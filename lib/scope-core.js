/**
 * 靶标范围（scope）解析与归一化 —— 客户端表单、服务端写库、智能体工具共用的唯一实现。
 *
 * 只做机械工作：把用户/模型写的地址拆开、纠正常见手误、统一写法。
 * 不判断该不该打、不评价范围大小 —— 那是模型在任务里自己的事，插件别替它想。
 *
 * 支持写法（逗号 / 分号 / 顿号 / 空格 / 换行分隔，大小写不敏感）：
 *   10.20.30.4                      单个 IPv4
 *   10.20.30.0/24                   IPv4 网段（写 10.20.30.5/24 会归一到 .0/24 并提示）
 *   10.20.30.1-10.20.30.50          IPv4 段（也接受 10.20.30.1-50 简写）
 *   2001:db8::1 / 2001:db8::/64     IPv6 与 IPv6 网段
 *   oa.example.com                  域名 / 子域名（至少两级）
 *   *.example.com                   通配子域（* 后面至少两级）
 *   https://oa.example.com:8443/login?x=1
 *                                   URL —— 只取 host[:port]，路径/参数忽略并提示
 *
 * 归一化：域名转小写、去掉结尾点；网段按掩码取网络地址；重复项去重。
 * 拒绝：认不出的写法、单段主机名、非法字符、超长、超过 200 项，以及
 *   不可用作靶标的特殊地址（0.0.0.0/8、组播 224/4、保留 240/4、::）。
 *   127.0.0.1、内网段、链路本地等照常可用 —— 本机测试是正常工况。
 *
 * 注意：本文件同时被服务端 import 和客户端 bundle 内联（scripts/build-client.mjs），
 * 所以只能写纯函数，不能碰 node 内置模块，也不能用 export default。
 */

const DF_SCOPE_MAX_ITEMS = 200
const DF_SCOPE_MAX_TOKEN = 255
const DF_SCOPE_SPLIT = /[,，;；、\s]+/

/** 去掉用户复制时带上的引号/尖括号（IPv6 的方括号单独处理）。 */
function dfScopeTrimToken(raw) {
  let s = String(raw == null ? '' : raw).trim()
  s = s.replace(/^[<"'`]+/, '').replace(/[>"'`]+$/, '').trim()
  if (s.length > 1 && s[0] === '[' && s[s.length - 1] === ']') s = s.slice(1, -1)
  return s
}

/** 点分 IPv4 → 32 位无符号整数；不合法返回 null（拒绝前导零，避免八进制歧义）。 */
function dfScopeIpv4Int(text) {
  const parts = String(text).split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    n = n * 256 + value
  }
  return n >>> 0
}

function dfScopeIpv4Text(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
}

/**
 * 不可作为靶标的 IPv4 段：0/8（this network）、224/4（组播）、240/4（保留 + 广播）。
 * 返回原因，正常地址返回空串。回环 127/8、链路本地 169.254/16、CGNAT 100.64/10 都放行。
 */
function dfScopeIpv4Blocked(n) {
  const first = n >>> 24
  if (first === 0) return '0.0.0.0/8 是保留地址，写具体 IP'
  if (first >= 224 && first <= 239) return '组播地址（224.0.0.0/4）不能当靶标'
  if (first >= 240) return '保留地址（240.0.0.0/4）不能当靶标'
  return ''
}

function dfScopePort(text) {
  if (!/^\d{1,5}$/.test(String(text))) return false
  const n = Number(text)
  return n >= 1 && n <= 65535
}

/** 域名 / 子域名；要求至少两级、标签 1-63、字母数字与连字符，TLD 不能是纯数字。 */
function dfScopeDomain(text) {
  const s = String(text || '').toLowerCase().replace(/\.+$/, '')
  if (s === '' || s.length > 253) return null
  const labels = s.split('.')
  if (labels.length < 2) return null
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return null
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) return null
  }
  const tld = labels[labels.length - 1]
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(tld)) return null
  return s
}

/** IPv6 字面量（含 :: 缩写）；返回小写原文，不合法返回 null。 */
function dfScopeIpv6(text) {
  const s = String(text || '').trim().replace(/^\[|\]$/g, '')
  if (!s.includes(':')) return null
  if (!/^[0-9a-fA-F:]+$/.test(s)) return null
  const halves = s.split('::')
  if (halves.length > 2) return null
  const left = halves[0] === '' ? [] : halves[0].split(':')
  const right = halves.length > 1 ? (halves[1] === '' ? [] : halves[1].split(':')) : []
  if (halves.length === 1 && left.length !== 8) return null
  if (halves.length === 2 && left.length + right.length > 7) return null
  for (const group of left.concat(right)) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null
  }
  return s.toLowerCase()
}

