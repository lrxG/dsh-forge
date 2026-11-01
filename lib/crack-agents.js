/**
 * 破解模式子智能体提示词（triage / static / dynamic / patch / verify）。
 *
 * 和红队不同：破解没有“靶标”维度，角色稿就是模式级文件
 * `$DSH_HOME/crack/agents/<code>.md`，改一次所有破解会话都生效。
 *
 * 默认稿来自随包 `presets/crack/agents/<code>.md`；这里只做文件读写与默认回填。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crackPersonaDefault, crackPersonaInfo } from "./crack/index.js";

const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_BYTES = 256 * 1024;
const BUNDLED_DIR = fileURLToPath(new URL("../presets/crack/agents/", import.meta.url));

export const CRACK_ROLES = [
  { id: "triage", label: "样本研判", note: "识别样本类型、壳、入口和关键校验点，只做判断，不下结论。" },
  { id: "static", label: "静态分析", note: "反编译、字符串、交叉引用、算法与密钥恢复，产出可复核的证据。" },
  { id: "dynamic", label: "动态分析", note: "运行时调试、脱壳、抓取、内存观测，验证静态结论。" },
  { id: "patch", label: "补丁 / 注册机", note: "在授权样本上写补丁、keygen、重打包脚本，保留回滚副本。" },
  { id: "verify", label: "验证", note: "在干净环境复现“修补前失败、修补后成功”，只验证被改动的行为。" },
];

const ROLE_BY_ID = new Map(CRACK_ROLES.map((r) => [r.id, r]));

export function isCrackRole(id) {
  return ROLE_BY_ID.has(String(id || ""));
}

export function crackAgentsDir(home) {
  return path.join(path.normalize(String(home || "")), "crack", "agents");
}

export function crackAgentPath(home, id) {
  if (!isCrackRole(id)) throw new Error("未知破解角色：" + id);
  return path.join(crackAgentsDir(home), id + ".md");
}

function bundledPath(id) {
  if (!isCrackRole(id)) return "";
  return path.join(BUNDLED_DIR, id + ".md");
}

export function crackAgentDefault(id) {
  if (!isCrackRole(id)) throw new Error("未知破解角色：" + id);
  try {
    return fs.readFileSync(bundledPath(id), "utf8");
  } catch {
    return "";
  }
}

function statOf(fp) {
  try {
    const st = fs.statSync(fp);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

export function listCrackAgents(home) {
  return CRACK_ROLES.map((role) => {
    const fp = crackAgentPath(home, role.id);
    const st = statOf(fp);
    let content = "";
    try { content = fs.readFileSync(fp, "utf8"); } catch { content = ""; }
    const fallback = crackAgentDefault(role.id);
    return {
      id: role.id,
      label: role.label,
      note: role.note,
      path: fp,
      exists: Boolean(st),
      content: st ? content : fallback,
      customized: Boolean(st) && String(content).trim() !== String(fallback).trim(),
      chars: String(st ? content : fallback).length,
      updated_at: st ? st.mtime.toISOString() : null,
      default_content: fallback,
      scope: "整个破解模式",
    };
  });
}

/** 主会话人格：可写用户覆盖 `$DSH_HOME/crack/persona.md`，重启 dsh 生效。 */
export function crackMainPrompt(home) {
  const def = crackPersonaDefault();
  const info = crackPersonaInfo(home);
  const legacy = info.legacy_ignored
    ? "检测到旧版默认人格（并行开子会话、没有案件账本），已忽略；保存一次即可写入当前版本。"
    : "";
  return {
    label: "破解指挥官",
    content: info.text,
    chars: info.text.length,
    default_content: def,
    path: info.path,
    custom: !info.builtin,
    editable: true,
    scope: "整个破解模式 · 重启 DeepSeek Harness 生效",
    note: ((info.builtin
      ? "当前使用内置默认稿；保存后写入覆盖文件，重启 DeepSeek Harness 生效。"
      : "当前使用用户覆盖稿；保存后重启 DeepSeek Harness 生效。")
      + (legacy ? " " + legacy : ""))
      + " 主会话另有一段代码级「工作流契约」常驻（后台任务与派活纪律），面板不能编辑；实际内容见「提示词」页的实际组装。",
  };
}

export async function saveCrackPersona(home, content) {
  const text = String(content ?? "");
  if (!text.trim()) throw new Error("人格不能为空");
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new Error("人格太大（上限 256KB）");
  const fp = path.join(path.normalize(String(home || "")), "crack", "persona.md");
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, text, "utf8");
  return { chars: text.length, path: fp };
}

/** 删除用户覆盖（含 persona.local.md），回落到内置默认。 */
export async function resetCrackPersona(home) {
  const root = path.join(path.normalize(String(home || "")), "crack");
  for (const name of ["persona.md", "persona.local.md"]) {
    try { fs.unlinkSync(path.join(root, name)); } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  return { ok: true };
}

export async function saveCrackAgent(home, id, content) {
  if (!isCrackRole(id)) throw new Error("未知破解角色：" + id);
  const text = String(content ?? "");
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new Error("提示词太大（上限 256KB）");
  const fp = crackAgentPath(home, id);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = fp + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, fp);
  return { id, chars: text.length, path: fp };
}

export async function resetCrackAgent(home, id) {
  const text = crackAgentDefault(id);
  if (!text) throw new Error("读不到包内默认稿：" + id);
  return saveCrackAgent(home, id, text);
}
