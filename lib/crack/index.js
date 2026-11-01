/**
 * 破解模式自举（host 侧）—— dsh-forge 新增的破解 agent 模块
 *
 * 本地定制版，私有使用。
 * 借鉴其红队模式（lib/redteam/index.js）的「预设自注册 + 随包技能落地 + 模式下拉框声明」架构。
 * 本文件的代码、提示词与技能由本仓库维护者新增，上游著作权归原作者所有。
 *
 * 「破解模式」预设的注册与资源落地，只依赖宿主服务，不依赖任何第三方包：
 *   1. 把包内 `presets/crack/preset.yml` 和角色门脚本落到
 *      `$DSH_HOME/.agent-presets/crack/`；预设声明本身由本文件用 JS 注册
 *   2. 随包技能 `skills/crack/*.md` 同步到 `$DSH_HOME/crack/skills/`、
 *      角色稿 `presets/crack/agents/*.md` 同步到 `$DSH_HOME/crack/agents/`
 *   3. 用 `ctx.agentPresets.register()` 把预设声明进模式下拉框（Web 0.1.7+ 只认注册表，
 *      扫磁盘 .agent-presets 不会出现在下拉里 —— 与红队同款结论）
 *
 * 预设正文是纯 JS 构建的 registry declaration，不走 YAML 解析：
 *   · 无第三方依赖，坏在任何一台 dsh 上都只影响本模块
 *   · `!!js dshHomePath(...)` 这类表达式在 JS 里直接算成绝对路径
 *   · 相对插件行（角色门 `./crack-role.mjs`）解析成 file URL 交给注册表
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'dsh-forge-crack'

/**
 * 主会话的 REA 子集：判断、定序和串行前段要用的「看样本」动作。
 *
 * 完整 195 个动作留给执行角色；主线只带这些高频动作（索引约 1.2k 字符），
 * 既能让主线自己做 triage/static 判断，又不用每轮付完整 REA 表。
 * 动作名来自 lib/crack/rea-index.js。
 */
export const CRACK_MAIN_REA_ACTIONS = [
  // 文档 / 会话
  'current_document', 'list_documents', 'list_segments', 'list_architectures', 'list_names',
  'inspect_plist', 'inspect_sqlite_database', 'inspect_artifact', 'extract_artifact',
  // Android
  'inspect_android_package', 'inspect_android_class', 'inspect_android_method',
  'search_android_classes', 'trace_android_references', 'decode_android_resources',
  'open_jeb_project', 'list_jeb_units', 'decompile_jeb_item',
  // JS / Electron
  'analyze_javascript_application', 'analyze_web_bundle', 'recover_javascript_sources',
  'inspect_electron_fuses',
  // .NET
  'inspect_managed_artifact', 'inspect_managed_members', 'compare_managed_members',
  // 原生 / 反汇编
  'open_binary', 'binary_overview', 'inspect_binary_layout', 'inspect_pe_resources', 'inspect_macho',
  'inspect_native_api', 'list_strings', 'search_strings', 'search_bytes', 'read_bytes',
  'list_procedures', 'search_procedures', 'procedure_info', 'procedure_pseudo_code',
  'procedure_assembly', 'procedure_callers', 'procedure_callees',
  'find_xrefs_to_name', 'xrefs', 'address_to_file_offset',
  // 交叉分析
  'analyze_function', 'build_call_path', 'trace_call_path', 'get_call_graph',
  'get_objc_classes', 'analyze_swift_types', 'demangle_swift',
]

/** 与 dsh-agent-presets 的 USER_PRESET_DIR 保持一致。 */
export function userPresetRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, '.agent-presets')
}

/** 破解数据目录（技能 / 角色稿 / 案例库）。 */
export function crackDataDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'crack')
}

