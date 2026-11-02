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
import { atomicWriteFile, defaultOverrideText, findOverrideFile, normalizeOverride, readPromptInjectFileSync } from "./core.js";
import { listTemplates, readTemplate } from "./context-inventory.js";

export const DEFAULT_SCOPES = ["redteam", "crack"];
export const DEFAULT_TEMPLATE = "minimal";

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
  try {
    raw = JSON.parse(fs.readFileSync(injectConfigPath(home), "utf8")) || {};
  } catch { raw = {}; }
  return {
    enabled: raw.enabled !== false,
    scopes: Array.isArray(raw.scopes) ? cleanScopes(raw.scopes) : [...DEFAULT_SCOPES],
    template: typeof raw.template === "string" && raw.template.trim() ? raw.template.trim() : DEFAULT_TEMPLATE,
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
  if (minimal && current === minimal) return "minimal";
  if (normal && current === normal) return "redteam";
  return "custom";
}

/** 首次启动补 inject.json；已有配置不覆盖。 */
export async function syncInjectConfig(home) {
  const fp = injectConfigPath(home);
  if (!fs.existsSync(fp)) {
    let template = detectInjectTemplate(home);
    /* 旧版完整稿正好等于内置“正常”模板：首次升级直接切到最简；真正手改过的稿子不动。 */
    if (template === "redteam") {
      const minimal = readTemplate(home, "minimal");
      if (minimal) {
        await atomicWriteFile(findOverrideFile(home), minimal, "utf8");
        template = "minimal";
      }
    }
    return writeInjectConfig(home, {
      enabled: true,
      scopes: [...DEFAULT_SCOPES],
      template,
    });
  }
  const cfg = readInjectConfig(home);
  if (!cfg.template) return writeInjectConfig(home, { template: detectInjectTemplate(home) });
  return cfg;
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
