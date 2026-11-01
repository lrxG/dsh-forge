/**
 * dsh-forge 红队面板自举（host 半侧）
 *
 * 资产库、工具、预设、技能都在本插件目录内。本文件负责：
 *   1. 首次把 `presets/redteam` 落到 `$DSH_HOME/.agent-presets/redteam/`
 *   2. 随包技能落到 `$DSH_HOME/redteam/skills`，预设用 `dshHomePath` 指向它
 *   3. 已有用户预设时保留正文，只补 preset.yml / 角色脚本等实现文件
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readPresetDefinition } from './preset-composition.js'

/** Cordis 插件名。 */
export const name = 'dsh-forge-redteam'

/** 与梁神一致：不硬依赖 agentPresets，就绪后软取并声明。 */
export const inject = []

/** 模式下拉里的预设 id（目录名 / registry id）。 */
const REDTEAM_PRESET_ID = 'redteam'

/** 叶子子级预设 id：父预设用 tool-subagent.config.agentPreset 指过来。 */
const REDTEAM_WORKER_PRESET_ID = 'redteam-worker'

/** 插件根目录（lib/redteam → 上两级）。 */
export function packagePaths() {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  return {
    root,
    presets: join(root, 'presets'),
    presetDir: join(root, 'presets', 'redteam'),
    skills: join(root, 'skills', 'redteam'),
    scripts: join(root, 'scripts'),
  }
}

/** 环境数据目录（与 store/tools 用的同一份约定）。 */
export function redteamDataDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'redteam')
}

/** 用户 preset 根（与 dsh-agent-presets 的 USER_PRESET_DIR 保持一致）。 */
export function userPresetRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, '.agent-presets')
}

/**
 * 执行角色可用的红队动作白名单。
 *
 * worker 需要「查库 + 写成果 + 取证」，不需要「换靶标 / 重置角色稿 / 出报告」。
 * 把这些控制动作留给主会话，既避免子会话改掉主线绑定，也缩短 worker 每轮的动作索引。
 */
export const REDTEAM_WORKER_ACTIONS = [
  'session_info', 'session_bind',
  'asset_add', 'ingest', 'asset_link', 'asset_query', 'asset_get', 'asset_stats', 'asset_graph',
  'asset_test', 'asset_assess',
  'vuln_add', 'vuln_query', 'vuln_update',
  'credential_add', 'credential_list',
  'shot_add', 'shot_list',
  'access_add', 'access_list',
  'webshell_add', 'webshell_list', 'webshell_update',
  'tunnel_add', 'tunnel_list', 'tunnel_update',
  /* 入口登记后要能自己实测连通性：角色稿里写了"必须实测可用"，
     不给这个动作就等于逼子会话假装验证或回报阻塞。 */
  'session_check',
  'http_evidence_add',
  'chain_add', 'chain', 'attack_path',
  'hypothesis_add', 'hypothesis_close', 'hypothesis_list',
  'attack_file_add', 'attack_file_list',
  'coverage',
  'poc_search', 'poc_get', 'poc_list', 'poc_use',
  'vps_exec', 'vps_put', 'vps_get', 'oast_poll', 'capture',
  'import',
  'sessions',
]