function packagePaths() {
  // import.meta.url 是 lib/crack/index.js → 上两级即包根
  const root = fileURLToPath(new URL('../..', import.meta.url))
  return {
    root,
    presetDir: join(root, 'presets', 'crack'),
    skills: join(root, 'skills', 'crack'),
    agents: join(root, 'presets', 'crack', 'agents'),
    // 逆向 5 个领域技能：DSH 的 user-dsh 根是 $DSH_HOME/skills（目录式 SKILL.md），
    // 不是 $DSH_HOME/crack/skills（平铺 .md）。两个根都要落。
    seagullSkills: join(root, 'skills', 'seagull'),
    // 外部技能来源：
    // 已补 whenToUse 并剥掉指向原仓库的断链引用，同样落 user-dsh 根。
    externalSkills: join(root, 'skills', 'external'),
  }
}

/**
 * 把包内 `skills/seagull/*.md` 落成 DSH 认识的目录式技能：`$DSH_HOME/skills/<name>/SKILL.md`。
 *
 * 与 crack/redteam 不同，DSH 的内置文件系统 provider 对 user-dsh 根（$DSH_HOME/skills）
 * 认两种布局：`<dir>/SKILL.md` 或平铺 `<name>.md`。这里统一用目录式，避免同名平铺文件
 * 与用户自建技能冲突。原文缺 whenToUse 时补一句，让模型路由更准。
 */
function landSeagullSkills(srcDir, skillsRoot) {
  if (!existsSync(srcDir)) return { copied: 0, files: 0, missing: true }
  const files = readdirSync(srcDir).filter((f) => f.endsWith('.md'))
  let copied = 0
  for (const file of files) {
    let raw
    try { raw = readFileSync(join(srcDir, file), 'utf8') } catch { continue }
    const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
    const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text)
    if (!fm) continue
    const field = (key) => {
      const hit = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(fm[1])
      if (!hit) return undefined
      let v = hit[1].trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      return v
    }
    const name = field('name')
    const description = field('description')
    // DSH 硬要求：kebab-case name + 非空 description，缺一个整份被忽略。
    if (!name || !description || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) continue
    const whenToUse = field('whenToUse')
    const body = text.slice(fm[0].length).trimStart()
    const quote = (v) => (/[:#"'\n\\]/.test(v) ? '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' : v)
    const rendered = [
      '---',
      `name: ${name}`,
      `description: ${quote(description)}`,
      ...(whenToUse ? [`whenToUse: ${quote(whenToUse)}`] : []),
      '---',
      '',
      body,
    ].join('\n')
    const dir = join(skillsRoot, name)
    const dest = join(dir, 'SKILL.md')
    let same = false
    try { same = readFileSync(dest, 'utf8') === rendered } catch { same = false }
    if (same) continue
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(dest, rendered, 'utf8')
      copied += 1
    } catch { /* 单个失败不阻断其余 */ }
  }
  return { copied, files: files.length, missing: false }
}

/** 落一份文件：目标不存在或内容不同则覆盖，相同则不动。返回 'installed'|'updated'|'kept'|'missing'。 */
function landFile(src, dest) {
  if (!existsSync(src)) return 'missing'
  let wanted
  try { wanted = readFileSync(src, 'utf8') } catch { return 'missing' }
  try {
    mkdirSync(dirname(dest), { recursive: true })
    if (existsSync(dest)) {
      let current = ''
      try { current = readFileSync(dest, 'utf8') } catch { /* 读失败按需覆盖 */ }
      if (current === wanted) return 'kept'
    }
    writeFileSync(dest, wanted, 'utf8')
    return 'updated'
  } catch {
    return 'missing'
  }
}

/** 同步一个目录里全部 .md 文件；同名按包内覆盖。返回 { copied, target }。 */
function landDir(srcDir, targetDir) {
  let copied = 0
  if (!existsSync(srcDir)) return { copied, target: targetDir, missing: true }
  const files = readdirSync(srcDir).filter((f) => f.endsWith('.md'))
  for (const file of files) {
    const action = landFile(join(srcDir, file), join(targetDir, file))
    if (action === 'updated' || action === 'installed') copied += 1
  }
  return { copied, target: targetDir, files: files.length, missing: false }
}

