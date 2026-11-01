/**
 * 红队平台适配配置（插件内，无 .ps1）
 *
 * 落盘：`$DSH_HOME/redteam/config.json`
 * 用途：
 *   · Windows 上由用户填写工具绝对路径或搜索目录；
 *   · preflight / 技能可用性 / nuclei 模板目录 统一走这里；
 *   · 不往官方 `$DSH_HOME/skills` 写任何东西。
 *
 * 借鉴 Z3r0：系统配置集中、可在 UI 里改（FOFA / 路径类），而不是只靠 shell 引导。
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir, platform as osPlatform } from 'node:os'
import { connect as tcpConnect } from 'node:net'
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { toolGuide, isSystemCommand } from './tool-guide.js'

/** 配置文件路径。 */
export function configPathOf(root) {
  return join(root || redteamRoot(), 'config.json')
}

export function redteamRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'redteam')
}

/** `$DSH_HOME/.env`：preflight、面板和技能可用性必须读同一份。 */
export function envFilePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, '.env')
}

/**
 * 解析 .env：支持 `export KEY=value`、引号、未加引号的行内注释。
 * 空值忽略；重复键以最后一次为准（keys 保留出现顺序）。
 */
export function parseEnvFile(text) {
  const keys = []
  const values = {}
  for (const line of String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (m === null) continue
    let raw = m[2].trim()
    if (!/^["']/.test(raw)) raw = raw.replace(/\s+#.*$/, '')
    const value = raw.replace(/^["']|["']$/g, '').trim()
    if (value === '') continue
    keys.push(m[1])
    values[m[1]] = value
  }
  return { keys, values }
}

/** 读 `$DSH_HOME/.env`；读不到时返回空结构，不抛错。 */
export function readEnvFile() {
  const path = envFilePath()
  try {
    const parsed = parseEnvFile(readFileSync(path, 'utf8'))
    return { path, exists: true, ...parsed }
  } catch {
    return { path, exists: false, keys: [], values: {} }
  }
}

/**
 * 合并进程环境 + 平台 config.json env + `$DSH_HOME/.env`。
 * 优先级与 preflight 原逻辑一致：进程 / config 已有的非空值优先，.env 只补空。
 */
export function effectiveEnvOf(root, cfg) {
  const out = mergeConfigEnv({ ...process.env }, cfg || loadPlatformConfig(root))
  const file = readEnvFile()
  for (const [key, value] of Object.entries(file.values)) {
    if (out[key] === undefined || out[key] === '') out[key] = value
  }
  return out
}

/** 从 `$DSH_HOME/.env` 删除一个键（只删赋值行，保留注释和其它键）。 */
export function removeEnvFileKey(name) {
  const path = envFilePath()
  try {
    if (!existsSync(path)) return false
    const text = readFileSync(path, 'utf8')
    const bom = text.startsWith('\uFEFF') ? '\uFEFF' : ''
    const body = bom ? text.slice(1) : text
    const eol = body.includes('\r\n') ? '\r\n' : '\n'
    const lines = body.split(/\r?\n/)
    const kept = lines.filter((line) => {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
      return !(m !== null && m[1] === name)
    })
    if (kept.length === lines.length) return false
    writeFileSync(path, bom + kept.join(eol))
    return true
  } catch {
    return false
  }
}

/** 默认工具箱目录。 */
export function defaultToolkitDir(root) {
  return join(root || redteamRoot(), 'toolkit')
}

/**
 * 核心工具：没有它们，基础侦察/验证闭环就跑不起来。
 * 只有这一层会进 preflight 的缺失检查；其余工具保留、可发现，但不默认要求。
 */
export const CORE_TOOL_IDS = Object.freeze(['nmap', 'httpx', 'ffuf', 'nuclei', 'subfinder']);
const CORE_TOOL_SET = new Set(CORE_TOOL_IDS);

export function toolTier(id) {
  return CORE_TOOL_SET.has(String(id || '').trim().toLowerCase()) ? 'core' : 'scenario';
}

export function isCoreTool(id) {
  return toolTier(id) === 'core';
}

/**
 * 内置别名表：只用于把命令 / 文件名归并到稳定 id（整包扫描、工具使用记录）。
 * 面板不按这张表列工具；工具清单来自实际磁盘扫描、手动指定与使用记录。
 * 用户可在 config.tools[id] 填绝对路径覆盖；也可在 binDirs 里放整包工具目录。
 *
 * tier=core 的条目进 preflight；tier=scenario 只做别名归并与按需发现，不默认检查。
 */
export const TOOL_CATALOG = [
  { id: 'nmap', label: 'Nmap', names: ['nmap.exe', 'nmap'] },
  { id: 'nuclei', label: 'Nuclei', names: ['nuclei.exe', 'nuclei'] },
  { id: 'fscan', label: 'fscan', names: ['fscan.exe', 'fscan'] },
  { id: 'suo5', label: 'suo5', names: ['suo5.exe', 'suo5-windows-amd64.exe', 'suo5-linux-amd64', 'suo5'] },
  { id: 'frpc', label: 'frp 客户端', names: ['frpc.exe', 'frpc'] },
  { id: 'frps', label: 'frp 服务端', names: ['frps.exe', 'frps'] },
  { id: 'chisel', label: 'chisel', names: ['chisel.exe', 'chisel'] },
  { id: 'ffuf', label: 'ffuf', names: ['ffuf.exe', 'ffuf'] },
  /* names 是候选文件名，不是某台机器的绝对路径。adapt 是发行版常见别名，目录里碰见才用。 */
  { id: 'httpx', label: 'httpx', names: ['httpx-toolkit', 'pd-httpx', 'httpx.exe', 'httpx'], rejectPython: true, adapt: [/^httpx-toolkit$/, /^pd-httpx$/, /^httpx$/] },
  { id: 'dnsx', label: 'dnsx', names: ['dnsx.exe', 'dnsx'] },
  { id: 'subfinder', label: 'subfinder', names: ['subfinder.exe', 'subfinder'] },
  { id: 'impacket', label: 'impacket（目录或入口）', names: ['impacket-secretsdump', 'impacket-secretsdump.exe', 'secretsdump.py', 'impacket'], adapt: [/^impacket-secretsdump$/, /^secretsdump\.py$/] },
].map((def) => ({ ...def, tier: toolTier(def.id) }))

const EMPTY = () => ({
  version: 1,
  /* auto | windows —— auto 跟 Node process.platform */
  platform: 'auto',
  toolkitDir: '',
  nucleiTemplatesDir: '',
  /* 额外搜索目录：用户自己的工具包 / 绿色版工具夹 */
  binDirs: [],
  /* 只保留用户真的填过的路径；不再预置一整排空工具键。 */
  tools: {},
  /* 面板里「移除这条」记下的工具 key：内置清单与目录扫描都不再列它。 */
  hiddenTools: [],
  env: {
    FOFA_KEY: '',
    REDTEAM_VPS_HOST: '',
    REDTEAM_VPS_KEY: '',
  },
  notes: '',
  updated_at: null,
})

function isWinLike() {
  return true
}

export function loadPlatformConfig(root) {
  const base = EMPTY()
  const file = configPathOf(root)
  if (!existsSync(file)) return Object.assign({}, base, { path: file, exists: false })
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const tools = Object.assign({}, base.tools, raw.tools && typeof raw.tools === 'object' ? raw.tools : {})
    const env = Object.assign({}, base.env, raw.env && typeof raw.env === 'object' ? raw.env : {})
    const binDirs = Array.isArray(raw.binDirs)
      ? raw.binDirs.map((x) => String(x || '').trim()).filter(Boolean)
      : []
    return {
      version: Number(raw.version) || 1,
      platform: ['auto', 'windows'].includes(raw.platform) ? raw.platform : 'auto',
      toolkitDir: typeof raw.toolkitDir === 'string' ? raw.toolkitDir.trim() : '',
      nucleiTemplatesDir: typeof raw.nucleiTemplatesDir === 'string' ? raw.nucleiTemplatesDir.trim() : '',
      binDirs,
      tools,
      hiddenTools: Array.isArray(raw.hiddenTools)
        ? raw.hiddenTools.map((x) => String(x || '').trim()).filter(Boolean)
        : [],
      env,
      egress: raw.egress && typeof raw.egress === 'object' ? raw.egress : {},
      notes: typeof raw.notes === 'string' ? raw.notes : '',
      updated_at: raw.updated_at || null,
      path: file,
      exists: true,
    }
  } catch (error) {
    return Object.assign({}, base, {
      path: file,
      exists: true,
      error: error && error.message ? error.message : String(error),
    })
  }
}

export function savePlatformConfig(patch, root) {
  const dir = root || redteamRoot()
  mkdirSync(dir, { recursive: true })
  const prev = loadPlatformConfig(dir)
  const next = {
    version: 1,
    platform: ['auto', 'windows'].includes(patch.platform) ? patch.platform : (prev.platform || 'auto'),
    toolkitDir: typeof patch.toolkitDir === 'string' ? patch.toolkitDir.trim() : (prev.toolkitDir || ''),
    nucleiTemplatesDir: typeof patch.nucleiTemplatesDir === 'string'
      ? patch.nucleiTemplatesDir.trim()
      : (prev.nucleiTemplatesDir || ''),
    binDirs: Array.isArray(patch.binDirs)
      ? patch.binDirs.map((x) => String(x || '').trim()).filter(Boolean)
      : (prev.binDirs || []),
    tools: (() => {
      const merged = Object.assign({}, prev.tools || {});
      for (const name of Array.isArray(patch.removeTools) ? patch.removeTools : []) {
        delete merged[String(name || '').trim()];
      }
      if (patch.tools && typeof patch.tools === 'object') Object.assign(merged, patch.tools);
      return merged;
    })(),
    hiddenTools: Array.isArray(patch.hiddenTools)
      ? patch.hiddenTools.map((x) => String(x || '').trim()).filter(Boolean)
      : (prev.hiddenTools || []),
    env: Object.assign({}, prev.env || {}, patch.env && typeof patch.env === 'object' ? patch.env : {}),
    egress: (() => {
      const raw = patch.egress && typeof patch.egress === 'object' ? patch.egress : null
      const base = prev.egress || {}
      return {
        proxy: raw ? String(raw.proxy || '').trim() : String(base.proxy || '').trim(),
        noProxy: raw ? String(raw.noProxy || '').trim() : String(base.noProxy || '').trim(),
      }
    })(),
    notes: typeof patch.notes === 'string' ? patch.notes : (prev.notes || ''),
    updated_at: new Date().toISOString(),
  }
  /* 空 tools 键不再补 catalog 全量；只整理用户实际填过的路径。 */
  for (const id of Object.keys(next.tools)) {
    next.tools[id] = String(next.tools[id] || '').trim()
    if (!next.tools[id]) delete next.tools[id]
  }
  const file = configPathOf(dir)
  writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
  return loadPlatformConfig(dir)
}

function normPath(x) {
  const raw = String(x || '').trim()
  if (!raw) return ''
  try {
    return resolve(raw).replace(/[\\/]+$/, '').toLowerCase()
  } catch {
    return ''
  }
}

function samePath(a, b) {
  const left = normPath(a)
  return left !== '' && left === normPath(b)
}



/**
 * 从平台配置里移除一个“手动指定”的工具发现根：
 *   · toolkitDir 等于它 → 清空；
 *   · binDirs 里等于它的 → 删除；
 *   · tools 里路径父目录等于它的 → 删除。
 * 只删这一行根，不连带删除子目录里的其它根；插件默认目录不碰。
 */
export function removePlatformToolRoot(root, dir) {
  const cfg = loadPlatformConfig(root)
  const patch = {}
  let changed = false
  if (cfg.toolkitDir && samePath(cfg.toolkitDir, dir)) {
    patch.toolkitDir = ''
    changed = true
  }
  const bins = Array.isArray(cfg.binDirs) ? cfg.binDirs : []
  const keptBins = bins.filter((d) => !samePath(d, dir))
  if (keptBins.length !== bins.length) {
    patch.binDirs = keptBins
    changed = true
  }
  /* 只删“这一行根”对应的工具路径，不连带删除子目录里的其它根。 */
  const removeTools = []
  for (const [name, file] of Object.entries(cfg.tools || {})) {
    if (samePath(dirname(String(file || '')), dir)) removeTools.push(name)
  }
  if (removeTools.length) {
    patch.removeTools = removeTools
    changed = true
  }
  if (!changed) return { ok: false, changed: false, error: '该目录不是手动配置的工具路径' }
  const saved = savePlatformConfig(patch, root)
  return {
    ok: true, changed: true,
    removed_tools: removeTools,
    toolkitDir: saved.toolkitDir,
    binDirs: saved.binDirs,
  }
}

/** 生效的工具箱根。 */
export function toolkitDirOf(cfg, root) {
  const c = cfg || loadPlatformConfig(root)
  if (c.toolkitDir) return resolve(c.toolkitDir)
  return defaultToolkitDir(root)
}

/** 生效的 nuclei 模板目录（可空）。 */
export function nucleiTemplatesDirOf(cfg, root) {
  const c = cfg || loadPlatformConfig(root)
  if (c.nucleiTemplatesDir && existsSync(c.nucleiTemplatesDir)) return resolve(c.nucleiTemplatesDir)
  return null
}

/**
 * 在目录里找可执行名（浅扫一层 + 常见子目录 bin/）。
 */
function looksLikePythonCli(file) {
  /* pip / conda 生成的 Windows 入口 shim（如 `Scripts\httpx.exe`）不是 ProjectDiscovery 的 httpx：
     它只有一百来 KB，真正的 httpx 是几十 MB 的 Go 二进制。按目录判，比读 PE 头稳。 */
  const normalized = String(file).replace(/\\/g, "/").toLowerCase()
  if (/\.exe$/.test(normalized) && /(^|\/)(scripts|site-packages)\//.test(normalized)) return true
  let fd
  try {
    const buf = Buffer.alloc(96)
    fd = openSync(file, 'r')
    const n = readSync(fd, buf, 0, buf.length, 0)
    const head = buf.subarray(0, n).toString('utf8')
    return head.startsWith('#!') && /python/i.test(head)
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}

function findInDir(dir, names, options = {}) {
  if (!dir || !existsSync(dir)) return null
  const tryOne = (base) => {
    for (const name of names) {
      const p = join(base, name)
      if (existsSync(p)) {
        try {
          const st = statSync(p)
          if (!st.isFile()) continue
          if (options.rejectPython && looksLikePythonCli(p)) continue
          return p
        } catch { /* continue */ }
      }
    }
    return null
  }
  const hit = tryOne(dir) || adaptInDir(dir, options)
  if (hit) return hit
  for (const sub of ['bin', 'Bins', 'tools', 'Tools']) {
    const nested = tryOne(join(dir, sub)) || adaptInDir(join(dir, sub), options)
    if (nested) return nested
  }
  return null
}

/** 精确文件名没有时，用发行版别名在这一层目录里对。对上才算找到。 */
function adaptInDir(dir, options) {
  const patterns = options.adapt
  if (!dir || !Array.isArray(patterns) || patterns.length === 0 || !existsSync(dir)) return null
  let names
  try { names = readdirSync(dir) } catch { return null }
  for (const pattern of patterns) {
    for (const name of names) {
      if (!pattern.test(String(name).toLowerCase())) continue
      const file = join(dir, name)
      try {
        if (!statSync(file).isFile()) continue
        if (options.rejectPython && looksLikePythonCli(file)) continue
        return file
      } catch { /* continue */ }
    }
  }
  return null
}

/** PATH 上的 which（仅同步、不 spawn shell）。 */
function findOnPath(names, env = process.env, options = {}) {
  const pathVar = env.PATH || env.Path || ''
  const parts = pathVar.split(delimiter).filter(Boolean)
  for (const part of parts) {
    const hit = findInDir(part, names, options)
    if (hit) return hit
  }
  return null
}

/**
 * 解析单个工具：用户指定路径 → toolkit → binDirs → PATH。
 * @returns `{ id, label, path, source: 'config'|'toolkit'|'binDir'|'path'|'missing', names }`
 */
export function resolveTool(id, options = {}) {
  const root = options.root || redteamRoot()
  const cfg = options.config || loadPlatformConfig(root)
  const env = options.env || process.env
  const def = TOOL_CATALOG.find((t) => t.id === id)
  if (!def) {
    return { id, label: id, path: null, source: 'missing', names: [], tier: toolTier(id) }
  }
  const configured = cfg.tools && typeof cfg.tools[id] === 'string' ? cfg.tools[id].trim() : ''
  if (configured) {
    const abs = isAbsolute(configured) ? configured : resolve(configured)
    if (existsSync(abs)) {
      return { id, label: def.label, path: abs, source: 'config', names: def.names, tier: def.tier }
    }
    return { id, label: def.label, path: null, source: 'missing', names: def.names, tier: def.tier, configured: abs, note: 'config 路径不存在：' + abs }
  }
  const findOpts = { rejectPython: !!def.rejectPython, adapt: def.adapt }
  const toolkit = toolkitDirOf(cfg, root)
  const fromToolkit = findInDir(toolkit, def.names, findOpts)
  if (fromToolkit) return { id, label: def.label, path: fromToolkit, source: 'toolkit', names: def.names, tier: def.tier }

  for (const dir of cfg.binDirs || []) {
    const hit = findInDir(dir, def.names, findOpts)
    if (hit) return { id, label: def.label, path: hit, source: 'binDir', names: def.names, tier: def.tier, binDir: dir }
  }

  const fromPath = findOnPath(def.names, env, findOpts)
  if (fromPath) return { id, label: def.label, path: fromPath, source: 'path', names: def.names, tier: def.tier }

  return { id, label: def.label, path: null, source: 'missing', names: def.names, tier: def.tier }
}

export function resolveAllTools(options = {}) {
  return TOOL_CATALOG.map((t) => resolveTool(t.id, options))
}

/**
 * 把配置里的 env 合并进 effectiveEnv（进程 / .env 已有的优先，不覆盖）。
 */
export function mergeConfigEnv(effectiveEnv, cfg) {
  const out = Object.assign({}, effectiveEnv || {})
  const env = (cfg && cfg.env) || {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string') continue
    const val = v.trim()
    if (val === '') continue
    if (out[k] === undefined || out[k] === '') out[k] = val
  }
  return out
}

/**
 * 平台摘要：给面板与 preflight 用。
 */
export function platformSummary(root) {
  const cfg = loadPlatformConfig(root)
  const tools = resolveAllTools({ root, config: cfg })
  const found = tools.filter((t) => t.path)
  const missing = tools.filter((t) => !t.path)
  const toolkit = toolkitDirOf(cfg, root)
  const nuclei = nucleiTemplatesDirOf(cfg, root)
    || (existsSync(join(toolkit, 'nuclei-templates')) ? join(toolkit, 'nuclei-templates') : null)
  return {
    ok: true,
    config: Object.assign({}, cfg, { env: Object.assign({}, cfg.env, { FOFA_KEY: '' }) }),
    runtime: {
      nodePlatform: osPlatform(),
      effective: 'windows',
      windows: true,
      sep,
    },
    toolkitDir: toolkit,
    toolkitExists: existsSync(toolkit),
    nucleiTemplatesDir: nuclei,
    tools: {
      total: tools.length,
      found: found.length,
      missing: missing.length,
      items: tools,
    },
    /* 面板“工具”页用这份：只列实际存在或手动指定的，不再展示内置目录里的缺失项。 */
    inventory: buildToolInventory({ root, config: cfg }),
    hint: '当前按 Windows 适配：在本页填工具路径或用整包文件夹自动分配。出网代理看下方「出网状态」。',
    egress: {
      proxy: String((cfg.egress && cfg.egress.proxy) || ''),
      noProxy: String((cfg.egress && cfg.egress.noProxy) || ''),
      http_proxy: process.env.HTTP_PROXY || process.env.http_proxy || '',
      https_proxy: process.env.HTTPS_PROXY || process.env.https_proxy || '',
      all_proxy: process.env.ALL_PROXY || process.env.all_proxy || '',
      no_proxy: process.env.NO_PROXY || process.env.no_proxy || '',
      note: '只填 IP:端口（要认证写 user:pass@IP:端口）；http 与 socks5 同一个端口，由 AI 按任务选。会写进系统提示；不改 dsh 自身流量。',
    },
  }
}

const NAME_TO_IDS = (() => {
  const map = new Map()
  for (const t of TOOL_CATALOG) {
    for (const name of t.names) {
      const key = String(name).toLowerCase()
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(t.id)
    }
  }
  return map
})()

/* 面板工具清单不按内置目录列，只列「实际有」或「实际用过」的。
   这里给工具箱/附加目录做通用可执行文件扫描，名字和数量都来自磁盘。 */
const WIN_TOOL_EXT = new Set(['.exe', '.bat', '.cmd', '.ps1', '.com', '.msi'])
const TOOL_NOISE = /^(unins\d*|uninstall|setup|install|update|updater|crashpad|reporter|vc_redist|python|pythonw|node|npm|npx|pip|pip3|7z|7za)$/i
const TOOL_NOISE_SUFFIX = /(?:[-_.]?(?:update|updater|setup|installer|uninstall|crashpad|reporter))$/i
/* 工具包里常见的运行时/编译链/文档目录：整棵跳过，避免把 mingw、java 的 bin 扫进工具清单。 */
const TOOL_SKIP_DIR = /^(mingw(32|64)?|java\d*|jre\d*|jdk[\d._-]*|python\d*|py\d+|nodejs|perl\d*|ruby\d*|php\d*|_trash|__pycache__|node_modules|site-packages|lib|libexec|share|include|docs?|examples?|samples?|tests?)$/i

function toolKeyOf(name) {
  return String(name || '').trim().toLowerCase()
    .replace(/\\/g, '/').split('/').pop()
    .replace(/\.(exe|bat|cmd|ps1|com|msi|py|sh)$/i, '')
}

function isToolFileName(name) {
  const lower = String(name || '').toLowerCase()
  if (!lower) return false
  const base = lower.replace(/\.[^.]+$/, '')
  if (!base || TOOL_NOISE.test(base) || TOOL_NOISE_SUFFIX.test(base)) return false
  return WIN_TOOL_EXT.has(lower.slice(lower.lastIndexOf('.')))
}

/**
 * 通用扫描：列出目录里像工具的可执行文件。
 * 不依赖 TOOL_CATALOG，因此用户放什么就显示什么。
 */
export function scanExecutableFiles(dir, options = {}) {
  const maxDepth = Math.min(Math.max(Number(options.maxDepth) || 4, 1), 6)
  const maxFiles = Math.min(Math.max(Number(options.maxFiles) || 4000, 100), 20000)
  const maxItems = Math.min(Math.max(Number(options.maxItems) || 400, 1), 2000)
  const root = resolve(String(dir || '').trim())
  if (!root || !existsSync(root)) return []
  let scanned = 0
  const picked = new Map()
  const walk = (base, depth) => {
    if (scanned >= maxFiles || depth > maxDepth || picked.size >= maxItems) return
    let entries
    try { entries = readdirSync(base, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (scanned >= maxFiles || picked.size >= maxItems) break
      const name = ent.name
      if (!name || name.startsWith('.') || name === 'node_modules' || name === '.git') continue
      const full = join(base, name)
      let isDir = false
      let isFile = false
      try {
        if (typeof ent.isDirectory === 'function') {
          isDir = ent.isDirectory()
          isFile = ent.isFile()
        } else {
          const s = statSync(full)
          isDir = s.isDirectory()
          isFile = s.isFile()
        }
      } catch { continue }
      if (isDir) {
        if (!TOOL_SKIP_DIR.test(name)) walk(full, depth + 1)
        continue
      }
      if (!isFile) continue
      scanned += 1
      if (!isToolFileName(name)) continue
      const key = toolKeyOf(name)
      if (!key) continue
      const prev = picked.get(key)
      if (prev && prev.depth <= depth) continue
      picked.set(key, { key, name: name.replace(/\.[^.]+$/, ''), file: name, path: full, depth })
    }
  }
  walk(root, 0)
  return Array.from(picked.values())
}

/**
 * 工具面板的实际清单：手动指定的路径 + 工具箱/附加目录里扫到的文件。
 * 不含内置目录里“应该装但没装”的项——没装的东西不占清单。
 */
export function buildToolInventory(options = {}) {
  const root = options.root || redteamRoot()
  const cfg = options.config || loadPlatformConfig(root)
  const map = new Map()
  /* 面板「移除这条」的工具：不再从配置、扫描目录或内置清单里列出来。 */
  const hidden = new Set((cfg.hiddenTools || []).map((x) => toolKeyOf(x)))
  const put = (priority, item) => {
    const key = toolKeyOf(item.name || item.id || item.path)
    if (!key || hidden.has(key)) return
    const prev = map.get(key)
    if (prev && prev.priority <= priority) return
    map.set(key, Object.assign({ key }, item, { priority }))
  }

  for (const [id, rawPath] of Object.entries(cfg.tools || {})) {
    const raw = String(rawPath || '').trim()
    if (!raw) continue
    const abs = isAbsolute(raw) ? raw : resolve(raw)
    let exists = false
    try { exists = statSync(abs).isFile() } catch { exists = false }
    put(0, {
      id,
      name: String(abs).replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, ''),
      label: id,
      path: exists ? abs : null,
      configuredPath: abs,
      source: 'config',
      exists,
    })
  }

  /* 目录扫描只收红队内置目录里的渗透工具；旁边混着的其他 exe 不进清单。
     手填路径（cfg.tools）与 catalog 不受这条限制。 */
  const knownTool = (name) => NAME_TO_IDS.has(String(name || '').toLowerCase())
  const toolkit = toolkitDirOf(cfg, root)
  for (const f of scanExecutableFiles(toolkit)) {
    if (!knownTool(f.name)) continue
    put(1, { name: f.name, path: f.path, source: 'toolkit', exists: true })
  }
  for (const dir of cfg.binDirs || []) {
    for (const f of scanExecutableFiles(dir)) {
      if (!knownTool(f.name)) continue
      put(2, { name: f.name, path: f.path, source: 'binDir', exists: true, binDir: dir })
    }
  }

  /* 内置常用工具：没装也列出来，带用途/命令/安装提示，放在 catalog 里，
     不混进 items（items 保持「磁盘上真实存在/配置过」的语义）。 */
  const catalog = []
  for (const def of TOOL_CATALOG) {
    const key = toolKeyOf(def.id)
    if (map.has(key) || hidden.has(key)) continue
    const guide = toolGuide(def.id, def.label)
    catalog.push({
      key: key,
      id: def.id,
      name: def.label,
      label: def.label,
      path: null,
      source: 'catalog',
      exists: false,
      tier: def.tier,
      system: false,
      purpose: guide.purpose,
      command: guide.command,
      install: guide.install,
      category: guide.category,
    })
  }

  /* 已移除的条目：面板单独列一栏，填一次有效路径就能恢复（不能直接消失到无入口）。 */
  const hiddenItems = Array.from(hidden).filter(Boolean).sort().map((key) => {
    const guide = toolGuide(key)
    return {
      key,
      id: key,
      name: key,
      label: key,
      path: null,
      source: 'hidden',
      hidden: true,
      exists: false,
      tier: toolTier(key),
      system: false,
      purpose: guide.purpose,
      command: guide.command,
      install: guide.install,
      category: guide.category,
    }
  })

  const items = Array.from(map.values()).map(({ priority, ...rest }) => {
    const key = toolKeyOf(rest.id || rest.name || '') || ''
    const guide = toolGuide(key)
    return Object.assign(rest, {
      tier: toolTier(rest.id || key || rest.name),
      system: isSystemCommand(rest.name),
      purpose: rest.purpose || guide.purpose,
      command: rest.command || guide.command,
      install: rest.install || guide.install,
      category: rest.category || guide.category,
    })
  })
  items.sort((a, b) => String(a.name).localeCompare(String(b.name)))
  const found = items.filter((t) => t.exists !== false && t.path)
  const missing = items.filter((t) => t.exists === false)
  return { items, catalog, hidden: hiddenItems, total: items.length, found: found.length, missing: missing.length }
}

/**
 * 在文件夹内递归扫工具名（限深度），返回 id → 绝对路径。
 */
export function scanFolderForTools(dir, options = {}) {
  const maxDepth = Math.min(Math.max(Number(options.maxDepth) || 4, 1), 6)
  const maxFiles = Math.min(Math.max(Number(options.maxFiles) || 8000, 100), 20000)
  const rawDir = String(dir || '').trim()
  if (!rawDir) return { ok: false, error: '先选择一个工具箱目录', assigned: {}, hits: [], scanned: 0 }
  const root = resolve(rawDir)
  const assigned = {}
  const hits = []
  if (!root || !existsSync(root)) {
    return { ok: false, error: '目录不存在：' + root, assigned, hits }
  }
  let st
  try { st = statSync(root) } catch {
    return { ok: false, error: '无法读取目录：' + root, assigned, hits }
  }
  if (!st.isDirectory()) {
    return { ok: false, error: '不是文件夹：' + root, assigned, hits }
  }

  let scanned = 0
  const ranks = {}
  const walk = (base, depth) => {
    if (scanned >= maxFiles || depth > maxDepth) return
    let entries
    try { entries = readdirSync(base, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (scanned >= maxFiles) break
      const name = ent.name
      if (!name || name === '.' || name === '..') continue
      if (name.startsWith('.') || name === 'node_modules' || name === '.git') continue
      const full = join(base, name)
      let isDir = false
      let isFile = false
      try {
        if (typeof ent.isDirectory === 'function') {
          isDir = ent.isDirectory()
          isFile = ent.isFile()
        } else {
          const s = statSync(full)
          isDir = s.isDirectory()
          isFile = s.isFile()
        }
      } catch { continue }
      if (isDir) {
        walk(full, depth + 1)
        continue
      }
      if (!isFile) continue
      scanned += 1
      const key = name.toLowerCase()
      const ids = NAME_TO_IDS.get(key)
      if (!ids) continue
      for (const id of ids) {
        const def = TOOL_CATALOG.find((t) => t.id === id)
        if (def && def.rejectPython && looksLikePythonCli(full)) continue
        const rank = def ? def.names.findIndex((n) => n.toLowerCase() === key) : 99
        const prevRank = ranks[id] === undefined ? 99 : ranks[id]
        if (assigned[id] && rank >= prevRank) continue
        ranks[id] = rank < 0 ? 99 : rank
        assigned[id] = full
        hits.push({ id, path: full, name })
      }
    }
  }
  walk(root, 0)

  /* nuclei-templates 目录顺带认一下 */
  let nucleiTemplatesDir = ''
  const tryNuclei = [
    join(root, 'nuclei-templates'),
    join(root, 'nuclei', 'templates'),
  ]
  for (const p of tryNuclei) {
    if (existsSync(p)) {
      try {
        if (statSync(p).isDirectory()) { nucleiTemplatesDir = p; break }
      } catch { /* ignore */ }
    }
  }

  return {
    ok: true,
    dir: root,
    scanned,
    assigned,
    hits,
    nucleiTemplatesDir,
    assignedCount: Object.keys(assigned).length,
  }
}

/**
 * 把整包工具文件夹写入 config：toolkitDir + 匹配到的 tools 路径。
 */
export function assignToolkitFolder(dir, root) {
  const scan = scanFolderForTools(dir)
  if (!scan.ok) return Object.assign({ ok: false }, scan)
  const prev = loadPlatformConfig(root)
  const tools = Object.assign({}, prev.tools || {})
  for (const [id, path] of Object.entries(scan.assigned)) {
    tools[id] = path
  }
  const binDirs = Array.isArray(prev.binDirs) ? prev.binDirs.slice() : []
  if (!binDirs.includes(scan.dir)) binDirs.unshift(scan.dir)
  const patch = {
    toolkitDir: scan.dir,
    binDirs,
    tools,
  }
  if (scan.nucleiTemplatesDir) patch.nucleiTemplatesDir = scan.nucleiTemplatesDir
  const cfg = savePlatformConfig(patch, root)
  const summary = platformSummary(root)
  return {
    ok: true,
    assigned: scan.assigned,
    assignedCount: scan.assignedCount,
    hits: scan.hits,
    scanned: scan.scanned,
    dir: scan.dir,
    nucleiTemplatesDir: scan.nucleiTemplatesDir || null,
    config: Object.assign({}, cfg, { env: Object.assign({}, cfg.env, { FOFA_KEY: '' }) }),
    tools: summary.tools,
  }
}

const EGRESS_PROBE_HOST = 'www.baidu.com'
const EGRESS_PROBE_PORT = 443
const EGRESS_PORTS = [7897, 7890, 7891, 1080, 10808, 8080, 8888]
let egressCache = { key: '', at: 0, value: null }

/**
 * 代理写法：`[user:pass@]host:port`，scheme 前缀可选。
 * 不写前缀 = 两种协议都试；写了就只认那一种（老写法兼容）。
 * socks4 / socks4a 一律归一成 SOCKS5：能说 4 的端口一定也能说 5。
 */
export function parseProxy(raw) {
  /* 中文输入法经常把冒号打成全角；先归一化，避免 host 里塞进“：”。 */
  const text = String(raw || '').trim().replace(/：/g, ':')
  if (!text) return null
  let scheme = ''
  let rest = text
  const m = /^(https?|socks4a?|socks5h?|socks):\/\//i.exec(text)
  if (m) {
    scheme = m[1].toLowerCase().replace(/h$/, '')
    if (scheme === 'https') scheme = 'http'
    if (scheme === 'socks4' || scheme === 'socks4a' || scheme === 'socks') scheme = 'socks5'
    rest = text.slice(m[0].length)
  } else if (text.includes('://')) {
    return null
  }
  rest = rest.replace(/\/.*$/, '')
  let auth
  const at = rest.lastIndexOf('@')
  if (at >= 0) {
    const credential = rest.slice(0, at)
    rest = rest.slice(at + 1)
    const sep = credential.indexOf(':')
    const user = sep >= 0 ? credential.slice(0, sep) : credential
    const pass = sep >= 0 ? credential.slice(sep + 1) : ''
    /* 只有密码没有用户名不是合法认证；不要静默降级成无认证。 */
    if (!user) return null
    const decode = (value) => { try { return decodeURIComponent(value) } catch { return value } }
    auth = { user: decode(user), pass: decode(pass) }
  }

  let host = ''
  let portText = ''
  if (rest.startsWith('[')) {
    const hit = /^\[([^\]]+)\]:(\d+)$/.exec(rest)
    if (!hit) return null
    host = hit[1]
    portText = hit[2]
  } else {
    /* 端口必须显式写；不再猜 8080/1080。 */
    const hit = /^([^:\s]+):(\d+)$/.exec(rest)
    if (!hit) return null
    host = hit[1]
    portText = hit[2]
  }
  if (!host || /[\s/\\]/.test(host)) return null
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { scheme, host, port, auth, raw: text }
}

/** 带认证的代理 URL：口令百分号编码，避免 `@` / `:` 把地址切断。 */
function proxyUrl(scheme, proxy) {
  const credential = proxy.auth
    ? encodeURIComponent(proxy.auth.user) + ':' + encodeURIComponent(proxy.auth.pass) + '@'
    : ''
  const host = String(proxy.host || '').includes(':') ? '[' + proxy.host + ']' : proxy.host
  return scheme + '://' + credential + host + ':' + proxy.port
}

/**
 * 面板里那个输入框 → 两个可直接进命令的 URL。
 * 系统提示与面板共用这一份，避免两处各自拼串拼法不一致。
 */
export function proxyTargets(raw) {
  const proxy = parseProxy(raw)
  if (!proxy) return null
  return {
    host: proxy.host,
    port: proxy.port,
    auth: proxy.auth ? 'user-pass' : 'none',
    pinned: proxy.scheme,
    http: proxyUrl('http', proxy),
    socks: proxyUrl('socks5h', proxy),
  }
}

export function probeHttpProxy(proxy, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const socket = tcpConnect({ host: proxy.host, port: proxy.port })
    let done = false
    let buf = Buffer.alloc(0)
    const finish = (ok, detail) => {
      if (done) return
      done = true
      try { socket.destroy() } catch { /* closed */ }
      resolve({ ok, detail })
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      const auth = proxy.auth
        ? 'Proxy-Authorization: Basic ' + Buffer.from(proxy.auth.user + ':' + proxy.auth.pass).toString('base64') + '\r\n'
        : ''
      socket.write(`CONNECT ${EGRESS_PROBE_HOST}:${EGRESS_PROBE_PORT} HTTP/1.1\r\nHost: ${EGRESS_PROBE_HOST}:${EGRESS_PROBE_PORT}\r\n${auth}Proxy-Connection: keep-alive\r\n\r\n`)
    })
    socket.on('data', (chunk) => {
      /* 状态行可能被 TCP 拆成多个包；等完整 \r\n 再判断。 */
      buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
      const end = buf.indexOf('\r\n')
      if (end < 0) return
      const line = buf.slice(0, end).toString('latin1')
      if (/^HTTP\/1\.[01] 407/.test(line)) finish(false, '407 需要代理认证')
      else finish(/^HTTP\/1\.[01] 200/.test(line), line)
    })
    socket.once('timeout', () => finish(false, 'timeout'))
    socket.once('error', (e) => finish(false, e.code || e.message))
  })
}

export function probeSocks5(proxy, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const socket = tcpConnect({ host: proxy.host, port: proxy.port })
    let done = false
    let stage = 0
    let buf = Buffer.alloc(0)
    const finish = (ok, detail) => {
      if (done) return
      done = true
      try { socket.destroy() } catch { /* closed */ }
      resolve({ ok, detail })
    }
    const take = (n) => {
      if (buf.length < n) return null
      const out = buf.slice(0, n)
      buf = buf.slice(n)
      return out
    }
    /** 认证过了（或本来不需要）再发 CONNECT，把域名交给代理解析。 */
    const sendConnect = () => {
      stage = 2
      const host = Buffer.from(EGRESS_PROBE_HOST)
      socket.write(Buffer.concat([
        Buffer.from([5, 1, 0, 3, host.length]),
        host,
        Buffer.from([EGRESS_PROBE_PORT >> 8, EGRESS_PROBE_PORT & 0xff]),
      ]))
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => socket.write(Buffer.from(proxy.auth ? [5, 2, 0, 2] : [5, 1, 0])))
    socket.on('data', (chunk) => {
      /* 握手包也可能被分片；按阶段凑够字节再判。 */
      buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
      if (stage === 0) {
        const head = take(2)
        if (!head) return
        if (head[0] !== 5) return finish(false, 'socks-greeting-failed')
        const method = head[1]
        if (method === 0) return sendConnect()
        if (method === 2) {
          if (!proxy.auth) return finish(false, 'socks-需要认证')
          const user = Buffer.from(proxy.auth.user)
          const pass = Buffer.from(proxy.auth.pass)
          stage = 1
          socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]))
          return
        }
        return finish(false, 'socks-method-rejected')
      }
      if (stage === 1) {
        const head = take(2)
        if (!head) return
        if (head[0] === 1 && head[1] === 0) return sendConnect()
        return finish(false, 'socks-auth-failed')
      }
      if (stage === 2) {
        const head = take(2)
        if (!head) return
        if (head[0] === 5 && head[1] === 0) finish(true, 'socks5-connect-ok')
        else finish(false, 'socks-connect-refused')
      }
    })
    socket.once('timeout', () => finish(false, 'timeout'))
    socket.once('error', (e) => finish(false, e.code || e.message))
  })
}

