/**
 * 平台能力收敛点。
 *
 * 设计目标：Windows 行为一位不变。
 *   · win32  → 所有补丁原样返回（`patchesForPlatform` 直接返回传入数组）；
 *   · darwin → 只保留「破甲核心」补丁（MAC_PATCH_IDS）；
 *   · 其他   → 不写宿主。
 *
 * 这里只放纯函数，不碰 fs / child_process，方便在 Windows 上直接单测 macOS 分支。
 * macOS 特有的实现（Keychain、codesign）在 ./platform-mac.js，只在 darwin 上动态 import。
 */

/** macOS 上真正要写进宿主的「破甲核心」：免责声明改写 + 顶层 system 替换 + complete 注入存活。 */
export const MAC_PATCH_IDS = Object.freeze([1, 2, 3, 40, 55]);

export function isWindows(platform = process.platform) {
  return platform === "win32";
}

export function isMac(platform = process.platform) {
  return platform === "darwin";
}

/**
 * macOS 补丁集可用环境变量微调，方便没有 mac 时先在真机上试：
 *   DSH_FORGE_MAC_PATCH_IDS=1,2,3,40,55
 * 空值或非法值回退到默认集，避免一个笔误把破甲关掉。
 */
export function macPatchIds(env = process.env) {
  const raw = String(env?.DSH_FORGE_MAC_PATCH_IDS || "").trim();
  if (!raw) return new Set(MAC_PATCH_IDS);
  const ids = raw
    .split(/[,\s]+/)
    .map((item) => Number(item))
    .filter((id) => Number.isInteger(id) && id > 0);
  return ids.length ? new Set(ids) : new Set(MAC_PATCH_IDS);
}

/** 当前平台实际要写入宿主的补丁。win32 原样返回，保证 Windows 行为完全不变。 */
export function patchesForPlatform(patches, platform = process.platform, env = process.env) {
  const list = Array.isArray(patches) ? patches : [];
  if (platform === "win32") return list;
  if (platform === "darwin") {
    const keep = macPatchIds(env);
    return list.filter((patch) => patch && keep.has(patch.id));
  }
  return [];
}

export function platformLabel(platform = process.platform) {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "macOS";
  return platform || "unknown";
}

/** macOS 写入宿主后是否重签。默认开；DSH_FORGE_MAC_RESIGN=0 关闭，用于排查。 */
export function shouldResignMac(platform = process.platform, env = process.env) {
  if (platform !== "darwin") return false;
  return String(env?.DSH_FORGE_MAC_RESIGN ?? "1") !== "0";
}

/**
 * 从任意位于 .app 内的路径向上找 bundle 根。
 * 例：/Applications/DeepSeek Harness.app/Contents/Resources/app/node_modules → /Applications/DeepSeek Harness.app
 * 纯字符串实现，不碰文件系统；Windows 路径不会命中（返回空串）。
 */
export function macBundleFromPath(input) {
  const text = String(input || "").replace(/\\/g, "/");
  if (!text) return "";
  const marker = ".app/";
  const at = text.toLowerCase().indexOf(marker);
  if (at >= 0) return text.slice(0, at + marker.length - 1);
  return text.toLowerCase().endsWith(".app") ? text : "";
}

/** 密钥后端名：win32 = dpapi，darwin = keychain，其余没有后端。 */
export function secretsBackendName(platform = process.platform) {
  if (platform === "win32") return "dpapi";
  if (platform === "darwin") return "keychain";
  return null;
}
