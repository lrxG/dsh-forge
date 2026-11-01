/**
 * 用户自定义的补丁方案。
 *
 * 一条方案只记「停用了哪些补丁」，不复制补丁定义；补丁新增/删除后仍然兼容。
 * 文件：$DSH_HOME/dsh-forge/patch-schemes.json
 *
 * 内置的「推荐 / 仅核心」不落盘，由前端按当前补丁列表计算；
 * 这里只存用户自己命名、保存的方案。
 */
import fs from "node:fs";
import path from "node:path";

const FILE_NAME = "patch-schemes.json";
const MAX_SCHEMES = 30;
const MAX_NAME = 40;
const MAX_ID = 9999;

function schemesPath(home) {
  return path.join(String(home || ""), "dsh-forge", FILE_NAME);
}

function normalizeIds(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0 || id > MAX_ID || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.sort((a, b) => a - b);
}

function normalizeName(raw) {
  return String(raw || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME);
}

function normalizeScheme(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = normalizeName(raw.name);
  if (!name) return null;
  const id = String(raw.id || "").trim().slice(0, 64) || `s${Date.now().toString(36)}`;
  return {
    id,
    name,
    disabled: normalizeIds(raw.disabled),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
  };
}

/** 读取方案；文件缺失/损坏都当作空列表，不让配置问题挡住维护页。 */
export function readPatchSchemes(home) {
  const empty = { schemes: [], path: schemesPath(home), exists: false };
  if (!home) return empty;
  try {
    const raw = JSON.parse(fs.readFileSync(schemesPath(home), "utf8"));
    const schemes = (Array.isArray(raw?.schemes) ? raw.schemes : [])
      .map(normalizeScheme)
      .filter(Boolean)
      .slice(0, MAX_SCHEMES);
    return { schemes, path: schemesPath(home), exists: true };
  } catch {
    return empty;
  }
}

export function writePatchSchemes(home, schemes) {
  if (!home) throw new Error("找不到 DSH_HOME，无法保存补丁方案");
  const list = (Array.isArray(schemes) ? schemes : [])
    .map(normalizeScheme)
    .filter(Boolean)
    .slice(0, MAX_SCHEMES);
  const fp = schemesPath(home);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = `${fp}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ schemes: list }, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, fp);
  return { schemes: list, path: fp, exists: true };
}

/** 新建或按 id 覆盖；同名视为同一条方案，避免列表出现两个同名项。 */
export function savePatchScheme(home, input = {}) {
  const current = readPatchSchemes(home);
  const name = normalizeName(input.name);
  if (!name) throw new Error("方案名不能为空");
  const id = String(input.id || "").trim();
  const disabled = normalizeIds(input.disabled);
  const list = current.schemes.slice();
  const at = new Date().toISOString();
  let hit = id ? list.find((s) => s.id === id) : null;
  if (!hit) hit = list.find((s) => s.name === name);
  let scheme;
  if (hit) {
    scheme = { ...hit, name, disabled, updatedAt: at };
    list[list.indexOf(hit)] = scheme;
  } else {
    if (list.length >= MAX_SCHEMES) throw new Error(`最多保存 ${MAX_SCHEMES} 条方案，请先删掉不用的`);
    scheme = {
      id: id || `s${Date.now().toString(36)}`,
      name,
      disabled,
      updatedAt: at,
    };
    list.push(scheme);
  }
  const saved = writePatchSchemes(home, list);
  return { scheme, ...saved };
}

export function deletePatchScheme(home, id) {
  const key = String(id || "").trim();
  if (!key) throw new Error("缺少方案 id");
  const current = readPatchSchemes(home);
  const list = current.schemes.filter((s) => s.id !== key);
  if (list.length === current.schemes.length) throw new Error("方案不存在或已删除");
  const saved = writePatchSchemes(home, list);
  return { deleted: key, ...saved };
}

export function findPatchScheme(home, id) {
  const key = String(id || "").trim();
  if (!key) return null;
  return readPatchSchemes(home).schemes.find((s) => s.id === key) || null;
}