/** 把包内预设与资源落到 $DSH_HOME。返回 { presetDir, skills, agents }。 */
export function installPresetResources(log = () => {}) {
  const paths = packagePaths()
  const presetTarget = join(userPresetRoot(), 'crack')
  const skillsTarget = join(crackDataDir(), 'skills')
  const agentsTarget = join(crackDataDir(), 'agents')

  let presetAction = 'kept'
  if (existsSync(paths.presetDir)) {
    for (const file of readdirSync(paths.presetDir)) {
      const action = landFile(join(paths.presetDir, file), join(presetTarget, file))
      if (action === 'updated') presetAction = 'updated'
    }
    // 角色门脚本（crack-role.mjs 主会话门）必须每次都落地：
    // 预设里是 file URL 引用它，缺一个整份预设就 broken。
    // crack-worker-role.mjs 仍会同步（留档/手动工具），但已不进 composition。
    for (const gate of ['crack-role.mjs', 'crack-worker-role.mjs']) {
      const action = landFile(join(paths.presetDir, gate), join(presetTarget, gate))
      if (action === 'updated') presetAction = 'updated'
    }
    log(`破解预设落地 ${presetTarget}（${presetAction}）`)
  } else {
    presetAction = 'missing'
    log('破解预设目录缺失：' + paths.presetDir)
  }

  const skills = landDir(paths.skills, skillsTarget)
  const agents = landDir(paths.agents, agentsTarget)
  log(`破解技能同步 ${skillsTarget}（新增/更新 ${skills.copied}/${skills.files ?? 0}）`)
  log(`角色稿同步 ${agentsTarget}（新增/更新 ${agents.copied}/${agents.files ?? 0}）`)

  // 逆向 5 个领域技能落到 DSH 的 user-dsh 根（$DSH_HOME/skills/<name>/SKILL.md）。
  // 这是内置文件系统 provider 默认扫描的路径，落这里才会出现在 <available_skills>。
  const userSkillsRoot = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'skills')
  const seagull = landSeagullSkills(paths.seagullSkills, userSkillsRoot)
  if (seagull.missing) log(`逆向技能目录缺失：${paths.seagullSkills}`)
  else log(`逆向技能同步 ${userSkillsRoot}（新增/更新 ${seagull.copied}/${seagull.files ?? 0}）`)

  // 外部移植技能同一根、同一格式。
  const external = landSeagullSkills(paths.externalSkills, userSkillsRoot)
  if (external.missing) log(`外部技能目录缺失：${paths.externalSkills}`)
  else log(`外部技能同步 ${userSkillsRoot}（新增/更新 ${external.copied}/${external.files ?? 0}）`)

  return {
    presetDir: presetTarget,
    skillsDir: skillsTarget,
    agentsDir: agentsTarget,
    seagullSkillsDir: userSkillsRoot,
    seagullSkills: seagull,
    externalSkills: external,
    presetAction,
  }
}

/** 主会话指挥官的完整 persona 正文（破解模式人设 + 调度纪律 + 速通路由）。 */
export function crackPersonaDefault() {
  return `## 职责

判断、裁决、推进顺序、收口都由你做，执行不必都由你做。先定三件：样本、要的产物（补丁 / keygen / 绕过 / 结论）、怎么算验过；缺一件就问一次，齐了直接做。

开工先确认 REA 是否可用（rea 工具或 shell 里的 rea doctor）；没有就明说只能走 CLI，不要把缺工具当分析失败。

## 干活顺序

- 开工先 crack_case open 建案件（同一路径会复用），把样本、目标、验收写进去；之后任务书只给 case id + 本次增量，不重抄背景。
- 有依赖、结论要往下传的活自己串着做；triage/static 这种前段主线能直接做（主线带 REA 子集），需要大量命令或独立产物再派 worker。
- 派活用 subagent，首行写 crackRole: triage|static|dynamic|patch|verify；worker 开工先 crack_case get 读案件，结束 note 回写。任务书给：case id、范围、判据、已知结论与已排除方向、产物、验收。回包只当候选，盘上核过才算数。
- 少而准：主线能直接做的自己做；同类小任务合并给一个 worker，不按命令数开 worker；并行只给互不依赖且确实耗时的块。
- 补丁产物、应用命令、回滚命令齐了才派 verify；verify 前可以先并行做补丁前基线失败复现。
- 交付是产物不是描述：补丁、keygen、改好的样本落盘，并给可复制的应用与回滚命令。样本原件不动，一切改在副本上。
- 收口先 crack_case closeout：目标、验收、交付物、验证记录、回滚命令补齐；gaps 不为空不许标 done（除非显式 force）。
- 原始输出落文件/案件库，对话只留结论、路径、数字；没有新增量就安静继续。
- 开工先读 $DSH_HOME/crack/memory.md；不存在就建，只追加不重写。记忆和中间产物写 $DSH_HOME/crack 或案件库，不往样本/项目工作目录写。`
}
/** 旧默认人格会把“并行开子会话”当默认，且没有案件账本。 */
export function isLegacyCrackPersona(text) {
  const s = String(text || '')
  return /互不依赖的单元|多个样本、批量串扫/.test(s) && !/crack_case open/.test(s)
}

