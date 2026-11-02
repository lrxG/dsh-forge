/**
 * 红队「根会话 → 靶标」绑定表。
 *
 * 之前这张表藏在 tools.js 里，角色稿注入只能读全局 `current` 指针，于是：
 *   · 两个窗口各绑一个靶标时，角色稿会拿到另一个靶标的 agents/<role>.md；
 *   · 面板切换「当前靶标」也会影响正在跑的会话。
 *
 * 这里把绑定键抽成独立模块：工具调用和角色稿注入用同一套解析，
 * 主会话与它的子会话共享根键，不同主会话天然隔离。
 *
 * 约束：
 *   · 绑定是进程内状态，宿主重启后由智能体重新绑定；
 *   · 找不到绑定时调用方回退到全局 current 指针（兼容旧会话/冷启动）。
 */

/** 根会话 id → engagementId 绑定（一次会话内稳定）。 */
const bindings = new Map()
const bindingAt = new Map()
const BINDING_TTL_MS = 12 * 60 * 60 * 1000

const BINDINGS_CAP = 500
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
capMap(bindings, BINDINGS_CAP)
capMap(bindingAt, BINDINGS_CAP)

/** 一次调用的会话解析结果。 */
export function sessionInfoOf(exec) {
  const agent = exec && exec.agent
  const session = agent && agent.session
  if (session === undefined || session === null) return {}
  const id = session.id === undefined ? undefined : String(session.id)
  let parentId
  try {
    const header = session.header
    parentId = header && header.parentSession !== undefined && header.parentSession !== null
      ? String(header.parentSession)
      : undefined
  } catch { parentId = undefined }
  return { id, parentId, session }
}

/**
 * 解析"根会话"：一路沿 parentSession 走到最顶层的会话 id。
 * 主会话派出的子智能体因此共享同一个绑定键，而不同主会话之间天然隔离。
 */
export function resolveRootSession(session) {
  const chain = []
  let cur = session
  let guard = 0
  while (cur !== undefined && cur !== null && guard < 64) {
    const info = sessionInfoOf({ agent: { session: cur } })
    if (info.id === undefined) break
    chain.push(info.id)
    if (info.parentId === undefined || info.parentId === '') break
    let parent
    try {
      const store = cur.store
      parent = store && typeof store.get === 'function' ? store.get(info.parentId) : undefined
    } catch { parent = undefined }
    if (parent === undefined || parent === null) {
      /* 父会话不在内存里（被回收 / 冷启动）：父 id 本身就是稳定的根键 */
      return { rootId: info.parentId, chain: chain.concat([info.parentId]) }
    }
    cur = parent
    guard += 1
  }
  return { rootId: chain.length > 0 ? chain[chain.length - 1] : undefined, chain }
}

/** 绑定键 + 会话链。 */
export function bindingKeyOf(exec) {
  const info = sessionInfoOf(exec)
  if (info.id === undefined) return { rootId: undefined, sessionId: undefined, chain: [] }
  const resolved = resolveRootSession(info.session)
  const rootId = resolved.rootId === undefined ? info.id : resolved.rootId
  return { rootId, sessionId: info.id, chain: resolved.chain }
}

/** 根键、当前会话键与整条父链，便于子会话继承。 */
export function bindKeysOf(exec) {
  const { rootId, sessionId, chain } = bindingKeyOf(exec)
  return Array.from(new Set([rootId, sessionId, ...chain].filter(Boolean)))
}

/** 子会话只写自己的键，避免把人工/父会话的绑定顶掉。 */
function isSubagentExec(exec) {
  const info = sessionInfoOf(exec)
  if (info.parentId !== undefined) return true
  try {
    const header = info.session && info.session.header
    return header && (header.origin === 'subagent' || Number(header.delegationDepth) > 0)
  } catch { return false }
}

/**
 * 把靶标绑定到当前会话。
 * 主会话写 root/session/chain，子智能体自然继承；子会话只写自己，
 * 这样主会话切目标时不会把正在跑的子会话一起带走。
 */
export function bindEngagement(exec, engagementId, options = {}) {
  if (typeof engagementId !== 'string' || engagementId.length === 0) return []
  const { rootId, sessionId, chain } = bindingKeyOf(exec)
  const keys = (isSubagentExec(exec) || options.sessionOnly === true)
    ? Array.from(new Set([sessionId].filter(Boolean)))
    : Array.from(new Set([rootId, sessionId, ...chain].filter(Boolean)))
  for (const key of keys) {
    bindings.set(key, engagementId)
    bindingAt.set(key, Date.now())
  }
  return keys
}

