/**
 * 破解案件账本：每个样本一个目录，主线和子会话共用。
 *
 * 目的不是“再做一个数据库”，而是把长任务的外部记忆固定下来：
 *   $DSH_HOME/crack/cases/<slug>-<hash>/
 *     case.json      目标、验收、状态、样本路径
 *     dossier.md     追加式结论/排除方向/证据路径
 *     artifacts/     补丁、日志、截图等产物
 *
 * 任务书只传 case id + 本次增量，子会话自己读 dossier；不用主线每次重抄背景。
 * 同一路径重复 open 会复用同一个案件，方便换窗口续做。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CASE_STATUSES = ["open", "blocked", "done"];

function homeOf(home) {
  return path.normalize(String(home || process.env.DSH_HOME || path.join(os.homedir(), ".dsh")));
}

export function casesRoot(home) {
  return path.join(homeOf(home), "crack", "cases");
}

function sampleKey(sample) {
  const resolved = path.resolve(String(sample || "").trim()).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function slugOf(sample) {
  const base = path.basename(String(sample || "").trim()).replace(/\.[^.]+$/, "");
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return slug || "sample";
}

export function caseIdFor(sample) {
  const key = sampleKey(sample);
  if (!key) throw new Error("sample 不能为空");
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 8);
  return `${slugOf(sample)}-${hash}`;
}

export function safeCaseId(id) {
  const text = String(id || "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,80}$/.test(text)) return "";
  if (text.includes("..")) return "";
  return text;
}

export function caseDirOf(home, id) {
  const safe = safeCaseId(id);
  if (!safe) throw new Error("非法案件 id：" + String(id || ""));
  return path.join(casesRoot(home), safe);
}

function writeJsonAtomic(file, value) {
  const tmp = file + "." + process.pid + "." + Date.now() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    fs.renameSync(tmp, file);
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function now() {
  return new Date().toISOString();
}

function dossierHeader(record) {
  return [
    "# 案件：" + record.sample,
    "",
    "- 创建：" + record.created_at,
    "- 目标：" + (record.goal || "（未填）"),
    "- 验收：" + (record.acceptance || "（未填）"),
    "",
  ].join("\n");
}

/** 交付字段统一入口：open 复用与 update 都走这里，避免两套字段名。 */
function applyDeliveryFields(target, input = {}) {
  if (input.deliverables !== undefined) {
    const list = Array.isArray(input.deliverables)
      ? input.deliverables
      : String(input.deliverables || "").split(/\r?\n/)
    target.deliverables = list.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 50)
  }
  for (const key of ["apply_cmd", "rollback_cmd"]) {
    if (input[key] !== undefined) target[key] = String(input[key] || "").trim()
  }
  if (input.verified !== undefined) {
    target.verified = typeof input.verified === "boolean" ? input.verified : String(input.verified || "").trim()
  }
}

function appendNoteFile(file, base, kind, text) {
  const body = String(text || "").trim().slice(0, 20000);
  if (!body) throw new Error("note 内容不能为空");
  let prefix = "";
  try {
    prefix = fs.existsSync(file) ? "" : base;
  } catch {
    prefix = base;
  }
  const kindText = String(kind || "note").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 24) || "note";
  const chunk = prefix + "\n## " + now() + " " + kindText + "\n" + body + "\n";
  fs.appendFileSync(file, chunk, "utf8");
  return chunk.length;
}

export function openCase(home, input = {}) {
  const sample = String(input.sample || "").trim();
  if (!sample) throw new Error("sample 不能为空");
  const id = caseIdFor(sample);
  const dir = caseDirOf(home, id);
  const file = path.join(dir, "case.json");
  const dossier = path.join(dir, "dossier.md");
  fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true });

  const existing = readJson(file);
  if (existing) {
    const next = {
      ...existing,
      goal: input.goal !== undefined && String(input.goal).trim() !== "" ? String(input.goal).trim() : existing.goal,
      acceptance: input.acceptance !== undefined && String(input.acceptance).trim() !== ""
        ? String(input.acceptance).trim()
        : existing.acceptance,
      updated_at: now(),
    };
    applyDeliveryFields(next, input);
    writeJsonAtomic(file, next);
    if (!fs.existsSync(dossier)) fs.writeFileSync(dossier, dossierHeader(next), "utf8");
    /* 不在每次 open 时写 reopen：模型可能每轮都 open，重复条目会把 dossier 撑大。 */
    return { created: false, case: next, dossier_path: dossier, artifacts_dir: path.join(dir, "artifacts") };
  }

  const record = {
    id,
    sample,
    sample_key: sampleKey(sample),
    goal: String(input.goal || "").trim(),
    acceptance: String(input.acceptance || "").trim(),
    status: "open",
    created_at: now(),
    updated_at: now(),
    deliverables: [],
    apply_cmd: "",
    rollback_cmd: "",
    verified: "",
  };
  applyDeliveryFields(record, input);
  fs.mkdirSync(dir, { recursive: true });
  /* case.json 损坏但 dossier 还在时，保留旧 dossier，不整份覆盖。 */
  if (fs.existsSync(dossier)) {
    fs.appendFileSync(dossier, "\n## " + now() + " recover\n案件元数据缺失，已重新建立；旧 dossier 保留。\n", "utf8");
  } else {
    fs.writeFileSync(dossier, dossierHeader(record), "utf8");
  }
  writeJsonAtomic(file, record);
  return { created: true, case: record, dossier_path: dossier, artifacts_dir: path.join(dir, "artifacts") };
}

