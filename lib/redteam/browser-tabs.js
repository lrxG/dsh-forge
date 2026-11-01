/**
 * 标签页与 Cookie 的纯逻辑：挑页、列页、算该淘汰哪页、拼 Cookie 头。
 * 单独成模块是因为这些判断不需要真浏览器，能直接单测；
 * 需要 CDP 的部分留在 browser.js。
 */

/** 选择器：序号（从 1 开始）、targetId 或其前缀、url/title 子串。没给就返回 null，由调用方定默认。 */
export function pickTarget(targets, selector) {
  const list = Array.isArray(targets) ? targets : []
  if (selector === undefined || selector === null || selector === '') return null
  const raw = String(selector).trim()
  if (!raw) return null
  if (/^\d+$/.test(raw)) {
    const index = Number(raw)
    return index >= 1 && index <= list.length ? list[index - 1] : null
  }
  const lower = raw.toLowerCase()
  const byId = list.find((t) => String(t.id || '') === raw)
  if (byId) return byId
  if (raw.length >= 6) {
    const byPrefix = list.find((t) => String(t.id || '').toLowerCase().startsWith(lower))
    if (byPrefix) return byPrefix
  }
  const byUrl = list.find((t) => String(t.url || '').toLowerCase().includes(lower))
  if (byUrl) return byUrl
  const byTitle = list.find((t) => String(t.title || '').toLowerCase().includes(lower))
  return byTitle || null
}

export function tabRows(targets, currentId) {
  return (Array.isArray(targets) ? targets : []).map((t, i) => ({
    index: i + 1,
    id: String(t.id || ''),
    url: String(t.url || ''),
    title: String(t.title || ''),
    current: String(t.id || '') === String(currentId || ''),
  }))
}

/** 超出上限时该关哪些页：最久没用过、且不是当前页的，关到只剩 keep 个。 */
export function oldestInactive(targets, currentId, lastUsed, keep) {
  const list = Array.isArray(targets) ? targets : []
  const excess = list.length - Math.max(1, Number(keep) || 1)
  if (excess <= 0) return []
  const idle = list
    .filter((t) => String(t.id || '') !== String(currentId || ''))
    .map((t) => ({ id: String(t.id || ''), used: Number((lastUsed && lastUsed.get && lastUsed.get(String(t.id || ''))) || 0) }))
    .sort((a, b) => a.used - b.used)
  return idle.slice(0, excess).map((row) => row.id).filter(Boolean)
}

/** Cookie 的 domain 可能是 ".example.com"，host 里没有点，两边都归一化后再比。 */
export function cookieDomainMatch(domain, host) {
  const d = String(domain || '').replace(/^\./, '').toLowerCase()
  const h = String(host || '').replace(/^\./, '').toLowerCase()
  if (!d || !h) return false
  return h === d || h.endsWith('.' + d)
}

/**
 * 拼成 curl 能直接用的 Cookie 头。
 * host 为空就全带上（拿整套登录态），否则按 domain 过滤；路径更长的排前面。
 */
export function cookieHeader(cookies, host) {
  const list = (Array.isArray(cookies) ? cookies : [])
    .filter((c) => c && c.name)
    .filter((c) => !host || cookieDomainMatch(c.domain, host))
    .sort((a, b) => String(b.path || '').length - String(a.path || '').length)
  return list.map((c) => `${c.name}=${c.value === undefined || c.value === null ? '' : c.value}`).join('; ')
}
