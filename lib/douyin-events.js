// 把抖音 im 协议的原始消息，归一化成我们自己的事件格式
const { parseFields, get, getAll, toStr } = require('./proto');

/** User 消息 -> 精简用户信息 */
function parseUser(buf) {
  if (!buf) return null;
  const f = parseFields(buf);
  const urlList = get(f, 9); // UrlList { repeated string url = 1 }
  const urls = urlList ? getAll(parseFields(urlList.value), 1).map(toStr) : [];
  return {
    id: get(f, 1) ? String(get(f, 1).value) : '',
    shortId: get(f, 2) ? String(get(f, 2).value) : '',   // 显示的抖音号
    displayId: toStr(get(f, 38)),                        // 页面显示的 ID 串
    secUid: toStr(get(f, 46)),
    nickname: toStr(get(f, 3)),
    avatar: urls[0] || '',
    fanLevel: get(f, 23) ? Number(get(get(parseFields(get(f, 23).value), 6) ? parseFields(get(f, 23).value) : [], 6)?.value ?? 0) : 0,
  };
}

function parseCommon(buf) {
  const f = parseFields(buf || Buffer.alloc(0));
  const dt = get(f, 8); // displayText {key, pattern, ...}
  return {
    method: toStr(get(f, 1)),
    msgId: get(f, 2) ? String(get(f, 2).value) : '',
    roomId: get(f, 3) ? String(get(f, 3).value) : '',
    key: dt ? toStr(get(parseFields(dt.value), 1)) : '',
  };
}

/** 从 UrlList{repeated string url = 1} 里取第一张图 */
function parseUrlList(buf) {
  if (!buf) return '';
  const f = parseFields(buf);
  return getAll(f, 1).map(toStr).filter(Boolean)[0] || '';
}

/**
 * GiftMessage.field 15 = GiftStruct，实测结构：
 *   1  = UrlList (礼物图标)
 *   2  = "送出小心心" 描述
 *   5  = 礼物 ID
 *   7  = 礼物类型
 *   12 = 抖币单价
 *  21/74 = 其他尺寸的图标
 */
function parseGiftInfo(buf) {
  if (!buf) return null;
  const f = parseFields(buf);
  const idField = get(f, 5);
  const desc = toStr(get(f, 2));                       // "送出小心心" / "送了一杯大啤酒"
  const name = toStr(get(f, 16)) || desc.replace(/^送出了?/, '').replace(/^一[杯捧朵个张]/, '').trim() || '礼物';
  const price = get(f, 12);
  return {
    id: idField && idField.wire === 0 ? String(idField.value) : '',
    name,
    desc,
    diamond: price && price.wire === 0 ? Number(price.value) : 0,
    icon: parseUrlList(get(f, 1)?.value) || parseUrlList(get(f, 21)?.value) || parseUrlList(get(f, 74)?.value),
  };
}

/**
 * 原始 Message{method,payload} -> 事件对象
 * 返回 null 表示不关心该消息
 */
function toEvent(msg) {
  const m = msg.method;
  const p = msg.payload;
  let f;
  try { f = parseFields(p); } catch (e) { return null; }

  const common = parseCommon(get(f, 1)?.value);
  const ts = get(f, 15) || get(f, 21);
  const base = {
    type: '',
    method: m,
    msgId: common.msgId,
    roomId: common.roomId,
    ts: ts && ts.wire === 0 ? Number(ts.value) : Math.floor(Date.now() / 1000),
    at: new Date().toISOString(),
  };

  switch (m) {
    case 'WebcastMemberMessage': {
      const user = parseUser(get(f, 2)?.value);
      if (!user) return null;
      const memberCount = get(f, 3); // 当前在线人数
      return { ...base, type: 'enter', user, online: memberCount ? Number(memberCount.value) : null };
    }
    case 'WebcastChatMessage': {
      const user = parseUser(get(f, 2)?.value);
      if (!user) return null;
      return { ...base, type: 'chat', user, text: toStr(get(f, 3)) };
    }
    case 'WebcastSocialMessage': {
      const user = parseUser(get(f, 2)?.value);
      if (!user) return null;
      // field 4 = 动作枚举(1 关注 / 3 分享)，common.displayText.key 是对应的文案 key
      const actionType = get(f, 4);
      const action = actionType && actionType.wire === 0 ? Number(actionType.value) : 0;
      const type = action === 1 ? 'follow' : action === 3 ? 'share' : 'social';
      return { ...base, type, user, action, actionKey: common.key };
    }
    case 'WebcastLikeMessage': {
      // 注意：2=点赞数 3=累计点赞 5=user
      const user = parseUser(get(f, 5)?.value);
      const count = get(f, 2);
      const total = get(f, 3);
      return {
        ...base, type: 'like', user,
        count: count && count.wire === 0 ? Number(count.value) : 0,
        total: total && total.wire === 0 ? Number(total.value) : 0,
      };
    }
    case 'WebcastGiftMessage': {
      // 实测：2=礼物ID(varint) 7=送礼用户 9=礼物名称文本 11=秒级时间戳 15=GiftStruct
      const user = parseUser(get(f, 7)?.value);
      if (!user) return null;
      const gift = parseGiftInfo(get(f, 15)?.value);
      const repeat = get(f, 5);   // 连击数量
      const combo = get(f, 6);    // 连击序号
      const group = get(f, 9);
      return {
        ...base, type: 'gift', user, gift,
        count: repeat && repeat.wire === 0 ? Number(repeat.value) : 1,
        combo: combo && combo.wire === 0 ? Number(combo.value) : 0,
        groupCount: group && group.wire === 0 ? Number(group.value) : 0,
        text: toStr(get(f, 9)),
      };
    }
    case 'WebcastRoomUserSeqMessage': {
      // 2=榜单条目(repeated) 3=当前在线人数 7=累计观看
      const online = get(f, 3);
      const total = get(f, 7);
      return {
        ...base, type: 'stats',
        online: online ? Number(online.value) : null,
        totalViewers: total ? Number(total.value) : null,
      };
    }
    default:
      return null;
  }
}

module.exports = { toEvent, parseUser };
