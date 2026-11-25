// 抓取原始帧存盘，供离线分析
const { chromium } = require('playwright');
const fs = require('fs');
const URL = process.env.ROOM || 'https://live.douyin.com/400545796091';
const SECONDS = Number(process.env.SECONDS || 30);
const DIR = '/tmp/frames';

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

(async () => {
  const ctx = await chromium.launchPersistentContext('./.profile', {
    headless: false, channel: 'chrome',
    viewport: { width: 1280, height: 800 }, locale: 'zh-CN',
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  let n = 0;

  page.on('websocket', (ws) => {
    ws.on('framereceived', (f) => {
      try {
        const b = Buffer.from(f.payload);
        fs.writeFileSync(`${DIR}/f${String(++n).padStart(3, '0')}.bin`, b);
      } catch (e) {}
    });
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(SECONDS * 1000);
  console.log('saved frames:', n);
  await ctx.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