/**
 * 主会话人格解析：显式 `persona.local.md` > `persona.md`（非旧版）> 内置默认。
 * 旧版默认人格不再生效，但也不删用户文件——面板会显示“已忽略旧版”，保存一次即覆盖。
 * 预设注册发生在启动时，所以改完要重启 dsh 才生效。
 */
export function crackPersonaInfo(home) {
  const root = home ? join(String(home), 'crack') : crackDataDir()
  const candidates = [
    { file: 'persona.local.md', path: join(root, 'persona.local.md'), source: 'user-local' },
    { file: 'persona.md', path: join(root, 'persona.md'), source: 'user' },
  ]
  let legacyPath = ''
  for (const c of candidates) {
    let text = ''
    try { text = readFileSync(c.path, 'utf8').trim() } catch { continue }
    if (!text) continue
    if (isLegacyCrackPersona(text)) { legacyPath = c.path; continue }
    return { text, path: c.path, source: c.source, builtin: false, legacy_ignored: Boolean(legacyPath) }
  }
  return {
    text: crackPersonaDefault(),
    path: join(root, 'persona.md'),
    source: legacyPath ? 'builtin(legacy-ignored)' : 'builtin',
    builtin: true,
    legacy_ignored: Boolean(legacyPath),
    legacy_path: legacyPath || undefined,
  }
}

export function crackPersona(home) {
  return crackPersonaInfo(home).text
}

/**
 * 旧版默认人格不再生效后，把磁盘上的文件改名留档，避免面板/上下文清单继续显示一份“生效中”的旧稿。
 * 只处理识别为旧默认的文件；用户自定义的 persona.md 不动。
 */
export function migrateLegacyCrackPersona(home) {
  const info = crackPersonaInfo(home)
  if (!info.legacy_ignored || !info.legacy_path) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = info.legacy_path.replace(/\.md$/i, '.legacy-' + stamp + '.md')
  try {
    renameSync(info.legacy_path, backup)
    return backup
  } catch {
    return null
  }
}

const REA_PATH_NAMES = process.platform === 'win32' ? ['rea.cmd', 'rea.exe', 'rea.bat'] : ['rea']

/** 在 PATH 里找 rea 可执行文件；找不到返回 null。 */
function findReaOnPath() {
  const dirs = String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
  for (const dir of dirs) {
    for (const name of REA_PATH_NAMES) {
      const candidate = join(dir, name)
      try { if (existsSync(candidate)) return candidate } catch { /* 目录不可读就跳过 */ }
    }
  }
  return null
}

/**
 * REA MCP 环境解析：全部在运行时发现，不写死任何机器路径。
 *   · `REA_MJS` 指向 `rea.mjs` → 用当前 node 跑
 *   · `REA_CMD` 指向 rea 可执行文件 → 直接跑
 *   · 否则在 PATH 里找 `rea` / `rea.cmd`
 * 都找不到返回 null，调用方不挂 rea-mcp 这一行（不报错、不影响其它工具）。
 */
