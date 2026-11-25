// 极简 protobuf 解析：只做长度分隔字段与 varint，够解析抖音 im 协议用
const zlib = require('zlib');

function readVarint(buf, off) {
  let val = 0, shift = 0, i = off;
  while (i < buf.length) {
    const c = buf[i++];
    val += (c & 0x7f) * Math.pow(2, shift);
    if (!(c & 0x80)) return [val, i];
    shift += 7;
    if (shift > 63) break;
  }
  return [val, i];
}

/** 把 buffer 拆成 { field, wireType, value } 列表 */
function parseFields(buf) {
  const out = [];
  let off = 0;
  while (off < buf.length) {
    let tag;
    [tag, off] = readVarint(buf, off);
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) {
      let v; [v, off] = readVarint(buf, off);
      out.push({ field, wire, value: v });
    } else if (wire === 2) {
      let len; [len, off] = readVarint(buf, off);
      out.push({ field, wire, value: buf.subarray(off, off + len) });
      off += len;
    } else if (wire === 5) {
      out.push({ field, wire, value: buf.subarray(off, off + 4) }); off += 4;
    } else if (wire === 1) {
      out.push({ field, wire, value: buf.subarray(off, off + 8) }); off += 8;
    } else {
      break; // 不支持的 wire type，停止
    }
  }
  return out;
}

const get = (fields, n) => fields.find((f) => f.field === n);
const getAll = (fields, n) => fields.filter((f) => f.field === n);
const toStr = (f) => {
  if (!f) return '';
  if (Buffer.isBuffer(f.value)) return f.value.toString('utf8');
  return String(f.value);   // varint 字段也允许安全取字符串
};

/** PushFrame -> { payload: Buffer, compress: string } */
function decodeFrame(buf) {
  const f = parseFields(buf);
  // 抖音 PushFrame: 5=headers(repeated) 6=payloadEncoding("pb") 7=payloadType("msg") 8=payload
  const payload = get(f, 8) || get(f, 6);
  if (!payload) return null;
  const compress = f
    .filter((x) => x.field === 5)
    .map((h) => parseFields(h.value))
    .map((hf) => ({ k: toStr(get(hf, 1)), v: toStr(get(hf, 2)) }))
    .find((x) => x.k === 'compress_type');
  const compressName = compress ? compress.v : '';
  let data = payload.value;
  if (compressName === 'gzip') {
    try { data = zlib.gunzipSync(data); } catch (e) { return null; }
  } else if (compressName === 'zlib') {
    try { data = zlib.inflateSync(data); } catch (e) { return null; }
  }
  if (!data.length) return null;
  return { payload: data, compress: compressName };
}

/** Response -> Message[] */
function decodeResponse(buf) {
  const f = parseFields(buf);
  return getAll(f, 1).map((m) => {
    const mf = parseFields(m.value);
    return {
      method: toStr(get(mf, 1)),
      payload: get(mf, 2) ? get(mf, 2).value : Buffer.alloc(0),
      msgId: get(mf, 3) ? String(get(mf, 3).value) : '',
      msgType: get(mf, 4) ? get(mf, 4).value : 0,
      raw: mf,
    };
  });
}

module.exports = { parseFields, get, getAll, toStr, decodeFrame, decodeResponse };
