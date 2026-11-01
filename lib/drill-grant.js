/**
 * 红队面板授权落在数据根 `$DSH_HOME/redteam/drill-grant.json`，跟靶标数据放一起：
 * 把数据目录整体指到别处（REDTEAM_HOME / 另一个 DSH_HOME）时，授权跟着走，不再重弹。
 * 插件更新只换 node_modules，这份文件还在。成功卸载会删掉；Web 和桌面各记各的。
 *
 * 旧位置 `$DSH_HOME/dsh-forge/drill-grant.json` 仍然认，读到就迁到新位置，
 * 老用户升级不会看到第二次授权窗。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 当前授权文件位置（数据根内）。 */
export function drillGrantPath(dshHome) {
  return join(dshHome, "redteam", "drill-grant.json");
}

/** 旧版位置，仅用于读取迁移。 */
export function legacyDrillGrantPath(dshHome) {
  return join(dshHome, "dsh-forge", "drill-grant.json");
}

function readGrantFile(file) {
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return { granted: !!(raw && raw.granted === true), path: file, at: raw && raw.at ? raw.at : null };
  } catch {
    return { granted: false, path: file };
  }
}

export function readDrillGrant(dshHome) {
  const file = drillGrantPath(dshHome);
  const current = readGrantFile(file);
  if (current !== null) return current;

  // 旧位置：已授权就原地搬到新位置，只搬一次。
  const legacy = legacyDrillGrantPath(dshHome);
  const old = readGrantFile(legacy);
  if (old === null) return { granted: false, path: file };
  if (old.granted) {
    try { writeDrillGrant(dshHome, old.at); } catch { /* 搬不动就继续认旧的 */ }
    try { unlinkSync(legacy); } catch { /* 删不掉留着无害 */ }
  }
  return { granted: old.granted, path: file, at: old.at };
}

export function writeDrillGrant(dshHome, at) {
  const file = drillGrantPath(dshHome);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const stamp = typeof at === "string" && at ? at : new Date().toISOString();
  writeFileSync(tmp, `${JSON.stringify({ granted: true, at: stamp }, null, 2)}\n`, "utf8");
  try {
    if (existsSync(file)) unlinkSync(file);
    renameSync(tmp, file);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* 临时文件留不住就让原错误抛出 */ }
    throw error;
  }
  return readDrillGrant(dshHome);
}

/** 删除授权文件（新旧位置都删）。失败向上抛，不删整个目录。 */
export function clearDrillGrant(dshHome) {
  let cleared = false;
  for (const file of [drillGrantPath(dshHome), legacyDrillGrantPath(dshHome)]) {
    if (!existsSync(file)) continue;
    unlinkSync(file);
    cleared = true;
  }
  return cleared;
}