/**
 * 同一个 host:port 问两种协议：写了前缀只问那一种，没写就并行都问。
 * 至少一种通就返回可用的地址表；都不通返回 null。
 */
async function probeProxySchemes(proxy) {
  const want = proxy.scheme === 'socks5' ? ['socks5'] : proxy.scheme === 'http' ? ['http'] : ['http', 'socks5']
  const urlOf = (scheme) => proxyUrl(scheme === 'socks5' ? 'socks5h' : 'http', proxy)
  const results = {}
  await Promise.all(want.map(async (scheme) => {
    results[scheme] = scheme === 'http' ? await probeHttpProxy(proxy) : await probeSocks5(proxy)
  }))
  const usable = want.filter((scheme) => results[scheme] && results[scheme].ok)
  if (usable.length === 0) return null
  const primary = usable.includes('http') ? 'http' : 'socks5'
  return {
    mode: 'proxy',
    proxy: urlOf(primary),
    scheme: primary,
    schemes: Object.fromEntries(want.map((scheme) => [scheme, {
      ok: Boolean(results[scheme] && results[scheme].ok),
      url: urlOf(scheme),
      detail: (results[scheme] && results[scheme].detail) || '',
    }])),
    auth: proxy.auth ? 'user-pass' : 'none',
    reachable: true,
    detail: results[primary].detail,
  }
}


