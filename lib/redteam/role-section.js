/**
 * 红队子会话的角色稿。
 *
 * 指挥派活时在任务开头写 `engagement: <靶标 id>` 与 `redteamRole: <code>`。
 * 子会话领到这条用户消息时记下角色，组装系统提示词时把
 * `engagements/<靶标>/agents/<code>.md` 原样放进清洗稿和运行环境前提之间。
 * 没有角色行就不猜角色；子会话未绑定时只认任务书里的 engagement，不借用 current。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRedteamSession } from '../identity.js'
import { redteamRoot } from './platform-config.js'
import { boundEngagementForContext } from './session-bindings.js'

const ROLE_TAG = /^[ \t]*redteamRole[ \t]*[:：][ \t]*(recon|assess|vuln-scan|exploit|internal)[ \t]*$/i
const ENGAGEMENT_TAG = /^[ \t]*engagement[ \t]*[:：][ \t]*([^\s]+)[ \t]*$/i
/* 任务书允许 engagement 在前、redteamRole 在后。扫描前 20 个非空行：
   既覆盖“前面写了几行目标/范围”的任务书，又不会被正文深处的示例标签误伤。 */
const TAG_SCAN_LINES = 20

function linesOf(text) {
  return String(text || '').replace(/\r\n/g, '\n').split('\n')
}

export function parseRedteamRole(text) {
  let seen = 0
  for (const line of linesOf(text)) {
    if (line.trim() === '') continue
    const matched = line.match(ROLE_TAG)
    if (matched) return matched[1].toLowerCase()
    seen += 1
    if (seen >= TAG_SCAN_LINES) break
  }
  return ''
}

function parseEngagementTag(text) {
  let seen = 0
  for (const line of linesOf(text)) {
    if (line.trim() === '') continue
    const matched = line.match(ENGAGEMENT_TAG)
    if (matched) return matched[1]
    seen += 1
    if (seen >= TAG_SCAN_LINES) break
  }
  return ''
}

const roleBySession = new Map()
// 模块级 Map,跨 install/dispose 都不清,长开进程 session id 持续堆积。
// FIFO 兜底:超过 400 淘汰最早 100 条;角色很短(字符串),阈值可以放宽。
const ROLE_SESSION_CAP = 400
const ROLE_SESSION_EVICT = 100

function evictRoleBySessionIfOverflow() {
  if (roleBySession.size < ROLE_SESSION_CAP) return
  let i = 0
  for (const k of roleBySession.keys()) {
    if (i >= ROLE_SESSION_EVICT) break
    roleBySession.delete(k)
    i += 1
  }
}

export function textOfMessage(message) {
  if (!message) return ''
  if (typeof message === 'string') return message
  const content = message.content ?? message.text
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('\n')
}

function remember(agent, role) {
  const ids = [agent?.session?.id, agent?.id].filter((id) => id !== undefined && id !== null)
  if (ids.length) evictRoleBySessionIfOverflow()
  for (const id of ids) roleBySession.set(String(id), role)
}

function isRedteamChild(session, agent) {
  const header = session?.header
  if (header?.origin !== 'subagent' && !((header?.delegationDepth ?? 0) > 0)) return false
  return isRedteamSession({ session, agent: agent ? { ...agent, session } : { session } })
}

export function noteClaimedMessage(payload) {
  const agent = payload?.agent
  const session = agent?.session
  if (!isRedteamChild(session, agent)) return
  const role = parseRedteamRole(textOfMessage(payload?.message))
  if (!role) return
  remember(agent, role)
}

function userMessagesOf(session) {
  const events = []
  try {
    if (typeof session?.snapshotEvents === 'function') {
      const got = session.snapshotEvents()
      if (Array.isArray(got)) events.push(...got)
    }
  } catch { /* 读不到历史就只用已记下的角色 */ }
  if (Array.isArray(session?.events)) events.push(...session.events)
  const out = []
  for (const event of events) {
    if (!event || event.type !== 'user/message') continue
    const data = event.data
    out.push(textOfMessage(data?.message || data))
  }
  return out
}

function roleFromSessionEvents(session) {
  let found = ''
  for (const text of userMessagesOf(session)) {
    const role = parseRedteamRole(text)
    if (role) found = role
  }
  return found
}

/* 子会话在 session_bind 之前也能从任务书里读到目标，先给正确的角色稿；
   绑定之后仍以绑定为准。 */
function engagementFromSessionEvents(session) {
  let found = ''
  for (const text of userMessagesOf(session)) {
    const id = parseEngagementTag(text)
    if (id) found = id
  }
  return found
}

function safeEngagementId(id) {
  const text = String(id || '').trim()
  if (!text || text.length > 200) return ''
  if (text.includes('..') || text.includes('/') || text.includes('\\') || text.includes('\0')) return ''
  return text
}