export function readCase(home, id) {
  const dir = caseDirOf(home, id);
  const record = readJson(path.join(dir, "case.json"));
  if (!record) throw new Error("案件不存在：" + String(id || ""));
  return { ...record, dir };
}

function tailText(text, limit) {
  const cap = Math.max(0, Math.min(Number(limit) || 0, 20000));
  if (!cap || text.length <= cap) return text;
  return "…（前文已省略，完整内容见 dossier_path）\n" + text.slice(-cap);
}

export function getCase(home, id, options = {}) {
  const record = readCase(home, id);
  const dossier = path.join(record.dir, "dossier.md");
  let text = "";
  try { text = fs.readFileSync(dossier, "utf8"); } catch { text = ""; }
  return {
    case: record,
    dossier_path: dossier,
    dossier_chars: text.length,
    dossier_tail: tailText(text, options.tail === undefined ? 4000 : options.tail),
    artifacts_dir: path.join(record.dir, "artifacts"),
  };
}

export function noteCase(home, id, text, kind = "note") {
  const record = readCase(home, id);
  const dossier = path.join(record.dir, "dossier.md");
  const added = appendNoteFile(dossier, dossierHeader(record), kind, text);
  const next = { ...record, updated_at: now() };
  delete next.dir;
  writeJsonAtomic(path.join(record.dir, "case.json"), next);
  return { id: record.id, dossier_path: dossier, added_chars: added };
}

export function updateCase(home, id, patch = {}) {
  const record = readCase(home, id);
  const next = { ...record };
  delete next.dir;
  for (const key of ["goal", "acceptance"]) {
    if (patch[key] !== undefined) next[key] = String(patch[key] || "").trim();
  }
  applyDeliveryFields(next, patch);
  if (patch.status !== undefined) {
    const status = String(patch.status || "").trim();
    if (!CASE_STATUSES.includes(status)) throw new Error("status 只能是 " + CASE_STATUSES.join(" / "));
    next.status = status;
  }
  next.updated_at = now();
  writeJsonAtomic(path.join(record.dir, "case.json"), next);
  return next;
}

function looksLikePath(text) {
  const s = String(text || "").trim();
  return /[\\/]/.test(s) || /^[A-Za-z]:/.test(s);
}

/**
 * 破解交付门：结构检查，不靠模型当天记不记得。
 * 目标是“可复现的产物”，不是“写了一段总结”。
 */
export function caseCloseout(home, id) {
  const record = readCase(home, id);
  const gaps = [];
  const add = (code, message) => gaps.push({ code, message });
  if (!String(record.goal || "").trim()) add("goal", "案件没有写目标：这次要拿到什么产物");
  if (!String(record.acceptance || "").trim()) add("acceptance", "案件没有写验收：怎么算成功、怎么算失败");
  const deliverables = Array.isArray(record.deliverables) ? record.deliverables : [];
  if (!deliverables.length) add("deliverables", "没有交付物：补丁 / keygen / 报告 / 样本路径至少写一项");
  for (const item of deliverables) {
    if (looksLikePath(item) && !fs.existsSync(item)) add("deliverable_missing", "交付物不存在：" + item);
  }
  const verified = record.verified;
  if (verified !== true && !String(verified || "").trim()) {
    add("verified", "没有验证记录：写清修补前失败、修补后成功的命令/截图/输出");
  }
  if (String(record.apply_cmd || "").trim() && !String(record.rollback_cmd || "").trim()) {
    add("rollback", "有应用命令但没有回滚命令：补回滚步骤，或说明为什么不可逆");
  }
  const dir = record.dir;
  let artifacts = [];
  try {
    artifacts = fs.readdirSync(path.join(dir, "artifacts")).filter((n) => !n.startsWith("."));
  } catch {
    artifacts = [];
  }
  if (!artifacts.length && !deliverables.length) add("artifacts", "artifacts/ 是空的：产物或证据没有落盘");
  return {
    ok: gaps.length === 0,
    gaps,
    case: {
      id: record.id,
      sample: record.sample,
      status: record.status,
      goal: record.goal,
      acceptance: record.acceptance,
      deliverables,
      apply_cmd: record.apply_cmd || "",
      rollback_cmd: record.rollback_cmd || "",
      verified: record.verified ?? "",
    },
    artifacts,
    artifacts_dir: path.join(dir, "artifacts"),
  };
}

export function listCases(home, limit = 50) {
  const root = casesRoot(home);
  let names = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
  const rows = [];
  for (const name of names) {
    const id = safeCaseId(name);
    if (!id) continue;
    const record = readJson(path.join(root, id, "case.json"));
    if (!record) continue;
    rows.push({
      id: record.id,
      sample: record.sample,
      goal: record.goal,
      status: record.status,
      updated_at: record.updated_at,
    });
  }
  rows.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
  return rows.slice(0, Math.max(1, Math.min(Number(limit) || 50, 200)));
}
