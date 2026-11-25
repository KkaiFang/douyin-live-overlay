#!/usr/bin/env node
// 扫码登录抖音，登录态保存在 .profile/，之后采集会复用
//
// 关键点：必须去掉 Chrome 的 --enable-automation 标志，
// 否则抖音会识别为自动化环境，登录面板根本不弹出（只触发隐形验证）。
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const PROFILE_DIR = path.join(__dirname, '..', '.profile');
const ENTRY = 'https://www.douyin.com/';   // live.douyin.com 不弹登录框，这里用主站

const log = (...a) => console.log(...a);

async function findLoginButton(page) {
  return page.evaluate(() => {
    const el = [...document.querySelectorAll('*')].filter((e) => {
      const t = (e.innerText || '').trim();
      const b = e.getBoundingClientRect();
      return t === '登录' && b.width > 30 && b.width < 250 && b.height > 20;
    })[0];
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
}

async function loginPanelReady(page) {
  return page.evaluate(() => /扫码登录|验证码登录|扫一扫/.test(document.body.innerText || ''));
}

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  await page.goto(ENTRY, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);

  const btn = await findLoginButton(page);
  if (!btn) {
    log('✅ 已是登录状态，无需扫码');
    await ctx.close();
    return;
  }

  // 模拟真人：移动鼠标再点击
  await page.mouse.move(btn.x - 120, btn.y + 60, { steps: 12 });
  await page.waitForTimeout(300 + Math.random() * 400);
  await page.mouse.move(btn.x, btn.y, { steps: 8 });
  await page.waitForTimeout(200);
  await page.mouse.click(btn.x, btn.y);
  await page.waitForTimeout(4000);

  if (await loginPanelReady(page)) {
    log('✅ 登录面板已弹出');
  } else {
    log('⚠️ 登录面板没弹出，请手动点右上角「登录」');
  }

  // 存档二维码截图，方便你直接用手机对着屏幕扫
  const shot = path.join(PROFILE_DIR, 'login-qr.png');
  await page.screenshot({ path: shot });

  log('\n=============================================');
  log('  请用抖音 App 扫描二维码');
  log('  路径：抖音 → 左上角「☰」→ 扫一扫');
  log(`  二维码截图：${shot}`);
  log('  登录成功后本脚本会自动检测并退出');
  log('=============================================\n');

  let ok = false;
  for (let i = 0; i < 180; i++) {
    await page.waitForTimeout(2000);
    if (!(await findLoginButton(page))) { ok = true; break; }
    if (i % 15 === 14) log(`  等待扫码… ${(i + 1) * 2}s`);
  }

  if (ok) {
    await page.waitForTimeout(4000); // 等登录态写进 storage
    await page.screenshot({ path: path.join(PROFILE_DIR, 'login-done.png') });
    log('✅ 登录成功！登录态已保存');
    log('   接下来运行: npm run overlay');
  } else {
    log('❌ 超时。窗口保持 2 分钟，可手动完成登录。');
    await page.waitForTimeout(120000);
  }

  await ctx.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