/** 用户编辑预设时可能删掉必需行；加载时只在内存里补齐，不改用户文件。 */
export function hardenRedteamDefinition(definition) {
  if (!definition || !Array.isArray(definition.plugins)) return definition
  const plugins = definition.plugins
  const ids = new Set(plugins.map((row) => row && row.id).filter(Boolean))
  if (!ids.has('browser')) {
    plugins.push({ id: 'browser', name: 'dsh-forge/redteam/browser' })
  }
  if (!ids.has('present')) {
    plugins.push({ id: 'present', name: '@deepseek-ai/dsh-tool-present' })
  }
  if (!ids.has('toolbox')) {
    plugins.push({ id: 'toolbox', name: 'dsh-forge/toolbox', config: { mode: 'redteam' } })
  }
  /* tool-subagent 在 delegation 组里；旧 YAML 的缩进结构必须递归找。 */
  const ensureMaxDepth = (rows) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || typeof row !== 'object') continue
      if (row.id === 'tool-subagent') {
        row.config = row.config && typeof row.config === 'object' ? row.config : {}
        if (row.config.maxDepth === undefined) row.config.maxDepth = 1
        /* 老预设没有 agentPreset 时，子会话会落到宿主默认预设（或继承 redteam）
           —— 要么没有红队工具，要么再生成一个"指挥官"。只在缺省时补，不覆盖用户显式配置。 */
        const provider = String(row.config.provider || 'spawn')
        if (provider === 'spawn' && row.config.agentPreset === undefined) {
          row.config.agentPreset = REDTEAM_WORKER_PRESET_ID
        }
      }
      if (row.group === true && Array.isArray(row.config)) ensureMaxDepth(row.config)
    }
  }
  ensureMaxDepth(plugins)
  return definition
}

/** 叶子子级预设 redteam-worker 的 composition rows（可单测）。 */
export function redteamWorkerCompositionRows(home = process.env.DSH_HOME || join(homedir(), '.dsh')) {
  return [
    // 子会话没有角色标签时也有一个最小身份；具体角色稿仍由 role-section 追加。
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: {
      prefix: '你是红队执行角色，只做任务书里那一块活。开工先用 session_bind 绑任务书第一行的 engagement，只写自己的靶标；缺参数、缺凭据、缺工具就写进回包，不派发、不反问你自己的判断。回包只给结论、落库 id、证据路径、卡点和下一步。',
      suffix: 'Your working directory is {{cwd}}.',
    } },
    // 不挂任何 inject 了 agent 的门脚本：mount 审计会把「等 agent」判成不可用。
    // 下面这份行表就是叶子约束本身：不放派活行，子会话的工具表里就没有派发能力。
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
    { id: 'redteam-tools', name: 'dsh-forge/redteam/tools', config: {
      actions: REDTEAM_WORKER_ACTIONS,
      /* worker 每轮不为完整动作索引付费；需要时 action:"help" 现取。 */
      compactIndex: true,
    } },
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: process.platform === 'win32' },
    { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: process.platform !== 'win32' },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
    { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem', config: {
      includeDefaultRoots: false,
      customSkillDirs: [join(home, 'skills'), join(home, 'redteam', 'skills')],
    } },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
    // 不挂 tool-ask-user：子会话缺参直接写进回包，由主会话统一决定要不要问用户。
    // 不挂 present：成品由主会话摆；worker 只回包和证据路径。
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: false, searchTimeoutMs: 60000 } },
    { id: 'browser', name: 'dsh-forge/redteam/browser' },
    { id: 'toolbox', name: 'dsh-forge/toolbox', config: { mode: 'redteam' } },
  ]
}

/**
 * 技能同步目标目录（第一个是主目标，其余是"顺手补一份"）。
 *
 * `$DSH_HOME` 有两个可能来源：插件进程的 `process.env.DSH_HOME || homedir()/.dsh`，
 * 与宿主 `dshHomePath()` 解析出的 home。换盘 / 换 profile / `HOME` 为空的机器上两者
 * 会分叉 —— 技能只落到一边，预设指向另一边时就是"装了却列不出来 / 显示不可用"。
 * 所以：主目标必写，另外那个候选 home 只要在本机真实存在就补一份（不凭空造 home）。
 */
function skillSyncTargets() {
  const homes = []
  const push = (p) => { if (p && !homes.includes(p)) homes.push(p) }
  push(process.env.DSH_HOME)
  push(join(homedir(), '.dsh'))
  const primary = join(redteamDataDir(), 'skills')
  const dirs = [primary]
  for (const home of homes) {
    if (!existsSync(home)) continue
    const dir = join(home, 'redteam', 'skills')
    if (!dirs.includes(dir)) dirs.push(dir)
  }
  return dirs
}