function currentEngagementId(root) {
  try {
    const base = String(root || redteamRoot())
    const id = safeEngagementId(readFileSync(join(base, 'current'), 'utf8'))
    if (!id) return ''
    if (!existsSync(join(base, 'engagements', id, 'agents'))) return ''
    return id
  } catch {
    return ''
  }
}

/**
 * 角色稿根目录：优先用运行中 store 的真实根（宿主可能配了 REDTEAM_HOME / 换盘），
 * 拿不到再退回 $DSH_HOME/redteam。以前固定用 redteamRoot()，在分叉环境里
 * 面板写在一处、这里读另一处，角色稿会静默变空。
 */
function roleRootOf(context) {
  try {
    const ctx = context?.agent?.ctx || context?.ctx
    const store = ctx?.redteam || (ctx && typeof ctx.get === 'function' ? ctx.get('redteam') : null)
    const root = store && typeof store.root === 'string' ? store.root.trim() : ''
    if (root) return root
  } catch { /* 取不到就用默认根 */ }
  const env = String(process.env.REDTEAM_HOME || '').trim()
  if (env) return env
  return redteamRoot()
}

/**
 * 优先用本会话的绑定靶标；子会话未绑定时只看任务书声明的 engagement，
 * 不再回退全局 current（那个指针可能是另一个目标的）。
 * 主会话仍可回退 current，用于旧会话/冷启动。
 */
function roleEngagementId(context) {
  const root = roleRootOf(context)
  const bound = safeEngagementId(boundEngagementForContext(context))
  if (bound && existsSync(join(root, 'engagements', bound, 'agents'))) return bound

  const agent = context?.agent
  const session = agent?.session || context?.session
  const declared = safeEngagementId(engagementFromSessionEvents(session))
  if (declared && existsSync(join(root, 'engagements', declared, 'agents'))) return declared

  if (isRedteamChild(session, agent)) return ''
  return currentEngagementId(root)
}

function readRoleFile(root, engagementId, role) {
  const id = safeEngagementId(engagementId)
  if (!id || !parseRedteamRole('redteamRole: ' + role)) return ''
  try {
    const path = join(String(root || redteamRoot()), 'engagements', id, 'agents', role + '.md')
    if (!existsSync(path)) return ''
    const text = readFileSync(path, 'utf8').trim()
    /* 角色稿为空视为缺失：面板不允许存空稿，这里再兜一层。 */
    if (!text) return ''
    return text
  } catch {
    return ''
  }
}

export function resolveSubagentRoleText(context) {
  try {
    const agent = context?.agent
    const session = agent?.session || context?.session
    if (!isRedteamChild(session, agent)) return ''
    const sessionId = session?.id ?? agent?.id
    let role = sessionId !== undefined && sessionId !== null
      ? roleBySession.get(String(sessionId)) || ''
      : ''
    if (!role) {
      role = roleFromSessionEvents(session)
      if (role) remember(agent || { session }, role)
    }
    if (!role) return ''
    return readRoleFile(roleRootOf(context), roleEngagementId(context), role)
  } catch {
    return ''
  }
}

export function installSubagentRoleCapture(ctx) {
  if (!ctx || typeof ctx.on !== 'function') return
  if (ctx.__dshForgeRoleCapture) return
  ctx.__dshForgeRoleCapture = true
  const hook = (payload) => {
    try { noteClaimedMessage(payload) } catch { /* 记角色失败不阻断领消息 */ }
  }
  // ctx.effect:plugin dispose 时解绑 agent/inbox/claimed,否则重载后角色记录函数 N 份叠加触发。
  // installed flag:cordis 允许同一 handler 多次注册会多次触发;我们只需挂一次。
  const effect = ctx.effect
  if (typeof effect === 'function') {
    effect.call(ctx, () => {
      let installed = false
      let disposer = null
      const install = () => {
        if (installed) return
        try {
          disposer = ctx.on('agent/inbox/claimed', hook, { global: true, prepend: true })
          installed = true
        } catch { /* ignore */ }
      }
      install()
      queueMicrotask(install)
      const timer = setTimeout(install, 800)
      return () => {
        clearTimeout(timer)
        try { if (typeof disposer === 'function') disposer() } catch { /* ignore */ }
        delete ctx.__dshForgeRoleCapture
      }
    })
    return
  }
  // ctx.effect 不可用(非 cordis 环境)时退回原逻辑。
  let installed = false
  const install = () => {
    if (installed) return
    try { ctx.on('agent/inbox/claimed', hook, { global: true, prepend: true }); installed = true } catch { /* ignore */ }
  }
  install()
  queueMicrotask(install)
  setTimeout(install, 800)
}
