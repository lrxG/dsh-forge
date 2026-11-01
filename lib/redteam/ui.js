/**
 * RedTeam 控制台 —— Host 半侧
 *
 * 职责：为浏览器半侧提供一条 Package 私有的 HTTP 桥接 `POST /redteam/api`：
 *   · 资产库相关 op 转交 `ctx.redteam`（dsh-redteam-store 发布的进程级服务）；
 *   · 会话连通性 op（probeSessions）在 host 侧真实发起 TCP/HTTP 探测；
 *   · 技能目录 op（skillCatalog / skillRead）直接读 `ctx.skills`，按红队 preset
 *     的 standing scope 取目录——技能由 DSH 原生 skill 体系管理（$DSH_HOME/skills、
 *     项目 .dsh/skills、.agents/skills），控制台只做浏览。
 *
 * 为什么走 webServer 而不是 typert/@Remote：本包与 store 包都刻意保持零外部依赖
 * （profile 下解析不到 node_modules），具名路由是最小且稳定的接缝。
 * 跨源请求由 Origin/Host 校验挡住（同源 POST 才放行）。
 */
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { request as httpsRequest } from 'node:https'
import { checkUpdate } from '../update.js'
import { dispatch, dispatchAsync } from './store-core.js'
/* 技能可用性判定与 redteam_preflight 共用同一份实现（环境变量 / 本机路径 / 占位符） */
import { checkSkill, officialSkillSummaries, skillLibraryOf, summarizeSkills } from './skill-availability.js'
import { maxAgentsOf, maxAgentsSourceOf, saveMaxAgents, DEFAULT_MAX_AGENTS, MAX_AGENTS_LIMIT } from './settings.js'
import {
  effectiveEnvOf, loadPlatformConfig, readEnvFile, redteamRoot, removeEnvFileKey,
  platformSummary, savePlatformConfig, assignToolkitFolder, probeEgress,
} from './platform-config.js'
import { vpsTest, vpsApply, vpsClear, vpsSummary, vpsSetNative } from './vps.js'
import { oastSave, oastClear, oastSummary } from './oast.js'
import { hasSecret, loadSecret, saveSecret, deleteSecret } from './secrets.js'

/** DSH_HOME：显式环境变量优先；Windows 上 HOME 常空，回退 homedir()。 */
function dshHomeOf() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return join(homedir(), '.dsh')
}

/**
 * 本包自带技能目录候选。
 * 桌面端经 profile/node_modules 符号链接加载时，单靠 import.meta.url 拼相对路径
 * 可能指到不存在的位置（空格路径、未解析的 junction）；所以多路探测并 realpath。
 * 不从 index.js 引 packagePaths，避免与 cordis 插件入口互相拖拽。
 */
/** `$DSH_HOME` 的两个可能来源（插件进程 env 与宿主 dshHomePath 用的 home 会分叉）。 */
function dshHomeCandidates() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOME)
  push(join(homedir(), '.dsh'))
  return out
}

function resolvePluginSkillsDir() {
  const candidates = []
  try {
    const root = fileURLToPath(new URL('../..', import.meta.url))
    candidates.push(join(root, 'skills', 'redteam'))
  } catch { /* ignore */ }
  try {
    candidates.push(resolve(fileURLToPath(new URL('../../skills/redteam/', import.meta.url))))
  } catch { /* ignore */ }
  /* installBundledSkills 落盘位置：包内路径失效时仍能列出技能。两个候选 home 都探。 */
  for (const home of dshHomeCandidates()) {
    candidates.push(join(home, 'redteam', 'skills'))
    for (const profile of ['desktop', 'web', 'headless']) {
      candidates.push(join(home, 'profiles', profile, 'node_modules', 'dsh-forge', 'skills', 'redteam'))
    }
  }
  /* 不扫官方 $DSH_HOME/skills：技能只认本包 / 同步副本（与上游插件包内分发一致）。 */
  for (const raw of candidates) {
    if (!raw) continue
    try {
      if (!existsSync(raw)) continue
      const real = realpathSync(raw)
      const md = readdirSync(real).filter((f) => f.endsWith('.md'))
      if (md.length > 0 || /skills[/\\]redteam$/i.test(real) || /[/\\]skills$/i.test(real)) return real
    } catch { /* try next */ }
  }
  return null
}

const PLUGIN_SKILLS_DIR = resolvePluginSkillsDir()

function readOfficialSkill(name) {
  if (typeof name !== 'string' || name.length === 0) return { ok: false, error: 'name required' }
  const found = officialSkillSummaries().find((skill) => skill.name === name)
  if (!found) return { ok: false, error: 'skill not found: ' + name }
  return {
    ok: true,
    name: found.name,
    description: found.description,
    whenToUse: '',
    provider: 'dsh',
    source: 'official',
    path: found.path,
    content: found.content,
    library: 'official',
  }
}

function officialCatalogItems() {
  return officialSkillSummaries().map((skill) => ({
    name: skill.name,
    description: skill.description,
    whenToUse: '',
    provider: 'dsh',
    source: 'official',
    dir: skill.resourceBase && skill.resourceBase.path,
    path: skill.path,
    modelInvocable: true,
    userInvocable: true,
    fromPlugin: false,
    library: 'official',
    availability: 'listed',
    problems: [],
    needs_user: [],
  }))
}

function withBothLibraries(payload) {
  if (!payload || payload.ok === false || !Array.isArray(payload.items)) return payload
  const redteam = payload.items.map((item) => Object.assign({ library: 'redteam' }, item, {
    library: item.library === 'official' ? 'official' : 'redteam',
  }))
  const seen = new Set(redteam.filter((item) => item.library === 'official').map((item) => item.name))
  const official = officialCatalogItems().filter((item) => !seen.has(item.name))
  const items = redteam.concat(official)
  return Object.assign({}, payload, {
    items,
    total: items.length,
    libraries: {
      redteam: items.filter((item) => item.library !== 'official').length,
      official: items.filter((item) => item.library === 'official').length,
    },
  })
}
/** 目录比较要规范化：注册表给的是 `/a/b/skills`，URL 拼出来可能带结尾斜杠。 */
const sameDir = (a, b) => {
  if (a === null || b === null) return false
  try {
    const left = existsSync(a) ? realpathSync(a) : resolve(a)
    const right = existsSync(b) ? realpathSync(b) : resolve(b)
    return left === right
  } catch {
    try { return resolve(a) === resolve(b) } catch { return false }
  }
}

/** Cordis 插件名。 */
export const name = 'dsh-forge-redteam-ui'

/**
 * 硬依赖只留资产库 + HTTP。
 * skills / agentPresets 在桌面端时常序更晚或名称不同；写成硬依赖会导致整条
 * `/redteam/api` 挂不上，界面里技能库/知识库/SQLite 全部读不到。
 */
export const inject = ['redteam', 'webServer']

/** 请求体上限（资产导入可能较大）。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/* ------------------------------------------------------------------ 版本与更新 */

/**
 * 找 DSH 自带的 pnpm 入口（`<runtime>/dependencies/pnpm/bin/pnpm.mjs`）。
 *
 * 为什么必须找：桌面版把 pnpm 打进 `resources/runtime/primary-runtime` 里，
 * **从不写进 PATH**（它由 host 用 `process.execPath --expose-internals <pnpm.mjs>`
 * 直接拉起，见 dsh-desktop-host/lib/cli.js 的 packageManager）。于是面板里
 * `spawn('pnpm.cmd', ..., { shell: true })` 必然 `'pnpm.cmd' 不是内部或外部命令`，
 * code=-1 —— 「检查更新」被迫每次走 Gitee 兜底，「更新」按钮则**永远装不上**。
 *
 * 顺序：host argv 里的真实路径 → process.execPath 同级的 resources/runtime →
 * 用户级 runtime 缓存 → PATH 里的 pnpm/npm（用户自己装过的情况）。
 */
