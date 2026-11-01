/**
 * dsh 原生指令文件（AGENTS.md / CLAUDE.md）的发现与编辑。
 *
 * 只做三件事：
 *   · 按 dsh-agent-instructions 的默认规则列出会进上下文的文件；
 *   · 只允许改这些候选文件，拒绝任意外路径；
 *   · 写盘用宿主的 atomicWriteFile，避免半截文件。
 *
 * 这里不判断“哪个规则集生效”——dsh 自己会按 用户级 → 项目根 → cwd 顺序拼接。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteFile } from "./core.js";
import { readLastCwd } from "./rules.js";

/* 与 dsh-agent-instructions 的默认候选一致。 */
export const INSTRUCTION_NAMES = ["AGENTS.md", "CLAUDE.md", "AGENTS.local.md", "CLAUDE.local.md"];
export const INSTRUCTION_BUDGET_BYTES = 65536;
const MAX_FILE_BYTES = 512 * 1024;
const PROJECT_MARKERS = [".git"];

function agentsHome() {
  const env = process.env.DSH_AGENTS_HOME;
  if (env && String(env).trim()) return path.normalize(String(env).trim());
  return path.join(os.homedir(), ".agents");
}

function statFile(fp) {
  try {
    const st = fs.statSync(fp);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

function existsDir(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch { return false }
}

/* dsh 只认 .git 作为项目根标记；这里保持一致，免得列出一堆 dsh 根本不读的文件。 */
function chainForCwd(cwd) {
  const start = path.resolve(cwd);
  let root = null;
  let cur = start;
  for (;;) {
    for (const marker of PROJECT_MARKERS) {
      if (fs.existsSync(path.join(cur, marker))) { root = cur; break; }
    }
    if (root) break;
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  if (!root) root = start;
  const chain = [];
  let walker = start;
  for (let i = 0; i < 32; i += 1) {
    chain.push(walker);
    if (walker === root) break;
    const parent = path.dirname(walker);
    if (!parent || parent === walker) break;
    walker = parent;
  }
  return chain.reverse();
}

function displayOf(home, cwd, fp) {
  const abs = path.resolve(fp);
  if (abs === path.resolve(home, "AGENTS.md")) return "$DSH_HOME/AGENTS.md";
  if (abs === path.resolve(agentsHome(), "AGENTS.md")) return "$DSH_AGENTS_HOME/AGENTS.md";
  if (!cwd) return abs;
  const base = path.resolve(cwd);
  if (path.dirname(abs) === base) return "./" + path.basename(abs);
  const rel = path.relative(base, abs);
  return rel.split(path.sep).join("/");
}

function scopeLabel(scope) {
  if (scope === "user-global") return "用户级";
  if (scope === "agents-global") return "共享级";
  if (scope === "root") return "项目根";
  if (scope === "cwd") return "当前目录";
  return "上级目录";
}

function pushFile(out, home, cwd, fp, scope, options = {}) {
  const abs = path.resolve(fp);
  if (out.some((row) => row.path === abs)) return;
  const st = statFile(abs);
  if (!st && options.includeMissing !== true) return;
  out.push({
    path: abs,
    name: path.basename(abs),
    display: displayOf(home, cwd, abs),
    scope,
    scopeLabel: scopeLabel(scope),
    exists: Boolean(st),
    size: st ? st.size : 0,
    mtime: st ? st.mtime.toISOString() : null,
  });
}

/**
 * 列出当前 dsh 会读取的全部指令文件。
 * @param {string} home - DSH_HOME。
 * @returns {{ ok: boolean, cwd: string, projectRoot: string, files: object[], totalBytes: number, budgetBytes: number }}
 */
export function listInstructionFiles(home) {
  const root = path.normalize(String(home || ""));
  const cwd = readLastCwd(root) || "";
  const out = [];

  /* 用户级：dsh 只读 AGENTS.md，不读 CLAUDE.md。 */
  pushFile(out, root, cwd, path.join(root, "AGENTS.md"), "user-global", { includeMissing: true });

  /* 共享级：~/.agents 存在时才列，避免给没这个目录的人塞一行空文件。 */
  const sharedDir = agentsHome();
  if (existsDir(sharedDir) || statFile(path.join(sharedDir, "AGENTS.md"))) {
    pushFile(out, root, cwd, path.join(sharedDir, "AGENTS.md"), "agents-global", { includeMissing: true });
  }

  /* 项目级：项目根 → cwd，每层 4 个候选，只列已存在的。 */
  let chain = [];
  if (cwd) chain = chainForCwd(cwd);
  for (const dir of chain) {
    const before = out.length;
    for (const name of INSTRUCTION_NAMES) {
      const fp = path.join(dir, name);
      const scope = dir === chain[0] ? "root" : dir === path.resolve(cwd) ? "cwd" : "ancestor";
      pushFile(out, root, cwd, fp, scope);
    }
    /* 项目根和 cwd 没有指令文件时给一个“新建”位；中间目录只列已存在的，避免刷一屏空行。 */
    if (out.length === before && (dir === chain[0] || dir === path.resolve(cwd))) {
      const scope = dir === chain[0] ? "root" : "cwd";
      pushFile(out, root, cwd, path.join(dir, "AGENTS.md"), scope, { includeMissing: true });
    }
  }

  const totalBytes = out.reduce((n, row) => n + (row.exists ? row.size : 0), 0);
  return {
    ok: true,
    cwd,
    projectRoot: chain[0] || "",
    files: out,
    totalBytes,
    budgetBytes: INSTRUCTION_BUDGET_BYTES,
    note: "DeepSeek Harness 按 用户级 → 共享级 → 项目根 → 当前目录 顺序拼接；总预算 64KB，超出会截断。",
  };
}

/**
 * 校验一个路径是不是 dsh 真会读取的指令文件。
 * 只允许：用户级/共享级的 AGENTS.md；项目根到 cwd 每一层里的 4 个候选名。
 */
export function editableInstructionPath(home, requested) {
  const root = path.normalize(String(home || ""));
  const fp = path.resolve(String(requested || ""));
  const name = path.basename(fp);
  if (!INSTRUCTION_NAMES.includes(name)) {
    throw new Error("只能编辑 AGENTS.md / CLAUDE.md / AGENTS.local.md / CLAUDE.local.md");
  }
  const dir = path.dirname(fp);
  if (dir === path.resolve(root) || dir === path.resolve(agentsHome())) {
    if (name !== "AGENTS.md") throw new Error("用户级只读 AGENTS.md，DeepSeek Harness 不读同名 CLAUDE.md");
    return fp;
  }
  const cwd = readLastCwd(root);
  if (!cwd) throw new Error("还没有记录工作目录；先发一条消息，或只改用户级 AGENTS.md");
  const chain = chainForCwd(cwd).map((d) => path.resolve(d));
  if (!chain.includes(dir)) throw new Error("只能改项目根到当前目录之间的指令文件");
  return fp;
}

/** 读取一个指令文件；不存在时按空内容返回，方便“新建”。 */
export function readInstructionFile(home, requested) {
  const fp = editableInstructionPath(home, requested);
  let content = "";
  try {
    content = fs.readFileSync(fp, "utf8");
  } catch (e) {
    if (e && e.code !== "ENOENT") throw e;
  }
  return { ok: true, path: fp, content, exists: fs.existsSync(fp) };
}

/** 写入一个指令文件；空内容也允许，dsh 会把空文件当作无内容。 */
export async function saveInstructionFile(home, requested, content) {
  const fp = editableInstructionPath(home, requested);
  const text = String(content ?? "");
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
    throw new Error("指令文件太大（单文件上限 512KB）");
  }
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  await atomicWriteFile(fp, text);
  const st = statFile(fp);
  return {
    ok: true,
    path: fp,
    size: st ? st.size : Buffer.byteLength(text, "utf8"),
    mtime: st ? st.mtime.toISOString() : null,
  };
}