/** 会话结束/关闭后清掉绑定，避免“已关闭的会话还占着当前靶标”。 */
export function dropBinding(key) {
  const id = String(key || '')
  if (!id) return false
  bindingAt.delete(id)
  return bindings.delete(id)
}

/**
 * 清掉不再存活的会话绑定。
 * 优先问宿主 agents 注册表；拿不到注册表时用 12h TTL 兜底。
 */
export function pruneBindings(exec) {
  const now = Date.now()
  const keep = new Set(bindKeysOf(exec))
  let registry = null
  try {
    const ctx = exec?.agent?.ctx || exec?.ctx
    registry = ctx?.agents || (typeof ctx?.get === 'function' ? ctx.get('agents') : null)
  } catch { registry = null }
  for (const key of Array.from(bindings.keys())) {
    if (keep.has(key)) continue
    if (registry && typeof registry.get === 'function') {
      let agent = null
      try { agent = registry.get(key) } catch { agent = null }
      if (!agent || !agent.session) {
        bindings.delete(key)
        bindingAt.delete(key)
      }
      continue
    }
    const at = Number(bindingAt.get(key)) || 0
    if (!at || now - at > BINDING_TTL_MS) {
      bindings.delete(key)
      bindingAt.delete(key)
    }
  }
}

/** 先按当前键找，再沿父链找；找不到返回空串。 */
export function boundEngagementOf(exec) {
  const { rootId, sessionId, chain } = bindingKeyOf(exec)
  /* 子会话只认自己的绑定：root 是主会话的，不能拿来兜底，否则主会话切目标
     会把没来得及 session_bind 的子会话带跑。未绑定就让上层报错。 */
  const keys = isSubagentExec(exec)
    ? Array.from(new Set([sessionId].filter(Boolean)))
    : Array.from(new Set([sessionId, ...chain, rootId].filter(Boolean)))
  for (const key of keys) {
    const bound = bindings.get(key)
    if (typeof bound === 'string' && bound.length > 0) return bound
  }
  return ''
}

/**
 * 角色稿注入用：从 context（agent.session / session）解析绑定。
 *
 * 角色组装时拿到的 session 不一定带 store，先按 store 走一遍；
 * 走不到根时再用 context 里的 agents 注册表沿 parentSession 查绑定键。
 */
export function boundEngagementForContext(context) {
  const session = context?.agent?.session || context?.session
  if (!session) return ''
  const direct = boundEngagementOf({ agent: { session } })
  if (direct) return direct
  /* 子会话只认自己的绑定，不能沿父链拿主会话的靶标。 */
  if (isSubagentExec({ agent: { session } })) return ''

  const ctx = context?.agent?.ctx || context?.ctx
  let registry = null
  try { registry = ctx?.agents || (typeof ctx?.get === 'function' ? ctx.get('agents') : null) } catch { registry = null }
  let cur = session
  const seen = new Set()
  for (let guard = 0; cur && guard < 64; guard += 1) {
    const id = cur.id === undefined || cur.id === null ? '' : String(cur.id)
    if (id && seen.has(id)) break
    if (id) seen.add(id)
    if (id && bindings.has(id)) return bindings.get(id)
    const parentId = cur.header?.parentSession
    if (parentId === undefined || parentId === null || parentId === '') break
    if (bindings.has(String(parentId))) return bindings.get(String(parentId))
    let parent = null
    try { parent = registry && typeof registry.get === 'function' ? registry.get(parentId) : null } catch { parent = null }
    if (!parent?.session) break
    cur = parent.session
  }
  return ''
}

/** 当前会话的绑定关系（session_info 与面板展示用）。 */
export function bindingViewOf(exec) {
  const info = sessionInfoOf(exec)
  const { rootId, sessionId, chain } = bindingKeyOf(exec)
  const subagent = isSubagentExec(exec)
  /* 子会话只显示自己的绑定；主会话才回退 root。 */
  let bound = null
  const ownKeys = subagent
    ? Array.from(new Set([sessionId].filter(Boolean)))
    : Array.from(new Set([sessionId, ...chain].filter(Boolean)))
  for (const key of ownKeys) {
    if (bindings.has(key)) { bound = bindings.get(key); break }
  }
  if (bound === null && !subagent && rootId !== undefined) bound = bindings.get(rootId) ?? null
  return {
    session_id: info.id ?? null,
    parent_session: info.parentId ?? null,
    root_session: rootId ?? null,
    session_chain: chain,
    is_subagent: subagent,
    bound_engagement: bound,
  }
}

/** 全部绑定（仅诊断用）。 */
export function bindingsNow() {
  return Array.from(bindings, ([session, engagement]) => ({ session, engagement }))
}
