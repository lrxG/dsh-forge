/**
 * RedTeam 智能体工具集（preset 平面）
 *
 * 这些行只向 `tools` 注册模型可见工具，自身不发布任何服务，因此不需要 isolate realm；
 * 它们解析的是 host 平面的 `ctx.redteam`（dsh-redteam-store 发布的进程级实例）。
 *
 * 设计约定：
 *   · 写入一律走 redteam_asset_add / redteam_asset_link，智能体不直接碰 SQL；
 *   · 每次发现都带 provenance（passive|active）与 tool，保证界面上的来源标注可信；
 *   · **靶标按根会话隔离**：绑定键是会话的根祖先 id，子智能体顺着
 *     `session.header.parentSession` 继承父会话的靶标 —— 多会话并行时互不串写，
 *     报告不会再被别的靶标的成果污染（v0.9.0 之前的全局「当前靶标」指针正是串写的根源）；
 *   · 并发硬约束：`redteam_agent_slot` 用 `ctx.subagents.listChildren` 的真实运行数
 *     卡住同一靶标同时跑的执行智能体数（上限见 settings.json，默认 8），超了直接拒绝，
 *     不靠提示词自觉。
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, realpathSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { captureWeb } from './capture.js'
import { ROLE_TITLES, PLANNER_ROLE, ROLE_ORDER, PENDING_REVIEW_STATUSES, humanVerdictBlock } from './store-core.js'
import {
  bindEngagement,
  boundEngagementOf,
  bindingViewOf,
  bindingsNow,
  pruneBindings,
  dropBinding,
  sessionInfoOf,
  bindingKeyOf,
  bindKeysOf,
} from './session-bindings.js'
/* 技能可用性判定只有一份实现：面板的「技能库」页签与这里共用（见该文件头注释） */
import { bundledSkillSummaries, checkSkill, summarizeSkills, expandSkillPath, redteamSummariesForCheck } from './skill-availability.js'
import { parseScanOutput } from './ingest-parse.js'
import { importBatchRows, BATCH_KINDS } from './batch-import.js'
import { skeletonOf, renderSkeleton, SKELETONS } from './skill-skeletons.js'
import {
  CORE_TOOL_IDS,
  effectiveEnvOf,
  loadPlatformConfig,
  platformSummary,
  probeEgress,
  readEnvFile,
  toolkitDirOf,
} from './platform-config.js'
import { maxAgentsOf, DEFAULT_MAX_AGENTS, MAX_AGENTS_LIMIT } from './settings.js'
import { vpsExec, vpsSummary, vpsPut, vpsGet } from './vps.js'
import { oastPoll, oastSummary } from './oast.js'
import { loadSecret } from './secrets.js'

/**
 * link: 源码包不在 profile node_modules 树内，静态 import `@deepseek-ai/dsh-tools`
 * 会解析失败 → 预设行 fiber 为 undefined（never started）→ 整份「红队模式」被下拉过滤。
 * 这里从运行中的 dsh / profile 路径 createRequire。
 */
/** 首次 preflight 执行成功就落标记；第一次仍按 first_run 返回，下一次不再念新用户台词。 */
function markSetupComplete(file) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, new Date().toISOString() + '\n', 'utf8')
  } catch { /* 写不了标记不影响体检 */ }
}

const CORE_TOOL_SET = new Set(CORE_TOOL_IDS)

function coreToolIdOf(item) {
  return String(item && (item.id || item.key || item.name) || '').trim().toLowerCase()
}

/**
 * preflight 只暴露核心工具。scenario/optional 工具仍在磁盘和工具箱里，
 * 但不进自检结论，避免模型把“装了但这次用不到”误当成缺失。
 */
function corePlatformView(plat) {
  if (!plat || typeof plat !== 'object') return plat
  const pick = (item) => CORE_TOOL_SET.has(coreToolIdOf(item))
  const coreItems = (plat.tools && Array.isArray(plat.tools.items) ? plat.tools.items : []).filter(pick)
  const inv = plat.inventory && typeof plat.inventory === 'object' ? plat.inventory : {}
  const invItems = (Array.isArray(inv.items) ? inv.items : []).filter(pick)
  const invCatalog = (Array.isArray(inv.catalog) ? inv.catalog : []).filter(pick)
  const countOf = (list, fn) => list.filter(fn).length
  return Object.assign({}, plat, {
    core_tool_ids: CORE_TOOL_IDS.slice(),
    tools: Object.assign({}, plat.tools || {}, {
      total: coreItems.length,
      found: countOf(coreItems, (t) => !!t.path),
      missing: countOf(coreItems, (t) => !t.path),
      items: coreItems,
    }),
    inventory: Object.assign({}, inv, {
      items: invItems,
      catalog: invCatalog,
      total: invItems.length + invCatalog.length,
      found: countOf(invItems, (t) => !!t.path),
      missing: countOf(invItems, (t) => !t.path),
    }),
    note: '这里只列核心工具；其他工具保留在工具箱里，不默认检查，需要时用 toolbox find 检索。',
  })
}

function addCandidate(list, pkg) {
  if (!pkg) return
  const norm = String(pkg).replace(/\\/g, '/')
  if (!list.includes(norm)) list.push(norm)
}

