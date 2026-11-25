// 语音播报：用 macOS 自带 say 合成中文语音，落盘缓存后给浏览器播放。
// 进场欢迎 / 送礼答谢 / 大礼夸张版，配合模板池随机出词，避免每次都是同一句。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const DIR = path.join(__dirname, '..', '.voice');
const MAX_FILES = 400;      // 超出后按修改时间淘汰
const MAX_QUEUE = 24;       // 积压太多时直接丢弃，别让 say 把机器拖卡
let running = 0;
const CONCURRENCY = 2;
const pending = [];
const inFlight = new Map(); // key -> Promise<file>

/* ================= 文案 ================= */
// {nick} 昵称，{gift} 礼物名，{n} 数量；吉利话单独抽，保证每条都能组出顺口的一句
const BLESS = [
  '财源广进，好运连连',
  '恭喜发财，钱包鼓鼓',
  '事事顺心，一路发财',
  '福气满满，大吉大利',
  '顺风顺水，赚钱不愁',
  '平安顺遂，心想事成',
  '好运缠身，财气拉满',
  '考试全过，抽卡全出金',
  '桃花朵朵，学业有成',
  '老板大气，福气加倍',
  '财神爷都羡慕你',
  '好运得像开了挂',
  '红包不断，好运加倍',
  '万事如意，天天开心',
  '贵人相助，贵人不断',
  '数钱数到手抽筋，好运挡也挡不住',
  '钱包鼓成仓鼠脸，快乐多到装不下',
  '锦鲤附体，欧气爆棚',
  '今天好运，明天更旺',
  '好事一件接一件，福气一筐接一筐',
  '出门捡到宝，在家数钞票',
  '横财就手，富贵临门',
  '吃嘛嘛香，干啥啥成',
  '钞票追着你跑，幸福跟着你走',
  '旺得发紫，红得发亮',
  '一路躺赢，越活越甜',
];

const TEMPLATES = {
  enter: [
    '欢迎{nick}走进直播间，{bless}',
    '欢迎{nick}来了，{bless}',
    '{nick}踏着七彩祥云来了，{bless}',
    '欢迎{nick}光临，{bless}',
    '{nick}一进门，好运跟着来',
    '欢迎{nick}，常来看看，{bless}',
    '锣鼓喧天欢迎{nick}，{bless}',
    '{nick}闪亮登场，{bless}',
    '欢迎{nick}大驾光临，{bless}',
  ],
  gift: [
    '{nick}送来{gift}，{bless}',
    '感谢{nick}的{gift}，{bless}',
    '{nick}大手一挥，{gift}安排，{bless}',
    '{nick}的{gift}收到啦，{bless}',
    '谢谢{nick}的{gift}，{bless}',
    '{nick}出手不凡，{gift}奉上，{bless}',
    '{nick}的{gift}到了，{bless}',
    '收到{nick}的{gift}，主播笑开了花，{bless}',
    '{nick}一掷千金，{gift}走起，{bless}',
  ],
  giftBig: [
    '{nick}送出{gift}×{n}，豪气冲天，{bless}',
    '哇，{nick}送出{gift}×{n}，{bless}',
    '{nick}的{gift}×{n}来了，老板真的绝，{bless}',
    '{nick}出手就是{gift}×{n}，{bless}',
    '全体起立，{nick}送出{gift}×{n}，{bless}',
    '{gift}×{n}，{nick}这是要买下直播间啊，{bless}',
  ],
  lottery: [
    '恭喜{nick}被抽中幸运观众，{bless}',
    '{nick}成为本轮幸运观众，{bless}',
    '幸运观众是{nick}，奖牌安排上，{bless}',
    '恭喜{nick}中了幸运观众，{bless}',
    '{nick}欧皇附体，抽中幸运观众，{bless}',
    '恭喜{nick}喜提幸运观众，{bless}',
  ],
  comment: [
    '{nick}扣的 666 收到啦，{bless}',
    '谢谢{nick}的 666，{bless}',
    '{nick}一个 666，气势拉满，{bless}',
    '{nick}这波 666，好运加倍，{bless}',
  ],
};

const pick = (a) => a[(Math.random() * a.length) | 0];

// 昵称里常见的表情/空格/竖线读起来很怪，只留数字字母和中文
function cleanNick(n) {
  const raw = String(n || '');
  // 抖音网页端给的用户昵称是脱敏的「首字***」，念一个残字不如念通用称呼
  if (/\*{2,}\s*$/.test(raw)) return '一位新朋友';
  const s = raw.replace(/[^\p{Script=Han}0-9a-zA-Z]/gu, '');
  return s || '神秘观众';
}

/**
 * 生成一句播报。
 * @param {{kind?: 'enter'|'gift'|'giftBig', nick?: string, gift?: string, count?: number}} o
 */
function buildText(o = {}) {
  const kind = TEMPLATES[o.kind] ? o.kind : 'enter';
  // 小礼物也可能送很多个，超过 9 个按大礼文案走
  const k = kind === 'gift' && (Number(o.count) || 1) >= 9 ? 'giftBig' : kind;
  return pick(TEMPLATES[k])
    .replace('{nick}', cleanNick(o.nick))
    .replace('{gift}', String(o.gift || '礼物').slice(0, 8))
    .replace('{n}', String(Math.max(1, Number(o.count) || 1)))
    .replace('{bless}', pick(BLESS));
}

/* ================= 合成 ================= */
function prune() {
  let files;
  try {
    files = fs.readdirSync(DIR).filter((f) => f.endsWith('.m4a'));
  } catch (e) {
    return;
  }
  if (files.length <= MAX_FILES) return;
  const list = files
    .map((f) => ({ f, t: fs.statSync(path.join(DIR, f)).mtimeMs }))
    .sort((a, b) => a.t - b.t);
  for (const { f } of list.slice(0, files.length - MAX_FILES)) {
    try { fs.unlinkSync(path.join(DIR, f)); } catch (e) {}
  }
}

function synthesize(text, voice, rate) {
  const key = crypto.createHash('md5').update(`${voice}|${rate}|${text}`).digest('hex');
  const out = path.join(DIR, key + '.m4a');
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (inFlight.has(key)) return inFlight.get(key);

  const job = new Promise((resolve, reject) => {
    if (pending.length >= MAX_QUEUE) return reject(new Error('语音播报积压过多，已跳过'));
    pending.push(() => {
      const tmp = path.join(DIR, key + '.' + process.pid + '.wav');
      const done = (err) => {
        running--;
        next();
        if (err) { try { fs.unlinkSync(tmp); } catch (e) {} return reject(err); }
        prune();
        resolve(out);
      };
      execFile('say', ['-v', voice, '-r', String(rate), '-o', tmp,
        '--data-format=LEI16@22050', '--file-format=WAVE', text], (err) => {
        if (err) return done(err);
        execFile('afconvert', [tmp, out, '-f', 'm4af', '-d', 'aac', '-b', '64000'], (err2) => {
          try { fs.unlinkSync(tmp); } catch (e) {}
          if (err2) return done(err2);
          if (!fs.existsSync(out)) return done(new Error('合成失败'));
          done(null);
        });
      });
    });
    next();
  }).finally(() => inFlight.delete(key));

  inFlight.set(key, job);
  return job;
}

function next() {
  while (running < CONCURRENCY && pending.length) {
    running++;
    pending.shift()();
  }
}

function init() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) {}
}

module.exports = { buildText, synthesize, init, DIR };