function embeddedPnpmEntry() {
  const candidates = []
  // ① host 进程 argv 里就有：… <runtimeDir> <pnpm.mjs> <binDir>
  for (const arg of process.argv || []) {
    const text = String(arg || '')
    if (/pnpm[\\/]bin[\\/]pnpm\.mjs$/i.test(text)) candidates.push(text)
  }
  // ② 与当前可执行文件同级：<install>/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs
  try {
    const exeDir = resolve(process.execPath, '..')
    candidates.push(join(exeDir, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'))
  } catch { /* 忽略：resolve 失败就走后面的候选 */ }
  // ③ 用户级 runtime 缓存（dsh 自更新后会落到 ~/.dsh/dsh-runtimes）
  try {
    candidates.push(join(dshHomeOf(), 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'))
  } catch { /* 同上 */ }
  for (const fp of candidates) {
    try { if (existsSync(fp)) return fp } catch { /* 单个候选不可读不影响其余 */ }
  }
  return ''
}

/**
 * 把 `pnpm` / `npm` 这类包管理器名解析成**可执行文件 + 前缀参数**。
 * @param name - 调用方写的包管理器名（pnpm / npm）。
 * @returns `{ command, prefix, shell }`；找不到自带 pnpm 时退回 PATH + .cmd + shell。
 */
function resolvePackageManager(name) {
  const isWin = process.platform === 'win32'
  if (/^pnpm$/i.test(name)) {
    const entry = embeddedPnpmEntry()
    if (entry) {
      /* 自带 pnpm 是 .mjs：必须由当前 Electron 以 node 模式跑。
         ELECTRON_RUN_AS_NODE 不能漏，否则 Electron 会把 pnpm.mjs 当 app 启动。 */
      return {
        command: process.execPath,
        prefix: ['--expose-internals', entry],
        shell: false,
        env: { ELECTRON_RUN_AS_NODE: '1' },
      }
    }
  }
  /* 退回 PATH：Windows 上 npm/npx/pnpm 都是 .cmd 批处理，不走 shell 解析不到 PATHEXT。 */
  const needsShim = isWin && /^(npm|npx|pnpm|pnpx|yarn)$/i.test(name)
  return { command: needsShim ? `${name}.cmd` : name, prefix: [], shell: needsShim, env: {} }
}

/** 运行 shell 命令，带超时；返回 `{ code, stdout, stderr, timedOut }`。 */
function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    let child
    try {
      /* ⚠️ 三个都踩过：
         · env 必须显式传 process.env —— spawn 默认给的是空环境，空 PATH 下
           npm/pnpm 会直接 `spawn npm ENOENT`（版本检查永远失败）；
         · cwd 必须是**真实存在**的目录 —— 传一个不存在的路径同样是 ENOENT
           （报错长得像"命令找不到"，很容易误判）；
         · Windows 上 npm/npx/pnpm/yarn 都是 .cmd 批处理，Node 的 spawn 不走
           shell 时直接找不到可执行文件 —— 必须 `shell: true`（或补 .cmd 后缀）
           才能解析 PATHEXT，不然红队面板「检测新版本」永远 code=-1。
         · 桌面版压根没有 PATH 里的 pnpm —— 见 resolvePackageManager()。 */
      const cwd = typeof options.cwd === 'string' && options.cwd !== '' && existsSync(options.cwd) ? options.cwd : undefined
      const isWin = process.platform === 'win32'
      const pm = resolvePackageManager(command)
      child = spawn(pm.command, pm.prefix.concat(args), {
        cwd,
        env: Object.assign({}, options.env || process.env, pm.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: pm.shell,
        windowsHide: isWin,
      })
    } catch (error) {
      resolvePromise({ code: -1, stdout: '', stderr: error && error.message ? error.message : String(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const CHILD_IO_CAP = 1 << 20 // 子进程 stdout/stderr 各 1MB 上限,防失控子进程 OOM 宿主
    const done = (value) => { if (!settled) { settled = true; resolvePromise(value) } }
    const cleanupPipes = () => {
      try { child.stdout.removeAllListeners(); child.stderr.removeAllListeners() } catch { /* ignore */ }
      try { child.stdout.destroy(); child.stderr.destroy() } catch { /* ignore */ }
    }
    // kill 子孙:child.kill 只杀直接子,孙子(npm → node → tool)活着。Windows 用 taskkill /T 杀树,
    // POSIX 兜底 SIGKILL + 尝试 process group kill。
    const killTree = () => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      try {
        if (process.platform === 'win32' && child.pid) {
          execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
            stdio: 'ignore', windowsHide: true, timeout: 2000,
          })
        } else if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL') } catch { /* 不是 group leader,忽略 */ }
        }
      } catch { /* taskkill 失败也无所谓,child.kill 已先触发 */ }
    }
    const timer = setTimeout(() => {
      killTree()
      cleanupPipes()
      done({ code: -1, stdout: stdout, stderr: stderr, timedOut: true })
    }, Math.max(Number(options.timeoutMs) || 30000, 1000))
    child.stdout.on('data', (c) => {
      if (settled) return
      if (stdout.length + c.length > CHILD_IO_CAP) {
        killTree()
        clearTimeout(timer); cleanupPipes()
        done({ code: -1, stdout, stderr, oversize: 'stdout' }); return
      }
      stdout += c.toString('utf8')
    })
    child.stderr.on('data', (c) => {
      if (settled) return
      if (stderr.length + c.length > CHILD_IO_CAP) {
        killTree()
        clearTimeout(timer); cleanupPipes()
        done({ code: -1, stdout, stderr, oversize: 'stderr' }); return
      }
      stderr += c.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer); cleanupPipes()
      done({ code: -1, stdout: stdout, stderr: String((error && error.message) || error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer); cleanupPipes()
      done({ code: code === null ? -1 : code, stdout: stdout, stderr: stderr })
    })
  })
}

/** 本插件包身份（由 store 壳读取 package.json 后挂上；读不到则报"未知版本"）。 */
function pluginIdentity(ctx) {
  const store = ctx.redteam
  const info = store && store.plugin ? store.plugin : null
  return {
    name: (info && info.name) || 'dsh-forge',
    version: (info && info.version) || null,
    description: (info && info.description) || '',
    homepage: (info && info.homepage) || null,
  }
}

/**
 * profile 目录：DSH 的 `ctx.baseUrl` 就是它（loader.internal.import(name, profileDir) 的 base）。
 * ⚠️ `ctx.baseUrl` 实际是 `file:///...` URL —— 直接当路径传给 join/existsSync 会把
 *    `node_modules` 拼到 URL 后面，`updatePreflight` 把 `devLinked` 永久判成 true，
 *    之后面板的「更新」按钮永远灰着。必须 fileURLToPath 转回系统路径。
 */
function profileDirOf(ctx) {
  try {
    const raw = ctx && typeof ctx.baseUrl === 'string' ? ctx.baseUrl : ''
    if (raw) return raw.startsWith('file://') ? fileURLToPath(raw) : raw
  } catch { /* 忽略：转换失败走兜底路径 */ }
  return join(dshHomeOf(), 'profiles', 'web')
}

/**
 * 环境适配 op：面板 EnvTab 读写 `$DSH_HOME/redteam/config.json`。
 * @returns JSON 结果，或 undefined 表示不是这个 op。
 */
/** FOFA 的“已配置”只认两个真实来源：能解开的加密存储或 $DSH_HOME/.env。 */
export async function fofaStatusOf(root) {
  if (hasSecret(root, 'fofa')) {
    try {
      if (String(await loadSecret(root, 'fofa')).trim() !== '') {
        return { configured: true, source: 'secret' }
      }
    } catch { /* 密文损坏/换机器解不开 → 继续看 .env */ }
  }
  const envFofa = String(readEnvFile().values.FOFA_KEY || '').trim()
  return envFofa !== ''
    ? { configured: true, source: 'env' }
    : { configured: false, source: '' }
}

async function configView(root) {
  const summary = platformSummary(root)
  if (summary.config && summary.config.env) summary.config.env.FOFA_KEY = ''
  return Object.assign(summary, {
    vps: vpsSummary(root),
    oast: oastSummary(root),
    fofa: await fofaStatusOf(root),
  })
}

async function handlePlatformOp(store, request) {
  const op = request && request.op
  if (op !== 'platformConfigGet' && op !== 'platformConfigSave' && op !== 'platformAssignToolkit'
    && op !== 'egressTest'
    && op !== 'vpsStatus' && op !== 'vpsTest' && op !== 'vpsApply' && op !== 'vpsClear' && op !== 'vpsNative'
    && op !== 'oastStatus' && op !== 'oastSave' && op !== 'oastClear'
    && op !== 'fofaClear') {
    return undefined
  }
  const root = (store && store.root) || redteamRoot()
  if (op === 'egressTest') {
    try {
      const probe = await probeEgress(loadPlatformConfig(root))
      return { ok: true, ...probe }
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) }
    }
  }
  if (op === 'vpsStatus') return Object.assign({ ok: true }, vpsSummary(root))
  if (op === 'vpsTest') return Object.assign({ ok: true }, await vpsTest(root, request))
  if (op === 'vpsApply') return Object.assign({ ok: true }, await vpsApply(root, request))
  if (op === 'vpsNative') return Object.assign({ ok: true }, await vpsSetNative(root, request.enabled === true))
  if (op === 'vpsClear') return await vpsClear(root)
  if (op === 'oastStatus') return Object.assign({ ok: true }, oastSummary(root))
  if (op === 'oastSave') return Object.assign({ ok: true }, await oastSave(root, request))
  if (op === 'oastClear') return oastClear(root)
  if (op === 'fofaClear') {
    deleteSecret(root, 'fofa')
    savePlatformConfig({ env: { FOFA_KEY: '' } }, root)
    removeEnvFileKey('FOFA_KEY')
    return configView(root)
  }
  if (op === 'platformConfigGet') {
    return configView(root)
  }
  if (op === 'platformConfigSave') {
    const cfg = request.config && typeof request.config === 'object' ? Object.assign({}, request.config) : {}
    const env = Object.assign({}, cfg.env && typeof cfg.env === 'object' ? cfg.env : {})
    const fofa = String(env.FOFA_KEY || '').trim()
    if (fofa) {
      await saveSecret(root, 'fofa', fofa)
      /* 面板保存的新 key 必须成为唯一生效值，否则 preflight 会继续读 .env 里的旧 key。 */
      removeEnvFileKey('FOFA_KEY')
    }
    delete env.FOFA_KEY
    cfg.env = env
    cfg.notes = ''
    savePlatformConfig(cfg, root)
    return configView(root)
  }
  return assignToolkitFolder(request.dir, root)
}

/** 读 profile 的 package.json（依赖声明 + dsh.profile.bundles）。 */
function readProfilePackage(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch { return null }
}

/** 包管理器：profile 里有 pnpm-lock / pnpm-workspace 就用 pnpm，否则 npm。 */
function packageManagerOf(dir) {
  if (existsSync(join(dir, 'pnpm-lock.yaml')) || existsSync(join(dir, 'pnpm-workspace.yaml'))) return 'pnpm'
  return 'npm'
}

/**
 * 更新前置检查：装的是不是发布版（profile 里能不能解析到这个包名）、
 * 有没有智能体正在跑（更新要重启 dsh web，会把它们打断）。
 */
async function updatePreflight(ctx) {
  const dir = profileDirOf(ctx)
  const pkg = pluginIdentity(ctx)
  const profilePkg = readProfilePackage(dir)
  const deps = (profilePkg && profilePkg.dependencies) || {}
  const declared = typeof deps[pkg.name] === 'string' ? deps[pkg.name] : null
  const installedDir = join(dir, 'node_modules', pkg.name)
  const blockers = []
  const notes = []

  /* ① 开发态（源码软链）：profile 里没有这个包名 → 不能用包管理器更新 */
  const devLinked = declared === null && !existsSync(join(installedDir, 'package.json'))
  if (devLinked) {
    blockers.push('当前是**开发态安装**（profile 依赖里没有 ' + pkg.name + '，是源码软链/手动挂载的），包管理器更新不适用。')
    notes.push('开发态请在本仓库升级：`git pull && npm run build:client`，再重启 DeepSeek Harness。')
  }

  /* ② 有智能体在跑：重启会打断它们 */
  let running = []
  try {
    const subagents = ctx.get('subagents')
    const sessions = ctx.get('sessions')
    if (subagents !== undefined && subagents !== null && sessions !== undefined && sessions !== null && typeof sessions.list === 'function') {
      const roots = sessions.list().filter((s) => {
        const header = s && s.header
        return header && (header.parentSession === undefined || header.parentSession === null)
      })
      for (const root of roots) {
        try {
          const kids = await subagents.listChildren(root.id)
          for (const k of Array.isArray(kids) ? kids : []) {
            if (k && k.kind === 'child' && k.activity === 'running') running.push({ session: String(root.id), label: k.label || String(k.id) })
          }
        } catch { /* 单个会话读不到不影响其它 */ }
      }
    }
  } catch { /* 注册表不可用就不挡（只是少了一层保护） */ }
  if (running.length > 0) {
    blockers.push('有 ' + running.length + ' 个智能体正在跑（' + running.map((r) => r.label).join('、') + '）：更新要重启当前宿主，会打断它们。请等它们结束。')
  }
  return { dir, declared, packageManager: packageManagerOf(dir), devLinked, running, blockers, notes }
}

/**
 * 从 package.json 的 homepage/repository 里扒 `owner/repo`；没有就返回默认仓库。
 *
 * 本仓为本地私有版本，不做在线更新。
 * `lib/update.js` 的 `REPO` 常量也是这一个。
 *
 * 这里原来叫 `githubRepoOf`，正则只匹配 github.com，兜底还硬编码了上游
 * 上游仓库。于是 redteam 面板的「检查更新」在 `npm view` 404
 * 之后跑去查**别人的 GitHub 仓库**——检查的是上游版本，与用户手里的这份
 * 代码无关，而且永远拿不到我们自己的版本号。
 */
function releaseRepoOf(homepage) {
  const m = String(homepage || '').match(/gitee\.com[/:]+([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:[/#?].*)?$/i)
  if (m) return `${m[1]}/${m[2]}`
  return ''
}

/**
 * 简陋 JSON 抓取（10 秒超时，最多跟随 3 次 30x）。
 *
 * 为什么现在必须跟随跳转：这段代码原来只打 `api.github.com`，注释写着
 * 「30xx 不自动跳转——api.github.com 不会跳」。换到 Gitee 之后这个前提不成立：
 * `gitee.com/<repo>/raw/HEAD/<file>` 会 302 到 CDN 域名，不跟随就只拿到一个
 * 没有 body 的 302，然后被误读成 JSON 解析失败。
 */
function fetchJson(url, hop = 0) {
  return new Promise((resolveP) => {
    try {
      const req = httpsRequest(url, {
        method: 'GET',
        headers: {
          'user-agent': 'dsh-forge-updater',
          accept: 'application/json, text/plain, */*',
        },
      }, (res) => {
        const status = Number(res.statusCode || 0)
        if (status >= 300 && status < 400 && res.headers.location && hop < 3) {
          res.resume()
          resolveP(fetchJson(new URL(res.headers.location, url).toString(), hop + 1))
          return
        }
        if (status !== 200) {
          res.resume()
          resolveP({ ok: false, error: `HTTP ${status}` })
          return
        }
        let body = ''
        const BODY_CAP = 1 << 20 // 1MB:github tags/releases JSON 一般几 KB~几十 KB,1MB 够用也足够防 OOM
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          if (body.length + chunk.length > BODY_CAP) {
            try { res.destroy(new Error('body too large')) } catch { /* 忽略 */ }
            resolveP({ ok: false, error: 'response body too large' })
            return
          }
          body += chunk
        })
        res.on('end', () => {
          try { resolveP({ ok: true, data: JSON.parse(body) }) }
          catch { resolveP({ ok: false, error: 'JSON parse error' }) }
        })
      })
      // req.setTimeout 要 socket 分配后才生效,DNS 查询阶段卡死不触发。外加 setTimeout 兜底。
      const extTimer = setTimeout(() => {
        try { req.destroy(new Error('timeout')) } catch { /* 忽略 */ }
        resolveP({ ok: false, error: 'timeout' })
      }, 12000)
      req.setTimeout(10000, () => { try { req.destroy(new Error('timeout')) } catch { /* 忽略 */ } })
      req.on('error', (e) => { clearTimeout(extTimer); resolveP({ ok: false, error: String(e && e.message || e) }) })
      req.on('close', () => clearTimeout(extTimer))
      req.end()
    } catch (e) {
      resolveP({ ok: false, error: String(e && e.message || e) })
    }
  })
}

/** 预发布版本名识别：`-beta`/`-rc`/`-pre` 之类不算 stable。 */
function isPrereleaseName(name) {
  return /[-._](?:alpha|beta|rc|pre|preview|dev|snapshot|test)(?:[-._\d]|$)/i.test(String(name || ''))
}

/**
 * Gitee 兜底：dsh-forge 不发到 npm，`npm view` 必定 404。
 *
 * 权威版本源是本仓的 Gitee 仓库。先读 `raw/HEAD/package.json` 的 `version`：
 * 它随每次提交更新、匿名可读、不需要 token（Gitee 的 contents / zipball API
 * 匿名访问会 401）。读不到 manifest 再退一步读 tags —— 有些发布只打 tag。
 */
async function checkLatestFromGitee(homepage) {
  const repo = releaseRepoOf(homepage)
  const manifest = await fetchJson(`https://gitee.com/${repo}/raw/HEAD/package.json`)
  if (manifest.ok && manifest.data && typeof manifest.data === 'object') {
    const ver = String(manifest.data.version || '').trim()
    if (/^\d+\.\d+\.\d+/.test(ver) && !isPrereleaseName(ver)) return { ok: true, latest: ver, registry: 'gitee' }
  }
  const tags = await fetchJson(`https://gitee.com/api/v5/repos/${repo}/tags?per_page=50`)
  if (!tags.ok || !Array.isArray(tags.data)) {
    return { ok: false, error: tags.error || manifest.error || 'Gitee 版本源不可用' }
  }
  let latest = null
  for (const row of tags.data) {
    const name = String(row && row.name || '').trim()
    if (!/^v?\d+\.\d+\.\d+/.test(name)) continue
    const ver = name.replace(/^v/, '')
    /* 预发布 tag（1.2.0-beta.1、2.0.0-rc1）如果 core 号比 stable 大，直接取它会把
       没正式发出去的版本当「最新」—— 复用 update.js 的 latestStableVersion 口径，
       跳过。 */
    if (isPrereleaseName(ver)) continue
    if (!latest || versionLess(latest, ver)) latest = ver
  }
  if (!latest) return { ok: false, error: 'Gitee 上没有可识别的稳定版本 tag' }
  return { ok: true, latest, registry: 'gitee' }
}

/**
 * 查最新版本。**先问 Gitee，失败才问包管理器。**
 *
 * 顺序为什么反了：`dsh-forge` 从来没发到 npmjs（上游 issue #93），所以
 * `pnpm view dsh-forge version` 必定 `ERR_PNPM_FETCH_404`。实测这一步在冷缓存下
 * 要 **55 秒**才返回 404（registry 元数据拉取 + 代理握手），而 Gitee 的
 * `raw/HEAD/package.json` 只要 **200ms**。
 *
 * 原来的顺序（先包管理器、超时 60s、再兜底 Gitee）意味着：用户点一下「检查更新」，
 * 面板要卡近一分钟才出结果；一旦包管理器那步超过浏览器 45s 超时，
 * 前端 `apiTimeoutMs` 直接 abort，界面就只剩「检测超时」——
 * 而版本源其实是通的。把 Gitee 提到前面，这条路永远走不到慢分支。
 */
async function checkLatest(ctx, dir, name) {
  /* 复用 /dsh-forge/update 的同一套源（GitHub / 渠道配置）。
     以前这里会回退到 `npm view dsh-forge`，而 npm 上的 dsh-forge 是别人的包
     （0.0.1），等于给出一个错误版本号；现在只认真实发布源。 */
  const up = await checkUpdate()
  if (up && up.remoteVersion) {
    return { ok: true, latest: String(up.remoteVersion), registry: up.source || 'update' }
  }
  return { ok: false, error: (up && up.error) || '没有可用的发布源（检查 维护 → 更新 的渠道配置）' }
}

/** `a < b`（只比较数字段，够用；预发布后缀按"更旧"处理）。 */
function versionLess(a, b) {
  const parse = (v) => String(v || '').split('-')[0].split('.').map((x) => Number(x) || 0)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] || 0) < (y[i] || 0)) return true
    if ((x[i] || 0) > (y[i] || 0)) return false
  }
  return false
}