/** 不可作为靶标的 IPv6：未指定地址（全零）、组播 ff00::/8。返回原因或空串。 */
function dfScopeIpv6Blocked(text) {
  const s = text.toLowerCase()
  if (s.replace(/[:0]/g, '') === '') return ':: 是未指定地址，写具体 IPv6'
  if (/^ff/i.test(s)) return '组播地址（ff00::/8）不能当靶标'
  return ''
}

/** 主机（IP 或域名）→ `{ text, kind, v6 }`；认不出返回 null。 */
function dfScopeHost(host) {
  const v4 = dfScopeIpv4Int(host)
  if (v4 !== null) {
    const blocked = dfScopeIpv4Blocked(v4)
    if (blocked) return { error: blocked }
    return { text: dfScopeIpv4Text(v4), kind: 'ipv4', v6: false }
  }
  const v6 = dfScopeIpv6(host)
  if (v6 !== null) {
    const blocked = dfScopeIpv6Blocked(v6)
    if (blocked) return { error: blocked }
    return { text: v6, kind: 'ipv6', v6: true }
  }
  const domain = dfScopeDomain(host)
  if (domain !== null) return { text: domain, kind: 'domain', v6: false }
  return null
}

function dfScopeEntry(host, port) {
  const tail = port ? ':' + port : ''
  return host.v6 && port ? '[' + host.text + ']:' + port : host.text + tail
}

/**
 * 解析单个范围项。
 * @returns null（空项）| `{ error }` | `{ entry, kind, notes }`
 */
function dfScopeOne(raw) {
  const token = dfScopeTrimToken(raw)
  if (token === '') return null
  if (token.length > DF_SCOPE_MAX_TOKEN) return { error: '这一项太长（超过 255 字符）' }
  const notes = []

  /* 1. 带协议的 URL：只保留 host[:port] */
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) {
    let url = null
    try {
      url = new URL(token)
    } catch {
      return { error: 'URL 解析不了，检查协议后面是不是少写了主机名' }
    }
    const port = String(url.port || '')
    if (port !== '' && !dfScopePort(port)) return { error: '端口要在 1-65535 之间' }
    if ((url.pathname && url.pathname !== '/') || url.search || url.hash) notes.push('已忽略路径/参数')
    const host = dfScopeHost(String(url.hostname || '').replace(/^\[|\]$/g, ''))
    if (host === null) return { error: 'URL 里的主机名不是合法的 IP 或域名' }
    if (host.error) return { error: host.error }
    return { entry: dfScopeEntry(host, port), kind: host.kind, notes }
  }

  /* 2. IPv4 网段 */
  let m = /^([0-9.]+)\/(\d{1,2})$/.exec(token)
  if (m !== null) {
    const base = dfScopeIpv4Int(m[1])
    if (base === null) return { error: '网段前面的地址不是合法 IPv4' }
    const prefix = Number(m[2])
    if (prefix > 32) return { error: 'IPv4 掩码要在 /0-/32 之间' }
    if (prefix === 0) return { error: '/0 等于全部 IPv4 地址，写具体网段' }
    const mask = (0xffffffff << (32 - prefix)) >>> 0
    const net = (base & mask) >>> 0
    const blocked = dfScopeIpv4Blocked(net)
    if (blocked) return { error: blocked }
    const entry = dfScopeIpv4Text(net) + '/' + prefix
    if (net !== base) notes.push('已按掩码归一到 ' + entry)
    return { entry, kind: 'ipv4', notes }
  }

  /* 3. IPv6 网段 */
  m = /^(.+)\/(\d{1,3})$/.exec(token)
  if (m !== null && String(m[1]).includes(':')) {
    const base = dfScopeIpv6(m[1])
    if (base === null) return { error: '网段前面的地址不是合法 IPv6' }
    const prefix = Number(m[2])
    if (prefix > 128) return { error: 'IPv6 掩码要在 /0-/128 之间' }
    if (prefix === 0) return { error: '/0 等于全部 IPv6 地址，写具体网段' }
    const blocked = dfScopeIpv6Blocked(base)
    if (blocked) return { error: blocked }
    return { entry: base + '/' + prefix, kind: 'ipv6', notes }
  }

  /* 4. IPv4 段：a.b.c.d-a.b.c.e，或 a.b.c.d-e 简写 */
  m = /^([0-9.]+)\s*-\s*([0-9.]+)$/.exec(token)
  if (m !== null) {
    const start = dfScopeIpv4Int(m[1])
    if (start === null) return { error: 'IP 段的起点不是合法 IPv4' }
    const startBlocked = dfScopeIpv4Blocked(start)
    if (startBlocked) return { error: startBlocked }
    let endText = m[2]
    if (/^\d{1,3}$/.test(endText)) {
      endText = m[1].split('.').slice(0, 3).join('.') + '.' + endText
      notes.push('已补全为 ' + endText)
    }
    const end = dfScopeIpv4Int(endText)
    if (end === null) return { error: 'IP 段的终点不是合法 IPv4' }
    const endBlocked = dfScopeIpv4Blocked(end)
    if (endBlocked) return { error: endBlocked }
    if (end < start) return { error: 'IP 段的起点比终点大' }
    return {
      entry: dfScopeIpv4Text(start) + '-' + dfScopeIpv4Text(end),
      kind: 'ipv4-range', notes,
    }
  }

  /* 5. 单个 IPv4 / IPv6 */
  m = /^([0-9.]+)$/.exec(token)
  if (m !== null) {
    const value = dfScopeIpv4Int(m[1])
    if (value === null) return { error: 'IPv4 要写成四段、每段 0-255，且不能有前导零' }
    const blocked = dfScopeIpv4Blocked(value)
    if (blocked) return { error: blocked }
    return { entry: dfScopeIpv4Text(value), kind: 'ipv4', notes }
  }
  const v6 = dfScopeIpv6(token)
  if (v6 !== null) {
    const blocked = dfScopeIpv6Blocked(v6)
    if (blocked) return { error: blocked }
    return { entry: v6, kind: 'ipv6', notes }
  }

  /* 5b. 方括号写法的 IPv6（从 URL / 配置文件里抄出来时常见）：[::1] 或 [::1]:8443 */
  m = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(token)
  if (m !== null) {
    const inner = dfScopeIpv6(m[1])
    if (inner === null) return { error: '方括号里不是合法 IPv6' }
    const innerBlocked = dfScopeIpv6Blocked(inner)
    if (innerBlocked) return { error: innerBlocked }
    const innerPort = m[2] || ''
    if (innerPort !== '' && !dfScopePort(innerPort)) return { error: '端口要在 1-65535 之间' }
    return { entry: innerPort ? '[' + inner + ']:' + innerPort : inner, kind: 'ipv6', notes }
  }

  /* 6. host[:port][/path] —— 没写协议但带了路径或端口 */
  const slash = token.indexOf('/')
  const hostPart = slash >= 0 ? token.slice(0, slash) : token
  if (hostPart === '') return { error: '认不出是什么：支持 IP、网段、IP 段、域名、*.通配、URL' }
  if (slash >= 0) notes.push('已忽略路径/参数')
  let hostText = hostPart
  let port = ''
  const colon = hostPart.lastIndexOf(':')
  if (colon > 0 && /^\d{1,5}$/.test(hostPart.slice(colon + 1))) {
    port = hostPart.slice(colon + 1)
    hostText = hostPart.slice(0, colon)
    if (!dfScopePort(port)) return { error: '端口要在 1-65535 之间' }
  }

  /* 7. 通配子域 */
  if (hostText.startsWith('*.')) {
    const rest = dfScopeDomain(hostText.slice(2))
    if (rest === null) return { error: '通配符要写成 *.example.com（* 后面至少两级域名）' }
    return { entry: '*.' + rest + (port ? ':' + port : ''), kind: 'wildcard', notes }
  }

  /* 8. 普通域名 */
  const domain = dfScopeDomain(hostText)
  if (domain !== null) {
    return { entry: domain + (port ? ':' + port : ''), kind: 'domain', notes }
  }
  if (hostText === '*') return { error: '通配符要写全，如 *.example.com' }
  if (hostText.includes(':')) return { error: '冒号后面要么是 IPv6 地址，要么是 1-65535 的端口' }
  if (!hostText.includes('.')) return { error: '单段主机名不行，请写 IP 或至少两级域名（如 dc01.corp.local）' }
  return { error: '认不出是什么：支持 IP、网段、IP 段、域名、*.通配、URL' }
}