export function resolveReaEnvironment() {
  const mjs = String(process.env.REA_MJS || '').trim()
  if (mjs !== '' && existsSync(mjs)) return { command: process.execPath, args: [mjs, 'mcp'] }
  const explicit = String(process.env.REA_CMD || '').trim()
  const cmd = explicit !== '' && existsSync(explicit) ? explicit : findReaOnPath()
  if (cmd !== null) return { command: cmd, args: ['mcp'] }
  return null
}

/**
 * 破解预设的完整 composition rows。
 * 由 JS 对象直接构建 registry declaration，无 YAML 依赖。
 */
export function crackCompositionRows() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const skillsRoot = join(home, 'skills')
  const crackSkillsRoot = join(crackDataDir(), 'skills')
  const presetDir = join(userPresetRoot(), 'crack')
  const roleGateUrl = pathToFileURL(join(presetDir, 'crack-role.mjs')).href

  const persona = crackPersona()

  return [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: {
      prefix: persona,
      suffix: 'Your working directory is {{cwd}}.',
    } },

    // 角色门：子会话首行 crackRole: <code> → 把 $DSH_HOME/crack/agents/<code>.md 注入其系统提示词
    { id: 'crack-role-gate', name: roleGateUrl },

    // 主线只挂 REA 高频子集：判断和前段串行分析要能直接看样本；
    // 完整 195 个动作留给执行角色（见 crackWorkerCompositionRows）。
    ...(resolveReaEnvironment()
      ? [{ id: 'rea-tools', name: 'dsh-forge/crack/rea-tools', config: { actions: CRACK_MAIN_REA_ACTIONS } }]
      : []),
    { id: 'crack-case', name: 'dsh-forge/crack/case-tools' },
    { id: 'toolbox', name: 'dsh-forge/toolbox', config: { mode: 'crack' } },
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },

    // shell
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: process.platform === 'win32' },
    { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: process.platform !== 'win32' },

    // filesystem
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },

    // background jobs
    { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },

    // skills：只扫 $DSH_HOME/skills + $DSH_HOME/crack/skills，避免把项目级大技能包吞进来
    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem', config: {
      includeDefaultRoots: false,
      customSkillDirs: [skillsRoot, crackSkillsRoot],
    } },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },

    // goals
    { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
    { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },

    // plan mode（执行优先，plan 模式仅当用户明确要求）
    { id: 'planning', name: 'cordis:group', group: true, isolate: { planMode: true }, config: [
      { id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode', config: { section: [
        'You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode. When the operator explicitly asks to implement now, treat that as authorization to execute; exit plan mode or proceed with mutation tools as the operator directs.',
        'Explore first with reads and analysis; when the operator requires changes, use mutation tools to carry out the plan — do not refuse implementation because plan mode is active.',
        'Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer.',
        'Make the plan decision-complete: state the goal and success criteria; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions.',
        'When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. If review rejects it, incorporate the feedback and present again.',
      ].join('\n\n') } },
    ] },

    // compaction
    { id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true, toolResultPruner: true }, config: [
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
      { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
      { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner', config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 } },
    ] },

    // delegation：主会话可派活；子会话落 crack-worker 叶子预设（tools.restrict 去掉派发工具 + maxDepth 1）
    { id: 'delegation', name: 'cordis:group', group: true, isolate: { workflowEngine: true }, config: [
      { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control', disabled: false },
      { id: 'tool-subagent-list-agents', name: '@deepseek-ai/dsh-tool-subagent-control/list-agents', disabled: false },
      // dsh 0.2.1-rc.2 迁移：tool-subagent 的 config 不再接受 toolFilter（加载即抛错、
      // 整个预设判 broken）。叶子约束改为「子级独立预设 crack-worker + agentPreset 指定」，
      // 子级在自己的预设里 tools.restrict()，效果等同旧 deny。
      { id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent', disabled: false, config: {
        provider: 'spawn',
        toolName: 'subagent',
        modelSelectionSettings: true,
        maxDepth: 1,
        agentPreset: 'crack-worker',
      } },
      { id: 'tool-subagent-codex', name: '@deepseek-ai/dsh-tool-subagent', disabled: true, config: {
        provider: 'codex', toolName: 'subagent_codex', maxDepth: 'provider-managed',
      } },
      { id: 'tool-subagent-claude-code', name: '@deepseek-ai/dsh-tool-subagent', disabled: true, config: {
        provider: 'claude-code', toolName: 'subagent_claude_code', maxDepth: 'provider-managed',
      } },
      { id: 'workflow-worker-thread', name: '@deepseek-ai/dsh-workflow-worker-thread', disabled: true, config: { provider: 'spawn' } },
      { id: 'workflow-ptc', name: '@deepseek-ai/dsh-workflow-ptc', config: { provider: 'spawn' } },
      { id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow' },
    ] },

    // remaining model-facing rows
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: false, searchTimeoutMs: 60000 } },
    { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
  ]
}