/**
 * 重启脚本：等旧进程退出 + 端口释放，再按同样的参数把 dsh web 拉起来。
 *
 * 生成的是一个**自包含的 node 脚本**（不是 shell 脚本），它做三件事：
 *   ① 等旧 pid 退出（最多 60 秒）；
 *   ② 等端口不再被监听（最多 30 秒，用 net 探测，不依赖 ss/lsof）；
 *   ③ spawn(command, ARGS_ARRAY) 以 argv 数组拉起新进程。
 *
 * 为什么不用 shell：原实现把命令与参数拼成 shell 串，需要一套手写引号转义
 * （单引号里套单引号、双引号再转义），任何一处漏掉就是命令注入 ——
 * 而这段脚本正是"由程序生成、以用户身份执行"的，最不该有注入面。
 * argv 数组交给 spawn 之后 shell 完全不参与，转义问题从根上消失。
 *
 * @param pid - 当前进程 pid（等它退出）。
 * @param port - dsh web 端口（等它释放）。
 * @param command - 可执行文件（通常是 process.argv[0]）。
 * @param args - 参数数组（process.argv.slice(1)）。
 * @param logPath - 日志文件路径（追加写）。
 * @param cwd - 新进程的工作目录。
 * @returns 脚本正文。
 */
function restartScript(pid, port, command, args, logPath, cwd) {
  const payload = {
    oldPid: Number(pid),
    port: Number(port) || 0,
    command: String(command),
    args: args.map((a) => String(a)),
    log: String(logPath),
    cwd: String(cwd),
  }
  return [
    '#!/usr/bin/env node',
    '/* 由 RedTeam 控制台的「自动更新」生成：等旧 dsh web 退出后，按原 argv 把它重新拉起。',
    '   参数以数组形式传给 spawn —— shell 不参与，因此不存在引号转义与命令注入问题。 */',
    "'use strict'",
    'const { spawn } = require("node:child_process")',
    'const { appendFileSync, mkdirSync } = require("node:fs")',
    'const { connect } = require("node:net")',
    'const { dirname } = require("node:path")',
    'const CFG = ' + JSON.stringify(payload, null, 2),
    '',
    'const log = (msg) => {',
    '  const line = "[" + new Date().toISOString() + "] " + msg + "\\n"',
    '  try { mkdirSync(dirname(CFG.log), { recursive: true }); appendFileSync(CFG.log, line) } catch (e) { /* 日志写不进去不该影响重启 */ }',
    '}',
    '',
    'const sleep = (ms) => new Promise((r) => setTimeout(r, ms))',
    '',
    '/** 旧进程还在吗（kill -0 的等价物）。 */',
    'const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return false } }',
    '',
    '/** 端口还有人在听吗（不依赖 ss/lsof）。 */',
    'const portBusy = (port) => new Promise((resolve) => {',
    '  if (!port) { resolve(false); return }',
    '  const sock = connect({ host: "127.0.0.1", port: port })',
    '  let done = false',
    '  const finish = (busy) => { if (!done) { done = true; try { sock.destroy() } catch (e) {} resolve(busy) } }',
    '  sock.setTimeout(800)',
    '  sock.on("connect", () => finish(true))',
    '  sock.on("timeout", () => finish(false))',
    '  sock.on("error", () => finish(false))',
    '})',
    '',
    'async function main() {',
    '  log("等待旧进程 pid=" + CFG.oldPid + " 退出…")',
    '  for (let i = 0; i < 60; i += 1) {',
    '    if (!alive(CFG.oldPid)) break',
    '    await sleep(1000)',
    '  }',
    '  for (let i = 0; i < 30; i += 1) {',
    '    if (!(await portBusy(CFG.port))) break',
    '    await sleep(1000)',
    '  }',
    '  log("启动：" + CFG.command + " " + CFG.args.join(" "))',
    '  const child = spawn(CFG.command, CFG.args, {',
    '    cwd: CFG.cwd,',
    '    detached: true,',
    '    stdio: ["ignore", "ignore", "ignore"],',
    '    env: process.env,',
    '  })',
    '  child.unref()',
    '  log("已拉起新进程 pid=" + child.pid)',
    '}',
    '',
    'main().catch((error) => { log("重启失败：" + (error && error.message ? error.message : String(error))) })',
    '',
  ].join('\n')
}