function considerBin(list, bin) {
  if (!bin) return
  let text = String(bin).replace(/\\/g, '/')
  try { text = realpathSync(bin).replace(/\\/g, '/') } catch { /* 解析不了就用原路径 */ }
  const needle = '/node_modules/@deepseek-ai/dsh/'
  const at = text.lastIndexOf(needle)
  if (at >= 0) addCandidate(list, text.slice(0, at + needle.length - 1) + '/package.json')
  const nm = text.lastIndexOf('/node_modules/')
  if (nm >= 0) addCandidate(list, join(text.slice(0, nm), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  const dir = dirname(text)
  /* npm 全局的 argv 常常是 …/bin/dsh，真正的包在旁边的 lib/node_modules。 */
  addCandidate(list, join(dir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  addCandidate(list, join(dir, '..', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
}

function loadDefineTool() {
  const candidates = []
  try { considerBin(candidates, process.argv[1]) } catch { /* ignore */ }
  const homes = [process.env.DSH_HOME, join(homedir(), '.dsh')].filter(Boolean)
  for (const home of homes) {
    addCandidate(candidates, join(home, 'package.json'))
    for (const profile of ['web', 'desktop', 'default']) {
      addCandidate(candidates, join(home, 'profiles', profile, 'package.json'))
      addCandidate(candidates, join(home, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    }
  }
  addCandidate(candidates, join(process.cwd(), 'package.json'))
  addCandidate(candidates, join('D:', 'DeepSeek Harness', 'npm-global', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  for (const pkg of candidates) {
    try {
      if (!pkg || !existsSync(pkg)) continue
      const mod = createRequire(pkg)('@deepseek-ai/dsh-tools')
      const fn = mod && (mod.defineTool || (mod.default && mod.default.defineTool))
      if (typeof fn === 'function') return fn
    } catch { /* try next */ }
  }
  throw new Error('dsh-forge/redteam/tools: cannot resolve @deepseek-ai/dsh-tools from host')
}

const defineTool = loadDefineTool()

/** Cordis 插件名。 */
export const name = 'dsh-forge-redteam-tools'

/** 硬依赖工具注册表；`redteam` 在 host 平面由 store 发布，预设域内用软取。 */
export const inject = ['tools']

/** 并发闸门：根会话 id → Map(子智能体键 → 预留时间戳)。子智能体结束时自动释放。 */
const reservations = new Map()

/** FIFO cap:长会话累积失效的 session id,防无限涨。订单最老的被淘汰(FIFO,近似 LRU)。 */
const RESERVATIONS_CAP = 500
function capMap(m, cap) {
  const origSet = m.set.bind(m)
  m.set = (k, v) => {
    if (!m.has(k) && m.size >= cap) {
      const first = m.keys().next().value
      if (first !== undefined) m.delete(first)
    }
    return origSet(k, v)
  }
}
capMap(reservations, RESERVATIONS_CAP)

/** 并发上限：每次调用现读 settings.json → REDTEAM_MAX_AGENTS → 默认 8（见 settings.js）。 */
function maxAgentsNow(ctx) {
  const root = (() => { try { return ctx.redteam.root } catch { return undefined } })()
  return maxAgentsOf(root, process.env)
}

/** 会话 id（兼容旧调用点）。 */
function sessionOf(exec) {
  return sessionInfoOf(exec).id
}

/**
 * 解析本次调用应作用在哪个靶标上（会话隔离版）。
 *
 * 顺序：① 显式传入 → ② 本会话/父链上的绑定 → ③ 全局「当前靶标」指针
 * （仅当没有被别的会话占用；被占用时报错并提示显式绑定，**绝不静默串写**）。
 *
 * 抛错而不是"随便挑一个"是刻意的：多会话并行时挑错靶标 = 把 A 单位的成果写进
 * B 单位的库、A 的报告里出现 B 的数据（这正是要多会话隔离的原因）。
 */
function resolveEngagement(store, exec, explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  try { pruneBindings(exec) } catch { /* 绑定表清理失败不影响解析 */ }
  const bound = boundEngagementOf(exec)
  if (bound) return bound
  const keys = bindKeysOf(exec)
  const list = store.listEngagements()
  /* 只有一个靶标时直接采纳：没有选错的余地，不必让人多点一次。 */
  if (list.length === 1) {
    bindEngagement(exec, list[0].id)
    return list[0].id
  }
  /* 多个靶标时绝不猜。绑定只活在进程内存里，宿主重启就清空；
     这时若静默采纳全局「当前靶标」，前一天的成果会写进另一个库而面板看不出异常。 */
  const active = typeof store.activeEngagementId === 'function' ? store.activeEngagementId() : undefined
  if (!active) {
    throw new Error('尚未绑定靶标：请先调用 redteam_engagement_open 传入靶标单位名称，或 redteam_session_bind 绑定到已有靶标。')
  }
  const holder = bindingsNow().find((row) => row.engagement === active && !keys.includes(row.session))
  throw new Error(
    (holder !== undefined
      ? '本会话尚未绑定靶标，而全局「当前靶标」' + active + ' 已被另一个会话占用；'
      : '本会话尚未绑定靶标。全局「当前靶标」是 ' + active + '，但它不是本会话的绑定——'
        + '重启或换窗口后这条指针不跟着会话走，直接采纳会把成果写进别的靶标库；')
    + '请显式绑定：redteam_engagement_open（新建/打开）或 redteam_session_bind（绑定到已有靶标）。',
  )
}

/** 逗号/空白分隔的清单 → 去重数组。 */
function splitList(value) {
  return String(value || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)
}

/** 粗校验：IPv4 点分十进制或 IPv6（含冒号）。资产表的 ip 列只放地址，主机名走 primary_name。 */
function looksLikeIp(value) {
  const text = String(value || '').trim()
  if (!text) return false
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) {
    return text.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255)
  }
  return text.includes(':') && /^[0-9a-f:.]+$/i.test(text)
}

/** 把一行资产压成模型可读的紧凑结构（避免把整库原始数据塞进上下文）。 */
function compactAsset(a) {
  return {
    id: a.id,
    ip: a.ip,
    segment: a.segment_cidr,
    state: a.state,
    name: a.primary_name,
    names: a.names.map((n) => n.name),
    ports: a.ports.filter((p) => p.state === 'open')
      .map((p) => p.port + '/' + p.proto + (p.service ? ' ' + [p.service, p.product, p.version].filter(Boolean).join(' ') : '') + ' [' + p.provenance + ']'),
    /* 同一指纹在 80/443 会各有一条记录（端口证据保留在库），给模型看时按内容去重。 */
    fingerprints: Array.from(new Set(a.fingerprints.map((f) => [f.category, f.vendor, f.product, f.version].filter(Boolean).join(' ') + ' [' + f.provenance + ']'))),
    passive: a.passive,
    active: a.active,
    /* 发现时间：这条资产第一次进入本库的时刻（面板与报告都按它排时间线） */
    discovered_at: a.discovered_at,
    first_seen: a.first_seen,
    last_seen: a.last_seen,
    test_status: a.test_status,
    priority: a.priority,
  }
}

const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

/** 单条工具输出给模型的硬上限：超了就把中间内容换成一句提示，别让 pruner 把结构化结果切碎。 */
const MAX_TOOL_STREAM = 32000
function clipToolStream(value) {
  const raw = value === undefined || value === null ? '' : String(value)
  if (raw.length <= MAX_TOOL_STREAM) return raw
  return raw.slice(0, MAX_TOOL_STREAM)
    + '\n…（已截断 ' + (raw.length - MAX_TOOL_STREAM) + ' 字节；完整输出请重定向到文件，再用 file/read 分段看）'
}

/** 解析批量导入文件：JSONL（一行一条）或 JSON 数组；带行号，便于失败定位。 */
function parseJsonRows(raw) {
  const body = String(raw).replace(/^\uFEFF/, '').trim()
  if (body === '') return { items: [], errors: [{ line: 0, error: '文件为空' }] }
  if (body.startsWith('[')) {
    try {
      const list = JSON.parse(body)
      if (!Array.isArray(list)) return { items: [], errors: [{ line: 0, error: 'JSON 顶层不是数组' }] }
      /* 数组形态没有真实行号，用 1 起的下标代替 */
      return { items: list.map((value, i) => ({ line: i + 1, value })), errors: [] }
    } catch (error) {
      return { items: [], errors: [{ line: 0, error: 'JSON 解析失败：' + (error && error.message ? error.message : String(error)) }] }
    }
  }
  const items = []
  const errors = []
  body.split(/\r?\n/).forEach((line, i) => {
    const row = line.trim()
    if (row === '' || row.startsWith('#')) return
    try {
      items.push({ line: i + 1, value: JSON.parse(row) })
    } catch (error) {
      errors.push({ line: i + 1, error: 'JSON 解析失败：' + (error && error.message ? error.message : String(error)) })
    }
  })
  if (items.length === 0 && errors.length === 0) errors.push({ line: 0, error: '没有可导入的行' })
  return { items, errors }
}

/** 角色 code 的合法值说明（写进工具 description，模型不用猜）。 */
const ROLE_HINT = '角色 code：' + ROLE_ORDER.map((r) => '`' + r + '`（' + ROLE_TITLES[r] + '）').join('、')

/** 实时并发占用：读 subagents 注册表里"真正在跑"的直接子会话数。 */
async function liveRunningChildren(ctx, rootSessionId) {
  const subagents = ctx.get('subagents')
  if (subagents === undefined || subagents === null || typeof subagents.listChildren !== 'function') {
    return { available: false, running: 0, error: 'subagents 注册表不可用（无法核对实际并发数，只能按预留计数）' }
  }
  try {
    const entries = await subagents.listChildren(rootSessionId)
    const rows = Array.isArray(entries) ? entries : []
    const running = rows.filter((e) => e && e.kind === 'child' && e.activity === 'running')
    return {
      available: true,
      running: running.length,
      running_labels: running.map((e) => e.label || e.id).slice(0, 20),
      total_children: rows.filter((e) => e && e.kind === 'child').length,
    }
  } catch (error) {
    return { available: false, running: 0, error: '列子会话失败：' + (error && error.message ? error.message : String(error)) }
  }
}

/** 预留的有效期：派活失败/模型忘了 release 时不能让名额永久被占。 */
const RESERVATION_TTL_MS = 15 * 60 * 1000

function pruneReservations(map, now = Date.now()) {
  if (!map) return
  for (const [key, at] of map) {
    if (!Number(at) || now - Number(at) > RESERVATION_TTL_MS) map.delete(key)
  }
}

function reservationList(rootId) {
  const map = reservations.get(rootId)
  if (map === undefined) return []
  pruneReservations(map)
  return Array.from(map, ([key, at]) => ({ key, at }))
}

function addReservation(rootId, key) {
  if (!reservations.has(rootId)) reservations.set(rootId, new Map())
  const map = reservations.get(rootId)
  pruneReservations(map)
  map.set(key, Date.now())
}

function dropReservation(rootId, key) {
  const map = reservations.get(rootId)
  if (map === undefined) return false
  pruneReservations(map)
  if (key === undefined) {
    /* 无 key 时只释放最早的一条（与工具描述一致）——清空整张表会把别的在途预留一起放掉，名额超卖 */
    let oldestKey = null
    let oldestAt = Infinity
    for (const [k, at] of map) {
      if (at < oldestAt) { oldestAt = at; oldestKey = k }
    }
    return oldestKey !== null ? map.delete(oldestKey) : false
  }
  return map.delete(key)
}

/**
 * 产出这条记录的智能体角色：显式传的优先，否则默认按主会话记账。
 * 这个值会写进库里的 `agent` 列，报告里"这一步是谁做的"就靠它。
 */
function agentOf(args) {
  const raw = typeof args.agent === 'string' ? args.agent.trim() : ''
  return raw !== '' ? raw : PLANNER_ROLE
}

/** 写库工具共用的 agent 参数（角色 code 白名单提示写进 description）。 */
const AGENT_PARAM = {
  type: 'string',
  description: '【建议填】产出这条记录的角色 —— ' + ROLE_HINT
    + '。报告里会按它标注"这一步是谁做的"，不填按主会话记账。',
}

/**
 * 把 store 层抛出的异常统一收敛成结构化的失败返回。
 *
 * 为什么需要：同一类错误（对象不存在 / 参数非法）此前有两种形态 ——
 * 有的工具 `return { ok:false, error }`，有的直接抛。模型拿到前者能换参数重试，
 * 拿到后者往往直接放弃这一次调用，行为不可预测。统一成前者，且**不吞原始信息**。
 * @param tool - defineTool 的返回值。
 * @returns 包了一层 try/catch 的同一个工具定义。
 */
function withStructuredErrors(tool) {
  const inner = tool.execute
  if (typeof inner !== 'function') return tool
  return Object.assign({}, tool, {
    async execute(args, exec) {
      try {
        return await inner(args, exec)
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        /* 参数类错误（非法值/缺必填）与"找不到对象"分开提示，模型据此决定重试还是放弃 */
        const kind = /非法|invalid|required|不能为空|not found|不存在/i.test(message) ? 'bad_input' : 'failed'
        return JSON.stringify({
          ok: false,
          error: message,
          error_kind: kind,
          hint: kind === 'bad_input'
            ? '这是参数或对象标识的问题：核对参数名与取值（可用对应的 *_list / *_query 工具先看实际 id），修正后重试。'
            : '工具执行失败，错误原文见 error 字段；不要静默跳过，先向用户或指挥者说明卡点。',
        }, null, 2)
      }
    },
  })
}

export function apply(ctx, config = {}) {
  /* 执行角色只拿到白名单动作：换靶标 / 重置角色稿 / 出报告这类控制动作留在主会话。
     不传 actions 的主会话仍拿完整动作表。 */
  const allowed = new Set(
    (Array.isArray(config.actions) ? config.actions : [])
      .map((name) => String(name || '').trim().replace(/^redteam_/, ''))
      .filter(Boolean),
  )
  let store
  try {
    store = ctx.redteam
  } catch {
    store = undefined
  }
  if (!store) {
    try { store = ctx.get('redteam') } catch { store = undefined }
  }
  if (!store) {
    ctx.logger?.warn?.('redteam-tools: host ctx.redteam unavailable — tools will report store_missing')
    store = {
      openEngagement: () => { throw new Error('redteam store unavailable') },
      listEngagements: () => [],
      stats: () => ({}),
    }
  }

  /* 动作先收进 collected，最后只注册一个入口；参数结构按需取。 */
  const collected = new Map()
  const collect = (tool) => {
    if (tool && typeof tool.name === 'string') collected.set(tool.name, tool)
    return tool
  }

  /* ── 子智能体结束时自动释放并发名额（不依赖模型记得调 release）──────────── */
  /* ctx.effect 包起来 → plugin dispose 时解绑 subagent/end,否则 handler 残留 + 热重载翻倍。 */
  ctx.effect(() => {
    let disposer = null
    try {
      disposer = ctx.on('subagent/end', (info, parent) => {
        const parentSession = parent && parent.session
        const { rootId } = bindingKeyOf({ agent: { session: parentSession } })
        const childId = info && info.id !== undefined ? String(info.id) : undefined
        if (childId !== undefined) dropBinding(childId)
        if (rootId === undefined) return
        if (childId !== undefined && dropReservation(rootId, childId)) return
        /* 注册表里的键可能与 runId 不同：按时间兜底清掉最早的一个预留 */
        const map = reservations.get(rootId)
        if (map === undefined || map.size === 0) return
        let oldestKey
        let oldestAt = Number.POSITIVE_INFINITY
        for (const [key, at] of map) { if (at < oldestAt) { oldestAt = at; oldestKey = key } }
        if (oldestKey !== undefined) map.delete(oldestKey)
      })
    } catch { /* 事件不可用时只影响自动释放，手动 release 仍然可用 */ }
    return () => { try { if (typeof disposer === 'function') disposer() } catch { /* ignore */ } }
  })

  collect(withStructuredErrors(defineTool({
    name: 'redteam_engagement_open',
    description: '打开或创建一次攻防演练靶标（按单位名称），并把**当前会话**绑定到该靶标。后续所有资产工具默认作用于它。若靶标已存在则复用其资产库。写入的是本会话的绑定，不会改动其它会话正在用的靶标。**子会话不会自动继承**：派活时在任务书第一行写 `engagement: <靶标 id>`，子会话开工先用 session_bind 绑上。',
    parameters: {
      target: { type: 'string', required: true, description: '靶标单位名称，例如「示例科技有限公司」' },
      scope: {
        type: 'array',
        description: '范围列表（可选）。每项写 IP、网段、IP 段、域名、*.通配 或 URL，例如 10.20.30.0/24、10.20.30.1-50、oa.example.com、*.example.com、https://oa.example.com:8443/login（URL 只取主机与端口）。0.0.0.0/8、组播、:: 这类不可用地址会被拒绝',
        items: { type: 'string' },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      /* bindCurrent: false —— 工具解析只用本会话绑定，避免多会话串写；
         然后把展示用的「当前靶标」指过来，面板才会跟着这次任务切。 */
      const engagement = store.openEngagement(args.target, args.scope, { bindCurrent: false })
      bindEngagement(exec, engagement.id)
      const view = bindingViewOf(exec)
      /* 子会话只绑自己，不能把面板当前靶标带跑；主会话才同步展示指针。 */
      if (!view.is_subagent) store.setActiveEngagement(engagement.id)
      return JSON.stringify({
        ok: true,
        engagement,
        stats: store.stats(engagement.id),
        session: view,
        note: '已绑定到本会话（会话隔离：其它会话的绑定不受影响）；子会话不会自动继承，派活时在任务书第一行写 engagement: ' + engagement.id + '，子会话开工先 session_bind。'
          + (view.is_subagent ? ' 注意：本会话是子智能体，通常不需要再 open，直接 session_bind 父会话给你的靶标即可。' : ''),
      }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_session_bind',
    description: '把一个**已经存在**的靶标绑定到当前会话（多会话并行时用：每个会话绑自己的靶标，互不串写）。可用靶标 id 或单位名称，省略则列出可绑定的靶标。',
    parameters: {
      engagement: { type: 'string', description: '靶标 id 或单位名称；省略只列出候选' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const list = store.listEngagements()
      const wanted = typeof args.engagement === 'string' ? args.engagement.trim() : ''
      if (wanted === '') {
        return JSON.stringify({
          ok: false,
          candidates: list.map((e) => ({ id: e.id, name: e.name, created_at: e.created_at, stats: e.stats })),
          note: '请传 engagement（靶标 id 或单位名称）完成绑定。',
        }, null, 2)
      }
      const hit = list.find((e) => e.id === wanted)
        || list.find((e) => String(e.name) === wanted)
        || list.find((e) => String(e.name).includes(wanted))
      if (hit === undefined) {
        return JSON.stringify({ ok: false, error: '靶标不存在：' + wanted, candidates: list.map((e) => e.id) }, null, 2)
      }
      bindEngagement(exec, hit.id)
      const view = bindingViewOf(exec)
      if (!view.is_subagent) store.setActiveEngagement(hit.id)
      return JSON.stringify({
        ok: true, engagement: { id: hit.id, name: hit.name },
        session: view,
        note: '本会话已绑定到「' + hit.name + '」；后续工具与报告都只作用于它。',
      }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_session_info',
    description: '查看**当前会话绑定的是哪个靶标**（会话 id、父会话、根会话、绑定链）。多会话同时开工时，先跑它确认自己没串到别人的靶标上。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(_args, exec) {
      const view = bindingViewOf(exec)
      const changed = view.bound_engagement !== null ? store.stats(view.bound_engagement) : null
      return JSON.stringify({
        ok: true, session: view, stats: changed,
        bindings_now: bindingsNow(),
        note: '绑定是进程内状态：DeepSeek Harness 重启后各会话需要重新绑定一次（redteam_engagement_open / redteam_session_bind）。',
      }, null, 2)
    },
  })))

  /* 搜索通道只有宿主那一条（DeepSeek 搜索），它的 key 不在插件手里；
     判它能不能用只能真搜一次——配置存在不等于 key 有效，401 只有发请求才看得见。 */
  const probeWebSearch = async () => {
    let web = null
    try { web = typeof ctx.get === 'function' ? ctx.get('web') : null } catch { web = null }
    const fallback = '搜索不可用：用 `browser` 开搜索引擎，或直接抓已知网址；别停在这条路上'
    if (!web || typeof web.search !== 'function') {
      return { status: 'unknown', detail: '宿主没有暴露 web 服务，判不了', fallback }
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 20000)
    try {
      const res = await web.search({ query: 'tool preflight connectivity check', maxResults: 1 }, ctrl.signal)
      const n = Array.isArray(res && res.sources) ? res.sources.length : 0
      return { status: 'available', sources: n, fallback: '' }
    } catch (error) {
      const text = String(error && error.message ? error.message : error).split('\n')[0]
      return { status: 'broken', detail: text.slice(0, 240), fallback }
    } finally {
      clearTimeout(timer)
    }
  }

  collect(withStructuredErrors(defineTool({
    name: 'redteam_preflight',
    description: '【开工前自检】平台技能与资源自检：逐个检查红队技能的必需环境变量（如 FOFA 测绘的 FOFA_KEY）、本机工具与二进制（suo5 / fscan / frp / 冰蝎 / 哥斯拉 / nmap / nuclei…）、外部基础设施（反弹 Shell 用的 VPS）、以及网页搜索通道能不能真搜出结果。返回 available/broken 清单与每个坏掉的技能"缺什么、怎么补"。**缺 key / 缺 VPS 时直接向用户要，或改用替代方案，不要假装能跑。**',
    parameters: {
      include: { type: 'string', description: '只检查这些技能（逗号分隔）；省略则检查全部红队技能' },
      skeletons: { type: 'boolean', description: '是否下发技能判据骨架，默认 true；已经拿过一遍、只想复核环境时传 false' },
      net: { type: 'boolean', description: '是否实测本机出网（DNS/TCP/代理握手），默认 true；只想快速看工具路径时传 false' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      let skills
      try { skills = typeof ctx.get === 'function' ? ctx.get('skills') : null } catch { skills = null }
      /* 数据根可能是 REDTEAM_HOME 指定的别的盘：配置、密钥、toolkit 都跟着它走，
         否则 preflight 会去 $DSH_HOME 读一份空的 config，把已配好的工具全报成缺失。 */
      const dataRoot = store && store.root ? store.root : undefined
      const plat = platformSummary(dataRoot)
      const corePlat = corePlatformView(plat)
      const cfg = loadPlatformConfig(dataRoot)
      const egress = args.net === false ? null : await probeEgress(cfg)
      const webSearch = args.net === false ? null : await probeWebSearch()
      /* 环境变量的真实来源：进程环境 + $DSH_HOME/.env + 平台 config.json env */
      const envFile = readEnvFile()
      const effectiveEnv = effectiveEnvOf(dataRoot, cfg)
      const envFileKeys = envFile.keys

      const toolkit = toolkitDirOf(cfg, dataRoot)
      let toolkitEntries = []
      try {
        if (existsSync(toolkit)) {
          const { readdirSync } = await import('node:fs')
          toolkitEntries = readdirSync(toolkit).slice(0, 60)
        }
      } catch { /* 忽略 */ }

      const redteamDir = dataRoot || expandSkillPath('$DSH_HOME/redteam')
      const markerFile = redteamDir + '/.setup-complete'
      const hasMarker = existsSync(markerFile)
      const toolkitHint = '工具放 $DSH_HOME/tools 或「环境适配」配置的目录；模型可下载到 $DSH_HOME/tools 后 toolbox sync。FOFA_KEY / VPS 仍在「环境适配」填。'
      let fofaKey = effectiveEnv.FOFA_KEY || ''
      if (!fofaKey) {
        try { fofaKey = await loadSecret(store && store.root ? store.root : undefined, 'fofa') } catch { fofaKey = '' }
      }
      if (fofaKey && !effectiveEnv.FOFA_KEY) effectiveEnv.FOFA_KEY = fofaKey
      const vps = vpsSummary(store && store.root ? store.root : undefined)
      const oast = oastSummary(store && store.root ? store.root : undefined)
      const vpsHost = vps.host || ''
      const hasVps = vps.configured
      const missing = []
      if (fofaKey === '') missing.push('FOFA_KEY（资产测绘：在「环境适配」页填写，或写进 $DSH_HOME/.env）')
      if (!hasVps) {
        missing.push('VPS（在「环境适配」填主机 / 端口 / 账号 / 密码，测试后可改用密钥）')
      }
      if (!oast.configured) {
        missing.push('CEYE 域名（盲 SSRF / 盲 RCE 回连验证需要；在「环境适配」填域名与 token）')
      }
      const runtimeHint = '当前为 **Windows 适配**：请在靶场「环境适配」页配置工具路径/搜索目录与 FOFA/VPS。仍建议用专用演练机，勿在日常办公机上落私钥与扫描器。'

      let checked = []
      let allBroken = []
      let allAvailable = []
      let broken = []
      let available = []
      let only = splitList(args.include)
      let unknownIncludes = []

      const bundledSkills = bundledSkillSummaries()
      const skillsMissing = skills === undefined || skills === null || typeof skills.list !== 'function'
      if (skillsMissing && bundledSkills.length === 0) {
        /* 桌面端常无 skills inject：仍返回平台工具探测，避免整条 preflight 报废 */
        const toolMissing = (corePlat.tools.items || []).filter((t) => !t.path).map((t) => t.id)
        const onboarding = {
          complete: hasMarker && missing.length === 0,
          runtime_hint: runtimeHint,
          first_run: !hasMarker,
          marker: { path: markerFile, exists: hasMarker },
          toolkit_hint: toolkitHint,
          configured: {
            fofa_key: fofaKey === '' ? 'missing' : 'configured',
            vps_key: vps.native ? vps.nativeKeyPath : (vps.auth === 'key' ? 'encrypted' : 'missing'),
            vps_host: vpsHost,
            vps: vps,
          vps_hint: vps.native
            ? '原生 ssh 已开启：用 ssh -i ' + vps.nativeKeyPath + ' ' + vps.user + '@' + vps.host + '；私钥文件可被本机进程读取。'
            : 'VPS 命令统一用 redteam_vps_exec；私钥已加密保存，不要尝试读取或直接 ssh。',
            oast: oast,
            oast_hint: oast.configured
              ? 'CEYE 域名 ' + oast.domain + '；用 redteam_oast_poll 查 DNS/HTTP 记录。'
              : 'CEYE 未配置：盲 SSRF/RCE/XXE 无法回连验证。',
            env_file: { path: envFile.path, exists: envFile.exists, keys: envFileKeys },
            platform_config: { path: cfg.path, exists: !!cfg.exists },
          },
          web_search: webSearch,
          missing,
        }
        if (!hasMarker) markSetupComplete(markerFile)
        return JSON.stringify({
          ok: missing.length === 0,
          onboarding,
          web_search: webSearch,
          platform: corePlat,
          toolkit: { dir: toolkit, exists: existsSync(toolkit), entries: toolkitEntries, hint: toolkitHint },
          tool_missing: toolMissing,
          toolbox_hint: '工具箱里的其他工具不默认列出；需要时用 toolbox find <关键词> 检索，open/run 后才会进入默认工具页。',
          skills_root_hint: '宿主 skills 服务不可用：已跳过技能正文体检，仅返回平台工具探测。请到「环境适配」配置路径。',
          next: '打开红队面板「环境适配」：① 填 binDirs 或逐个 tools 路径 ② 填 FOFA_KEY / VPS ③ 保存后重新 preflight。',
        }, null, 2)
      }

      let summaries = []
      let fromBundle = skillsMissing
      let scoped = false
      if (fromBundle) {
        summaries = bundledSkills
      } else {
        try {
          let scope = null
          try {
            const presets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : null
            if (presets && typeof presets.standingKeyFor === 'function') {
              scope = await presets.standingKeyFor('redteam')
            }
          } catch { scope = null }
          scoped = scope != null
          const listed = scoped ? await skills.list({ scope }) : await skills.list()
          summaries = redteamSummariesForCheck(listed, bundledSkills, scoped)
          fromBundle = summaries.every((item) => item && item.library === 'redteam' && item.content)
        } catch (error) {
          if (bundledSkills.length === 0) {
            return JSON.stringify({ ok: false, error: '读取技能目录失败：' + (error && error.message ? error.message : String(error)), platform: corePlat }, null, 2)
          }
          summaries = bundledSkills
          fromBundle = true
        }
      }
      summaries = redteamSummariesForCheck(summaries, bundledSkills, scoped)
      const onlyLower = new Set(only.map((n) => n.toLowerCase()))
      const matchesOnly = (name) => onlyLower.size === 0 || onlyLower.has(String(name).toLowerCase())
      const wanted = summaries.filter((s) => matchesOnly(s.name))
      /* include 时只体检点名的技能：否则 ok 被无关 broken 拖成 false，模型会误以为目标技能坏了 */
      const toCheck = only.length > 0 ? wanted : summaries
      unknownIncludes = Array.from(new Set(only.filter((n) => !summaries.some((s) => String(s.name).toLowerCase() === n.toLowerCase()))))
      const rootsWith = new Map()
      for (const x of summaries) {
        const dir = x.resourceBase && x.resourceBase.kind === 'directory' ? x.resourceBase.path : null
        if (dir === null) continue
        if (!rootsWith.has(x.name)) rootsWith.set(x.name, [])
        if (!rootsWith.get(x.name).includes(dir)) rootsWith.get(x.name).push(dir)
      }
      for (const summary of toCheck) {
        let def
        if (!fromBundle && skills && typeof skills.get === 'function') {
          try { def = await skills.get(summary.name) } catch { def = undefined }
        }
        const path = def && typeof def.path === 'string'
          ? def.path
          : (typeof summary.path === 'string'
            ? summary.path
            : (summary.resourceBase && summary.resourceBase.kind === 'directory' ? summary.resourceBase.path : null))
        const root = summary.resourceBase && summary.resourceBase.kind === 'directory' ? summary.resourceBase.path : null
        const content = def && typeof def.content === 'string' && def.content.trim() !== ''
          ? def.content
          : summary.content
        const verdict = checkSkill({ name: summary.name, content, path, root },
          { env: effectiveEnv, sameNameIn: rootsWith.get(summary.name) || [] })
        checked.push(Object.assign({}, verdict, {
          title: summary.description,
          path,
          when_to_use: summary.whenToUse || '',
          needs_user: verdict.needs_user.map((n) => (n.startsWith('环境变量')
            ? n + (plat.runtime.windows ? '（可在「环境适配」页填写）' : '（拿到后 export 并重启 DeepSeek Harness 服务）')
            : n === 'VPS 地址' || n === 'VPS 主机名'
              ? '反弹 Shell / 载荷投递用的 ' + n + '（技能里还是占位符）'
              : n)),
        }))
      }
      allBroken = checked.filter((s) => s.status === 'broken')
      allAvailable = checked.filter((s) => s.status === 'available')
      const shown = (x) => matchesOnly(x.name)
      broken = allBroken.filter(shown)
      available = allAvailable.filter(shown)
      const toolMissing = (corePlat.tools.items || []).filter((t) => !t.path).map((t) => t.id)
      const needsUser = Array.from(new Set(broken.flatMap((s) => s.needs_user)))
      const summary = summarizeSkills(checked)
      const onboarding = {
        complete: hasMarker && checked.length > 0 && missing.length === 0 && allBroken.length === 0 && summary.unknown === 0,
        runtime_hint: runtimeHint,
        first_run: !hasMarker,
        marker: { path: markerFile, exists: hasMarker },
        toolkit_hint: toolkitHint,
        configured: {
          fofa_key: fofaKey === '' ? 'missing' : 'configured',
          vps_key: vps.native ? vps.nativeKeyPath : (vps.auth === 'key' ? 'encrypted' : 'missing'),
          vps_host: vpsHost,
          vps: vps,
          vps_hint: vps.native
            ? '原生 ssh 已开启：用 ssh -i ' + vps.nativeKeyPath + ' ' + vps.user + '@' + vps.host + '；私钥文件可被本机进程读取。'
            : 'VPS 命令统一用 redteam_vps_exec；私钥已加密保存，不要尝试读取或直接 ssh。',
            oast: oast,
            oast_hint: oast.configured
              ? 'CEYE 域名 ' + oast.domain + '；用 redteam_oast_poll 查 DNS/HTTP 记录。'
              : 'CEYE 未配置：盲 SSRF/RCE/XXE 无法回连验证。',
          env_file: { path: envFile.path, exists: envFile.exists, keys: envFileKeys },
          platform_config: { path: cfg.path, exists: !!cfg.exists },
        },
        web_search: webSearch,
        missing,
      }
      let next
      if (unknownIncludes.length > 0) {
        next = 'include 里这些技能名没匹配上：' + unknownIncludes.join(', ') + '；核对名称后重跑（技能名大小写不敏感）。'
      } else if (!hasMarker) {
        next = '首次使用：把 onboarding.missing 一次性列给用户；补不齐说明降级（无 FOFA 用 crt.sh，无 VPS 不落地）。'
      } else if (missing.length > 0) {
        next = '有缺口：把 onboarding.missing 一次性列给用户，配置入口是「环境适配」。'
      } else if (allBroken.length > 0) {
        next = '把 broken 里 needs_user 一次性列给用户；补不齐说明降级。'
      } else if (summary.unknown > 0) {
        next = '有 ' + summary.unknown + ' 篇技能判不了（正文读不到），不能算全部可用；需要时用 skill 工具取全文。'
      } else {
        next = '全部可用，可以开工。'
      }
      /* 搜索通道挂了叠加在 any next 上：它不挡开工，但必须让模型知道换哪条路。 */
      if (webSearch && webSearch.status === 'broken') {
        next += ' 搜索通道不可用（' + webSearch.detail + '）：要查东西就换 `browser` 开搜索引擎，别停在 web_search 上；顺手把这条告诉操作者。'
      }

      /* 判据骨架：一篇十几行，随 preflight 一次性下发，替代整篇装载 */
      const skeletons = checked.length === 0
        ? ''
        : Object.keys(SKELETONS)
          .filter((n) => checked.some((s) => s.name === n))
          .map((n) => renderSkeleton(n, SKELETONS[n]))
          .join('\n\n')
      if (!hasMarker) markSetupComplete(markerFile)
      /* 预设“磁盘上写了什么”和“会话里真正挂上什么”经常不是一回事：
         harden 会补缺失行，旧人格会被随包稿替换。把生效结果直接报出来，避免按磁盘猜。 */
      let presetInfo = null
      try {
        if (!dataRoot) throw new Error('no data root')
        const raw = JSON.parse(readFileSync(join(dataRoot, 'preset-declare.json'), 'utf8'))
        presetInfo = {
          ok: raw.ok === true,
          phase: raw.phase,
          plugins: raw.plugins,
          disk_components: raw.disk_components,
          effective_components: raw.effective_components,
          injected_components: raw.injected_components,
          persona_source: raw.persona_source,
          persona_legacy_replaced: raw.persona_legacy_replaced || undefined,
          broken: raw.broken || undefined,
        }
      } catch { presetInfo = null }
      return JSON.stringify({
        /* include 模式：ok 只反映点名技能的体检结果；测绘 key/VPS 等 missing 与此无关，降为参考不拖 ok */
        ok: checked.length > 0 && unknownIncludes.length === 0 && allBroken.length === 0
          && summary.unknown === 0 && (only.length > 0 || missing.length === 0),
        /* 工具缺失只提示，不把 preflight 判死：AI 可以按任务自己下载。 */
        tool_missing: toolMissing,
        include: only.length > 0 ? {
          requested: only,
          unknown: unknownIncludes,
          note: '技能名大小写不敏感；ok 只覆盖点名的技能；onboarding.missing 是全局参考，不影响本次 ok',
        } : undefined,
        all_checked: { registry_total: summaries.length, checked: checked.length, broken: allBroken.length, available: allAvailable.length },
        onboarding,
        platform: corePlat,
        agent_preset: presetInfo,
        toolbox_hint: '工具箱里的其他工具不默认列出；需要时用 toolbox find <关键词> 检索，open/run 后才会进入默认工具页。',
        egress,
        web_search: webSearch,
        summary,
        lessons: (() => {
          try {
            const eid = resolveEngagement(store, exec, undefined)
            const items = store.lessonList(eid, { limit: 5, exclude_categories: ['negative'] })
            if (!items.length) return undefined
            return '【同类栈经验·上次在同栈上验过的判断，先按它决策；与现场冲突以现场为准】\n'
              + items.map((l) => '· [' + (l.category || 'other') + (l.component ? '/' + l.component : '/通用') + '] '
                + l.title + '：' + l.content).join('\n')
          } catch { return undefined }
        })(),
        negative_lessons: (() => {
          try {
            const eid = resolveEngagement(store, exec, undefined)
            const items = store.lessonList(eid, { limit: 5, categories: ['negative'] })
            if (!items.length) return undefined
            return '【已排除/误报·先看这里】\n'
              + items.map((l) => '· ' + l.title + '：' + l.content).join('\n')
          } catch { return undefined }
        })(),
        skeletons: args.skeletons === false || skeletons === '' ? undefined : skeletons,
        skeletons_hint: args.skeletons === false || skeletons === '' ? undefined : '以上是各技能的判据骨架，日常依此决策即可；真要执行某篇的命令时用 skill 工具取全文。',
        engagement: (() => {
          try {
            const eid = resolveEngagement(store, exec, undefined)
            const st = store.stats(eid)
            return { id: eid, assets: st.assets, untested: store.untestedAssetIds(eid).length, vulns: st.vulns }
          } catch { return null }
        })(),
        checked: checked.length,
        available: available.map((s) => s.name),
        broken: broken.map((s) => ({ name: s.name, problems: s.problems, needs_user: s.needs_user,
          fixes: (s.issues || []).map((i) => i && i.fix).filter(Boolean),
          fix_note: '用户可放到配置目录，或由模型下载到 $DSH_HOME/tools 后 toolbox sync；不要把工具装进系统目录或项目工作目录。' })),
        unknown: checked.filter((s) => s.status === 'unknown').map((s) => s.name),
        toolkit: { dir: toolkit, exists: existsSync(toolkit), entries: toolkitEntries, hint: toolkitHint },
        skills_root_hint: '这里只检查红队技能。官方技能在 $DSH_HOME/skills，不按红队工具路径判不可用。',
        next,
        needs_user_flat: needsUser,
        wanted_count: wanted.length,
      }, null, 2)
    },
  })))

  /* VPS 代跑：密码模式也不把密码交给模型，命令在宿主里连。 */
  collect(withStructuredErrors(defineTool({
    name: 'redteam_vps_exec',
    description: '在 VPS 上执行一条 shell 命令并返回输出。密钥/密码模式都走这里；密码不会出现在参数或返回里。用于反弹监听、下载载荷、检查端口、清理进程。长任务用 nohup/screen 自行后台化。',
    parameters: {
      command: { type: 'string', required: true, description: '要在 VPS 上执行的命令' },
      timeout_ms: { type: 'number', description: '超时毫秒，默认 20000，最大 120000' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const root = store && store.root ? store.root : undefined
      const r = await vpsExec(root, args.command, { timeoutMs: args.timeout_ms })
      return JSON.stringify({
        ok: r.code === 0,
        code: r.code,
        stdout: clipToolStream(r.stdout),
        stderr: clipToolStream(r.stderr),
      }, null, 2)
    },
  })))

  /* VPS 文件传输：固定远端目录，落地到固定下载目录，SHA-256 校验。 */
  collect(withStructuredErrors(defineTool({
    name: 'redteam_vps_put',
    description: '把本地文件上传到 VPS 的 ~/dsh-forge/files/。只接受工作区、工具箱或 $DSH_HOME 内的文件；远端只按文件名落盘，不接受路径。默认不覆盖同名文件，上传后做 SHA-256 校验。',
    parameters: {
      local_path: { type: 'string', required: true, description: '本地文件绝对路径或相对当前工作区的路径' },
      remote_name: { type: 'string', description: '远端文件名，省略则用本地文件名' },
      overwrite: { type: 'boolean', description: '允许覆盖远端同名文件，默认 false' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const root = store && store.root ? store.root : undefined
      const cwd = exec?.agent?.session?.header?.cwd
      const r = await vpsPut(root, args.local_path, args.remote_name, { cwd, overwrite: args.overwrite === true })
      return JSON.stringify(r, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_vps_get',
    description: '从 VPS 的 ~/dsh-forge/files/ 下载文件到本机 $DSH_HOME/redteam/downloads/。只按文件名取，不接受路径；默认不覆盖本地同名文件，下载后做 SHA-256 校验。',
    parameters: {
      remote_name: { type: 'string', required: true, description: '远端文件名（只允许字母、数字、点、下划线、连字符）' },
      overwrite: { type: 'boolean', description: '允许覆盖本地同名文件，默认 false' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const root = store && store.root ? store.root : undefined
      const r = await vpsGet(root, args.remote_name, { overwrite: args.overwrite === true })
      return JSON.stringify(r, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_oast_poll',
    description: '查 CEYE 的 DNS / HTTP 记录。用于验证盲 SSRF、盲 RCE、XXE、SQLi 回连。filter 默认使用已配置的 CEYE 域名，最长 20 字符。token 不会出现在参数或返回里。',
    parameters: {
      type: { type: 'string', enum: ['dns', 'request'], description: '查 DNS 还是 HTTP 请求，默认 dns' },
      filter: { type: 'string', description: '按域名/URL 片段过滤，最长 20 字符；默认使用已配置的 CEYE 域名' },
      limit: { type: 'number', description: '最多返回几条，默认 50，最大 200' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const root = store && store.root ? store.root : undefined
      const r = await oastPoll(root, { type: args.type, filter: args.filter, limit: args.limit })
      return JSON.stringify(r, null, 2)
    },
  })))

  /* 作战简报：给子会话/下一轮的最小上下文。只回摘要，明细让调用方按需再查。 */
  collect(withStructuredErrors(defineTool({
    name: 'redteam_brief',
    description: '拿一份可直接派活的作战简报：靶标、范围、资产/漏洞统计、待人工复核、未测资产前几条、覆盖矩阵汇总。只回结构化摘要，不回明细——派子会话时把它放进任务书，子会话不用重新摸一遍家底。',
    parameters: {
      engagement: { type: 'string' },
      limit: { type: 'number', description: '每类最多几条，默认 8，最大 30' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const cap = Math.max(1, Math.min(Number(args.limit) || 8, 30))
      const meta = (store.listEngagements() || []).find((e) => e.id === id) || {}
      const st = store.stats(id)
      let pending = []
      try { pending = (store.listVulns(id, { status: 'pending', limit: cap, with_http_evidence: false }) || {}).items || [] } catch { pending = [] }
      let untestedIds = null
      try { untestedIds = new Set(store.untestedAssetIds(id)) } catch { /* 老库没有矩阵数据时退回原始计数 */ }
      let matrix = null
      try { matrix = store.matrixSummary(id) } catch { /* 老库没有矩阵数据 */ }
      /* 模型只看四个数字没法补：把“哪个资产缺哪几类”直接带出来。 */
      let matrixGaps = null
      try { matrixGaps = store.matrixGaps(id, { limit: cap }) } catch { matrixGaps = null }
      let untested = []
      try {
        const rows = (store.listAssets(id, { limit: 1000, sort: 'priority' }) || {}).items || []
        untested = untestedIds
          ? rows.filter((a) => untestedIds.has(a.id))
          : rows.filter((a) => String(a.test_status || 'untested') === 'untested')
      } catch { untested = [] }
      /* 入口清单的载体是 coverage.surface + note；brief 直接把 distinct surface 带出来，
         下一轮/新窗口不用重列，也不用翻全表。 */
      let entries = []
      try {
        const cov = store.coverageList(id, {})
        const seen = new Map()
        for (const row of cov.items || []) {
          const surface = String(row.surface || '').trim()
          if (!surface) continue
          const cur = seen.get(surface) || { surface, asset_id: row.asset_id ?? undefined, classes: [], note: '' }
          if (row.test_class && !cur.classes.includes(row.test_class)) cur.classes.push(row.test_class)
          if (!cur.note && row.note) cur.note = row.note
          seen.set(surface, cur)
        }
        entries = Array.from(seen.values()).slice(0, cap)
      } catch { entries = [] }
      let tools = []
      try { tools = store.toolList(id).items || [] } catch { tools = [] }
      const blockedTools = tools.filter((t) => t.status === 'blocked').map((t) => t.name)
      const recentTools = tools.slice(0, 5).map((t) => ({ name: t.name, uses: t.uses, status: t.status || undefined }))
      let hyp = null
      try { hyp = store.hypothesisStats(id) } catch { hyp = null }
      /* 失败归因：blocked/refuted 是"这台资产上已知打不通/已证伪"的方向，
         下一轮先看这里，避免换天/换窗口后重撞同一堵墙。 */
      let blockedDirs = []
      let refutedDirs = []
      try { blockedDirs = (store.listHypotheses(id, { status: 'blocked', limit: cap }) || {}).items || [] } catch { blockedDirs = [] }
      try { refutedDirs = (store.listHypotheses(id, { status: 'refuted', limit: cap }) || {}).items || [] } catch { refutedDirs = [] }
      const direction = (h) => ({
        surface: h.surface, asset_ip: h.asset_ip || undefined, vuln_class: h.vuln_class || undefined,
        why: h.why || undefined, basis: h.basis || undefined, closed_at: h.closed_at || undefined,
      })
      return JSON.stringify({
        ok: true,
        engagement: id,
        target: meta.name || id,
        scope: meta.scope || [],
        counts: {
          assets: st.assets, live: st.liveAssets, open_ports: st.openPorts,
          vulns: st.vulns, credentials: st.credentials, accesses: st.accesses,
          untested: untestedIds ? untestedIds.size : st.untestedAssets, blocked: st.blockedAssets,
          coverage_cells: matrix ? { tested: matrix.tested_cells, total: matrix.cells, gaps: matrix.gaps, exempt_assets: matrix.exempt_assets } : undefined,
          ...(hyp ? { hypotheses: hyp } : {}),
        },
        pending_review: pending.slice(0, cap).map((v) => ({ id: v.id, title: v.title, severity: v.severity, status: v.status })),
        untested_assets: untested.slice(0, cap).map((a) => ({ id: a.id, ip: a.ip, name: a.primary_name || undefined, priority: a.priority, open_ports: a.open_ports })),
        matrix_gaps: matrixGaps && matrixGaps.items.length
          ? {
            total_missing_cells: matrixGaps.total_missing_cells,
            assets_with_gaps: matrixGaps.assets_with_gaps,
            items: matrixGaps.items,
            hint: matrixGaps.hint,
          }
          : undefined,
        entry_surfaces: entries.length ? entries : undefined,
        blocked_directions: blockedDirs.length ? blockedDirs.slice(0, cap).map(direction) : undefined,
        refuted_directions: refutedDirs.length ? refutedDirs.slice(0, cap).map(direction) : undefined,
        tools: tools.length ? { blocked: blockedTools, recent: recentTools } : undefined,
        note: '当前家底摘要。matrix_gaps 直接列出缺哪几类；不适用类用 coverage op=skip_rest 批量标。blocked/refuted 是已知打不通/已证伪的方向，先看再排下一轮，不要重复撞。',
      }, null, 2)
    },
  })))

  /* 工具清单：使用次数来自既有记录，人工标注由面板写；模型按需查。 */




  collect(withStructuredErrors(defineTool({
    name: 'redteam_agent_slot',
    description: '【可选】子智能体并发状态：action=status 看当前在跑几个与上限；acquire 占名额；release 释放（子智能体结束时服务端会自动释放）。只在确需并行时用。',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'acquire', 'release'], description: 'status 查看 / acquire 占用 / release 释放' },
      label: { type: 'string', description: 'acquire 时的任务标签，例如「信息收集：主域与 C 段」' },
      key: { type: 'string', description: 'release 时指定要释放的键（省略则释放最早的一个预留）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const { rootId, sessionId } = bindingKeyOf(exec)
      const owner = rootId ?? sessionId
      if (owner === undefined) {
        return JSON.stringify({ ok: false, error: '取不到会话 id：无法统计并发（请确认工具调用带着 agent 上下文）。' }, null, 2)
      }
      const live = await liveRunningChildren(ctx, owner)
      const reserved = reservationList(owner)
      /* 注册表里 running 的子会话已经包含正在跑的；预留是"刚占位还没出现在注册表"的那部分，
         两者取较大值，避免重复计数又不会漏计 */
      const used = Math.max(live.running, reserved.length)
      const cap = maxAgentsNow(ctx)
      const free = Math.max(cap - used, 0)
      const base = {
        ok: true, max: cap, used, free,
        running_from_registry: live.running,
        running_labels: live.running_labels ?? [],
        reservations: reserved,
        registry_available: live.available,
        registry_note: live.available ? undefined : live.error,
      }
      if (args.action === 'status') {
        return JSON.stringify(Object.assign(base, {
          hint: free === 0
            ? '名额已满：等现有智能体回报后再派（每次只派一个、按顺序推进是最稳的节奏）。'
            : '还有 ' + free + ' 个名额。默认一个一个派；只有确实互不依赖的活才并行。',
        }), null, 2)
      }
      if (args.action === 'acquire') {
        if (free <= 0) {
          return JSON.stringify(Object.assign(base, {
            ok: false,
            error: '并发已满（最多 ' + cap + ' 个）：现在不能派新智能体。先等当前的在跑智能体回报，或先 release 掉已经结束的。',
          }), null, 2)
        }
        const key = (typeof args.label === 'string' && args.label.trim() !== '' ? args.label.trim() : 'slot') + '#' + Date.now()
        addReservation(owner, key)
        return JSON.stringify(Object.assign(base, { slot: key, used: used + 1, free: Math.max(cap - used - 1, 0) }, {
          hint: '已占位（' + key + '）。**派完之后要记得**：子智能体结束会自动释放；若你派活失败（比如工具报错），手动 redteam_agent_slot action=release key=' + key + ' 把它放掉。',
        }), null, 2)
      }
      const dropped = dropReservation(owner, typeof args.key === 'string' && args.key.trim() !== '' ? args.key.trim() : undefined)
      return JSON.stringify(Object.assign(base, {
        ok: dropped,
        released: dropped,
        used: Math.max(used - (dropped ? 1 : 0), 0),
        ...(dropped ? {} : { error: '没有匹配的预留可释放（key 不存在或已经过期/自动释放）；status 里能看到当前预留。' }),
      }), null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_asset_add',
    description: '把一个资产及其端口/服务/指纹写入资产库（幂等 upsert）。每条发现必须标注 provenance：被动收集填 passive，主动探测填 active，并填写 tool（数据源或工具名）。',
    parameters: {
      engagement: { type: 'string', description: '靶标 id；省略则用当前会话绑定的靶标' },
      ip: { type: 'string', required: true, description: '资产 IP（IPv4）' },
      state: { type: 'string', description: 'live | dead | unknown，默认 unknown' },
      primary_name: { type: 'string', description: '主域名/主机名' },
      provenance: { type: 'string', required: true, enum: ['passive', 'active'], description: '本条发现的来源：被动或主动' },
      tool: { type: 'string', description: '数据源或工具名，例如 crt.sh / nmap / nuclei / curl' },
      discovered_at: { type: 'string', description: '【可选】这条资产的发现时间（ISO，如 2026-09-17T09:30:00Z）。不填则按"第一次入库的时刻"自动记录；数据源给出历史首次出现时间时传进来更准。**重复采集不会覆盖它**。' },
      first_seen: { type: 'string', description: '【可选】数据源/工具报告的首次出现时间（与发现时间分开记）' },
      names: {
        type: 'array',
        description: '该资产关联的域名/证书名',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            kind: { type: 'string', description: 'domain | hostname | cert_cn，默认 domain' },
            provenance: { type: 'string', enum: ['passive', 'active'] },
          },
        },
      },
      ports: {
        type: 'array',
        description: '开放端口及其服务/指纹',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            port: { type: 'number', required: true },
            proto: { type: 'string', description: 'tcp（默认）| udp' },
            service: { type: 'string', description: '服务名，例如 http / mysql' },
            product: { type: 'string', description: '产品名，例如 nginx' },
            version: { type: 'string', description: '版本，例如 1.24.0' },
            banner: { type: 'string', description: '原始 banner 片段' },
            url: { type: 'string', description: 'Web 服务可直接访问的完整 URL，例如 https://oa.example.com:8443/portal' },
            title: { type: 'string', description: 'Web 页面标题（HTTP 探测获取），例如「致远OA 登录」' },
            provenance: { type: 'string', enum: ['passive', 'active'] },
            tool: { type: 'string' },
            fingerprints: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  category: { type: 'string', description: 'Web服务器 | 中间件 | 框架 | CMS | 数据库 | VPN网关 …' },
                  vendor: { type: 'string' },
                  product: { type: 'string' },
                  version: { type: 'string' },
                  evidence: { type: 'string', description: '判定依据，例如响应头 / 路径 / banner' },
                  confidence: { type: 'number', description: '0–1' },
                },
              },
            },
          },
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const ip = String(args.ip || '').trim()
      if (!looksLikeIp(ip)) {
        return JSON.stringify({
          ok: false,
          error: 'ip 必须是 IPv4/IPv6 地址：' + JSON.stringify(args.ip),
          error_kind: 'bad_input',
          hint: '主机名/域名请放 primary_name 或 names；只有地址才进 ip 列，否则会在面板里多出一个假 C 段。',
        }, null, 2)
      }
      const asset = {
        ip, state: args.state, primary_name: args.primary_name,
        provenance: args.provenance, tool: args.tool,
        names: args.names, ports: args.ports,
        /* 发现时间：不传则由服务端按"第一次入库的时刻"自动记录；
           数据源能给历史时间（FOFA 的 first_seen 等）就传进来，报告时间线更准 */
        discovered_at: args.discovered_at,
        first_seen: args.first_seen,
      }
      const result = store.importBundle(id, { scan: { tool: args.tool, argv: ['redteam_asset_add'] }, assets: [asset] })
      const written = store.listAssets(id, { ip, limit: 1 }).items[0]
      return JSON.stringify({
        ok: true, engagement: id, asset_id: written ? written.id : null, ip, counts: result.counts,
      }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_ingest',
    description: '把扫描器输出文件批量导入资产库，扫描器给出的命中同时按 candidate 漏洞入库（等人复核）。**优先用这个，不要逐条调 redteam_asset_add**：一次读文件、解析、批量入库，只回一行计数，明细不占上下文。支持 fscan（txt/json）、httpx（jsonl/txt）、nmap（xml）、nuclei（jsonl）、burp（xml issue）、nessus（xml），格式可自动识别。扫描完把 -o 的输出文件直接交给它。',
    parameters: {
      engagement: { type: 'string', description: '靶标 id；省略则用当前会话绑定的靶标' },
      file: { type: 'string', required: true, description: '扫描输出文件的绝对路径（如 runs/fscan-10.0.0.0.txt，相对路径按会话工作区解析）' },
      tool: { type: 'string', description: '产生这份输出的工具名，写进 scan_run 与资产的 tool 字段，例如 fscan / httpx / nmap / nuclei / burp / nessus' },
      format: { type: 'string', enum: ['auto', 'fscan', 'fscan-json', 'httpx', 'nmap', 'nuclei', 'burp', 'nessus'], description: '解析格式，默认 auto 按内容识别' },
      provenance: { type: 'string', enum: ['active', 'passive'], description: '这批发现的来源，默认 active（主动探测）' },
      max_assets: { type: 'number', description: '单次最多导入多少条资产，默认 20000' },
      max_findings: { type: 'number', description: '单次最多导入多少条漏洞命中，默认 500；超出的留在文件里按需再导' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const file = expandSkillPath(String(args.file || '').trim())
      if (!file || !existsSync(file)) {
        return JSON.stringify({ ok: false, error: '扫描输出文件不存在：' + args.file }, null, 2)
      }
      const raw = readFileSync(file, 'utf8')
      const parsed = parseScanOutput(raw, args.format || 'auto')
      const findings = Array.isArray(parsed.findings) ? parsed.findings : []
      if (!parsed.assets.length && !findings.length) {
        return JSON.stringify({
          ok: false,
          format: parsed.format,
          lines: parsed.lines,
          matched: parsed.matched,
          error: '没有解析出任何资产或漏洞。检查 format 是否选错，或输出文件里是否只有日志没有结果行。',
        }, null, 2)
      }
      const cap = Math.max(1, Number(args.max_assets) || 20000)
      const assets = parsed.assets.slice(0, cap).map((a) => Object.assign({}, a, {
        provenance: args.provenance || 'active',
        tool: args.tool || parsed.format,
      }))
      const result = assets.length
        ? store.importBundle(id, {
          scan: { tool: args.tool || parsed.format, argv: ['redteam_ingest', file] },
          assets,
        })
        : { counts: { assets: 0, ports: 0, services: 0, fingerprints: 0 } }
      /* 扫描命中一律 candidate：扫描器说「有」不等于验证过，等人复核（见 review_*） */
      const findingCap = Math.max(1, Number(args.max_findings) || 500)
      const imported = findings.slice(0, findingCap)
      let nameToId = new Map()
      if (imported.length) {
        try {
          const list = store.listAssets(id, { limit: 2000 }).items || []
          nameToId = new Map()
          for (const a of list) {
            if (a.ip) nameToId.set(String(a.ip), a.id)
            if (a.primary_name) nameToId.set(String(a.primary_name), a.id)
          }
        } catch { nameToId = new Map() }
      }
      let vulns = 0
      const sample = []
      const failed = []
      for (const f of imported) {
        try {
          const assetId = nameToId.get(String(f.ip || '')) || nameToId.get(String(f.hostname || ''))
          store.addVuln(id, {
            title: f.title,
            severity: f.severity,
            cve: f.cve || undefined,
            target: f.target,
            source: f.source,
            evidence: f.evidence,
            confidence: 0.6,
            status: 'candidate',
            asset_id: assetId,
            found_by_agent: args.tool || f.source || 'vuln-scan',
          })
          vulns += 1
          if (sample.length < 5) sample.push({ title: f.title, severity: f.severity, target: f.target })
        } catch (error) {
          /* 单条失败不能静默：整批都因为同一个原因写不进去时，模型会以为"扫描没命中"。 */
          if (failed.length < 20) failed.push({ title: f.title, target: f.target, error: String(error && error.message ? error.message : error) })
        }
      }
      const webCount = assets.reduce((n, a) => n + (a.ports || []).filter((p) => p.url).length, 0)
      return JSON.stringify({
        ok: true,
        engagement: id,
        format: parsed.format,
        lines: parsed.lines,
        assets: result.counts.assets,
        ports: result.counts.ports,
        services: result.counts.services,
        fingerprints: result.counts.fingerprints,
        web: webCount,
        vulns,
        finding_sample: sample.length ? sample : undefined,
        ...(failed.length ? {
          vuln_failed: failed.length,
          vuln_failed_sample: failed,
          warning: '有漏洞命中没写进库（上面列的是前几条）。常见原因：缺 target、靶标未绑定、字段不合法。修好后可只重跑失败的命中，不要直接重导整份文件。',
        } : {}),
        ...(parsed.assets.length > cap ? { truncated: parsed.assets.length - cap } : {}),
        ...(findings.length > imported.length ? { truncated_findings: findings.length - imported.length } : {}),
        hint: '已入库。漏洞命中是 candidate，等人工复核；下一步用 redteam_asset_query / redteam_vuln_query 按需筛（不要重读原始输出文件）。',
      }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_asset_link',
    description: '在资产库中写入一条关系边（图谱与后续横向分析共用）。relation 例如 resolves / exposes / contains / trusts / shares_cert。',
    parameters: {
      engagement: { type: 'string' },
      src_kind: { type: 'string', required: true, description: 'segment | asset | domain | port …' },
      src_id: { type: 'string', required: true },
      dst_kind: { type: 'string', required: true },
      dst_id: { type: 'string', required: true },
      relation: { type: 'string', required: true },
      confidence: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.importBundle(id, {
        edges: [{
          src_kind: args.src_kind, src_id: args.src_id,
          dst_kind: args.dst_kind, dst_id: args.dst_id,
          relation: args.relation, confidence: args.confidence,
        }],
      })
      return JSON.stringify({ ok: true, edges: result.counts.edges }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_asset_query',
    description: '检索资产库。支持按 C 段、端口、服务、指纹、来源、内外网维度（scope）、排序（sort）、关键词（全文，覆盖 IP/域名/banner/服务/指纹）过滤。返回紧凑结果，含每个资产的开放端口与指纹及内外网归属。',
    parameters: {
      engagement: { type: 'string' },
      cidr: { type: 'string', description: 'C 段，例如 203.0.113.0/24' },
      port: { type: 'number', description: '开放端口' },
      service: { type: 'string', description: '服务/产品名关键词，例如 nginx' },
      fingerprint: { type: 'string', description: '指纹关键词，例如 Tomcat / Spring' },
      provenance: { type: 'string', enum: ['passive', 'active'], description: '只看被动或主动来源' },
      q: { type: 'string', description: '全文检索词（空格分隔多词为 AND）' },
      state: { type: 'string', enum: ['live', 'dead', 'unknown'] },
      scope: { type: 'string', enum: ['internal', 'external'], description: '内外网维度：internal=内网/私网地址，external=互联网可达' },
      sort: { type: 'string', enum: ['priority', 'todo', 'ports', 'ip', 'discovered'], description: '排序：priority=易打性优先（默认），todo=待测优先，ports=端口多优先，ip=按 IP，discovered=最近发现优先' },
      limit: { type: 'number', description: '返回条数上限，默认 30（太大时宿主会截断工具结果导致 JSON 不可解析），最大 1000' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const limit = Math.min(Number(args.limit) || 30, 1000)
      const result = store.listAssets(id, {
        cidr: args.cidr, port: args.port, service: args.service,
        fingerprint: args.fingerprint, provenance: args.provenance,
        q: args.q, state: args.state, scope: args.scope, sort: args.sort, limit,
      })
      return JSON.stringify({
        ok: true, engagement: id, total: result.total, returned: result.items.length,
        items: result.items.map(compactAsset),
      }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_triage',
    description: '【判断辅助】把已入库的资产按易打性聚合成一份短清单：每类给出数量与少数代表（id + ip + 端口 + 标题 + 为什么值得打）。用于「先打谁」的判断，**不要用 redteam_asset_query 翻全表**——这个工具只回浓缩结论。',
    parameters: {
      engagement: { type: 'string' },
      scope: { type: 'string', enum: ['external', 'internal'], description: '只评外网或内网，省略则全部' },
      top: { type: 'number', description: '每组给几个代表，默认 5' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const top = Math.min(Math.max(Number(args.top) || 5, 1), 20)
      const all = store.listAssets(id, { scope: args.scope, sort: 'priority', limit: 2000 }).items || []
      const groups = {
        web_login: [],      // 标题像登录/管理后台
        web_other: [],      // 其它 Web
        remote_admin: [],   // 3389 / 22 / 5985 / 5900
        database: [],       // 3306 / 1433 / 5432 / 6379 / 27017 / 9200 / 11211
        file_share: [],     // 445 / 139 / 2049 / 21
        middleware: [],     // 7001 / 8080 / 9000 / 8161 / 1099
        other: [],
      }
      const LOGIN_RE = /登录|管理|后台|admin|login|portal|系统|平台|console|dashboard/i
      const REMOTE = new Set([3389, 22, 5985, 5986, 5900, 23])
      const DB = new Set([3306, 1433, 5432, 6379, 27017, 9200, 11211, 1521, 389])
      const SHARE = new Set([445, 139, 2049, 21])
      const MW = new Set([7001, 8080, 9000, 8161, 1099, 2375, 2376])
      for (const a of all) {
        const ports = a.ports || []
        const portNums = ports.map((p) => Number(p.port))
        const titles = ports.map((p) => String(p.title || '')).join(' ')
        if (LOGIN_RE.test(titles)) groups.web_login.push(a)
        else if (portNums.some((p) => p === 80 || p === 443 || p === 8080 || p === 8443 || p === 8000)) groups.web_other.push(a)
        else if (portNums.some((p) => REMOTE.has(p))) groups.remote_admin.push(a)
        else if (portNums.some((p) => DB.has(p))) groups.database.push(a)
        else if (portNums.some((p) => SHARE.has(p))) groups.file_share.push(a)
        else if (portNums.some((p) => MW.has(p))) groups.middleware.push(a)
        else groups.other.push(a)
      }
      const brief = (a) => ({
        id: a.id,
        ip: a.ip || a.primary_name,
        ports: (a.ports || []).map((p) => p.port).slice(0, 6),
        title: ((a.ports || []).find((p) => p.title) || {}).title || '',
        tested: a.test_status || a.status || '',
      })
      const ORDER = [
        ['web_login', '登录/后台类 Web：凭据、弱口令、越权最直接'],
        ['middleware', '中间件管理端口：未授权与反序列化高发'],
        ['database', '数据库/缓存暴露：未授权读取最常见'],
        ['remote_admin', '远程管理口：凭据复用与弱口令'],
        ['file_share', '文件共享：匿名与凭据枚举'],
        ['web_other', '其它 Web：接口与前端未授权'],
        ['other', '其它端口'],
      ]
      const out = ORDER
        .filter(([k]) => groups[k].length > 0)
        .map(([k, why]) => ({
          group: k, why, count: groups[k].length,
          samples: groups[k].slice(0, top).map(brief),
        }))
      return JSON.stringify({
        ok: true, engagement: id, total_assets: all.length,
        groups: out,
        hint: '按上面顺序挑一组打；对某个资产开始测之前用 redteam_asset_test 标 testing。',
      }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_asset_get',
    description: '取单个资产的完整详情：全部端口与服务、指纹、采集溯源时间线、关系边。用于深入分析某个目标。',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true, description: '资产 id（来自 redteam_asset_query 结果）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const asset = store.getAsset(id, args.id)
      if (asset === undefined) return JSON.stringify({ ok: false, error: 'asset not found' })
      return JSON.stringify({ ok: true, asset }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_asset_stats',
    description: '资产测绘概览：C 段数、资产数（存活）、开放端口、服务、指纹、被动/主动溯源条数，以及各 C 段的明细。',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, stats: store.stats(id), segments: store.listSegments(id) }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_asset_graph',
    description: '导出资产图谱（C 段 → 资产 → 开放端口，含域名解析边），用于拓扑推理与横向移动路径规划。节点数超过上限时按 C 段缩小范围。',
    parameters: {
      engagement: { type: 'string' },
      cidr: { type: 'string', description: '只取某个 C 段的子图' },
      maxNodes: { type: 'number', description: '节点上限，默认 300' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const maxNodes = Math.min(Number(args.maxNodes) || 300, 1000)
      const graph = store.graph(id, { cidr: args.cidr })
      if (graph.nodes.length > maxNodes) {
        return JSON.stringify({
          ok: false,
          error: '图谱节点过多（' + graph.nodes.length + ' > ' + maxNodes + '），请指定 cidr 缩小范围',
          segments: store.listSegments(id).map((s) => ({ cidr: s.cidr, assets: s.assets })),
        }, null, 2)
      }
      return JSON.stringify({ ok: true, engagement: id, nodes: graph.nodes, edges: graph.edges }, null, 2)
    },
  })))





  collect(withStructuredErrors(defineTool({
    name: 'redteam_asset_test',
    description: '记录资产的侦察/测试进展：本次做了什么（`test`，追加式）、还剩什么攻击面（`surface`，覆盖式）、资产级状态、是否被 WAF 封禁。这是资产级状态（侦察到哪一步），**不是八类覆盖结论**；哪一类测没测以 redteam_coverage 为准。**只写 `test` 不会自动标已测**；要标 tested/blocked/abandoned/no_surface 必须显式传 status。排除结论、登录失败原因、重测理由都写在 `test` 里。',
    parameters: {
      engagement: { type: 'string' },
      asset_id: { type: 'number', description: '资产 id（与 ip 二选一，优先 asset_id）' },
      ip: { type: 'string', description: '资产 IP' },
      status: { type: 'string', enum: ['untested', 'testing', 'tested', 'blocked', 'abandoned', 'no_surface'], description: '测试状态：未测试/测试中/已测试/被封禁/已放弃/无攻击面' },
      test: { type: 'string', description: '本次做了什么测试（**追加**到测试记录，例如「nmap 全端口 + nuclei cve 模板 + 接口越权」）。排除结论、登录失败原因、重测理由都写这里。' },
      notes: { type: 'string', description: 'test 的兼容别名（老提示词里的写法），效果与 test 相同，会一并追加到测试记录。' },
      surface: { type: 'string', description: '还剩什么攻击面可测（覆盖式，例如「SMB 445 未测；Web /api 未做越权」）' },
      blocked: { type: 'boolean', description: '本次是否被 WAF/防护封禁（true 时封禁计数 +1）' },
      updated_by: { type: 'string', description: '记录角色，例如 recon / vuln-scan' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.updateAssetTest(id, { ...args, engagement: undefined })
      /* test_notes 是追加式的，长会话会越来越长；每次回写都把全文回给模型
         既烧上下文又没新信息。只回最后一段够判断"写进去了没有"。 */
      const { tests, ...rest } = result
      const notes = String(rest.test_notes || '')
      if (notes.length > 800) rest.test_notes = '…（前 ' + (notes.length - 800) + ' 字符省略）\n' + notes.slice(-800)
      return JSON.stringify({ ok: true, engagement: id, ...rest }, null, 2)
    },
  })))

  /* ================================================================== 漏洞检测 */

  collect(withStructuredErrors(defineTool({
    name: 'redteam_vuln_add',
    description: '记录一条漏洞发现（漏洞检测角色）。带 cve 时按 (asset_id, cve, target) 幂等更新。status 只能写 candidate（待验证）或 exploited（已复现）；confirmed / false-positive / fixed 是**人工复核结论**，写了会被拒。candidate 可以先只有标题和目标；写成 exploited 时必须同时有 target/asset_id 与 evidence；HTTP(S) 目标的 exploited 漏洞收口/报告还要求对应 http_evidence 原始报文（Web 漏洞的 target 请写完整 URL）。',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      asset_id: { type: 'number', description: '资产 id（来自 redteam_asset_query）' },
      cve: { type: 'string', description: 'CVE / CNVD 编号（无编号可省略）' },
      title: { type: 'string', required: true, description: '漏洞标题' },
      severity: { type: 'string', required: true, enum: ['critical', 'high', 'medium', 'low', 'info'] },
      status: { type: 'string', enum: ['candidate', 'confirmed', 'false-positive', 'exploited', 'fixed'] },
      target: { type: 'string', description: '受影响的目标，如 https://host:443/path 或 ip:port' },
      source: { type: 'string', description: '发现方式：nuclei / sqlmap / curl / manual …' },
      confidence: { type: 'number', description: '0–1' },
      evidence: { type: 'string', description: '证据：请求/响应摘要、命令、证据文件路径；写 exploited 时必填' },
      found_by_agent: { type: 'string', description: '发现角色，默认 vuln-scan' },
      gained: { type: 'string', description: '【重要】通过这个漏洞拿到了什么权限/成果，写成果口径的短标签，多项用顿号或逗号分隔，例如「服务器权限、内网隧道」「后台管理员账号」「数据库权限」' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const blocked = humanVerdictBlock(args.status)
      if (blocked) return JSON.stringify({ ok: false, error: blocked }, null, 2)
      if (!args.asset_id && !String(args.target || '').trim()) {
        return JSON.stringify({ ok: false, error: '漏洞要挂到资产或 target 上（candidate 也一样），否则报告与面板关联不到' }, null, 2)
      }
      if (args.status === 'exploited' && !String(args.evidence || '').trim()) {
        return JSON.stringify({ ok: false, error: '写 exploited 必须有 evidence：请求/响应摘要、复现命令或证据文件路径；没证据先写 candidate' }, null, 2)
      }
      const result = store.addVuln(id, { ...args, engagement: undefined, agent: agentOf(args), found_by_agent: args.found_by_agent || args.agent || 'vuln-scan' })
      return JSON.stringify({
        ok: true, engagement: id, ...result,
        ...(result.status_locked ? { note: '已有人员判定（' + result.status + '），本次只更新证据/严重级，状态保持不变' } : {}),
      }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_vuln_query',
    description: '检索漏洞库：按严重级、状态（status:"pending" 看待人工复核的）、CVE、资产、C 段或关键词过滤。用于挑选待利用目标或核对人工复核结论（confirmed / false-positive / fixed 与 review_note）。',
    parameters: {
      engagement: { type: 'string' },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
      status: { type: 'string', enum: ['pending', 'candidate', 'confirmed', 'false-positive', 'exploited', 'fixed'] },
      cve: { type: 'string' },
      asset_id: { type: 'number' },
      cidr: { type: 'string' },
      q: { type: 'string', description: '标题/CVE/目标/证据关键词' },
      limit: { type: 'number', description: '默认 30（太大时宿主会截断工具结果导致 JSON 不可解析），最大 1000' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const limit = Math.min(Number(args.limit) || 30, 1000)
      const result = store.listVulns(id, { ...args, engagement: undefined, limit, with_http_evidence: false })
      /* 不放原始报文：库里的包体单条可到 60KB，100 条就会把上下文打爆，
         而且宿主 pruner 会把 JSON 头尾截断成不可解析的文本。只回轻量元数据。 */
      const items = result.items.map((v) => {
        const http = Array.isArray(v.http_evidence) ? v.http_evidence : []
        return {
          ...v,
          http_evidence: http.map((e) => ({
            id: e.id, label: e.label, method: e.method, url: e.url, status: e.status, captured_at: e.captured_at,
          })),
        }
      })
      return JSON.stringify({
        ok: true, engagement: id, total: result.total, items, stats: store.vulnStats(id),
        note: 'http_evidence 只给元数据（method/url/status）；完整原始报文在面板漏洞详情里查看，不要指望这里回包体。',
      }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_vuln_update',
    description: '更新漏洞的严重级/证据/标题/产出，或把状态改成 candidate / exploited。**confirmed / false-positive / fixed 是人工复核结论，写了会被拒**——发现写 candidate，复现成功写 exploited，等人在面板判定。改成 exploited 必须有 evidence，且行内已有 target/asset_id（或本次补上）。',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true, description: '漏洞 id' },
      status: { type: 'string', enum: ['candidate', 'confirmed', 'false-positive', 'exploited', 'fixed'] },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
      evidence: { type: 'string' },
      confidence: { type: 'number' },
      gained: { type: 'string', description: '通过这个漏洞拿到了什么权限/成果（成果口径短标签，多项用顿号分隔）' },
      title: { type: 'string' },
      target: { type: 'string', description: '补/改受影响目标；改成 exploited 时 target 和 asset_id 至少要有一个' },
      asset_id: { type: 'number', description: '补/改关联资产 id' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const blocked = humanVerdictBlock(args.status)
      if (blocked) return JSON.stringify({ ok: false, error: blocked }, null, 2)
      const result = store.updateVuln(id, args.id, {
        status: args.status, severity: args.severity, evidence: args.evidence, confidence: args.confidence,
        gained: args.gained, title: args.title, target: args.target, asset_id: args.asset_id,
      })
      /* store 对"找不到这条漏洞"只回 updated:false，不带 error；工具这里必须补一句，
         否则模型看到 ok:false 却不知道是 id 过期还是靶标绑错了。 */
      const error = result.updated === false && !result.error
        ? '漏洞不存在：' + args.id + '（先用 redteam_vuln_query 核对 id 与 engagement；跨靶标时显式传 args.engagement）'
        : result.error
      return JSON.stringify({
        ok: result.updated, engagement: id, ...result, ...(error ? { error } : {}),
        stats: store.vulnStats(id),
        ...(result.status_locked ? { note: '已有人员判定（' + result.status + '），本次只更新其它字段，状态保持不变' } : {}),
      }, null, 2)
    },
  })))

  /* ================================================================== 漏洞利用 / 内网渗透 */

  collect(withStructuredErrors(defineTool({
    name: 'redteam_credential_add',
    description: '记录一条凭据（漏洞利用/内网渗透角色）。**能写明文就把口令/密钥写进 secret_value**（面板要直接显示明文供随时复用）；只拿到文件引用时写 secret_ref 指向 runs/ 下的证据文件。注意：本库只在本机，禁止把库文件或导出内容提交到任何仓库。',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      host: { type: 'string', required: true, description: '所属主机（IP 或域名）' },
      username: { type: 'string' },
      secret_type: { type: 'string', description: 'password | hash | key | token | connection-string，默认 password' },
      secret_value: { type: 'string', description: '【强烈建议】凭据明文：口令 / Hash / 私钥 / Token / 连接串；只给引用时可留空并写 secret_ref' },
      secret_ref: { type: 'string', description: '证据引用路径，例如 runs/cred-vnc-10.0.0.5.txt' },
      privilege: { type: 'string', description: '该凭据的权限级别，如 admin / user / db-read' },
      asset_id: { type: 'number' },
      source: { type: 'string', description: '来源：exploit / dump / config-leak …' },
      tool: { type: 'string' },
      note: { type: 'string' },
      found_by_agent: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addCredential(id, { ...args, engagement: undefined, agent: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_shot_add',
    description: '登记一张证据截图：把图片拷进靶标目录并挂到漏洞/资产上（面板点开漏洞即可看图，报告里也会嵌入）。',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      path: { type: 'string', description: '图片在本机的路径（相对靶标目录或绝对路径）；与 data_base64 二选一' },
      data_base64: { type: 'string', description: '图片内容（base64，可带 data: 前缀）；截图工具没落盘时用这个' },
      label: { type: 'string', description: '图片说明，例如「域控 WEB-SHDC1 atexec 回显 nt authority\\system」' },
      kind: { type: 'string', description: 'screenshot（现场截图，默认）| card（由记录生成的证据摘录卡，报告里会标注）' },
      vuln_id: { type: 'number', description: '关联的漏洞 id；先 vuln_add 写 candidate，再截图挂上去' },
      asset_id: { type: 'number' },
      target: { type: 'string', description: '这张图对应的目标（IP / URL）' },
      note: { type: 'string', description: '补充说明：这张图证明了什么' },
      source_ref: { type: 'string', description: '原始来源：截图的落盘路径或 runs/ 下的证据文件' },
      captured_at: { type: 'string', description: '截图时间（ISO），缺省用当前时间' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addShot(id, { ...args, engagement: undefined, agent: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_capture',
    description: '给漏洞/成果补证据截图。kind=web（默认）：用本机 Chrome/Edge 无头截公开网页，自动入库并关联 vuln_id，面板立刻可见；需要登录态/真实指纹的页面先用 browser 工具截图。kind=file：登记已有图片。只截网页，不截桌面窗口。',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      kind: { type: 'string', description: 'web（默认）| file' },
      url: { type: 'string', description: 'kind=web 时要截的 http/https 地址' },
      path: { type: 'string', description: 'kind=file 时图片路径（靶标相对或绝对），与 data_base64 二选一' },
      data_base64: { type: 'string', description: 'kind=file 时图片 base64（可带 data: 前缀）' },
      vuln_id: { type: 'number', description: '关联的漏洞 id；面板会把截图挂在这条漏洞下' },
      target: { type: 'string', description: '截图对应的目标（URL 或 host:port）；kind=file 时也建议填，报告按它归类' },
      label: { type: 'string', description: '截图说明，例如「Log4Shell 回显」' },
      note: { type: 'string', description: '这张图证明了什么' },
      width: { type: 'number', description: '视口宽，默认 1440' },
      height: { type: 'number', description: '视口高，默认 900' },
      wait_ms: { type: 'number', description: '等页面渲染的时间，默认 2500ms' },
      full_page: { type: 'boolean', description: 'true 时把视口加高，截长页' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const kind = args.kind === 'file' ? 'file' : 'web'
      if (kind === 'file') {
        const shot = store.addShot(id, {
          path: args.path,
          data_base64: args.data_base64,
          label: args.label,
          note: args.note,
          vuln_id: args.vuln_id,
          /* 以前把本地文件路径写进 target，报告/截图列表的「目标」列会出现 C:\…\x.png。
             目标应来自调用方；没给就留空，由截图自己带 source_ref。 */
          target: args.target || null,
          source_ref: args.path || null,
          agent: agentOf(args),
        })
        return JSON.stringify({ ok: true, engagement: id, kind, shot }, null, 2)
      }
      const url = String(args.url || '').trim()
      if (!url) throw new Error('kind=web 需要 url')
      const out = join(tmpdir(), 'dsh-forge-shot-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8) + '.png')
      const cap = await captureWeb({
        url,
        out,
        width: args.width,
        height: args.height,
        waitMs: args.wait_ms,
        fullPage: args.full_page === true,
      })
      let shot
      try {
        shot = store.addShot(id, {
          path: out,
          label: args.label || url,
          note: args.note,
          vuln_id: args.vuln_id,
          target: url,
          source_ref: url,
          agent: agentOf(args) || 'capture',
        })
      } finally {
        try { unlinkSync(out) } catch { /* 临时文件删不掉不影响入库 */ }
      }
      return JSON.stringify({ ok: true, engagement: id, kind, url, engine: cap.engine, shot }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_shot_list',
    description: '列出已登记的证据截图（含所属目标、类型、落盘文件）。',
    parameters: {
      engagement: { type: 'string' },
      vuln_id: { type: 'number' },
      asset_id: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, ...store.listShots(id, {
        vuln_id: args.vuln_id, asset_id: args.asset_id,
      }) }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_shot_delete',
    description: '删除一张证据截图（连同磁盘文件）。',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true, description: 'shot id（redteam_shot_list 里返回的 id）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const eng = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: eng, ...store.deleteShot(eng, args.id) }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_credential_list',
    description: '列出已收集的凭据（含明文 secret_value），用于凭据复用与横向移动。',
    parameters: {
      engagement: { type: 'string' },
      host: { type: 'string' },
      username: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listCredentials(id, { host: args.host, username: args.username }) }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_access_add',
    description: '记录一次成功获得的访问会话（横向移动起点）。method 例如 vnc/rdp/ssh/web-shell/webshell/db；privilege 例如 admin/user/system。',
    parameters: {
      engagement: { type: 'string' },
      host: { type: 'string', required: true },
      username: { type: 'string' },
      method: { type: 'string', required: true, description: '获得访问的方式' },
      privilege: { type: 'string' },
      asset_id: { type: 'number' },
      session_ref: { type: 'string', description: '会话/证据引用，例如 runs/session-vnc-10.0.0.5.md' },
      note: { type: 'string' },
      found_by_agent: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addAccess(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_access_list',
    description: '列出已获得的访问会话。',
    parameters: {
      engagement: { type: 'string' },
      host: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listAccess(id, { host: args.host }) }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_role_prompt_reset',
    description: '把角色系统提示词恢复为内置默认（新版模板）。老靶标想用上最新版角色提示词时用它；省略 role 则四个角色全部重置。',
    parameters: {
      engagement: { type: 'string' },
      role: { type: 'string', /* 角色白名单**从 ROLE_ORDER 派生**：写死 4 个值曾漏掉 assess，
          而预设明确要求主会话用本工具取资产梳理角色的提示词 —— 结果 enum 直接拒绝，
          资产梳理子智能体永远拿不到角色约束。派生后新增角色不会再漏。 */
      enum: ROLE_ORDER },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.resetPrompts(id, args.role)
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  /* ---------- WebShell 与内网隧道：打的过程中随时复用，避免"打到后面忘了还有入口" ---------- */

  collect(withStructuredErrors(defineTool({
    name: 'redteam_sessions',
    description: '【每次决策前后都要看】一屏总览当前所有可复用入口：已上线的 WebShell、可用的内网隧道（含监听地址与可达网段）、凭据、访问会话，并给出在线/离线统计。打内网前先看这里。',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const summary = store.sessionSummary(id)
      return JSON.stringify({
        ok: true, engagement: id, totals: summary.totals,
        webshells: summary.webshells.map((w) => ({
          id: w.id, url: w.url, type: w.shell_type, pass_key: w.pass_key, privilege: w.privilege,
          status: w.status, asset_ip: w.asset_ip, last_check: w.last_check, note: w.note,
        })),
        tunnels: summary.tunnels.map((t) => ({
          id: t.id, kind: t.kind, listen: t.listen, entry: t.entry, reach: t.reach,
          entry_kind: t.entry_kind, legit: t.legit,
          status: t.status, asset_ip: t.asset_ip, command: t.command, last_check: t.last_check, note: t.note,
        })),
        hint: '隧道 status=active 时可直接给扫描器用：-socks5 <listen> 或 --proxy socks5://<listen>；webshell status=online 时用对应客户端连接。'
          + ' 注意 legit=false（entry_kind=self-only，只在自己的 VPS/自建服务器上）**不算跨越靶标边界、不算突破**；legit=null 表示未声明 entry_kind，用 redteam_tunnel_update 补上目标侧那一端。',
      }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_webshell_add',
    description: '登记一个已上线的 WebShell。**必须上传冰蝎马（behinder）或哥斯拉马（godzilla）的加密马**——用户在控制台要用对应客户端直连，一句话马/自研马/MemShell 用户连不上，不算可交付的入口。shell_type 只能填 godzilla | behinder；确实只能用其它形式时填 custom 并在 note 里写清为什么。同一 url+pass_key 重复登记会合并刷新。登记后所有角色智能体都能复用它。',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      url: { type: 'string', required: true, description: 'WebShell 完整 URL' },
      shell_type: { type: 'string', description: 'godzilla（哥斯拉）| behinder（冰蝎）；其它形式才用 antsword/custom 并说明原因' },
      pass_key: { type: 'string', description: '连接密码 / 密钥（冰蝎马写 pass，哥斯拉写 key）' },
      privilege: { type: 'string', description: '当前权限，例如 www-data / root / iis' },
      secret_ref: { type: 'string', description: '凭据/证据引用，例如 runs/ws-10.0.0.5.txt（不要把明文口令写进库）' },
      asset_id: { type: 'number' },
      note: { type: 'string' },
      found_by_agent: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addWebshell(id, { ...args, engagement: undefined, status: 'online', agent: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_webshell_list',
    description: '列出已登记的 WebShell（含在线状态与最后检查时间）。',
    parameters: {
      engagement: { type: 'string' },
      status: { type: 'string', description: 'online | offline | unknown' },
      asset_id: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listWebshells(id, args) }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_webshell_update',
    description: '更新 WebShell 状态（被删/掉线/权限变化）或补充说明。',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true, description: 'WebShell 记录 id' },
      status: { type: 'string', description: 'online | offline | dead | unknown' },
      privilege: { type: 'string' },
      note: { type: 'string' },
      check_note: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const eng = resolveEngagement(store, exec, args.engagement)
      const result = store.updateWebshell(eng, args.id, args)
      return JSON.stringify({ ok: true, engagement: eng, ...result }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_tunnel_add',
    description: '登记一条已建立的内网隧道。kind 是通道类型，listen 写本机可用地址（如 127.0.0.1:1080），reach 写它可达的网段；登记后扫描器可以直接用它当出口。**entry_kind 要说清目标侧的那一端**：target-outbound（目标主动连出到我方，或目标上跑 frp/Stowaway 客户端）、target-http（经目标 WebShell/HTTP，suo5、Neo-ReGeorg）、target-agent（经目标已控进程/会话转发）。只在自己 VPS 或自建服务器上开的 socks5、frp 服务端是 self-only——没碰到目标，不算跨越靶标边界。',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      kind: { type: 'string', required: true, description: 'suo5（首选，走 WebShell/HTTP）| socks5 | ssh-r | frp | chisel | other' },
      listen: { type: 'string', required: true, description: '本地监听地址 host:port' },
      entry: { type: 'string', description: '入口：WebShell URL / 跳板机 / 命令' },
      reach: { type: 'string', description: '可达网段，例如 10.0.0.0/8' },
      entry_kind: { type: 'string', description: '【重要】通道的目标侧那一端是什么：target-outbound（目标反弹 shell 到我方/目标上跑 frp 客户端）| target-http（经目标 WebShell 的 suo5/Neo-ReGeorg）| target-agent（经目标已控进程转发）| self-only（只在自己 VPS/自建服务器上，**不算突破**）' },
      webshell_id: { type: 'number', description: '由哪个 WebShell 建立' },
      asset_id: { type: 'number' },
      command: { type: 'string', description: '建立命令，便于重建' },
      pid: { type: 'string' },
      note: { type: 'string' },
      found_by_agent: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addTunnel(id, { ...args, engagement: undefined, status: 'active', agent: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_tunnel_list',
    description: '列出已登记的内网隧道（含状态、监听地址、可达网段、entry_kind 与 legit 判定）。**legit=false 表示只在自己 VPS/自建服务器上开的通道，不算跨越靶标边界、不算突破**；legit=null 表示未声明 entry_kind。',
    parameters: {
      engagement: { type: 'string' },
      status: { type: 'string', description: 'active | down | unknown' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listTunnels(id, args) }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_tunnel_update',
    description: '更新隧道状态（关闭/失效/更换监听地址）或补 entry_kind 判定。用完隧道务必标为 down 并说明，避免后续误用。**老记录没声明入口归属的（legit=null，界面显示"待确认"），用 entry_kind 补上目标侧那一端**，补完才算突破凭证。',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true },
      status: { type: 'string', description: 'active | down | closed | unknown' },
      listen: { type: 'string' },
      reach: { type: 'string' },
      entry: { type: 'string', description: '入口：WebShell URL / 跳板机 / 命令' },
      entry_kind: { type: 'string', description: '补声明目标侧那一端：target-outbound | target-http | target-agent | self-only（只在自己服务器上，不算突破）' },
      note: { type: 'string' },
      check_note: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const eng = resolveEngagement(store, exec, args.engagement)
      const result = store.updateTunnel(eng, args.id, args)
      return JSON.stringify({ ok: true, engagement: eng, ...result }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_session_check',
    description: '实测所有 WebShell 与隧道的连通性（由 host 侧真实发起 HTTP / TCP 连接），并把在线/离线状态回写数据库。开工前和长时间任务后各跑一次。',
    parameters: {
      engagement: { type: 'string' },
      timeoutMs: { type: 'number', description: '单次探测超时，默认 6000ms' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = await store.probeSessions(id, { timeoutMs: args.timeoutMs })
      const online = result.webshells.filter((w) => w.status === 'online').length
      const active = result.tunnels.filter((t) => t.status === 'active').length
      return JSON.stringify({
        ok: true, engagement: id, checked_at: result.checkedAt,
        summary: `WebShell 在线 ${online}/${result.webshells.length}，隧道可用 ${active}/${result.tunnels.length}`,
        webshells: result.webshells, tunnels: result.tunnels,
      }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_attack_path',
    description: '导出攻击图谱：资产拓扑 + 漏洞节点 + 已控制资产（meta.owned）。用于横向移动路径规划与战果汇报。节点过多时用 cidr 缩小范围。',
    parameters: {
      engagement: { type: 'string' },
      cidr: { type: 'string' },
      maxNodes: { type: 'number', description: '默认 400' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const maxNodes = Math.min(Number(args.maxNodes) || 400, 1500)
      const graph = store.attackGraph(id, { cidr: args.cidr })
      if (graph.nodes.length > maxNodes) {
        return JSON.stringify({
          ok: false,
          error: '图谱节点过多（' + graph.nodes.length + ' > ' + maxNodes + '），请指定 cidr 缩小范围',
          summary: graph.summary,
        }, null, 2)
      }
      return JSON.stringify({
        ok: true, engagement: id, summary: graph.summary,
        owned: graph.nodes.filter((n) => n.meta && n.meta.owned).map((n) => n.label),
        nodes: graph.nodes, edges: graph.edges,
      }, null, 2)
    },
  })))

  /* ================================================================== 域名 / Web 资产 */











  collect(withStructuredErrors(defineTool({
    name: 'redteam_asset_assess',
    description: '给资产做「易打性评估」：预期能拿下哪些成果（账号权限/RCE/服务器权限/数据库权限/敏感数据/边界突破）、优先级多高、判断理由。信息收集收口时对每个资产调用一次，供指挥者按性价比排序。',
    parameters: {
      engagement: { type: 'string' },
      asset_id: { type: 'number' },
      ip: { type: 'string' },
      priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'high 容易出成果 / medium 一般 / low 难打或价值低' },
      potential: { type: 'string', description: '预期成果，如「账号权限+RCE」「数据库权限」「大量敏感信息」' },
      reason: { type: 'string', description: '判断理由：指纹版本命中 Nday、接口未鉴权、口令弱、暴露数据库、WAF 强弱等' },
      assessed_by: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.assessAsset(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  /* ================================================================== 证据 / 攻击链 / 报告 */

  collect(withStructuredErrors(defineTool({
    name: 'redteam_http_evidence_add',
    description: '保存 HTTP 证据：原始请求与响应。单条给 request 或 file（probe --save 的产物直接读文件）；多条用 items 一次提交，省往返。报告会把它渲染成可粘贴进 Burp Suite / Yakit 的原始报文。',
    parameters: {
      engagement: { type: 'string' },
      vuln_id: { type: 'number', description: '关联的漏洞 id（建议填）' },
      asset_id: { type: 'number' },
      label: { type: 'string', description: '这条证据的用途，例如「越权读取用户列表」' },
      method: { type: 'string', description: 'GET/POST/…' },
      url: { type: 'string' },
      status: { type: 'number', description: '响应状态码' },
      request: { type: 'string', description: '原始请求全文（Burp 可直接粘贴）；与 file 二选一' },
      file: { type: 'string', description: '落盘的原始报文路径（probe --save 或 curl -o 的产物），内容直接当 request；与 request 二选一' },
      response: { type: 'string', description: '响应全文或关键片段' },
      note: { type: 'string' },
      captured_by: { type: 'string', description: '采集角色' },
      items: { type: 'array', description: '一次提交多条证据；每项字段同本工具（request/file/url/vuln_id/...），最多 20 条', items: { type: 'object', additionalProperties: true } },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const readRequest = (item) => {
        let request = String(item.request || '')
        if (!request.trim() && String(item.file || '').trim()) {
          try { request = readFileSync(String(item.file).trim(), 'utf8') } catch (error) {
            throw new Error('读不到 file：' + String(error && error.message ? error.message : error))
          }
        }
        return request.trim() ? request : ''
      }
      if (Array.isArray(args.items) && args.items.length > 0) {
        const rows = []
        for (let i = 0; i < Math.min(args.items.length, 20); i += 1) {
          const item = args.items[i] || {}
          let request = ''
          try { request = readRequest(item) } catch (error) {
            return JSON.stringify({ ok: false, error: '第 ' + (i + 1) + ' 条：' + error.message }, null, 2)
          }
          if (!request) return JSON.stringify({ ok: false, error: '第 ' + (i + 1) + ' 条缺 request 或 file' }, null, 2)
          rows.push(store.addHttpEvidence(id, {
            ...item, engagement: undefined, request,
            vuln_id: item.vuln_id ?? args.vuln_id,
            asset_id: item.asset_id ?? args.asset_id,
            captured_by: item.captured_by ?? args.captured_by,
          }))
        }
        return JSON.stringify({ ok: true, engagement: id, count: rows.length, items: rows }, null, 2)
      }
      let request = ''
      try { request = readRequest(args) } catch (error) {
        return JSON.stringify({ ok: false, error: error.message }, null, 2)
      }
      if (!request) {
        return JSON.stringify({ ok: false, error: '要么给 request（原始报文全文），要么给 file 指向落盘的报文文件；多条用 items' }, null, 2)
      }
      const result = store.addHttpEvidence(id, { ...args, items: undefined, file: undefined, request, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_chain_add',
    description: '记录一个攻击链步骤。**报告里「这一步怎么来的」完全靠这条记录**：账号密码怎么来的、冰蝎马怎么上的、隧道怎么搭的，都要在这里用 `tool`（实际命令原文）+ `detail`（为什么这么做、线索从哪来）+ `result`（实际回显/结果）写清楚。攻击链页面与报告按 seq 排序展示。',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      stage: { type: 'string', enum: ['recon', 'vuln', 'exploit', 'access', 'pivot', 'data', 'other'], description: '动作类型（兼容字段）：recon 信息收集 | vuln 漏洞发现 | exploit 利用 | access 获得权限 | pivot 内网突破 | data 敏感数据 | other。**阶段归属用 stage_code**，这个字段只用于老数据兜底。' },
      title: { type: 'string', required: true, description: '一句话描述这一步做了什么，例如「通过后台模板上传点上传冰蝎马」「用 suo5 建 socks5 隧道」' },
      detail: { type: 'string', description: '为什么这么做、线索从哪来，例如「登录页泄露版本 Coremail XT 5.0 → 匹配 CVE-2023-xxxx → 后台模板管理可上传」' },
      tool: { type: 'string', description: '【报告复现的关键】**实际执行的命令原文**，例如 `nuclei -t CVE-2021-xxxx.yaml -u http://x`、`suo5-linux-amd64 -t http://x/shell.jsp -l 1080`、`sqlmap -u "http://x?id=1" --dump`。不写这条，报告里这一步就没法复现。' },
      result: { type: 'string', description: '【报告复现的关键】实际结果/回显摘要，例如 `uid=0(root) gid=0(root)`、「返回 200，含 1.2 万条用户数据」、「后台管理员 tomcat 登录成功」' },
      asset_id: { type: 'number' },
      vuln_id: { type: 'number' },
      access_id: { type: 'number' },
      evidence_ref: { type: 'string', description: '证据文件/会话引用，例如 runs/session-vnc.md' },
      recorded_by: { type: 'string' },
      stage_code: { type: 'string', enum: ['recon', 'internet', 'boundary', 'internal', 'target'], description: '所属作战阶段（只有这 5 个合法值）：recon(信息收集) | internet(互联网资产权限) | boundary(边界突破·搭隧道) | internal(内网资产权限) | target(靶标系统权限)。写别的值会被忽略并退回按 stage 兜底。' },
      seq: { type: 'number', description: '不填则自动追加到链尾' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addChainStep(id, { ...args, engagement: undefined, agent: agentOf(args), recorded_by: args.recorded_by || args.agent })
      /* 步骤落库后提醒两件事：报告要用的 tool/result 有没有写 */
      const hints = []
      if (!args.tool) hints.push('这一步没写 `tool`（实际命令）：报告里"怎么做的"会变成空白，建议补一条步骤把命令写上。')
      if (!args.result) hints.push('这一步没写 `result`（实际回显/结果）：报告复现时会缺"打没打通"的证据。')
      const compact = { ok: true, engagement: id, id: result.id, seq: result.seq, stage_code: result.stage_code }
      if (result.stage_hint) compact.stage_hint = result.stage_hint
      if (hints.length > 0) compact.hints = hints
      return JSON.stringify(compact, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_import',
    description: '【归档批量契约】一次写入多条成果：JSONL 一行一条，或 JSON 数组；`kind` 决定落到哪个写入口（' + BATCH_KINDS.join(' / ') + '）。字段与对应单条动作完全一致，逐行校验、逐行报错，一行坏不影响其余。子会话只产出这个格式，写库由主会话调本动作完成。资产与扫描结果仍走 redteam_ingest。',
    parameters: {
      engagement: { type: 'string', description: '靶标 id；省略则用当前会话绑定的靶标' },
      data: { type: 'string', description: 'JSONL 文本（与 file 二选一）' },
      file: { type: 'string', description: 'JSONL 或 JSON 数组文件的绝对路径（与 data 二选一）' },
      agent: AGENT_PARAM,
      max_items: { type: 'number', description: '单次最多导入多少条，默认 2000' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      let raw = ''
      if (typeof args.data === 'string' && args.data.trim() !== '') {
        raw = args.data
      } else {
        const file = expandSkillPath(String(args.file || '').trim())
        if (!file || !existsSync(file)) {
          return JSON.stringify({ ok: false, error: '需要 data 文本，或一个存在的 file：' + (args.file || '') }, null, 2)
        }
        raw = readFileSync(file, 'utf8')
      }
      const rows = parseJsonRows(raw)
      const cap = Math.max(1, Number(args.max_items) || 2000)
      const result = importBatchRows(store, id, rows.items.slice(0, cap), {
        agent: args.agent ? agentOf({ agent: args.agent }) : '',
      })
      const errors = rows.errors.concat(result.errors)
      const partial = result.written > 0 && errors.length > 0
      return JSON.stringify({
        /* 全失败才是 ok:false；部分成功要标 partial，否则模型会重发整批，
           chain 这类纯 INSERT 的条目会被重复写一遍。 */
        ok: result.written > 0 || errors.length === 0,
        ...(partial ? { partial: true } : {}),
        engagement: id,
        read: Math.min(rows.items.length, cap),
        written: result.written,
        counts: result.counts,
        ...(rows.items.length > cap ? { truncated: rows.items.length - cap } : {}),
        failed: errors.length,
        errors: errors.slice(0, 20),
        ...(partial ? { retry_hint: '只重发 errors 里列出的行号（line）；不要整批重发，chain 会重复。' } : {}),
        kinds: BATCH_KINDS,
        hint: result.written > 0
          ? '已入库。核对用对应查询动作（asset_query / vuln_query / chain / coverage list），不要重读原文件。'
          : '一行都没写进去：按 errors 修正后重试。',
      }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_chain',
    description: '读取完整攻击链（按步骤顺序），用于汇报与检查链路是否闭合（入口 → 权限 → 内网突破）。',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listChain(id) }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_attack_file_add',
    description: '保存一个**实际生效**的攻击文件（脚本/POC/EXP/字典）到目标文件夹，供复用与交付。目录结构：attack-files/<IP|URL主机|C段>/<文件名>。evidence 必填且必须写清验证效果（例如"回显 uid=0"、"未授权返回 200 并含数据"）——**没打通的、只是尝试过的脚本不要放进来**。',
    parameters: {
      engagement: { type: 'string' },
      target: { type: 'string', required: true, description: '目标：IP、URL 或 C 段（同一 IP 的多个端口会归到该 IP 文件夹）' },
      name: { type: 'string', required: true, description: '文件名，例如 cve-2021-22893.sh / vnc_brute.py' },
      kind: { type: 'string', enum: ['poc', 'exp', 'script', 'wordlist', 'other'], description: '类型：poc 验证 / exp 利用 / script 脚本 / wordlist 字典' },
      description: { type: 'string', description: '这个文件做什么（一句话）' },
      evidence: { type: 'string', required: true, description: '有效性证据：实际打通的输出/回显/影响，或对应漏洞/证据 id' },
      content: { type: 'string', description: '文件内容（与 path 二选一）' },
      path: { type: 'string', description: '已存在的文件路径（相对靶标目录或绝对路径），会复制进目标文件夹（与 content 二选一）' },
      asset_id: { type: 'number' },
      vuln_id: { type: 'number' },
      created_by: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addAttackFile(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_attack_file_list',
    description: '列出已保存的攻击文件（按目标文件夹分组）。开始打某个目标前先看这里，避免重复造轮子。',
    parameters: {
      engagement: { type: 'string' },
      target: { type: 'string', description: '只看某个目标' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      if (args.target) return JSON.stringify({ ok: true, engagement: id, items: store.listAttackFiles(id, { target: args.target }) }, null, 2)
      return JSON.stringify({ ok: true, engagement: id, folders: store.attackFileTree(id) }, null, 2)
    },
  })))





  /* ── 收尾自检 ────────────────────────────────────────────────────────────
     收口前把"看起来拿到了"和"报告能站住"之间的差距一次列清：
     资产状态、漏洞证据、步骤可复现性、入口可用性。模型据此补完再交报告。 */
  collect(withStructuredErrors(defineTool({
    name: 'redteam_hypothesis_add',
    description: '【开一条假设】一条待验证的测试方向。三样必填：测什么（surface）、为什么值得测（why）、什么结果算证伪（falsify）——说不清证伪判据的就别开，那只是"试过"。其余（预期类型与成因、成立条件、验证方式）尽量写全，报告与下一轮经验都从这里长出来。',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      asset_id: { type: 'number', description: '关联资产 id（可选）' },
      surface: { type: 'string', required: true, description: '对象：页面 / 接口 / 参数，例如 POST /api/cart/items 的 cartId' },
      why: { type: 'string', required: true, description: '为什么值得测：指纹、业务位置、返回差异、历史 CVE…' },
      vuln_class: { type: 'string', description: '预期漏洞类型，例如 IDOR / SSRF / SQLi' },
      cause: { type: 'string', description: '成因：预期它在哪一层漏了校验' },
      conditions: { type: 'string', description: '成立条件：需要什么身份、什么前置状态' },
      test_plan: { type: 'string', description: '验证方式：打算怎么打，差分怎么组' },
      falsify: { type: 'string', required: true, description: '什么结果算证伪：看到什么就判定不成立' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addHypothesis(id, { ...args, engagement: undefined, agent: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_hypothesis_close',
    description: '【关一条假设】结局只有三种：confirmed（成立，挂 vuln_id 或给 evidence）、refuted（不成立，必须写依据：回显/版本/权限位/差分结果）、blocked（打不了，必须写外部原因：WAF/无凭据/目标下线）。refuted 与 blocked 也是成果——它们让下一轮不重走这条路。confirmed 的漏洞先走 vuln_add 落库，这里只传 vuln_id。',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      id: { type: 'number', required: true, description: '假设 id（hypothesis_list 拿）' },
      status: { type: 'string', required: true, enum: ['confirmed', 'refuted', 'blocked'] },
      basis: { type: 'string', description: '依据 / 原因（refuted、blocked 必填）' },
      vuln_id: { type: 'number', description: 'confirmed 时挂的已有漏洞 id（先 vuln_add）' },
      evidence: { type: 'string', description: 'confirmed 时的证据（请求/响应摘要）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      /* 旧的混写入口已拆掉：显式拒绝，避免模型以为漏洞/报文已经落库。 */
      if (args.vuln !== undefined || args.http_evidence !== undefined) {
        return JSON.stringify({
          ok: false,
          error: 'hypothesis_close 只关假设：漏洞先用 vuln_add 落库、报文用 http_evidence_add，再传 vuln_id',
          error_kind: 'bad_input',
        }, null, 2)
      }
      const result = store.closeHypothesis(id, args.id, {
        status: args.status, basis: args.basis, vuln_id: args.vuln_id ?? null, evidence: args.evidence,
        engagement: undefined, closed_by: agentOf(args),
      })
      return JSON.stringify({
        ok: true, engagement: id, ...result,
        stats: store.hypothesisStats(id),
      }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_hypothesis_list',
    description: '看假设的账：每条假设的对象、为什么、证伪判据与结局，以及统计（提了几条 / 成立 / 证伪 / 打不了 / 成立率）。开工前看还有哪些开着，收口前看有没有没关的。',
    parameters: {
      engagement: { type: 'string' },
      status: { type: 'string', enum: ['open', 'confirmed', 'refuted', 'blocked'] },
      asset_id: { type: 'number' },
      limit: { type: 'number', description: '默认 100，最大 500' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, ...store.listHypotheses(id, args) }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_coverage',
    description: '覆盖账本：按 面（host/URL）× 测试类（authn/authz/injection/file/ssrf/logic/client/infra）× 结论（untested/tested/clean/skipped）记账。op=set 写入；list 看明细；gaps 看“哪个资产缺哪几类”；skip_rest 把不适用/本轮不测的类批量标 skipped（写原因）。surface + note 同时就是入口清单。收口前先看 gaps，空格就是没测。',
    parameters: {
      engagement: { type: 'string' },
      op: { type: 'string', enum: ['set', 'list', 'gaps', 'skip_rest'], description: '默认 set' },
      surface: { type: 'string', description: '面：host 或 URL（set 必填，list 可筛）' },
      asset_id: { type: 'number', description: '关联资产 id（可选）' },
      asset_ids: { type: 'array', items: { type: 'number' }, description: 'skip_rest：要批量标记的资产 id；不传则配合 all:true' },
      all: { type: 'boolean', description: 'skip_rest：对所有仍需要的资产执行（慎用，note 必须写清原因）' },
      test_classes: { type: 'array', items: { type: 'string' }, description: 'skip_rest：要标记的测试类，默认全部八类；只填空格，不动已 tested/clean' },
      test_class: { type: 'string', enum: ['authn', 'authz', 'injection', 'file', 'ssrf', 'logic', 'client', 'infra'], description: '测试类；list 时可筛' },
      status: { type: 'string', enum: ['untested', 'tested', 'clean', 'skipped'], description: '结论；新记录默认 untested；skipped 必须写 note 原因' },
      note: { type: 'string', description: '结论/排除原因；skipped 与 skip_rest 必填' },
      limit: { type: 'number', description: 'gaps/list 返回条数，默认 20' },
      by: { type: 'string', description: '记录者' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      if (args.op === 'list') return JSON.stringify({ ok: true, engagement: id, ...store.coverageList(id, args) }, null, 2)
      if (args.op === 'gaps') return JSON.stringify({ ok: true, engagement: id, ...store.matrixGaps(id, args) }, null, 2)
      if (args.op === 'skip_rest') {
        return JSON.stringify({
          ok: true, engagement: id,
          ...store.coverageSkipRest(id, { ...args, by: args.by || agentOf(args) }),
        }, null, 2)
      }
      const result = store.coverageSet(id, { ...args, by: args.by || agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_closeout',
    description: '【收口前核对】核对成果能不能站住：没覆盖的资产、只做了一部分的测试格、缺证据或 HTTP 目标的 exploited 缺报文、证据不同源、缺命令或结果的攻击步骤、不可用或不成立的入口、未关假设。返回 gaps 清单与 counts；gaps 为空且没有待复核，才算可以出正式报告。',
    parameters: {
      engagement: { type: 'string' },
      lessons: {
        type: 'array',
        description: '可选，0–3 条可复用判断：换到另一个同栈靶标仍然成立的经验。每条形如 {title:"现象→判断", category:"authn|authz|injection|file|ssrf|logic|client|infra|negative|yield", component:"产品名", versions:"受影响版本", content:"现象 + 判断（给下次直接照用）", evidence:"这次看到的证据一句"}。只写判断，不写"打了哪个 IP"；也可以是收益判断（哪类资产上什么动作不划算，category 用 yield）。',
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const savedLessons = []
      for (const it of (Array.isArray(args.lessons) ? args.lessons.slice(0, 3) : [])) {
        try {
          const r = store.lessonSave(it || {}, { engagement: id })
          savedLessons.push(r && r.poc ? r.poc.code : (r && r.code))
        } catch { /* 单条经验写失败不影响收口结论 */ }
      }

      const release = store.releaseGaps(id)
      const gaps = release.gaps.map((g) => g.message)
      const stats = release.stats
      const matrix = release.matrix
      const matrixGaps = release.matrixGaps
      const untested = release.untested
      const evidence = release.evidence
      const confirmed = release.confirmed
      const noHttp = evidence.noHttp
      const mismatched = evidence.mismatched
      const pendingReview = release.pendingReview
      const steps = release.steps
      const summary = release.summary
      const hyp = release.hyp

      return JSON.stringify({
        ok: true, engagement: id,
        ready: gaps.length === 0 && pendingReview.length === 0,
        technical_ready: gaps.length === 0,
        counts: {
          assets: stats.assets, untested, open_ports: stats.openPorts,
          coverage_cells: matrix ? { tested: matrix.tested_cells, total: matrix.cells, gaps: matrix.gaps, partial_gaps: matrix.partial_gaps, exempt_assets: matrix.exempt_assets } : undefined,
          matrix_gaps: matrix ? matrix.partial_gaps : undefined,
          vulns_confirmed: confirmed.length, chain_steps: steps.length,
          vulns_no_http: noHttp.length,
          vulns_evidence_mismatch: mismatched.length,
          vulns_pending_review: pendingReview.length,
          hypotheses: hyp,
          tunnels_active: (summary.tunnels || []).filter((t) => t.status === 'active').length,
          webshells_online: (summary.webshells || []).filter((w) => w.status === 'online').length,
        },
        gaps,
        matrix_gaps: matrixGaps && matrixGaps.items.length
          ? {
            total_missing_cells: matrixGaps.total_missing_cells,
            assets_with_gaps: matrixGaps.assets_with_gaps,
            items: matrixGaps.items,
            exempt: matrixGaps.exempt.length ? matrixGaps.exempt : undefined,
            hint: matrixGaps.hint,
          }
          : undefined,
        directions: (release.blockedHyp.length || release.refutedHyp.length)
          ? {
            blocked: release.blockedHyp.slice(0, 10).map((h) => ({
              surface: h.surface, asset_ip: h.asset_ip || undefined, vuln_class: h.vuln_class || undefined,
              why: h.why || undefined, basis: h.basis || undefined, closed_at: h.closed_at || undefined,
            })),
            refuted: release.refutedHyp.slice(0, 10).map((h) => ({
              surface: h.surface, asset_ip: h.asset_ip || undefined, vuln_class: h.vuln_class || undefined,
              why: h.why || undefined, basis: h.basis || undefined, closed_at: h.closed_at || undefined,
            })),
            total_blocked: hyp.blocked || 0,
            total_refuted: hyp.refuted || 0,
            note: '这些是已知打不通 / 已证伪的方向：写进报告边界，下一轮先看 brief 里的 blocked_directions，不要重复撞。',
          }
          : undefined,
        pending_review: pendingReview.length
          ? {
            count: pendingReview.length,
            items: pendingReview.slice(0, 10).map((v) => ({ id: v.id, title: v.title, status: v.status })),
            note: '这些等人复核（确认/误报/已修复），不是你能补的缺口；汇报里列出来即可',
          }
          : undefined,
        lessons_saved: savedLessons.length ? savedLessons : undefined,
        next: gaps.length === 0
          ? (pendingReview.length
            ? '技术工作已收口；还有 ' + pendingReview.length + ' 条待人工复核，复核后才能出报告；可先用 redteam_report_draft 取草稿'
            : '技术工作已收口：可先用 redteam_report_draft 取 Markdown 草稿，正式报告到面板「交付 → 报告」生成')
          : '按 gaps 逐条补齐后再跑一次 redteam_closeout；补不上的在汇报里说明原因，不要当成成果',
      }, null, 2)
    },
  })))

  /* 只读报告草稿：模型收口后至少能把内容带回对话；不落文件、不绕报告门。 */
  collect(withStructuredErrors(defineTool({
    name: 'redteam_report_draft',
    description: '只读生成报告草稿：返回 Markdown，不落文件、不绕报告门；正式报告仍在面板生成。收口后用它先把可交付内容带回对话，避免“跑完了没东西”。',
    parameters: {
      engagement: { type: 'string' },
      title: { type: 'string', description: '报告标题，默认“渗透测试报告”' },
      max_chars: { type: 'number', description: '返回正文上限，默认 30000，最大 80000' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const blockers = []
      try {
        const release = store.releaseGaps(id)
        blockers.push(...release.gaps.map((g) => g.message))
        if (release.pendingReview.length > 0) blockers.push(release.pendingReview.length + ' 条漏洞待人工复核')
      } catch { /* 老库字段缺失时仍返回草稿 */ }
      const report = store.report(id, { title: args.title || '渗透测试报告' })
      const md = String(report.markdown || '')
      const max = Math.min(Math.max(Number(args.max_chars) || 30000, 1000), 80000)
      const banner = blockers.length > 0
        ? '> **草稿 / 未收口**：' + blockers.join('；') + '\n\n'
        : ''
      return JSON.stringify({
        ok: true, engagement: id, ready: blockers.length === 0, blockers,
        chars: md.length,
        markdown: banner + (md.length > max ? md.slice(0, max) + '\n\n…（截断）' : md),
      }, null, 2)
    },
  })))

  /* ── 知识库（POC/EXP）：全局共享，跨靶标复用 ───────────────────────────────
     为什么单列一组工具：通用 POC/EXP 是一次性投入、长期复用的资产。打 Nday/1day
     之前先查这里，能省掉整轮"去互联网找 + 手搓 + 调试"的时间；验证有效的通用
     POC/EXP 必须回填，后面的靶标和智能体直接就能用。 */

  collect(withStructuredErrors(defineTool({
    name: 'redteam_poc_search',
    description: '【Nday/1day 前先查现成的】先查"现成的"两层：① **知识库**（本机沉淀的通用 POC/EXP，跨靶标共享，按"已验证 → 复用次数"排序）② **本机 nuclei 模板库**（上万条模板，CVE/组件名直接命中）。命中就取用：知识库用 redteam_poc_get 拿全文，模板直接 `nuclei -t <相对路径>`。两层都没有，再去互联网搜索或自己手搓，验证有效后用 redteam_poc_add 回填知识库。',
    parameters: {
      q: { type: 'string', description: '关键字：组件+版本、漏洞名、路径片段、正文里的特征串都行' },
      cve: { type: 'string', description: 'CVE / CNVD 编号，例如 CVE-2023-21839' },
      component: { type: 'string', description: '组件/产品名，例如 Weblogic、Shiro、泛微 OA、Nacos' },
      kind: { type: 'string', description: 'poc | exp | script | template | payload' },
      category: { type: 'string', description: '按**归类**筛（可多值，逗号分隔）：rce | deserialization | file-upload | sqli | unauthorized | auth-bypass | weak-password | ssrf | xxe | path-traversal | info-leak | privesc | tunnel | tradecraft | negative | other' },
      engagement: { type: 'string', description: '按**来源靶标**筛（靶标 id 或名称关键词）：只看"在某个单位上验证过的"经验' },
      asset_target: { type: 'string', description: '按**发现资产**筛（IP / 域名 / URL 片段）' },
      language: { type: 'string', description: 'python | go | java | bash | http | nuclei | js | php' },
      source: { type: 'string', description: 'web（互联网）| self（手搓）| manual（人工）| nuclei-template' },
      verified: { type: 'boolean', description: 'true 只看实测验证过的（优先用这些）' },
      templateLimit: { type: 'number', description: '本机 nuclei 模板最多返回几条，默认 20' },
      limit: { type: 'number', description: '知识库条目上限，默认 200' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const items = store.searchPocs(args)
      const stats = store.pocStats()
      const q = args.q || args.cve || args.component || ''
      /* templateStats() / nucleiTemplatesDir() 都要扫模板目录：**一次调用只算一次**。
         原来这一小段里 templateStats() 被连着算了三遍（13k 模板的目录每次都要走一遍）。 */
      const tplStats = store.templateStats()
      const tpl = (q || args.category)
        ? store.searchTemplates(q, Math.min(Number(args.templateLimit) || 20, 100), 0, args.category || '')
        : { dir: tplStats.dir || store.nucleiTemplatesDir() || null, total: tplStats.total, items: [], byCategory: tplStats.byCategory }
      const hit = items.length > 0 || (tpl.items || []).length > 0
      return JSON.stringify({
        ok: true,
        knowledge_base: {
          total: stats.total, verified: stats.verified, reused: stats.reused,
          /* 归类概览：让智能体知道"哪类武器已经攒了多少"，缺哪类心里有数 */
          by_category: (stats.byCategory || []).filter((c) => c.n > 0).map((c) => c.name + ' ' + c.n + '（已验证 ' + c.verified + '）'),
          by_engagement: (stats.byEngagement || []).slice(0, 10).map((e) => e.engagement + ' ' + e.n),
        },
        local_templates: {
          dir: tplStats.dir, total: tplStats.total, cve_templates: tplStats.cve, matched: (tpl.items || []).length,
          by_category: (tplStats.byCategory || []).filter((c) => c.n > 0).map((c) => c.name + ' ' + c.n),
        },
        count: items.length,
        hint: hit
          ? '命中现成的：知识库条目用 redteam_poc_get 取全文；nuclei 模板直接用 `nuclei -t <模板相对路径>`。用完 redteam_poc_use 记一次复用。'
          : '知识库与本机模板库都没有：去互联网搜索（web_search / GitHub / ExploitDB / 厂商公告）或自己手搓，验证有效后务必 redteam_poc_add 回填知识库（带 category + engagement + asset_target + verified_note）。',
        templates: (tpl.items || []).map((t) => ({ path: t.path, name: t.name, severity: t.severity, tags: t.tags })),
        items: items.map((x) => ({
          id: x.id, code: x.code, title: x.title, kind: x.kind, category: x.category, cve: x.cve, component: x.component,
          versions: x.versions, language: x.language, source: x.source, source_url: x.source_url,
          verified: x.verified === 1, verified_note: x.verified_note, hit_count: x.hit_count,
          /* 来源溯源：哪条经验、哪个靶标、哪台资产、什么时候建的 */
          engagement: x.engagement_name || x.engagement_id || null, asset_target: x.asset_target || null,
          found_by_agent: x.found_by_agent || null, created_at: x.created_at,
          tags: x.tags, usage: x.usage, path: x.path, has_content: x.has_content === 1,
        })),
      }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_poc_get',
    description: '取一条知识库 POC/EXP 的**完整内容**（正文 + 用法 + 验证记录 + 落盘路径），可直接照用或改造成目标专用脚本。不传 id 时可用 code（redteam_poc_search 返回里的 code 字段）。',
    parameters: {
      id: { type: 'number', description: '知识库条目 id' },
      code: { type: 'string', description: '知识库条目的稳定标识（search 结果里的 code）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const row = store.getPoc(args.id !== undefined ? args.id : args.code)
      if (row === undefined) return JSON.stringify({ ok: false, error: '知识库没有这一条（先用 redteam_poc_search 检索）' }, null, 2)
      return JSON.stringify({ ok: true, ...row }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_poc_add',
    description: '把通用可复用的 POC/EXP 落进知识库（跨靶标共享）。判据是**换个目标还能用**；只对本次靶标有效的脚本走 redteam_attack_file_add。同名 code 合并刷新，可用于更新版本。知识库是增量资产，以新增为主、旧条目只修正。事件复盘里能搬到别的目标的攻击思路、未公开漏洞的利用条件也算知识（category 用 tradecraft）。回填三件套：category 归类、engagement + asset_target 交代来源、verified + verified_note 给证据。',
    parameters: {
      title: { type: 'string', required: true, description: '标题：组件 + 漏洞名/编号，例如「Weblogic T3 反序列化 CVE-2023-21839」' },
      code: { type: 'string', description: '稳定标识；留空按标题生成。同一 code 再次写入会合并刷新，比标题更稳' },
      kind: { type: 'string', description: 'poc（验证）| exp（利用）| script | template | payload' },
      category: { type: 'string', description: '【归类，建议必填】rce 远程命令执行 | deserialization 反序列化 | file-upload 文件上传 getshell | sqli SQL 注入 | unauthorized 未授权访问 | auth-bypass 认证绕过/越权 | weak-password 弱口令 | ssrf | xxe | path-traversal 目录穿越/任意文件读 | info-leak 信息泄露 | privesc 提权/横向 | tunnel 隧道/代理 | tradecraft 攻击方思路/战术（事件复盘、未公开利用条件） | negative 排除/误报（证伪、打不通、误报） | other 其它' },
      cve: { type: 'string', description: 'CVE / CNVD 编号' },
      component: { type: 'string', description: '组件/产品名（便于按组件检索）' },
      versions: { type: 'string', description: '影响版本范围' },
      severity: { type: 'string', description: 'critical | high | medium | low' },
      language: { type: 'string', description: 'python | go | java | bash | http | nuclei | js | php' },
      source: { type: 'string', description: 'web（互联网扒的）| self（自己手搓）| manual（人工）| nuclei-template' },
      source_url: { type: 'string', description: '来源链接（互联网来源必填，便于复核）' },
      description: { type: 'string', description: '这个 POC 干什么、原理要点、前提条件' },
      usage: { type: 'string', description: '用法：完整命令行示例 + 需要替换的参数' },
      content: { type: 'string', description: '正文：脚本/POC 源码、原始请求包、nuclei 模板、调用步骤' },
      path: { type: 'string', description: '也可以给本机已有文件路径（相对 pocs/ 或绝对路径），由知识库读取正文' },
      filename: { type: 'string', description: '正文落盘文件名，默认按语言给（poc.py / poc.sh / poc.yaml…）' },
      verified: { type: 'boolean', description: '是否已实测验证（**只有在真实目标上验证过的才填 true**）' },
      verified_note: { type: 'string', description: '验证证据：在哪台目标、什么回显/结果、是否需要认证' },
      engagement: { type: 'string', description: '【来源靶标】这条知识是在哪个靶标上发现/验证的（填靶标 id 或单位名称）' },
      asset_target: { type: 'string', description: '【发现资产】具体是在哪台资产/哪个目标上验证成功的，例如 10.1.2.3:8080 或 http://oa.demo.com' },
      found_by_agent: { type: 'string', description: '发现它的角色 code（recon / assess / vuln-scan / exploit / internal）' },
      tags: { type: 'string', description: '逗号分隔标签，例如「java,反序列化,rce」' },
      created_by: { type: 'string', description: '哪个角色/智能体沉淀的' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      /* engagement 这个参数名在本工具里表示"来源靶标"，不是"作用在哪个靶标"，
         所以不能走 resolveEngagement；只做名称补全，把 id 与中文名都记下来便于面板归类。 */
      const payload = Object.assign({}, args)
      if (typeof args.engagement === 'string' && args.engagement.trim() !== '') {
        const wanted = args.engagement.trim()
        const hit = store.listEngagements().find((e) => e.id === wanted || String(e.name) === wanted || String(e.name).includes(wanted))
        payload.engagement_id = hit ? hit.id : wanted
        payload.engagement_name = hit ? hit.name : wanted
      }
      const r = store.savePoc(payload)
      const stats = store.pocStats()
      return JSON.stringify({
        ok: true, created: r.created, code: r.poc.code, path: r.path,
        category: r.poc.category, engagement: r.poc.engagement_name || r.poc.engagement_id || null,
        asset_target: r.poc.asset_target || null, created_at: r.poc.created_at,
        verified: r.poc.verified === 1,
        hint: '已进知识库（归类：' + (r.poc.category || 'other') + '，建立时间：' + r.poc.created_at + '），'
          + '后续任何靶标的智能体 redteam_poc_search 都能直接命中；知识库共 ' + stats.total + ' 条。',
      }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_poc_list',
    description: '列出知识库里的 POC/EXP（可按 kind/source/component/verified 过滤，不带条件就是全部）。用于盘点"我们手上已经有哪些现成武器"，避免重复搜集。',
    parameters: {
      kind: { type: 'string' }, source: { type: 'string' }, component: { type: 'string' },
      verified: { type: 'boolean' }, limit: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const items = store.searchPocs(args)
      const stats = store.pocStats()
      return JSON.stringify({ ok: true, stats: { total: stats.total, verified: stats.verified, by_kind: stats.byKind, by_source: stats.bySource },
        count: items.length,
        items: items.map((x) => ({ id: x.id, code: x.code, title: x.title, kind: x.kind, cve: x.cve, component: x.component,
          language: x.language, source: x.source, verified: x.verified === 1, hit_count: x.hit_count, tags: x.tags })) }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_poc_update',
    description: '更新知识库条目：补验证结论（verified + verified_note）、修正影响版本、补用法或正文、改标签。**在真实目标上验证通过后，一定要回来把 verified 置 true 并写清证据**——后续智能体会优先用已验证的。',
    parameters: {
      id: { type: 'number', description: '知识库条目 id' },
      code: { type: 'string', description: '或用 code 指定条目' },
      patch: {
        type: 'object', additionalProperties: true,
        description: '{ verified, verified_note, versions, usage, description, content, tags, severity, component, cve, source, source_url, language }',
      },
      verified: { type: 'boolean', description: '便捷写法：直接传 verified' },
      verified_note: { type: 'string', description: '便捷写法：直接传验证证据' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const patch = Object.assign({}, args.patch || {})
      if (args.verified !== undefined) patch.verified = args.verified
      if (args.verified_note !== undefined) patch.verified_note = args.verified_note
      const row = store.updatePoc(args.id !== undefined ? args.id : args.code, patch)
      return JSON.stringify({ ok: true, id: row.id, code: row.code, verified: row.verified === 1, verified_note: row.verified_note, updated_at: row.updated_at }, null, 2)
    },
  })))

  collect(withStructuredErrors(defineTool({
    name: 'redteam_poc_use',
    description: '记一次知识库 POC/EXP 的复用（用在哪个靶标/目标）。复用次数高的条目会排前面，方便后来者优先选经过实战的武器。',
    parameters: {
      id: { type: 'number' },
      code: { type: 'string' },
      used_on: { type: 'string', description: '用在哪：靶标名 / 目标 IP / URL' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const r = store.markPocUsed(args.id !== undefined ? args.id : args.code, args.used_on)
      return JSON.stringify(r, null, 2)
    },
  })))

  /* ── 唯一入口 ───────────────────────────────────────────────────────────
     动作表全部在 collected 里，只暴露一个 redteam 工具；
     完整参数 schema 用 action=help 按需取，平时只带一份索引。 */
  const visible = allowed.size === 0
    ? collected
    : new Map(Array.from(collected).filter(([name]) => allowed.has(name.replace(/^redteam_/, ''))))
  const actionNames = Array.from(visible.keys()).map((n) => n.replace(/^redteam_/, ''))
  /* 名字已经说清"对什么做什么"的动作不带预览（asset_get / vuln_query 这类）。
     预览只留给名字看不出产出或对象的：brief / triage / coverage / chain / ingest … */
  const INDEX_PREVIEW = new Set([
    'brief', 'preflight', 'triage', 'coverage', 'closeout', 'sessions', 'ingest', 'import',
    'agent_slot', 'asset_graph', 'attack_path', 'chain',
    'asset_assess', 'asset_test', 'capture', 'http_evidence_add',
    'role_prompt_reset', 'session_check', 'session_bind', 'session_info', 'engagement_open',
    'poc_search', 'attack_file_add', 'vps_exec', 'oast_poll',
  ])
  const actionIndexOf = (tool) => {
    const short = tool.name.replace(/^redteam_/, '')
    if (!INDEX_PREVIEW.has(short)) return short
    const first = String(tool.description || '').split(/[。；]/)[0] || ''
    return short + ' ' + first.slice(0, 26)
  }
  const compactIndex = config.compactIndex === true
  const indexText = compactIndex
    ? `索引已收起（共 ${actionNames.length} 个动作）：用 redteam({action:"help"}) 取完整动作名；常用 asset_add、asset_query、vuln_add、chain_add、asset_test、coverage、vps_exec。`
    : Array.from(visible.values()).map(actionIndexOf).join('｜')
  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam',
    description: '红队动作入口（唯一工具）：redteam({action, args})。动作名见下；参数结构用 action:"help", args:{name:"..."} 查。技能与角色稿里的 redteam_xxx 就是这里的 action（可省略前缀）。索引：'
      + indexText,
    parameters: {
      action: { type: 'string', required: true, description: '动作名；help 查看某个动作的参数结构' },
      args: { type: 'object', additionalProperties: true, description: '该动作的参数对象' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const raw = String((args && args.action) || '').trim()
      const inner = Object.assign({}, (args && args.args && typeof args.args === 'object' && !Array.isArray(args.args)) ? args.args : {})
      for (const [k, v] of Object.entries(args || {})) {
        if (k !== 'action' && k !== 'args' && inner[k] === undefined) inner[k] = v
      }
      if (raw === '' || raw === 'help' || raw === '?') {
        const want = String(inner.name || inner.action || '').trim()
        if (want === '') {
          return JSON.stringify({ ok: true, actions: actionNames, hint: 'redteam({action:"help", args:{name:"asset_add"}}) 取单个动作的参数结构' }, null, 2)
        }
        const helpKey = want.startsWith('redteam_') ? want : 'redteam_' + want
        const helpSpec = visible.get(helpKey)
        if (helpSpec === undefined) {
          const restricted = collected.has(helpKey)
          return JSON.stringify({
            ok: false,
            error: restricted ? '该动作仅主会话可用' : '未知动作：' + want,
            hint: '不带 name 调 help 列出当前角色可用动作',
          }, null, 2)
        }
        return JSON.stringify({ ok: true, name: helpKey, description: helpSpec.description, parameters: helpSpec.parameters }, null, 2)
      }
      const key = raw.startsWith('redteam_') ? raw : 'redteam_' + raw
      const spec = visible.get(key)
      if (spec === undefined) {
        return JSON.stringify({
          ok: false,
          error: collected.has(key) ? '该动作仅主会话可用' : '未知动作：' + raw,
          actions: actionNames,
          hint: '按上面的名字重试',
        }, null, 2)
      }
      const missing = Object.entries(spec.parameters || {})
        .filter(([, v]) => v && v.required === true)
        .map(([k]) => k)
        .filter((k) => inner[k] === undefined || inner[k] === null)
      if (missing.length > 0) {
        return JSON.stringify({ ok: false, error: '缺少必填参数：' + missing.join('、'), action: raw, parameters: spec.parameters }, null, 2)
      }
      return spec.execute(inner, exec)
    },
  })))
}
