// 语音播报（页面端）：优先用浏览器自带的 speechSynthesis 念，手机/电脑/平板都能出声，不用装任何东西。
// 只有在浏览器确实没有中文语音时（例如 OBS 内置 Chromium），才退回服务端 /tts 的合成音频。
// 展示墙和打印机共用；开关 / 冷却 / 音量由控制台统一下发（voice-config 消息）。
(function () {
  const S = {
    enabled: false,     // 以服务端为准；演示模式下自动打开
    enter: true,
    gift: true,
    enterCooldown: 25,
    volume: 0.85,
  };

  /* ---------- 引擎检测：浏览器语音优先，没有中文语音才用服务端音频 ---------- */
  const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
  let engine = 'unknown';       // unknown | browser | server
  let voice = null;             // 选中的中文 voice
  const pending = [];           // 引擎没确定前先攒着（最多几条）

  function isChinese(v) {
    const lang = String(v.lang || '').toLowerCase();
    const name = String(v.name || '');
    return /^zh/.test(lang) || /中文|普通话|Chinese|Tingting|婷婷|Meijia|美佳/i.test(name);
  }
  // 优先大陆普通话、女声、名字里带 Tingting/婷婷 的
  function pickVoice() {
    const vs = synth ? synth.getVoices() : [];
    const cn = vs.filter(isChinese);
    if (!cn.length) return null;
    const score = (v) => {
      let n = 0;
      const lang = String(v.lang || '').toLowerCase();
      if (lang === 'zh-cn' || lang === 'zh_cn') n += 100;
      if (lang.startsWith('zh')) n += 40;
      if (/Tingting|婷婷|美佳|Meijia|女/.test(v.name || '')) n += 20;
      if (v.localService) n += 5;
      return n;
    };
    return cn.sort((a, b) => score(b) - score(a))[0];
  }

  function detect() {
    if (!synth) { engine = 'server'; return; }
    const v = pickVoice();
    if (v) { voice = v; engine = 'browser'; return; }
    // 语音列表可能还没加载完（尤其手机），先别急着走服务端，等 voiceschanged 或超时
    engine = 'unknown';
  }
  detect();
  if (synth) {
    const onVoices = () => {
      if (engine !== 'browser') { detect(); flush(); }
    };
    if ('onvoiceschanged' in synth) synth.addEventListener('voiceschanged', onVoices);
    synth.onvoiceschanged = onVoices;
    // 有些浏览器不会触发 voiceschanged，刚启动时轮询几次
    let tries = 0;
    const poll = setInterval(() => {
      if (engine === 'browser' || ++tries > 8) { clearInterval(poll); return; }
      detect();
      if (engine === 'browser') { clearInterval(poll); flush(); }
    }, 250);
  }
  // 6 秒还没拿到中文语音（手机首次加载语音列表偏慢），当成不支持，走服务端
  setTimeout(() => {
    if (engine === 'unknown') { engine = 'server'; flush(); }
  }, 6000);

  /* ---------- 播放 ---------- */
  let curTag = null;
  const serverQueue = [];
  let serverAudio = null;

  function flush() {
    while (pending.length) {
      const p = pending.shift();
      speakNow(p.text, p.tag);
    }
  }

  function speakNow(text, tag) {
    if (!S.enabled || !text) return;
    // 进场欢迎不丢：浏览器语音本身会排队；礼物等其它类播放中才做同类去重
    if (tag !== 'enter' && curTag === tag) return;
    if (engine === 'unknown') {
      if (pending.length < 6) pending.push({ text, tag });
      return;
    }
    if (engine === 'server') return speakServer(text, tag);
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.lang = (voice && voice.lang) || 'zh-CN';
    u.rate = 1.06;
    u.pitch = 1.12;               // 稍高一点，甜
    u.volume = S.volume;
    if (tag !== 'enter') curTag = tag;
    const done = () => { if (tag !== 'enter' && curTag === tag) curTag = null; };
    u.onend = done;
    u.onerror = done;
    synth.speak(u);
  }

  // 服务端音频兜底（OBS 里没有系统语音时用）
  function speakServer(text, tag) {
    const cap = tag === 'enter' ? 10 : 4;
    if (serverQueue.length >= cap) {
      if (tag !== 'enter') return;
      serverQueue.shift();          // 进场积压时丢最旧的，保新的
    }
    serverQueue.push({ url: `/tts?text=${encodeURIComponent(text)}`, tag });
    playServer();
  }
  function playServer() {
    if (serverAudio || !serverQueue.length) return;
    const job = serverQueue.shift();
    const a = new Audio();
    a.volume = S.volume;
    a.src = job.url;
    serverAudio = a;
    const finish = () => { if (serverAudio !== a) return; serverAudio = null; playServer(); };
    a.addEventListener('ended', finish);
    a.addEventListener('error', finish);
    a.play().catch(finish);
  }

  /* ---------- 进场欢迎 ---------- */
  const greeted = new Map();     // 昵称 -> 上次欢迎时间
  const enterBuf = [];           // 一波进场的昵称，攒一会儿合成一句念，人多也不丢
  let enterTimer = null;

  function nickOf(u) {
    return String((u && (u.nickname || u.nick)) || '');
  }

  // 同一个名字冷却内不重复欢迎，避免反复进出刷屏；
  // 脱敏昵称（「陈***」）可能是不同人撞了首字，不做同名校验，靠批处理合并
  function onEnter(m) {
    if (!S.enabled || !S.enter) return;
    const nick = nickOf(m.user);
    if (!nick) return;
    const now = Date.now();
    const masked = /\*{2,}\s*$/.test(nick);
    if (!masked) {
      if (now - (greeted.get(nick) || 0) < S.enterCooldown * 1000) return;
      if (greeted.size > 300) {
        for (const [k, ts] of greeted) if (now - ts > S.enterCooldown * 2000) greeted.delete(k);
      }
      greeted.set(nick, now);
    }
    enterBuf.push(nick);
    if (enterBuf.length > 80) enterBuf.shift();
    if (!enterTimer) {
      // 正在念的时候把窗口拉长，一次凑更多人，减少排队压力
      const busy = (synth && (synth.speaking || synth.pending)) || serverAudio || serverQueue.length;
      enterTimer = setTimeout(flushEnters, busy ? 3000 : 1500);
    }
  }

  function flushEnters() {
    enterTimer = null;
    if (!enterBuf.length) return;
    speakNow(batchWelcome(enterBuf.splice(0, enterBuf.length)), 'enter');
  }

  // 一批进场合成一句：单人走随机模板，多人合成「欢迎 A、B 等 N 位朋友…」
  function batchWelcome(names) {
    const seen = new Set();
    const real = [];
    let generic = 0;
    for (const n of names) {
      if (seen.has(n)) continue;
      seen.add(n);
      const name = cleanName(n);
      if (name === '一位新朋友') generic++;
      else real.push(name);
    }
    const total = real.length + generic;
    if (total === 1 && real.length === 1) return compose('enter', real[0], '', 1);
    const shown = real.slice(0, 6);
    const who = shown.length
      ? shown.join('、') + (total > shown.length ? `等${total}位朋友` : '')
      : `${total}位新朋友`;
    return `欢迎${who}走进直播间，${pickOne(BLESS)}`;
  }

  /* ---------- 送礼答谢 ---------- */
  const giftSaid = new Map();   // 昵称|礼物 -> 上次播报
  let lastBig = 0;

  function onGift(m, opts) {
    if (!S.enabled || !S.gift) return;
    if (opts && opts.replay) return;   // 开页时回放的最近礼物不播
    const nick = nickOf(m.user);
    const g = m.gift || {};
    const count = Math.max(1, Number(m.count) || 1);
    const diamond = Number(g.diamond) || 0;
    const now = Date.now();
    const big = diamond * count >= 100 || count >= 9;
    const key = nick + '|' + (g.name || '');

    if (!big) {
      if (now - (giftSaid.get(key) || 0) < 30000) return;   // 小礼物 30 秒内同人同礼只说一次
      if (now - lastBig < 4000) return;                     // 大礼播报期间给大礼让路
    } else {
      lastBig = now;
    }
    if (giftSaid.size > 400) giftSaid.clear();
    giftSaid.set(key, now);

    speakNow(compose(big ? 'giftBig' : 'gift', nick, g.name || '礼物', count), 'gift');
  }

  /* ---------- 造词（模板与 lib/voice.js 保持一致，服务端兜底时也能直接合成） ---------- */
  const BLESS = [
    '财源广进，好运连连', '恭喜发财，钱包鼓鼓', '事事顺心，一路发财', '福气满满，大吉大利',
    '顺风顺水，赚钱不愁', '平安顺遂，心想事成', '好运缠身，财气拉满', '考试全过，抽卡全出金',
    '桃花朵朵，学业有成', '老板大气，福气加倍', '财神爷都羡慕你', '好运得像开了挂',
    '红包不断，好运加倍', '万事如意，天天开心', '贵人相助，贵人不断',
    '数钱数到手抽筋，好运挡也挡不住', '钱包鼓成仓鼠脸，快乐多到装不下',
    '锦鲤附体，欧气爆棚', '今天好运，明天更旺', '好事一件接一件，福气一筐接一筐',
    '出门捡到宝，在家数钞票', '横财就手，富贵临门', '吃嘛嘛香，干啥啥成',
    '钞票追着你跑，幸福跟着你走', '旺得发紫，红得发亮', '一路躺赢，越活越甜',
  ];
  const TPL = {
    enter: [
      '欢迎{nick}走进直播间，{bless}', '欢迎{nick}来了，{bless}', '{nick}踏着七彩祥云来了，{bless}',
      '欢迎{nick}光临，{bless}', '{nick}一进门，好运跟着来', '欢迎{nick}，常来看看，{bless}',
      '锣鼓喧天欢迎{nick}，{bless}', '{nick}闪亮登场，{bless}', '欢迎{nick}大驾光临，{bless}',
    ],
    gift: [
      '{nick}送来{gift}，{bless}', '感谢{nick}的{gift}，{bless}', '{nick}大手一挥，{gift}安排，{bless}',
      '{nick}的{gift}收到啦，{bless}', '谢谢{nick}的{gift}，{bless}', '{nick}出手不凡，{gift}奉上，{bless}',
      '{nick}的{gift}到了，{bless}', '收到{nick}的{gift}，主播笑开了花，{bless}',
      '{nick}一掷千金，{gift}走起，{bless}',
    ],
    giftBig: [
      '{nick}送出{gift}乘{n}，豪气冲天，{bless}', '哇，{nick}送出{gift}乘{n}，{bless}',
      '{nick}的{gift}乘{n}来了，老板真的绝，{bless}', '{nick}出手就是{gift}乘{n}，{bless}',
      '全体起立，{nick}送出{gift}乘{n}，{bless}', '{gift}乘{n}，{nick}这是要买下直播间啊，{bless}',
    ],
    like: [
      '感谢{nick}的点赞连击，{bless}', '{nick}手速真快，连赞安排，{bless}',
      '谢谢{nick}一路点赞，{bless}', '{nick}点的赞收到啦，{bless}',
      '{nick}点赞像开挂，{bless}',
    ],
    follow: [
      '感谢{nick}关注了主播，{bless}', '欢迎{nick}成为新粉，{bless}',
      '谢谢{nick}的关注，{bless}', '{nick}关注了主播，{bless}',
      '{nick}荣升家人团，{bless}',
    ],
    lottery: [
      '恭喜{nick}被抽中幸运观众，{bless}', '{nick}成为本轮幸运观众，{bless}',
      '幸运观众是{nick}，奖牌安排上，{bless}', '恭喜{nick}中了幸运观众，{bless}',
      '{nick}欧皇附体，抽中幸运观众，{bless}', '恭喜{nick}喜提幸运观众，{bless}',
    ],
    comment: [
      '{nick}扣的 666 收到啦，{bless}', '谢谢{nick}的 666，{bless}',
      '{nick}一个 666，气势拉满，{bless}', '{nick}这波 666，好运加倍，{bless}',
    ],
    share: [
      '感谢{nick}分享了直播间，{bless}', '{nick}帮我们分享啦，{bless}',
      '谢谢{nick}分享直播间，{bless}', '{nick}分享出去了，{bless}',
    ],
  };
  const pickOne = (a) => a[(Math.random() * a.length) | 0];
  function cleanName(s) {
    const raw = String(s || '');
    // 抖音网页端推的进场/送礼用户是脱敏的：「首字***」、uid=111111。
    // 只念残字很怪，改念通用称呼；拿到真名的数据源后再走正常逻辑。
    if (/\*{2,}\s*$/.test(raw)) return '一位新朋友';
    return raw.replace(/[^\p{Script=Han}0-9a-zA-Z]/gu, '') || '神秘观众';
  }
  function compose(kind, nick, gift, count) {
    return pickOne(TPL[kind] || TPL.enter)
      .replace('{nick}', cleanName(nick))
      .replace('{gift}', String(gift || '礼物').slice(0, 8))
      .replace('{n}', String(count || 1))
      .replace('{bless}', pickOne(BLESS));
  }

  /* ---------- 配置同步 ---------- */
  let demoMode = false;
  function applyVoice(v) {
    if (!v || demoMode) return;   // 演示模式不连服务端，别被线上配置盖掉
    S.enabled = !!v.enabled;
    S.enter = v.enter !== false;
    S.gift = v.gift !== false;
    S.enterCooldown = Number(v.enterCooldown) || 0;
    S.volume = v.volume != null ? Number(v.volume) : 0.85;
    if (serverAudio) serverAudio.volume = S.volume;
    if (!S.enabled) stopAll();
  }

  function stopAll() {
    pending.length = 0;
    serverQueue.length = 0;
    curTag = null;
    if (synth) { try { synth.cancel(); } catch (e) {} }
    if (serverAudio) { try { serverAudio.pause(); } catch (e) {} serverAudio = null; }
  }

  // 演示模式：没有服务端配置，直接按演示开
  function demo(on) {
    demoMode = !!on;
    if (demoMode) {
      S.enabled = true;
      S.enter = true;
      S.gift = true;
      S.enterCooldown = 25;
      S.volume = 0.85;
    }
  }

  // 手机（iOS）要求先有一次用户点击才能出声；点一下页面就解锁，并把攒着的播掉
  let unlocked = false;
  function unlock() {
    unlocked = true;
    if (engine === 'browser') {
      try { synth.resume(); } catch (e) {}
      const u = new SpeechSynthesisUtterance('');
      if (voice) u.voice = voice;
      u.volume = 0;
      try { synth.speak(u); } catch (e) {}
    }
    flush();
  }
  addEventListener('pointerdown', unlock);
  addEventListener('touchend', unlock);
  addEventListener('keydown', unlock);

  window.Voice = {
    demo,
    enter: onEnter,
    gift: onGift,
    apply: applyVoice,        // WS hello / voice-config 里的 voice 对象喂进来
    unlock,
    say: speakNow,
    compose,
    state: () => ({
      ...S, demo: demoMode, engine, voice: voice ? voice.name : null, unlocked,
      speaking: synth ? synth.speaking : false, pending: pending.length,
    }),
  };
})();