/** 应用更新：装新版本 + 生成重启脚本 + 让当前进程退出。 */
async function applyUpdate(ctx, dir, name, targetVersion) {
  const pm = packageManagerOf(dir)
  const spec = targetVersion ? name + '@' + targetVersion : name
  const args = pm === 'pnpm' ? ['add', spec] : ['install', spec, '--save']
  const r = await run(pm, args, { cwd: dir, timeoutMs: 300000 })
  if (r.code !== 0) {
    return { ok: false, error: '安装失败（' + pm + ' ' + args.join(' ') + '）：' + String(r.stderr || r.stdout || '').trim().slice(0, 1200) }
  }
  /* 重启：拿当前进程的启动命令原样再来一遍 */
  const argv = process.argv.slice()
  const command = argv[0]
  const rest = argv.slice(1)
  const port = (() => {
    try { return String(ctx.webServer.port) } catch { return '3080' }
  })()
  const root = (() => {
    try { return ctx.redteam.root } catch { return join(process.env.DSH_HOME || '.', 'redteam') }
  })()
  mkdirSync(root, { recursive: true })
  const logPath = join(root, 'update.log')
  const scriptPath = join(root, 'restart-dsh-web.sh')
  writeFileSync(scriptPath, restartScript(process.pid, port, command, rest, logPath, process.cwd()), { encoding: 'utf8', mode: 0o755 })
  const child = spawn(process.execPath, [scriptPath], { detached: true, stdio: 'ignore' })
  child.unref()
  /* 给浏览器留出收到响应的窗口，然后退出 —— 新进程由脚本按原命令行拉起 */
  setTimeout(() => { process.exit(0) }, 1200).unref()
  return {
    ok: true, installed: spec, packageManager: pm,
    restart: { script: scriptPath, log: logPath, port, command: [command].concat(rest).join(' '), pid: process.pid },
  }
}


