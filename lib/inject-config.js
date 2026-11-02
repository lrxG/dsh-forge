/**
 * 破甲注入的开关、范围与模板标记。
 *
 * 内容仍然写 $DSH_HOME/prompt-inject.md（兼容旧路径），这里只存：
 *   · enabled：总开关
 *   · scopes：哪些模式生效
 *   · template：当前内容来自哪个模板（minimal / redteam / custom）
 */
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFile, defaultOverrideText, normalizeOverride, readPromptInjectFileSync } from "./core.js";
import { listTemplates, readTemplate } from "./context-inventory.js";

export const DEFAULT_SCOPES = ["redteam", "crack"];
/* 默认就是全量。最简只是可选模板，不再作为出厂默认。 */
export const DEFAULT_TEMPLATE = "redteam";

const FALLBACK_MODES = [
  { id: "redteam", name: "红队" },
  { id: "crack", name: "破解" },
  { id: "standard", name: "标准" },
  { id: "minimal", name: "极简" },
  { id: "ptc", name: "PTC" },
];

export function injectConfigPath(home) {
  return path.join(path.normalize(String(home || "")), "dsh-forge", "inject.json");
}

export function normalizeModeId(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  /* 先认带命名空间的 worker：`preset/redteam-worker` 也以 -worker 结尾，
     如果先走通用 -worker 分支会被削成 `preset/redteam`，范围/契约/日志全部对不上。 */
  if (text.endsWith("/redteam-worker")) return "redteam";
  if (text.endsWith("/crack-worker")) return "crack";
  if (text.endsWith("-worker")) return text.slice(0, -7);
  if (text.endsWith("/redteam")) return "redteam";
  if (text.endsWith("/crack")) return "crack";
  if (text === "preset-redteam" || text === "red-team") return "redteam";
  if (text === "preset-crack") return "crack";
  if (/红队/.test(text)) return "redteam";
  if (/破解/.test(text)) return "crack";
  return text;
}

function cleanScopes(input) {
  const out = [];
  for (const raw of Array.isArray(input) ? input : []) {
    const id = normalizeModeId(raw);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

export function readInjectConfig(home) {
  let raw = {};
  let corrupt = false;
  try {
    raw = JSON.parse(fs.readFileSync(injectConfigPath(home), "utf8")) || {};
  } catch (error) {
    raw = {};
    /* 文件不存在用默认值；文件存在但解析失败就标 custom，不能把全量误标成最简。 */
    corrupt = !(error && error.code === "ENOENT");
  }
  return {
    enabled: raw.enabled !== false,
    scopes: Array.isArray(raw.scopes) ? cleanScopes(raw.scopes) : [...DEFAULT_SCOPES],
    template: corrupt
      ? "custom"
      : (typeof raw.template === "string" && raw.template.trim() ? raw.template.trim() : DEFAULT_TEMPLATE),
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : null,
  };
}

export async function writeInjectConfig(home, patch = {}) {
  const prev = readInjectConfig(home);
  const next = {
    enabled: patch.enabled === undefined ? prev.enabled : patch.enabled !== false,
    scopes: patch.scopes === undefined ? prev.scopes : cleanScopes(patch.scopes),
    template: patch.template === undefined ? prev.template : String(patch.template || DEFAULT_TEMPLATE),
    updated_at: new Date().toISOString(),
  };
  const fp = injectConfigPath(home);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  await atomicWriteFile(fp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/** 当前内容更接近哪个内置模板；都不是就是自定义。 */
export function detectInjectTemplate(home) {
  listTemplates(home);
  const current = normalizeOverride(readPromptInjectFileSync(home));
  if (!current) return DEFAULT_TEMPLATE;
  const minimal = normalizeOverride(readTemplate(home, "minimal"));
  const normal = normalizeOverride(readTemplate(home, "redteam"));
  /* 密封槽就是“全量版”本体；模板文件被用户改过时也要认得出它。 */
  const sealed = normalizeOverride(defaultOverrideText());
  if (minimal && current === minimal) return "minimal";
  if (sealed && current === sealed) return "redteam";
  if (normal && current === normal) return "redteam";
  return "custom";
}

/**
 * 补/修 inject.json；任何情况下都不改 prompt-inject.md。
 *
 * 旧版在配置缺失时会把“全量稿”自动降成最简，导致迁移/清理一次就把用户的破甲稿换掉。
 * 现在默认就是全量；配置丢了只重建配置，正文由当前模板决定。
 */
export async function syncInjectConfig(home) {
  const fp = injectConfigPath(home);
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch { raw = null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return writeInjectConfig(home, {
      enabled: true,
      scopes: [...DEFAULT_SCOPES],
      template: detectInjectTemplate(home),
    });
  }
  return readInjectConfig(home);
}

export async function setInjectEnabled(home, enabled) {
  return writeInjectConfig(home, { enabled: enabled !== false });
}

export async function setInjectScopes(home, scopes) {
  return writeInjectConfig(home, { scopes });
}

export async function setInjectTemplate(home, template) {
  return writeInjectConfig(home, { template: String(template || DEFAULT_TEMPLATE) });
}

export function injectSummary(home) {
  const cfg = readInjectConfig(home);
  let content = readPromptInjectFileSync(home);
  /* 新装/预览还没落盘时，先按当前模板取，再退回加密槽里的最简稿。 */
  if (!normalizeOverride(content)) content = readTemplate(home, cfg.template) || defaultOverrideText();
  const templates = listTemplates(home);
  return {
    ...cfg,
    chars: normalizeOverride(content).length,
    tokens: Math.ceil(normalizeOverride(content).length / 2),
    content,
    templates,
    defaultScopes: [...DEFAULT_SCOPES],
    defaultTemplate: DEFAULT_TEMPLATE,
  };
}

export function fallbackModes() {
  return FALLBACK_MODES.map((m) => ({ ...m }));
}
