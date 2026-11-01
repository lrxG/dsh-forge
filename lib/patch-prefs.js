/**
 * 补丁启停偏好。
 *
 * 只存「停用了哪些 id」，默认全开；这样新增补丁自动是启用状态，升级不用迁移。
 * 文件：$DSH_HOME/dsh-forge/patch-prefs.json
 *
 * 注意：这里只影响「下次应用写哪些补丁」。已经写进宿主的补丁要撤掉，
 * 必须重新 apply（apply 会先还原再按启用集合写），单切开关不会动宿主文件。
 */
import fs from "node:fs";
import path from "node:path";

const FILE_NAME = "patch-prefs.json";
const MAX_ID = 9999;

function prefsPath(dshHome) {
  return path.join(dshHome || "", "dsh-forge", FILE_NAME);
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

/** 读取偏好；文件缺失或损坏都当作「全开」，不让配置问题挡住应用。 */
export function readPatchPrefs(dshHome) {
  const empty = { disabled: [], path: prefsPath(dshHome), exists: false };
  if (!dshHome) return empty;
  try {
    const raw = fs.readFileSync(prefsPath(dshHome), "utf8");
    const parsed = JSON.parse(raw);
    return {
      disabled: normalizeIds(parsed?.disabled),
      path: prefsPath(dshHome),
      exists: true,
      updatedAt: typeof parsed?.updatedAt === "string" ? parsed.updatedAt : "",
    };
  } catch {
    return empty;
  }
}

/** 覆盖写入停用列表；返回落盘后的规范值。 */
export function writePatchPrefs(dshHome, next) {
  if (!dshHome) throw new Error("找不到 DSH_HOME，无法保存补丁开关");
  const disabled = normalizeIds(next?.disabled);
  const payload = { disabled, updatedAt: new Date().toISOString() };
  const fp = prefsPath(dshHome);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = `${fp}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, fp);
  return { ...payload, path: fp, exists: true };
}

export function enabledPatchIds(patches, prefs) {
  const off = new Set(prefs?.disabled || []);
  return (patches || []).filter((p) => !off.has(p.id)).map((p) => p.id);
}

export function selectEnabledPatches(patches, prefs) {
  const off = new Set(prefs?.disabled || []);
  return (patches || []).filter((p) => !off.has(p.id));
}