/** 读取完整请求体；超过上限即中断。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg) } }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        // destroy 带 Error → socket 立即 RST,client 不会继续发,端对端收尾。
        const err = new Error('request body too large')
        done(reject, err)
        try { req.destroy(err) } catch { /* 忽略 */ }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done(resolve, Buffer.concat(chunks).toString('utf8')))
    req.on('error', (err) => done(reject, err))
  })
}

/** 统一的 JSON 响应。 */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 技能可用性缓存：`{ at, scope, byName: Map }`；30 秒内复用。 */
let skillAvailabilityCache = null
const SKILL_AVAILABILITY_TTL_MS = 30000

/**
 * 安全取 Cordis 服务：未 inject 时 ctx.get / 点属性都会抛，不能让它冒泡成 400。
 */
function softService(ctx, name) {
  if (!ctx) return undefined
  try {
    if (typeof ctx.get === 'function') return ctx.get(name)
  } catch { /* not injected */ }
  try {
    return ctx[name]
  } catch { /* proxy throw */ }
  return undefined
}

/**
 * 逐个技能的可用性（读正文 → 共享判定模块）。
 * @param skillsSvc - 已取得的 skills 服务（可为 null）。
 * @param list - `skills.list()` 的返回（SkillSummary[]）。
 * @param scope - 当前作用域。
 * @param force - true 时跳过快取缓存。
 */
async function skillAvailabilityOf(skillsSvc, list, scope, force) {
  const now = Date.now()
  // scope 签名加入 cache key:切预设时 scope 变,老 cache 可能对应错误的技能可用性快照。
  const scopeSig = scope == null ? '' : String(scope)
  if (!force && skillAvailabilityCache !== null
    && now - skillAvailabilityCache.at < SKILL_AVAILABILITY_TTL_MS
    && skillAvailabilityCache.size === list.length
    && skillAvailabilityCache.scope === scopeSig) {
    return { at: skillAvailabilityCache.at, cached: true, byName: skillAvailabilityCache.byName }
  }
  const rootsWith = new Map()
  for (const x of list) {
    const dir = x.resourceBase && x.resourceBase.kind === 'directory' ? x.resourceBase.path : null
    if (dir === null) continue
    if (!rootsWith.has(x.name)) rootsWith.set(x.name, [])
    if (!rootsWith.get(x.name).includes(dir)) rootsWith.get(x.name).push(dir)
  }
  const byName = new Map()
  for (const summary of list) {
    let def
    try {
      def = skillsSvc && typeof skillsSvc.get === 'function'
        ? await skillsSvc.get(summary.name, { scope })
        : undefined
    } catch { def = undefined }
    const path = def && typeof def.path === 'string'
      ? def.path
      : (summary.resourceBase && summary.resourceBase.kind === 'directory' ? summary.resourceBase.path : null)
    const root = summary.resourceBase && summary.resourceBase.kind === 'directory' ? summary.resourceBase.path : null
    const verdict = checkSkill({ name: summary.name, content: def && def.content, path, root },
      { env: effectiveEnvOf(redteamRoot()), sameNameIn: rootsWith.get(summary.name) || [] })
    byName.set(summary.name, verdict)
  }
  skillAvailabilityCache = { at: now, scope: scope == null ? '' : String(scope), size: list.length, byName }
  return { at: now, cached: false, byName }
}

