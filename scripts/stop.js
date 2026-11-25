#!/usr/bin/env node
// 一键停掉服务：释放端口 + 清理残留的采集用 Chrome 进程
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.PORT || 8181);
const PROFILE = path.join(__dirname, '..', '.profile');

function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch (e) { return ''; }
}

let stopped = 0;

// 1. 停掉占用端口的进程
const pids = sh(`lsof -ti:${PORT}`).split('\n').filter(Boolean);
for (const pid of pids) {
  const cmd = sh(`ps -p ${pid} -o command=`);
  if (/node\s+.*server\.js/.test(cmd)) {
    sh(`kill -9 ${pid}`);
    console.log(`已停止服务进程 ${pid}`);
    stopped++;
  } else {
    console.log(`⚠️ 端口 ${PORT} 被其它程序占用（${cmd.slice(0, 60)}），未处理`);
  }
}

// 2. 清理采集用的 Chrome（残留会占用 .profile，导致下次采集静默失败）
const chromePids = sh(`pgrep -f "user-data-dir=${PROFILE}"`).split('\n').filter(Boolean);
if (chromePids.length) {
  sh(`pgrep -f "user-data-dir=${PROFILE}" | xargs kill -9`);
  console.log(`已清理采集浏览器进程 ${chromePids.length} 个`);
  stopped++;
}

// 3. 清掉 Chrome 单例锁
for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
  const p = path.join(PROFILE, f);
  if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (e) {} }
}

console.log(stopped ? '\n✅ 已清理干净' : '没有需要清理的进程');
