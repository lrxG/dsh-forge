/**
 * 隐写注入层 —— 从 psnb-obs 的 stego.ts 移植（MIT）。
 *
 * 三条通道：vs（变体选择符）/ tag（Unicode Tag 区）/ zw（零宽二进制）。
 * 用途：把载荷编进不可见字符（附在载体后）、解码疑似样本、扫描隐写含量。
 *
 * 只做编解码与统计，不发起任何网络请求，也不写文件。
 */

// ------------------------------------------------------------------ 常量

export const VS_SAMPLE_BASE = 0xe00f0;
export const VS_STD_BASE = 0xe0100;
export const TAG_BASE = 0xe0000;
export const TAG_START = 0xe0001;
export const TAG_END = 0xe007f;

const ZW_ZERO = "\u200c"; // ZWNJ
const ZW_ONE = "\u200b"; // ZWSP

// ------------------------------------------------------------------ 编码

function utf8Units(text, asciiOnly) {
  if (asciiOnly) {
    const out = [];
    for (const ch of String(text)) {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp >= 0x20 && cp <= 0x7e) out.push(cp);
    }
    return out;
  }
  return Array.from(new TextEncoder().encode(String(text)));
}

export function encodeVs(text, base = VS_SAMPLE_BASE, asciiOnly = false) {
  return utf8Units(text, asciiOnly).map((u) => String.fromCodePoint(base + u)).join("");
}

export function encodeTag(text, envelope = false, asciiOnly = false) {
  const body = utf8Units(text, asciiOnly).map((u) => String.fromCodePoint(TAG_BASE + u)).join("");
  return envelope ? String.fromCodePoint(TAG_START) + body + String.fromCodePoint(TAG_END) : body;
}

export function encodeZw(text) {
  const bits = [];
  for (const b of Array.from(new TextEncoder().encode(String(text)))) {
    for (const bit of b.toString(2).padStart(8, "0")) bits.push(bit);
  }
  return bits.map((bit) => (bit === "1" ? ZW_ONE : ZW_ZERO)).join("");
}

export function encode(text, channel = "vs") {
  if (channel === "vs") return encodeVs(text);
  if (channel === "tag") return encodeTag(text, true);
  return encodeZw(text);
}

// ------------------------------------------------------------------ 解码

function decodeUnitsAsUtf8(units) {
  if (!units.length) return "";
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(units));
  } catch {
    return units.filter((u) => u >= 0x20 && u <= 0x7e).map((u) => String.fromCharCode(u)).join("");
  }
}

export function decodeVsAt(text, base) {
  const units = [];
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= base && cp <= base + 0xff) units.push(cp - base);
  }
  return decodeUnitsAsUtf8(units);
}

function readability(text) {
  if (!text) return 0;
  const sample = Array.from(text).slice(0, 200);
  let good = 0;
  for (const ch of sample) {
    if (/[\p{L}\p{N}\s.,!?:;-_/@#()[\]{}"']/u.test(ch)) good += 1;
  }
  return sample.length ? good / sample.length : 0;
}

export function decodeVs(text, base) {
  if (base !== undefined) return { text: decodeVsAt(text, base), base, auto: false };
  const candidates = [VS_SAMPLE_BASE, VS_STD_BASE, VS_STD_BASE + 1, TAG_BASE];
  let best = { score: 0, text: "", base: VS_SAMPLE_BASE };
  for (const b of candidates) {
    const t = decodeVsAt(text, b);
    const s = readability(t);
    if (s > best.score) best = { score: s, text: t, base: b };
  }
  return { text: best.text, base: best.base, auto: true };
}

export function decodeTag(text) {
  const units = [];
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0) ?? 0;
    // 包封字符不参与解码（encodeTag(envelope=true) 会写入它们）
    if (cp === TAG_START || cp === TAG_END) continue;
    // 收全字节区间：上游只收 0xe0020–0xe007e，多字节 UTF-8 载荷必然丢失
    if (cp >= TAG_BASE && cp <= TAG_BASE + 0xff) units.push(cp - TAG_BASE);
  }
  return decodeUnitsAsUtf8(units);
}