/**
 * 技能目录：桌面端默认读本包 `skills/redteam/*.md`；
 * 仅当 skills + agentPresets 都可用时才走原生注册表。
 */
async function handleSkillOp(ctx, request) {
  if (request.op !== 'skillCatalog' && request.op !== 'skillRead') return undefined

  /* 桌面端绝不能让 "without inject" 冒泡：一律 softService + 文件兜底。 */
  const skillsSvc = softService(ctx, 'skills')
  const presetsSvc = softService(ctx, 'agentPresets')

  let scope = null
  let registryReady = false
  if (skillsSvc && typeof skillsSvc.list === 'function' && presetsSvc) {
    const standing = presetsSvc.standingKeyFor
    if (typeof standing === 'function') {
      try {
        scope = await standing.call(presetsSvc, 'redteam')
        registryReady = scope != null
      } catch {
        registryReady = false
      }
    }
  }

  if (!registryReady) {
    return withBothLibraries(handleSkillOpFromPluginDir(request))
  }

  if (request.op === 'skillCatalog') {
    let list = []
    try {
      list = await skillsSvc.list({ scope })
    } catch {
      list = []
    }
    if (!Array.isArray(list) || list.length === 0) {
      return withBothLibraries(handleSkillOpFromPluginDir(request))
    }
    const redteamList = list.filter((s) => skillLibraryOf(s) !== 'official')
    const availability = await skillAvailabilityOf(skillsSvc, redteamList, scope, request.refresh === true)
    const pluginDir = resolvePluginSkillsDir()
    const bySource = new Map()
    const byDir = new Map()
    const items = list.map((s) => {
      const dir = s.resourceBase && s.resourceBase.kind === 'directory' ? s.resourceBase.path : null
      const name = dir === null ? '(非文件系统来源)' : dir
      byDir.set(name, (byDir.get(name) || 0) + 1)
      bySource.set(s.source, (bySource.get(s.source) || 0) + 1)
      const library = skillLibraryOf(s) === 'official' ? 'official' : 'redteam'
      const avail = availability.byName.get(s.name)
      return {
        name: s.name,
        description: s.description,
        whenToUse: s.whenToUse || '',
        provider: s.provider,
        source: s.source,
        dir: dir,
        modelInvocable: s.invocation ? s.invocation.modelInvocable !== false : true,
        userInvocable: s.invocation ? s.invocation.userInvocable !== false : true,
        fromPlugin: sameDir(dir, pluginDir),
        library,
        availability: library === 'official' ? 'listed' : (avail ? avail.status : 'unknown'),
        problems: library === 'official' ? [] : (avail ? avail.problems : ['未检查']),
        needs_user: library === 'official' ? [] : (avail ? avail.needs_user : []),
      }
    })
    const availSummary = summarizeSkills(Array.from(availability.byName.values()))
    return withBothLibraries({
      ok: true,
      total: items.length,
      fromPlugin: items.filter((x) => x.fromPlugin).length,
      availability: {
        summary: availSummary,
        checked_at: availability.at,
        cached: availability.cached,
        broken: Array.from(availability.byName.values()).filter((x) => x.status === 'broken')
          .map((x) => ({ name: x.name, problems: x.problems, needs_user: x.needs_user })),
        note: '可用性 = 技能文件存在且正文能加载。缺工具、缺密钥、VPS 占位符记在缺口里，不把整条技能标成不可用。',
      },
      bySource: Array.from(bySource, ([k, n]) => ({ key: k, n })).sort((a, b) => b.n - a.n),
      byDir: Array.from(byDir, ([k, n]) => ({ key: k, n })).sort((a, b) => b.n - a.n),
      note: '红队技能和官方技能分开。红队技能才做工具路径检查；官方技能在 $DSH_HOME/skills，由宿主按任务调用。',
      items,
    })
  }
  if (request.library === 'official') return readOfficialSkill(request.name)
  if (typeof request.name !== 'string' || request.name.length === 0) {
    return { ok: false, error: 'name required' }
  }
  try {
    const skill = await skillsSvc.get(request.name, { scope })
    if (skill !== undefined) {
      return {
        ok: true,
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse || '',
        provider: skill.provider,
        source: skill.source,
        path: skill.path || null,
        content: skill.content || '',
      }
    }
  } catch { /* fall through */ }
  return handleSkillOpFromPluginDir(request)
}

