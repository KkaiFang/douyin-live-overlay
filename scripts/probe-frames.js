// 导出原始帧结构
const { chromium } = require('playwright');
const URL = 'https://live.douyin.com/400545796091';

(async () => {
  const ctx = await chromium.launchPersistentContext('./.profile', {
    headless: false, channel: 'chrome',
    viewport: { width: 1280, height: 800 }, locale: 'zh-CN',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  let n = 0;

  page.on('websocket', (ws) => {
    ws.on('framereceived', (f) => {
      if (n++ > 12) return;
      const isBuf = typeof f.payload !== 'string';
      const b = Buffer.from(f.payload);
      console.log(`\n--- frame #${n} type=${isBuf ? 'binary' : 'text'} len=${b.length} ---`);
      console.log('head:', b.subarray(0, 48).toString('hex'));
      if (!isBuf) console.log('text:', b.subarray(0, 200).toString());
      else console.log('ascii:', b.subarray(0, 80).toString('latin1').replace(/[^\x20-\x7e]/g, '.'));
    });
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(25000);
  await ctx.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
