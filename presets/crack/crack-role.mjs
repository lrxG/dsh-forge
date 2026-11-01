/**
 * dsh-forge 破解模式角色门（预设平面插件行，随预设 composition 挂载）
 *
 * 本地定制版，私有使用。
 * 借鉴红队角色门 lib/redteam/role-section.js 的「首行角色标签 → 子会话角色稿注入」架构。
 *
 * 破解指挥官派活时在任务第一行写 `crackRole: <code>`。
 * 子会话领到这条消息时记下角色，组装系统提示词时把
 * `$DSH_HOME/crack/agents/<code>.md` 作为独立 section 塞进角色稿。
 * 没有这一行就不猜角色。code 只能是 triage / static / dynamic / patch / verify。
 *
 * 只对「破解模式」的 subagent 子会话生效：先沿 parentSession 走到根会话，
 * 根会话预设 id 不是 crack（或名称不含「破解」）就不注入。
 * 与红队的 redteamRole 互不干扰（各自正则、各自 section）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-forge-crack-role-gate'

const ROLE_TAG = /^[ \t]*crackRole:[ \t]*(triage|static|dynamic|patch|verify)[ \t]*$/i

function firstNonEmptyLine(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n')
  return lines.find((line) => line.trim() !== '') || ''
}
const ROLE_SECTION = 'dsh-crack-role'

const roleBySession = new Map()
const ROLE_SESSION_CAP = 400
const ROLE_SESSION_EVICT = 100

function crackRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'crack')
}

function evictIfOverflow() {
  if (roleBySession.size < ROLE_SESSION_CAP) return
  let i = 0
  for (const key of roleBySession.keys()) {
    if (i >= ROLE_SESSION_EVICT) break
    roleBySession.delete(key)
    i += 1
  }
}

export function parseCrackRole(text) {
  const matched = firstNonEmptyLine(text).match(ROLE_TAG)
  return matched ? matched[1].toLowerCase() : ''
}

function textOfMessage(message) {
  if (!message) return ''
  if (typeof message === 'string') return message
  const content = message.content ?? message.text
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('\n')
}

function presetLabel(value) {
  if (typeof value === 'string') return value.trim()
  if (!value || typeof value !== 'object') return ''
  if (typeof value.id === 'string' && value.id.trim()) return value.id.trim()
  if (typeof value.name === 'string' && value.name.trim()) return value.name.trim()
  return ''
}

const CRACK_PRESET_IDS = new Set(['crack', 'crack-worker', 'crack-leaf'])

function isCrackLabel(value) {
  const text = presetLabel(value)
  if (!text) return false
  if (CRACK_PRESET_IDS.has(text)) return true
  if (text.toLowerCase() === 'crack') return true
  return /破解/.test(text)
}

function sessionOfContext(context) {
  return context?.agent?.session || context?.session || null
}

function inheritsParentPrompt(session) {
  const header = session?.header
  if (!header?.parentSession) return false
  return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
}

function parentSessionRecord(context, parentId) {
  const ctx = context?.agent?.ctx || context?.ctx
  if (!ctx || !parentId) return null
  try {
    const registry = ctx.agents || ctx.get?.('agents')
    const parent = registry?.get?.(parentId)
    if (parent?.session) return parent.session
  } catch { /* 读不到就用子会话自己的预设 */ }
  return null
}

function rootSession(context) {
  let session = sessionOfContext(context)
  const seen = new Set()
  while (session && !seen.has(session)) {
    seen.add(session)
    if (!inheritsParentPrompt(session)) return session
    const parent = parentSessionRecord(context, session.header.parentSession)
    if (!parent || parent === session) return session
    session = parent
  }
  return sessionOfContext(context)
}

function sessionPresetLabel(session, context) {
  // 优先：当前挂载的预设（registry.composedPreset）
  try {
    const ctx = context?.agent?.ctx || context?.ctx
    const presets = ctx?.get?.('agentPresets') || ctx?.agentPresets
    if (presets && typeof presets.composedPreset === 'function') {
      const label = presetLabel(presets.composedPreset(ctx))
      if (label) return label
    }
  } catch { /* 软取失败继续 */ }
  if (!session) return ''
  const projection = presetLabel(session?.projectionValues?.agentPreset)
  if (projection) return projection
  const direct = presetLabel(session?.agentPreset)
  if (direct) return direct
  return presetLabel(session?.header?.agentPreset)
}

