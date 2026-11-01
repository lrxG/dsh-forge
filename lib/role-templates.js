/**
 * 角色稿变体：按「模式 + 角色」存可复用文本。
 *
 * 存储按「模式 + 角色」隔离：
 *   role-templates/<mode>/<role>/<id>.md
 *
 * - 红队：plan / recon / assess / vuln-scan / exploit / internal
 * - 破解：triage / static / dynamic / patch / verify
 *
 * 模板只保存文本；载入后要点“保存”才写当前靶标（红队）或破解模式文件（破解）。
 */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PROMPTS } from "./redteam/store-core.js";
import { CRACK_ROLES, crackAgentDefault } from "./crack-agents.js";
import { crackPersonaDefault } from "./crack/index.js";
import { bundledPresetPrefix } from "./preset-prompt.js";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_BYTES = 256 * 1024;

export const TEMPLATE_MODES = ["redteam", "crack"];
export const PERSONA_ROLE = "__persona__";

export function rolesOf(mode) {
  if (mode === "crack") return CRACK_ROLES.map((r) => r.id);
  if (mode === "redteam") return Object.keys(DEFAULT_PROMPTS);
  return [];
}

function modeLabel(mode) {
  return mode === "crack" ? "破解模式" : "红队模式";
}

export function isRole(mode, role) {
  if (role === PERSONA_ROLE) return mode === "redteam" || mode === "crack";
  return rolesOf(String(mode || "")).includes(String(role || ""));
}

function templatesRoot(home) {
  return path.join(home, "redteam", "role-templates");
}

function dirOf(home, mode, role) {
  return path.join(templatesRoot(home), mode, role);
}

function sizeOf(text) {
  const chars = String(text || "").length;
  return { chars, tokens: Math.ceil(chars / 2) };
}

export function roleDefault(mode, role) {
  if (role === PERSONA_ROLE) {
    if (mode === "crack") return crackPersonaDefault();
    if (mode === "redteam") return bundledPresetPrefix("redteam");
    return "";
  }
  if (mode === "crack") return crackAgentDefault(role);
  return DEFAULT_PROMPTS[role] || "";
}

export function listRoleTemplates(home, mode, role) {
  if (!isRole(mode, role)) throw new Error("未知角色：" + mode + "/" + role);
  const dir = dirOf(home, mode, role);
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
  const items = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    const id = e.name.slice(0, -3);
    if (!ID_RE.test(id)) continue;
    let content = "";
    try { content = fs.readFileSync(path.join(dir, e.name), "utf8"); } catch { continue; }
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, id + ".json"), "utf8")) || {}; } catch { meta = {}; }
    items.push({
      id,
      name: typeof meta.name === "string" && meta.name.trim() ? meta.name : id,
      ...sizeOf(content),
      updated_at: meta.updated_at || null,
    });
  }
  return items.sort((x, y) => x.name.localeCompare(y.name));
}

export function readRoleTemplate(home, mode, role, id) {
  if (!isRole(mode, role)) throw new Error("未知角色：" + mode + "/" + role);
  const key = String(id || "").trim();
  if (!ID_RE.test(key)) throw new Error("模板标识不合法");
  const fp = path.join(dirOf(home, mode, role), key + ".md");
  if (!fs.existsSync(fp)) throw new Error("模板不存在：" + key);
  return fs.readFileSync(fp, "utf8");
}

export function saveRoleTemplate(home, mode, role, id, name, content) {
  if (!isRole(mode, role)) throw new Error("未知角色：" + mode + "/" + role);
  const key = String(id || "").trim();
  if (!ID_RE.test(key)) throw new Error("模板标识不合法");
  const text = String(content || "");
  if (!text.trim()) throw new Error("模板内容不能为空");
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new Error("模板太大（上限 256KB）");
  const dir = dirOf(home, mode, role);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, key + ".md." + process.pid + ".tmp");
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, path.join(dir, key + ".md"));
  fs.writeFileSync(path.join(dir, key + ".json"), JSON.stringify({
    name: String(name || key).trim().slice(0, 64) || key,
    updated_at: new Date().toISOString(),
  }, null, 2), "utf8");
  return { id: key, name: String(name || key).trim().slice(0, 64) || key, ...sizeOf(text) };
}

export function deleteRoleTemplate(home, mode, role, id) {
  if (!isRole(mode, role)) throw new Error("未知角色：" + mode + "/" + role);
  const key = String(id || "").trim();
  if (!ID_RE.test(key)) throw new Error("模板标识不合法");
  let removed = false;
  for (const fp of [path.join(dirOf(home, mode, role), key + ".md"), path.join(dirOf(home, mode, role), key + ".json")]) {
    try { fs.unlinkSync(fp); removed = true; } catch { /* ignore */ }
  }
  return { removed };
}

export function roleTemplateStatus(home, mode, role) {
  if (!isRole(mode, role)) throw new Error("未知角色：" + mode + "/" + role);
  return {
    mode,
    mode_label: modeLabel(mode),
    role,
    roles: rolesOf(mode),
    items: listRoleTemplates(home, mode, role),
    default_content: roleDefault(mode, role),
  };
}
