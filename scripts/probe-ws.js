// 探针：打开直播间页面，观察 websocket 帧结构
const { chromium } = require('playwright');

const URL = 'https://live.douyin.com/400545796091';
const SECONDS = Number(process.env.SECONDS || 40);

(async () => {
  const ctx = await chromium.launchPersistentContext('./.profile', {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1280, height: 800 },
    locale: 'zh-CN',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  const methods = new Map();
  const wsInfo = [];

  page.on('websocket', (ws) => {
    wsInfo.push(ws.url());
    ws.on('framereceived', (f) => {
      try {
        const b = Buffer.from(f.payload);
        // 外层 Response: 第 8~11 字节是 messagesList 长度
        const n = b.length >= 12 ? b.readUInt32BE(8) : 0;
        let off = 12;
        while (off + 8 <= n + 12) {
          const tag = b[off];
          if ((tag & 7) !== 2) break; // 不是长度分隔字段就停
          let len = 0, shift = 0, i = off + 1;
          while (i < b.length) {
            const c = b[i++];
            len |= (c & 0x7f) << shift;
            if (!(c & 0x80)) break;
            shift += 7;
          }
          const body = b.subarray(i, i + len);
          // message.method 是 body 里的第一个字段（field 1, string）
          let mlen = 0, mshift = 0, j = 1;
          while (j < body.length) {
            const c = body[j++];
            mlen |= (c & 0x7f) << mshift;
            if (!(c & 0x80)) break;
            mshift += 7;
          }
          const method = body.subarray(j, j + mlen).toString();
          methods.set(method, (methods.get(method) || 0) + 1);
          off = i + len;
        }
      } catch (e) { /* ignore */ }
    });
  });

  console.log('打开页面...');
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(SECONDS * 1000);

  await page.screenshot({ path: '/tmp/dy-shot.png' });
  console.log('\n===== WEBSOCKET =====');
  console.log([...new Set(wsInfo)].join('\n') || '(无 ws 连接)');
  console.log('\n===== 收到的消息类型计数 =====');
  const sorted = [...methods.entries()].sort((a, b) => b[1] - a[1]);
  for (const [m, c] of sorted) console.log(String(c).padStart(6), m);
  if (!sorted.length) console.log('(没有解析到消息 — 需要调整解码逻辑)');

  await ctx.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