export function decodeZw(text) {
  const bits = [];
  for (const ch of String(text)) {
    if (ch === ZW_ONE) bits.push("1");
    else if (ch === ZW_ZERO) bits.push("0");
  }
  if (!bits.length || bits.length % 8 !== 0) return "";
  const bytes = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8).join(""), 2);
  }
  return decodeUnitsAsUtf8(Array.from(bytes));
}

export function countChannels(text) {
  let vs = 0;
  let tag = 0;
  let zw = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0) ?? 0;
    if ((cp >= 0xe0100 && cp <= 0xe01ef) || (cp >= 0xe00f0 && cp <= 0xe00ff)) vs += 1;
    else if (cp >= TAG_BASE && cp <= TAG_BASE + 0xff && cp !== TAG_START && cp !== TAG_END) tag += 1;
    else if (ch === ZW_ONE || ch === ZW_ZERO || ch === "\u200d" || ch === "\u2060" || ch === "\ufeff") zw += 1;
  }
  return { vs, tag, zw };
}

export function decode(text, channel) {
  if (channel === "vs") {
    const r = decodeVs(text);
    return { text: r.text, channel: "vs", base: `0x${r.base.toString(16)}`, auto: false };
  }
  if (channel === "tag") return { text: decodeTag(text), channel: "tag", base: null, auto: false };
  if (channel === "zw") return { text: decodeZw(text), channel: "zw", base: null, auto: false };

  const c = countChannels(text);
  if (c.tag >= 10) {
    const t = decodeTag(text);
    if (t) return { text: t, channel: "tag", base: null, auto: true };
  }
  if (c.vs >= 10) {
    const r = decodeVs(text);
    return { text: r.text, channel: "vs", base: `0x${r.base.toString(16)}`, auto: true };
  }
  if (c.zw >= 16) {
    const t = decodeZw(text);
    if (t) return { text: t, channel: "zw", base: null, auto: true };
  }
  if (c.tag > 0) {
    const t = decodeTag(text);
    if (t) return { text: t, channel: "tag", base: null, auto: true };
  }
  if (c.zw > 0) {
    const t = decodeZw(text);
    if (t) return { text: t, channel: "zw", base: null, auto: true };
  }
  const r = decodeVs(text);
  return { text: r.text, channel: "vs", base: `0x${r.base.toString(16)}`, auto: true };
}

// ------------------------------------------------------------------ 载体与扫描

export function wrap(payload, carrier = "🎉", channel = "vs") {
  return carrier + encode(payload, channel);
}

export function scan(text) {
  const counts = countChannels(text);
  const total = Math.max(String(text).length, 1);
  const hits = [];
  for (const [channel, count] of Object.entries(counts)) {
    if (count < 10) continue;
    let sample = "";
    if (channel === "vs") sample = decodeVs(text).text;
    else if (channel === "tag") sample = decodeTag(text);
    else sample = decodeZw(text);
    hits.push({ channel, count, ratio: count / total, sample });
  }
  return { total: String(text).length, clean: hits.length === 0, hits };
}

export function renderScan(result) {
  const status = result.clean ? "✓ 干净（无隐写符号）" : "⚠ 检测到隐写通道";
  const lines = [`[dsh-forge stego] 扫描 ${result.total} 字符 —— ${status}`];
  for (const h of result.hits) {
    const icon = h.count >= 50 ? "⚠" : "·";
    lines.push(`  ${icon} ${h.channel.padEnd(8)} ${String(h.count).padStart(6)} 个符号（${(h.ratio * 100).toFixed(2)}%）  试解: ${JSON.stringify(String(h.sample).slice(0, 60))}`);
  }
  if (result.clean) lines.push("  （无 VS / Tag / 零宽二进制符号）");
  return lines.join("\n");
}
