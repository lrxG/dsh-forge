/**
 * 工具 registry：面板和 toolbox 共用一份。
 *
 * 只记录“允许发现的目录”里的工具，不扫整个 PATH：
 *   $DSH_HOME/tools                 —— 插件默认目录，模型下载放这里
 *   $DSH_HOME/redteam/toolkit       —— 红队工具目录
 *   $DSH_HOME/crack/tools           —— 破解默认目录
 *   用户显式添加的 roots
 *   redteam config 里的 toolkitDir / binDirs
 *
 * registry 文件：
 *   $DSH_HOME/redteam/toolbox.json  —— 红队（面板读这份）
 *   $DSH_HOME/crack/toolbox.json    —— 破解（面板不读）
 *
 * 并发：所有“读 → 改 → 写”都走 withLock 的跨进程文件锁。锁只是优化，
 * 拿不到锁时仍会继续执行，避免因为残留锁把 toolbox / 面板整个卡死。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPlatformConfig } from "../redteam/platform-config.js";

const MAX_DEPTH = 3;
const MAX_FILES = 1200;
const HELP_MAX = 4000;
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 4000;
const LOCK_STALE_MS = 30_000;
const SKIP_DIRS = new Set(["node_modules", ".git", ".svn", "venv", ".venv", "site-packages", "__pycache__"]);

/** 只给“扫描到的工具”补默认卡片信息，不会凭空创建工具条目。 */
const TOOL_HINTS = {
  nmap: { purpose: "端口与服务识别", tags: ["recon", "port", "scan", "service"], risk: "active" },
  probe: { purpose: "批量 HTTP 探测与差分取证（httpprobe.py：端点批量、取 VIEWSTATE/token、落原始包、计时筛）", tags: ["web", "http", "differential", "probe"], risk: "active" },
  masscan: { purpose: "大网段高速端口扫描", tags: ["recon", "port"], risk: "active" },
  nuclei: { purpose: "模板化漏洞扫描", tags: ["scan", "vuln", "poc"], risk: "active" },
  httpx: { purpose: "HTTP 探活与指纹", tags: ["recon", "http", "fingerprint"], risk: "active" },
  dnsx: { purpose: "DNS 批量解析与记录枚举", tags: ["recon", "dns"], risk: "active" },
  subfinder: { purpose: "被动子域名枚举", tags: ["recon", "subdomain", "dns"], risk: "passive" },
  ksubdomain: { purpose: "子域名爆破", tags: ["recon", "subdomain", "dns"], risk: "active" },
  ffuf: { purpose: "Web 目录与参数爆破", tags: ["web", "fuzz", "directory"], risk: "active" },
  fscan: { purpose: "内网综合扫描", tags: ["intranet", "scan", "credential"], risk: "active" },
  frp: { purpose: "内网隧道与端口转发", tags: ["tunnel", "proxy"], risk: "active" },
  chisel: { purpose: "TCP/UDP 隧道", tags: ["tunnel", "proxy"], risk: "active" },
  suo5: { purpose: "HTTP 隧道", tags: ["tunnel", "http"], risk: "active" },
};

function emptyRegistry() {
  return { version: 1, roots: [], tools: {}, hidden: [], updated_at: null, last_sync: null };
}

/** 手动路径是否还能用：同步时用来判断“保留人工路径”还是“标记消失”。 */
function isExistingFile(file) {
  try { return Boolean(file) && fs.statSync(String(file)).isFile(); } catch { return false; }
}

export function toolboxHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

export function modeDir(home, mode) {
  return path.join(home, mode === "crack" ? "crack" : "redteam");
}

export function registryPath(home, mode) {
  return path.join(modeDir(home, mode), "toolbox.json");
}

export function loadRegistry(home = toolboxHome(), mode = "redteam") {
  const file = registryPath(home, mode);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      ...emptyRegistry(),
      ...(raw && typeof raw === "object" ? raw : {}),
      roots: Array.isArray(raw?.roots) ? raw.roots.filter((r) => r && typeof r.path === "string") : [],
      tools: raw?.tools && typeof raw.tools === "object" ? raw.tools : {},
      /* 面板「移除这条」记下的名字：重新同步时不再扫回来。 */
      hidden: Array.isArray(raw?.hidden)
        ? raw.hidden.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean)
        : [],
    };
  } catch {
    return emptyRegistry();
  }
}

