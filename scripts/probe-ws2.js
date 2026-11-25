// 探针 v2：解析出消息类型
const { chromium } = require('playwright');
const { decodeFrame, decodeResponse } = require('../lib/proto');

const URL = process.env.ROOM || 'https://live.douyin.com/400545796091';
const SECONDS = Number(process.env.SECONDS || 40);

(async () => {
  const ctx = await chromium.launchPersistentContext('./.profile', {
    headless: false, channel: 'chrome',
    viewport: { width: 1280, height: 800 }, locale: 'zh-CN',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const counts = new Map();
  const samples = new Map();

  page.on('websocket', (ws) => {
    ws.on('framereceived', (f) => {
      try {
        const fr = decodeFrame(Buffer.from(f.payload));
        if (!fr) return;
        for (const m of decodeResponse(fr.payload)) {
          if (!m.method) continue;
          counts.set(m.method, (counts.get(m.method) || 0) + 1);
          if (!samples.has(m.method) && m.payload.length) samples.set(m.method, m.payload);
        }
      } catch (e) { /* ignore */ }
    });
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(SECONDS * 1000);

  console.log('\n===== 消息类型 =====');
  for (const [m, c] of [...counts].sort((a, b) => b[1] - a[1])) console.log(String(c).padStart(5), m);

  console.log('\n===== 样本（字符串字段预览）=====');
  for (const [m, p] of samples) {
    const s = p.toString('latin1').replace(/[^\x20-\x7e一-龥]/g, '.');
    console.log(`\n[${m}] len=${p.length}\n${s.slice(0, 300)}`);
  }
  await ctx.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