/* 已从包内删除的旧技能：同步时清掉 $DSH_HOME/redteam/skills 里的残留。
   这个目录是插件托管目录；用户自己的技能放 $DSH_HOME/skills，不在这里。 */
const RETIRED_BUNDLED_SKILLS = ['gogo-intranet.md', 'kimi-webbridge.md']

/**
 * 把包内 `skills/redteam/*.md` 同步到 `$DSH_HOME/redteam/skills`（分叉时两个 home 都放一份）。
 * 同名文件按包内内容覆盖。用户自己的副本在 `$DSH_HOME/skills`，不在这里改。
 */
export function installBundledSkills() {
  const paths = packagePaths()
  const targets = skillSyncTargets()
  if (!existsSync(paths.skills)) return { action: 'missing', path: targets[0], copied: 0 }
  const files = readdirSync(paths.skills).filter((f) => f.endsWith('.md'))
  let copied = 0
  for (const target of targets) {
    mkdirSync(target, { recursive: true })
    for (const old of RETIRED_BUNDLED_SKILLS) {
      try { unlinkSync(join(target, old)) } catch { /* 本来就没有 */ }
    }
    for (const file of files) {
      const wanted = readFileSync(join(paths.skills, file))
      const dest = join(target, file)
      let same = false
      try { same = readFileSync(dest).equals(wanted) } catch { same = false }
      if (same) continue
      writeFileSync(dest, wanted)
      if (target === targets[0]) copied += 1
    }
  }
  return { action: copied > 0 ? 'updated' : 'kept', path: targets[0], copied, targets }
}

/**
 * `probe.cmd` —— toolbox 在 Windows 上只认 exe/cmd/bat/com/ps1，`.py` 扫不到，
 * 所以随包探针脚本配一个包装，让 toolbox 的 probe 卡片能直接 run。
 * 解释器按现场取（python → py -3），不写死本机路径。
 */
const PROBE_CMD = [
  '@echo off',
  'rem dsh-forge: wrapper for httpprobe.py (toolbox only runs exe/cmd/bat/com/ps1)',
  'setlocal',
  'where python >nul 2>nul',
  'if not errorlevel 1 (set "PY=python" & goto :check)',
  'where py >nul 2>nul',
  'if not errorlevel 1 (set "PY=py -3" & goto :check)',
  'echo [probe] Python 3 not found. Install Python 3 or use curl for a single request.',
  'exit /b 2',
  ':check',
  '%PY% -c "import sys" >nul 2>nul',
  'if errorlevel 1 (echo [probe] Python exists but is not runnable. Use curl for a single request. & exit /b 2)',
  '%PY% -c "import requests" >nul 2>nul',
  'if errorlevel 1 (echo [probe] Python is present but requests is missing. Run: pip install requests. Or use curl for a single request. & exit /b 2)',
  ':run',
  '%PY% "%~dp0httpprobe.py" %*',
  'exit /b %errorlevel%',
  '',
].join('\r\n')

/**
 * 把包内 `scripts/httpprobe.py` 同步到 `$DSH_HOME/tools`，并补 `probe.cmd`。
 * 内容一致就不重写；包内那份是权威，用户改过的会被覆盖（toolbox 目录是插件托管）。
 */