function probeDirect(timeoutMs = 1800) {
  return new Promise((resolve) => {
    const socket = tcpConnect({ host: EGRESS_PROBE_HOST, port: EGRESS_PROBE_PORT })
    let done = false
    const finish = (ok, detail) => {
      if (done) return
      done = true
      try { socket.destroy() } catch { /* closed */ }
      resolve({ ok, detail })
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true, 'tcp-connect-ok'))
    socket.once('timeout', () => finish(false, 'timeout'))
    socket.once('error', (e) => finish(false, e.code || e.message))
  })
}

/**
 * 出网事实：配置里的代理 → 环境变量 → 本机常见端口的真实握手 → 直连。
 * 只测「能不能出去」，不改任何系统代理；结果缓存 60 秒，失败即重探。
 */
export async function probeEgress(cfg = {}) {
  const configured = String(cfg?.egress?.proxy || '').trim()
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy || ''
  const key = JSON.stringify({ configured, envProxy })
  if (egressCache.key === key && Date.now() - egressCache.at < 60000) return egressCache.value

  const fixed = []
  if (configured) fixed.push({ raw: configured, source: 'config' })
  if (envProxy && envProxy !== configured) fixed.push({ raw: envProxy, source: 'env' })
  /* 面板里填的那条不通时要留下原因：否则会静默换成别的出口，看着像"填了没生效" */
  let configError
  for (const candidate of fixed) {
    const proxy = parseProxy(candidate.raw)
    if (!proxy) {
      if (candidate.source === 'config') configError = '地址写法认不出（要 IP:端口，可带 user:pass@）'
      continue
    }
    const hit = await probeProxySchemes(proxy)
    if (hit) {
      const value = Object.assign(hit, {
        source: candidate.source,
        checked_at: new Date().toISOString(),
        ...(candidate.source === 'config' || !configError ? {} : { configured_error: configError }),
      })
      egressCache = { key, at: Date.now(), value }
      return value
    }
    if (candidate.source === 'config') {
      configError = (proxy.scheme === 'http'
        ? 'HTTP CONNECT'
        : proxy.scheme === 'socks5' ? 'SOCKS5' : 'HTTP/SOCKS5') + ' 都没握手成功'
    }
  }

  const probes = []
  for (const port of EGRESS_PORTS) {
    probes.push(probeHttpProxy({ host: '127.0.0.1', port }).then((r) => (r.ok ? { scheme: 'http', port, detail: r.detail } : null)))
    probes.push(probeSocks5({ host: '127.0.0.1', port }).then((r) => (r.ok ? { scheme: 'socks5', port, detail: r.detail } : null)))
  }
  const hits = (await Promise.all(probes)).filter(Boolean)
  if (hits.length > 0) {
    const hit = hits[0]
    const value = {
      mode: 'proxy', proxy: `${hit.scheme === 'socks5' ? 'socks5h' : 'http'}://127.0.0.1:${hit.port}`, scheme: hit.scheme,
      source: 'probe', reachable: true, detail: hit.detail, checked_at: new Date().toISOString(),
      ...(configError ? { configured_error: configError } : {}),
    }
    egressCache = { key, at: Date.now(), value }
    return value
  }

  const direct = await probeDirect()
  const value = {
    mode: direct.ok ? 'direct' : 'none', proxy: '', scheme: '', source: 'direct',
    reachable: direct.ok, detail: direct.detail, checked_at: new Date().toISOString(),
    ...(configError ? { configured_error: configError } : {}),
  }
  egressCache = { key, at: Date.now(), value }
  return value
}

export default {
  TOOL_CATALOG,
  probeEgress,
  proxyTargets,
  configPathOf,
  redteamRoot,
  loadPlatformConfig,
  savePlatformConfig,
  resolveTool,
  resolveAllTools,
  platformSummary,
  buildToolInventory,
  scanExecutableFiles,
  mergeConfigEnv,
  envFilePath,
  parseEnvFile,
  readEnvFile,
  effectiveEnvOf,
  removeEnvFileKey,
  toolkitDirOf,
  nucleiTemplatesDirOf,
  scanFolderForTools,
  assignToolkitFolder,
}