/** 只做原子写。会改 registry 的调用方请用 mutateRegistry / withLock。 */
export function saveRegistry(home, mode, registry) {
  const file = registryPath(home, mode);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = {
    ...emptyRegistry(),
    ...(registry || {}),
    updated_at: new Date().toISOString(),
  };
  const tmp = file + "." + process.pid + "." + Date.now() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  try { fs.renameSync(tmp, file); } catch {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    fs.renameSync(tmp, file);
  }
  return next;
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* 极少数没有 SharedArrayBuffer 的环境 */ }
  }
}

/**
 * 跨进程写锁。多 worker 同时 use/learn/sync 时，避免 load→改→save 丢更新。
 * 拿不到锁（权限、残留锁超时）也继续执行，保证功能可用。
 */
function withLock(home, mode, fn) {
  const file = registryPath(home, mode);
  const lock = file + ".lock";
  let fd = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const started = Date.now();
    for (;;) {
      try {
        fd = fs.openSync(lock, "wx");
        try { fs.writeSync(fd, String(process.pid)); } catch { /* ignore */ }
        break;
      } catch (error) {
        if (error && error.code !== "EEXIST") break;
        let stale = false;
        try { stale = Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS; } catch { stale = true; }
        if (stale) {
          try { fs.rmSync(lock, { force: true }); } catch { /* ignore */ }
          continue;
        }
        if (Date.now() - started > LOCK_TIMEOUT_MS) break;
        sleepSync(LOCK_RETRY_MS);
      }
    }
  } catch {
    fd = null;
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.rmSync(lock, { force: true }); } catch { /* ignore */ }
    }
  }
}

/** 在锁内读 → 改 → 写。mutator 返回 undefined 时返回保存后的 registry。 */
export function mutateRegistry(home, mode, mutator) {
  return withLock(home, mode, () => {
    const registry = loadRegistry(home, mode);
    const result = mutator ? mutator(registry) : undefined;
    const saved = saveRegistry(home, mode, registry);
    return result === undefined ? saved : result;
  });
}

function isWindows() {
  return process.platform === "win32";
}

function isExecutable(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size === 0) return false;
    if (!isWindows()) return (st.mode & 0o111) !== 0;
    return [".exe", ".cmd", ".bat", ".com", ".ps1"].includes(path.extname(file).toLowerCase());
  } catch {
    return false;
  }
}

function normalizeRoot(value, home) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return path.resolve(raw.replace(/^~(?=$|[\\/])/, home));
}

function normalizeTags(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(/[,，、;；\s]+/);
  return Array.from(new Set(list.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean))).slice(0, 12);
}

/** 默认根 + 用户根 + 平台配置根；去重，不读取 PATH。 */
export function rootsOf(home = toolboxHome(), mode = "redteam", registry = loadRegistry(home, mode)) {
  const roots = [];
  const add = (value, source) => {
    const dir = normalizeRoot(value, home);
    if (!dir) return;
    if (!roots.some((r) => r.path.toLowerCase() === dir.toLowerCase())) roots.push({ path: dir, source });
  };
  add(path.join(home, "tools"), "default");
  add(path.join(modeDir(home, mode), mode === "crack" ? "tools" : "toolkit"), "default");
  for (const root of registry.roots || []) {
    if (root.enabled === false) continue;
    add(root.path, root.source || "user");
  }
  if (mode === "redteam") {
    try {
      /* 配置根跟着传入的 home 走：测试/自定义 REDTEAM_HOME 时才不会去读真实用户目录。 */
      const cfgRoot = process.env.REDTEAM_HOME || path.join(home, "redteam");
      const cfg = loadPlatformConfig(cfgRoot);
      add(cfg.toolkitDir, "config");
      for (const dir of Array.isArray(cfg.binDirs) ? cfg.binDirs : []) add(dir, "config");
      /* 用户逐个填的工具路径：把所在目录作为发现根，保证面板 / toolbox 一致。 */
      for (const file of Object.values(cfg.tools || {})) {
        const text = String(file || "").trim();
        if (text) add(path.dirname(text), "config");
      }
    } catch { /* config 不可读就只用默认根 */ }
  }
  return roots;
}

