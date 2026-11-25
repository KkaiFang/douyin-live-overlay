#!/usr/bin/env node
// 命令行采集器：实时打印进场/弹幕/礼物/关注
const { DouyinGrabber } = require('../lib/grabber');

const room = process.argv[2] || 'https://live.douyin.com/400545796091';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', blue: '\x1b[36m', pink: '\x1b[35m',
  yellow: '\x1b[33m', red: '\x1b[31m', gray: '\x1b[90m',
};

const LABEL = {
  enter: `${C.green}进场${C.reset}`,
  chat: `${C.blue}弹幕${C.reset}`,
  gift: `${C.pink}礼物${C.reset}`,
  follow: `${C.yellow}关注${C.reset}`,
  like: `${C.red}点赞${C.reset}`,
  social: `${C.gray}其他${C.reset}`,
  stats: `${C.gray}统计${C.reset}`,
};

const t = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

function fmt(ev) {
  const u = ev.user || {};
  const who = `${C.bold}${u.nickname || '?'}${C.reset} ${C.dim}(id:${u.id} 号:${u.shortId || u.displayId || '-'})${C.reset}`;
  switch (ev.type) {
    case 'enter': return `${LABEL.enter} ${who}${C.dim} 在线${ev.online}${C.reset}`;
    case 'chat': return `${LABEL.chat} ${who}${C.dim}:${C.reset} ${ev.text}`;
    case 'gift': return `${LABEL.gift} ${who} ${C.pink}${ev.gift?.name || '礼物'} ×${ev.count}${C.reset}${C.dim} 连击${ev.combo}${C.reset}`;
    case 'follow': return `${LABEL.follow} ${who}`;
    case 'like': return `${LABEL.like} ${who} +${ev.count}${C.dim} 累计${ev.total}${C.reset}`;
    case 'social': return `${LABEL.social} ${who} ${ev.action}`;
    case 'stats': return `${LABEL.stats} ${C.dim}在线 ${ev.online ?? '-'} / 累计 ${ev.totalViewers ?? '-'}${C.reset}`;
    default: return `${ev.type} ${JSON.stringify(ev)}`;
  }
}

(async () => {
  const g = new DouyinGrabber({ room });
  g.on('connected', (u) => console.log(`${C.dim}[${t()}] websocket 已连接${C.reset}`));
  g.on('event', (ev) => {
    if (ONLY && !ONLY.includes(ev.type)) return;
    if (ONLY && ev.type !== 'stats') {
      // 结构化输出一行，方便下游消费
      console.log(fmt(ev));
    } else if (!ONLY) {
      console.log(fmt(ev));
    }
    if (process.env.JSON) console.log(JSON.stringify(ev));
  });
  g.on('warn', (m) => console.log(`${C.yellow}[warn] ${m}${C.reset}`));
  g.on('closed', () => { console.log('浏览器关闭，退出'); process.exit(0); });

  await g.start();
  console.log(`${C.dim}采集中… Ctrl+C 退出${C.reset}\n`);

  process.on('SIGINT', async () => {
    console.log(`\n${C.dim}共 ${g.stats.events} 个事件 / ${g.stats.frames} 帧${C.reset}`);
    await g.stop();
    process.exit(0);
  });
})().catch((e) => { console.error('启动失败:', e.message); process.exit(1); });
