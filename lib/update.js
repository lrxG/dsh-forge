import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteSync, findDshHome } from "./core.js";
import { extractZipArchive, listZipFile } from "./zip-extract.js";

/**
 * 发布源。
 *
 * 成品走 GitHub Releases：正式版 = 普通 release，测试版 = prerelease。
 * 更新包是 Release 里的 zip 资产 + SHA256SUMS.txt，下载不需要任何令牌。
 * Gitee 只在开发期当过渡通道，`DSH_FORGE_UPDATE_SOURCE=gitee` 即可切回去。
 */
const GITHUB_REPO = String(process.env.DSH_FORGE_GH_REPO || "lrxG/dsh-forge").trim();
const GITHUB_WEB = "https://github.com";
const GITHUB_API = "https://api.github.com";
const UPDATE_SOURCE = String(process.env.DSH_FORGE_UPDATE_SOURCE || "github").toLowerCase() === "gitee"
  ? "gitee"
  : "github";
/** Gitee 过渡仓库：只在 UPDATE_SOURCE=gitee 时参与更新。 */
const GITEE_REPO = "proxy-g/dsh-forge";
const GITEE_HOST = "gitee.com";
const GITEE_API = "https://gitee.com/api/v5";
/** 更新首选路径：公开仓库的 git 协议匿名可用，不需要令牌。 */
const GITEE_CLONE_URL = `https://${GITEE_HOST}/${GITEE_REPO}.git`;
/** 回退路径：Gitee zipball。此接口即使仓库公开也要求 access_token。 */
const GITEE_ZIPBALL = `${GITEE_API}/repos/${GITEE_REPO}/zipball`;
const STABLE_REF = "master";
const BETA_REF = "beta";
const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const CHANNELS = {
  stable: { id: "stable", ref: STABLE_REF, label: "正式版" },
  beta: { id: "beta", ref: BETA_REF, label: "测试版" },
};
/**
 * 更新包里允许覆盖的运行时文件。
 *
 * `docs/`（交接文档）、`scripts/`（开发脚本）刻意不在列表里：
 * GitHub 上的发行包是纯插件，覆盖时也不该把这些东西带到用户机器上。
 * 提示词工具用的静态资源在 `lib/data/`，随 `lib` 一起更新。
 */
const RUNTIME_NAMES = [
  "lib",
  "presets",
  "skills",
  "bin",
  "client.next.js",
  "cordis.patch.yml",
  "package.json",
  "README.md",
  "LICENSE",
  "NOTICE",
];
/** 覆盖前先整目录删掉的项：避免新版本删掉的文件继续留在旧安装里。 */
const CLEAN_NAMES = new Set(["lib", "bin", "presets", "skills"]);

function githubRepoOk() {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(GITHUB_REPO);
}

/** 当前实际可用的发布源；空串表示没配，面板显示「不提供在线更新」。 */
export function updateSource() {
  if (UPDATE_SOURCE === "gitee") return GITEE_REPO ? "gitee" : "";
  return githubRepoOk() ? "github" : "";
}

export function updateRepo() {
  return updateSource() === "github" ? GITHUB_REPO : (GITEE_REPO || "");
}

const HIDDEN = {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
  windowsHide: true,
  timeout: 20000,
};

// 只允许发布源自己的跳转落地，阻挡中间人把下载指向任意主机。
const UPDATE_REDIRECT_ALLOWED_HOSTS = new Set([
  "gitee.com",
  /* `gitee.com/<repo>/raw/<ref>/<file>` 现在会 302 到 CDN：实测落地域名是
     `raw.giteeusercontent.com`（旧的 `objects.githubusercontent.com` 是 GitHub 时代遗留）。
     少了这一条，raw 版本号读取会在跟随重定向时被自己的白名单拒掉，
     remoteVersion 恒为空。 */
  "raw.giteeusercontent.com",
  "github.com",
  "api.github.com",
  /* Release 资产从 github.com 302 到这两个 CDN；2024 年后新资产走 release-assets。 */
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "codeload.github.com",
]);
const MAX_UPDATE_BYTES = 50 * 1024 * 1024;

export function pluginRoot() {
  return PLUGIN_ROOT;
}

export function localVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "package.json"), "utf8"));
    return String(pkg.version || "");
  } catch {
    return "";
  }
}

function channelStatePath() {
  return path.join(findDshHome(), "dsh-forge", "channel.json");
}

function historyPath() {
  return path.join(findDshHome(), "dsh-forge", "version-history.json");
}

function stampPath() {
  return path.join(findDshHome(), "dsh-forge", "installed-rev");
}

function autoUpdateGuardPath() {
  return path.join(findDshHome(), "dsh-forge", "auto-update-guard.json");
}

function markAutoUpdateGuard(ref, sha = "") {
  atomicWriteSync(autoUpdateGuardPath(), `${JSON.stringify({
    ref: String(ref || ""),
    sha: String(sha || ""),
    at: new Date().toISOString(),
  }, null, 2)}\n`);
}

export function normalizeChannel(value) {
  return String(value || "").toLowerCase() === "beta" ? "beta" : "stable";
}

function isBetaName(name) {
  return /(?:^|[-._])(beta|rc|pre|preview|test)(?:\d|$|[-._])/i.test(String(name || ""));
}

function withdrawnVersion(item) {
  const text = [item?.version, item?.ref, item?.id].filter(Boolean).join(" ");
  return /(?:^|[\sv])1\.1\.11-beta/i.test(String(text).replace(/^v/i, " "));
}

function splitVersion(raw) {
  const text = String(raw || "").trim().replace(/^v/i, "");
  const cut = text.split("-");
  const core = String(cut[0] || "").split(".").map((n) => parseInt(n, 10) || 0);
  return { core: [core[0] || 0, core[1] || 0, core[2] || 0], pre: cut.slice(1).join("-") };
}

export function versionIsNewer(remote, local) {
  if (!remote) return false;
  if (!local) return true;
  if (String(remote) === String(local)) return false;
  const a = splitVersion(remote);
  const b = splitVersion(local);
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
  }
  if (a.pre && !b.pre) return false;
  if (!a.pre && b.pre) return true;
  return a.pre > b.pre;
}

export function latestStableVersion(versions) {
  let best = "";
  for (const item of versions || []) {
    if (!item || item.channel === "beta") continue;
    const ver = String(item.version || "").replace(/^v/i, "");
    if (!/^\d+\.\d+\.\d+/.test(ver) || isBetaName(ver)) continue;
    if (!best || versionIsNewer(ver, best)) best = ver;
  }
  return best;
}

/** 测试通道只认 beta 分支头。旧的 beta/rc/pre 标签不列出。 */
export function hideListedVersion(item, _stableVersion = "") {
  if (!item || withdrawnVersion(item)) return true;
  // GitHub 的正式/测试由 release 的 prerelease 标记决定，标签名不作数；两条通道都要列出来。
  if (item.kind === "release") return false;
  if (item.ref === BETA_REF && item.channel === "beta") return false;
  return item.channel === "beta" || isBetaName(item.version) || isBetaName(item.ref) || isBetaName(item.id);
}

export function readChannelState() {
  const raw = readJson(channelStatePath()) || {};
  const stored = String(raw.channel || "").toLowerCase();
  const pin = typeof raw.pin === "string" ? raw.pin.trim() : "";
  const channel = stored === "beta" ? "beta" : "stable";
  const state = {
    channel,
    pin: isBetaName(pin) || pin === BETA_REF ? "" : pin,
  };
  if ((stored === "beta") !== (channel === "beta") || state.pin !== pin) writeChannelState(state);
  return state;
}

