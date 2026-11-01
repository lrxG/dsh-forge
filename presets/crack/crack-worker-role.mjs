/**
 * 破解模式的叶子子级约束（dsh 0.2.1-rc.2 迁移）。
 *
 * 旧版靠 tool-subagent 的 toolFilter.deny 把 subagent_fork / workflow / ralph
 * 从子会话工具目录摘掉；0.2.1-rc.2 移除了该字段（加载即抛
 * "toolFilter is no longer supported"，整个预设判 broken）。
 * 迁移路径：子级独立预设 + 子级预设内自行 tools.restrict()。
 *
 * 关键实现约束（踩过两次）：
 *   1. Cordis 读 ctx.agent / ctx.tools 前必须先 inject，否则报
 *      cannot get property "agent" without inject；
 *   2. 但 inject 是「预检门」——服务不在时整行被判 failed。tools 是预设内 scoped
 *      服务，这里改成可选依赖 inject: { tools: { required: false } }，
 *      拿不到就安静跳过，不再拖垮整份预设。
 *
 * 与红队 worker 的角色约束各自独立，互不干扰。
 */
export const name = 'dsh-forge-crack-leaf'

/** agent 必选（要读会话）；tools 可选（拿不到就跳过 restrict）。 */
export const inject = {
  agent: { required: true },
  tools: { required: false },
}

/** 子会话里要摘掉的派发/编排工具（都是全局工具名）。 */
const DENY = ['subagent', 'subagent_fork', 'workflow', 'ralph']

function sessionOf(ctx) {
  try {
    return ctx?.agent?.session || ctx?.session || null
  } catch {
    return null
  }
}

function activeTools(ctx) {
  try {
    return ctx?.tools || ctx?.get?.('tools') || null
  } catch {
    return null
  }
}

function presetLabel(value) {
  if (typeof value === 'string') return value.trim()
  if (!value || typeof value !== 'object') return ''
  if (typeof value.id === 'string' && value.id.trim()) return value.id.trim()
  if (typeof value.name === 'string' && value.name.trim()) return value.name.trim()
  return ''
}

const CRACK_PRESETS = new Set(['crack', 'crack-worker', 'crack-leaf'])

function isCrackLabel(value) {
  const label = presetLabel(value)
  if (!label) return false
  if (CRACK_PRESETS.has(label)) return true
  return /破解/.test(label)
}

/** 沿 parentSession 走到根会话，看根预设是不是破解模式。 */
function rootIsCrack(ctx) {
  const session = sessionOf(ctx)
  let cursor = session
  const seen = new Set()
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const label = presetLabel(cursor?.projectionValues?.agentPreset)
      || presetLabel(cursor?.agentPreset)
      || presetLabel(cursor?.header?.agentPreset)
    if (label) return isCrackLabel(label)
    const parentId = cursor?.header?.parentSession
    if (!parentId) break
    let parent = null
    try {
      const agents = ctx?.agents || ctx?.get?.('agents')
      parent = agents?.get?.(parentId)?.session || null
    } catch { /* 读不到父会话就用当前会话判定 */ }
    if (!parent) break
    cursor = parent
  }
  return isCrackLabel(session?.header?.agentPreset)
}

function isChildSession(session) {
  if (!session) return false
  const header = session.header || {}
  return Boolean(header.parentSession)
    || header.origin === 'subagent'
    || (header.delegationDepth ?? 0) > 0
}

export function apply(ctx) {
  const session = sessionOf(ctx)
  if (!isChildSession(session)) return
  if (!rootIsCrack(ctx)) return
  const tools = activeTools(ctx)
  if (!tools || typeof tools.restrict !== 'function') {
    ctx.logger?.info?.('dsh-forge-crack-leaf: 当前没有 tools 服务，跳过叶子裁剪（maxDepth 仍是兜底）')
    return
  }
  try {
    tools.restrict({ deny: DENY })
    ctx.logger?.info?.('dsh-forge-crack-leaf: 子会话已摘掉派发工具 %s', DENY.join(', '))
  } catch (error) {
    ctx.logger?.warn?.('dsh-forge-crack-leaf: tools.restrict 失败：%s', error?.message || String(error))
  }
}

export default { name, inject, apply }