export function installBundledTools() {
  const paths = packagePaths()
  const src = join(paths.scripts, 'httpprobe.py')
  const target = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'tools')
  if (!existsSync(src)) return { action: 'missing', dir: target, files: [] }
  const wanted = readFileSync(src)
  const files = []
  try {
    mkdirSync(target, { recursive: true })
    const script = join(target, 'httpprobe.py')
    let same = false
    try { same = readFileSync(script).equals(wanted) } catch { same = false }
    if (!same) {
      writeFileSync(script, wanted)
      files.push('httpprobe.py')
    }
    const wrapper = join(target, 'probe.cmd')
    let sameWrapper = false
    try { sameWrapper = readFileSync(wrapper, 'utf8') === PROBE_CMD } catch { sameWrapper = false }
    if (!sameWrapper) {
      writeFileSync(wrapper, PROBE_CMD, 'utf8')
      files.push('probe.cmd')
    }
  } catch (error) {
    return { action: 'failed', dir: target, files, error: error && error.message ? error.message : String(error) }
  }
  return { action: files.length > 0 ? 'updated' : 'kept', dir: target, files }
}

/**
 * 伴随文件补齐：`preset.yml` / 角色 `.mjs` / worker `.cordis.yml` 属于预设的实现部分，
 * 用户不会手写。目标目录若已有 `agent.cordis.yml`，installPreset 走的是"保留用户内容"
 * 分支，早期实现在那里直接 return，于是 `preset.yml` 从未落地 —— 注册时读不到它，
 * 报 `preset.yml is unreadable`，红队模式就不会出现在下拉里。
 *
 * 这里只补缺失的文件，并把 `.mjs` 刷到包内版本（代码不该由用户维护）。
 * @returns 实际写入的文件名数组
 */
function syncCompanionFiles(target, paths) {
  const written = []
  let files = []
  try { files = readdirSync(paths.presetDir) } catch { return written }
  for (const file of files) {
    if (file === 'agent.cordis.yml') continue
    const dst = join(target, file)
    const isCode = file.endsWith('.mjs') || file === 'preset.yml'
    const exists = existsSync(dst)
    if (exists && !isCode) continue
    let wanted
    try { wanted = readFileSync(join(paths.presetDir, file), 'utf8') } catch { continue }
    const next = wanted.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    if (exists) {
      let current = ''
      try { current = readFileSync(dst, 'utf8') } catch { current = '' }
      if (current === next) continue
    }
    try {
      mkdirSync(target, { recursive: true })
      writeFileSync(dst, next, 'utf8')
      written.push(file)
    } catch { /* 单个文件失败不影响其余 */ }
  }
  return written
}