/** 从本包 skills/redteam 目录拼一份技能目录，并做真实可用性检查（不依赖宿主 skills 注入）。 */
function handleSkillOpFromPluginDir(request) {
  const dir = resolvePluginSkillsDir() || PLUGIN_SKILLS_DIR
  if (!dir || !existsSync(dir)) {
    return { ok: false, error: '本包 skills/redteam 目录不存在，且宿主 skills 服务不可用' }
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'))
  const parseMeta = (text) => {
    const out = { description: '', whenToUse: '' }
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    if (!m) {
      const first = String(text || '').split(/\r?\n/).find((l) => l.trim()) || ''
      out.description = first.replace(/^#\s*/, '').trim()
      return out
    }
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^(\w+)\s*:\s*(.*)$/.exec(line)
      if (!kv) continue
      if (kv[1] === 'description') out.description = kv[2].trim().replace(/^['"]|['"]$/g, '')
      if (kv[1] === 'when_to_use' || kv[1] === 'whenToUse') out.whenToUse = kv[2].trim().replace(/^['"]|['"]$/g, '')
    }
    return out
  }
  /* 环境变量：进程 + 平台 config.json + $DSH_HOME/.env（空字段不覆盖） */
  const cfg = loadPlatformConfig(redteamRoot())
  const checkEnv = effectiveEnvOf(redteamRoot(), cfg)

  if (request.op === 'skillCatalog') {
    const byName = new Map()
    const items = files.map((file) => {
      const name = file.replace(/\.md$/i, '')
      const path = join(dir, file)
      let description = ''
      let whenToUse = ''
      let content = ''
      try {
        content = readFileSync(path, 'utf8')
        const meta = parseMeta(content)
        description = meta.description
        whenToUse = meta.whenToUse
      } catch { /* ignore */ }
      const verdict = checkSkill(
        { name, content, path, root: dir },
        { env: checkEnv },
      )
      byName.set(name, verdict)
      return {
        name,
        description,
        whenToUse,
        provider: 'dsh-forge',
        source: 'plugin',
        dir,
        modelInvocable: true,
        userInvocable: true,
        fromPlugin: true,
        library: 'redteam',
        availability: verdict.status,
        problems: verdict.problems,
        needs_user: verdict.needs_user,
      }
    }).sort((a, b) => a.name.localeCompare(b.name))
    const availSummary = summarizeSkills(Array.from(byName.values()))
    return withBothLibraries({
      ok: true,
      total: items.length,
      fromPlugin: items.length,
      availability: {
        summary: availSummary,
        checked_at: Date.now(),
        cached: false,
        broken: Array.from(byName.values()).filter((x) => x.status === 'broken')
          .map((x) => ({ name: x.name, problems: x.problems, needs_user: x.needs_user })),
        note: '按本包技能文件自检（含环境适配 config.json）。工具路径、密钥和 VPS 占位符只记在缺口里，不把整条技能标成不可用。',
      },
      bySource: [{ key: 'plugin', n: items.length }],
      byDir: [{ key: dir, n: items.length }],
      note: '本包 skills/redteam 共 ' + items.length + ' 个技能；可用性已按正文与本机配置检查。',
      items,
    })
  }
  if (request.library === 'official') return readOfficialSkill(request.name)
  if (typeof request.name !== 'string' || request.name.length === 0) {
    return { ok: false, error: 'name required' }
  }
  const file = join(dir, request.name.endsWith('.md') ? request.name : (request.name + '.md'))
  if (!existsSync(file)) return { ok: false, error: 'skill not found: ' + request.name }
  let content = ''
  try { content = readFileSync(file, 'utf8') } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) }
  }
  const meta = parseMeta(content)
  return {
    ok: true,
    name: request.name.replace(/\.md$/i, ''),
    description: meta.description,
    whenToUse: meta.whenToUse,
    provider: 'dsh-forge',
    source: 'plugin',
    path: file,
    content,
  }
}

/**
 * 智能体并发状态（「智能体」页签用）：直接读 subagents 注册表里"真正在跑"的子会话。
 * 与工具层的 `redteam_agent_slot` 同一套口径，但这里只读不占位。
 * @param ctx - 插件上下文。
 * @param request - `{ op: 'agentsStatus' }`。
 * @returns JSON 结果，或 undefined 表示不是这个 op。
 */
async function handleAgentsOp(ctx, request) {
  if (request.op !== 'agentsStatus' && request.op !== 'setAgentsMax') return undefined
  const root = (() => { try { return ctx.redteam.root } catch { return undefined } })()
  if (request.op === 'setAgentsMax') {
    const next = saveMaxAgents(root, request.max)
    return {
      ok: true, max: next, source: 'settings', limit: MAX_AGENTS_LIMIT,
      note: '已保存为 ' + next + ' 个并发执行智能体，立即生效：智能体下次 redteam_agent_slot acquire 时按新值放行（插件不拦截宿主直接派活）。',
    }
  }
  const max = maxAgentsOf(root, process.env)
  const subagents = softService(ctx, 'subagents')
  const sessions = softService(ctx, 'sessions')
  if (subagents === undefined || subagents === null || sessions === undefined || sessions === null || typeof sessions.list !== 'function') {
    return { ok: false, error: 'subagents / sessions 注册表不可用：读不到并发占用。', max }
  }
  const children = []
  const runningByParent = new Map()
  try {
    const roots = sessions.list().filter((s) => {
      const header = s && s.header
      return header && (header.parentSession === undefined || header.parentSession === null)
    })
    for (const root of roots) {
      try {
        const kids = await subagents.listChildren(root.id)
        let n = 0
        for (const k of Array.isArray(kids) ? kids : []) {
          if (k && k.kind === 'child') {
            children.push({ parent: String(root.id), label: k.label || String(k.id), activity: k.activity, mode: k.mode })
            if (k.activity === 'running') n += 1
          }
        }
        if (n > 0) runningByParent.set(String(root.id), n)
      } catch { /* 单个会话读不到就跳过 */ }
    }
  } catch (error) {
    return { ok: false, error: '列子会话失败：' + (error && error.message ? error.message : String(error)), max }
  }
  const running = children.filter((c) => c.activity === 'running')
  /* 上限是"同一会话（靶标）同时最多 N 个"：面板要跟工具同口径，
     取各根会话里最大的占用，而不是把所有会话的子智能体加总。 */
  const used = runningByParent.size > 0 ? Math.max(...runningByParent.values()) : 0
  return {
    ok: true, max, used, free: Math.max(max - used, 0),
    running: running.slice(0, 20), total_children: children.length,
    per_session: Array.from(runningByParent, ([session, n]) => ({ session, used: n })),
    source: maxAgentsSourceOf(root, process.env),
    limit: MAX_AGENTS_LIMIT,
    default_max: DEFAULT_MAX_AGENTS,
    note: '同一会话（靶标）同时最多 ' + max + ' 个执行智能体；默认顺序派活。'
      + ' 上限由智能体在派活前调用 redteam_agent_slot 占位来遵守，插件不拦截宿主的直接派活。',
  }
}

/**
 * 取官方权限预设服务。
 * 桌面端服务装载时机会晚于本插件，所以不做硬 inject，运行时软取。
 * @returns 服务对象，或 null。
 */
function permissionPresetsOf(ctx) {
  try {
    if (ctx.permissionPresets && typeof ctx.permissionPresets.apply === 'function') return ctx.permissionPresets
  } catch { /* without inject */ }
  try {
    const svc = ctx.get('permissionPresets')
    if (svc && typeof svc.apply === 'function') return svc
  } catch { /* missing */ }
  return null
}

/** 当前活着的会话；读不到就当空。 */
function liveSessionsOf(ctx) {
  try {
    const sessions = ctx.get('sessions')
    if (sessions && typeof sessions.list === 'function') {
      const list = sessions.list()
      return Array.isArray(list) ? list : []
    }
  } catch { /* missing */ }
  return []
}

/**
 * 权限档位（面板「环境」页）：读写的就是官方 @deepseek-ai/dsh-permission-presets。
 *
 * 面板不存第二份状态：
 *   · 读 —— catalog() 给可选项，current() 给当前会话实际生效值；
 *   · 写 —— set()/apply() 落当前会话，settings.update('permission') 落未来会话。
 *
 * 三档的 approval 都是 never，所以正常不会走到审批回调，也不会弹确认框。
 * @param ctx - 插件上下文。
 * @param request - `{ op: 'permissionCatalog' }` 或 `{ op: 'permissionSet', preset }`。
 * @returns JSON 结果，或 undefined 表示不是权限类 op。
 */
async function handlePermissionOp(ctx, request) {
  const op = request && request.op
  if (op !== 'permissionCatalog' && op !== 'permissionSet') return undefined
  const service = permissionPresetsOf(ctx)
  if (!service) {
    return {
      ok: false,
      unavailable: true,
      error: '宿主未提供权限预设能力：权限档位无法读取或修改。',
    }
  }
  const sessions = liveSessionsOf(ctx)

  if (op === 'permissionCatalog') {
    let catalog = {}
    try { catalog = service.catalog() || {} } catch { catalog = {} }
    let options = Array.isArray(catalog.options) ? catalog.options : []
    /* 只列可主动选中的档位；custom / auto 是推导态，选了也留不住。 */
    const configured = new Set()
    try { for (const name of service.names || []) configured.add(name) } catch { /* ignore */ }
    if (configured.size > 0) {
      options = options.filter((o) => o && configured.has(o.value) && o.value !== 'auto')
    }
    let current = null
    const last = sessions.length > 0 ? sessions[sessions.length - 1] : null
    if (last) {
      try { current = service.current(last) } catch { current = null }
    }
    return {
      ok: true,
      options,
      defaultPreset: catalog.defaultPreset || null,
      current,
      sessions: sessions.length,
    }
  }

  const name = typeof request.preset === 'string' ? request.preset.trim() : ''
  let names = []
  try { names = Array.isArray(service.names) ? service.names.slice() : [] } catch { names = [] }
  if (!name || !names.includes(name)) {
    return {
      ok: false,
      error: '未知档位「' + (name || '空') + '」，可选：' + (names.join(' / ') || '无'),
    }
  }

  const failed = []
  let changed = 0
  for (const session of sessions) {
    try {
      /* set() 用 session 级 setApprovalPolicy，不依赖 agent；旧版本没有就退到 apply()。 */
      if (typeof service.set === 'function') service.set(session, name)
      else service.apply(session, name, () => {})
      changed += 1
    } catch (error) {
      failed.push(error && error.message ? error.message : String(error))
    }
  }

  /* 未来会话跟随：写官方 permission 命名空间的 defaultPreset，面板不另存一份。 */
  let defaultSaved = false
  let defaultError = ''
  try {
    const settings = ctx.get('settings')
    if (settings && typeof settings.update === 'function') {
      await settings.update('permission', { defaultPreset: name })
      defaultSaved = true
    } else {
      defaultError = 'settings 服务不可用，新会话会回到配置默认档'
    }
  } catch (error) {
    defaultError = '新会话默认档没写进去：' + (error && error.message ? error.message : String(error))
  }

  const allFailed = sessions.length > 0 && changed === 0
  return {
    ok: !allFailed,
    error: allFailed ? (failed[0] || '当前会话切换失败') : undefined,
    preset: name,
    sessions: changed,
    failed,
    defaultSaved,
    defaultError,
  }
}

/**
 * 版本与更新类 op（面板右上角的「版本 + 自动更新」用）。
 * 不碰资产库，直接操作 profile 与 npm/pnpm；全部在 host 侧执行。
 * @param ctx - 插件上下文。
 * @param request - `{ op: 'version' | 'updateCheck' | 'updateApply', target? }`。
 * @returns JSON 结果，或 undefined 表示不是更新类 op。
 */
async function handleUpdateOp(ctx, request) {
  if (!['version', 'updateCheck', 'updateApply'].includes(request.op)) return undefined
  const pkg = pluginIdentity(ctx)
  const pre = await updatePreflight(ctx)
  if (request.op === 'version') {
    const check = pre.devLinked ? null : await checkLatest(ctx, pre.dir, pkg.name)
    return {
      ok: true,
      plugin: pkg,
      install: {
        mode: pre.devLinked ? 'dev' : 'package',
        dir: pre.dir,
        declared: pre.declared,
        packageManager: pre.packageManager,
      },
      latest: check && check.ok ? check.latest : null,
      updateAvailable: check && check.ok && pkg.version ? versionLess(pkg.version, check.latest) : false,
      /* 本地版本比 registry 还新：本机跑的是尚未发布的开发版本。
         不区分这一种，"检查更新"会一直显示"已是最新"，把"这个版本根本没发出去"藏起来。 */
      localAhead: check && check.ok && pkg.version ? versionLess(check.latest, pkg.version) : false,
      check_error: check && check.ok === false ? check.error : undefined,
      blockers: pre.blockers,
      notes: pre.notes,
      running_agents: pre.running,
    }
  }
  if (request.op === 'updateCheck') {
    const check = await checkLatest(ctx, pre.dir, pkg.name)
    if (check.ok !== true) return { ok: false, error: check.error, current: pkg.version, install: { mode: pre.devLinked ? 'dev' : 'package' } }
    const localAhead = pkg.version ? versionLess(check.latest, pkg.version) : false
    return {
      ok: true, current: pkg.version, latest: check.latest,
      updateAvailable: pkg.version ? versionLess(pkg.version, check.latest) : true,
      localAhead,
      install: { mode: pre.devLinked ? 'dev' : 'package', dir: pre.dir, packageManager: pre.packageManager },
      blockers: pre.blockers,
      notes: pre.notes.concat(localAhead
        ? ['本机版本（' + pkg.version + '）比 npm 上的最新版（' + check.latest + '）还新：'
           + '当前跑的是尚未发布的开发版本，包管理器更新不适用（要回退版本请显式指定）。']
        : []),
      running_agents: pre.running,
    }
  }
  /* updateApply */
  if (pre.blockers.length > 0) {
    return { ok: false, error: '现在不能更新：' + pre.blockers.join(' '), blockers: pre.blockers, notes: pre.notes }
  }
  /* target 会被原样拼进 `npm install <target>`：不校验就等于把"装任意包并重启进程"
     暴露给浏览器侧输入。只接受纯 semver（可带 v 前缀），其余一律拒绝并说清原因。 */
  const rawTarget = typeof request.target === 'string' ? request.target.trim() : ''
  if (rawTarget !== '' && !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(rawTarget)) {
    return {
      ok: false,
      current: pkg.version,
      error: 'updateApply 的 target 必须是纯版本号（如 0.11.0），收到 ' + JSON.stringify(rawTarget)
        + '。不接受包名、路径、URL 或 npm 参数 —— 它会原样传给包管理器，等于允许远程指定安装内容。',
    }
  }
  const result = await applyUpdate(ctx, pre.dir, pkg.name, rawTarget || null)
  if (result.ok !== true) return Object.assign({ current: pkg.version }, result)
  return Object.assign({ current: pkg.version, latest: request.target || null }, result, {
    note: '已安装，正在重启当前宿主（页面会在几秒内断开，重启完成后刷新即可看到新版本）。重启日志：' + result.restart.log,
  })
}

/**
 * @param ctx - 插件上下文（已保证 redteam / webServer / skills / agentPresets 可用）。
 */
export function apply(ctx) {
  const store = ctx.redteam

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/redteam/api',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' })
        return
      }
      /* 来源校验：本机回环一律放行（官方桌面端 Origin 常是 app:// / file://，
         旧逻辑会把 Origin.host 判空后直接 403，导致技能库/知识库/SQL 全挂）。
         非回环才要求 Origin 与 Host 同源。 */
      const remote = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : ''
      const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
      const host = typeof req.headers.host === 'string' ? req.headers.host : ''
      const hostLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)
      const origin = req.headers.origin
      const originOk = (() => {
        if (loopback) return true
        /* 官方桌面端：Origin 常为 app:// / null，Host 仍是 127.0.0.1:port */
        if (hostLocal) {
          if (origin === undefined || origin === '' || origin === 'null') return true
          if (typeof origin === 'string' && /^app:/i.test(origin)) return true
          try {
            const oh = new URL(origin).host
            if (oh === host || oh === '' ) return true
          } catch { /* fall through */ }
        }
        if (typeof origin !== 'string' || origin === '') return false
        let originHost = null
        try { originHost = new URL(origin).host } catch { originHost = null }
        return originHost !== null && originHost === host
      })()
      if (!originOk) {
        sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
        return
      }
      /* 再要求一个本包私有的自定义请求头。
         跨源「简单请求」带不了自定义头，带了就得先过预检，而这里不应答预检；
         所以 sandboxed iframe / data: 页面（Origin: null）没法借本机反代打进来。
         同源页面的 fetch 可以随意设置自定义头，控制台不受影响。 */
      if (String(req.headers['x-dsh-forge-bridge'] || '') !== '1') {
        sendJson(res, 403, { ok: false, error: 'missing bridge header' })
        return
      }
      try {
        const raw = await readBody(req)
        const request = raw.trim() ? JSON.parse(raw) : {}
        const platformResult = await handlePlatformOp(store, request)
        if (platformResult !== undefined) {
          sendJson(res, 200, platformResult)
          return
        }
        const agentsResult = await handleAgentsOp(ctx, request)
        if (agentsResult !== undefined) {
          sendJson(res, 200, agentsResult)
          return
        }
        const updateResult = await handleUpdateOp(ctx, request)
        if (updateResult !== undefined) {
          sendJson(res, 200, updateResult)
          return
        }
        const permissionResult = await handlePermissionOp(ctx, request)
        if (permissionResult !== undefined) {
          sendJson(res, 200, permissionResult)
          return
        }
        let skillResult
        try {
          skillResult = await handleSkillOp(ctx, request)
        } catch (skillErr) {
          /* 桌面端 inject 缺失时绝不 400：直接文件兜底 */
          if (request && (request.op === 'skillCatalog' || request.op === 'skillRead')) {
            skillResult = handleSkillOpFromPluginDir(request)
            if (!skillResult || skillResult.ok === false) {
              skillResult = {
                ok: false,
                error: '技能读取失败：' + (skillErr && skillErr.message ? skillErr.message : String(skillErr)),
              }
            }
          } else {
            throw skillErr
          }
        }
        sendJson(res, 200, skillResult === undefined ? await dispatchAsync(store, request) : skillResult)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error && error.message ? error.message : String(error) })
      }
    },
  }))
}