/** 解析一组范围项（数组或整段文本）。 */
function dfScopeParseList(tokens) {
  const list = (Array.isArray(tokens) ? tokens : [])
    .map((item) => String(item == null ? '' : item).trim())
    .filter(Boolean)
  const items = []
  const errors = []
  const seen = new Set()
  if (list.length > DF_SCOPE_MAX_ITEMS) {
    errors.push({ raw: '', message: '最多 200 项' })
  }
  for (const raw of list.slice(0, DF_SCOPE_MAX_ITEMS)) {
    const one = dfScopeOne(raw)
    if (one === null) continue
    if (one.error) {
      errors.push({ raw, message: one.error })
      continue
    }
    if (seen.has(one.entry)) continue
    seen.add(one.entry)
    items.push({ raw, entry: one.entry, kind: one.kind, notes: one.notes || [] })
  }
  return { entries: items.map((item) => item.entry), items, errors }
}

/** 整段文本 → 解析结果（表单用）。 */
function dfScopeParseText(text) {
  return dfScopeParseList(String(text == null ? '' : text).split(DF_SCOPE_SPLIT))
}

/** 数组或文本 → 解析结果（服务端写库用；兼容旧的自由文本）。 */
function dfScopeNormalize(scope) {
  if (Array.isArray(scope)) return dfScopeParseList(scope)
  return dfScopeParseText(scope)
}

export { dfScopeParseText, dfScopeNormalize, dfScopeDomain, dfScopeIpv4Int }
