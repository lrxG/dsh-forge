/**
 * Skill 路由：只负责“该先看哪 1–3 个 skill”，不负责执行。
 *
 * 读取现有 skill 的 description/whenToUse，按 domain + query 打分。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DOMAIN_WORDS = {
  webapi: ["web", "api", "http", "xss", "sqli", "ssrf", "upload", "auth", "cors", "csrf", "jwt", "oauth", "越权", "接口", "浏览器", "业务"],
  intranet: ["内网", "横向", "凭据", "服务", "端口", "隧道", "代理", "ad", "域", "smb", "redis", "数据库"],
  reverse: ["逆向", "apk", "android", "ios", "frida", "jadx", "ghidra", "js", "electron", "binary", "binary", "协议", "脱壳", "补丁", "crack"],
  verify: ["验证", "证据", "定级", "复现", "coverage", "收口", "audit", "sink", "control"],
};

function listFiles(root) {
  const out = [];
  let entries = [];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name.startsWith("_")) continue;
    const full = join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
    else if (entry.isDirectory()) {
      try {
        if (statSync(join(full, "SKILL.md")).isFile()) out.push(join(full, "SKILL.md"));
      } catch { /* not a skill directory */ }
    }
  }
  return out;
}

function parseSkill(path) {
  const text = readFileSync(path, "utf8");
  const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim()
    || (path.endsWith("SKILL.md") ? path.split(/[\\/]/).slice(-2, -1)[0] : path.split(/[\\/]/).pop().replace(/\.md$/, ""));
  const desc = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim() || "";
  const when = /^whenToUse:\s*(.+)$/m.exec(text)?.[1]?.trim() || "";
  return { name, desc, when, path };
}

export function selectSkills({ home, domain = "webapi", query = "", limit = 3 } = {}) {
  const root = home || process.env.DSH_HOME || join(homedir(), ".dsh");
  const files = [
    ...listFiles(join(root, "redteam", "skills")),
    ...listFiles(join(root, "crack", "skills")),
    ...listFiles(join(root, "skills")),
  ];
  const words = DOMAIN_WORDS[domain] || DOMAIN_WORDS.webapi;
  const q = String(query || "").toLowerCase();
  const scored = [];
  for (const path of files) {
    let skill;
    try { skill = parseSkill(path); } catch { continue; }
    const hay = `${skill.name} ${skill.desc} ${skill.when}`.toLowerCase();
    let score = 0;
    for (const word of words) if (hay.includes(word)) score += 1;
    for (const token of q.split(/[\s,，;；]+/).filter(Boolean)) {
      if (hay.includes(token)) score += 2;
    }
    if (domain === "reverse" && /^(rev-|crack-|seagull-reverse|thick-client|protocol-reverse|binary-diff)/.test(skill.name)) score += 3;
    if (domain === "verify" && /finding-severity|control-matrix|audit-sink-flow/.test(skill.name)) score += 2;
    if (score > 0) scored.push({ ...skill, score });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, Math.max(1, Math.min(Number(limit) || 3, 6))).map(({ path, ...rest }) => rest);
}