/** 构建注册表声明（id=破解模式）。 */
export function buildDefinition() {
  return {
    id: 'crack',
    name: '破解模式',
    description: '逆向与破解：静态分析、动态调试、补丁与验证。',
    order: 20,
    plugins: crackCompositionRows(),
  }
}

/** 叶子子级预设 crack-worker 的 composition rows（无派发工具、带 REA、只做本职分析）。 */
export function crackWorkerCompositionRows() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const skillsRoot = join(home, 'skills')
  const crackSkillsRoot = join(crackDataDir(), 'skills')
  const rea = resolveReaEnvironment()

  return [
    // 子会话没有角色标签时也有一个最小身份；具体角色稿仍由 crack-role-gate 追加。
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: {
      prefix: '你是破解执行角色，只做任务书里那一块活。开工先读任务书里的案件账本，缺参数/缺设备/缺工具就写进回包；不提问、不派发、不覆盖原件。回包只给结论、产物路径、验证结果和卡点。',
      suffix: 'Your working directory is {{cwd}}.',
    } },
    // REA 走单入口：rea({action,args})。207 个动作的 schema 不再随请求下发，
    // 只带 195 个动作名的索引（约 4.2k 字符），参数用 action:"help" 现取。
    // 排除 12 个（研究账本 8 + 场景录制 4），名单见 lib/crack/rea-index.js。
    ...(rea ? [{ id: 'rea-tools', name: 'dsh-forge/crack/rea-tools', config: { compactIndex: true } }] : []),
    { id: 'crack-case', name: 'dsh-forge/crack/case-tools' },
    { id: 'toolbox', name: 'dsh-forge/toolbox', config: { mode: 'crack' } },

    // 叶子约束不在这里挂插件：
    //   · 任何 inject 了 agent 的行在 mount 审计时都会 "waiting for agent" 被判不可用
    //     （cordis _refresh：inject 名字拿不到实现 → 整行不激活）；
    //   · 叶子约束由 tool-subagent.config.maxDepth: 1 在 spawn provider 强制，
    //     加上父 persona 的「你是叶子节点」提示词，两层已够。
    // 本预设只负责「子会话能用什么工具」：不给 subagent / workflow / ralph 行即可。
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },

    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: process.platform === 'win32' },
    { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: process.platform !== 'win32' },

    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
    { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },

    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem', config: {
      includeDefaultRoots: false,
      customSkillDirs: [skillsRoot, crackSkillsRoot],
    } },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },

    // 不挂 ask-user：缺参回包，由主线决定是否问用户。
    // 不挂 present：成品由主线摆，worker 只回包和产物路径。
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: false, searchTimeoutMs: 60000 } },
  ]
}

/** 构建叶子子级声明（id=crack-worker）。 */
export function buildWorkerDefinition() {
  return {
    id: 'crack-worker',
    name: '破解模式 · 执行角色（子会话专用）',
    description: '破解模式的执行角色：只做分配到的单样本分析，不派发。手动新建会缺指挥人格与角色稿，请勿直接选用。',
    order: 92,
    plugins: crackWorkerCompositionRows(),
  }
}

