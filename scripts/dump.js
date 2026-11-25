// 递归打印 protobuf 字段树，用于定位 User / 内容字段编号
const fs = require('fs');
const { parseFields, decodeFrame, decodeResponse } = require('../lib/proto');

const target = process.argv[2];
const DIR = '/tmp/frames';

/** 尝试把字节串按嵌套 protobuf 再拆一层，成功则返回字段列表 */
function tryNested(buf) {
  if (buf.length < 2) return null;
  try {
    const f = parseFields(buf);
    if (!f.length) return null;
    if (f.length === 1 && f[0].wire === 2) return null; // 纯字符串
    return f;
  } catch (e) { return null; }
}

function dump(buf, depth, label, maxDepth = 5) {
  const pad = '  '.repeat(depth);
  let fields;
  try { fields = parseFields(buf); } catch (e) { return; }
  for (const f of fields) {
    if (f.wire === 0) {
      console.log(`${pad}${label}${f.field}: varint ${f.value}`);
    } else if (f.wire === 2) {
      const v = f.value;
      const asText = v.toString('utf8');
      const isReadable = /^[\x20-\x7e一-龥\s\p{Emoji}]{1,300}$/u.test(asText) && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(asText);
      const nested = depth < maxDepth ? tryNested(v) : null;
      if (isReadable && (!nested || asText.length > 3)) {
        console.log(`${pad}${label}${f.field}: string(${v.length}) ${JSON.stringify(asText.slice(0, 120))}`);
      } else if (nested) {
        console.log(`${pad}${label}${f.field}: message(${v.length})`);
        dump(v, depth + 1, '', maxDepth);
      } else {
        console.log(`${pad}${label}${f.field}: bytes(${v.length}) ${v.subarray(0, 16).toString('hex')}`);
      }
    }
  }
}

const seen = new Set();
for (const fn of fs.readdirSync(DIR).sort()) {
  const fr = decodeFrame(fs.readFileSync(`${DIR}/${fn}`));
  if (!fr) continue;
  for (const m of decodeResponse(fr.payload)) {
    if (m.method !== target || seen.has(m.method)) continue;
    seen.add(m.method);
    console.log(`\n########## ${m.method} ##########`);
    dump(m.payload, 0, '');
  }
}