function isCrackSubagent(context) {
  const session = sessionOfContext(context)
  const header = session?.header
  if (!header) return false
  const isChild = header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
  if (!isChild) return false
  const root = rootSession(context)
  return isCrackLabel(sessionPresetLabel(root, context)) || isCrackLabel(sessionPresetLabel(session, context))
}

function remember(agent, role) {
  const ids = [agent?.session?.id, agent?.id].filter((id) => id !== undefined && id !== null)
  if (ids.length) evictIfOverflow()
  for (const id of ids) roleBySession.set(String(id), role)
}

function noteClaimedMessage(payload) {
  try {
    const agent = payload?.agent
    const session = agent?.session
    if (!session || !isCrackSubagent({ agent, session })) return
    const role = parseCrackRole(textOfMessage(payload?.message))
    if (!role) return
    remember(agent, role)
  } catch { /* 记角色失败不阻断领消息 */ }
}

function roleFromSessionEvents(session) {
  const events = []
  try {
    if (typeof session?.snapshotEvents === 'function') {
      const got = session.snapshotEvents()
      if (Array.isArray(got)) events.push(...got)
    }
  } catch { /* 读不到历史就只用已记下的角色 */ }
  if (Array.isArray(session?.events)) events.push(...session.events)
  let found = ''
  for (const event of events) {
    if (!event || event.type !== 'user/message') continue
    const data = event.data
    const role = parseCrackRole(textOfMessage(data?.message || data))
    if (role) found = role
  }
  return found
}

function readRoleFile(role) {
  if (!parseCrackRole('crackRole: ' + role)) return ''
  try {
    const path = join(crackRoot(), 'agents', role + '.md')
    if (!existsSync(path)) return ''
    return readFileSync(path, 'utf8').trim()
  } catch {
    return ''
  }
}

function resolveRoleText(context) {
  try {
    const agent = context?.agent
    const session = agent?.session || context?.session
    if (!session || !isCrackSubagent(context)) return ''
    const sessionId = session?.id ?? agent?.id
    let role = sessionId !== undefined && sessionId !== null
      ? roleBySession.get(String(sessionId)) || ''
      : ''
    if (!role) {
      role = roleFromSessionEvents(session)
      if (role) remember(agent || { session }, role)
    }
    if (!role) return ''
    return readRoleFile(role)
  } catch {
    return ''
  }
}

function installRoleCapture(ctx) {
  if (!ctx || typeof ctx.on !== 'function') return
  if (ctx.__dshCrackRoleCapture) return
  ctx.__dshCrackRoleCapture = true
  const hook = (payload) => noteClaimedMessage(payload)
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
        delete ctx.__dshCrackRoleCapture
      }
    })
    return
  }
  let installed = false
  const install = () => {
    if (installed) return
    try { ctx.on('agent/inbox/claimed', hook, { global: true, prepend: true }); installed = true } catch { /* ignore */ }
  }
  install()
  queueMicrotask(install)
  setTimeout(install, 800)
}

function addRoleSection(assembled, roleText) {
  const body = String(roleText || '').trim()
  if (!body) return assembled
  if (!assembled || !Array.isArray(assembled.sections)) return assembled
  const existing = assembled.sections.find((s) => s?.name === ROLE_SECTION)
  const next = assembled.sections.filter((s) => s?.name !== ROLE_SECTION)
  const section = { name: ROLE_SECTION, text: body, interpolate: false, order: -99997 }
  const capAt = next.findIndex((s) => s?.name === 'dsh-forge')
  const at = capAt >= 0 ? capAt + 1 : 0
  next.splice(at, 0, existing ? { ...existing, ...section } : section)
  return { ...assembled, sections: next }
}

function installAssembleHook(ctx) {
  if (ctx.__dshCrackAssembleHook) return
  ctx.__dshCrackAssembleHook = true
  try {
    ctx.on('system-prompt/assemble', async (...args) => {
      try {
        const [assembly, context] = args
        const next = args.length >= 3 ? args[args.length - 1] : null
        let assembled = assembly
        if (typeof next === 'function') {
          try {
            assembled = await next()
          } catch { /* 下游失败用上游装配兜底 */ }
        }
        const roleText = resolveRoleText(context)
        if (!roleText) return assembled
        return addRoleSection(assembled, roleText)
      } catch {
        return assembly
      }
    }, { global: true, prepend: true })
  } catch { /* 老版本签名异常，忽略 */ }
}

export function apply(ctx) {
  installRoleCapture(ctx)
  installAssembleHook(ctx)
  ctx.logger?.info?.('dsh-forge-crack-role-gate: 角色门已挂载（crackRole: triage|static|dynamic|patch|verify）')
}

export default { name, apply }