/** 破解模式关联的全部预设声明（主会话 + 叶子子级）。 */
export function buildDefinitions() {
  return [buildDefinition(), buildWorkerDefinition()]
}

/** Cordis 插件入口：落地资源 + 声明预设进下拉框 + 暴露 ctx.crack 服务。 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return

  let result
  try {
    result = installPresetResources((msg) => ctx.logger?.info?.('dsh-forge-crack: ' + msg))
  } catch (error) {
    ctx.logger?.error?.('dsh-forge-crack: 资源落地失败：%s', error?.message || String(error))
    result = { presetDir: join(userPresetRoot(), 'crack'), skillsDir: join(crackDataDir(), 'skills'), agentsDir: join(crackDataDir(), 'agents') }
  }

  try {
    const backup = migrateLegacyCrackPersona()
    if (backup) ctx.logger?.info?.('dsh-forge-crack: 旧版默认人格已停用并备份到 ' + backup)
  } catch { /* 迁移失败不挡启动；运行时会忽略旧稿 */ }

  ctx.provide('crackMode', Object.freeze({ preset: result }))

  const statusFile = join(crackDataDir(), 'preset-declare.json')
  const writeStatus = (patch) => {
    try {
      mkdirSync(crackDataDir(), { recursive: true })
      let prev = {}
      try { prev = JSON.parse(readFileSync(statusFile, 'utf8')) } catch { /* first */ }
      writeFileSync(statusFile, JSON.stringify({ ...prev, ...patch, at: new Date().toISOString() }, null, 2), 'utf8')
    } catch { /* ignore */ }
  }
  writeStatus({ ok: false, phase: 'apply-start', presetDir: result.presetDir, skillsDir: result.skillsDir })

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

  let released
  let closed = false
  const undeclare = async () => {
    const dispose = released
    released = undefined
    if (!dispose) return
    try { await dispose() } catch { /* ignore */ }
  }

  const registerOnce = (registry) => {
    let definitions
    try {
      definitions = buildDefinitions()
    } catch (error) {
      writeStatus({ ok: false, phase: 'build-failed', error: error?.message || String(error) })
      ctx.logger?.warn?.('dsh-forge-crack: 构建预设失败：%s', error?.message || String(error))
      return
    }
    const ids = definitions.map((d) => d.id)
    writeStatus({ ok: false, phase: 'registering', id: 'crack', name: definitions[0].name, plugins: definitions[0].plugins.length, presets: ids })
    Promise.resolve()
      .then(async () => {
        await undeclare()
        const releases = []
        for (const definition of definitions) {
          releases.push(await registry.register(definition))
        }
        released = async () => {
          for (const release of releases) {
            try { await release() } catch { /* 逐条释放，单条失败不影响其余 */ }
          }
        }
        let broken = null
        // roster 留档：把宿主真正列出的本插件预设（含 broken 原因）写进状态文件，
        // 这样「注册时没报错但下拉框里看不到」时有据可查，不再靠猜。
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
        writeStatus({ ok: !broken && rosterError === '', phase: broken ? 'registered-broken' : rosterError ? 'roster-failed' : 'registered', id: 'crack', name: definitions[0].name, plugins: definitions[0].plugins.length, presets: ids, roster, rosterError, broken, error: '' })
        if (broken) ctx.logger?.warn?.('dsh-forge-crack: 已声明但 broken：%s', broken)
        else ctx.logger?.info?.('dsh-forge-crack: 已声明进模式下拉框：%s', ids.join(', '))
      })
      .catch((error) => {
        writeStatus({ ok: false, phase: 'register-failed', error: error?.message || String(error) })
        ctx.logger?.warn?.('dsh-forge-crack: 注册失败：%s', error?.message || String(error))
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
  }, 'dsh-forge-crack: declare agent preset')

  ctx.logger?.info?.('dsh-forge-crack: 就绪（预设 %s；技能 %s）', result.presetDir, result.skillsDir)
}

export default { name, apply }
