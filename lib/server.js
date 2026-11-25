// 服务端：控制台 API + 事件推送 + 静态页
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { DouyinGrabber, parseRoomInput } = require('./grabber');
const voice = require('./voice');

const PORT = Number(process.env.PORT || 8181);
const PUBLIC = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mjs': 'application/javascript; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

/* ============ 状态 ============ */
const state = {
  running: false,
  room: null,          // { webRid, url }
  loggedIn: null,
  online: null,
  totalViewers: null,
  startedAt: null,
  counters: { enter: 0, chat: 0, gift: 0, like: 0, follow: 0, share: 0 },
  recentGifts: [],     // 最近 100 条礼物，供新开的展示页回放
  lastError: null,
  printer: null,       // 3D 工作室推来的队列快照，转发给 /stats 页面
  voice: {
    enabled: process.env.VOICE === '1',  // 默认关：这一屋子的观众得手动开，避免一上线就吵
    enter: true,        // 进场欢迎
    gift: true,         // 送礼答谢
    enterCooldown: 25,  // 同一人进场欢迎冷却（秒）
    volume: 0.85,
  },
};

// macOS say 的声音，可用 `say -v '?' | grep zh_CN` 挑
const TTS_VOICE = process.env.TTS_VOICE || 'Tingting';
const TTS_RATE = Math.max(120, Math.min(320, Number(process.env.TTS_RATE) || 195));

let grabber = null;

/* ============ WebSocket ============ */
const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === 1) {
      try { ws.send(data); } catch (e) { clients.delete(ws); }
    }
  }
}

/* ============ HTTP ============ */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

// 音频响应：支持 Range（Safari/iOS 播放需要），并让浏览器缓存，同一句话反复播不用再请求
function sendAudio(res, file) {
  let size;
  try { size = fs.statSync(file).size; } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('audio not found');
  }
  const base = {
    'Content-Type': 'audio/mp4',
    'Cache-Control': 'public, max-age=86400',
    'Accept-Ranges': 'bytes',
  };
  const hdr = String(res.req.headers.range || '');
  const m = /^bytes=(\d*)-(\d*)$/.exec(hdr);
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    start = Math.max(0, Math.min(start, size - 1));
    end = Math.max(start, Math.min(end, size - 1));
    res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...base, 'Content-Length': size });
  fs.createReadStream(file).pipe(res);
}