function scanRoot(root, state) {
  if (state.files >= MAX_FILES) return;
  let entries = [];
  try { entries = fs.readdirSync(root.path, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(root.path, entry.name);
    if (entry.isDirectory()) {
      if (state.depth >= MAX_DEPTH) continue;
      if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      state.depth += 1;
      scanRoot({ ...root, path: full }, state);
      state.depth -= 1;
      continue;
    }
    if (!entry.isFile() || !isExecutable(full)) continue;
    if (state.files >= MAX_FILES) {
      state.truncated = true;
      break;
    }
    state.files += 1;
    const name = path.basename(entry.name, path.extname(entry.name)).toLowerCase();
    if (!name || state.tools[name]) continue;
    const hint = TOOL_HINTS[name] || {};
    state.tools[name] = {
      name,
      path: full,
      source: root.source || "user",
      status: "",
      uses: 0,
      first_seen: null,
      last_seen: null,
      recipe: null,
      help: null,
      missing: false,
      purpose: hint.purpose || "",
      tags: hint.tags ? hint.tags.slice() : [],
      risk: hint.risk || "",
    };
  }
}

/** 重新扫 roots；保留已有 uses / recipe / help / status / 人工卡片。 */
export function syncRegistry(home = toolboxHome(), mode = "redteam") {
  return withLock(home, mode, () => {
    const registry = loadRegistry(home, mode);
    /* 默认目录始终存在，模型下载工具时不用自己猜路径。 */
    try { fs.mkdirSync(path.join(home, "tools"), { recursive: true }); } catch { /* ignore */ }
    try { fs.mkdirSync(path.join(modeDir(home, mode), mode === "crack" ? "tools" : "toolkit"), { recursive: true }); } catch { /* ignore */ }
    const roots = rootsOf(home, mode, registry);
    const state = { depth: 0, files: 0, tools: {}, truncated: false };
    for (const root of roots) scanRoot(root, state);
    const old = registry.tools || {};
    const hidden = new Set(registry.hidden || []);
    const now = new Date().toISOString();
    for (const [name, tool] of Object.entries(state.tools)) {
      const prev = old[name] || {};
      /* 面板里手动指定的路径优先：同名的旧副本还在扫描目录里时，不能被同步覆盖。 */
      const keepManual = prev.source === "manual" && isExistingFile(prev.path);
      state.tools[name] = {
        ...tool,
        ...prev,
        name,
        path: keepManual ? prev.path : tool.path,
        source: keepManual ? "manual" : (prev.source || tool.source),
        uses: Number(prev.uses) || 0,
        registered: prev.registered === true,
        registered_at: prev.registered_at || null,
        first_seen: prev.first_seen || now,
        last_seen: prev.last_seen || null,
        recipe: prev.recipe || null,
        help: prev.help || null,
        missing: false,
        purpose: prev.purpose || tool.purpose || "",
        tags: Array.from(new Set([
          ...(Array.isArray(prev.tags) ? prev.tags : []),
          ...(Array.isArray(tool.tags) ? tool.tags : []),
        ])),
        risk: prev.risk || tool.risk || "",
      };
    }
    for (const [name, prev] of Object.entries(old)) {
      if (state.tools[name]) continue;
      /* 手动路径可能就在扫描根之外：只有它仍存在时才算“可用”；
         原来扫到、但目录已被移除的工具仍标 missing（文件还在也不算发现）。 */
      state.tools[name] = { ...prev, name, missing: !(prev.source === "manual" && isExistingFile(prev.path)) };
    }
    /* 用户在面板里移除过的工具：即使二进制还在目录里，也不再扫回来。 */
    for (const name of Object.keys(state.tools)) {
      if (hidden.has(name)) delete state.tools[name];
    }
    /* registry.roots 只持久化“用户添加”的根；默认/配置根每次由 rootsOf 重新组合，
       这样用户改了 toolkitDir/binDirs 后旧目录不会永远留在扫描列表里。 */
    const userRoots = (registry.roots || []).filter((root) => root && root.source !== "default" && root.source !== "config");
    const next = {
      ...registry,
      roots: userRoots,
      tools: state.tools,
      last_sync: now,
      last_sync_truncated: state.truncated === true,
    };
    saveRegistry(home, mode, next);
    return {
      ...next,
      count: Object.keys(state.tools).length,
      scanned: state.files,
      truncated: state.truncated === true,
    };
  });
}

export function addRoot(home, mode, dir, source = "user") {
  const normalized = normalizeRoot(dir, home);
  if (!normalized) throw new Error("目录不能为空");
  let st;
  try { st = fs.statSync(normalized); } catch {
    throw new Error("目录不存在：" + normalized);
  }
  if (!st.isDirectory()) throw new Error("不是目录：" + normalized);
  withLock(home, mode, () => {
    const registry = loadRegistry(home, mode);
    if (!registry.roots.some((r) => r.path.toLowerCase() === normalized.toLowerCase())) {
      registry.roots.push({ path: normalized, source, enabled: true });
      saveRegistry(home, mode, registry);
    }
  });
  return syncRegistry(home, mode);
}

export function removeRoot(home, mode, dir) {
  const normalized = normalizeRoot(dir, home);
  withLock(home, mode, () => {
    const registry = loadRegistry(home, mode);
    const next = registry.roots.filter((r) => r.path.toLowerCase() !== normalized.toLowerCase());
    if (next.length !== registry.roots.length) {
      registry.roots = next;
      saveRegistry(home, mode, registry);
    }
  });
  return syncRegistry(home, mode);
}

/** 工具被模型打开/执行/固化后登记，面板默认只显示登记过的工具。 */
export function markRegistered(home, mode, name) {
  const key = String(name || "").trim().toLowerCase();
  if (!key) return null;
  return withLock(home, mode, () => {
    const registry = loadRegistry(home, mode);
    const tool = registry.tools[key] || { name: key, path: "", source: "model", status: "", uses: 0 };
    const now = new Date().toISOString();
    tool.registered = true;
    if (!tool.registered_at) tool.registered_at = now;
    if (!tool.first_seen) tool.first_seen = now;
    registry.tools[key] = tool;
    saveRegistry(home, mode, registry);
    return tool;
  });
}

export function recordUse(home, mode, name, extra = {}) {
  const key = String(name || "").trim().toLowerCase();
  if (!key) return null;
  return withLock(home, mode, () => {
    const registry = loadRegistry(home, mode);
    const tool = registry.tools[key] || { name: key, path: "", source: "model", status: "", uses: 0 };
    const now = new Date().toISOString();
    tool.uses = (Number(tool.uses) || 0) + 1;
    tool.last_seen = now;
    tool.registered = true;
    if (!tool.registered_at) tool.registered_at = now;
    if (extra.command) {
      tool.recipe = { command: String(extra.command), note: String(extra.note || ""), updated_at: now };
    }
    if (!tool.first_seen) tool.first_seen = now;
    registry.tools[key] = tool;
    saveRegistry(home, mode, registry);
    return tool;
  });
}

export function learnRecipe(home, mode, name, command, note = "", extra = {}) {
  const key = String(name || "").trim().toLowerCase();
  const cmd = String(command || "").trim();
  if (!key || !cmd) throw new Error("name 和 command 不能为空");
  return withLock(home, mode, () => {
    const registry = loadRegistry(home, mode);
    const tool = registry.tools[key] || { name: key, path: "", source: "model", status: "", uses: 0 };
    const now = new Date().toISOString();
    tool.recipe = { command: cmd, note: String(note || ""), updated_at: now };
    tool.registered = true;
    if (!tool.registered_at) tool.registered_at = now;
    const tags = normalizeTags(extra.tags);
    if (tags.length) tool.tags = normalizeTags([...(Array.isArray(tool.tags) ? tool.tags : []), ...tags]);
    if (extra.purpose) tool.purpose = String(extra.purpose).trim().slice(0, 120);
    if (extra.risk) tool.risk = String(extra.risk).trim().toLowerCase().slice(0, 24);
    if (!tool.first_seen) tool.first_seen = now;
    tool.last_seen = now;
    registry.tools[key] = tool;
    saveRegistry(home, mode, registry);
    return tool;
  });
}

/** 面板编辑工具卡片：用途、tags、risk、recipe。不会改使用次数。 */
export function setToolMeta(home, mode, name, patch = {}) {
  const key = String(name || "").trim().toLowerCase();
  if (!key) throw new Error("name 不能为空");
  return withLock(home, mode, () => {
    const registry = loadRegistry(home, mode);
    const tool = registry.tools[key] || { name: key, path: "", source: "manual", uses: 0 };
    const now = new Date().toISOString();
    if (patch.purpose !== undefined) tool.purpose = String(patch.purpose || "").trim().slice(0, 120);
    if (patch.tags !== undefined) tool.tags = normalizeTags(patch.tags);
    if (patch.risk !== undefined) tool.risk = String(patch.risk || "").trim().toLowerCase().slice(0, 24);
    if (patch.recipe !== undefined) {
      const command = String(patch.recipe || "").trim();
      tool.recipe = command
        ? { command, note: String(patch.note || ""), updated_at: now }
        : null;
    } else if (patch.note !== undefined && tool.recipe) {
      tool.recipe.note = String(patch.note || "");
      tool.recipe.updated_at = now;
    }
    tool.updated_at = now;
    tool.registered = true;
    if (!tool.registered_at) tool.registered_at = now;
    registry.tools[key] = tool;
    saveRegistry(home, mode, registry);
    return tool;
  });
}

/** 面板「移除这条」：删掉登记条目（用途、标注、使用次数一起走）。 */
export function forgetTool(home, mode, name) {
  const key = String(name || "").trim().toLowerCase();
  if (!key) return false;
  return withLock(home, mode, () => {
    const registry = loadRegistry(home, mode);
    if (!registry.tools[key]) {
      /* 已经不在表里也要记一笔：否则下次同步会把它扫回来。 */
      if (!registry.hidden.includes(key)) {
        registry.hidden.push(key);
        saveRegistry(home, mode, registry);
      }
      return false;
    }
    delete registry.tools[key];
    if (!registry.hidden.includes(key)) registry.hidden.push(key);
    saveRegistry(home, mode, registry);
    return true;
  });
}

/** 面板改单条工具路径：只改这一条，不重扫目录。 */
export function setToolPath(home, mode, name, file) {
  const key = String(name || "").trim().toLowerCase();
  if (!key) throw new Error("name 不能为空");
  return withLock(home, mode, () => {
    const registry = loadRegistry(home, mode);
    const tool = registry.tools[key] || { name: key, source: "manual", status: "", uses: 0 };
    tool.path = String(file || "").trim();
    /* 已有条目也要标成人工路径：否则下一次同步还会用扫描到的旧路径覆盖。 */
    tool.source = "manual";
    tool.missing = false;
    tool.updated_at = new Date().toISOString();
    /* 之前移除过又给回了路径：撤销隐藏。 */
    registry.hidden = registry.hidden.filter((x) => x !== key);
    registry.tools[key] = tool;
    saveRegistry(home, mode, registry);
    return tool;
  });
}

export function setHelp(home, mode, name, text) {
  const key = String(name || "").trim().toLowerCase();
  if (!key) return null;
  return withLock(home, mode, () => {
    const registry = loadRegistry(home, mode);
    const tool = registry.tools[key] || { name: key, path: "", source: "model", uses: 0 };
    tool.help = {
      text: String(text || "").slice(0, HELP_MAX),
      updated_at: new Date().toISOString(),
      truncated: String(text || "").length > HELP_MAX,
    };
    registry.tools[key] = tool;
    saveRegistry(home, mode, registry);
    return tool;
  });
}

export function setToolStatus(home, mode, name, status, note) {
  const key = String(name || "").trim().toLowerCase();
  if (!key) throw new Error("name 不能为空");
  return withLock(home, mode, () => {
    const registry = loadRegistry(home, mode);
    const tool = registry.tools[key] || { name: key, path: "", source: "manual", uses: 0 };
    if (status !== undefined) tool.status = String(status || "");
    if (note !== undefined) tool.note = String(note || "");
    tool.updated_at = new Date().toISOString();
    tool.registered = true;
    if (!tool.registered_at) tool.registered_at = tool.updated_at;
    registry.tools[key] = tool;
    saveRegistry(home, mode, registry);
    return tool;
  });
}

function tokensOf(query) {
  return String(query || "").trim().toLowerCase().split(/[\s,，、;；|/]+/).filter(Boolean);
}

function scoreOf(tool, tokens, known) {
  const name = String(tool.name || "").toLowerCase();
  const purpose = String(tool.purpose || "").toLowerCase();
  const note = String(tool.note || "").toLowerCase();
  const source = String(tool.source || "").toLowerCase();
  const recipe = String(tool.recipe && tool.recipe.command || "").toLowerCase();
  const file = String(tool.path || "").toLowerCase();
  const tags = (Array.isArray(tool.tags) ? tool.tags : []).map((x) => String(x).toLowerCase());
  const uses = Number(tool.uses) || 0;
  let score = Math.min(uses, 50) * 2;
  if (known) score += tokens.length ? 30 : 1000;
  if (tool.missing === true) score -= 120;
  if (tool.status === "blocked") score -= 200;
  if (tool.recipe && tool.recipe.command) score += 5;
  if (!tokens.length) {
    /* 空查询默认给“有卡片信息”的工具，而不是一堆按字母序的陌生文件名。 */
    if (purpose) score += 40;
    score += Math.min(tags.length, 5) * 5;
    if (tool.recipe && tool.recipe.command) score += 10;
    return score;
  }

  let matched = 0;
  for (const token of tokens) {
    let hit = 0;
    if (name === token) hit = 120;
    else if (name.startsWith(token)) hit = 80;
    else if (name.includes(token)) hit = 55;
    if (tags.some((tag) => tag === token)) hit = Math.max(hit, 45);
    else if (tags.some((tag) => tag.includes(token) || token.includes(tag))) hit = Math.max(hit, 30);
    if (purpose.includes(token)) hit = Math.max(hit, 35);
    if (recipe.includes(token)) hit = Math.max(hit, 15);
    if (note.includes(token)) hit = Math.max(hit, 12);
    if (file.includes(token)) hit = Math.max(hit, 10);
    if (source.includes(token)) hit = Math.max(hit, 5);
    if (hit > 0) matched += 1;
    score += hit;
  }
  if (!matched) return Number.NEGATIVE_INFINITY;
  if (matched === tokens.length && tokens.length > 1) score += 20;
  return score;
}

/** 按名称 / 用途 / tags / recipe / 使用频率排序的工具卡片。 */
export function findRegistry(home, mode, query = "", limit = 8, known = [], maxLimit = 30) {
  const registry = loadRegistry(home, mode);
  const tokens = tokensOf(query);
  const knownSet = new Set((Array.isArray(known) ? known : []).map((x) => String(x).toLowerCase()));
  const cap = Math.max(1, Math.min(Number(maxLimit) || 30, 200));
  const max = Math.max(1, Math.min(Number(limit) || 8, cap));
  return Object.values(registry.tools || {})
    .map((tool) => ({ tool, score: scoreOf(tool, tokens, knownSet.has(String(tool.name || "").toLowerCase())) }))
    .filter((row) => Number.isFinite(row.score))
    .sort((a, b) => b.score - a.score || (Number(b.tool.uses) || 0) - (Number(a.tool.uses) || 0) || String(a.tool.name).localeCompare(String(b.tool.name)))
    .slice(0, max)
    .map((row) => row.tool);
}

export function searchRegistry(home, mode, query = "", limit = 40) {
  return findRegistry(home, mode, query, limit, [], 200);
}