function writeChannelState(next) {
  const state = {
    channel: normalizeChannel(next?.channel),
    pin: typeof next?.pin === "string" ? next.pin.trim() : "",
  };
  atomicWriteSync(channelStatePath(), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

export function channelPublic(state = readChannelState()) {
  const meta = CHANNELS[state.channel] || CHANNELS.stable;
  return {
    channel: meta.id,
    channelLabel: meta.label,
    pin: state.pin || "",
  };
}

function currentChannelRef(state = readChannelState()) {
  return (CHANNELS[state.channel] || CHANNELS.stable).ref;
}

function readHistory() {
  const raw = readJson(historyPath());
  const rows = Array.isArray(raw) ? raw : [];
  return rows.filter((item) => item && !withdrawnVersion(item));
}

function pushHistory(entry) {
  const next = [entry, ...readHistory().filter((item) => item && item.ref !== entry.ref)].slice(0, 20);
  atomicWriteSync(historyPath(), `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * Gitee 归档下载。实测结论：
 *   · `api/v5/repos/<repo>/zipball` 即使仓库公开也要求 access_token（无 token 返回 401）；
 *   · `gitee.com/<repo>/repository/archive/<ref>.zip` 匿名访问返回 **200 + 登录页 HTML**，
 *     状态码不报错、内容却不是 zip —— 这条路不能用于更新。
 * 所以更新下载必须带 token，缺失时直接抛明确错误，而不是把 HTML 当 zip 解析。
 *
 * 令牌来源顺序（原来只读环境变量，等于把已经存在凭据白白浪费掉）：
 *   ① 环境变量 GITEE_TOKEN / GITEE_ACCESS_TOKEN —— 显式优先；
 *   ② `$DSH_HOME/.credentials.yaml` 的 `refs.GITEE_TOKEN` —— DSH 自己的凭据库，
 *      用户按 DSH 方式存过就不该再要求他 export 一遍；
 *   ③ `git credential fill` —— 系统凭据管理器里存的 gitee 凭据。
 */
function giteeToken() {
  const env = String(process.env.GITEE_TOKEN || process.env.GITEE_ACCESS_TOKEN || "").trim();
  if (env) return env;
  const fromStore = credentialsFileToken();
  if (fromStore) return fromStore;
  return "";
}

/** 从 DSH 凭据文件里读 `refs.GITEE_TOKEN`。只做最小的行解析，不引入 YAML 依赖。 */
function credentialsFileToken() {
  try {
    const fp = path.join(findDshHome(), ".credentials.yaml");
    if (!fs.existsSync(fp)) return "";
    const text = fs.readFileSync(fp, "utf8");
    /* 结构是：
         refs:
           GITEE_TOKEN: xxxxx
       records: 里的 token 是别的用途（账号/设备），不能误取 ——
       所以只在 refs: 段内匹配，遇到下一个顶格键就停。 */
    let inRefs = false;
    for (const raw of text.split(/\r?\n/)) {
      if (/^\S/.test(raw)) {
        inRefs = /^refs:\s*$/.test(raw);
        continue;
      }
      if (!inRefs) continue;
      const m = raw.match(/^\s+GITEE_TOKEN:\s*(\S+)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, "").trim();
    }
  } catch {
    // 凭据文件不可读就走下一个来源。
  }
  return "";
}

function withToken(url) {
  const token = giteeToken();
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
}

function archiveZipUrl(ref) {
  const value = String(ref || STABLE_REF);
  const query = /^[0-9a-f]{40}$/i.test(value)
    ? `?sha=${encodeURIComponent(value)}`
    : `?ref=${encodeURIComponent(value)}`;
  const base = GITEE_ZIPBALL.replace(/\?.*$/, "");
  return withToken(`${base}${query}`);
}

function archiveTarballUrl(ref) {
  return archiveZipUrl(ref);
}

/** 更新下载需要 Gitee 令牌；缺失时给出可操作的提示。 */
export function requireUpdateToken() {
  const token = giteeToken();
  if (token) return token;
  const err = new Error(
    "update download needs a Gitee token: set GITEE_TOKEN (or GITEE_ACCESS_TOKEN) in the environment before starting dsh",
  );
  err.code = "GITEE_UPDATE_TOKEN_MISSING";
  throw err;
}

function readStamp() {
  try {
    return fs.readFileSync(stampPath(), "utf8").trim();
  } catch {
    return "";
  }
}

function writeStamp(value) {
  if (!value) return;
  atomicWriteSync(stampPath(), `${value}\n`);
}

function sameRev(a, b) {
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

export function realPath(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

function readJson(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}

function isGitCheckout(dir) {
  return fs.existsSync(path.join(dir, ".git"));
}

function canGit(dir) {
  if (!isGitCheckout(dir)) return false;
  try {
    execFileSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], HIDDEN);
    return true;
  } catch {
    return false;
  }
}

function gitOk() {
  return canGit(PLUGIN_ROOT);
}

function gitHead(dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], HIDDEN).trim();
  } catch {
    return "";
  }
}

export function isLinkSpec(spec) {
  const s = String(spec || "");
  return /^(link|file):/i.test(s) || s === "." || /^\.\.?(?:[/\\]|$)/.test(s);
}

export function resolveLinkDir(profileDir, spec) {
  const raw = String(spec).replace(/^(link|file):/i, "");
  return path.resolve(profileDir, raw);
}

export function findForgeProfiles() {
  const root = path.join(findDshHome(), "profiles");
  if (!fs.existsSync(root)) return [];
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const dir = path.join(root, name);
    const pkg = readJson(path.join(dir, "package.json"));
    const spec = pkg?.dependencies?.["dsh-forge"] || pkg?.devDependencies?.["dsh-forge"];
    if (!spec) continue;
    out.push({ name, dir, spec: String(spec) });
  }
  return out;
}

export function profilePluginDir(profileDir) {
  const nm = path.join(profileDir, "node_modules", "dsh-forge");
  return fs.existsSync(nm) ? realPath(nm) : "";
}

/** 把 profile 里的安装地址钉到这次装的具体版本（GitHub 用 Release 资产，Gitee 用 zipball）。 */
function installSpecUrl(ref) {
  if (updateSource() === "github") {
    const tag = /^v/i.test(String(ref || "")) ? String(ref) : `v${ref}`;
    return `${GITHUB_WEB}/${GITHUB_REPO}/releases/download/${tag}/dsh-forge-${tag.replace(/^v/i, "")}.zip`;
  }
  return archiveTarballUrl(ref);
}

function pinInstalledSpec(profileDir, ref) {
  if (!profileDir) return;
  const url = installSpecUrl(ref);
  const pkgPath = path.join(profileDir, "package.json");
  const pkg = readJson(pkgPath);
  if (pkg) {
    let changed = false;
    for (const key of ["dependencies", "devDependencies", "optionalDependencies"]) {
      if (pkg[key] && Object.prototype.hasOwnProperty.call(pkg[key], "dsh-forge") && pkg[key]["dsh-forge"] !== url) {
        pkg[key]["dsh-forge"] = url;
        changed = true;
      }
    }
    if (changed) atomicWriteSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  // 这里曾经用正则把 pnpm-lock.yaml 里 importer 的 specifier/version 两行换成新地址，
  // 却没有写 packages:/snapshots: 条目。锁文件于是自相矛盾，pnpm 在任何命令之前校验
  // 锁文件就失败：
  //   ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY / Broken lockfile: no entry for 'dsh-forge@…'
  // dsh 又给子进程带 CI=1（frozen-lockfile 默认开），于是 profile 里连紧随其后、
  // 本来能修好它的 pnpm add --force 都起不来 —— 整个 profile 从此不可安装。
  // 这个手改并不需要：pin 完 package.json 后，pnpm 自己会在 add --force 时按新地址
  // 重新解析，把 importer / packages / snapshots 一次写一致。锁文件只能由解析出这些
  // 字段的解析器来写。
}

function planUpdates() {
  const profiles = findForgeProfiles();
  const jobs = [];
  const seen = new Set();
  const remember = (dir) => {
    const key = realPath(dir).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };

  for (const p of profiles) {
    if (isLinkSpec(p.spec)) {
      const dir = resolveLinkDir(p.dir, p.spec);
      if (!remember(dir)) continue;
      jobs.push(canGit(dir) ? { kind: "git", dir, profile: p.name } : { kind: "zip", dir, profile: p.name });
      continue;
    }
    const dir = profilePluginDir(p.dir) || PLUGIN_ROOT;
    jobs.push({ kind: "dsh", profile: p.name, spec: p.spec, dir, profileDir: p.dir });
    remember(dir);
  }

  if (!jobs.length) {
    jobs.push(canGit(PLUGIN_ROOT) ? { kind: "git", dir: PLUGIN_ROOT } : { kind: "zip", dir: PLUGIN_ROOT });
    return jobs;
  }
  if (remember(PLUGIN_ROOT)) {
    jobs.push(canGit(PLUGIN_ROOT) ? { kind: "git", dir: PLUGIN_ROOT } : { kind: "zip", dir: PLUGIN_ROOT });
  }
  return jobs;
}

function detectVia() {
  if (gitOk()) {
    const extra = findForgeProfiles().some((p) => !isLinkSpec(p.spec));
    return extra ? "mixed" : "git";
  }
  if (findForgeProfiles().some((p) => !isLinkSpec(p.spec))) return "dsh";
  if (findForgeProfiles().length) return "dsh";
  return "zip";
}

function isAbortError(e) {
  const msg = String((e && e.message) || e || "");
  return (e && (e.name === "AbortError" || e.name === "TimeoutError")) || /aborted|abort|超时/i.test(msg);
}

/**
 * 把安装来源里的归档地址规范化成 Gitee zipball。
 * 老配置可能还留着 GitHub 的 archive 链接，这里统一改写成本仓库的 zipball，
 * 其余（link:/file:/git 地址）原样返回空串表示「不需要改写」。
 */
function rewriteDownloadUrl(url) {
  const value = String(url || "");

  // 已是本仓库的 zipball：只补 token。
  if (value.startsWith(GITEE_ZIPBALL)) return withToken(value);

  // GitHub archive → Gitee zipball（迁移旧配置）。
  let match = value.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/archive\/refs\/(tags|heads)\/(.+)\.(zip|tar\.gz)$/i);
  if (match) {
    return archiveZipUrl(decodeURIComponent(match[3]));
  }
  match = value.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/archive\/([0-9a-f]{7,40})\.(zip|tar\.gz)$/i);
  if (match) {
    return archiveZipUrl(match[2]);
  }

  // Gitee 的 archive 路径对私有仓库返回 403，换成 zipball。
  match = value.match(/^https?:\/\/gitee\.com\/([^/]+\/[^/]+)\/repository\/archive\/(.+)\.(zip|tar\.gz)$/i);
  if (match) {
    return archiveZipUrl(decodeURIComponent(match[2]));
  }

  return "";
}

function requestBuffer(url, ms, headers, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      reject(new Error(`update: unsupported protocol ${parsed.protocol}`));
      return;
    }
    const lib = parsed.protocol === "http:" ? http : https;
    const req = lib.request(parsed, {
      method: "GET",
      headers: { "user-agent": "dsh-forge-update", accept: "*/*", ...headers },
    }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error("http redirect loop"));
          return;
        }
        const loc = Array.isArray(res.headers.location) ? res.headers.location[0] : res.headers.location;
        const candidate = loc ? new URL(loc, url).href : rewriteDownloadUrl(url);
        if (!candidate || candidate === url) {
          reject(new Error(`http ${status}`));
          return;
        }
        let nextUrl;
        try {
          nextUrl = new URL(candidate);
        } catch (e) {
          reject(e);
          return;
        }
        if (nextUrl.protocol !== "https:") {
          reject(new Error(`update: redirect rejected (non-https: ${nextUrl.protocol})`));
          return;
        }
        if (!UPDATE_REDIRECT_ALLOWED_HOSTS.has(nextUrl.hostname)) {
          reject(new Error(`update: redirect rejected (host not allowed: ${nextUrl.hostname})`));
          return;
        }
        requestBuffer(nextUrl.href, ms, headers, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        const rewritten = rewriteDownloadUrl(url);
        if (rewritten && rewritten !== url && redirectsLeft > 0) {
          requestBuffer(rewritten, ms, headers, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        reject(new Error(`http ${status}`));
        return;
      }
      const chunks = [];
      let received = 0;
      let aborted = false;
      res.on("data", (chunk) => {
        if (aborted) return;
        received += chunk.length;
        if (received > MAX_UPDATE_BYTES) {
          aborted = true;
          req.destroy(new Error(`update: response exceeds ${MAX_UPDATE_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (!aborted) resolve({ status, body: Buffer.concat(chunks), headers: res.headers });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(ms, () => {
      req.destroy(new Error("GitHub 超时"));
    });
    req.end();
  });
}

async function fetchRes(url, ms = 20000, headers = {}) {
  const started = rewriteDownloadUrl(url) || url;
  try {
    const result = await requestBuffer(started, ms, headers);
    return {
      ok: true,
      status: result.status,
      headers: result.headers || {},
      async text() {
        return result.body.toString("utf8");
      },
      async arrayBuffer() {
        return result.body.buffer.slice(
          result.body.byteOffset,
          result.body.byteOffset + result.body.byteLength,
        );
      },
    };
  } catch (e) {
    if (isAbortError(e) || /GitHub 超时/.test(String(e && e.message))) throw new Error("GitHub 超时");
    throw e;
  }
}

async function fetchText(url, ms = 20000, headers = {}) {
  return (await fetchRes(url, ms, headers)).text();
}

async function fetchJson(url, ms = 20000, headers = {}) {
  return JSON.parse(await fetchText(url, ms, headers));
}

function versionFromPackageText(text) {
  const pkg = JSON.parse(text);
  return pkg && pkg.version ? String(pkg.version) : "";
}

// 远端 package.json 版本号查询:5 分钟 memo,频繁刷新面板时不重复打 Gitee API。
const _remotePkgVerCache = new Map();
const REMOTE_PKG_VER_TTL = 300_000;
async function remotePackageVersion(sha = "", fallbackRef = STABLE_REF) {
  const ref = sha || fallbackRef;
  const key = sha || `ref:${ref}`;
  const now = Date.now();
  const hit = _remotePkgVerCache.get(key);
  if (hit && now - hit.at < REMOTE_PKG_VER_TTL) return hit.value;
  try {
    /* 首选 `raw/HEAD/package.json`：匿名可读、200ms、跟随一次 302 就到 CDN。
       原来只打 `api/v5/repos/.../contents/package.json`，而 Gitee 的 api/v5
       现在**匿名一律 403**（实测 8/8 全 403），于是版本号永远是空串，
       remoteVersion 恒为 ""，`versionIsNewer("", local)` 恒 false ——
       远端发了新版本，面板也永远不会提示「有新版本」。 */
    const rawRef = sha ? `raw/${encodeURIComponent(sha)}` : "raw/HEAD";
    const raw = await fetchJson(`https://${GITEE_HOST}/${GITEE_REPO}/${rawRef}/package.json`, 15000);
    let ver = "";
    if (raw && raw.version) ver = String(raw.version);
    if (ver) {
      _remotePkgVerCache.set(key, { value: ver, at: now });
      return ver;
    }
  } catch {
    // 落到下面的 API 兜底。
  }
  try {
    const url = withToken(
      `${GITEE_API}/repos/${GITEE_REPO}/contents/package.json?ref=${encodeURIComponent(ref)}`,
    );
    const data = await fetchJson(url, 20000);
    let ver = "";
    if (data && data.content) {
      // Gitee 与 GitHub 一样返回 base64，换行需先去掉。
      const text = Buffer.from(String(data.content).replace(/\s/g, ""), "base64").toString("utf8");
      ver = versionFromPackageText(text);
    } else if (data && data.version) {
      ver = String(data.version);
    }
    if (ver) {
      _remotePkgVerCache.set(key, { value: ver, at: now });
      return ver;
    }
  } catch {
    // 落到下面的空缓存。
  }
  // 失败也记短缓存 30 秒,避免反复打空请求。
  _remotePkgVerCache.set(key, { value: "", at: now - (REMOTE_PKG_VER_TTL - 30_000) });
  return "";
}

/**
 * 远端分支头提交号。**先走匿名 git，再走 API。**
 *
 * 顺序为什么重要：`api/v5/repos/<repo>/commits` 现在匿名返回 403（实测 8/8），
 * 所以 remoteHeadSha 原来恒为 ""，`stableSha` 空 → 列表里没有 master 项 →
 * `lane.version` 空 → `versionIsNewer("", "1.4.0")` 恒 false。
 * 结果是「检查更新」永远显示「已是最新」，远端真发了新版也发现不了。
 *
 * `git ls-remote` 匿名可用（实测 267–380ms，无需令牌、无交互），
 * 因此把它提到 API 之前。API 只在 git 不可用时兜底。
 */
async function remoteHeadSha(ref = STABLE_REF) {
  const target = String(ref || STABLE_REF).trim();
  if (!target) return "";
  const refName = `refs/heads/${target}`;
  try {
    const out = execFileSync(
      "git",
      ["ls-remote", GITEE_CLONE_URL, refName],
      { ...HIDDEN, timeout: 20000 },
    );
    const line = String(out || "").trim().split(/\r?\n/).find(Boolean) || "";
    const sha = line.split(/\s+/)[0] || "";
    if (/^[0-9a-f]{7,40}$/i.test(sha)) return sha;
    /* 空输出 = 该分支不存在（比如没有 beta 分支），这是正常结果，不要再去打 API。 */
    return "";
  } catch {
    // git 不可用或网络拒绝 → 走 API 兜底。
  }
  try {
    const rows = await fetchJson(
      withToken(`${GITEE_API}/repos/${GITEE_REPO}/commits?sha=${encodeURIComponent(target)}&per_page=1`),
    );
    if (Array.isArray(rows) && rows[0] && rows[0].sha) return String(rows[0].sha);
  } catch {
    // 回退到 tags 探测。
  }
  return "";
}

function versionLabel(version, channel, sha = "") {
  const ver = String(version || "").replace(/^v/, "") || (sha ? String(sha).slice(0, 7) : "");
  const mark = channel === "beta" ? "测试" : "正式";
  return ver ? `${ver}（${mark}）` : mark;
}

function rememberVersion(item, seen) {
  if (!item || !item.ref) return null;
  const key = `${item.sha || ""}|${item.ref}`.toLowerCase();
  if (seen.has(key)) return null;
  seen.add(key);
  return item;
}

const UPDATE_REF_RE = /^(?:v?\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?|master|main|beta|[0-9a-f]{7,40})$/i;

export function safeUpdateRef(ref) {
  const target = String(ref || "").trim();
  if (!target) return "";
  if (!UPDATE_REF_RE.test(target)) return "";
  return target;
}

export function markCurrent(versions, state, localVer, localSha) {
  const pin = String(state?.pin || "");
  const rows = versions || [];
  const ver = String(localVer || "").replace(/^v/i, "");
  const channel = state?.channel || "stable";
  const sameVersion = (item) => ver && String(item?.version || "").replace(/^v/i, "") === ver && item.channel === channel;
  const sameSha = (item) => Boolean(localSha && item?.sha && sameRev(localSha, item.sha));
  let chosen = null;
  if (pin) {
    chosen = rows.find((item) => item.ref === pin) || null;
  } else {
    const pool = rows.filter(sameVersion);
    // 安装记录里的旧提交号不能把较低版本标成当前。只认和正在跑的 package.json 相同的版本。
    chosen = pool.find((item) => sameSha(item) && (item.latest || item.ref === "master" || item.kind === "head"))
      || pool.find((item) => item.latest || item.ref === "master" || item.kind === "head")
      || pool.find((item) => sameSha(item))
      || pool[0]
      || null;
  }
  return rows.map((item) => ({
    ...item,
    shaShort: item.shaShort || (item.sha ? String(item.sha).slice(0, 7) : ""),
    current: Boolean(chosen && item === chosen),
  }));
}

async function listGiteeTags() {
  try {
    const rows = await fetchJson(withToken(`${GITEE_API}/repos/${GITEE_REPO}/tags?per_page=50`));
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => {
      const name = String(row?.name || "").trim();
      if (!name || !/^v?\d+\.\d+/.test(name)) return null;
      // Gitee 的 tag 节点把提交号放在 commit.sha，与 GitHub 同名。
      const sha = row?.commit?.sha ? String(row.commit.sha) : "";
      const channel = isBetaName(name) ? "beta" : "stable";
      return {
        id: name,
        ref: name,
        sha,
        version: name.replace(/^v/, ""),
        channel,
        label: versionLabel(name, channel, sha),
        kind: "tag",
      };
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------ GitHub Releases */

const GH_HEADERS = { accept: "application/vnd.github+json", "user-agent": "dsh-forge-update" };
const GH_RELEASES_TTL = 60_000;
let _ghReleases = { at: 0, etag: "", rows: [] };

/**
 * 拉 Release 列表。60 次/小时的匿名额度对面板来说够用，加 ETag + 60 秒 memo，
 * 频繁切页也不会重复计数。
 */
async function githubReleases(force = false) {
  if (!githubRepoOk()) return [];
  const now = Date.now();
  if (!force && _ghReleases.rows.length && now - _ghReleases.at < GH_RELEASES_TTL) return _ghReleases.rows;
  const headers = { ...GH_HEADERS };
  if (_ghReleases.etag) headers["if-none-match"] = _ghReleases.etag;
  try {
    const res = await fetchRes(`${GITHUB_API}/repos/${GITHUB_REPO}/releases?per_page=50`, 20000, headers);
    const rows = JSON.parse(await res.text());
    if (!Array.isArray(rows)) throw new Error("发布源返回的不是版本列表");
    _ghReleases = { at: now, etag: String((res.headers && res.headers.etag) || ""), rows };
    return rows;
  } catch (error) {
    if (/http 304/.test(String(error && error.message))) {
      _ghReleases.at = now;
      return _ghReleases.rows;
    }
    // 匿名额度是 60 次/小时，同一出口 IP 很容易被邻居打满。API 不通时退回仓库约定，
    // 至少「检测更新 / 安装最新版」还能用；旧版本列表要等额度恢复。
    const rows = await releaseFallback().catch(() => []);
    if (rows.length) {
      _ghReleases = { at: now, etag: "", rows };
      return rows;
    }
    throw error;
  }
}

/** Release 资产命名是发布脚本的固定约定，API 不可用时按约定拼地址。 */
function assetUrlsFor(tag) {
  const version = String(tag).replace(/^v/i, "");
  const base = `${GITHUB_WEB}/${GITHUB_REPO}/releases/download/${tag}`;
  return {
    zip: {
      name: `dsh-forge-${version}.zip`,
      browser_download_url: `${base}/dsh-forge-${version}.zip`,
    },
    sums: {
      name: "SHA256SUMS.txt",
      browser_download_url: `${base}/SHA256SUMS.txt`,
    },
  };
}

function decodeXml(text) {
  return String(text)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Releases API 的退路：`releases.atom`。
 *
 * 它由 github.com 直接提供，不走 API 额度（匿名 60 次/小时，同一出口 IP 很容易被邻居打满），
 * 也不像 raw.githubusercontent.com 那样在部分网络被重置。缺的是 prerelease 标记与资产大小，
 * 所以测试版按版本号里的 `-beta` / `-rc` 识别，资产地址走发布脚本的命名约定。
 */
async function releaseFallback() {
  const xml = await fetchText(`${GITHUB_WEB}/${GITHUB_REPO}/releases.atom`, 20000, {
    accept: "application/atom+xml",
  });
  const rows = [];
  const entry = /<entry>([\s\S]*?)<\/entry>/g;
  let hit;
  while ((hit = entry.exec(xml))) {
    const block = hit[1];
    const title = decodeXml((block.match(/<title>([^<]*)<\/title>/) || [])[1] || "").trim();
    if (!title) continue;
    const version = title.replace(/^v/i, "");
    if (!/^\d+\.\d+\.\d+/.test(version)) continue;
    const href = (block.match(/href="([^"]*\/releases\/tag\/[^"]+)"/) || [])[1] || "";
    const updated = (block.match(/<updated>([^<]*)<\/updated>/) || [])[1] || "";
    const content = (block.match(/<content[^>]*>([\s\S]*?)<\/content>/) || [])[1] || "";
    rows.push({
      tag_name: title,
      prerelease: isBetaName(version),
      body: decodeXml(content).replace(/<[^>]+>/g, "").trim().slice(0, 6000),
      published_at: updated,
      html_url: href,
      assets: [],
    });
  }
  return rows;
}

function releaseItem(rel) {
  const tag = String(rel?.tag_name || "").trim();
  const version = tag.replace(/^v/i, "");
  if (!tag || !/^\d+\.\d+\.\d+/.test(version)) return null;
  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  const zip = assets.find((row) => /\.zip$/i.test(String(row?.name || "")));
  const channel = rel.prerelease ? "beta" : "stable";
  return {
    id: tag,
    ref: tag,
    sha: "",
    version,
    channel,
    label: versionLabel(version, channel, ""),
    kind: "release",
    latest: false,
    prerelease: Boolean(rel.prerelease),
    notes: String(rel.body || "").slice(0, 6000),
    publishedAt: String(rel.published_at || ""),
    size: zip ? Number(zip.size || 0) : 0,
    asset: zip ? String(zip.name) : "",
    url: String(rel.html_url || ""),
  };
}

function latestOf(items, channel) {
  let best = null;
  for (const item of items || []) {
    if (item.channel !== channel) continue;
    if (!best || versionIsNewer(item.version, best.version)) best = item;
  }
  return best;
}

/** 通道名 / 版本号 / 标签都能解析到具体的 Release 标签。 */
async function resolveReleaseRef(ref = "", channel = "stable") {
  const raw = String(ref || "").trim();
  const rows = await githubReleases();
  const items = rows.map(releaseItem).filter(Boolean);
  if (!raw || raw === STABLE_REF || raw === "main" || raw === "stable") {
    return latestOf(items, "stable")?.ref || "";
  }
  if (raw === BETA_REF || raw === "beta") return latestOf(items, "beta")?.ref || "";
  const want = raw.replace(/^v/i, "");
  const hit = rows.find((row) => String(row.tag_name || "").replace(/^v/i, "") === want);
  return hit ? String(hit.tag_name) : "";
}

async function releaseForRef(ref = "") {
  const tag = await resolveReleaseRef(ref);
  if (!tag) return null;
  const rows = await githubReleases();
  return rows.find((row) => String(row.tag_name) === tag) || null;
}

function sha256Of(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function downloadBuffer(url, label = "更新包", ms = 90000) {
  const res = await fetchRes(url, ms, { accept: "*/*" });
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error(`${label}为空`);
  if (buf.length > MAX_UPDATE_BYTES) throw new Error(`${label}超过 ${MAX_UPDATE_BYTES} 字节`);
  return buf;
}

/** 具体标签优先；API 不可用时，明确的版本号可以直接按约定落成 `v<ver>`。 */
async function releaseTagOf(ref, channel) {
  const tag = await resolveReleaseRef(ref, channel).catch(() => "");
  if (tag) return tag;
  const raw = String(ref || "").replace(/^v/i, "");
  return /^\d+\.\d+\.\d+/.test(raw) ? `v${raw}` : "";
}

/** 下载 + 校验，但不覆盖任何文件。面板上「下载并校验」和更新前的预检都走这里。 */
async function fetchReleasePackage(ref, channel = "stable") {
  const tag = await releaseTagOf(ref, channel);
  if (!tag) throw new Error("没有找到对应的发布版本");
  const rel = await releaseForRef(tag).catch(() => null);
  const assets = rel && Array.isArray(rel.assets) ? rel.assets : [];
  const conv = assetUrlsFor(tag);
  const zip = assets.find((row) => /\.zip$/i.test(String(row?.name || ""))) || conv.zip;
  const sums = assets.find((row) => /^sha256sums(\.txt)?$/i.test(String(row?.name || ""))) || conv.sums;
  const buf = await downloadBuffer(zip.browser_download_url, "更新包");
  let expected = "";
  if (sums && sums.browser_download_url) {
    const text = await fetchText(sums.browser_download_url, 30000, { accept: "*/*" }).catch(() => "");
    const line = String(text).split(/\r?\n/).find((row) => row.trim().endsWith(zip.name));
    expected = line ? line.trim().split(/\s+/)[0].toLowerCase() : "";
  }
  const actual = sha256Of(buf);
  if (expected && expected !== actual) {
    throw new Error(`更新包校验失败：期望 ${expected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`);
  }
  return {
    tag,
    version: tag.replace(/^v/i, ""),
    channel: rel ? (rel.prerelease ? "beta" : "stable") : normalizeChannel(channel),
    asset: String(zip.name),
    size: buf.length,
    sha256: actual,
    verified: Boolean(expected),
    notes: String((rel && rel.body) || ""),
    buffer: buf,
  };
}

function ensureRunningVersion(versions, state, localVer, localSha) {
  const ver = String(localVer || "").replace(/^v/i, "");
  if (!ver || isBetaName(ver) || state?.channel === "beta") return versions;
  if ((versions || []).some((item) => item.channel === "stable" && String(item.version || "").replace(/^v/i, "") === ver)) {
    return versions;
  }
  const ref = (versions || []).some((item) => item.ref === "master") ? `local-${ver}` : "master";
  return [{
    id: ref,
    ref,
    sha: localSha || "",
    version: ver,
    channel: "stable",
    label: versionLabel(ver, "stable", localSha),
    kind: "local",
    latest: !(versions || []).some((item) => item.channel === "stable" && item.latest),
  }, ...(versions || [])];
}

async function listRemoteVersions() {
  const state = readChannelState();
  const seen = new Set();
  const out = [];
  const add = (item) => {
    const next = rememberVersion(item, seen);
    if (next) out.push(next);
  };

  const localVer = localVersion();
  const localSha = (gitOk() ? gitHead(PLUGIN_ROOT) : "") || readStamp();

  if (updateSource() === "github") {
    const releases = await githubReleases().catch(() => []);
    const items = releases.map(releaseItem).filter(Boolean).filter((item) => !withdrawnVersion(item));
    const stable = latestOf(items, "stable");
    const beta = latestOf(items, "beta");
    if (stable) stable.latest = true;
    if (beta) beta.latest = true;
    items.sort((a, b) => (versionIsNewer(a.version, b.version) ? -1 : 1));
    for (const item of items) add(item);
    for (const item of readHistory()) {
      if (!item || !item.ref || withdrawnVersion(item)) continue;
      add({
        ...item,
        label: item.label || versionLabel(item.version, item.channel, item.sha),
        kind: item.kind || "history",
      });
    }
    const withLocal = ensureRunningVersion(out, state, localVer, localSha);
    return {
      versions: withLocal,
      hasBeta: Boolean(beta),
      stableSha: stable ? stable.ref : "",
      betaSha: beta ? beta.ref : "",
    };
  }

  const [stableSha, betaSha, tags] = await Promise.all([
    remoteHeadSha(STABLE_REF),
    remoteHeadSha(BETA_REF),
    listGiteeTags(),
  ]);

  if (stableSha) {
    const version = await remotePackageVersion(stableSha, STABLE_REF).catch(() => "");
    add({
      id: STABLE_REF,
      ref: STABLE_REF,
      sha: stableSha,
      version: version || "",
      channel: "stable",
      label: `${versionLabel(version, "stable", stableSha)} · 最新`,
      kind: "head",
      latest: true,
    });
  }
  if (betaSha) {
    const version = await remotePackageVersion(betaSha, BETA_REF).catch(() => "");
    add({
      id: BETA_REF,
      ref: BETA_REF,
      sha: betaSha,
      version: version || "",
      channel: "beta",
      label: `${versionLabel(version, "beta", betaSha)} · 最新`,
      kind: "head",
      latest: true,
    });
  }
  for (const tag of tags) {
    if (!withdrawnVersion(tag)) add(tag);
  }
  for (const item of readHistory()) {
    if (!item || !item.ref || withdrawnVersion(item)) continue;
    add({
      ...item,
      label: item.label || versionLabel(item.version, item.channel, item.sha),
      kind: item.kind || "history",
    });
  }

  const withLocal = ensureRunningVersion(out, state, localVer, localSha);
  const ceiling = latestStableVersion([
    ...withLocal,
    localVer && !isBetaName(localVer) ? { channel: "stable", version: localVer } : null,
  ].filter(Boolean));
  const visible = withLocal.filter((item) => !hideListedVersion(item, ceiling));
  return {
    versions: markCurrent(visible, state, localVer, localSha),
    hasBeta: Boolean(betaSha),
    stableSha,
    betaSha: betaSha || "",
  };
}

function describeLane(id, listed, state, localVer, localRev) {
  const versions = listed.versions.filter((item) => item.channel === id);
  const latest = versions.find((item) => item.latest) || versions[0] || null;
  const version = latest?.version || "";
  const ref = latest?.ref || CHANNELS[id].ref;
  const onLane = state.channel === id;
  // GitHub 通道里 sha 是空的，只有 Gitee 分支头才有提交号可比。
  const headSha = id === "beta" ? listed.betaSha : listed.stableSha;
  const matchesHead = Boolean(localRev && headSha && sameRev(localRev, headSha));
  const current = matchesHead || versions.some((item) => item.current && (item.latest || (state.pin && item.ref === state.pin)));
  // 只跟版本号。提交号对不上就再 add --force，会在 dsh 杀掉宿主后形成无限重启。
  const hasUpdate = Boolean(onLane && version && versionIsNewer(version, localVer));
  return {
    id,
    ref,
    version,
    sha: latest?.shaShort || "",
    current,
    hasUpdate,
    hasRemote: versions.length > 0 || Boolean(headSha),
  };
}

function lanesOf(listed, state, localVer, localRev) {
  return {
    stable: describeLane("stable", listed, state, localVer, localRev),
    beta: describeLane("beta", listed, state, localVer, localRev),
  };
}

export async function checkUpdate() {
  // 没配发布源时直接给结论，不去拼空仓库地址（那样只会拿到一堆 404/403 噪音）。
  if (!updateSource()) {
    return rememberUpdate({
      ok: true,
      hasUpdate: false,
      hasBeta: false,
      localOnly: true,
      source: "",
      error: "",
      note: "未配置发布源，不提供在线更新",
      localVersion: localVersion(),
      remoteVersion: "",
      localSha: "",
      remoteSha: "",
      updateTarget: "",
      via: "local",
      versions: [],
      lanes: {},
      ...channelPublic(),
    });
  }
  let state = readChannelState();
  const localVer = localVersion();
  const listed = await listRemoteVersions();
  const gitSha = gitOk() ? gitHead(PLUGIN_ROOT) : "";
  const stamp = readStamp();
  const localRev = gitSha || stamp;
  listed.versions = markCurrent(listed.versions, state, localVer, localRev);
  const channelRef = currentChannelRef(state);
  const lanes = lanesOf(listed, state, localVer, localRev);
  const lane = lanes[state.channel] || lanes.stable;
  if (!lane.hasRemote && state.channel === "beta") {
    return rememberUpdate({
      ok: true,
      hasUpdate: false,
      hasBeta: false,
      source: updateSource(),
      repo: updateRepo(),
      error: "还没有测试版",
      localVersion: localVer,
      remoteVersion: "",
      localSha: localRev ? localRev.slice(0, 7) : "",
      remoteSha: "",
      updateTarget: channelRef,
      via: detectVia(),
      versions: listed.versions,
      lanes,
      ...channelPublic(state),
    });
  }
  if (!lanes.stable.hasRemote) throw new Error("无法读取发布源，检查网络或仓库地址");
  const result = {
    ok: true,
    hasUpdate: Boolean(lane.hasUpdate),
    hasBeta: listed.hasBeta,
    source: updateSource(),
    repo: updateRepo(),
    updateTarget: lane.ref || channelRef,
    pinned: Boolean(state.pin),
    localVersion: localVer,
    remoteVersion: lane.version || lane.sha,
    localSha: localRev ? localRev.slice(0, 7) : "",
    remoteSha: lane.sha,
    via: detectVia(),
    versions: listed.versions,
    lanes,
    ...channelPublic(state),
  };
  rememberUpdate(result);
  return result;
}

function gitTrackedDirty(dir) {
  try {
    const out = execFileSync(
      "git",
      ["-C", dir, "status", "--porcelain", "--untracked-files=no", "--", ...RUNTIME_NAMES],
      HIDDEN,
    ).trim();
    return Boolean(out);
  } catch {
    return true;
  }
}

let lastUpdate = null;

function rememberUpdate(result) {
  lastUpdate = result && typeof result === "object" ? result : lastUpdate;
  return lastUpdate;
}

export function lastUpdateResult() {
  return lastUpdate;
}

function runGit(dir, args, timeout = 20000) {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout,
    });
  } catch (e) {
    const detail = [e.stderr, e.stdout, e.message].filter(Boolean).join("\n").trim();
    throw new Error(detail || `git ${args.join(" ")}`);
  }
}

function gitResetTo(dir, ref, { force = false } = {}) {
  if (!force && gitTrackedDirty(dir)) {
    throw new Error("本地插件文件有未提交改动，未覆盖");
  }
  const target = safeUpdateRef(ref || STABLE_REF);
  if (!target) throw new Error("未知版本");
  try {
    runGit(dir, ["fetch", "origin", "--tags"], 60000);
  } catch {
    runGit(dir, ["fetch", "origin", "--tags", target], 60000);
  }
  if (target === STABLE_REF || target === BETA_REF) {
    try {
      runGit(dir, ["checkout", "-B", target, `origin/${target}`]);
      return;
    } catch {
      runGit(dir, ["reset", "--hard", `origin/${target}`]);
      return;
    }
  }
  try {
    runGit(dir, ["fetch", "origin", "--tags", target], 60000);
  } catch {
    // 上面已经 fetch 过全部分支。
  }
  runGit(dir, ["reset", "--hard", target]);
}

/**
 * 解压前的路径校验。
 *
 * Windows 上 extractZipArchive 会优先用 tar / Expand-Archive，这两条路都不经过
 * extractZipBuffer 里的 safeZipName；压缩包被替换或被劫持时，../ 与绝对路径条目
 * 能写出目标目录。这里先列出条目、按同样规则拦掉，再交给解压器。
 */
function assertSafeArchiveEntries(zip) {
  let names = [];
  try {
    names = listZipFile(zip);
  } catch (error) {
    throw new Error(`更新包无法解析，已中止：${error && error.message ? error.message : error}`);
  }
  if (!Array.isArray(names) || names.length === 0) throw new Error("更新包为空，已中止");
  for (const raw of names) {
    const rel = String(raw || "").replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+$/, "");
    if (!rel) continue;
    if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) throw new Error(`更新包路径不合法：${raw}`);
    if (rel.split("/").some((part) => part === ".." || part === "")) {
      throw new Error(`更新包路径不合法：${raw}`);
    }
  }
  return names.length;
}

function extractZip(zip, dest) {
  // win32：tar(bsdtar) → powershell。darwin/linux：tar → unzip → python3 → bsdtar。
  // 外部工具都不可用时用 Node 解 zip，Linux 不会再去调用 powershell。
  assertSafeArchiveEntries(zip);
  extractZipArchive(zip, dest);
}

/**
 * 用 `git clone` 取一份源码到临时目录，返回含 package.json 的那一层。
 *
 * 公开仓库的 git 协议匿名可用，不依赖任何令牌 —— 这是更新的首选路径。
 * 只有本机没有 git、或网络拒绝 git 时，才回退到需要令牌的 zipball。
 */
async function checkoutFromGit(tmp, ref = STABLE_REF) {
  const target = safeUpdateRef(ref);
  if (!target) throw new Error("未知版本");
  const work = path.join(tmp, "clone");
  const env = {
    ...process.env,
    // 公开仓库无需交互；禁止卡在凭据提示上。
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (args, timeout = 120000) =>
    execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout,
      env,
    });

  git(["clone", "--depth", "1", "--branch", target, GITEE_CLONE_URL, work]);
  const unpacked = work;
  if (!fs.existsSync(path.join(unpacked, "package.json"))) {
    throw new Error("克隆下来的目录里没有 package.json");
  }
  return unpacked;
}

async function overlayFromZip(dests, ref = STABLE_REF) {
  const unique = [...new Set(dests.filter(Boolean).map((d) => realPath(d)))];
  if (!unique.length) return;
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-forge-upd-"));
  try {
    let unpacked = null;

    // 首选：匿名 git clone，不需要令牌。
    try {
      unpacked = await checkoutFromGit(tmp, ref);
    } catch (gitError) {
      // 回退：Gitee zipball。这条路需要令牌，且对无权限请求会返回登录页 HTML。
      requireUpdateToken();
      const zip = path.join(tmp, "plugin.zip");
      const res = await fetchRes(archiveZipUrl(ref), 45000);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!(buf[0] === 0x50 && buf[1] === 0x4b)) {
        const head = buf.subarray(0, 200).toString("utf8");
        throw new Error(
          `git 拉取失败且 zip 下载没有返回合法归档（${buf.length} bytes, 开头 ${JSON.stringify(head.slice(0, 60))}）: ` +
            String((gitError && gitError.message) || gitError).split("\n")[0],
        );
      }
      await fsp.writeFile(zip, buf);
      extractZip(zip, tmp);
      const names = await fsp.readdir(tmp);
      unpacked = names
        .map((n) => path.join(tmp, n))
        .find((p) => fs.existsSync(path.join(p, "package.json")));
      if (!unpacked) throw new Error("zip 里没有 package.json");
    }

    await overlayTree(unpacked, unique);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** 把解包目录里的运行时文件覆盖到每个安装目录。 */
async function overlayTree(unpacked, dests) {
  for (const dest of dests) {
    for (const name of RUNTIME_NAMES) {
      const from = path.join(unpacked, name);
      const to = path.join(dest, name);
      if (!fs.existsSync(from)) continue;
      if (CLEAN_NAMES.has(name)) {
        try {
          await fsp.rm(to, { recursive: true, force: true });
        } catch (e) {
          // 删不掉说明文件被进程占用。继续 cp 会写出一半新文件一半旧文件的半升级,
          // 让 host 和插件的版本不一致。宁可抛错让用户彻底退出宿主再重试。
          throw new Error(
            `覆盖 ${to} 失败(${e.message || e})。可能被进程占用,请完全退出宿主后重试。`,
          );
        }
      }
      await fsp.cp(from, to, { recursive: true, force: true });
    }
  }
}

/**
 * GitHub Release 覆盖：下载 zip 资产 → 校验 SHA256 → 解包 → 覆盖。
 * 全程不需要令牌，也不碰 git；开发目录被覆盖只会变脏，不会 reset。
 */
async function overlayFromRelease(dests, ref) {
  const unique = [...new Set(dests.filter(Boolean).map((d) => realPath(d)))];
  if (!unique.length) return;
  const pkg = await fetchReleasePackage(ref);
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-forge-rel-"));
  try {
    const zip = path.join(tmp, "plugin.zip");
    await fsp.writeFile(zip, pkg.buffer);
    const out = path.join(tmp, "unpacked");
    extractZip(zip, out);
    let root = out;
    if (!fs.existsSync(path.join(root, "package.json"))) {
      const names = await fsp.readdir(out);
      root = names
        .map((n) => path.join(out, n))
        .find((p) => fs.existsSync(path.join(p, "package.json"))) || "";
      if (!root) throw new Error("更新包里没有 package.json");
    }
    await overlayTree(root, unique);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

function parseReapplyOutput(text) {
  const line = String(text || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.startsWith("{"))
    .pop();
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** 用刚写好的插件文件在新进程里还原并重打，避免还在跑旧补丁列表。 */
function runReapplyChild() {
  const cli = path.join(PLUGIN_ROOT, "lib", "reapply-cli.js");
  if (!fs.existsSync(cli)) return { ok: false, error: "缺少重新应用脚本" };
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  delete env.DSH_FORGE_RESTART;
  let run;
  try {
    run = spawnSync(process.execPath, ["--expose-internals", cli], {
      cwd: PLUGIN_ROOT,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 180000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
  const parsed = parseReapplyOutput(`${run.stdout || ""}\n${run.stderr || ""}`);
  if (parsed) return parsed;
  const detail = String(run.stderr || run.stdout || (run.error && run.error.message) || "重新应用失败").trim();
  return { ok: false, error: detail.slice(0, 500) || "重新应用失败" };
}

let applyUpdateInflight = null;

export async function applyUpdate(jobs = planUpdates(), options = {}) {
  // 没有发布源：直接拒绝，避免把空仓库地址拼成下载 URL。
  if (!updateSource()) throw new Error("未配置发布源，不提供在线更新");
  // 同一时刻只能有一次 applyUpdate 在跑。第二次调用在第一次完成前共享同一个 Promise,
  // 避免两条 overlayFromZip 同时往同一目录写出一半文件,或两次 writeStamp 竞争。
  if (applyUpdateInflight) return applyUpdateInflight;
  applyUpdateInflight = (async () => {
    try {
      return await _applyUpdateImpl(jobs, options);
    } finally {
      applyUpdateInflight = null;
    }
  })();
  return applyUpdateInflight;
}

async function _applyUpdateImpl(jobs, options) {
  if (!Array.isArray(jobs)) {
    options = jobs && typeof jobs === "object" ? jobs : {};
    jobs = planUpdates();
  }
  const state = readChannelState();
  const source = updateSource();
  const force = options.force !== false;
  const pin = options.pin === false ? "" : (options.pin || state.pin || "");
  const channel = normalizeChannel(options.channel || state.channel);
  // GitHub 通道里 "master"/"beta" 不是标签，先解析成具体的 Release 标签。
  let ref = safeUpdateRef(options.ref || "");
  if (source === "github" && (!ref || ref === STABLE_REF || ref === BETA_REF)) {
    ref = safeUpdateRef(await resolveReleaseRef(ref || channel, channel));
  }
  ref = ref || safeUpdateRef(currentChannelRef(state) || STABLE_REF);
  if (!ref) throw new Error("未知版本");
  const zipDirs = [];
  const specProfiles = [];
  const vias = new Set();
  for (const job of jobs) {
    // GitHub 发行包是整份插件，不依赖 git 历史；覆盖比 reset 安全（开发目录只会变脏）。
    if (source === "github") {
      if (job.dir) zipDirs.push(job.dir);
      if (job.profileDir) specProfiles.push(job.profileDir);
      continue;
    }
    if (job.kind === "git") {
      try {
        gitResetTo(job.dir, ref, { force });
        vias.add("git");
        continue;
      } catch (e) {
        if (!force && /未提交改动/.test(String(e && e.message))) throw e;
        zipDirs.push(job.dir);
      }
      continue;
    }
    if (job.kind === "dsh") {
      // exe 和 web 都走 dsh plugin add → pnpm。pnpm 拉 GitHub 包会 302 或 fetch failed，
      // 而且 add --force 会先杀掉宿主。这里改为自己下载再覆盖。
      if (job.dir) zipDirs.push(job.dir);
      if (job.profileDir) specProfiles.push(job.profileDir);
      continue;
    }
    zipDirs.push(job.dir);
  }
  if (zipDirs.length) {
    if (source === "github") {
      // 开发机的插件目录是 git 检出：有未提交改动时覆盖会直接吃掉改动，宁可拒绝。
      const self = realPath(PLUGIN_ROOT).toLowerCase();
      const dirty = zipDirs.find((dir) => realPath(dir).toLowerCase() === self
        && canGit(dir) && gitTrackedDirty(dir));
      if (dirty) throw new Error("插件目录有未提交改动，已中止更新（先提交或还原后再试）");
      await overlayFromRelease(zipDirs, ref);
    } else {
      await overlayFromZip(zipDirs, ref);
    }
    vias.add(source === "github" ? "release" : "zip");
  }
  for (const dir of specProfiles) pinInstalledSpec(dir, ref);
  const sha = (gitOk() ? gitHead(PLUGIN_ROOT) : "")
    || (source === "gitee" ? await remoteHeadSha(ref).catch(() => "") : "");
  const via = vias.size > 1 ? "mixed" : [...vias][0] || detectVia();
  const saved = writeChannelState({ channel, pin });
  const localVer = localVersion();
  const listed = await listRemoteVersions().catch(() => ({ versions: [], hasBeta: saved.channel === "beta" }));
  const reapplied = runReapplyChild();
  // reapply 真的成功才能承认这次升级：写 stamp / guard / history。
  // 失败就不写,下次 checkUpdate 还能发现没完成的升级,而不是误标为"已是最新"。
  if (reapplied.ok === true) {
    if (sha) markAutoUpdateGuard(ref, sha);
    if (sha) writeStamp(sha);
    pushHistory({
      ref,
      sha: sha || "",
      version: localVer,
      channel,
      label: versionLabel(localVer, channel, sha),
      at: new Date().toISOString(),
    });
  }
  const restartAfter = reapplied.ok === true && !reapplied.needsFullQuit;
  const needsFullQuit = reapplied.ok === true && Boolean(reapplied.needsFullQuit);
  return rememberUpdate({
    ok: reapplied.ok !== false,
    applied: reapplied.ok === true,
    hasUpdate: reapplied.ok !== true,
    hasBeta: listed.hasBeta,
    pinned: Boolean(saved.pin),
    localVersion: localVer,
    remoteVersion: localVer,
    localSha: sha ? String(sha).slice(0, 7) : "",
    remoteSha: sha ? String(sha).slice(0, 7) : "",
    needRestart: false,
    reloadClient: !restartAfter && !needsFullQuit,
    restartAfter,
    needsFullQuit,
    reapplied: reapplied.ok === true,
    needsRetry: reapplied.ok === false,
    error: reapplied.ok === false ? `文件已更新，但还原并重新应用失败: ${reapplied.error || "未知错误"}` : undefined,
    via,
    versions: listed.versions,
    lanes: lanesOf(listed, saved, localVer, sha),
    ...channelPublic(saved),
  });
}

export async function switchChannel(channel, { apply = true } = {}) {
  const next = normalizeChannel(channel);
  if (!apply) {
    writeChannelState({ channel: next, pin: "" });
    return checkUpdate();
  }
  return applyUpdate(planUpdates(), { ref: CHANNELS[next].ref, channel: next, pin: false, force: true });
}

function listedUpdateRef(target, listed) {
  const safe = safeUpdateRef(target);
  if (!safe) return "";
  const hit = (listed?.versions || []).find((item) => (
    item.ref === safe
    || item.id === safe
    || item.sha === safe
    || (item.sha && safe.length >= 7 && (item.sha.startsWith(safe) || safe.startsWith(item.sha)))
  ));
  return safeUpdateRef(hit?.ref || "");
}

export async function switchVersion(ref) {
  const raw = String(ref || "").trim();
  if (withdrawnVersion({ ref: raw, version: raw })) throw new Error("该版本已下线");
  const target = safeUpdateRef(raw);
  if (!target) throw new Error("请选择要回退的版本");
  const listed = await listRemoteVersions();
  const resolved = listedUpdateRef(target, listed);
  if (!resolved) throw new Error("未知版本");
  const hit = listed.versions.find((item) => item.ref === resolved);
  const channel = hit?.channel || readChannelState().channel;
  const pin = hit?.latest ? "" : resolved;
  return applyUpdate(planUpdates(), { ref: resolved, channel, pin, force: true });
}

/** 解包到临时目录，只做检查：版本号对不对、有没有混进交接文档。 */
async function inspectPackage(buf) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-forge-chk-"));
  try {
    const zip = path.join(tmp, "plugin.zip");
    await fsp.writeFile(zip, buf);
    const out = path.join(tmp, "unpacked");
    extractZip(zip, out);
    let root = out;
    if (!fs.existsSync(path.join(root, "package.json"))) {
      const names = await fsp.readdir(out);
      root = names
        .map((n) => path.join(out, n))
        .find((p) => fs.existsSync(path.join(p, "package.json"))) || "";
      if (!root) throw new Error("更新包里没有 package.json");
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const names = fs.readdirSync(root);
    const banned = names.filter((name) => ["docs", "data", "scripts", ".git"].includes(name));
    return { version: String(pkg.version || ""), files: names, pure: banned.length === 0, banned };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 只下载并校验，不覆盖任何文件。面板上「下载并校验」用它，
 * 也方便在不动安装目录的前提下确认发布包是好的。
 */
export async function prefetchUpdate(ref = "", channel = "") {
  if (updateSource() !== "github") throw new Error("当前发布源不支持预检");
  const lane = normalizeChannel(channel || readChannelState().channel);
  const pkg = await fetchReleasePackage(ref || lane, lane);
  const inside = await inspectPackage(pkg.buffer);
  if (inside.version && inside.version !== pkg.version) {
    throw new Error(`更新包版本不一致：标签 ${pkg.version}，包内 ${inside.version}`);
  }
  return {
    ok: true,
    tag: pkg.tag,
    version: pkg.version,
    channel: pkg.channel,
    asset: pkg.asset,
    size: pkg.size,
    sha256: pkg.sha256,
    verified: pkg.verified,
    purePlugin: inside.pure,
    banned: inside.banned,
    files: inside.files,
  };
}

export async function handleUpdateOp(body = {}) {
  const op = String(body.op || (body.auto ? "auto" : "apply")).toLowerCase();
  if (op === "check" || op === "status" || op === "versions") return checkUpdate();
  if (op === "channel") return switchChannel(body.channel, { apply: body.apply !== false });
  if (op === "switch" || op === "rollback") return switchVersion(body.ref || body.version || body.id);
  if (op === "prefetch" || op === "download") return prefetchUpdate(body.ref, body.channel);
  if (op === "auto") return autoUpdateIfNeeded();
  const state = readChannelState();
  const requested = body.ref || currentChannelRef(state);
  const ref = safeUpdateRef(requested);
  if (!ref) throw new Error("未知版本");
  if (ref !== BETA_REF && isBetaName(ref)) throw new Error("该测试标签已不再提供");
  if (ref !== STABLE_REF && ref !== BETA_REF) {
    const listed = await listRemoteVersions();
    if (!listedUpdateRef(ref, listed)) throw new Error("未知版本");
  }
  const channel = ref === BETA_REF ? "beta" : (ref === STABLE_REF ? "stable" : normalizeChannel(body.channel || state.channel));
  return applyUpdate(planUpdates(), { ref, channel, pin: false, force: true });
}

export async function autoUpdateIfNeeded() {
  // 插件只允许用户在面板手动更新；启动路径永不自动升（版本适配依赖本机宿主）。
  return rememberUpdate({
    auto: true,
    skipped: "manual-only",
    hasUpdate: false,
    error: "",
    ...channelPublic(),
  });
}
