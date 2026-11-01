/**
 * 措辞转换 —— 从 psnb-obs 的 wording.ts 移植（MIT）。
 *
 * 依据（原作者实测结论）：拒绝是词级锚定，不是能力级理解；同义技术描述替换是
 * 唯一稳定有效的杠杆。本模块只做替换，不改技术内容，也不碰宿主。
 *
 * 与 perf 相关的两个约束沿用原实现：
 *   1) 术语按长度降序匹配，长词优先，替换后不再扫描（单次 replace）；
 *   2) ASCII 术语加词边界，避免 `hook` 命中 `hooked`。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, "data");

const ASCII_TERM = /^[A-Za-z0-9_\-. ]+$/;
const FALLBACK = { groups: {}, attribution: { rules: [], sample_ids: {} }, placeholder: { slots: [], rule: "" } };

function loadJson(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), "utf8"));
  } catch {
    return null;
  }
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class WordingEngine {
  constructor(file) {
    this.file = file ?? loadJson("wording_map.json") ?? FALLBACK;
    this.groups = this.file.groups ?? {};
    this.attr = (this.file.attribution?.rules ?? []).map((r) => [new RegExp(r.pattern, "g"), r.to]);
    this.slots = this.file.placeholder?.slots ?? [];

    const all = [];
    for (const [gname, g] of Object.entries(this.groups)) {
      for (const it of g.items ?? []) all.push([it.term, it.to, gname]);
    }
    all.sort((a, b) => b[0].length - a[0].length);
    this.terms = all;

    this.byGroup = {};
    for (const [term, to, gname] of all) {
      (this.byGroup[gname] ??= []).push([term, to, gname]);
    }
    this.reCache = new Map();
  }

  /** groups=null 表示全组；groups=[] 表示一个术语都不换（别把空数组当 falsy）。 */
  buildRegex(groups) {
    const key = groups === null ? "ALL" : [...groups].sort().join("|");
    const hit = this.reCache.get(key);
    if (hit) return hit;

    const picked = [];
    for (const g of groups === null ? Object.keys(this.groups) : groups) {
      picked.push(...(this.byGroup[g] ?? []));
    }
    picked.sort((a, b) => b[0].length - a[0].length);

    const alts = [];
    const lut = new Map();
    for (const [term, to] of picked) {
      if (ASCII_TERM.test(term)) {
        alts.push(`(?<![A-Za-z0-9_])${escapeRe(term)}(?![A-Za-z0-9_])`);
        lut.set(term.toLowerCase(), to);
      } else {
        alts.push(escapeRe(term));
        lut.set(term, to);
      }
    }
    const re = alts.length ? new RegExp(alts.join("|"), "gi") : /(?!x)x/;
    const entry = { re, lut };
    this.reCache.set(key, entry);
    return entry;
  }

  transform(text, groups = null) {
    const changes = [];
    let out = String(text ?? "");

    for (const [re, to] of this.attr) {
      re.lastIndex = 0;
      const m = re.exec(out);
      if (m) {
        changes.push({ kind: "attribution", src: m[0], dst: to, group: "" });
        out = out.replace(re, to);
      }
    }

    const { re, lut } = this.buildRegex(groups);
    re.lastIndex = 0;
    out = out.replace(re, (raw) => {
      const dst = lut.get(raw) ?? lut.get(raw.toLowerCase()) ?? raw;
      if (dst !== raw) changes.push({ kind: "term", src: raw, dst, group: this.groupOf(raw) });
      return dst;
    });

    return { text: out, changes, slots: this.findSlots(out) };
  }

  detect(text) {
    return this.transform(text).changes;
  }

  findSlots(text) {
    return this.slots.filter((s) => String(text).includes(s));
  }

  groupOf(term) {
    for (const [gname, items] of Object.entries(this.byGroup)) {
      if (items.some(([t]) => t === term)) return gname;
    }
    return "";
  }

  describe() {
    const lines = ["组别统计："];
    let total = 0;
    for (const [gname, g] of Object.entries(this.groups)) {
      const n = (g.items ?? []).length;
      total += n;
      lines.push(`  ${String(gname).padEnd(12)} ${String(g.label ?? "").padEnd(20)} ${n} 条`);
    }
    lines.push(`  合计 ${total} 条术语 + ${this.attr.length} 条归属规则`);
    return lines.join("\n");
  }

  /** 数据层不变式：替换文本不得再含触发词（大小写不敏感，因为匹配器是 IGNORECASE）。 */
  selfTriggerAudit() {
    const triggers = this.terms.map(([t]) => t);
    const bad = [];
    const pairs = this.terms.map(([t, to, g]) => [t, to, g]);
    for (const [re, to] of this.attr) pairs.push([re.source, to, "attribution"]);
    for (const [term, to, group] of pairs) {
      const low = String(to).toLowerCase();
      for (const trig of triggers) {
        if (trig && low.includes(String(trig).toLowerCase())) {
          bad.push({ group, term, trigger: trig, to });
          break;
        }
      }
    }
    return bad;
  }
}

export function transform(text, groups = null) {
  return new WordingEngine().transform(text, groups).text;
}

/** 给 CLI / 面板用的变更摘要。 */
export function renderChanges(changes) {
  if (!changes.length) return "（无命中）";
  return changes
    .map((c) => `  ${c.kind === "attribution" ? "@归因" : "[" + (c.group || "-") + "]"} ${JSON.stringify(c.src)} → ${JSON.stringify(c.dst)}`)
    .join("\n");
}