export function installPreset(options = {}) {
  const paths = packagePaths()
  const bundled = installBundledSkills()
  const target = join(userPresetRoot(), 'redteam')
  const log = options.log ?? (() => {})
  const tools = installBundledTools()
  if (tools.files.length > 0) log(`探针已同步到 ${tools.dir}：${tools.files.join('、')}`)
  else if (tools.action === 'failed') log(`探针同步失败：${tools.error}`)
  const skillCount = existsSync(paths.skills)
    ? readdirSync(paths.skills).filter((f) => f.endsWith('.md')).length
    : 0
  const presetFile = join(target, 'agent.cordis.yml')

  if (existsSync(presetFile) && options.force !== true) {
    /* 用户自己维护 agent.cordis.yml 时保留正文，只补实现文件。 */
    const companions = syncCompanionFiles(target, paths)
    if (companions.length > 0) {
      log(`补齐伴随文件：${companions.join('、')}`)
      return {
        action: 'repaired', dir: target, skillsDir: bundled.path, skills: skillCount, toolsDir: tools.dir,
        repaired: 'companions(' + companions.join('+') + ')',
      }
    }
    log(`已存在用户自己的预设 ${target}，保留不动（要覆盖：REDTEAM_PRESET_REFRESH=1 启动一次）`)
    return { action: 'kept', dir: target, skillsDir: bundled.path, skills: skillCount, toolsDir: tools.dir }
  }

  mkdirSync(target, { recursive: true })
  for (const file of readdirSync(paths.presetDir)) {
    const text = readFileSync(join(paths.presetDir, file), 'utf8')
    writeFileSync(join(target, file), text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8')
  }
  // 叶子子级预设的角色门脚本必须落地：父预设里 tool-subagent.config.agentPreset
  // 指向 redteam-worker，而该预设的 composition 用 file URL 引用这个 .mjs。
  // 只同步 .mjs（.yml 只是留档，真正的声明由 buildWorkerDefinition() 在 JS 里构建）。
  for (const file of readdirSync(paths.presetDir).filter((f) => f.endsWith('.mjs'))) {
    const wanted = readFileSync(join(paths.presetDir, file), 'utf8')
    writeFileSync(join(target, file), wanted, 'utf8')
  }
  log(`预设已安装到 ${target}（随包技能 ${skillCount} 个，目录 ${bundled.path}）`)
  return { action: 'installed', dir: target, skillsDir: bundled.path, skills: skillCount, toolsDir: tools.dir }
}

/**
 * @param ctx - 插件上下文。
 */
export function apply(ctx) {
  const paths = packagePaths()
  let result
  try {
    result = installPreset({
      force: process.env.REDTEAM_PRESET_REFRESH === '1',
      log: (msg) => ctx.logger?.info?.('redteam-mode: ' + msg),
    })
  } catch (error) {
    ctx.logger?.error?.('redteam-mode: 预设安装失败：%s', error && error.message ? error.message : String(error))
    result = { action: 'failed', dir: join(userPresetRoot(), 'redteam'), skillsDir: join(redteamDataDir(), 'skills'), skills: 0 }
  }
  /*
   * Web 0.1.7+ 模式下拉只认 agent-preset registry.register()，
   * 扫磁盘 .agent-presets 不会出现在下拉里（梁神同款）。
   */
  const statusFile = join(redteamDataDir(), 'preset-declare.json')
  const writeStatus = (patch) => {
    try {
      mkdirSync(redteamDataDir(), { recursive: true })
      let prev = {}
      try { prev = JSON.parse(readFileSync(statusFile, 'utf8')) } catch { /* first */ }
      writeFileSync(statusFile, JSON.stringify({ ...prev, ...patch, at: new Date().toISOString() }, null, 2), 'utf8')
    } catch { /* ignore */ }
  }
  writeStatus({ ok: false, phase: 'apply-start', skillsDir: result.skillsDir, presetDir: result.dir })

  let releaseDeclared
  let closed = false
  const softRegistry = () => {
    try {
      if (ctx.agentPresets && typeof ctx.agentPresets.register === 'function') return ctx.agentPresets
    } catch { /* without inject */ }
    try {
      const reg = ctx.get('agentPresets')
      if (reg && typeof reg.register === 'function') return reg
    } catch { /* missing */ }
    return null
  }
  const undeclare = async () => {
    const dispose = releaseDeclared
    releaseDeclared = undefined
    if (!dispose) return
    try { await dispose() } catch (error) {
      ctx.logger?.warn?.('redteam-mode: undeclare failed: %s', error?.message || String(error))
    }
  }
  const buildDefinition = () => {
    const fromDisk = join(userPresetRoot(), 'redteam')
    if (!existsSync(join(fromDisk, 'agent.cordis.yml'))) {
      installPreset({ force: false, log: () => {} })
    }
    const readyDir = existsSync(join(userPresetRoot(), 'redteam', 'agent.cordis.yml'))
      ? join(userPresetRoot(), 'redteam')
      : paths.presetDir
    return hardenRedteamDefinition(readPresetDefinition(REDTEAM_PRESET_ID, readyDir))
  }

  const buildWorkerDefinition = () => {
    return {
      id: REDTEAM_WORKER_PRESET_ID,
      name: '红队模式 · 执行角色（子会话专用）',
      description: '红队执行角色：只做分配到的单点任务，不派发。手动新建会缺指挥人格与角色稿，请勿直接选用。',
      order: 91,
      plugins: redteamWorkerCompositionRows(),
    }
  }

  const registerOnce = (registry) => {
    let definition
    let workerDefinition
    try {
      definition = buildDefinition()
    } catch (error) {
      writeStatus({ ok: false, phase: 'read-failed', error: error?.message || String(error) })
      ctx.logger?.warn?.('redteam-mode: read preset failed: %s', error?.message || String(error))
      return
    }
    try {
      workerDefinition = buildWorkerDefinition()
    } catch (error) {
      ctx.logger?.warn?.('redteam-mode: build worker preset failed: %s', error?.message || String(error))
    }
    const ids = [definition.id, ...(workerDefinition ? [workerDefinition.id] : [])]
    writeStatus({
      ok: false,
      phase: 'registering',
      id: definition.id,
      name: definition.name,
      plugins: Array.isArray(definition.plugins) ? definition.plugins.length : -1,
      presets: ids,
    })
    Promise.resolve()
      .then(async () => {
        await undeclare()
        const releases = []
        releases.push(await registry.register(definition))
        if (workerDefinition) releases.push(await registry.register(workerDefinition))
        releaseDeclared = async () => {
          for (const release of releases) {
            try { await release() } catch { /* 逐条释放 */ }
          }
        }
        let broken = null
        let roster = []
        let rosterError = ''
        try {
          const rows = await registry.list()
          const mine = rows.filter((p) => ids.includes(p.id))
          roster = mine.map((p) => ({ id: p.id, broken: p.broken || null }))
          const bad = mine.filter((p) => p.broken)
          if (bad.length > 0) broken = bad.map((p) => `${p.id}: ${p.broken}`).join(' | ')
        } catch (error) {
          rosterError = error?.message || String(error)
        }
        writeStatus({
          ok: !broken && rosterError === '',
          phase: broken ? 'registered-broken' : rosterError ? 'roster-failed' : 'registered',
          id: definition.id,
          name: definition.name,
          plugins: Array.isArray(definition.plugins) ? definition.plugins.length : -1,
          presets: ids,
          roster,
          rosterError,
          broken,
          /* 成功这一轮要把上一轮的 error 抹掉：writeStatus 是合并写，不清就永远留着旧错。 */
          error: '',
        })
        if (broken) ctx.logger?.warn?.('redteam-mode: declared but broken: %s', broken)
        else ctx.logger?.info?.('redteam-mode: declared for mode dropdown: %s', definition.name || REDTEAM_PRESET_ID)
      })
      .catch((error) => {
        writeStatus({ ok: false, phase: 'register-failed', error: error?.message || String(error) })
        ctx.logger?.warn?.('redteam-mode: register failed: %s', error?.message || String(error))
      })
  }

  ctx.effect(() => {
    let tries = 0
    const tick = () => {
      if (closed) return true
      tries += 1
      const registry = softRegistry()
      if (!registry) {
        writeStatus({ ok: false, phase: 'waiting-registry', tries })
        return false
      }
      registerOnce(registry)
      return true
    }
    let timer
    let stop
    if (!tick()) {
      timer = setInterval(() => {
        if (tick()) {
          clearInterval(timer)
          timer = undefined
          if (stop) clearTimeout(stop)
        }
      }, 400)
      if (typeof timer.unref === 'function') timer.unref()
      stop = setTimeout(() => {
        if (timer) {
          clearInterval(timer)
          timer = undefined
          writeStatus({ ok: false, phase: 'timeout-waiting-registry', tries })
        }
      }, 45000)
      try { stop.unref?.() } catch { /* ignore */ }
    }
    return () => {
      closed = true
      if (timer) clearInterval(timer)
      if (stop) clearTimeout(stop)
      void undeclare()
    }
  }, 'dsh-forge-redteam: declare agent preset')

  ctx.provide('redteamMode', Object.freeze({ paths, preset: result }))
  ctx.logger?.info?.(
    'redteam-mode: 就绪（数据目录默认 $DSH_HOME/redteam；预设 %s；技能目录 %s）',
    result.dir, result.skillsDir,
  )
}

export default { name, inject, apply }