function publicStatus() {
  return {
    running: state.running,
    room: state.room,
    loggedIn: state.loggedIn,
    online: state.online,
    totalViewers: state.totalViewers,
    startedAt: state.startedAt,
    counters: state.counters,
    lastError: state.lastError,
    voice: state.voice,
    tts: { voice: TTS_VOICE, available: process.platform === 'darwin' },
    diag: grabber ? {
      frames: grabber.stats.frames,
      messages: grabber.stats.messages,
      events: grabber.stats.events,
      hasPage: !!grabber._page,
      mediaBlock: !!grabber.mediaBlock,
      mediaBlocked: grabber.stats.mediaBlocked || 0,
      mediaLeaked: grabber.stats.mediaLeaked || 0,
    } : null,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // ---- API ----
  if (p === '/api/status' && req.method === 'GET') {
    return sendJson(res, 200, publicStatus());
  }

  if (p === '/api/room' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }

    try {
      parseRoomInput(body.room); // 先校验，避免把非法输入带进浏览器
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }

    try {
      if (!grabber) {
        grabber = new DouyinGrabber();
        attachGrabber(grabber);
        await grabber.start(body.room);
        state.running = true;
        state.startedAt = Date.now();
      } else {
        await grabber.switchRoom(body.room);
      }
      state.lastError = null;
      broadcast({ type: 'room-changed', room: state.room });
      return sendJson(res, 200, publicStatus());
    } catch (e) {
      state.lastError = e.message;
      broadcast({ type: 'error', message: e.message });
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (p === '/api/stop' && req.method === 'POST') {
    if (grabber) {
      await grabber.stop().catch(() => {});
      grabber = null;
    }
    state.running = false;
    state.room = null;
    state.online = null;
    state.loggedIn = null;
    state.counters = { enter: 0, chat: 0, gift: 0, like: 0, follow: 0, share: 0 };
    state.recentGifts = [];
    state.printer = null;
    broadcast({ type: 'stopped' });
    broadcast({ type: 'stats-snapshot', snapshot: null });
    return sendJson(res, 200, publicStatus());
  }

  // ---- 头像代理：抖音图床有防盗链/可能需要 referer，走服务端中转换成本地可访问 ----
  if (p === '/img') {
    const src = url.searchParams.get('u');
    if (!src || !/^https?:\/\//.test(src)) { res.writeHead(400); res.end(); return; }
    const mod = src.startsWith('https:') ? require('https') : require('http');
    const req2 = mod.get(src, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://live.douyin.com/' } }, (r2) => {
      if (r2.statusCode !== 200) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, {
        'Content-Type': r2.headers['content-type'] || 'image/jpeg',
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
      });
      r2.pipe(res);
    });
    req2.on('error', () => { res.writeHead(504); res.end(); });
    req2.setTimeout(8000, () => { req2.destroy(); if (!res.headersSent) { res.writeHead(504); res.end(); } });
    return;
  }

  // ---- 语音播报：合成一句吉利话，返回可播放的音频 ----
  // /tts?kind=enter|gift|giftBig&nick=xx[&gift=嘉年华&count=1][&text=自定义]
  // /tts?voice=1 试听
  if (p === '/tts') {
    if (url.searchParams.get('voice') === '1') {
      try {
        const f = await voice.synthesize(voice.buildText({ kind: 'gift', nick: '小鹿乱撞', gift: '嘉年华', count: 1 }), TTS_VOICE, TTS_RATE);
        return sendAudio(res, f);
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }
    const text = String(url.searchParams.get('text') || '').slice(0, 60)
      || voice.buildText({
        kind: url.searchParams.get('kind') || 'enter',
        nick: url.searchParams.get('nick') || '',
        gift: url.searchParams.get('gift') || '',
        count: url.searchParams.get('count') || 1,
      });
    try {
      const f = await voice.synthesize(text, TTS_VOICE, TTS_RATE);
      return sendAudio(res, f);
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // ---- 语音配置：默认关，在控制台里开关 ----
  if (p === '/api/voice' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    if (body.enabled != null) state.voice.enabled = !!body.enabled;
    if (body.enter != null) state.voice.enter = !!body.enter;
    if (body.gift != null) state.voice.gift = !!body.gift;
    if (body.enterCooldown != null) state.voice.enterCooldown = Math.max(0, Math.min(600, Number(body.enterCooldown) || 0));
    if (body.volume != null) state.voice.volume = Math.max(0, Math.min(1, Number(body.volume)));
    broadcast({ type: 'voice-config', voice: state.voice });
    return sendJson(res, 200, publicStatus());
  }

  // ---- 静态文件 ----
  // 支持无扩展名访问：/ -> console.html，/display -> display.html
  let file = p === '/' ? '/console.html' : p;
  if (!path.extname(file)) file += '.html';
  const full = path.join(PUBLIC, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(full).pipe(res);
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/events') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    ws.send(JSON.stringify({
      type: 'hello',
      ...publicStatus(),
      recentGifts: state.recentGifts.slice(-40),
      printer: state.printer,
    }));

    // 打印机页面把队列快照推上来，服务端只做中转：别的页面（/stats）要就发过去
    ws.on('message', (buf) => {
      let m;
      try { m = JSON.parse(String(buf)); } catch (e) { return; }
      if (!m || typeof m !== 'object') return;
      if (m.type === 'stats-snapshot') {
        ws._kind = 'printer';
        if (!m.snapshot) return;
        state.printer = m.snapshot;
        for (const c of clients) if (c !== ws && c.readyState === 1) {
          try { c.send(JSON.stringify({ type: 'stats-snapshot', snapshot: m.snapshot })); } catch (e) { clients.delete(c); }
        }
        return;
      }
      if (m.type === 'stats-req') {
        ws.send(JSON.stringify({ type: 'stats-snapshot', snapshot: state.printer }));
      }
    });
    ws.on('close', () => {
      // 打印机页面关了：通知 /stats 那边别再用旧数据
      if (ws._kind === 'printer') {
        state.printer = null;
        for (const c of clients) if (c.readyState === 1) {
          try { c.send(JSON.stringify({ type: 'stats-snapshot', snapshot: null })); } catch (e) {}
        }
      }
    });
  });
});

/* ============ 采集器事件 -> 广播 ============ */
function attachGrabber(g) {
  g.on('room', (room) => {
    state.room = { webRid: room.webRid, url: room.url };
    state.loggedIn = room.loggedIn;
    broadcast({ type: 'room', room: state.room, loggedIn: room.loggedIn });
  });
  g.on('login-state', (ok) => {
    state.loggedIn = ok;
    broadcast({ type: 'login-state', loggedIn: ok });
  });
  g.on('connected', (c) => broadcast({ type: 'connected', kind: c.kind }));
  g.on('warn', (m) => broadcast({ type: 'warn', message: m }));
  g.on('closed', () => {
    state.running = false;
    grabber = null;
    broadcast({ type: 'stopped' });
  });
  g.on('event', (ev) => {
    if (ev.type === 'stats') {
      if (ev.online != null) state.online = ev.online;
      if (ev.totalViewers != null) state.totalViewers = ev.totalViewers;
      broadcast({ type: 'stats', online: state.online, totalViewers: state.totalViewers });
      return;
    }
    if (ev.type in state.counters) state.counters[ev.type]++;
    if (ev.type === 'gift') {
      state.recentGifts.push(ev);
      if (state.recentGifts.length > 100) state.recentGifts.shift();
    }
    broadcast(ev);
  });
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n❌ 端口 ${PORT} 已被占用，通常是上一次的服务没关掉。`);
    console.error(`   先执行下面这行清掉，再重新 npm start：\n`);
    console.error(`   lsof -ti:${PORT} | xargs kill -9\n`);
    console.error(`   也可以换个端口启动：PORT=8182 npm start\n`);
    process.exit(1);
  }
  throw e;
});

voice.init();
server.listen(PORT, () => {
  console.log(`\n  控制台   http://localhost:${PORT}/`);
  console.log(`  展示墙   http://localhost:${PORT}/display`);
  console.log(`  3D 工作室 http://localhost:${PORT}/studio`);
  console.log(`  信息页   http://localhost:${PORT}/stats\n`);
});
