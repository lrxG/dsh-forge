/**
 * 运行时钩子开关（尾部锚点 / 子代理审批接管）。
 *
 * 两个钩子都走 cordis 事件，装上就会一直生效；但用户希望"需要时再开"，
 * 所以这里放一份独立开关，默认全关，改完立即生效（不需要重启、不需要重装）。
 *
 * 与 inject.json 分开存：注入是"内容"，这两个是"行为"，混在一起会让
 * 「关掉注入」变成「顺带关掉锚点」这种隐形耦合。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const RUNTIME_HOOK_NAMES = ["anchor", "subagentControl"];

/** 默认全关：用户明确要求"确认有需求时再用"。 */
const DEFAULTS = { anchor: false, subagentControl: false };

export function runtimeHooksDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "dsh-forge");
}

export function runtimeHooksPath() {
  return path.join(runtimeHooksDir(), "runtime-hooks.json");
}

export function readRuntimeHooks() {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(runtimeHooksPath(), "utf8"));
  } catch {
    raw = null;
  }
  const out = { ...DEFAULTS };
  for (const name of RUNTIME_HOOK_NAMES) {
    if (raw && typeof raw[name] === "boolean") out[name] = raw[name];
  }
  return out;
}

export function writeRuntimeHooks(patch = {}) {
  const current = readRuntimeHooks();
  const next = { ...current };
  for (const name of RUNTIME_HOOK_NAMES) {
    if (typeof patch[name] === "boolean") next[name] = patch[name];
  }
  const file = runtimeHooksPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
  cache = { at: Date.now(), data: next, mtimeMs: mtimeOf(file) };
  return next;
}

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** 1 秒或 mtime 变化就重读；事件钩子里会频繁调用，不能每次读盘。 */
let cache = { at: 0, data: null, mtimeMs: -1 };

export function hookEnabled(name) {
  const now = Date.now();
  const mtime = mtimeOf(runtimeHooksPath());
  if (cache.data && now - cache.at < 1000 && mtime === cache.mtimeMs) return cache.data[name] === true;
  const data = readRuntimeHooks();
  cache = { at: now, data, mtimeMs: mtime };
  return data[name] === true;
}
