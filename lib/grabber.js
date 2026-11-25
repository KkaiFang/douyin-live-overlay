// 直播间事件采集器 —— 用浏览器承接抖音的签名逻辑，截获 im websocket 帧并归一化
const { chromium } = require('playwright');
const EventEmitter = require('events');
const path = require('path');
const { decodeFrame, decodeResponse } = require('./proto');
const { toEvent } = require('./douyin-events');

const PROFILE_DIR = path.join(__dirname, '..', '.profile');

// 省流量：只放行页面脚本/接口与事件 WebSocket，不下载直播视频
const MEDIA_BLOCK_ON = !/^(0|false|off)$/i.test(process.env.BLOCK_MEDIA || '1');
const BLOCK_IMAGES = /^(1|true|on)$/i.test(process.env.BLOCK_IMAGES || '');
const MEDIA_EXT_RE = /\.(m3u8|ts|flv|m4s|mp4|m4a|aac|mpd|webm|mov)(?:[?#]|$)/i;
const VIDEO_HOST_RE = /(^|\.)(douyinvod\.com|douyincdn\.com|ixigua\.com)$/i;
const IMG_KEEP_RE = /(^|\.)douyinpic\.com$/i; // 头像、礼物图、验证资源

/**
 * 把用户输入解析成直播间 URL。
 * 支持：完整链接 / live.douyin.com/123 / 纯数字 web_rid / 分享文本里夹带的链接
 */
function parseRoomInput(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('请输入直播间链接或房间号');

  // 从任意文本里抠出直播间链接
  const urlMatch = raw.match(/https?:\/\/[^\s"'<>]+/);
  const url = urlMatch ? urlMatch[0] : null;

  if (url) {
    const m = url.match(/live\.douyin\.com\/(\d{6,})/);
    if (m) return { webRid: m[1], url: `https://live.douyin.com/${m[1]}` };
    if (/live\.douyin\.com/.test(url)) throw new Error('链接里没找到房间号');
    // 其它域名的分享链接（v.douyin.com 短链）需要跳转解析
    return { webRid: '', url, needsResolve: true };
  }

  // 纯数字房间号
  if (/^\d{6,}$/.test(raw)) return { webRid: raw, url: `https://live.douyin.com/${raw}` };

  throw new Error('无法识别的输入，请粘贴直播间链接或输入房间号');
}

class DouyinGrabber extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.headless = opts.headless ?? false;
    this.log = opts.log || ((...a) => console.log(...a));
    this.stats = {
      frames: 0,
      messages: 0,
      events: 0,
      startedAt: null,
      mediaBlocked: 0, // 已拦截的媒体请求数
      mediaLeaked: 0,  // 拦截后仍成功下载的媒体请求（用于发现 Service Worker 绕过）
    };
    this.mediaBlock = opts.mediaBlock ?? MEDIA_BLOCK_ON;
    this.blockImages = opts.blockImages ?? BLOCK_IMAGES;
    this.room = null;
    this.loggedIn = null;
    this._seen = new Set();
    this._ctx = null;
    this._page = null;
    this._closing = false;
    this._boundPages = new WeakSet();
  }

  /** 启动浏览器（只启动一次），并打开指定直播间 */
  async start(roomInput) {
    const room = parseRoomInput(roomInput);
    this._ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: this.headless,
      channel: 'chrome',
      viewport: { width: 1280, height: 800 },
      locale: 'zh-CN',
      // 去掉 --enable-automation，否则抖音会按自动化环境降级推送（礼物等消息会被过滤）
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--disable-blink-features=AutomationControlled', '--mute-audio'],
    });
    await this._installMediaBlock();
    this._page = this._ctx.pages()[0] || (await this._ctx.newPage());
    this._ctx.on('close', () => {
      if (!this._closing) this.emit('closed');
    });

    this._watchdog = setInterval(() => this._checkAlive(), 20000);
    await this._navigate(room);
    return this;
  }

  /** 切换到另一个直播间（复用同一个浏览器窗口） */
  async switchRoom(roomInput) {
    if (!this._ctx) throw new Error('采集器未启动');
    const room = parseRoomInput(roomInput);
    await this._navigate(room);
    return this.room;
  }

  async _navigate(room) {
    let target = room.url;
    if (room.needsResolve) {
      // 短链：让浏览器跟随跳转后取最终地址
      this._page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await this._page.waitForTimeout(4000);
      const finalUrl = this._page.url();
      const m = finalUrl.match(/live\.douyin\.com\/(\d{6,})/);
      if (!m) throw new Error('该链接不是直播间链接');
      room = { webRid: m[1], url: `https://live.douyin.com/${m[1]}` };
      target = room.url;
    }

    this._seen.clear();          // 换房间后消息 ID 不通用，清空去重表
    this.room = room;
    this._bindPage(this._page);

    this.log(`打开直播间 ${target}`);
    await this._page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await this._page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    this.stats.startedAt = new Date();

    this.loggedIn = await this.checkLogin();
    this.emit('login-state', this.loggedIn);
    this.emit('room', { ...room, loggedIn: this.loggedIn });
  }

  /** 拦截视频/音频请求，保留脚本、接口与 WebSocket；?BLOCK_MEDIA=0 可关闭 */
  async _installMediaBlock() {
    if (!this.mediaBlock) {
      this.log('[media-block] 已关闭 (BLOCK_MEDIA=0)，直播视频会照常下载');
      return;
    }
    await this._ctx.route('**/*', async (route) => {
      const req = route.request();
      const type = req.resourceType();
      const url = req.url();
      let host = '';
      try { host = new URL(url).hostname; } catch (e) { /* data:, blob: 等忽略 */ }

      const isMedia = type === 'media' || MEDIA_EXT_RE.test(url);
      const isVideoCdn = VIDEO_HOST_RE.test(host) &&
        (type === 'media' || type === 'xhr' || type === 'fetch' || type === 'other');
      const isBlockedImage = this.blockImages && type === 'image' && !IMG_KEEP_RE.test(host);

      if (isMedia || isVideoCdn || isBlockedImage) {
        this.stats.mediaBlocked++;
        return route.abort('blockedbyclient').catch(() => {});
      }
      return route.continue().catch(() => {});
    });
    this.log('[media-block] 已开启：不再下载直播视频/音频，事件 WebSocket 不受影响');
  }

  _bindPage(page) {
    if (this._boundPages.has(page)) return;
    this._boundPages.add(page);
    if (this.mediaBlock) {
      // 拦截后仍收到媒体响应 => 可能有 Service Worker 绕过了路由
      page.on('response', (r) => {
        const u = r.url();
        if (r.request().resourceType() === 'media' || MEDIA_EXT_RE.test(u)) this.stats.mediaLeaked++;
      });
    }
    page.on('websocket', (ws) => {
      const u = ws.url();
      if (!/webcast\/im\//.test(u) && !/webcast\/gift\//.test(u)) return;
      const kind = /gift/.test(u) ? 'gift' : 'im';
      this.emit('connected', { kind });
      ws.on('framereceived', (f) => this._onFrame(f));
      ws.on('close', () => this.emit('socket-closed', { kind }));
    });
    page.on('pageerror', () => {});
  }

  _onFrame(frame) {
    let fr;
    try {
      fr = decodeFrame(Buffer.from(frame.payload));
    } catch (e) {
      return;
    }
    if (!fr) return;
    this.stats.frames++;

    let messages;
    try { messages = decodeResponse(fr.payload); } catch (e) { return; }

    for (const m of messages) {
      this.stats.messages++;
      let ev;
      try { ev = toEvent(m); } catch (e) { continue; }
      if (!ev) continue;
      if (this._seen.has(ev.msgId)) continue;
      this._seen.add(ev.msgId);

      if (this._seen.size > 5000) {
        this._seen = new Set([...this._seen].slice(-2500));
      }

      this.stats.events++;
      this.emit('event', ev);
    }
  }

  /** 页面上还有「登录」按钮 => 未登录 */
  async checkLogin() {
    try {
      return await this._page.evaluate(() => {
        const hasBtn = [...document.querySelectorAll('*')].some((el) =>
          el.children.length === 0 &&
          /^登录$/.test((el.textContent || '').trim()) &&
          el.getBoundingClientRect().width > 0
        );
        return !hasBtn;
      });
    } catch (e) {
      return null;
    }
  }

  async _checkAlive() {
    if (!this._page) return;
    try {
      const hidden = await this._page.evaluate(() => document.visibilityState === 'hidden');
      if (hidden) this.emit('warn', '采集窗口被隐藏，可能被限速');
    } catch (e) { /* 页面切换中，忽略 */ }
  }

  async stop() {
    this._closing = true;
    clearInterval(this._watchdog);
    if (this._ctx) await this._ctx.close().catch(() => {});
    this._ctx = null;
    this._page = null;
  }
}

module.exports = { DouyinGrabber, parseRoomInput };
