window.__ModuleLoader__.load({ id: "dsh-forge", factory: (require) => {
var module = { exports: {} };
var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let react = require("react");
const h = react.createElement;
const { useState, useEffect, useLayoutEffect, useRef, useCallback, Component } = react;

/* ---- lib/scope-core.js（与服务端共用） ---- */
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


/* ---- lib/http-evidence-core.js（与服务端共用） ---- */
/**
 * 证据文本 → 原始 HTTP 报文（Burp / Yakit 可直接粘贴）。
 *
 * 红队交付里「证据」经常是一段人写的复现记录，长这样：
 *
 *   POST https://api.example.com/v2/carts
 *   Header: X-Anonymous-Consents: [] / x-asw-cache-version: v_default
 *   body {"product":{"code":"20378"},"quantity":1}
 *   → 201 {"guid":"da95...","code":"11027443046"}
 *
 * 这种文本在面板里只能当「原文」看，粘贴进 Burp 还得手工补请求行、Host、
 * 空行和响应头。本文件把它整理成标准报文：
 *
 *   POST /v2/carts HTTP/1.1
 *   Host: api.example.com
 *   X-Anonymous-Consents: []
 *   x-asw-cache-version: v_default
 *
 *   {"product":{"code":"20378"},"quantity":1}
 *
 * 也直接吃已经写好的原始报文（`GET /x HTTP/1.1` + 头 + 空行 + 体），
 * 以及 `.../carts/{id}` 这种省略了公共前缀的写法 —— 用上一条请求的目录补全。
 *
 * 注意：本文件同时被服务端 import 和客户端 bundle 内联（scripts/build-client.mjs），
 * 所以只能写纯函数，不能碰 node 内置模块，也不能用 export default。
 */

const HTTP_METHODS = new Set([
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT',
  'PROPFIND', 'PROPPATCH', 'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK',
])

const HTTP_STATUS_TEXT = {
  100: 'Continue', 101: 'Switching Protocols',
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 206: 'Partial Content',
  301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 406: 'Not Acceptable', 408: 'Request Timeout', 409: 'Conflict',
  410: 'Gone', 413: 'Payload Too Large', 415: 'Unsupported Media Type', 418: "I'm a teapot",
  422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway',
  503: 'Service Unavailable', 504: 'Gateway Timeout',
}

/** 状态码 → reason phrase；未知码返回空串（只写数字也合法）。 */
function httpStatusText(code) {
  const n = Number(code)
  return HTTP_STATUS_TEXT[n] || ''
}

/** 是 http(s) 绝对地址吗。 */
function httpIsAbsolute(url) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(url || '').trim())
}

/** 从 URL / host:port / 纯主机里取主机名（不含端口）。 */
function httpHostName(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  try {
    const u = new URL(httpIsAbsolute(text) ? text : 'http://' + text)
    return u.hostname.replace(/^\[|\]$/g, '')
  } catch {
    return ''
  }
}

/** `/a/b?x=1` 或绝对地址 → 路径+查询串。 */
function httpPathOf(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (httpIsAbsolute(text)) {
    try {
      const u = new URL(text)
      return (u.pathname || '/') + (u.search || '')
    } catch { return '' }
  }
  if (text.startsWith('/')) return text
  if (text.startsWith('?') || text.startsWith('...')) return text
  return '/' + text
}

/**
 * 把请求目标解析成 host / path / origin。
 *
 * @param target - 绝对 URL、`/path`、`.../path`（省略公共前缀）。
 * @param context - 上一条请求留下的 `{ origin, host, path }`。
 * @param base - 兜底地址（通常传漏洞的 target）。
 */
function httpResolveTarget(target, context, base) {
  let text = String(target || '').trim()
  if (!text) return null
  if (httpIsAbsolute(text)) {
    try {
      const u = new URL(text)
      const path = (u.pathname || '/') + (u.search || '')
      return {
        url: text, host: u.host, path, origin: u.origin,
        /* 省略前缀的基准：最近一次完整地址所在目录。 */
        dir: path.replace(/[^/]*$/, '') || '/',
      }
    } catch { return null }
  }
  /* 没有上下文时，用 base 的 origin 兜底（例如报告里只写 `GET /admin`）。 */
  if (!context.origin && httpIsAbsolute(base)) {
    try {
      const u = new URL(base)
      context.origin = u.origin
      context.host = u.host
    } catch { /* base 不是合法 URL 就继续无 Host */ }
  }
  if (text.startsWith('...')) {
    /* `.../carts/x` = 公共前缀（最近一次完整地址的目录）+ `carts/x`。
       注意基准不能随每条相对请求往后滚，否则 `.../carts/x` 会拼成 `.../carts/.../carts/x`。 */
    const rest = text.replace(/^\.\.\.\/?/, '')
    const dir = String(context.dir || context.path.replace(/[^/]*$/, '') || '/')
    text = dir.replace(/\/+$/, '/') + rest
  }
  if (text.startsWith('?')) text = String(context.path || '/').replace(/\?.*$/, '') + text
  if (!text.startsWith('/')) text = '/' + text
  const origin = context.origin || ''
  return {
    url: origin ? origin + text : '',
    host: context.host || '',
    path: text,
    origin,
    dir: '',
  }
}

/**
 * 从一行里拆出 JSON 体和尾巴：`{"a":1}  ← 说明` → `{ body: '{"a":1}', tail: '← 说明' }`。
 * 复现记录常在 JSON 后面跟一句人话，直接塞进 body 会让报文没法粘进 Burp。
 */
function httpSplitBodyTail(text) {
  const s = String(text || '').trim()
  if (!s) return { body: '', tail: '' }
  if (s[0] === '{' || s[0] === '[') {
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === '{' || ch === '[') depth += 1
      else if (ch === '}' || ch === ']') {
        depth -= 1
        if (depth === 0) return { body: s.slice(0, i + 1), tail: s.slice(i + 1).trim() }
      }
    }
    return { body: s, tail: '' }
  }
  const at = s.search(/[{[]/)
  if (at > 0) {
    const inner = httpSplitBodyTail(s.slice(at))
    return {
      body: inner.body,
      tail: (s.slice(0, at).trim() + (inner.tail ? ' ' + inner.tail : '')).trim(),
    }
  }
  return { body: '', tail: s }
}

/** `Header: a: b / c: d` → ['a: b', 'c: d']；不认识的片段并回上一条。 */
function httpSplitHeaders(text) {
  const out = []
  const parts = String(text || '').split(/\s+\/\s+|\s*[;；]\s*/)
  for (const part of parts) {
    const line = part.trim()
    if (!line) continue
    if (/^[A-Za-z0-9_!#$%&'*+.^`|~-]+:\s?\S/.test(line)) out.push(line)
    else if (out.length) out[out.length - 1] += ' / ' + line
  }
  return out
}

/** 一行是不是 `Name: value` 形式的头。 */
function httpIsHeaderLine(line) {
  return /^[A-Za-z0-9_!#$%&'*+.^`|~-]+:\s?\S/.test(String(line || '').trim())
}

/**
 * 解析证据文本里的 HTTP 报文。
 *
 * @param text - 证据原文。
 * @param options - `{ base?: string }`：补全相对路径 / Host 的兜底地址。
 * @returns {Array<{method:string,url:string,host:string,path:string,status:number|null,
 *   request:string,response:string,label:string,raw:boolean}>}
 */
function parseHttpPackets(text, options = {}) {
  const source = String(text || '').replace(/\r\n?/g, '\n')
  if (!source.trim()) return []
  const base = String((options && options.base) || '').trim()
  const lines = source.split('\n')
  const packets = []
  const context = { origin: '', host: '', path: '' }
  let cur = null
  let mode = '' // req-head | req-body | res-head | res-body
  let heading = ''

  const start = (method, target, raw) => {
    const loc = httpResolveTarget(target, context, base)
    if (!loc) return false
    cur = {
      method: String(method || 'GET').toUpperCase(),
      url: loc.url || '',
      host: loc.host || '',
      path: loc.path || '/',
      status: null,
      statusLine: '',
      headers: [],
      body: [],
      respHeaders: [],
      respBody: [],
      label: heading,
      raw: raw === true,
    }
    heading = ''
    packets.push(cur)
    mode = 'req-head'
    if (loc.origin) {
      context.origin = loc.origin
      context.host = loc.host
      context.path = loc.path
      if (loc.dir) context.dir = loc.dir
    } else if (loc.path) {
      context.path = loc.path
      if (!context.dir) context.dir = loc.path.replace(/[^/]*$/, '') || '/'
    }
    return true
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/[ \t]+$/, '')
    const trimmed = line.trim()

    if (!trimmed) {
      if (mode === 'req-head') mode = 'req-body'
      else if (mode === 'res-head') mode = 'res-body'
      continue
    }

    /* 响应起始行：HTTP/1.1 200 OK */
    const statusLine = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\b(.*)$/i.exec(trimmed)
    if (statusLine) {
      if (!cur) continue
      cur.status = Number(statusLine[1])
      cur.statusLine = trimmed
      mode = 'res-head'
      continue
    }

    /* 复现记录里的箭头：→ 201 {...} / -> 200 / => 302 */
    const arrow = /^(?:→|->|=>|⇢|⇒|⭢)\s*(\d{3})\b\s*(.*)$/.exec(trimmed)
    if (arrow) {
      if (!cur) continue
      cur.status = Number(arrow[1])
      const split = httpSplitBodyTail(arrow[2])
      if (split.body) cur.respBody.push(split.body)
      mode = 'res-body'
      continue
    }

    /* 请求行：GET /x、POST https://h/x、DELETE .../x HTTP/1.1 */
    const requestLine = /^([A-Z][A-Z0-9-]{1,15})\s+(\S+)(?:\s+HTTP\/\d(?:\.\d)?)?$/.exec(trimmed)
    if (requestLine && HTTP_METHODS.has(requestLine[1].toUpperCase())) {
      if (start(requestLine[1], requestLine[2], /HTTP\/\d/i.test(trimmed))) continue
    }

    /* 还没进入报文：只记最近的标题，给下一条报文当 label。 */
    if (!cur) {
      if (!/^\s/.test(rawLine)) heading = trimmed
      continue
    }

    /* 人写的 `Header: a: b / c: d` 批量头。 */
    const headerBatch = /^(?:headers?|请求头|响应头)\s*[:：]\s*(.+)$/i.exec(trimmed)
    if (headerBatch) {
      const list = httpSplitHeaders(headerBatch[1])
      const target = mode === 'res-head' || mode === 'res-body' ? cur.respHeaders : cur.headers
      for (const h of list) target.push(h)
      continue
    }

    /* 人写的 `body {...}` / `请求体: {...}`。 */
    const bodyPrefix = /^(?:body|请求体|payload|post\s*data)\s*(?:[:：]\s*|\s+)([{[].*)$/i.exec(trimmed)
      || /^(?:body|请求体|payload|post\s*data)\s*[:：]\s*(.+)$/i.exec(trimmed)
    if (bodyPrefix) {
      const target = mode === 'res-head' || mode === 'res-body' ? cur.respBody : cur.body
      const split = httpSplitBodyTail(bodyPrefix[1])
      if (split.body) target.push(split.body)
      if (mode !== 'res-body') mode = 'req-body'
      continue
    }

    /* 原始报文里的头。 */
    if (httpIsHeaderLine(trimmed) && (mode === 'req-head' || mode === 'res-head')) {
      if (mode === 'res-head') cur.respHeaders.push(trimmed)
      else cur.headers.push(trimmed)
      continue
    }

    /* JSON 体（原始报文或人写的省略体）。 */
    if (/^[{[]/.test(trimmed)) {
      const split = httpSplitBodyTail(trimmed)
      const target = mode === 'res-head' || mode === 'res-body' ? cur.respBody : cur.body
      if (split.body) target.push(split.body)
      continue
    }

    /* 正文续行：原始报文里的多行 body 原样收；人写的记录里夹在正文后的
       `（注意：…）`/`← 成功` 这类人话不是报文，遇到就收尾。 */
    if (mode === 'req-body' || mode === 'res-body') {
      const bodyish = cur.raw || /^[{[]/.test(trimmed) || /^</.test(trimmed)
      if (!bodyish) {
        if (!/^\s/.test(rawLine)) {
          cur = null
          mode = ''
          heading = trimmed
        }
        continue
      }
      if (mode === 'res-body') cur.respBody.push(trimmed)
      else cur.body.push(trimmed)
      continue
    }

    /* 其余行：人写的小标题 / 说明，不算报文体。 */
    if (!/^\s/.test(rawLine)) heading = trimmed
  }

  return packets.map((p) => {
    /* 原始报文常写成 `GET /x HTTP/1.1` + `Host: …`，主机名只能从头里补。 */
    if (!p.host) {
      const hostHeader = (p.headers || []).find((h) => /^host\s*:/i.test(h))
      if (hostHeader) p.host = String(hostHeader).replace(/^host\s*:\s*/i, '').trim()
    }
    const request = httpBuildRequest(p)
    const response = httpBuildResponse(p)
    return {
      method: p.method,
      url: p.url,
      host: p.host,
      path: p.path,
      status: p.status,
      request,
      response,
      label: String(p.label || '').trim(),
      raw: p.raw,
    }
  }).filter((p) => p.request)
}

function httpBuildRequest(p) {
  const out = [p.method + ' ' + (p.path || '/') + ' HTTP/1.1']
  const headers = Array.isArray(p.headers) ? p.headers.slice() : []
  if (p.host && !headers.some((h) => /^host\s*:/i.test(h))) headers.unshift('Host: ' + p.host)
  out.push(...headers)
  out.push('')
  out.push(...(p.body || []))
  return out.join('\n').replace(/\n+$/, '')
}

function httpBuildResponse(p) {
  if (p.status === null || p.status === undefined) return ''
  const reason = httpStatusText(p.status)
  const first = p.statusLine || ('HTTP/1.1 ' + p.status + (reason ? ' ' + reason : ''))
  const out = [first]
  out.push(...(p.respHeaders || []))
  out.push('')
  out.push(...(p.respBody || []))
  return out.join('\n').replace(/\n+$/, '')
}

/** 一条报文拼成「请求 + 空行 + 响应」，复制给 Burp / Yakit 用。 */
function httpPacketText(packet) {
  const p = packet || {}
  const request = String(p.request || '')
  const response = String(p.response || '')
  if (!request) return response
  return response ? request + '\n\n' + response : request
}


/* ---- lib/client/00-entry.js ---- */
/* 新客户端入口：自己建 React root 挂到 document.body，不再经过宿主 slot。
   这样事件、定位、尺寸都由我们自己的根节点控制，不受 overlay 容器影响。 */

const CLIENT_NAME = 'dsh-forge'
const CLIENT_INJECT = ['slots', 'locale']
const CLIENT_NS = 'settings.dsh-forge'
let translate = (k) => k

/** 宿主服务拿得到就接上：环境门禁要 sessions，回退要 slots + conversation。 */
function dfWireHost(ctx) {
  dfInstallHost(ctx)
  try {
    if (typeof ctx.inject === 'function') {
      const wanted = ['sessions', 'uiWorkspace', 'conversation', 'slots']
      ctx.inject(wanted, function (host) {
        dfInstallHost(host)
        dfInstallRewind(host)
      })
    } else if (ctx.sessions) {
      dfInstallRewind(ctx)
    }
  } catch (e) {
    try { console.warn('[dsh-forge] host services unavailable:', e && e.message) } catch (e2) { /* ignore */ }
  }
}

function apply(ctx) {
  dfInjectStyles()
  try {
    if (ctx.locale && typeof ctx.locale.register === 'function') {
      ctx.locale.register(CLIENT_NS, { zh: {}, en: {} })
      translate = ctx.locale.bind(CLIENT_NS)
    }
  } catch (e) { /* locale 可选 */ }

  dfWireHost(ctx)

  let host = document.getElementById('dsh-forge-client-root')
  if (!host) {
    host = document.createElement('div')
    host.id = 'dsh-forge-client-root'
    host.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none;z-index:2147483000'
    document.body.appendChild(host)
  }
  if (host.__dfMounted) return
  const app = h(DfErrorBoundary, null, h(DfApp, { ctx: ctx }))
  try {
    const rd = require('react-dom')
    if (rd && typeof rd.createRoot === 'function') {
      host.__dfMounted = true
      rd.createRoot(host).render(app)
    } else if (rd && typeof rd.render === 'function') {
      host.__dfMounted = true
      rd.render(app, host)
    } else {
      throw new Error('react-dom unavailable')
    }
  } catch (e) {
    try { console.warn('[dsh-forge] react-dom mount failed, falling back to slot:', e && e.message) } catch { /* ignore */ }
    try {
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay', id: 'dsh-forge-dock', order: 50,
      }, () => app))
    } catch (e2) {
      try { console.warn('[dsh-forge] slot mount failed too:', e2 && e2.message) } catch { /* ignore */ }
    }
  }
}

exports.name = CLIENT_NAME
exports.inject = CLIENT_INJECT
exports.apply = apply


/* ---- lib/client/05-core.js ---- */
/* 基础工具：格式化、hook、轻量事件与 Toast。
   这一层不碰网络，也不碰业务；视图与外壳共用。 */

/* ---------------------------------------------------------------- 类名与格式 */

function dfCx() {
  const out = []
  for (let i = 0; i < arguments.length; i += 1) {
    const v = arguments[i]
    if (!v) continue
    if (typeof v === 'string') out.push(v)
    else if (Array.isArray(v)) out.push(dfCx.apply(null, v))
    else if (typeof v === 'object') {
      Object.keys(v).forEach((k) => { if (v[k]) out.push(k) })
    }
  }
  return out.join(' ')
}

function dfNum(n) {
  const v = Number(n)
  if (!isFinite(v)) return '—'
  return v.toLocaleString('zh-CN')
}

/** 比例：0/0 时返回 null，界面显示「—」而不是 0%。 */
function dfRatio(a, b) {
  const x = Number(a)
  const y = Number(b)
  if (!isFinite(x) || !isFinite(y) || y <= 0) return null
  return x / y
}

function dfPct(a, b) {
  const r = dfRatio(a, b)
  return r === null ? '—' : Math.round(r * 100) + '%'
}

function dfPad(n) { return n < 10 ? '0' + n : String(n) }

/** ISO → `2026-10-27 19:42`；空值 → `—`。 */
function dfTime(iso, withSeconds) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return String(iso)
  const base = d.getFullYear() + '-' + dfPad(d.getMonth() + 1) + '-' + dfPad(d.getDate())
    + ' ' + dfPad(d.getHours()) + ':' + dfPad(d.getMinutes())
  return withSeconds ? base + ':' + dfPad(d.getSeconds()) : base
}

/** 只到日：`2026-10-27`。 */
function dfDay(iso) {
  const d = iso ? new Date(iso) : null
  if (!d || isNaN(d.getTime())) return '—'
  return d.getFullYear() + '-' + dfPad(d.getMonth() + 1) + '-' + dfPad(d.getDate())
}

/** 相对时间：`刚刚 / 3 分钟前 / 2 小时前 / 4 天前`。 */
function dfAgo(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000))
  if (s < 45) return '刚刚'
  if (s < 3600) return Math.round(s / 60) + ' 分钟前'
  if (s < 86400) return Math.round(s / 3600) + ' 小时前'
  if (s < 86400 * 30) return Math.round(s / 86400) + ' 天前'
  return dfDay(iso)
}

function dfShort(s, n) {
  const text = String(s === undefined || s === null ? '' : s)
  const max = n || 60
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

function dfDash(v) {
  if (v === undefined || v === null) return '—'
  const s = String(v).trim()
  return s === '' ? '—' : s
}

/* ---------------------------------------------------------------- 调度工具 */

function dfDebounce(fn, ms) {
  let timer = 0
  const wrapped = function () {
    const args = arguments
    const self = this
    if (timer) clearTimeout(timer)
    timer = setTimeout(function () { timer = 0; fn.apply(self, args) }, ms || 150)
  }
  wrapped.cancel = function () { if (timer) { clearTimeout(timer); timer = 0 } }
  return wrapped
}

/** 一帧只跑一次：拖拽 / 缩放用，避免 pointermove 洪水把渲染打满。 */
function dfRaf(fn) {
  let handle = 0
  let lastArgs = null
  const wrapped = function () {
    lastArgs = arguments
    if (handle) return
    handle = requestAnimationFrame(function () {
      handle = 0
      fn.apply(null, lastArgs || [])
    })
  }
  /* 卸载时取消挂起帧，避免组件消失后还 setState。 */
  wrapped.cancel = function () {
    if (handle) { cancelAnimationFrame(handle); handle = 0 }
  }
  return wrapped
}

function dfCopy(text) {
  const value = String(text === undefined || text === null ? '' : text)
  if (!value) return Promise.resolve(false)
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(value).then(function () { return true }, function () { return dfCopyFallback(value) })
    }
  } catch (e) { /* 走兜底 */ }
  return Promise.resolve(dfCopyFallback(value))
}

function dfCopyFallback(value) {
  try {
    const ta = document.createElement('textarea')
    ta.value = value
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch (e) { return false }
}

/** 触发浏览器下载：报告导出用。文件名里的路径分隔符与保留字符先清掉。 */
function dfDownload(name, text, mime) {
  try {
    const blob = new Blob([String(text || '')], { type: (mime || 'text/plain') + ';charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = String(name || 'download.txt').replace(/[\\/:*?"<>|]/g, '-')
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(function () { URL.revokeObjectURL(url) }, 2000)
    return true
  } catch (e) { return false }
}

/** 文件大小：截图上传统一显示 KB / MB。 */
function dfBytes(n) {
  const v = Number(n) || 0
  if (v < 1024) return v + ' B'
  if (v < 1024 * 1024) return (v / 1024).toFixed(0) + ' KB'
  return (v / 1024 / 1024).toFixed(1) + ' MB'
}

/* ---------------------------------------------------------------- Toast */

const DF_TOASTS = []
let dfToastSeq = 0
const dfToastSubs = new Set()

function dfToastEmit() {
  const snap = DF_TOASTS.slice()
  dfToastSubs.forEach(function (fn) { try { fn(snap) } catch (e) { /* 订阅者异常不影响其它 */ } })
}

/**
 * 轻提示。
 * @param {string} text - 文案。
 * @param {'ok'|'err'|'info'} kind - 语义。
 * @param {number} ms - 停留时长，默认 2600。
 */
function dfToast(text, kind, ms) {
  const id = ++dfToastSeq
  DF_TOASTS.push({ id: id, text: String(text), kind: kind || 'info' })
  dfToastEmit()
  const life = typeof ms === 'number' ? ms : 2600
  setTimeout(function () { dfToastDismiss(id) }, life)
  return id
}

function dfToastDismiss(id) {
  const i = DF_TOASTS.findIndex(function (t) { return t.id === id })
  if (i < 0) return
  DF_TOASTS.splice(i, 1)
  dfToastEmit()
}

function dfUseToasts() {
  const [list, setList] = useState(function () { return DF_TOASTS.slice() })
  useEffect(function () {
    dfToastSubs.add(setList)
    setList(DF_TOASTS.slice())
    return function () { dfToastSubs.delete(setList) }
  }, [])
  return list
}

/* ---------------------------------------------------------------- hooks */

/**
 * 克隆视图节点：把整棵 DOM 拷一份用来当「上一帧」。
 *
 * 为什么不直接留着原节点：React 只认得自己创建过的节点，切页时它会把旧视图整个卸掉。
 * 留着不动的那份只能是副本 —— 副本不参与更新、不触发动画、不接交互，纯占位。
 * canvas 只能按位图拷（cloneNode 出来的是空白画布），所以单独处理。
 *
 * @param {Element} src - 源节点。
 * @returns {Node|null}
 */
function dfCloneFrame(src) {
  if (!src || !src.cloneNode) return null
  const out = src.cloneNode(true)
  try {
    const from = src.querySelectorAll('canvas')
    const to = out.querySelectorAll('canvas')
    for (let i = 0; i < from.length && i < to.length; i += 1) {
      try { to[i].getContext('2d').drawImage(from[i], 0, 0) } catch (e) { /* 跨源画布，忽略 */ }
    }
    const all = [src].concat(Array.from(src.querySelectorAll('*')))
    const allOut = [out].concat(Array.from(out.querySelectorAll('*')))
    for (let i = 0; i < all.length && i < allOut.length; i += 1) {
      const sy = all[i].scrollTop
      const sx = all[i].scrollLeft
      if (sy || sx) { allOut[i].scrollTop = sy; allOut[i].scrollLeft = sx }
    }
  } catch (e) { /* 拷贝失败就当没有上一帧 */ }
  return out
}

function dfFrameShow(box, on) {
  if (!box) return
  box.setAttribute('data-on', on ? '1' : '0')
}

function dfFrameClear(box) {
  if (!box) return
  box.textContent = ''
  dfFrameShow(box, false)
}

/**
 * 视图是否已经画出「真东西」。
 *
 * 不能只看有没有卡片：维护页外层那颗卡片一直在，加载时里面装的是骨架，
 * 光看 `.df-card` 会以为内容早就到了，于是残影被提前撤掉、露出骨架。
 * 所以还要确认里面没有占位件。
 *
 * @param {Element|null} content - 视图的内容层。
 * @returns {boolean}
 */
function dfIsPainted(content) {
  if (!content) return false
  if (!content.querySelector('.df-ops, .df-card, .df-empty, .df-blank')) return false
  if (content.querySelector('.df-skel-wrap')) return false
  if (content.querySelector('.df-inline-wait')) return false
  return true
}

/**
 * 异步取数：自动丢弃过期结果，返回 loading/error/reload。
 *
 * @param {Function} loader - 返回 Promise 的函数。
 * @param {Array} deps - 依赖；变化时重跑。
 * @returns {{data: any, error: string, loading: boolean, at: number, reload: Function}}
 */
function dfUseAsync(loader, deps) {
  /* dfBust()（切靶标、写操作）会让所有挂着的取数同时作废，
     用 generation 区分「数据作废」和「换了个视图」：
     数据作废时既往结果直接丢（绝不能把旧靶标的数据当新数据显示），
     generation 变了但数据没作废 —— 比如组件被挪了个位置重新挂载 —— 可以先用手里那份垫着，
     第一帧就不是空白骨架了。 */
  const gen = dfBustGen()
  const genSeenRef = useRef(gen)
  const [state, setState] = useState({ data: null, error: '', loading: true, at: 0 })
  const seq = useRef(0)
  const loaderRef = useRef(loader)
  loaderRef.current = loader
  /* 数据被作废过 → 手里的 data 不能再拿来垫。 */
  if (genSeenRef.current !== gen) {
    genSeenRef.current = gen
    if (state.data) {
      state.data = null
      state.loading = true
    }
  }

  const run = useCallback(function () {
    const id = ++seq.current
    setState(function (s) { return { data: s.data, error: '', loading: true, at: s.at } })
    let p
    try { p = loaderRef.current() } catch (e) { p = Promise.reject(e) }
    Promise.resolve(p).then(function (data) {
      if (seq.current !== id) return
      setState({ data: data, error: '', loading: false, at: Date.now() })
    }, function (e) {
      if (seq.current !== id) return
      setState({ data: null, error: String((e && e.message) || e), loading: false, at: Date.now() })
    })
  }, deps || [])

  useEffect(function () {
    run()
    return function () { seq.current += 1 }
  }, [run])

  return Object.assign({}, state, { reload: run })
}

/** 点击外部关闭：用于下拉、命令面板。 */
function dfUseOutside(ref, onOutside, enabled) {
  useEffect(function () {
    if (enabled === false) return undefined
    const onDown = function (e) {
      const el = ref.current
      if (!el) return
      if (el.contains(e.target)) return
      onOutside(e)
    }
    document.addEventListener('pointerdown', onDown, true)
    return function () { document.removeEventListener('pointerdown', onDown, true) }
  }, [onOutside, enabled])
}

/** 媒体查询；SSR / 老宿主没有 matchMedia 时返回 false。 */
function dfUseMedia(query) {
  const [on, setOn] = useState(function () {
    try { return window.matchMedia ? window.matchMedia(query).matches : false } catch (e) { return false }
  })
  useEffect(function () {
    let mq
    try { mq = window.matchMedia ? window.matchMedia(query) : null } catch (e) { mq = null }
    if (!mq) return undefined
    const handler = function () { setOn(mq.matches) }
    try { mq.addEventListener('change', handler) } catch (e) { mq.addListener(handler) }
    setOn(mq.matches)
    return function () {
      try { mq.removeEventListener('change', handler) } catch (e) { mq.removeListener(handler) }
    }
  }, [query])
  return on
}

/** Ctrl/⌘ 是否按下（Windows 与 mac 同一套快捷键）。 */
function dfModKey(e) {
  return !!(e && (e.metaKey || e.ctrlKey))
}

/** 数组按 key 分组，保序。 */
function dfGroupBy(list, keyOf) {
  const map = new Map()
  ;(list || []).forEach(function (item) {
    const k = keyOf(item)
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(item)
  })
  return map
}

/** 稳定排序：空值永远排最后。 */
function dfSortBy(list, get, dir) {
  const sign = dir === 'desc' ? -1 : 1
  return (list || []).slice().sort(function (a, b) {
    const x = get(a)
    const y = get(b)
    const xe = x === undefined || x === null || x === ''
    const ye = y === undefined || y === null || y === ''
    if (xe && ye) return 0
    if (xe) return 1
    if (ye) return -1
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign
    return String(x).localeCompare(String(y), 'zh-CN') * sign
  })
}

/* ---------------------------------------------------------------- 兜底 */

/**
 * 顶层错误边界：某个视图的数据形状变了 / 渲染抛错时，
 * 只把这一块换成提示卡，别让整个面板从宿主里消失。
 */
class DfErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
    this.retry = this.retry.bind(this)
  }
  static getDerivedStateFromError(error) {
    return { error: error || new Error('unknown') }
  }
  componentDidCatch(error, info) {
    try { console.error('[dsh-forge] ui crash:', error, info) } catch (e) { /* ignore */ }
  }
  retry() { try { dfBust() } catch (e) { /* ignore */ } this.setState({ error: null }) }
  render() {
    const error = this.state.error
    if (!error) return this.props.children
    const msg = String((error && error.message) || error)
    const inline = this.props.inline === true
    return h('div', { className: 'df-crash' + (inline ? ' df-crash--inline' : '') },
      h('div', { className: 'df-crash-card' },
        h('div', { className: 'df-crash-hd' },
          h('span', { className: 'df-crash-mark' }, dfIcon('alert', 15)),
          h('b', null, '面板渲染出错')),
        h('p', null, '该区域数据与界面预期不一致。你的靶标数据未被改动，可以重试或刷新面板。'),
        h('pre', { className: 'df-crash-msg' }, dfShort(msg, 900)),
        h('div', { className: 'df-crash-ft' },
          h(DfCopyBtn, { text: msg, label: '复制错误信息', toast: '错误已复制' }),
          h('span', { className: 'df-spacer' }),
          h('button', { type: 'button', className: 'df-btn df-btn--sm', onClick: this.retry }, '重试'),
          h('button', {
            type: 'button', className: 'df-btn df-btn--sm df-btn--primary',
            onClick: function () { try { window.location.reload() } catch (e) { /* ignore */ } },
          }, '刷新面板'))))
  }
}


/* ---- lib/client/10-api.js ---- */
/* 接口层：只做 HTTP 与缓存，不做业务推导。
   · 读请求按 op+参数 缓存（默认 15s），同 key 并发只发一次；
   · 写请求成功后清空缓存，下一次读必然拿新数据；
   · 错误统一成 `{ ok:false, error }`，视图层只判断 ok。 */

const DF_API_PATH = '/redteam/api'
const DF_BRIDGE_HEADER = { 'x-dsh-forge-bridge': '1' }
const DF_CACHE_TTL = 15000

/** key → { at, value } */
const dfCache = new Map()
/** key → Promise（并发去重） */
const dfInflight = new Map()

function dfApiKey(op, args) {
  try { return op + '|' + JSON.stringify(args || {}) } catch (e) { return op + '|' + String(args) }
}

function dfCacheGet(key, ttl) {
  const hit = dfCache.get(key)
  if (!hit) return undefined
  if (Date.now() - hit.at > (ttl === undefined ? DF_CACHE_TTL : ttl)) {
    dfCache.delete(key)
    return undefined
  }
  return hit.value
}

function dfCacheSet(key, value) {
  dfCache.set(key, { at: Date.now(), value: value })
}

/** 清缓存：`dfBust()` 全清；`dfBust('assets')` 只清该前缀。 */
function dfBust(prefix) {
  dfBustGen.bump()
  /* 页面现在是常驻的：写操作之后，藏在后台的那些页不会自己重画。
     清完缓存顺手通知一声，让它们各自去取新数据 —— 否则切回去看到的是旧内容。 */
  dfBustSubs.forEach(function (fn) {
    try { fn() } catch (e) { /* 订阅方自己出错不影响别人 */ }
  })
  if (!prefix) { dfCache.clear(); return }
  const keys = Array.from(dfCache.keys())
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i].indexOf(prefix) === 0) dfCache.delete(keys[i])
  }
}

/* dfBust() 的代数：每次清缓存 +1。取数钩子拿它判断「手里这份数据是不是已经作废了」。 */
let dfBustCount = 0
function dfBustGen() {
  return dfBustCount
}
dfBustGen.bump = function () { dfBustCount += 1 }

/* 订阅 dfBust()：主区靠它让所有常驻页一起刷新。 */
const dfBustSubs = new Set()
function dfBustSubscribe(fn) {
  dfBustSubs.add(fn)
  return function () { dfBustSubs.delete(fn) }
}

/* 权限档位是全局开关，但改它不动任何靶标数据：
   单独一条通知通道，别借用 dfBust() 把整面板缓存全清 —— 那会让所有常驻页
   同时掉进骨架态，切档时闪一屏。 */
const dfPermSubs = new Set()
function dfPermNotify() {
  dfPermSubs.forEach(function (fn) {
    try { fn() } catch (e) { /* 订阅方自己出错不影响别人 */ }
  })
}
function dfPermSubscribe(fn) {
  dfPermSubs.add(fn)
  return function () { dfPermSubs.delete(fn) }
}

/** 写操作前缀：命中后清缓存。 */
/** 写操作：成功后清空读缓存。显式列出，避免把 platformConfigGet 这类读 op 也当成写。 */
const DF_WRITE_OPS = {
  openEngagement: 1, activateEngagement: 1, deleteEngagement: 1, deleteEngagements: 1, import: 1,
  assetTest: 1, assessAsset: 1, addChainStep: 1, addHttpEvidence: 1,
  addAsset: 1, addPort: 1, addService: 1, addFingerprint: 1, addVuln: 1,
  addCredential: 1, addAccess: 1, addTunnel: 1, addWebshell: 1,
  updateVuln: 1, reviewVuln: 1, toolSet: 1, updateWebshell: 1, updateTunnel: 1, updateAsset: 1,
  savePrompt: 1, resetPrompts: 1, addAttackFile: 1,
  pocUse: 1, pocUpdate: 1, pocDelete: 1, savePoc: 1,
  shotAdd: 1, shotDelete: 1,
  toolboxSync: 1, toolboxAddRoot: 1, toolboxRemoveRoot: 1, toolboxSet: 1, toolboxMeta: 1,
  toolboxPath: 1, toolboxForget: 1,
  platformConfigSave: 1, platformAssignToolkit: 1, vpsApply: 1, vpsClear: 1, vpsNative: 1,
  oastSave: 1, oastClear: 1, fofaClear: 1,
  setAgentsMax: 1, updateApply: 1,
  /* 模型工具专用：面板目前不直接调用它，但一旦调用必须绕开 15s 读缓存，
     否则「刷新」会复用上一次探测结果，还会漏掉新的探测写库。 */
  probeSessions: 1,
  /* 报告开关 / 生成都会改变概览的「下一步」和报告页状态，必须让读缓存失效。 */
  reportMark: 1, reportGenerate: 1,
}

function dfIsWriteOp(op) {
  return !!DF_WRITE_OPS[String(op || '')]
}

function dfJson(res) {
  return res.text().then(function (text) {
    let data = null
    try { data = text ? JSON.parse(text) : null } catch (e) {
      /* 不要把整段 HTML / 堆栈丢到界面上：给状态码就够定位，细节留给宿主日志。 */
      return { ok: false, error: '接口响应异常（HTTP ' + res.status + '）' }
    }
    if (!res.ok) {
      return Object.assign({}, data || {}, {
        ok: false,
        error: (data && (data.error || data.message)) || (res.status + ' ' + res.statusText),
      })
    }
    return data
  }, function () {
    return { ok: false, error: res.status + ' ' + res.statusText }
  })
}

/**
 * 原始 HTTP。
 * @param {string} path - 同源路径。
 * @param {object} [init] - fetch 参数。
 * @param {{ttl?:number, force?:boolean}} [opts] - 缓存策略；GET 默认 15s，POST 不缓存。
 */
function dfHttp(path, init, opts) {
  const options = init || {}
  const config = opts || {}
  const method = String(options.method || 'GET').toUpperCase()
  const cacheable = method === 'GET' && config.ttl !== 0
  const cacheKey = method + ' ' + path
  /* 并发去重按「方法 + 路径 + body」：同一个 POST 路径可能带不同参数（技能详情、规则详情）。 */
  const key = cacheKey + (options.body ? '#' + String(options.body) : '')
  if (cacheable && !config.force) {
    const hit = dfCacheGet(cacheKey, config.ttl)
    if (hit !== undefined) return Promise.resolve(hit)
  }
  if (dfInflight.has(key)) return dfInflight.get(key)

  const p = fetch(path, Object.assign({ cache: 'no-store', credentials: 'same-origin' }, options))
    .then(dfJson)
    .then(function (value) {
      if (cacheable) dfCacheSet(cacheKey, value)
      return value
    }, function (e) {
      return { ok: false, error: '请求失败：' + String((e && e.message) || e) }
    })
    .then(function (value) {
      dfInflight.delete(key)
      return value
    })
  dfInflight.set(key, p)
  return p
}

/** 宿主接口调用：统一成 { ok, ... }，视图只判断 ok。 */
function dfHost(path, init) {
  return dfHttp(path, init, { ttl: 0 }).then(function (r) {
    return r || { ok: false, error: '宿主接口没有返回内容' }
  })
}

function dfHostPost(path, body) {
  return dfHost(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
}

/**
 * 面板 op。
 * @param {string} op - store-core 的 op。
 * @param {object} [args] - 参数（可含 engagement）。
 * @param {{ttl?:number, force?:boolean}} [opts] - 缓存策略。
 */
function dfApi(op, args, opts) {
  const config = opts || {}
  const key = dfApiKey(op, args)
  if (!config.force) {
    const hit = dfCacheGet(key, config.ttl)
    if (hit !== undefined) return Promise.resolve(hit)
  }
  if (dfInflight.has(key)) return dfInflight.get(key)

  const body = JSON.stringify(Object.assign({ op: op }, args || {}))
  const p = fetch(DF_API_PATH, {
    method: 'POST',
    cache: 'no-store',
    credentials: 'same-origin',
    headers: Object.assign({ 'content-type': 'application/json' }, DF_BRIDGE_HEADER),
    body: body,
  })
    .then(dfJson)
    .then(function (value) {
      if (value && value.ok !== false) {
        /* 权限档位只影响「下次越界怎么判」，不影响已读到的数据：
           走独立通知，不全局清缓存。 */
        if (op === 'permissionSet') dfPermNotify()
        else if (dfIsWriteOp(op)) dfBust()
        else dfCacheSet(key, value)
      }
      return value
    }, function (e) {
      return { ok: false, error: '请求失败：' + String((e && e.message) || e) }
    })
    .then(function (value) {
      dfInflight.delete(key)
      return value
    })
  dfInflight.set(key, p)
  return p
}

/** 失败时抛出，交给 dfUseAsync 显示错误。 */
function dfExpect(result) {
  if (result && result.ok === false) throw new Error(result.error || '接口返回失败')
  return result
}

/* ---------------------------------------------------------------- 便捷封装 */

/** 当前靶标 id（缓存 60s；切靶标时由外壳主动 dfBust）。 */
function dfBootstrap(force) {
  return dfApi('bootstrap', {}, { ttl: 60000, force: !!force })
}

/** 统一带上靶标 id 的读请求。 */
function dfEngApi(op, engagement, args, opts) {
  return dfApi(op, Object.assign({ engagement: engagement }, args || {}), opts)
}


/* ---- lib/client/15-icons.js ---- */
/* 内联图标：统一 24 视框、1.6 描边，跟随 currentColor。
   不引第三方图标库：产物小，也不会跟宿主的图标风格打架。 */

const DF_ICONS = {
  shield: ['M12 3.2l7 2.9v5.1c0 4.4-2.9 7.8-7 9.6-4.1-1.8-7-5.2-7-9.6V6.1l7-2.9z'],
  grid: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
  server: ['M4 5h16v5H4z', 'M4 14h16v5H4z', 'M7.5 7.5h.01', 'M7.5 16.5h.01'],
  bug: ['M9 5.5a3 3 0 0 1 6 0', 'M7 9h10v5a5 5 0 0 1-10 0z', 'M12 9v10', 'M4 12h3', 'M17 12h3', 'M5.5 6.5L8 9', 'M18.5 6.5L16 9', 'M5.5 18.5L8 16', 'M18.5 18.5L16 16'],
  link: ['M10.5 13.5a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 1 0-5.7-5.7l-1 1', 'M13.5 10.5a4 4 0 0 0-5.7 0l-2.3 2.3a4 4 0 1 0 5.7 5.7l1-1'],
  route: ['M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M8 17h5a4 4 0 0 0 4-4V9'],
  list: ['M8 6h12', 'M8 12h12', 'M8 18h12', 'M4 6h.01', 'M4 12h.01', 'M4 18h.01'],
  book: ['M5 4h9a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z', 'M17 7h2v13H8'],
  spark: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z', 'M18.5 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z'],
  cloud: ['M7 18a4 4 0 0 1 0-8 5.5 5.5 0 0 1 10.4 1.4A3.4 3.4 0 0 1 17.5 18z'],
  trash: ['M4 7h16', 'M9.5 7V4.8h5V7', 'M6.5 7l1 12.2h9L17.5 7', 'M10 11v5', 'M14 11v5'],
  users: ['M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5', 'M16 4.5a3.5 3.5 0 0 1 0 7', 'M17.5 14.8c2.1.7 3.5 2.4 3.5 5.2'],
  sliders: ['M4 7h10', 'M18 7h2', 'M4 17h4', 'M12 17h8', 'M16 4.5v5', 'M8 14.5v5'],
  prompt: ['M4 5h16v11H9l-5 4z', 'M8 9h8', 'M8 12.5h5'],
  wrench: ['M15.5 4.5a4.5 4.5 0 0 0-5.9 5.6L4 15.7 8.3 20l5.6-5.6a4.5 4.5 0 0 0 5.6-5.9l-2.9 2.9-2.9-2.9z'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-3.6-3.6'],
  refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4.5V11h-6.5'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  max: ['M5 5h14v14H5z'],
  restore: ['M8 8h11v11H8z', 'M5 16V5h11'],
  plus: ['M12 5v14', 'M5 12h14'],
  chevron: ['M8 10l4 4 4-4'],
  chevronRight: ['M10 8l4 4-4 4'],
  copy: ['M9 9h10v10H9z', 'M15 9V5H5v10h4'],
  external: ['M14 4h6v6', 'M20 4l-8 8', 'M18 14v5H5V6h5'],
  filter: ['M4 5h16l-6 7v6l-4 2v-8z'],
  sort: ['M8 5v14', 'M5 8l3-3 3 3', 'M16 19V5', 'M13 16l3 3 3-3'],
  play: ['M8 5l11 7-11 7z'],
  check: ['M5 12.5l4.5 4.5L19 7'],
  alert: ['M12 4l9 16H3z', 'M12 10v4.5', 'M12 17.5h.01'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v5', 'M12 7.5h.01'],
  key: ['M14.5 9.5a3.5 3.5 0 1 1-3-3.4', 'M13 11l7 7', 'M17 15l2-2', 'M19 17l2-2'],
  terminal: ['M4 6h16v12H4z', 'M7 10l2.5 2L7 14', 'M12.5 14.5H17'],
  eye: ['M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7.5V12l3 2'],
  target: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z', 'M12 12h.01'],
  more: ['M6 12h.01', 'M12 12h.01', 'M18 12h.01'],
  download: ['M12 4v10', 'M8 11l4 4 4-4', 'M5 19h14'],
  upload: ['M12 20V10', 'M7 15l5-5 5 5', 'M5 4h14'],
  folder: ['M4 7h6l2 2h8v10H4z'],
  lock: ['M6 11h12v9H6z', 'M9 11V8a3 3 0 0 1 6 0v3'],
  bolt: ['M13 3L5 14h6l-1 7 8-11h-6z'],
  db: ['M12 6.5c4.4 0 8-1.1 8-2.5S16.4 1.5 12 1.5 4 2.6 4 4s3.6 2.5 8 2.5z', 'M4 4v7c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5V4', 'M4 11v7c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-7'],
  crosshair: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 3v4', 'M12 17v4', 'M3 12h4', 'M17 12h4'],
  pause: ['M9 5v14', 'M15 5v14'],
  arrowRight: ['M5 12h13', 'M13 7l5 5-5 5'],
  arrowUp: ['M12 19V5', 'M6 11l6-6 6 6'],
  arrowDown: ['M12 5v14', 'M6 13l6 6 6-6'],
  minus: ['M5 12h14'],
  star: ['M12 4l2.4 5 5.6.8-4 4 1 5.6-5-2.7-5 2.7 1-5.6-4-4 5.6-.8z'],
  layers: ['M12 3l9 5-9 5-9-5z', 'M3 13l9 5 9-5', 'M3 17.5l9 5 9-5'],
  panelLeft: ['M4 5h16v14H4z', 'M9.5 5v14'],
  focus: ['M9 4H4v5', 'M15 4h5v5', 'M20 15v5h-5', 'M4 15v5h5'],
  fileText: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 12h6', 'M9 16h6'],
  image: ['M4 5h16v14H4z', 'M8.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3', 'M4 17l5-5 4 4 3-3 4 4'],
}

/**
 * 取图标。
 * @param {string} name - DF_ICONS 的键。
 * @param {number} [size] - 像素，默认 16。
 * @param {number} [stroke] - 描边宽度，默认 1.6。
 */
function dfIcon(name, size, stroke) {
  const paths = DF_ICONS[name] || DF_ICONS.info
  const s = size || 16
  return h('svg', {
    width: s,
    height: s,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: stroke || 1.6,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    focusable: 'false',
    style: { display: 'block', flex: 'none' },
  }, paths.map(function (d, i) { return h('path', { key: i, d: d }) }))
}


/* ---- lib/client/20-styles.js ---- */
/* 设计令牌与全部 CSS。
   令牌优先吃宿主 --dsw-alias-*，宿主没有时用兜底值；明暗由 data-ds-dark-theme 切换。
   结构色走官方 alias，语义色由 state-* 与 label-primary 混合得到（自动跟随明暗）。 */

function dfInjectStyles() {
  if (document.getElementById('dsh-forge-client-styles')) return
  const el = document.createElement('style')
  el.id = 'dsh-forge-client-styles'
  el.textContent = `
  /* ---------------------------------------------------------------- 令牌
     视图只消费 --df-*，不直接写色值。括号里是预览壳（没有宿主 token）时的兜底。 */
  .dfx-dock,.dfx-launch,.df-portal,.df-rewind-wrap{
    /* 底色与分隔：iOS 分组列表配色（灰底白卡），不再跟随宿主灰蓝色板。 */
    --df-bg:#f2f2f7;
    --df-surface:#ffffff;
    /* 凹陷面（分段控件 / 键帽 / 引用块）：半透明灰，叠在任何底色上都成立。 */
    --df-surface-2:rgba(118,118,128,.12);
    /* 胶囊控件底色（顶栏靶标按钮）：浅色下要略深于 surface-2，白底上才看得出「一块」。 */
    --df-fill:rgba(118,118,128,.18);
    --df-fill-hover:rgba(118,118,128,.26);
    --df-line:rgba(60,60,67,.18);
    --df-line-soft:rgba(60,60,67,.08);
    /* 文字：sub 是信息性文字（≥4.5:1），faint 只给图标与装饰。 */
    --df-ink:#1c1c1e;
    --df-sub:#6e6e73;
    --df-faint:#8e8e93;
    --df-ink-inv:#ffffff;
    /* 强调色 = iOS systemBlue。结构强调用它，语义色各管各的。 */
    --df-accent:#007aff;
    --df-accent-hover:#0069d9;
    --df-accent-soft:rgba(0,122,255,.12);
    --df-sel:rgba(0,122,255,.14);
    --df-hover:rgba(120,120,128,.08);
    --df-hover-2:rgba(120,120,128,.14);
    /* 语义色：正文色压暗保证对比度；solid 留给要抢眼的色块（徽章 / 圆点）。 */
    --df-ok:#1f8f42;
    --df-warn:#a55a00;
    --df-err:#c4271c;
    --df-info:#0057c2;
    --df-ok-solid:#34c759;
    --df-warn-solid:#ff9500;
    --df-err-solid:#d93025;
    --df-info-solid:#007aff;
    --df-ok-soft:rgba(52,199,89,.14);
    --df-warn-soft:rgba(255,149,0,.14);
    --df-err-soft:rgba(255,59,48,.12);
    --df-info-soft:rgba(0,122,255,.12);
    /* 严重度徽章：critical/high 实心，medium/low 淡底 —— 一眼分得出轻重。 */
    --df-sev-critical-bg:#d93025;
    --df-sev-critical-fg:#ffffff;
    --df-sev-high-bg:#f59e0b;
    --df-sev-high-fg:#231400;
    --df-sev-medium-bg:rgba(245,158,11,.18);
    --df-sev-medium-fg:#8a5100;
    --df-sev-low-bg:rgba(120,120,128,.14);
    --df-sev-low-fg:#6e6e73;
    /* 浮层 */
    --df-mask:rgba(0,0,0,.32);
    --df-shadow-1:0 1px 2px rgba(0,0,0,.04),0 6px 20px rgba(0,0,0,.05);
    --df-shadow-2:0 30px 80px rgba(0,0,0,.22),0 4px 14px rgba(0,0,0,.08);
    /* 字体与尺寸 */
    /* 字号刻度：全站只用这一组，别在规则里现写 px。
       num   26  大数字（首屏状态带 / 严重度）
       page  17  页面标题
       card  15  卡片标题
       row   14  列表主标题、表格「身份列」
       body  14  正文、表格单元格（与 row 同值，语义不同：row 表示「这是主信息」）
       meta  13   副行、时间戳、工具名、说明
       micro 12.5 结构性微标签：顶栏、菜单、快捷键、导航分组名、矩阵列头副行 */
    --df-t-num:26px;
    --df-t-page:17px;
    --df-t-card:15px;
    --df-t-row:14px;
    --df-t-body:14px;
    --df-t-meta:13px;
    --df-t-micro:12.5px;
    --df-font:var(--dsw-font-family,-apple-system,"SF Pro Text","PingFang SC","Microsoft YaHei",system-ui,sans-serif);
    --df-mono:var(--ds-font-family-code,ui-monospace,"SF Mono","Cascadia Code",Consolas,monospace);
    --df-r-xs:8px;
    --df-r-sm:10px;
    --df-r:14px;
    --df-r-lg:20px;
    --df-row:46px;
    --df-fs:14px;
  }
  body[data-ds-dark-theme] .dfx-dock,body[data-ds-dark-theme] .dfx-launch,
  body[data-ds-dark-theme] .df-portal,body[data-ds-dark-theme] .df-rewind-wrap{
    --df-bg:#1c1c1e;
    --df-surface:#2c2c2e;
    --df-surface-2:rgba(118,118,128,.24);
    /* 胶囊控件底色（顶栏靶标按钮）：比 surface-2 更实一档，暗色下才看得出是「一块」。 */
    --df-fill:#3a3a3c;
    --df-fill-hover:#48484a;
    --df-line:rgba(84,84,88,.65);
    --df-line-soft:rgba(84,84,88,.4);
    --df-ink:#f2f2f7;
    --df-sub:#aeaeb2;
    --df-faint:#8e8e93;
    --df-ink-inv:#ffffff;
    --df-accent:#0a84ff;
    --df-accent-hover:#409cff;
    --df-accent-soft:rgba(10,132,255,.22);
    --df-sel:rgba(10,132,255,.26);
    --df-hover:rgba(255,255,255,.07);
    --df-hover-2:rgba(255,255,255,.12);
    --df-ok:#30d158;
    --df-warn:#ff9f0a;
    --df-err:#ff453a;
    --df-info:#64d2ff;
    --df-ok-solid:#30d158;
    --df-warn-solid:#ff9f0a;
    --df-err-solid:#d93025;
    --df-info-solid:#0a84ff;
    --df-ok-soft:rgba(48,209,88,.18);
    --df-warn-soft:rgba(255,159,10,.18);
    --df-err-soft:rgba(255,69,58,.18);
    --df-info-soft:rgba(100,210,255,.16);
    --df-sev-critical-bg:#d93025;
    --df-sev-critical-fg:#ffffff;
    --df-sev-high-bg:#ff9f0a;
    --df-sev-high-fg:#1c1c1e;
    --df-sev-medium-bg:rgba(255,159,10,.2);
    --df-sev-medium-fg:#ffc46b;
    --df-sev-low-bg:rgba(120,120,128,.28);
    --df-sev-low-fg:#c7c7cc;
    --df-mask:rgba(0,0,0,.55);
  }

  /* ---------------------------------------------------------------- 基础 */
  .dfx-dock,.dfx-dock *,.df-portal,.df-portal *,.df-rewind-wrap,.df-rewind-wrap *{box-sizing:border-box}
  .dfx-dock,.df-portal,.df-rewind-wrap{color:var(--df-ink);font:var(--df-fs)/1.5 var(--df-font);
    -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
  .dfx-dock ::selection,.df-portal ::selection{background:var(--df-accent-soft)}
  .dfx-dock button,.dfx-dock input,.dfx-dock select,.dfx-dock textarea,
  .df-portal button,.df-portal input,.df-portal select,.df-portal textarea,
  .df-rewind-wrap button,.df-rewind-wrap input,.df-rewind-wrap select,.df-rewind-wrap textarea{font-family:inherit}
  .dfx-dock button:focus-visible,.dfx-dock input:focus-visible,.dfx-dock select:focus-visible,
  .dfx-dock textarea:focus-visible,.dfx-dock [tabindex]:focus-visible,
  .df-portal button:focus-visible,.df-portal input:focus-visible,.df-portal [tabindex]:focus-visible{outline:2px solid var(--df-accent);outline-offset:1px}
  .dfx-dock a,.df-portal a{color:var(--dsw-alias-link,var(--df-accent));text-decoration:none}
  .dfx-dock ::-webkit-scrollbar,.df-portal ::-webkit-scrollbar{width:10px;height:10px}
  /* 滚动条：平时很淡，鼠标进面板才显形 —— 像系统 overlay 滚动条，
     而不是网页那种常驻的一条灰杠。 */
  .dfx-dock ::-webkit-scrollbar-thumb,.df-portal ::-webkit-scrollbar-thumb{
    background:color-mix(in srgb,var(--df-ink) 10%,transparent);border-radius:999px;
    border:3px solid transparent;background-clip:content-box;transition:background .15s}
  .dfx-dock:hover ::-webkit-scrollbar-thumb,.df-portal:hover ::-webkit-scrollbar-thumb{
    background:color-mix(in srgb,var(--df-ink) 18%,transparent);
    border:3px solid transparent;background-clip:content-box}
  .dfx-dock ::-webkit-scrollbar-thumb:hover,.df-portal ::-webkit-scrollbar-thumb:hover{
    background:color-mix(in srgb,var(--df-ink) 30%,transparent);
    border:3px solid transparent;background-clip:content-box}
  .dfx-dock ::-webkit-scrollbar-track,.df-portal ::-webkit-scrollbar-track{background:transparent}

  /* ---------------------------------------------------------------- 启动器 */
  .dfx-launch{position:absolute;right:18px;bottom:18px;z-index:2147483000;display:inline-flex;align-items:center;gap:7px;
    height:32px;padding:0 12px 0 10px;border:1px solid var(--df-line);border-radius:999px;background:var(--df-surface);
    color:var(--df-sub);font-size:14px;font-weight:600;line-height:1;cursor:pointer;
    box-shadow:var(--df-shadow-1);pointer-events:auto;-webkit-app-region:no-drag;
    transition:color .16s,background .16s,border-color .16s,transform .16s}
  .dfx-launch:hover{color:var(--df-ink);border-color:color-mix(in srgb,var(--df-accent) 45%,var(--df-line));transform:translateY(-1px)}
  .dfx-launch:active{transform:translateY(0)}
  .dfx-launch .df-dot{width:6px;height:6px;border-radius:50%;background:var(--df-ok);box-shadow:0 0 0 3px var(--df-ok-soft)}

  /* ---------------------------------------------------------------- 外壳 */
  /* 面板出现时给 140ms 的轻微放大 + 淡入：本地应用不会「啪」地贴一屏，
     而是从触发它的地方长出来。位移只有 2px，够被眼睛读到，又不会显得在表演。 */
  .dfx-dock{position:absolute;z-index:2147483001;display:flex;flex-direction:column;background:var(--df-bg);
    border:1px solid var(--df-line-soft);border-radius:var(--df-r-lg);overflow:hidden;box-shadow:var(--df-shadow-2);
    pointer-events:auto;min-width:640px;min-height:420px;
    animation:dfx-rise .14s cubic-bezier(.2,.7,.3,1) both}
  @keyframes dfx-rise{from{opacity:0;transform:translateY(2px) scale(.995)}to{opacity:1;transform:none}}
  .dfx-inner{display:flex;flex-direction:column;min-width:0;min-height:0;width:100%;height:100%;position:relative}
  .dfx-head{display:flex;align-items:center;gap:10px;height:48px;padding:0 10px 0 16px;flex:none;
    background:var(--df-surface);border-bottom:1px solid var(--df-line-soft);-webkit-app-region:no-drag;
    cursor:default;user-select:none}
  .dfx-mark{width:24px;height:24px;border-radius:7px;display:flex;align-items:center;justify-content:center;flex:none;
    background:var(--df-accent);color:var(--df-ink-inv)}
  .dfx-brand{font-weight:700;font-size:15px;letter-spacing:.02em;white-space:nowrap}
  /* 产品副名：中文字距拉开一点、颜色压淡，跟主名形成主次，而不是两个同权重的大字。 */
  .dfx-sub{font-size:12px;color:var(--df-faint);white-space:nowrap;letter-spacing:.05em;
    padding-left:8px;border-left:1px solid var(--df-line)}
  /* 作者署名：只做识别，不做视觉重心 —— 比副名更小更淡。字号 12 是面板的字号下限
     （全页审计要求除矩阵列头副行外不得低于 12），所以不靠字号再压，只靠颜色。 */
  .dfx-by{font-size:12px;color:var(--df-faint);white-space:nowrap;opacity:.8;
    font-variant-numeric:tabular-nums;letter-spacing:.01em;transition:opacity .15s}
  .dfx-head:hover .dfx-by{opacity:1}
  .dfx-spacer{margin-left:auto}

  /* 顶栏按可用宽度逐级收窄（JS 实测 scrollWidth 后写 data-hd）：
     先去掉副标题与说明文字，再去掉品牌字、缩小靶标名，最后收起缩放组与模式。
     窗控和权限档位永远保留：这两样在窄窗里也不能消失。 */
  .dfx-head[data-hd]{gap:6px}
  .dfx-head[data-hd="1"] .dfx-sub,
  .dfx-head[data-hd="1"] .dfx-by,
  .dfx-head[data-hd="1"] .df-topbtn-t,
  .dfx-head[data-hd="1"] .df-topbtn kbd,
  .dfx-head[data-hd="1"] .df-target-meta{display:none}
  .dfx-head[data-hd="1"] .df-target-name{max-width:140px}
  .dfx-head[data-hd="2"] .dfx-brand{display:none}
  .dfx-head[data-hd="2"] .df-target-name{max-width:96px}
  .dfx-head[data-hd="3"] .df-zoom{display:none}
  .dfx-head[data-hd="3"] .df-target{max-width:150px}
  .dfx-head[data-hd="3"] .df-target-name{max-width:78px}
  .dfx-head[data-hd="3"] .df-inject-label{display:none}
  .dfx-docktabs{display:flex;gap:2px;background:var(--df-surface-2);padding:2px;border-radius:var(--df-r-sm);-webkit-app-region:no-drag}
  .dfx-docktabs button{font-size:14px;font-weight:500;height:26px;padding:0 12px;border:0;background:transparent;
    border-radius:7px;color:var(--df-sub);cursor:pointer;transition:background .15s,color .15s}
  .dfx-docktabs button:hover{color:var(--df-ink)}
  .dfx-docktabs button.on{background:var(--df-surface);color:var(--df-ink);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08),0 2px 6px rgba(0,0,0,.04)}
  .dfx-tag{font-size:12px;font-weight:600;color:var(--df-sub);white-space:nowrap;
    display:inline-flex;align-items:center;height:24px;padding:0 10px;
    border:1px solid var(--df-line);border-radius:999px;background:transparent}
  /* 顶栏破甲状态：名字固定“破甲注入”，圆点红=未启动，绿=已启动。 */
  .df-inject-chip{height:26px;gap:6px;color:var(--df-sub);cursor:pointer;font:inherit;font-size:12px;font-weight:600}
  .df-inject-chip:hover{background:var(--df-fill);color:var(--df-ink)}
  .df-inject-chip .df-inject-dot{width:7px;height:7px;border-radius:50%;flex:none}
  .df-inject-wrap{position:relative;display:flex;align-items:center}
  .df-inject-menu{left:auto;right:0;width:300px}
  .df-inject-menu-bd{padding:8px;display:flex;flex-direction:column;gap:6px}
  .df-inject-menu-ft{display:flex;align-items:center;justify-content:flex-end;gap:6px;padding:8px;
    border-top:1px solid var(--df-line-soft)}
  .df-agent-modes{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 10px;
    border:1px solid var(--df-line);border-radius:10px;background:var(--df-surface)}
  .df-agent-modes .df-ops-meta{margin-right:4px}
  .df-agent-mode{height:28px;padding:0 12px;border:1px solid var(--df-line);border-radius:999px;
    background:transparent;color:var(--df-sub);font:inherit;font-size:12.5px;cursor:pointer;
    transition:background .15s,color .15s,border-color .15s}
  .df-agent-mode:hover{background:var(--df-hover);color:var(--df-ink)}
  .df-agent-mode.is-on{background:var(--df-accent-soft);border-color:color-mix(in srgb,var(--df-accent) 45%,var(--df-line));
    color:var(--df-accent);font-weight:650}
  /* 破甲注入页的状态区：大按钮开关，不用小滑块。 */
  .df-inject-hero{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 14px;margin-bottom:10px;
    border:1px solid var(--df-line);border-radius:12px;background:var(--df-surface-2)}
  .df-inject-hero.is-on{border-color:color-mix(in srgb,var(--df-ok-solid) 32%,var(--df-line));
    background:color-mix(in srgb,var(--df-ok-solid) 6%,var(--df-surface))}
  .df-ih-main{flex:1 1 220px;min-width:0;display:flex;flex-direction:column;gap:2px}
  .df-ih-main b{font-size:14px;color:var(--df-ink)}
  .df-ih-main span{font-size:12.5px;color:var(--df-sub);line-height:1.5}
  /* 破甲注入未生效时的顶部提示条：比顶栏小按钮更显眼，说明「为什么现在不算正常破甲」。 */
  .df-inject-banner{position:relative;z-index:3;display:flex;align-items:center;gap:12px;padding:12px 14px;
    flex-wrap:wrap;
    border:1px solid color-mix(in srgb,var(--df-warn-solid) 38%,var(--df-line));border-radius:12px;
    background:color-mix(in srgb,var(--df-warn-solid) 8%,var(--df-surface));
    box-shadow:0 1px 2px rgba(0,0,0,.04)}
  .df-inject-banner.is-soft{border-color:var(--df-line);background:var(--df-surface)}
  .df-inject-banner.is-soft .df-ib-ico{background:var(--df-fill);color:var(--df-sub)}
  .df-ib-ico{flex:none;width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;
    background:var(--df-warn-soft);color:var(--df-warn)}
  .df-ib-main{min-width:0;flex:1 1 240px;display:flex;flex-direction:column;gap:2px}
  .df-ib-main b{font-size:14px;color:var(--df-ink)}
  .df-ib-main span{font-size:12.5px;color:var(--df-sub);line-height:1.5}
  .df-ib-act{display:flex;gap:6px;align-items:center;flex:none}
  .df-scope-line{display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap}
  .df-scope-main{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
  .df-scope-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  /* 补丁方案条：推荐 / 仅核心 / 全部，右侧是“只看已停用”。 */
  .df-presetbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:10px 12px 0;
    border-top:1px solid var(--df-line-soft);margin-top:2px}
  .df-presetbar .df-ops-meta{margin-right:2px}
  .df-presetbar .df-agent-mode{height:26px;padding:0 11px;font-size:12.5px}
  .df-scheme-chip{display:inline-flex;align-items:center;height:26px;border:1px solid var(--df-line);
    border-radius:999px;background:transparent;overflow:hidden}
  .df-scheme-chip.is-on{border-color:color-mix(in srgb,var(--df-accent) 45%,var(--df-line));
    background:var(--df-accent-soft)}
  .df-scheme-name{border:0;background:transparent;height:24px;padding:0 8px 0 11px;
    font:inherit;font-size:12.5px;color:var(--df-sub);cursor:pointer;white-space:nowrap}
  .df-scheme-name:hover{color:var(--df-ink)}
  .df-scheme-chip.is-on .df-scheme-name{color:var(--df-accent);font-weight:650}
  .df-scheme-x{border:0;border-left:1px solid var(--df-line-soft);background:transparent;
    height:24px;width:23px;color:var(--df-faint);font-size:13px;line-height:1;cursor:pointer;padding:0}
  .df-scheme-x:hover{background:var(--df-err-soft);color:var(--df-err)}
  .df-scheme-save{display:inline-flex;align-items:center;gap:5px}
  /* 补丁标签筛选条：核心用强调色，选中后实心。 */
  .df-tagbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:10px 12px 0}
  .df-tagbar .df-agent-mode{height:26px;padding:0 11px;font-size:12.5px}
  /* 核心默认保持中性，只加粗；只有点中筛选时才用强调色。
     否则它和“全部”同时像选中，两个橙块叠在一起会发浑。 */
  .df-tag-chip.is-core{border-color:var(--df-line);background:transparent;
    color:var(--df-sub);font-weight:700}
  .df-tag-chip.is-core.is-on{background:var(--df-accent-soft);
    border-color:color-mix(in srgb,var(--df-accent) 45%,var(--df-line));color:var(--df-accent)}
  /* 生效范围的模式名是给人看的，不能套 9.5px 的小 chip：单独放大到正文尺寸。 */
  .df-scope-chips .df-chip{height:26px;padding:0 11px;border-radius:8px;font-size:12.5px;font-weight:620;letter-spacing:0}
  .df-scope-chips .df-chip svg{width:12px;height:12px}
  .dfx-x{border:0;background:transparent;color:var(--df-sub);font-size:17px;cursor:pointer;width:28px;height:28px;
    display:inline-flex;align-items:center;justify-content:center;border-radius:var(--df-r-sm);-webkit-app-region:no-drag;
    transition:background .15s,color .15s}
  .dfx-x:hover{background:var(--df-hover);color:var(--df-ink)}

  /* 导航（左侧常驻栏）
     位置按「工作频率」排：作业在最上（每一轮都在用），交付其次，资源与配置垫底。
     频率表写死在 DF_NAV 里，**不按最近点击自动重排** —— 键盘不会因为你刚敲了 A 就换键位，
     空间记忆一旦建立就不该被打乱。 */
  .dfx-nav{display:flex;flex-direction:column;width:176px;flex:none;padding:6px 8px;
    background:var(--df-bg);border-right:1px solid var(--df-line-soft);overflow:hidden}
  .dfx-navlist{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:2px}
  .dfx-navlist::-webkit-scrollbar{width:8px}
  .dfx-ngrp{font-size:12px;font-weight:600;letter-spacing:.05em;color:var(--df-sub);
    padding:12px 10px 5px;white-space:nowrap;user-select:none;-webkit-user-select:none;pointer-events:none}
  .dfx-ngrp-block:first-child .dfx-ngrp{padding-top:4px}
  .dfx-navbtn{position:relative;display:flex;flex:none;align-items:center;gap:9px;width:100%;height:32px;
    padding:0 9px;border:0;border-radius:9px;background:transparent;color:var(--df-sub);
    font-size:var(--df-t-meta);font-weight:500;line-height:1;cursor:pointer;text-align:left;white-space:nowrap;
    transition:background .14s,color .14s,box-shadow .14s}
  .dfx-navbtn>svg{opacity:.8}
  .dfx-navbtn .df-navtxt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
  .dfx-navbtn:hover{background:var(--df-hover);color:var(--df-ink)}
  /* 选中 = 实底胶囊 + 极轻阴影（浮在浅灰侧栏上），不加左侧色条、不整行反白。 */
  .dfx-navbtn.on{background:var(--df-surface);color:var(--df-ink);font-weight:600;
    box-shadow:0 1px 2px rgba(0,0,0,.06),0 0 0 1px rgba(60,60,67,.08)}
  .dfx-navbtn.on>svg{color:var(--df-accent);opacity:1}
  .dfx-navbtn .df-navdot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--df-err)}
  .dfx-navfoot{display:flex;align-items:center;gap:2px;flex:none;margin-top:6px;padding-top:6px;
    border-top:1px solid var(--df-line-soft)}
  .dfx-navfold{display:flex;align-items:center;gap:9px;flex:1;min-width:0;height:30px;padding:0 9px;border:0;
    border-radius:9px;background:transparent;color:var(--df-faint);font-size:var(--df-t-meta);cursor:pointer;
    white-space:nowrap;transition:background .14s,color .14s}
  .dfx-navfold--icon{flex:none;width:30px;justify-content:center;padding:0}
  .dfx-nav.is-mini .dfx-navfold--icon{display:none}
  .dfx-navfold:hover{background:var(--df-hover);color:var(--df-sub)}
  .dfx-navfold-ico{display:flex;flex:none;transition:transform .16s ease}
  .dfx-navfold-ico.is-mini{transform:rotate(180deg)}
  /* 收起：56px 纯图标栏，分组改用细线分隔 —— 宽度变了，但每一项的上下顺序不变。 */
  .dfx-nav.is-mini{width:56px;padding:6px}
  .dfx-nav.is-mini .dfx-ngrp{display:none}
  .dfx-nav.is-mini .dfx-ngrp-block:not(:first-child){margin-top:8px;padding-top:8px;
    border-top:1px solid var(--df-line-soft)}
  .dfx-nav.is-mini .dfx-navbtn{justify-content:center;padding:0}
  .dfx-nav.is-mini .dfx-navbtn .df-navtxt{display:none}
  .dfx-nav.is-mini .dfx-navbtn .df-navdot{position:absolute;top:6px;right:7px;width:5px;height:5px}
  .dfx-nav.is-mini .dfx-navfold{justify-content:center;padding:0;flex:none;width:30px}
  /* 沉浸模式：侧栏变成贴左边缘的浮层。收起时完全让出宽度，
     鼠标进入 12px 热区才滑出 —— 它不参与布局，主区宽度不会跟着鼠标抖。 */
  .dfx-navzone{display:none}
  .dfx-dock[data-nav="hidden"] .dfx-navzone{display:block;position:absolute;left:0;top:0;bottom:0;width:12px;z-index:6}
  .dfx-dock[data-nav="hidden"] .dfx-navzone::after{content:"";position:absolute;left:3px;top:50%;margin-top:-18px;
    width:3px;height:36px;border-radius:2px;background:var(--df-line);opacity:.32;transition:opacity .15s}
  .dfx-dock[data-nav="hidden"] .dfx-navzone:hover::after{opacity:.9}
  .dfx-dock[data-nav="hidden"] .dfx-nav{position:absolute;left:0;top:0;bottom:0;z-index:7;width:176px;
    border-right:1px solid var(--df-line);box-shadow:10px 0 28px rgba(0,0,0,.14);
    transform:translateX(-100%);opacity:0;pointer-events:none;
    transition:transform .16s cubic-bezier(.2,.7,.3,1),opacity .12s ease}
  .dfx-dock[data-nav="hidden"] .dfx-navzone:hover ~ .dfx-nav,
  .dfx-dock[data-nav="hidden"] .dfx-nav:hover,
  .dfx-dock[data-nav="hidden"] .dfx-nav:focus-within{transform:none;opacity:1;pointer-events:auto}

  .dfx-body{flex:1;display:flex;min-height:0;width:100%;background:var(--df-bg);position:relative}
  .dfx-main{flex:1;min-width:0;overflow:auto;padding:18px;display:flex;flex-direction:column;gap:14px;
    container-type:inline-size;position:relative}
  .dfx-main>*{max-width:1480px;width:100%;margin-left:auto;margin-right:auto}
  /* 常驻页：只显示当前这一个，其余的留在 DOM 里但不可见。
     display:none 而不是 visibility —— 藏起来的页不参与布局和绘制，切换更省。 */
  .dfx-pane{display:none;flex-direction:column;gap:14px;width:100%;max-width:1480px;margin:0 auto}
  .dfx-pane[data-on="1"]{display:flex}
  /* 内容层压在残影之下：残影是「盖在上面的上一页」，揭开才看得到内容。 */
  .dfx-pane .df-viewbox,.dfx-main>.df-viewbox{position:relative;z-index:1}
  /* 上一帧残影：整块盖在主区上（含内边距），带不透明底 + 裁切，
     所以它不是「垫在下面透出来」，而是真的把新页挡住 —— 新页可以直接在它背后
     慢慢画完，画好了再一次性揭开。这样中间永远不会露出空白或骨架。 */
  .dfx-frame{position:absolute;inset:0;padding:18px;overflow:hidden;pointer-events:none;user-select:none;
    background:var(--df-bg);display:flex;flex-direction:column;gap:14px;
    opacity:0;visibility:hidden;z-index:2}
  .dfx-frame>*{max-width:1480px;width:100%;margin-left:auto;margin-right:auto}
  .dfx-frame[data-on="1"]{opacity:1;visibility:visible}
  /* 抽屉从右侧滑进来（不是瞬间撑开），关掉时由 React 直接卸载，不做退场动画 ——
     退场动画会让「点了没反应」的错觉变长。 */
  .dfx-side{width:380px;flex:none;border-left:1px solid var(--df-line-soft);background:var(--df-surface);
    padding:16px;overflow:auto;display:flex;flex-direction:column;gap:12px;
    animation:dfx-slide .16s cubic-bezier(.2,.7,.3,1) both}
  @keyframes dfx-slide{from{opacity:.4;transform:translateX(10px)}to{opacity:1;transform:none}}
  /* ------------------------------------------------ 整页详情（iOS push 式下钻）
     点列表进来 → 一层新页面，左上角返回；内容占满，不再和列表抢宽度。
     数据接口沿用抽屉的 { title, sub, rows, node }，调用方加 mode:'page' 即可。 */
  .dfx-dock>.dfx-page{max-width:none;width:100%;margin:0}
  .dfx-page{position:absolute;inset:0;z-index:40;display:flex;flex-direction:column;
    background:var(--df-surface);animation:dfPageIn .24s cubic-bezier(.32,.72,0,1) both}
  .dfx-page-hd{flex:0 0 auto;display:flex;align-items:center;gap:10px;height:48px;
    padding:0 12px 0 6px;border-bottom:1px solid var(--df-line-soft);background:var(--df-surface);
    box-shadow:0 1px 0 var(--df-line-soft)}
  .dfx-page-back{display:inline-flex;align-items:center;gap:4px;height:32px;padding:0 10px 0 6px;
    border:0;border-radius:8px;background:transparent;color:var(--df-accent);
    font-size:12.5px;font-weight:650;cursor:pointer}
  .dfx-page-back:hover{background:var(--df-hover)}
  .dfx-page-tt{display:flex;flex-direction:column;gap:1px;min-width:0}
  .dfx-page-tt b{font-size:14px;font-weight:650;line-height:1.3;max-width:46ch;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .dfx-page-tt small{font-size:10.5px;color:var(--df-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .dfx-page-bd{flex:1;overflow:auto;padding:14px 16px 32px}
  /* 整页里的长文本编辑器：占满可用高度、用等宽字体；不要在窄抽屉里改大段文字。 */
  /* 只有「文档类」编辑器放大：人格 / 角色稿 / 破甲注入 / 规则片段。
     漏洞复核、短表单这类普通 df-area 保持默认高度，不要跟着一起铺满。 */
  .dfx-page-bd textarea.df-area--doc,
  .dfx-page-bd textarea.df-area--code{min-height:56vh;font-size:13px;line-height:1.7;resize:vertical}
  /* 宽屏下详情内容不铺满整行，长文更好读；字段两列并排。 */
  .dfx-page-bd>.df-kv,
  .dfx-page-bd>.df-detail{max-width:1100px;margin-left:auto;margin-right:auto}
  .dfx-page .df-kv{grid-template-columns:76px minmax(0,1fr) 76px minmax(0,1fr);gap:8px 18px;
    padding:14px 16px;border:1px solid var(--df-line);border-radius:12px;background:var(--df-surface-2)}
  @media (max-width: 760px){
    .dfx-page .df-kv{grid-template-columns:76px minmax(0,1fr)}
  }
  @keyframes dfPageIn{from{opacity:.35;transform:translateX(22px)}to{opacity:1;transform:none}}
  @media (prefers-reduced-motion: reduce){.dfx-page{animation:none}}
  /* ------------------------------------------------ 快速预览卡（peek）
     扫一眼的详情：贴在行旁边，只给 6 个字段 + 复制 + 「查看完整」，
     不需要为一条凭证/通道开整页。 */
  .df-peek{position:fixed;z-index:60;display:flex;flex-direction:column;width:360px;max-height:60vh;
    background:var(--df-surface);border:1px solid var(--df-line);border-radius:12px;
    box-shadow:var(--df-shadow-2);overflow:hidden;
    animation:dfPeekIn .16s cubic-bezier(.2,.7,.3,1) both}
  .df-peek-hd{display:flex;align-items:flex-start;gap:8px;padding:10px 8px 8px 12px;
    border-bottom:1px solid var(--df-line-soft)}
  .df-peek-tt{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
  .df-peek-tt b{font-size:12.5px;font-weight:650;line-height:1.35;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .df-peek-tt small{font-size:10.5px;color:var(--df-faint);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .df-peek-x{border:0;background:transparent;color:var(--df-faint);cursor:pointer;
    padding:3px;border-radius:6px;display:flex}
  .df-peek-x:hover{background:var(--df-hover);color:var(--df-ink)}
  .df-peek-bd{overflow:auto;padding:10px 12px}
  .df-peek .df-kv{grid-template-columns:76px minmax(0,1fr);font-size:12px;gap:6px 10px}
  .df-peek .df-kv dt{font-size:11.5px;line-height:1.5}
  .df-peek-ft{display:flex;align-items:center;gap:8px;padding:8px 10px;
    border-top:1px solid var(--df-line-soft)}
  .df-peek-more{font-size:10px;color:var(--df-faint)}
  @keyframes dfPeekIn{from{opacity:.3;transform:translateY(4px) scale(.985)}to{opacity:1;transform:none}}
  @media (prefers-reduced-motion: reduce){.df-peek{animation:none}}
  /* 工具页双列：卡片短，单列右边会空一大块。auto-fit 在窄窗自动回单列。 */
  .df-tool-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:8px;padding:10px}
  .df-tool-grid .df-vrow{width:100%}
  .dfx-rz{position:absolute;z-index:8;touch-action:none}
  .dfx-rz-r{right:0;top:14px;bottom:14px;width:8px;cursor:ew-resize}
  .dfx-rz-b{left:14px;right:14px;bottom:0;height:8px;cursor:ns-resize}
  .dfx-resize{right:0;bottom:0;width:20px;height:20px;cursor:nwse-resize}
  .dfx-resize:after{content:"";position:absolute;right:5px;bottom:5px;width:9px;height:9px;
    border-right:1.5px solid var(--df-faint);border-bottom:1.5px solid var(--df-faint);opacity:.5}
  .dfx-dock:hover .dfx-resize:after{opacity:1}

  /* ---------------------------------------------------------------- 顶栏控件 */
  .df-topbtn{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 8px;border:1px solid transparent;
    border-radius:var(--df-r-sm);background:transparent;color:var(--df-sub);font-size:13px;font-weight:500;line-height:1;
    cursor:pointer;transition:background .15s,color .15s,border-color .15s}
  .df-topbtn:hover{background:var(--df-hover);color:var(--df-ink);border-color:var(--df-line)}
  .df-topbtn kbd,.df-cmd-esc{font-family:var(--df-mono);font-size:12px;font-weight:600;line-height:1;color:var(--df-sub);
    background:var(--df-surface-2);border:1px solid var(--df-line);border-radius:var(--df-r-xs);padding:2px 4px;letter-spacing:0}
  .df-iconbtn{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border:0;
    border-radius:var(--df-r-sm);background:transparent;color:var(--df-sub);font-size:14px;cursor:pointer;flex:none;
    transition:background .15s,color .15s}
  .df-iconbtn:hover{background:var(--df-hover);color:var(--df-ink)}
  .df-iconbtn[disabled]{opacity:.5;cursor:not-allowed}

  /* 顶栏权限档位：常驻一颗，颜色即语义（只读=绿 / 工作区可写=蓝 / 完全访问=橙）。
     造型刻意做成「状态读数」而不是按钮：浅底 + 同色细边 + 前缀「权限」，
     一眼知道这是当前授权限度，点开才会切换。定宽保证换档时整簇不位移。 */
  .dfx-perm{position:relative;display:flex;flex:none}
  .dfx-perm-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:5px;height:24px;width:144px;
    padding:0 6px;border:1px solid transparent;border-radius:8px;
    font-size:12px;font-weight:600;line-height:1;cursor:pointer;white-space:nowrap;
    background:var(--df-surface-2);color:var(--df-sub);
    transition:background .18s ease,color .18s ease,border-color .18s ease,box-shadow .18s ease}
  /* 换档时只有文字轻轻上浮一下：不做整块缩放，避免看起来像闪了一下。 */
  .dfx-perm-name{display:inline-block;font-weight:650;animation:df-perm-swap .18s cubic-bezier(.2,.7,.3,1) both}
  .dfx-perm-prefix{font-weight:500;opacity:.62}
  @keyframes df-perm-swap{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:none}}
  .dfx-perm-btn[data-tone="ok"]{background:var(--df-ok-soft);border-color:rgba(52,199,89,.28);color:var(--df-ok)}
  .dfx-perm-btn[data-tone="info"]{background:var(--df-info-soft);border-color:rgba(0,122,255,.26);color:var(--df-info)}
  .dfx-perm-btn[data-tone="warn"]{background:var(--df-warn-soft);border-color:rgba(255,149,0,.3);color:var(--df-warn)}
  .dfx-perm-btn:hover{filter:brightness(1.04)}
  .dfx-perm-btn:hover>svg:last-child{opacity:.8}
  .dfx-perm-btn.is-open{box-shadow:0 0 0 2px var(--df-accent-soft)}
  .dfx-perm-btn>svg:last-child{opacity:.45}
  /* 「越界时询问」开着时，chip 右上角一个小点：不改变宽度，也不多一行字。 */
  .dfx-perm-flag{position:absolute;top:3px;right:4px;width:5px;height:5px;border-radius:50%;
    background:var(--df-accent);box-shadow:0 0 0 2px var(--df-ok-soft)}
  .dfx-perm-ask{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;
    height:30px;margin-top:2px;padding:0 8px;border:0;border-radius:var(--df-r-sm);
    background:transparent;color:var(--df-sub);font-size:12px;cursor:pointer;text-align:left}
  .dfx-perm-ask:hover{background:var(--df-hover)}
  .dfx-perm-ask[disabled]{opacity:.45;cursor:default}
  .dfx-perm-ask[disabled]:hover{background:transparent}
  .dfx-perm-sw{position:relative;flex:none;width:28px;height:16px;border-radius:999px;
    background:var(--df-surface-2);transition:background .15s}
  .dfx-perm-sw:after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;
    background:var(--df-surface);box-shadow:0 1px 2px rgba(0,0,0,.22);transition:transform .15s}
  .dfx-perm-ask.on{color:var(--df-ink)}
  .dfx-perm-ask.on .dfx-perm-sw{background:var(--df-accent)}
  .dfx-perm-ask.on .dfx-perm-sw:after{transform:translateX(12px)}
  .dfx-perm .dfx-perm-menu{left:auto;right:0;width:280px;top:calc(100% + 6px)}
  .dfx-perm-menu .df-menu-item{padding:8px}
  .dfx-perm-menu .df-menu-item .df-mi-main span{line-height:1.5}
  .dfx-perm-menu .df-menu-item[disabled]{opacity:.6;cursor:progress}
  .dfx-perm-foot{margin-top:5px;padding:7px 8px 4px;border-top:1px solid var(--df-line-soft);
    font-size:12px;line-height:1.5;color:var(--df-faint)}
  .df-zoom{display:inline-flex;align-items:center;gap:1px;height:24px;padding:1px;border-radius:var(--df-r-sm);
    background:var(--df-surface-2);color:var(--df-sub);flex:none}
  .df-zoom button{height:20px;min-width:20px;border:0;border-radius:var(--df-r-xs);background:transparent;color:inherit;
    font-family:var(--df-mono);font-size:12px;font-weight:600;line-height:1;cursor:pointer;
    display:inline-flex;align-items:center;justify-content:center}
  .df-zoom button:hover{background:var(--df-surface);color:var(--df-ink)}
  .df-zoom .df-zoom-v{min-width:38px;font-size:12px}

  /* ---------------------------------------------------------------- 靶标下拉 */
  .df-target{position:relative;display:flex;min-width:0;max-width:340px}
  /* 靶标是「我在哪」，但不需要做成一颗实心胶囊：顶栏的胶囊已经够多了。
     改成扁平入口 —— 悬停浮出底色、打开时才有底，靠前置图标区分层级。 */
  .df-target-btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 8px;max-width:100%;min-width:0;
    border:0;border-radius:var(--df-r-sm);background:transparent;color:var(--df-ink);
    font-size:13px;font-weight:500;line-height:1;cursor:pointer;transition:background .15s}
  .df-target-btn:hover{background:var(--df-hover)}
  .df-target-btn.is-open{background:var(--df-fill);box-shadow:0 0 0 2px var(--df-accent-soft)}
  .df-target-btn>svg:first-child{color:var(--df-accent)}
  .df-target-btn>svg:last-child{opacity:.5}
  .df-target-name{min-width:0;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
  .df-target-meta{font-size:12px;color:var(--df-sub);white-space:nowrap;font-variant-numeric:tabular-nums}
  .df-menu{position:absolute;left:0;top:calc(100% + 6px);z-index:40;width:352px;max-width:min(420px,86vw);
    background:var(--df-surface);border:1px solid var(--df-line);border-radius:var(--df-r);box-shadow:var(--df-shadow-2);
    padding:6px;animation:df-pop .16s cubic-bezier(.2,.7,.3,1)}
  .df-menu-hd{display:flex;align-items:center;gap:7px;padding:5px 8px 7px;font-size:12px;font-weight:650;
    color:var(--df-sub);letter-spacing:.04em}
  .df-menu-list{max-height:300px;overflow:auto;display:flex;flex-direction:column;gap:1px}
  .df-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:7px 8px;border:0;border-radius:var(--df-r-sm);
    background:transparent;color:var(--df-ink);text-align:left;cursor:pointer;font:inherit}
  .df-menu-item:hover{background:var(--df-hover)}
  .df-menu-item.on{background:var(--df-sel)}
  .df-menu-item .df-mi-ico{width:18px;flex:none;display:flex;align-items:center;justify-content:center;color:var(--df-faint)}
  .df-menu-item.on .df-mi-ico{color:var(--df-ink)}
.df-menu-item.is-broken .df-mi-side{color:var(--df-warn)}
  .df-menu-item .df-mi-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
  .df-menu-item .df-mi-main b{font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-menu-item .df-mi-main span{font-size:12px;color:var(--df-sub);font-variant-numeric:tabular-nums}
  .df-menu-item .df-mi-side{font-size:12px;color:var(--df-sub);flex:none}
  .df-menu-empty{padding:18px 10px;text-align:center;font-size:13px;color:var(--df-sub)}
  .df-menu-ft{display:flex;align-items:center;gap:6px;padding:7px 6px 3px;margin-top:4px;
    border-top:1px solid var(--df-line-soft)}
  .df-menu-form{display:flex;flex-direction:column;gap:9px;padding:2px 4px 3px}
  .df-menu-warn{display:flex;flex-direction:column;gap:2px;padding:8px 9px;border-radius:var(--df-r-sm);
    background:var(--df-err-soft);color:var(--df-err);font-size:13px;line-height:1.55}
  .df-menu-warn b{font-size:14px}
  .df-menu-note{padding:7px 9px;border-radius:var(--df-r-sm);background:var(--df-surface-2);color:var(--df-sub);
    font-size:13px;line-height:1.55}
  .df-menu-note.is-err{background:var(--df-err-soft);color:var(--df-err)}
  .df-menu-note.is-warn{background:var(--df-warn-soft);color:var(--df-warn)}
  .df-del-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
  .df-del-cell{display:flex;flex-direction:column;align-items:center;gap:1px;padding:7px 4px;
    border:1px solid var(--df-line-soft);border-radius:var(--df-r-sm);background:var(--df-surface-2)}
  .df-del-cell b{font-size:17px;font-variant-numeric:tabular-nums}
  .df-del-cell span{font-size:12px;color:var(--df-sub)}

  .df-cwdrow{cursor:pointer;padding:6px 8px;gap:9px}
  .df-cwdrow input{flex:none;width:14px;height:14px;accent-color:var(--df-accent)}
  .df-cwdrow .df-ri-main{display:flex;flex-direction:column;gap:1px;white-space:normal;overflow:hidden}
  .df-cwdrow b{font-size:13px;font-weight:600}
  .df-cwdrow small{font-size:12px;color:var(--df-sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-btnrow{display:flex;align-items:center;gap:6px;flex:none}

  /* ---------------------------------------------------------------- 抽屉 / 空白 */
  .dfx-side{position:relative;overflow:hidden;gap:0;container-type:inline-size}
  /* 抽屉窄时表单改单列：两列会把输入框压到只剩几十像素。 */
  @container (max-width: 430px){
    .df-formgrid{grid-template-columns:1fr}
    .df-formgrid .df-field--wide{grid-column:auto}
  }
  /* 抽屉必须恰好填满侧栏：否则内容会顶出去、滚动条被侧栏的 overflow:hidden 吃掉。 */
  .dfx-side>.df-drawer{flex:1;min-height:0;height:auto}
  .dfx-side-grip{position:absolute;left:-3px;top:0;bottom:0;width:7px;cursor:ew-resize;z-index:3}
  .dfx-side-grip:hover{background:var(--df-accent-soft)}
  .df-blank{flex:1;display:flex;align-items:center;justify-content:center;min-height:280px}
  .df-blank .df-empty{padding:20px}
  .df-cmd-none{padding:18px 10px;text-align:center;font-size:13px;color:var(--df-sub)}
  .df-cmd .df-cmd-in .df-cmd-esc{flex:none}

  /* ---------------------------------------------------------------- 智能体 */
  .df-agents-set{display:flex;align-items:flex-end;gap:18px;padding:4px 14px 14px;flex-wrap:wrap}
  .df-agents-slider{flex:1;min-width:220px;display:flex;flex-direction:column;gap:5px}
  .df-agents-slider input[type="range"]{width:100%;accent-color:var(--df-accent);cursor:pointer}
  .df-agents-scale{display:flex;justify-content:space-between;font-size:12px;color:var(--df-sub)}
  .df-agents-num{display:flex;align-items:center;gap:6px}
  .df-agents-num .df-input{width:86px}

  /* ---------------------------------------------------------------- 按钮 */
  .df-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;
    border:1px solid var(--df-line-soft);border-radius:var(--df-r-sm);background:var(--df-surface);color:var(--df-ink);
    font-size:14px;font-weight:560;line-height:1;cursor:pointer;white-space:nowrap;
    transition:background .15s,border-color .15s,color .15s,transform .1s}
  .df-btn:hover{background:var(--df-hover)}
  .df-btn:active{transform:translateY(.5px)}
  .df-btn[disabled]{opacity:.45;cursor:not-allowed;transform:none}
  .df-btn--sm{height:26px;padding:0 9px;font-size:13px}
  .df-btn--lg{height:34px;padding:0 16px;font-size:15px}
  .df-btn--icon{width:30px;padding:0}
  .df-btn--primary{background:var(--df-accent);border-color:var(--df-accent);color:var(--df-ink-inv);font-weight:600;
    box-shadow:0 1px 2px rgba(0,122,255,.24)}
  .df-btn--primary:hover{background:var(--df-accent-hover);border-color:var(--df-accent-hover)}
  .df-btn--ghost{background:transparent;border-color:transparent;color:var(--df-sub)}
  .df-btn--ghost:hover{background:var(--df-hover);color:var(--df-ink);border-color:transparent}
  .df-btn--danger{color:var(--df-err);border-color:color-mix(in srgb,var(--df-err) 35%,var(--df-line))}
  .df-btn--danger:hover{background:var(--df-err-soft)}
  .df-btn--solid-danger{background:var(--df-err-solid);border-color:var(--df-err-solid);color:#fff}
  .df-btn--solid-danger:hover{background:color-mix(in srgb,var(--df-err-solid) 86%,#000)}

  /* ---------------------------------------------------------------- 表单 */
  .df-input,.df-select,.df-area{width:100%;border:1px solid transparent;border-radius:var(--df-r-sm);
    background:var(--df-surface-2);color:var(--df-ink);font-size:14px;line-height:1.4;padding:0 11px;height:32px;min-width:0;
    transition:border-color .15s,box-shadow .15s,background .15s}
  .df-area{height:auto;min-height:120px;padding:9px 11px;resize:vertical;line-height:1.65}
  /* 短清单（一行一个目录）按 rows 走，别被 120px 的下限撑成一大块空框。 */
  .df-area--list{min-height:0;height:64px}
  .df-input::placeholder,.df-area::placeholder{color:var(--df-faint)}
  .df-input:focus,.df-select:focus,.df-area:focus{outline:none;background:var(--df-surface);border-color:var(--df-accent);
    box-shadow:0 0 0 3px var(--df-accent-soft)}
  .df-input--sm{height:26px;font-size:13px}
  .df-search{position:relative;display:flex;align-items:center;min-width:180px}
  .df-search .df-search-ico{position:absolute;left:8px;color:var(--df-faint);pointer-events:none}
  .df-search .df-input{padding-left:28px;padding-right:26px}
  /* 用自绘的清空按钮，隐藏 WebKit 原生那个，避免叠两个 ×。 */
  .df-search .df-input::-webkit-search-cancel-button,
  .df-search .df-input::-ms-clear{display:none}
  .df-search .df-search-clear{position:absolute;right:4px;border:0;background:transparent;color:var(--df-faint);
    width:20px;height:20px;border-radius:var(--df-r-xs);cursor:pointer;display:flex;align-items:center;justify-content:center}
  .df-search .df-search-clear:hover{background:var(--df-hover);color:var(--df-ink)}
  .df-field{display:flex;flex-direction:column;gap:5px;min-width:0}
  .df-field>label,.df-label{font-size:13px;font-weight:600;color:var(--df-sub);letter-spacing:.01em}
  .df-field .df-hint{font-size:var(--df-t-meta);color:var(--df-sub);line-height:1.5}
  /* 表单校验：出错时输入框描红、提示行跟着变红；归一化/范围过大这类「不是错」的说明压暗一档。 */
  .df-field .df-hint.is-err{color:var(--df-err)}
  .df-field .df-hint .df-hint-sub{color:var(--df-faint)}
  .df-input.is-err{border-color:var(--df-err)}
  .df-input.is-err:focus{box-shadow:0 0 0 2px var(--df-err-soft)}
  .df-switch{position:relative;display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:14px}
  .df-switch input{position:absolute;opacity:0;width:0;height:0}
  .df-switch i{width:34px;height:20px;border-radius:999px;background:var(--df-surface-2);border:1px solid var(--df-line);
    position:relative;transition:background .16s,border-color .16s;flex:none}
  .df-switch i:after{content:"";position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;
    background:var(--df-surface);box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .16s}
  .df-switch input:checked+i{background:var(--df-accent);border-color:var(--df-accent)}
  .df-switch input:checked+i:after{transform:translateX(14px);background:var(--df-ink-inv)}

  /* ---------------------------------------------------------------- 胶囊 / 徽标 */
  .df-chip{display:inline-flex;align-items:center;gap:5px;height:23px;padding:0 9px;border-radius:999px;
    font-size:13px;font-weight:600;letter-spacing:.01em;white-space:nowrap;background:var(--df-surface-2);
    color:var(--df-sub);border:1px solid transparent}
  .df-chip .df-dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
  .df-chip--ok{background:var(--df-ok-soft);color:var(--df-ok)}
  .df-chip--warn{background:var(--df-warn-soft);color:var(--df-warn)}
  .df-chip--err{background:var(--df-err-soft);color:var(--df-err)}
  .df-chip--info{background:var(--df-info-soft);color:var(--df-info)}
  .df-chip--line{background:transparent;border-color:var(--df-line);color:var(--df-sub)}
  .df-count{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;
    border-radius:999px;background:var(--df-surface-2);color:var(--df-sub);font-size:12px;font-weight:650;
    font-variant-numeric:tabular-nums}

  /* ---------------------------------------------------------------- 卡片 / KPI */
  .df-card{background:var(--df-surface);border:1px solid var(--df-line-soft);border-radius:var(--df-r-lg);min-width:0;
    box-shadow:var(--df-shadow-1);overflow:hidden}
  .df-card-hd{display:flex;align-items:center;gap:8px;padding:14px 18px;border-bottom:1px solid var(--df-line-soft);min-height:50px}
  .df-card-hd b{font-size:var(--df-t-card);font-weight:650;letter-spacing:normal;white-space:nowrap;flex:none}
  .df-card-hd .df-sub{font-size:13px;color:var(--df-sub);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-card-hd .df-spacer{margin-left:auto}
  .df-card-hd>.df-opsbar{flex:0 1 auto;flex-wrap:wrap;justify-content:flex-end;row-gap:6px;min-width:0}
  .df-card-bd{padding:10px 8px}
  .df-card-bd--pad{padding:16px}
  .df-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:12px}
  .df-kpi{position:relative;background:var(--df-surface);border:1px solid var(--df-line-soft);border-radius:var(--df-r-lg);
    padding:14px 16px 12px;overflow:hidden;min-width:0;box-shadow:var(--df-shadow-1)}
  .df-kpi .df-kpi-l{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:var(--df-sub);
    letter-spacing:.01em}
  .df-kpi .df-kpi-v{margin-top:6px;font-size:var(--df-t-num);font-weight:700;letter-spacing:-.03em;
    font-variant-numeric:tabular-nums;line-height:1.1}
  .df-kpi .df-kpi-v small{font-size:13px;font-weight:500;color:var(--df-sub);margin-left:4px;letter-spacing:0}
  .df-kpi .df-kpi-f{font-size:13px;color:var(--df-sub);margin-top:4px;
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
  .df-kpi .df-spark{position:absolute;right:12px;bottom:10px;display:flex;align-items:flex-end;gap:2px;height:22px;opacity:.85}
  .df-kpi .df-spark i{width:3px;border-radius:999px;background:var(--df-accent);opacity:.35}
  .df-kpi .df-spark i:last-child{opacity:.9}
  .df-kpi--accent{background:linear-gradient(160deg,var(--df-accent-soft),transparent 66%),var(--df-surface)}

  /* ---------------------------------------------------------------- 横向状态带 */
  /* 一排数字装在同一张白卡里：首屏依然是一整块白，切页明暗连续。
     窄了就自动折行，每条自带左侧分隔线，不靠外面切格子。 */
  .df-statsbar{display:flex;flex-wrap:wrap;background:var(--df-surface);border:1px solid var(--df-line-soft);
    border-radius:var(--df-r-lg);box-shadow:var(--df-shadow-1);padding:4px 0;overflow:hidden}
  /* 数字和标签同一行：数字大、标签跟在后头当说明，副行垫底。
     一条带子压到两行高，切页时首屏重心不上移。 */
  .df-stat{flex:1 1 168px;min-width:0;padding:8px 16px;position:relative;display:flex;flex-direction:column;justify-content:center;gap:0}
  .df-stat+.df-stat::before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:1px;background:var(--df-line-soft)}
  .df-stat-l{display:flex;align-items:center;gap:5px;font-size:13px;font-weight:500;color:var(--df-sub);
    white-space:nowrap;order:2}
  .df-stat-l svg{flex:none;opacity:.75}
  .df-stat-v{font-size:var(--df-t-num);font-weight:700;letter-spacing:-.03em;line-height:1.2;order:1;display:inline-flex;
    align-items:baseline;flex-wrap:wrap;row-gap:0;font-variant-numeric:tabular-nums;color:var(--df-ink)}
  .df-stat-v small{font-size:13px;font-weight:500;color:var(--df-sub);letter-spacing:0}
  .df-stat-f{font-size:var(--df-t-meta);font-weight:500;color:var(--df-sub);white-space:nowrap;overflow:hidden;
    text-overflow:ellipsis;margin-left:10px;opacity:.8}
  .df-stat--accent .df-stat-v{color:var(--df-accent)}
  @container (max-width:560px){
    .df-stat{flex-basis:50%}
    .df-stat+.df-stat::before{display:none}
  }

  /* ---------------------------------------------------------------- 表格 */
  .df-table{width:100%;border-collapse:separate;border-spacing:0;font-size:var(--df-t-body)}
  /* 主区表格给个下限：列被压到几十像素时还不如横向滚动。抽屉里的表格不适用。 */
  .dfx-main .df-table{min-width:560px}
  .df-table th{position:sticky;top:0;z-index:2;background:var(--df-surface);text-align:left;font-size:13px;
    font-weight:600;color:var(--df-sub);letter-spacing:.02em;padding:0 12px;height:38px;white-space:nowrap;
    border-bottom:1px solid var(--df-line-soft)}
  .df-table th.df-sortable{cursor:pointer;user-select:none}
  .df-table th.df-sortable:hover{color:var(--df-ink)}
  .df-table th .df-sortico{display:inline-flex;vertical-align:-2px;margin-left:3px;opacity:.5}
  .df-table th.df-sorted .df-sortico{opacity:1;color:var(--df-accent)}
  .df-table td{padding:0 12px;height:var(--df-row);border-bottom:1px solid var(--df-line-soft);vertical-align:middle}
  /* 身份列（资产 IP、技能名、URL…）加重一档，让表格有一列主信息。
     注意：**不要加负的小数字距**（-0.01em 这类）——Windows 上字形会落到非整数像素位，
     灰度抗锯齿把笔画摊开，看起来就是「糊」。实测漏洞清单里字距是 normal，所以显清晰。 */
  .df-table td:first-child{font-size:var(--df-t-row);font-weight:560;letter-spacing:normal}
  .df-table tbody tr{transition:background .12s}
  .df-table tbody tr:hover{background:var(--df-hover)}
  .df-table tbody tr.df-row--sel{background:var(--df-sel)}
  .df-table tbody tr.df-row--click{cursor:pointer}
  .df-table tbody tr.df-row--click:focus-visible{outline:2px solid var(--df-accent);outline-offset:-2px}
  .df-table tbody tr:last-child td{border-bottom:0}
  .df-table .df-num{font-variant-numeric:tabular-nums;color:var(--df-sub);white-space:nowrap}
  .df-table .df-nm{font-weight:560}
  /* 维护页补丁表：主行中文名，副行一句人话。两行都要能省略，不然窄窗撑破表格。
     注意 td.df-ellip>* 会把直接子元素强制 display:block，这里用更高特异性改回 flex。 */
  .df-table td.df-ellip>span.df-pname{display:flex;flex-direction:column;gap:1px;min-width:0;max-width:100%}
  .df-table .df-pname.is-off{opacity:.55}
  .df-table .df-pname-core{display:inline-block;margin-left:6px;padding:0 4px;border-radius:4px;font-style:normal;font-size:9px;line-height:14px;font-weight:700;letter-spacing:.04em;vertical-align:1px;
    background:var(--df-accent-soft);color:var(--df-accent);
    box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--df-accent) 32%,transparent)}
  /* 核心补丁整行加重：左侧色条 + 淡底，滚动时一眼能找到。 */
  .df-table tbody tr.df-row--core{background:color-mix(in srgb,var(--df-accent-soft) 55%,var(--df-surface))}
  .df-table tbody tr.df-row--core td:first-child{box-shadow:inset 3px 0 0 var(--df-accent)}
  .df-table tbody tr.df-row--core:hover{background:color-mix(in srgb,var(--df-accent-soft) 80%,var(--df-surface))}
  /* 补丁标签：核心最重，其它按语义色轻量显示。 */
  .df-ptags{display:flex;align-items:center;gap:3px;flex-wrap:wrap}
  .df-ptag{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:5px;
    font-size:10px;line-height:1;font-weight:600;letter-spacing:.02em;white-space:nowrap;
    background:var(--df-surface-2);color:var(--df-sub)}
  .df-ptag--core{background:var(--df-accent-soft);color:var(--df-accent);font-weight:750;
    box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--df-accent) 32%,transparent)}
  .df-ptag--info{background:var(--df-info-soft);color:var(--df-info)}
  .df-ptag--warn{background:var(--df-warn-soft);color:var(--df-warn)}
  .df-ptag--ok{background:var(--df-ok-soft);color:var(--df-ok)}
  /* 表格里的开关缩一号：默认 34×20 在 42px 行高里太抢眼。 */
  .df-table .df-switch--sm i{width:28px;height:16px}
  .df-table .df-switch--sm i:after{width:12px;height:12px;top:1px;left:1px}
  .df-table .df-switch--sm input:checked+i:after{transform:translateX(12px)}
  .df-table .df-switch--sm.is-busy{opacity:.5;pointer-events:none}
  .df-table .df-switch--sm.is-confirm i{border-color:var(--df-warn);box-shadow:0 0 0 3px var(--df-warn-soft)}
  .df-table .df-pname b{font-size:12.5px;font-weight:620;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .df-table .df-pname small{font-size:10.5px;line-height:1.35;font-weight:400;color:var(--df-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  /* 表格里的等宽（IP / URL / 路径）跟正文同字号：等宽体本身字面窄，
     再压到 13px 就会显得比旁边的正文小一号、也发虚。 */
  .df-table .df-mono{font-family:var(--df-mono);font-size:var(--df-t-body);letter-spacing:normal}
  .df-table .df-tight{width:1%;white-space:nowrap}
  .df-table--compact td{height:32px}
  .df-table--cozy td{height:40px}
  .df-table .df-ellip{max-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  /* 固定布局：列的百分比宽度真的按表格宽度算，不会因为某列内容长就把表撑出卡片。
     单元格里的内容要自己省略（td.df-ellip>* 或 .df-dvc-t 这类）。 */
  .df-table--fixed{table-layout:fixed}
  /* 省略列里的内容常包一层 span（等宽路径、带图标的单元）。td 上的 ellipsis
     管不到子元素，窄窗时会把整张表顶宽、右侧被卡片裁掉；让子元素自己在格子里截断。 */
  .df-table td.df-ellip>*{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

  /* ---------------------------------------------------------------- 覆盖矩阵
     格子是「状态」不是按钮：只用一个彩点 + 文字，不填底色、不加 hover 放大。
     要动数据得点整行去资产页补测，行尾的 › 就是这个入口。 */
  .df-mxbox{display:flex;flex-direction:column;gap:8px;padding:0 6px 4px}
  .df-mx-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:2px 8px 0}
  .df-mx-legend{display:flex;align-items:center;gap:14px;font-size:12.5px;color:var(--df-sub);flex-wrap:wrap;row-gap:4px}
  .df-mx-lg{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
  .df-mx-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--df-faint)}
  .df-mx-dot--tested{background:var(--df-ok-solid)}
  .df-mx-dot--clean{background:var(--df-faint)}
  .df-mx-dot--skipped{background:var(--df-warn-solid)}
  .df-mx-dot--untested{background:transparent;border:1.5px dashed var(--df-faint);width:7px;height:7px}
  .df-mx-tools{margin-left:auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .df-mx-note{font-size:12.5px;color:var(--df-faint);padding:0 10px}
  .df-mxwrap{overflow:auto;max-height:min(56vh,520px);border-radius:var(--df-r)}
  .df-mx{width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed}
  .df-mx th{font-weight:600;text-align:center;padding:9px 2px 10px;vertical-align:bottom;background:transparent}
  .df-mx th.df-mx-an{text-align:left;padding-left:12px;width:23%}
  .df-mx .df-mx-l{display:block;font-size:13px;font-weight:650;color:var(--df-ink);white-space:nowrap}
  .df-mx .df-mx-h{display:block;font-size:11.5px;font-weight:500;color:var(--df-faint);margin-top:2px;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .df-mx td{height:44px;padding:0 4px;border-bottom:1px solid var(--df-line-soft)}
  .df-mx tbody tr:last-child td{border-bottom:0}
  .df-mx tbody tr{transition:background .12s}
  .df-mx tbody tr:hover{background:var(--df-hover)}
  .df-mx tbody tr.df-row--click{cursor:pointer}
  .df-mx td.df-mx-an{padding-left:12px;padding-right:8px}
  .df-mx .df-mx-aip{font-family:var(--df-mono);font-size:15px;font-weight:600;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .df-mx .df-mx-sub{font-size:13px;color:var(--df-sub);margin-top:1px;white-space:nowrap;
    overflow:hidden;text-overflow:ellipsis}
  /* 「差 N 类」单独一段，不是 done 时橙色，让缺口一眼跳出来。 */
  .df-mx .df-mx-gap{font-weight:650}
  .df-mx .df-mx-gap--all{color:var(--df-err)}
  .df-mx .df-mx-gap--some{color:var(--df-warn)}
  .df-mx .df-cell{display:flex;align-items:center;justify-content:center;gap:6px;height:44px;
    font-size:14px;font-weight:550;color:var(--df-sub);white-space:nowrap}
  .df-mx .df-cell i{width:7px;height:7px;border-radius:50%;flex:none}
  .df-mx .df-cell--tested i{background:var(--df-ok-solid)}
  .df-mx .df-cell--clean i{background:var(--df-faint)}
  .df-mx .df-cell--blocked i,.df-mx .df-cell--skipped i{background:var(--df-warn-solid)}
  .df-mx .df-cell--untested{color:var(--df-faint)}
  .df-mx .df-cell--untested i{background:transparent;border:1.5px dashed var(--df-faint);width:6px;height:6px}
  .df-mx th.df-mx-th{white-space:nowrap;padding-left:2px;padding-right:2px}
  .df-mx td.df-mx-go{width:20px;text-align:right;padding-right:6px;color:var(--df-faint);font-size:16px;font-weight:600}
  .df-mx tbody tr:hover td.df-mx-go{color:var(--df-accent)}

  /* ---------------------------------------------------------------- 列表 / 时间线 */
  .df-rows{display:flex;flex-direction:column}
  .df-rowitem{display:flex;align-items:center;gap:10px;min-height:38px;padding:5px 8px;border-radius:var(--df-r-sm);
    border-bottom:1px solid var(--df-line-soft);font-size:14px;transition:background .12s}
  .df-rowitem:last-child{border-bottom:0}
  .df-rowitem:hover{background:var(--df-hover)}
  .df-rowitem--click{cursor:pointer}
  .df-rowitem .df-ri-main{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-rowitem .df-ri-side{flex:none;font-size:13px;color:var(--df-sub);font-variant-numeric:tabular-nums}
  .df-ri-bar{width:3px;height:22px;border-radius:999px;background:var(--df-line);flex:none}
  .df-ri-bar--err{background:var(--df-err)} .df-ri-bar--warn{background:var(--df-warn)}
  .df-ri-bar--ok{background:var(--df-ok)} .df-ri-bar--info{background:var(--df-info)}

  .df-tl{position:relative;padding-left:18px}
  .df-tl:before{content:"";position:absolute;left:5px;top:6px;bottom:6px;width:1.5px;background:var(--df-line)}
  .df-tl-item{position:relative;padding:7px 0 9px;cursor:pointer}
  .df-tl-item:before{content:"";position:absolute;left:-17px;top:13px;width:9px;height:9px;border-radius:50%;
    background:var(--df-surface);border:2px solid var(--df-line);transition:border-color .15s}
  .df-tl-item:hover:before{border-color:var(--df-accent)}
  .df-tl-item--ok:before{border-color:var(--df-ok)}
  .df-tl-item--err:before{border-color:var(--df-err)}
  .df-tl-item--warn:before{border-color:var(--df-warn)}
  .df-tl-item .df-tl-h{display:flex;align-items:center;gap:8px;font-size:var(--df-t-row);font-weight:600}
  .df-tl-item .df-tl-d{font-size:13px;color:var(--df-sub);margin-top:1px}
  .df-tl-item .df-tl-t{font-size:var(--df-t-meta);color:var(--df-sub);font-variant-numeric:tabular-nums;flex:none;margin-left:auto}

  /* ---------------------------------------------------------------- 空 / 骨架 / 加载 */
  .df-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;
    padding:34px 20px;text-align:center;color:var(--df-sub)}
  .df-empty .df-empty-ico{width:34px;height:34px;border-radius:var(--df-r-sm);display:flex;align-items:center;justify-content:center;
    background:var(--df-surface-2);color:var(--df-faint)}
  .df-empty b{font-size:14px;font-weight:600;color:var(--df-ink)}
  .df-empty span{font-size:13px;color:var(--df-sub);max-width:360px;line-height:1.6}
  .df-skel{background:var(--df-surface-2);border-radius:var(--df-r-xs)}
  .df-skel--line{height:12px;margin:6px 0}
  /* 切页那一瞬的占位：三个静态小点，安静但不至于一屏全空。
     刻意不做呼吸动画 —— 这段占位只活几十毫秒，动画刚起就被内容顶掉，
     眼睛收到的是「有个东西动了一下又没了」，反而像闪。切页里不放任何正在动的东西。 */
  .df-inline-wait{display:flex;align-items:center;justify-content:center;gap:6px;min-height:160px}
  .df-inline-wait i{width:6px;height:6px;border-radius:50%;background:var(--df-faint);opacity:.3}
  /* 等得久的加载态：一个图标 + 主句 + 说明，跟「空状态」同一套骨架，不闪。 */
  .df-wait{min-height:190px;display:flex;flex-direction:column;align-items:center;justify-content:center;
    gap:6px;text-align:center;padding:28px 20px}
  .df-wait-badge{width:38px;height:38px;border-radius:11px;display:flex;align-items:center;justify-content:center;
    background:var(--df-surface-2);color:var(--df-sub);margin-bottom:4px}
  .df-wait p{margin:0;font-size:14px;font-weight:600;color:var(--df-ink)}
  .df-wait span{font-size:13px;color:var(--df-sub);line-height:1.6;max-width:320px}
  /* 切页时上一帧留在原位（不重新挂载、不卸 DOM），只逐出交互与过渡，
     等新视图数据回来再整体换掉 —— 避免「空白 → 骨架 → 内容」三道闪。 */
  .df-keepalive{transition:none !important}
  .df-keepalive *{animation:none !important;transition:none !important}
  .df-keepalive[aria-hidden="true"]{pointer-events:none !important;user-select:none}
  .df-keepalive[aria-hidden="true"] a,.df-keepalive[aria-hidden="true"] button,
  .df-keepalive[aria-hidden="true"] input,.df-keepalive[aria-hidden="true"] select{pointer-events:none !important}
  .df-spin{width:14px;height:14px;border-radius:50%;border:2px solid color-mix(in srgb,var(--df-ink) 16%,transparent);
    border-top-color:var(--df-accent);animation:df-spin .7s linear infinite;flex:none}
  @keyframes df-spin{to{transform:rotate(360deg)}}

  /* ---------------------------------------------------------------- 分段 / 标签页 */
  .df-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;background:var(--df-surface-2);border-radius:var(--df-r-sm)}
  .df-seg button{height:28px;padding:0 11px;border:0;border-radius:8px;background:transparent;color:var(--df-sub);
    font-size:13px;font-weight:500;line-height:1;cursor:pointer;white-space:nowrap;transition:background .14s,color .14s}
  .df-seg button:hover{color:var(--df-ink)}
  .df-seg button.on{background:var(--df-surface);color:var(--df-ink);font-weight:600;box-shadow:var(--df-shadow-1)}
  .df-tabs{display:flex;align-items:center;gap:2px;border-bottom:1px solid var(--df-line);padding:0 4px}
  .df-tab{position:relative;height:34px;padding:0 11px;border:0;background:transparent;color:var(--df-sub);
    font-size:14px;font-weight:500;line-height:1;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
  .df-tab:hover{color:var(--df-ink)}
  .df-tab.on{color:var(--df-ink);font-weight:600}
  .df-tab.on:after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;border-radius:999px;background:var(--df-accent)}

  /* ---------------------------------------------------------------- 抽屉 */
  .df-drawer{display:flex;flex-direction:column;min-height:0;height:100%}
  .df-drawer-hd{display:flex;align-items:flex-start;gap:8px;padding:0 0 10px;border-bottom:1px solid var(--df-line-soft)}
  .df-drawer-hd .df-drawer-t{flex:1;min-width:0}
  .df-drawer-hd b{display:block;font-size:15px;font-weight:650;word-break:break-all;line-height:1.4}
  .df-drawer-hd .df-sub{font-size:13px;color:var(--df-sub);margin-top:2px}
  .df-drawer-bd{flex:1;overflow:auto;padding:12px 0 4px;display:flex;flex-direction:column;gap:12px}
  /* 抽屉里只保留一层滚动：正文块跟随内容展开，别再套内部滚动条。 */
  .df-drawer .df-code{max-height:none}
  .df-kv{display:grid;grid-template-columns:76px minmax(0,1fr);gap:7px 10px;font-size:14px}
  .df-kv dt{color:var(--df-sub);font-size:13px;line-height:1.6}
  .df-kv dd{margin:0;word-break:break-word;line-height:1.6}
  .df-code{font-family:var(--df-mono);font-size:13px;line-height:1.65;background:var(--df-surface-2);
    color:var(--df-ink);border:1px solid var(--df-line-soft);border-radius:var(--df-r-sm);padding:9px 10px;
    white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto}
  .df-copy{display:inline-flex;align-items:center;gap:4px;border:0;background:transparent;color:var(--df-sub);
    font:inherit;font-size:12px;cursor:pointer;padding:2px 4px;border-radius:var(--df-r-xs)}
  .df-copy:hover{background:var(--df-hover);color:var(--df-ink)}

  /* ---------------------------------------------------------------- Toast */
  .df-toasts{position:absolute;right:16px;bottom:16px;z-index:20;display:flex;flex-direction:column;gap:8px;
    pointer-events:none;max-width:380px}
  .df-toast{display:flex;align-items:flex-start;gap:8px;padding:9px 12px;border-radius:var(--df-r);background:var(--df-surface);
    border:1px solid var(--df-line);box-shadow:var(--df-shadow-2);font-size:14px;color:var(--df-ink);
    pointer-events:auto;animation:df-toast-in .18s cubic-bezier(.2,.7,.3,1)}
  .df-toast .df-toast-i{flex:none;margin-top:1px}
  .df-toast--ok .df-toast-i{color:var(--df-ok)}
  .df-toast--err .df-toast-i{color:var(--df-err)}
  .df-toast--info .df-toast-i{color:var(--df-info)}
  @keyframes df-toast-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}

  /* ---------------------------------------------------------------- 命令面板 */
  .df-cmd-mask{position:absolute;inset:0;z-index:30;background:var(--df-mask);
    display:flex;align-items:flex-start;justify-content:center;padding-top:12vh;animation:df-fade .14s ease}
  @keyframes df-fade{from{opacity:0}to{opacity:1}}
  .df-cmd{width:min(520px,86%);background:var(--df-surface);border:1px solid var(--df-line);border-radius:var(--df-r-lg);
    box-shadow:var(--df-shadow-2);overflow:hidden;animation:df-pop .18s cubic-bezier(.2,.7,.3,1)}
  @keyframes df-pop{from{opacity:0;transform:translateY(-6px) scale(.99)}to{opacity:1;transform:none}}
  .df-cmd .df-cmd-in{display:flex;align-items:center;gap:8px;padding:10px 13px;border-bottom:1px solid var(--df-line-soft)}
  .df-cmd .df-cmd-in input{flex:1;border:0;background:transparent;color:var(--df-ink);font-size:15px;line-height:1.4;outline:none}
  .df-cmd .df-cmd-list{max-height:320px;overflow:auto;padding:6px}
  .df-cmd .df-cmd-item{display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:var(--df-r-sm);font-size:14px;
    color:var(--df-ink);cursor:pointer}
  .df-cmd .df-cmd-item .df-cmd-k{margin-left:auto;font-size:12px;color:var(--df-sub);font-family:var(--df-mono)}
  .df-cmd .df-cmd-item.on,.df-cmd .df-cmd-item:hover{background:var(--df-sel)}

  /* ---------------------------------------------------------------- 兼容旧视图 */
  .dfx-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
  .dfx-kpi{background:var(--df-surface);border:1px solid var(--df-line);border-radius:var(--df-r);
    padding:11px 13px}
  .dfx-kpi .v{font-size:var(--df-t-num);font-weight:650;font-variant-numeric:tabular-nums;line-height:1.15}
  .dfx-kpi .l{font-size:13px;font-weight:600;color:var(--df-sub);margin-top:2px}
  .dfx-card{background:var(--df-surface);border:1px solid var(--df-line);border-radius:var(--df-r);
    padding:6px 8px;min-width:0}
  .dfx-sect{display:flex;align-items:baseline;gap:8px;margin:4px 0 -4px}
  .dfx-sect b{font-size:14px;font-weight:650}
  .dfx-sect span{font-size:13px;color:var(--df-sub)}
  .dfx-table{width:100%;border-collapse:separate;border-spacing:0;font-size:14px}
  .dfx-table th{text-align:left;font-size:12px;font-weight:600;color:var(--df-sub);letter-spacing:.03em;
    padding:8px 10px;border-bottom:1px solid var(--df-line);white-space:nowrap}
  .dfx-table td{padding:8px 10px;border-bottom:1px solid var(--df-line-soft);height:var(--df-row)}
  .dfx-table tbody tr{transition:background .12s}
  .dfx-table tbody tr:hover{background:var(--df-hover)}
  .dfx-table tbody tr:last-child td{border-bottom:0}
  .dfx-nm{font-weight:560}
  .dfx-num{font-variant-numeric:tabular-nums;color:var(--df-sub)}
  .dfx-sev{display:inline-flex;align-items:center;height:18px;font-size:12px;font-weight:700;padding:0 6px;
    border-radius:var(--df-r-xs);color:var(--df-ink-inv);letter-spacing:.02em}
  .dfx-sev.critical{background:var(--df-err)}
  .dfx-sev.high{background:color-mix(in srgb,var(--df-err) 62%,var(--df-warn))}
  .dfx-sev.medium{background:var(--df-warn)}
  .dfx-sev.low{background:var(--df-sub)}
  .dfx-sev.info{background:var(--df-info)}
  .dfx-st{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;padding:0 7px;height:20px;
    border-radius:999px;white-space:nowrap}
  .dfx-st i{width:5px;height:5px;border-radius:50%}
  .dfx-st.ok{color:var(--df-ok);background:var(--df-ok-soft)} .dfx-st.ok i{background:var(--df-ok)}
  .dfx-st.run{color:var(--df-info);background:var(--df-info-soft)} .dfx-st.run i{background:var(--df-info)}
  .dfx-st.blk{color:var(--df-warn);background:var(--df-warn-soft)} .dfx-st.blk i{background:var(--df-warn)}
  .dfx-st.idle{color:var(--df-sub);background:var(--df-surface-2)} .dfx-st.idle i{background:var(--df-sub)}
  .dfx-todo{display:flex;flex-direction:column;padding:2px 6px}
  .dfx-trow{display:flex;align-items:center;gap:9px;min-height:38px;padding:5px 2px;
    border-bottom:1px solid var(--df-line-soft);font-size:14px}
  .dfx-trow:last-child{border-bottom:0}
  .dfx-kind{font-size:12px;font-weight:600;color:var(--df-sub);border:1px solid var(--df-line);
    border-radius:var(--df-r-xs);padding:0 6px;flex:none;background:var(--df-surface-2);height:18px;display:inline-flex;align-items:center}
  .dfx-trow .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .dfx-trow .why{font-size:var(--df-t-meta);color:var(--df-sub);flex:none}
  .dfx-mx{width:100%;border-collapse:separate;border-spacing:3px;table-layout:fixed}
  .dfx-mx th{font-size:12px;font-weight:600;color:var(--df-sub);text-align:center;padding:0 0 3px}
  .dfx-mx th.an{text-align:left;padding-left:4px;width:34%}
  .dfx-mx td{text-align:center;padding:0;border:0}
  .dfx-mx td.an{text-align:left;font-size:13px;font-weight:560;padding:0 6px 0 4px;white-space:nowrap;
    overflow:hidden;text-overflow:ellipsis}
  .dfx-cell{display:flex;align-items:center;justify-content:center;height:28px;border-radius:var(--df-r-xs);
    font-size:12px;font-weight:650}
  .dfx-cell.tested{background:var(--df-ok-soft);color:var(--df-ok)}
  .dfx-cell.clean{background:var(--df-surface-2);color:var(--df-sub)}
  .dfx-cell.untested{background:transparent;color:var(--df-sub);border:1px dashed var(--df-line)}
  .dfx-cell.blocked,.dfx-cell.skipped{background:var(--df-warn-soft);color:var(--df-warn)}
  .dfx-note{font-size:13px;color:var(--df-sub);border:1px dashed var(--df-line);border-radius:var(--df-r-sm);
    padding:8px 10px;line-height:1.6;background:var(--df-surface)}
  .dfx-kv{display:grid;grid-template-columns:76px minmax(0,1fr);gap:7px 10px;font-size:14px}
  .dfx-kv dt{color:var(--df-sub);font-size:13px} .dfx-kv dd{margin:0;word-break:break-word}
  .dfx-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;
    padding:30px 18px;text-align:center;font-size:13px;color:var(--df-sub)}
  .dfx-path{position:relative;padding-left:16px}
  .dfx-path:before{content:"";position:absolute;left:4px;top:8px;bottom:8px;width:1.5px;background:var(--df-line)}
  .dfx-hop{position:relative;display:flex;gap:9px;align-items:flex-start;padding:7px 0;cursor:pointer}
  .dfx-hop:before{content:"";position:absolute;left:-15px;top:14px;width:9px;height:9px;border-radius:50%;
    background:var(--df-surface);border:2px solid var(--df-ok)}
  .dfx-stage{font-size:12px;font-weight:700;letter-spacing:.03em;padding:1px 6px;border-radius:var(--df-r-xs);
    background:var(--df-surface-2);color:var(--df-sub);flex:none;margin-top:1px}
  .dfx-hop .t{flex:1;min-width:0}
  .dfx-hop .h{font-size:14px;font-weight:560}
  .dfx-hop .s{font-size:13px;color:var(--df-sub);margin-top:1px}
  .dfx-btn{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;font-size:14px;
    border:1px solid var(--df-line);background:var(--df-surface);color:var(--df-ink);border-radius:var(--df-r-sm);cursor:pointer;
    font-weight:500;transition:background .15s,border-color .15s}
  .dfx-btn:hover{background:var(--df-hover)}
  .dfx-btn.primary{background:var(--df-accent);color:var(--df-ink-inv);border-color:var(--df-accent);font-weight:600}
  .dfx-code{font-family:var(--df-mono);font-size:13px;background:var(--df-surface-2);color:var(--df-ink);
    border:1px solid var(--df-line-soft);border-radius:var(--df-r-sm);padding:9px 10px;white-space:pre-wrap;word-break:break-word}

  /* ---------------------------------------------------------------- 作战视图 */
  .df-ops{display:flex;flex-direction:column;gap:14px;min-height:0;flex:none}
  .df-opsbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:32px}
  .df-ops-title{font-size:var(--df-t-page);font-weight:700;letter-spacing:normal}
  .df-ops-meta{font-size:13px;color:var(--df-sub);white-space:nowrap}
  /* 通用弹性占位：放在标题行 / 卡片头 / 页脚里，把后面的操作推到右侧。
     只在 flex 容器内生效，宽度为 0，靠 margin 吃掉剩余空间。 */
  .df-spacer{margin-left:auto}
  .df-ops-blank{display:flex;align-items:center;justify-content:center;min-height:260px}
  /* 概览三块：窄列放「下一步 / 最近作业」，宽列给覆盖矩阵。
     宽窄由主区自己的容器宽度决定（@container），与窗口缩放无关。 */
  .df-ov-cols{display:grid;grid-template-columns:minmax(300px,.82fr) minmax(0,1.55fr);gap:14px;align-items:start;
    grid-template-areas:"next matrix" "log matrix";grid-template-rows:min-content 1fr}
  .df-ov-next{grid-area:next}
  .df-ov-log{grid-area:log}
  .df-ov-mx{grid-area:matrix}
  @container (max-width: 900px){
    .df-ov-cols{grid-template-columns:1fr;grid-template-rows:auto auto auto;
      grid-template-areas:"next" "matrix" "log"}
  }
  .df-tablewrap{max-height:min(64vh,680px);overflow:auto;border-radius:var(--df-r)}
  .df-tablewrap--flat{max-height:240px;border:1px solid var(--df-line-soft)}
  .df-kpis--4{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
  .df-opsbar .df-select{width:auto;min-width:108px;flex:none}
  .df-opsbar .df-search{flex:0 1 260px}
  .df-note{padding:9px 12px;border-radius:var(--df-r-sm);background:var(--df-surface-2);border:1px solid var(--df-line-soft);
    color:var(--df-sub);font-size:13px;line-height:1.6}
  .df-note--warn{background:var(--df-warn-soft);border-color:var(--df-warn);color:var(--df-ink)}
  .df-maint{padding:12px 14px 14px}
  .df-maint .df-ops{gap:12px}
  .df-more{display:flex;justify-content:center;padding:10px 0 4px}
  /* 关于：三行「键—值—标签」，键弱值强，标签靠右收成弱色小字。 */
  .df-about{display:flex;flex-direction:column;gap:2px;margin-bottom:10px}
  .df-about-row{display:flex;align-items:baseline;gap:12px;padding:6px 0;font-size:13px;
    border-bottom:1px solid var(--df-line-soft)}
  .df-about-row:last-child{border-bottom:0}
  .df-about-row>span:first-child{width:56px;flex:none;color:var(--df-sub)}
  .df-about-row b{font-weight:600;color:var(--df-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-about-tag{margin-left:auto;flex:none;font-size:12px;color:var(--df-faint)}

  .df-asset{min-width:0}
  .df-asset-ip{font-family:var(--df-mono);font-size:var(--df-t-body);font-weight:650;letter-spacing:normal;line-height:1.35}
  /* 资产名下那行域名是列表里最常看的东西之一，不能是注释级别的字号。 */
  .df-asset-name{font-size:13.5px;color:var(--df-sub);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-portlist{display:flex;gap:4px;flex-wrap:wrap}
  .df-port{font-family:var(--df-mono);font-size:var(--df-t-meta);font-weight:600;line-height:1.7;padding:0 6px;border-radius:var(--df-r-xs);
    background:var(--df-surface-2);color:var(--df-sub);white-space:nowrap}
  .df-port--more{background:transparent;color:var(--df-sub);border:1px dashed var(--df-line)}

  .df-sev{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 9px 0 8px;border-radius:999px;
    font-size:12.5px;font-weight:700;letter-spacing:.02em;line-height:1;white-space:nowrap;
    background:var(--df-sev-low-bg);color:var(--df-sev-low-fg)}
  .df-sev i{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none;opacity:.9}
  /* 严重/高 = 实心，中/低 = 淡底：扫一眼先看到该先修的。 */
  .df-sev--critical{background:var(--df-sev-critical-bg);color:var(--df-sev-critical-fg)}
  .df-sev--high{background:var(--df-sev-high-bg);color:var(--df-sev-high-fg)}
  .df-sev--medium{background:var(--df-sev-medium-bg);color:var(--df-sev-medium-fg)}
  .df-sev--low{background:var(--df-sev-low-bg);color:var(--df-sev-low-fg)}
  .df-sev--info{background:var(--df-sev-low-bg);color:var(--df-sev-low-fg)}
  .df-vuln-t{font-weight:560;min-width:0}
  .df-vuln-t small{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1;
    font-weight:400;color:var(--df-sub);font-size:12px;margin-top:1px;
    overflow:hidden;word-break:break-word}

  /* ---------------------------------------------------------------- 漏洞：严重度筛选 + 成果列表 */
  .df-sevbar{display:grid;grid-template-columns:repeat(auto-fit,minmax(116px,1fr));gap:10px}
  /* 上下文页：上次实际组装的段大小条 */
  .df-ctx-bars{display:flex;flex-direction:column;gap:7px;padding:2px 0}
  .df-ctx-bar{display:grid;grid-template-columns:232px 1fr 76px;gap:9px;align-items:center;font-size:12.5px}
  .df-ctx-bar-name{color:var(--df-sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--df-mono)}
  .df-ctx-bar-tag{display:inline-block;font-style:normal;font-family:var(--df-font);font-size:10.5px;font-weight:600;
    line-height:16px;padding:0 5px;border-radius:4px;margin-right:6px;background:var(--df-surface-2);color:var(--df-sub)}
  .df-ctx-bar-tag.is-system{background:var(--df-info-soft);color:var(--df-info)}
  .df-ctx-bar-tag.is-workspace{background:var(--df-ok-soft);color:var(--df-ok)}
  .df-ctx-bar-tag.is-sub{background:var(--df-warn-soft);color:var(--df-warn)}
  .df-ctx-bar-track{height:6px;border-radius:3px;background:var(--df-surface-2);overflow:hidden}
  .df-ctx-bar-track i{display:block;height:100%;background:var(--df-info);border-radius:3px}
  .df-ctx-bar.is-forge .df-ctx-bar-track i{background:var(--df-warn)}
  .df-ctx-bar-num{text-align:right;color:var(--df-faint);font-variant-numeric:tabular-nums}
  /* 提示词生效链路：左侧编号、中间是什么、右侧何时生效；当前页整行加底色。 */
  .df-layers{border:1px solid var(--df-line-soft);border-radius:var(--df-r-lg);background:var(--df-surface);overflow:hidden}
  .df-layers-hd{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 16px;
    border-bottom:1px solid var(--df-line-soft)}
  .df-layers-hd b{font-size:var(--df-t-card);font-weight:650}
  .df-layers-note{font-size:12.5px;color:var(--df-sub);min-width:0}
  .df-layers-body{display:flex;flex-direction:column}
  .df-layer{display:grid;grid-template-columns:30px minmax(0,1fr) 132px;gap:12px;align-items:center;
    padding:12px 16px;position:relative;border-bottom:1px solid var(--df-line-soft)}
  .df-layer:last-child{border-bottom:0}
  .df-layer.is-link{cursor:pointer}
  .df-layer.is-link:hover{background:var(--df-hover)}
  .df-layer.is-focus{background:linear-gradient(90deg,var(--df-accent-soft),transparent 62%)}
  .df-layer.is-focus::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--df-accent)}
  .df-layer-no{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;
    font-family:var(--df-mono);font-size:11px;font-weight:700;color:var(--df-sub);background:var(--df-surface-2)}
  .df-layer.is-focus .df-layer-no{background:var(--df-accent);color:var(--df-ink-inv)}
  .df-layer-main{min-width:0}
  .df-layer-hd{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:0}
  .df-layer-hd b{font-size:var(--df-t-row);font-weight:650}
  .df-layer-role{font-family:var(--df-mono);font-size:11px;color:var(--df-sub);background:var(--df-surface-2);
    border-radius:5px;padding:1px 6px;white-space:nowrap}
  .df-layer-scope{font-size:12px;color:var(--df-faint);white-space:nowrap}
  .df-layer-here{font-size:11px;font-weight:650;color:var(--df-accent);background:var(--df-accent-soft);
    border-radius:999px;padding:1px 7px}
  .df-layer-purpose{font-size:12.5px;color:var(--df-sub);margin-top:3px;line-height:1.45}
  .df-layer-items{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}
  .df-layer-item{display:inline-flex;align-items:center;gap:5px;height:21px;padding:0 8px;border-radius:6px;
    background:var(--df-surface-2);font-size:11.5px;color:var(--df-sub);white-space:nowrap}
  .df-layer-item i{width:5px;height:5px;border-radius:50%;background:var(--df-accent);flex:none}
  .df-layer-item.is-edit{background:var(--df-accent-soft);color:var(--df-ink);font-weight:550}
  .df-layer-side{display:flex;flex-direction:column;align-items:flex-end;gap:5px;justify-self:end}
  .df-layer-when{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;color:var(--df-sub);white-space:nowrap}
  .df-layer-go{font-size:11.5px;color:var(--df-accent);white-space:nowrap}
  .df-layers-ft{padding:9px 16px;border-top:1px solid var(--df-line-soft);font-size:11.5px;
    color:var(--df-faint);line-height:1.5}
  .df-layers--compact .df-layers-hd{padding:10px 14px}
  .df-layers--compact .df-layer{grid-template-columns:26px minmax(0,1fr) auto;padding:9px 14px}
  .df-layers--compact .df-layer-no{width:22px;height:22px;font-size:10.5px}
  .df-layers--compact .df-layers-ft{padding:7px 14px}
  /* 工作区指令：按 用户级 → 共享级 → 项目根 → 当前目录 分组，每组一个编号头。 */
  .df-tierlist{display:flex;flex-direction:column;gap:10px;margin-top:8px}
  .df-tiergroup{border:1px solid var(--df-line-soft);border-radius:var(--df-r);overflow:hidden;background:var(--df-surface)}
  .df-tierhd{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--df-surface-2);min-width:0}
  .df-tierno{font-family:var(--df-mono);font-size:10px;font-weight:700;color:var(--df-sub);
    min-width:26px;height:20px;padding:0 5px;border-radius:999px;background:var(--df-surface);display:grid;place-items:center;flex:none}
  .df-tiert{font-size:12.5px;font-weight:650;color:var(--df-ink);white-space:nowrap}
  .df-tierw{font-size:12px;color:var(--df-sub);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-tiern{margin-left:auto;font-size:11.5px;color:var(--df-faint);white-space:nowrap}
  .df-vlist--flat{margin:0}
  @container (max-width:560px){
    .df-layer{grid-template-columns:26px minmax(0,1fr);row-gap:6px}
    .df-layer-side{grid-column:2;flex-direction:row;align-items:center;justify-content:flex-start}
  }
  .df-sevbtn{display:flex;flex-direction:column;align-items:flex-start;gap:3px;padding:12px 14px;min-width:0;position:relative;
    border:1.5px solid transparent;border-radius:var(--df-r-lg);background:var(--df-surface);
    box-shadow:var(--df-shadow-1);cursor:pointer;text-align:left;font:inherit;color:inherit;
    transition:background .15s,border-color .15s,transform .1s}
  .df-sevbtn:hover{transform:translateY(-1px)}
  .df-sevbtn:active{transform:none}
  .df-sevbtn .df-sb-l{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;
    color:var(--df-sub);white-space:nowrap}
  .df-sevbtn .df-sb-l i{width:8px;height:8px;border-radius:50%;background:var(--df-faint);flex:none}
  .df-sevbtn .df-sb-v{font-size:var(--df-t-num);font-weight:700;letter-spacing:-.03em;line-height:1.1;
    font-variant-numeric:tabular-nums;color:var(--df-ink)}
  .df-sevbtn.on{border-color:var(--df-accent);background:var(--df-accent-soft)}
  .df-sevbtn .df-sb-on{position:absolute;top:10px;right:11px;width:18px;height:18px;border-radius:50%;
    background:var(--df-accent);color:var(--df-ink-inv);font-size:12px;font-weight:700;line-height:1;
    display:flex;align-items:center;justify-content:center}
  .df-sevbtn--all i{background:var(--df-info-solid)}
  .df-sevbtn--critical i{background:var(--df-err-solid)}
  .df-sevbtn--high i{background:var(--df-warn-solid)}
  .df-sevbtn--medium i{background:#e6a400}
  .df-sevbtn--low i{background:var(--df-faint)}
  .df-sevbtn--critical .df-sb-v{color:var(--df-err)}
  .df-sevbtn--high .df-sb-v{color:var(--df-warn)}

  .df-vlist{display:flex;flex-direction:column;margin:-10px -8px}
  .df-vrow{display:flex;align-items:stretch;gap:12px;width:100%;padding:13px 16px 13px 14px;
    border:0;border-bottom:1px solid var(--df-line-soft);background:transparent;text-align:left;
    cursor:pointer;font:inherit;color:inherit;transition:background .12s}
  .df-vrow:last-child{border-bottom:0}
  .df-vrow:hover{background:var(--df-hover)}
  .df-vrow:active{background:var(--df-hover-2)}
  .df-vrow:focus-visible{outline:2px solid var(--df-accent);outline-offset:-2px}
  .df-vrow-rail{width:3px;border-radius:999px;flex:none;background:var(--df-faint);align-self:stretch}
  .df-vrow--critical .df-vrow-rail{background:var(--df-err-solid)}
  .df-vrow--high .df-vrow-rail{background:var(--df-warn-solid)}
  .df-vrow--medium .df-vrow-rail{background:#e6a400}
  .df-vrow--low .df-vrow-rail,.df-vrow--info .df-vrow-rail{background:var(--df-line)}
  .df-vrow-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px;justify-content:center}
  .df-vrow-hd{display:flex;align-items:center;gap:8px;min-width:0}
  .df-vrow-t{font-size:14.5px;font-weight:600;line-height:1.35;min-width:0;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-vrow-m{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:var(--df-t-meta);color:var(--df-sub);min-width:0}
  /* 靶标 IP 是这一行最需要被扫到的标识：和正文同级，不再单独缩到 13.5。 */
  .df-vrow-m .df-vrow-ip{font-family:var(--df-mono);font-size:var(--df-t-meta);font-weight:600;letter-spacing:normal}
  /* 目标 URL 可以很长：单行省略，绝不让它把行撑出卡片。 */
  .df-vrow-m .df-vrow-url{flex:0 1 auto;min-width:0;max-width:52ch;overflow:hidden;
    text-overflow:ellipsis;white-space:nowrap}
  .df-vrow-sep{color:var(--df-faint)}
  .df-vrow-right{display:flex;align-items:center;gap:10px;flex:none;padding-left:4px}
  .df-vrow-ago{font-size:var(--df-t-meta);color:var(--df-faint);white-space:nowrap}
  .df-vrow-go{color:var(--df-faint);font-size:18px;font-weight:600;line-height:1}
  .df-vrow:hover .df-vrow-go{color:var(--df-accent)}

  .df-next-ico{width:22px;height:22px;border-radius:var(--df-r-xs);display:flex;align-items:center;justify-content:center;
    background:var(--df-surface-2);color:var(--df-sub);flex:none}

  .df-seq{font-family:var(--df-mono);font-size:12px;font-weight:650;line-height:1;color:var(--df-sub);background:var(--df-surface-2);
    border:1px solid var(--df-line-soft);border-radius:var(--df-r-xs);padding:3px 5px;flex:none}
  .df-chain-tool{font-family:var(--df-mono);font-size:12px;color:var(--df-sub);max-width:46%;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-tl--pad{padding:10px 12px 10px 24px}
  .df-tl--pad .df-tl-item{padding:8px 0 10px}
  .df-tl-r{font-size:13px;color:var(--df-sub);margin-top:2px;line-height:1.55;
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .df-tl--pad .df-tl-d{display:flex;align-items:center;gap:8px;margin-top:2px}
  .df-act-ico{width:20px;height:20px;border-radius:var(--df-r-xs);display:inline-flex;align-items:center;justify-content:center;
    background:var(--df-surface-2);color:var(--df-sub);flex:none}

  .df-detail{display:flex;flex-direction:column;gap:14px;padding:4px 2px 10px}
  /* 补丁详情：状态卡 + 分段卡片。状态先解释清楚“为什么现在是这样、下一步做什么”。 */
  .df-patch-status{display:flex;align-items:flex-start;gap:11px;padding:12px 13px;
    border:1px solid var(--df-line);border-radius:11px;background:var(--df-surface-2)}
  .df-patch-status-ico{flex:none;width:30px;height:30px;border-radius:9px;display:flex;
    align-items:center;justify-content:center;background:var(--df-fill);color:var(--df-sub)}
  .df-patch-status-main{min-width:0;display:flex;flex-direction:column;gap:4px}
  .df-patch-status-badge{align-self:flex-start;display:inline-flex;align-items:center;gap:5px;
    height:24px;padding:0 9px;border-radius:7px;font-size:11.5px;font-weight:700;
    letter-spacing:.02em;white-space:nowrap;
    background:var(--df-surface);color:var(--df-ink);border:1px solid var(--df-line-strong)}
  .df-patch-status-badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
  .df-patch-status-main b{font-size:13px;font-weight:620;color:var(--df-ink);line-height:1.45}
  .df-patch-status-next{font-size:12px;color:var(--df-sub);line-height:1.55}
  .df-patch-status--ok{border-color:color-mix(in srgb,var(--df-ok-solid) 34%,var(--df-line));
    background:color-mix(in srgb,var(--df-ok-solid) 8%,var(--df-surface))}
  .df-patch-status--ok .df-patch-status-ico{background:var(--df-ok-soft);color:var(--df-ok)}
  .df-patch-status--ok .df-patch-status-badge{background:var(--df-ok-soft);color:var(--df-ok);
    border-color:color-mix(in srgb,var(--df-ok) 40%,var(--df-line))}
  .df-patch-status--warn{border-color:color-mix(in srgb,var(--df-warn-solid) 38%,var(--df-line));
    background:color-mix(in srgb,var(--df-warn-solid) 9%,var(--df-surface))}
  .df-patch-status--warn .df-patch-status-ico{background:var(--df-warn-soft);color:var(--df-warn)}
  .df-patch-status--warn .df-patch-status-badge{background:var(--df-warn-soft);color:var(--df-warn);
    border-color:color-mix(in srgb,var(--df-warn) 40%,var(--df-line))}
  .df-patch-status--err{border-color:color-mix(in srgb,var(--df-err-solid) 38%,var(--df-line));
    background:color-mix(in srgb,var(--df-err-solid) 8%,var(--df-surface))}
  .df-patch-status--err .df-patch-status-ico{background:var(--df-err-soft);color:var(--df-err)}
  .df-patch-status--err .df-patch-status-badge{background:var(--df-err-soft);color:var(--df-err);
    border-color:color-mix(in srgb,var(--df-err) 40%,var(--df-line))}
  .df-patch-status--info{border-color:color-mix(in srgb,var(--df-info-solid) 34%,var(--df-line));
    background:color-mix(in srgb,var(--df-info-solid) 8%,var(--df-surface))}
  .df-patch-status--info .df-patch-status-ico{background:var(--df-info-soft);color:var(--df-info)}
  .df-patch-status--info .df-patch-status-badge{background:var(--df-info-soft);color:var(--df-info);
    border-color:color-mix(in srgb,var(--df-info) 40%,var(--df-line))}
  /* 作用 / 开启后 / 关闭后：一段一张淡卡，和上方状态卡拉开层次。 */
  .df-patch-sec{padding:10px 12px;border:1px solid var(--df-line-soft);border-radius:10px;
    background:var(--df-surface)}
  .df-patch-sec .df-detail-hd{margin-bottom:4px}
  .df-patch-sec .df-detail-p{color:var(--df-ink);opacity:.9}
  .df-patch-sec.is-on{border-left:3px solid var(--df-ok-solid);padding-left:10px}
  .df-patch-sec.is-off{border-left:3px solid var(--df-line-strong);padding-left:10px}
  .df-detail-sec>h4{font-size:var(--df-t-micro);font-weight:650;color:var(--df-sub);letter-spacing:.04em;
    margin:0 0 6px}
  .df-detail-hd{display:flex;align-items:center;gap:8px;margin-bottom:6px}
  .df-detail-hd>h4{margin:0}
  .df-detail-hd .df-copy{margin-left:auto}
  .df-chips{display:flex;flex-wrap:wrap;gap:4px}
  .df-evi{font-family:var(--df-mono);font-size:var(--df-t-meta);line-height:1.6;white-space:pre-wrap;word-break:break-word;
    background:var(--df-surface-2);border:1px solid var(--df-line-soft);border-radius:var(--df-r-sm);
    padding:9px 10px;max-height:200px;overflow:auto;margin:0}
  .df-evi-card{border:1px solid var(--df-line-soft);border-radius:var(--df-r);padding:8px;margin-bottom:8px;
    display:flex;flex-direction:column;gap:6px;background:var(--df-surface)}
  .df-evi-hd{display:flex;align-items:center;gap:8px;font-family:var(--df-mono);font-size:var(--df-t-meta);color:var(--df-sub)}
  .df-evi-hd b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-evi-hd span{margin-left:auto;color:var(--df-sub);flex:none}
  /* 复现报文：抬头（方法/路径/状态）+ Request / Response 两栏，像 Burp Repeater。 */
  .df-pkt-list{display:flex;flex-direction:column;gap:8px}
  .df-pkt{border:1px solid var(--df-line-soft);border-radius:var(--df-r);overflow:hidden;background:var(--df-surface)}
  .df-pkt-hd{display:flex;align-items:center;gap:7px;min-width:0;padding:5px 9px;
    background:var(--df-surface-2);border-bottom:1px solid var(--df-line-soft);
    font-family:var(--df-mono);font-size:var(--df-t-meta)}
  .df-pkt-i{flex:none;color:var(--df-faint)}
  .df-pkt-m{flex:none;font-weight:700;color:var(--df-ink);letter-spacing:.02em}
  .df-pkt-u{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--df-sub)}
  .df-pkt-st{flex:none;padding:0 7px;border-radius:999px;font-size:var(--df-t-micro);font-weight:600;line-height:1.75}
  .df-pkt-st--ok{background:var(--df-ok-soft);color:var(--df-ok)}
  .df-pkt-st--info{background:var(--df-info-soft);color:var(--df-info)}
  .df-pkt-st--warn{background:var(--df-warn-soft);color:var(--df-warn)}
  .df-pkt-st--err{background:var(--df-err-soft);color:var(--df-err)}
  .df-pkt-st--line{background:var(--df-fill);color:var(--df-sub)}
  .df-pkt-tag{flex:none;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    color:var(--df-faint);font-size:var(--df-t-micro)}
  .df-pkt-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);
    gap:1px;background:var(--df-line-soft)}
  .df-pkt-grid--one{grid-template-columns:minmax(0,1fr)}
  @media (max-width: 760px){.df-pkt-grid{grid-template-columns:minmax(0,1fr)}}
  .df-pkt-col{min-width:0;background:var(--df-surface)}
  .df-pkt-cap{padding:3px 9px;border-bottom:1px dashed var(--df-line-soft);
    font-family:var(--df-mono);font-size:var(--df-t-micro);letter-spacing:.06em;
    color:var(--df-faint);text-transform:uppercase}
  .df-pkt-raw{margin:0;padding:8px 10px;max-height:300px;overflow:auto;
    font-family:var(--df-mono);font-size:var(--df-t-meta);line-height:1.6;
    white-space:pre;tab-size:2}
  .df-htp-start{color:var(--df-accent);font-weight:600}
  .df-htp-status{color:var(--df-ok);font-weight:600}
  .df-htp-head{color:var(--df-sub)}
  .df-evi-raw{margin-top:2px}
  .df-evi-raw>summary{cursor:pointer;color:var(--df-faint);font-size:var(--df-t-micro);
    padding:2px 0;user-select:none}
  .df-evi-raw>summary:hover{color:var(--df-sub)}
  .df-evi-raw .df-evi{margin-top:6px;max-height:240px}

  /* ---------------------------------------------------------------- 评分 / 报告 */
  .df-sgroup+.df-sgroup{border-top:1px solid var(--df-line-soft)}
  /* 交付清单：危害徽标 + 标题同行，标题单行截断，表格不会因长标题把列撑开。
     注意类名前缀用 df-dvc：.df-del-cell 已经被「删除靶标」的统计格占用了。 */
  .df-dvc{display:flex;align-items:center;gap:8px;min-width:0}
  .df-dvc-t{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-sgroup-hd{display:flex;align-items:baseline;gap:8px;padding:8px 10px 6px;background:var(--df-surface-2)}
  .df-sgroup-hd b{font-size:13px;font-weight:650}
  .df-sgroup-hd .df-sub{font-size:12px;color:var(--df-sub);margin-left:auto;font-variant-numeric:tabular-nums}
  .df-sgroup .df-tablewrap{max-height:none}
  .df-score-name{min-width:0}
  .df-score-name b{display:block;font-weight:600;font-size:var(--df-t-row);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-score-name small{display:block;font-family:var(--df-mono);font-size:var(--df-t-micro);color:var(--df-sub);margin-top:1px;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-score-num{font-variant-numeric:tabular-nums;font-weight:600}
  .df-score-num small{font-weight:400;color:var(--df-sub);font-size:var(--df-t-micro);margin-left:2px}
  .df-hits{display:flex;flex-direction:column;gap:8px}
  .df-hit{border:1px solid var(--df-line-soft);border-radius:var(--df-r-sm);padding:8px 10px;background:var(--df-surface)}
  .df-hit-hd{display:flex;align-items:center;gap:8px;font-size:13px;min-width:0}
  .df-hit-hd>.df-mono{font-size:var(--df-t-meta);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
  .df-hit-pts{font-weight:650;font-variant-numeric:tabular-nums;flex:none}
  .df-hit-d{font-size:var(--df-t-meta);color:var(--df-sub);margin:2px 0 5px}
  .df-hit .df-evi{max-height:120px;margin-top:5px}
  .df-hit .df-note{margin:4px 0 2px}
  .df-report-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 14px;border-bottom:1px solid var(--df-line-soft)}
  /* 生成前检查：报告是显式动作，所以把「会包含什么、不包含什么、代价是什么」先摆清楚，
     再给一个主按钮。清单不写成纯文字，是因为这里要让人一眼决定「现在生成还是先去补料」。 */
  .df-gen{padding:14px 16px 16px;display:flex;flex-direction:column;gap:14px}
  /* 单列四条：标签定宽、说明跟在后面。两列会把「包含」那条挤成折行，反而不像清单。 */
  .df-gen-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:9px}
  .df-gen-list li{display:flex;gap:12px;align-items:baseline;font-size:var(--df-t-body);line-height:1.6}
  .df-gen-list li b{flex:none;min-width:3.2em;font-size:var(--df-t-meta);font-weight:600;color:var(--df-faint);
    text-align:left}
  .df-gen-list li span{color:var(--df-sub);min-width:0}
  .df-gen-act{display:flex;align-items:center;gap:12px;flex-wrap:wrap;
    padding-top:14px;border-top:1px solid var(--df-line-soft)}
  /* 按钮旁边的说明不要那块灰底：它是提示语，不是一个信息块。 */
  .df-gen-act .df-note{padding:0;margin:0;flex:1 1 220px;background:none;border:0;font-size:var(--df-t-body)}

  .df-report-meta{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:8px 14px 0;font-size:var(--df-t-meta);color:var(--df-sub)}
  .df-report-bd{max-height:min(62vh,680px);overflow:auto;padding:6px 14px 18px}
  .df-md{max-width:1000px;font-size:var(--df-t-body);line-height:1.72;color:var(--df-ink)}
  .df-md h1{font-size:19px;font-weight:680;letter-spacing:-.01em;margin:4px 0 10px;line-height:1.35}
  .df-md h2{font-size:16px;font-weight:660;margin:18px 0 8px;padding-bottom:5px;border-bottom:1px solid var(--df-line-soft)}
  .df-md h3{font-size:14px;font-weight:650;margin:13px 0 5px}
  .df-md h4{font-size:13px;font-weight:650;margin:10px 0 4px;color:var(--df-sub)}
  .df-md p{margin:0 0 8px}
  .df-md ul,.df-md ol{margin:0 0 9px;padding-left:19px}
  .df-md li{margin:1px 0}
  .df-md b{font-weight:650}
  .df-md em{font-style:normal;color:var(--df-sub)}
  .df-md code{font-family:var(--df-mono);font-size:12px;background:var(--df-surface-2);color:var(--df-ink);
    border:1px solid var(--df-line-soft);border-radius:var(--df-r-xs);padding:0 4px;word-break:break-word}
  .df-md-code{margin:0 0 10px;padding:9px 11px;background:var(--df-surface-2);border:1px solid var(--df-line-soft);
    border-radius:var(--df-r-sm);overflow:auto;max-height:320px}
  .df-md-code code{background:none;border:0;padding:0;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
  .df-md blockquote{margin:6px 0 11px;padding:6px 10px;border-left:2px solid var(--df-line);
    background:var(--df-surface-2);border-radius:0 var(--df-r-sm) var(--df-r-sm) 0;color:var(--df-sub);font-size:13px}
  .df-md-tblwrap{overflow:auto;margin:0 0 11px;border:1px solid var(--df-line-soft);border-radius:var(--df-r-sm)}
  .df-md-tbl{border-collapse:collapse;width:100%;font-size:var(--df-t-meta)}
  .df-md-tbl th{text-align:left;font-weight:650;background:var(--df-surface-2);color:var(--df-ink);white-space:nowrap}
  .df-md-tbl th,.df-md-tbl td{padding:5px 8px;border-bottom:1px solid var(--df-line-soft);vertical-align:top}
  .df-md-tbl tr:last-child td{border-bottom:0}
  .df-md hr{border:0;border-top:1px solid var(--df-line-soft);margin:14px 0}
  .df-md-fig{margin:0 0 10px;padding:8px 10px;border:1px dashed var(--df-line);border-radius:var(--df-r-sm);
    background:var(--df-surface-2);display:flex;flex-direction:column;gap:2px}
  .df-md-fig figcaption{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--df-sub);min-width:0}
  .df-md-fig figcaption b{color:var(--df-ink);font-weight:600;flex:none}
  .df-md-fig figcaption code{margin-left:auto;max-width:56%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

  /* ---------------------------------------------------------------- 证据截图 */
  .df-shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px}
  .df-shot{position:relative;min-width:0}
  .df-shot-b{display:block;width:100%;aspect-ratio:16/10;padding:0;border:1px solid var(--df-line-soft);
    border-radius:var(--df-r-sm);overflow:hidden;background:var(--df-surface-2);cursor:zoom-in;position:relative}
  .df-shot-b:hover{border-color:var(--df-line)}
  .df-shot-b img{width:100%;height:100%;object-fit:cover;display:block}
  .df-shot-ph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--df-sub);font-size:var(--df-t-micro)}
  .df-shot-cap{margin-top:3px;font-size:var(--df-t-micro);line-height:1.4;color:var(--df-sub);
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-shot-del{position:absolute;top:3px;right:3px;width:20px;height:20px;padding:0;border:0;border-radius:var(--df-r-xs);
    display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);color:#fff;
    cursor:pointer;opacity:0;transition:opacity .12s}
  .df-shot:hover .df-shot-del,.df-shot-del.is-on{opacity:1}
  .df-shot-del.is-on{background:var(--df-err);color:var(--df-ink-inv)}
  .df-shot-full{margin-top:8px;border:1px solid var(--df-line-soft);border-radius:var(--df-r);overflow:hidden;
    background:var(--df-surface-2);max-height:min(46vh,460px);overflow:auto}
  .df-shot-full img{display:block;width:100%;height:auto}
  .df-shot-lightbox{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;
    padding:24px;background:rgba(8,10,14,.78);backdrop-filter:blur(2px);cursor:zoom-out}
  .df-shot-lightbox-body{position:relative;max-width:94vw;max-height:92vh;display:flex;flex-direction:column;
    gap:8px;padding:10px;border:1px solid var(--df-line);border-radius:var(--df-r);background:var(--df-surface);
    box-shadow:var(--df-shadow-2);cursor:default;overflow:auto}
  .df-shot-lightbox-body img{display:block;max-width:min(92vw,1800px);max-height:82vh;width:auto;height:auto;object-fit:contain;
    border-radius:var(--df-r-xs);background:var(--df-surface-2)}
  .df-shot-lightbox-cap{font-size:var(--df-t-micro);color:var(--df-sub);line-height:1.45;max-width:min(92vw,1800px);
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-shot-lightbox-x{position:absolute;top:14px;right:16px;width:30px;height:30px;border:1px solid rgba(255,255,255,.28);
    border-radius:50%;background:rgba(0,0,0,.55);color:#fff;font-size:20px;line-height:1;cursor:pointer;
    display:flex;align-items:center;justify-content:center}
  .df-shot-lightbox-x:hover{background:rgba(0,0,0,.78)}
  .df-shotbar{display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap}
  .df-upload{position:relative;overflow:hidden}
  .df-upload input{position:absolute;inset:0;opacity:0;cursor:pointer;font-size:0}

  /* ---------------------------------------------------------------- 资源 / 配置 */
  .df-opsbar--pad{padding:10px 12px 8px}
  .df-detail-p{font-size:var(--df-t-body);line-height:1.7;color:var(--df-sub);white-space:pre-wrap;word-break:break-word}
  .df-formgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:2px 14px 14px}
  .df-formsec{grid-column:1 / -1;display:flex;align-items:baseline;gap:10px;padding:10px 0 2px;border-top:1px solid var(--df-line-soft);margin-top:2px}
  .df-formsec:first-child{border-top:0;padding-top:0}
  .df-formsec h4{margin:0;font-size:13px;font-weight:600;color:var(--df-ink)}
  .df-formsec span{font-size:12px;color:var(--df-faint)}
  .df-formgrid .df-field--wide{grid-column:1 / -1}
  .dfx-dock[data-narrow="1"] .df-formgrid{grid-template-columns:1fr}
  .df-formfoot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;
    padding:9px 14px;border-top:1px solid var(--df-line-soft);background:var(--df-surface-2);
    border-radius:0 0 var(--df-r) var(--df-r)}
  .df-area--code{font-family:var(--df-mono);font-size:13px;line-height:1.65;min-height:260px}
  .df-kpi .df-kpi-v{word-break:break-word}

  /* ---------------------------------------------------------------- 门禁 / 授权 / 回退 */
  .df-crash{position:fixed;inset:0;z-index:2147483002;display:flex;align-items:center;justify-content:center;
    padding:24px;pointer-events:auto;background:var(--df-mask)}
  .df-crash-card{width:min(520px,100%);background:var(--df-surface);color:var(--df-ink);
    border:1px solid var(--df-line);border-radius:var(--df-r-lg);box-shadow:var(--df-shadow-2);padding:16px 18px 14px;
    display:flex;flex-direction:column;gap:10px}
  .df-crash-hd{display:flex;align-items:center;gap:9px;font-size:15px}
  .df-crash-hd .df-crash-mark{width:28px;height:28px;border-radius:var(--df-r-sm);display:flex;align-items:center;justify-content:center;
    background:var(--df-err-soft);color:var(--df-err);flex:none}
  .df-crash-card p{margin:0;font-size:13px;color:var(--df-sub);line-height:1.6}
  .df-crash-msg{margin:0;max-height:180px;overflow:auto;font-family:var(--df-mono);font-size:12px;line-height:1.55;color:var(--df-sub);
    background:var(--df-surface-2);border:1px solid var(--df-line-soft);border-radius:var(--df-r-sm);padding:8px 10px;
    white-space:pre-wrap;word-break:break-word}
  .df-crash-ft{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  /* 视图级兜底：留在主区里，导航和面板都还能用。 */
  .df-crash--inline{position:static;z-index:auto;padding:0;background:transparent;
    display:block;overflow:auto}
  .df-crash--inline .df-crash-card{margin:8px auto;max-width:560px}
  .df-mask{position:fixed;inset:0;z-index:2147483002;display:flex;align-items:center;justify-content:center;
    padding:24px;background:var(--df-mask);pointer-events:auto;animation:dfFade .16s ease-out}
  @keyframes dfFade{from{opacity:0}to{opacity:1}}
  .df-modal{width:min(560px,100%);max-height:min(88vh,780px);display:flex;flex-direction:column;
    background:var(--df-surface);border:1px solid var(--df-line);border-radius:var(--df-r-lg);
    box-shadow:var(--df-shadow-2);overflow:hidden}
  .df-modal--wide{width:min(660px,100%)}
  .df-modal-hd{display:flex;align-items:flex-start;gap:11px;padding:16px 18px 13px;
    border-bottom:1px solid var(--df-line-soft);background:var(--df-surface)}
  .df-modal-hd .df-mark{width:30px;height:30px;border-radius:var(--df-r-sm);flex:none;display:flex;align-items:center;
    justify-content:center;background:var(--df-accent);color:var(--df-ink-inv)}
  .df-modal-hd .df-mark.is-warn{background:var(--df-warn);color:var(--df-ink-inv)}
  .df-modal-hd .df-mh-t{flex:1;min-width:0}
  .df-modal-hd h2{margin:0;font-size:17px;font-weight:680;letter-spacing:.1px;line-height:1.35}
  .df-modal-hd p{margin:2px 0 0;font-size:13px;color:var(--df-sub);line-height:1.5}
  .df-modal-bd{flex:1;min-height:0;overflow:auto;padding:14px 18px 4px;display:flex;flex-direction:column;
    gap:10px;font-size:14px;line-height:1.72;color:var(--df-sub)}
  .df-modal-bd p{margin:0}
  .df-modal-bd h3{margin:4px 0 0;font-size:14px;font-weight:660;color:var(--df-ink)}
  .df-warnbox{padding:9px 12px;border-radius:var(--df-r-sm);background:var(--df-warn-soft);
    border:1px solid color-mix(in srgb,var(--df-warn) 28%,transparent);color:var(--df-ink);
    font-size:13px;line-height:1.65}
  .df-legal{max-height:236px;overflow:auto;padding:11px 13px;border:1px solid var(--df-line-soft);
    border-radius:var(--df-r);background:var(--df-surface-2);font-size:13px;line-height:1.72;color:var(--df-sub)}
  .df-legal p{margin:0 0 7px}
  .df-legal h3{margin:10px 0 5px;font-size:14px;font-weight:660;color:var(--df-ink)}
  .df-legal p:first-child{margin-top:0}
  .df-check{display:flex;align-items:flex-start;gap:8px;padding:7px 9px;border-radius:var(--df-r-sm);
    border:1px solid var(--df-line-soft);background:var(--df-surface-2);font-size:13px;line-height:1.55;
    color:var(--df-sub);cursor:pointer;transition:background .14s,border-color .14s}
  .df-check:hover{background:var(--df-hover)}
  .df-check.is-on{border-color:color-mix(in srgb,var(--df-accent) 40%,transparent);
    background:var(--df-accent-soft);color:var(--df-ink)}
  .df-check.is-locked{opacity:.55;cursor:default}
  .df-check input{margin:2px 0 0;accent-color:var(--df-accent);flex:none}
  .df-check span{flex:1;min-width:0}
  /* VPS 登录方式二选一：整块可点，选中描边，不做成裸 radio。 */
  .df-vps-opt{display:flex;align-items:flex-start;gap:10px;padding:12px;border:1px solid var(--df-line-soft);
    border-radius:var(--df-r);background:var(--df-surface-2);cursor:pointer;transition:border-color .14s,background .14s}
  .df-vps-opt+.df-vps-opt{margin-top:8px}
  .df-vps-opt:hover{border-color:color-mix(in srgb,var(--df-accent) 30%,var(--df-line-soft))}
  .df-vps-opt.on{border-color:color-mix(in srgb,var(--df-accent) 55%,transparent);background:var(--df-accent-soft)}
  .df-vps-opt.is-off{opacity:.55;cursor:default}
  .df-vps-opt.is-off:hover{border-color:var(--df-line-soft)}
  .df-vps-opt input{margin:3px 0 0;accent-color:var(--df-accent);flex:none}
  .df-vps-opt b{display:block;font-size:14px;font-weight:600;color:var(--df-ink);margin-bottom:3px}
  .df-vps-opt p{margin:0;font-size:13px;line-height:1.65;color:var(--df-sub)}
  .df-vps-sub{margin-top:10px;padding-top:10px;border-top:1px solid var(--df-line-soft)}
  .df-vps-native{display:flex;align-items:center;gap:12px;margin-top:10px;padding-top:10px;border-top:1px solid var(--df-line-soft)}
  .df-vps-native .df-check{flex:none}
  .df-vps-native .df-hint{flex:1;min-width:0}
  /* 外部接入：一行一个服务，状态和操作固定位置。 */
  .df-svc-list{display:flex;flex-direction:column;margin:-2px 0}
  .df-svc{display:grid;grid-template-columns:26px minmax(0,1fr) auto;gap:12px;align-items:center;
    padding:14px 2px;border-top:1px solid var(--df-line-soft)}
  .df-svc:first-child{border-top:0;padding-top:4px}
  .df-svc:last-child{padding-bottom:4px}
  .df-svc-ico{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;
    border-radius:8px;background:var(--df-surface-2);color:var(--df-sub)}
  .df-svc-title{display:flex;align-items:center;gap:8px;min-width:0}
  .df-svc-title b{font-size:14px;font-weight:600;color:var(--df-ink)}
  .df-svc-desc{font-size:13px;color:var(--df-sub);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-svc-actions{display:flex;align-items:center;gap:6px;flex:none}
  .df-svc-extra{grid-column:2/-1;margin-top:8px}
  .dfx-dock[data-narrow="1"] .df-svc{grid-template-columns:26px minmax(0,1fr)}
  .dfx-dock[data-narrow="1"] .df-svc-actions{grid-column:2;justify-content:flex-start;margin-top:8px;flex-wrap:wrap}
  .df-modal-ft{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 18px 14px;
    border-top:1px solid var(--df-line-soft);background:var(--df-surface)}
  .df-modal-hint{font-size:13px;color:var(--df-sub);line-height:1.5}
  .df-modal-hint.is-err{color:var(--df-err)}
  .df-modal-hint.is-warn{color:var(--df-warn)}

  .df-rewind-wrap{position:relative;display:inline-flex}
  .df-rewind{appearance:none;display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;
    border:0;border-radius:var(--df-r-sm);background:transparent;color:var(--df-sub);
    font-size:13px;line-height:1;cursor:pointer}
  .df-rewind:hover:not(:disabled){background:var(--df-hover);color:var(--df-ink)}
  .df-rewind:disabled{opacity:.4;cursor:default}
  .df-rewind svg{display:block}
  .df-rewind-menu{position:fixed;z-index:2147483003;box-sizing:border-box;min-width:238px;padding:4px;
    border:1px solid var(--df-line);border-radius:var(--df-r);background:var(--df-surface);color:var(--df-ink);
    box-shadow:var(--df-shadow-2);transform:translateY(-100%)}
  .df-rewind-item{display:flex;flex-direction:column;gap:2px;width:100%;padding:8px 10px;border:0;
    border-radius:var(--df-r-sm);background:transparent;color:inherit;text-align:left;cursor:pointer;
    font-size:13px;line-height:1.35}
  .df-rewind-item:hover{background:var(--df-hover)}
  .df-rewind-item b{font-size:14px;font-weight:620;color:var(--df-ink)}
  .df-rewind-item span{font-size:12px;color:var(--df-sub)}

  /* ---------------------------------------------------------------- 动效与降级 */
  @media (prefers-reduced-motion:reduce){
    .dfx-dock *,.df-portal *{animation-duration:.01ms!important;transition-duration:.01ms!important}
  }
  .dfx-dock[data-narrow="1"] .dfx-side{width:320px}
  .dfx-dock[data-narrow="1"] .dfx-sub,
  .dfx-dock[data-narrow="1"] .dfx-by,
  .dfx-dock[data-narrow="1"] .df-topbtn-t,
  .dfx-dock[data-narrow="1"] .df-topbtn kbd,
  .dfx-dock[data-narrow="1"] .df-target-meta{display:none}
  .dfx-dock[data-narrow="1"] .df-inject-label{display:none}
  .dfx-dock[data-narrow="1"] .df-target-name{max-width:118px}
  .dfx-dock[data-narrow="1"] .dfx-head{gap:6px;padding:0 8px 0 10px}
  .dfx-dock[data-narrow="1"] .dfx-main{padding:12px}
  .dfx-dock[data-narrow="1"] .dfx-frame{padding:12px}
  .dfx-dock[data-narrow="1"] .df-topbtn{padding:0 6px}
  .dfx-dock[data-narrow="1"] .df-target-btn{padding:0 9px;height:30px}
  /* 极窄（150% 缩放 / 小窗）抽屉浮在主区上，不再挤压表格。 */
  .dfx-dock[data-tight="1"] .dfx-body{position:relative}
  .dfx-dock[data-tight="1"] .dfx-side{position:absolute;right:0;top:0;bottom:0;z-index:6;
    border-left:1px solid var(--df-line);box-shadow:var(--df-shadow-2);border-radius:var(--df-r) 0 0 var(--df-r)}

  /* ---------------------------------------------------------------- 排版刻度收敛 */
  /* 上面各段是逐块写的，字号难免有 11.5 / 12 / 12.5 / 13 混着用的情况 ——
     切页时就会觉得「这一页字突然变小了」。这一层只改 font-size，把内容区收敛到刻度上：

       26 大数字 / 17 页面标题 / 15 卡片标题 / 14.5 列表主标题与身份列
       14 正文与表格 / 13 次要标签与 chip / 12.5 副行与细字 / 12 结构性微标签

     注意：11.5px 只在「矩阵列头副行」保留（那里一行要塞 6 个字，只能这么小）。
     顶栏、菜单、快捷键属于 chrome，本来就更小更紧，不在收敛范围内。 */
  .df-vuln-t small,
  .df-score-name small,
  .df-score-num small,
  .df-hit-hd>.df-mono,
  .df-hit-d,
  .df-sgroup-hd .df-sub,
  .df-chain-tool,
  .df-seq,
  .df-detail-sec>h4,
  .df-evi,
  .df-evi-hd,
  .df-md code,
  .df-md-code code,
  .df-md-fig figcaption,
  .df-shot-cap,
  .df-about-tag,
  .dfx-sev,
  .dfx-st,
  .dfx-kind,
  .dfx-trow .why,
  .dfx-mx th,
  .dfx-cell,
  .dfx-stage,
  .df-copy,
  .df-count,
  .df-rewind-item span,
  .df-crash-msg{font-size:var(--df-t-meta)}

  /* 行标题、卡片标题、页面标题统一走刻度，别再各写各的。 */
  .df-ops-title{font-size:var(--df-t-page)}
  .df-card-hd b{font-size:var(--df-t-card)}
  .df-vrow-t{font-size:var(--df-t-row)}
  /* 交付页的旧表格（.dfx-table）表头和主表保持同一级。 */
  .dfx-table th{font-size:13px}

  /* 主区被抽屉挤窄时：搜索框和说明先让步，别让工具条折成两行、掉一个控件在左端。
     容器查询挂在 .dfx-main 上，抽屉开合会自然触发。 */
  @container (max-width:840px){
    .df-opsbar .df-search{min-width:118px;flex:0 1 180px}
    /* 窄的时候副标题先缩到 300px：够放下大多数说明，又不会把右侧按钮挤到下一行。
       再窄（≤640）直接整条收起，见下一条。 */
    .df-opsbar .df-ops-meta{max-width:300px;overflow:hidden;text-overflow:ellipsis}
  }
  @container (max-width:640px){
    .df-opsbar .df-ops-meta{display:none}
  }

  /* ---------------------------------------------------------------- 本地应用手感 */
  /* 浏览器味的一大半来自这几件事：切页时滚动条消失/出现导致内容横向抖、
     滚到底继续滚会把宿主页面一起带走、文字到处能选中。 */
  .dfx-main{scrollbar-gutter:stable;overscroll-behavior:contain}
  .dfx-side,.df-portal .df-drawer-bd,.df-cmd-list{overscroll-behavior:contain}
  /* 界面本身不该被当成网页文本选中；真正的内容（代码、证据、报告）仍然可选。 */
  .dfx-head,.dfx-nav,.dfx-navbtn,.df-card-hd,.df-opsbar,.df-ops-title,.df-ops-meta,
  .df-table th,.df-stat,.df-sevbtn,.df-tabs,.df-seg{user-select:none;-webkit-user-select:none}
  .df-md,.df-evi,.df-code,.df-area--code,.df-detail-p,.df-crash-msg{user-select:text;-webkit-user-select:text}
  /* 按钮按下时轻微下沉，是「本机应用」最便宜的那种反馈。 */
  .df-btn:active:not(:disabled),.df-chip--btn:active,.df-navbtn:active,.df-sevbtn:active,
  .dfx-launch:active,.df-iconbtn:active{transform:scale(.975)}
  .df-btn,.df-iconbtn,.df-navbtn,.df-seg button{transition:background .12s ease,color .12s ease,
    border-color .12s ease,box-shadow .12s ease,transform .09s ease}

  /* ================================================================
     v2 整改层 · 设计令牌 + 外壳
     只改视觉语言，不动视图结构；后续再拆提示词工作台。
     ================================================================ */
  .dfx-dock,.dfx-launch,.df-portal,.df-rewind-wrap{
    --df-bg:#f0ebe1;
    --df-surface:#fffdf8;
    --df-surface-2:#f6f1e7;
    --df-fill:rgba(181,80,44,.10);
    --df-fill-hover:rgba(181,80,44,.16);
    --df-line:rgba(90,73,48,.23);
    --df-line-soft:rgba(90,73,48,.14);
    --df-line-strong:rgba(90,73,48,.36);
    --df-ink:#27241e;
    --df-sub:#5f5a50;
    --df-faint:#857d70;
    --df-ink-inv:#ffffff;
    --df-accent:#b5502c;
    --df-accent-hover:#963e20;
    --df-accent-soft:rgba(181,80,44,.12);
    --df-sel:rgba(181,80,44,.16);
    --df-hover:rgba(90,73,48,.06);
    --df-hover-2:rgba(90,73,48,.12);
    --df-ok:#2f7350;
    --df-warn:#a36a12;
    --df-err:#9a2f2a;
    --df-info:#356a7a;
    --df-ok-solid:#3c8f63;
    --df-warn-solid:#b07a1c;
    --df-err-solid:#b84a43;
    --df-info-solid:#4a8392;
    --df-ok-soft:rgba(60,143,99,.14);
    --df-warn-soft:rgba(176,122,28,.14);
    --df-err-soft:rgba(154,47,42,.13);
    --df-info-soft:rgba(74,131,146,.13);
    --df-sev-critical-bg:#9a2f2a;
    --df-sev-critical-fg:#ffffff;
    --df-sev-high-bg:#b26a1f;
    --df-sev-high-fg:#ffffff;
    --df-sev-medium-bg:#f7ecd3;
    --df-sev-medium-fg:#8a5a12;
    --df-sev-low-bg:#e0edf0;
    --df-sev-low-fg:#356a7a;
    --df-mask:rgba(25,20,12,.34);
    --df-shadow-1:0 1px 2px rgba(60,46,25,.06),0 12px 26px -20px rgba(60,46,25,.38);
    --df-shadow-2:0 30px 80px -30px rgba(40,30,15,.46),0 4px 14px rgba(40,30,15,.08);
    --df-t-num:25px;
    --df-t-page:24px;
    --df-t-card:13.5px;
    --df-t-row:13px;
    --df-t-body:13px;
    --df-t-meta:12px;
    --df-t-micro:11px;
    --df-font:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
    --df-serif:"Iowan Old Style","Palatino Linotype","Songti SC","Noto Serif CJK SC",Georgia,serif;
    --df-mono:"SFMono-Regular",Consolas,"Liberation Mono","Courier New",monospace;
    --df-r-xs:7px;
    --df-r-sm:9px;
    --df-r:13px;
    --df-r-lg:14px;
    --df-row:42px;
    --df-fs:13.5px;
  }
  body[data-ds-dark-theme] .dfx-dock,body[data-ds-dark-theme] .dfx-launch,
  body[data-ds-dark-theme] .df-portal,body[data-ds-dark-theme] .df-rewind-wrap{
    /* 暗色底跟宿主的中性色走（宿主暗色是偏蓝的灰，不是暖褐）：
       底色取在宿主 bg-base 与 layer-1 之间，面板才像「浮起来的一层」，
       又不会在宿主底色上显出一块发黄的脏灰。强调色仍保留暖色，和 dsh 区分开。 */
    --df-bg:#17181b;
    --df-surface:#202226;
    --df-surface-2:#272a2e;
    --df-fill:rgba(255,255,255,.06);
    --df-fill-hover:rgba(255,255,255,.11);
    --df-line:rgba(255,255,255,.12);
    --df-line-soft:rgba(255,255,255,.06);
    --df-line-strong:rgba(255,255,255,.22);
    --df-ink:#e9ecf1;
    --df-sub:#b7bdc7;
    --df-faint:#8a9099;
    /* 强调色上的文字用深色：白字压在暖橙上只有 3:1，会发灰。 */
    --df-ink-inv:#1c1410;
    --df-accent:#e0906a;
    --df-accent-hover:#f0a880;
    --df-accent-soft:rgba(224,144,106,.14);
    --df-sel:rgba(224,144,106,.22);
    --df-hover:rgba(255,255,255,.05);
    --df-hover-2:rgba(255,255,255,.10);
    --df-ok:#5fcb8c;
    --df-warn:#e3b566;
    --df-err:#f08b85;
    --df-info:#8fb8d8;
    --df-ok-solid:#3c8f63;
    --df-warn-solid:#b07a1c;
    --df-err-solid:#b84a43;
    --df-info-solid:#4a8392;
    --df-ok-soft:rgba(95,203,140,.16);
    --df-warn-soft:rgba(227,181,102,.16);
    --df-err-soft:rgba(240,139,133,.16);
    --df-info-soft:rgba(143,184,216,.16);
    --df-sev-critical-bg:#b84a43;
    --df-sev-critical-fg:#ffffff;
    --df-sev-high-bg:#b07a1c;
    --df-sev-high-fg:#1c1410;
    --df-sev-medium-bg:#332a1d;
    --df-sev-medium-fg:#e3b566;
    --df-sev-low-bg:#252a30;
    --df-sev-low-fg:#b7bdc7;
    --df-mask:rgba(0,0,0,.55);
    --df-shadow-1:0 1px 2px rgba(0,0,0,.2),0 18px 40px -30px rgba(0,0,0,.65);
    --df-shadow-2:0 30px 90px -24px rgba(0,0,0,.74),0 4px 14px rgba(0,0,0,.2);
  }

  .dfx-dock{border:1px solid var(--df-line);border-radius:16px;box-shadow:var(--df-shadow-2);background:var(--df-bg)}
  .dfx-head{height:52px;padding:0 12px 0 16px;gap:8px;background:var(--df-bg);border-bottom:1px solid var(--df-line)}
  .dfx-mark{width:28px;height:28px;border-radius:8px;background:var(--df-ink);color:var(--df-surface);box-shadow:inset 0 0 0 1px rgba(255,255,255,.06)}
  body[data-ds-dark-theme] .dfx-mark{background:var(--df-accent);color:var(--df-ink-inv)}
  .dfx-brand{font-size:14px;font-weight:750;letter-spacing:.01em}
  .dfx-sub{font-size:9.5px;letter-spacing:.08em;color:var(--df-faint)}
  .dfx-by{font-size:10px;color:var(--df-faint)}
  .dfx-tag{height:27px;border-radius:8px;background:var(--df-surface);border:1px solid var(--df-line);font-size:11.5px;padding:0 9px}
  .dfx-tag:hover{border-color:var(--df-line-strong);background:var(--df-surface-2)}
  .dfx-head .df-topbtn{height:30px;border-radius:8px;border:1px solid var(--df-line);background:var(--df-surface);font-size:11px;color:var(--df-sub)}
  .dfx-head .df-topbtn:hover{background:var(--df-surface-2);border-color:var(--df-line-strong)}
  .dfx-head .df-iconbtn{width:30px;height:30px;border-radius:8px}
  .dfx-body{background:var(--df-bg)}
  .dfx-nav{width:206px;padding:9px 9px 11px;border-right:1px solid var(--df-line);background:linear-gradient(180deg,var(--df-surface),var(--df-surface-2))}
  .dfx-ngrp{height:20px;padding:0 9px;font:9px/20px var(--df-mono);letter-spacing:.14em;text-transform:uppercase;color:var(--df-sub);opacity:.72}
  .dfx-ngrp-block:first-child .dfx-ngrp{padding-top:1px}
  .dfx-navbtn{height:33px;border-radius:8px;padding:0 9px;gap:9px;font-size:12.5px;font-weight:560;color:var(--df-sub)}
  .dfx-navbtn:hover{background:var(--df-hover);color:var(--df-ink)}
  .dfx-navbtn.on{background:var(--df-accent-soft);color:var(--df-accent);font-weight:650;box-shadow:none;border:0}
  .dfx-navbtn.on>svg{color:var(--df-accent);opacity:1}
  .dfx-navbtn.on::before{content:"";position:absolute;left:-9px;top:9px;bottom:9px;width:3px;border-radius:0 3px 3px 0;background:var(--df-accent)}
  .dfx-navbtn .df-navdot{width:5px;height:5px;background:var(--df-err);box-shadow:0 0 0 3px var(--df-err-soft)}
  .dfx-navfoot{border-top:1px solid var(--df-line);padding-top:7px;margin-top:7px}
  .dfx-navfold{height:30px;border-radius:8px;font-size:11px;color:var(--df-faint)}
  .dfx-navfold:hover{background:var(--df-hover);color:var(--df-sub)}
  .dfx-main{padding:22px 24px 32px;gap:14px;background:transparent}
  .dfx-pane{gap:14px}
  .dfx-side{background:var(--df-surface);border-left:1px solid var(--df-line)}

  .df-ops-title{font-family:var(--df-serif);font-size:24px;line-height:1.16;font-weight:600;letter-spacing:-.02em}
  .df-ops-meta{font-size:11px;color:var(--df-sub)}
  .df-card{border:1px solid var(--df-line);border-radius:var(--df-r);box-shadow:var(--df-shadow-1);background:var(--df-surface)}
  .df-card-hd{min-height:47px;padding:13px 16px;border-bottom-color:var(--df-line-soft)}
  .df-card-hd b{font-size:13px;font-weight:700}
  .df-card-hd .df-sub{font-size:10.5px;color:var(--df-faint)}
  .df-card-bd{padding:12px}
  .df-card-bd--pad{padding:15px}
  .df-card-hd .df-opsbar{gap:6px}
  .df-btn{height:31px;padding:0 11px;border-radius:8px;border-color:var(--df-line);background:var(--df-surface);font-size:12px;font-weight:620}
  .df-btn:hover{background:var(--df-surface-2);border-color:var(--df-line-strong)}
  .df-btn--sm{height:27px;padding:0 8px;font-size:11px}
  .df-btn--lg{height:35px;padding:0 15px;font-size:12.5px}
  .df-btn--primary{background:var(--df-accent);border-color:var(--df-accent);color:var(--df-ink-inv);box-shadow:0 6px 16px -12px var(--df-accent)}
  .df-btn--primary:hover{background:var(--df-accent-hover);border-color:var(--df-accent-hover)}
  .df-btn--ghost{border-color:transparent;color:var(--df-sub)}
  .df-btn--ghost:hover{background:var(--df-hover);border-color:transparent;color:var(--df-ink)}
  .df-btn--danger{border-color:var(--df-err-soft)}
  .df-input,.df-select,.df-area{border:1px solid var(--df-line);border-radius:8px;background:var(--df-surface-2);font-size:12px;height:31px}
  .df-input:focus,.df-select:focus,.df-area:focus{background:var(--df-surface);border-color:var(--df-accent);box-shadow:0 0 0 3px var(--df-accent-soft)}
  .df-chip{height:21px;padding:0 7px;font-size:9.5px;font-weight:650}
  .df-table th{background:var(--df-surface-2);font:9.5px/1.2 var(--df-mono);letter-spacing:.10em;text-transform:uppercase;color:var(--df-faint);height:33px}
  .df-table td{height:42px;font-size:12px;border-bottom-color:var(--df-line-soft)}
  .df-table td:first-child{font-size:12.5px;font-weight:620}
  .df-table tbody tr:hover{background:var(--df-hover)}
  .df-stat-l{font-size:11px;color:var(--df-faint)}
  .df-stat-v{font-size:25px;font-weight:600;font-family:var(--df-serif)}
  .df-stat-f{font-size:10px;color:var(--df-faint)}
  .df-note{border-radius:8px;font-size:11px;line-height:1.55}
  .df-menu{border-radius:12px;border-color:var(--df-line);box-shadow:var(--df-shadow-2);background:var(--df-surface)}
  .df-menu-hd{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--df-faint);font-family:var(--df-mono)}
  .df-menu-item{border-radius:7px;font-size:11.5px}
  .df-menu-item.on{background:var(--df-accent-soft)}
  .dfx-head .df-target{border-radius:8px;background:var(--df-surface);border:1px solid var(--df-line);height:27px;padding:0 9px}
  .dfx-head .df-target-name{font-size:11.5px;font-weight:650}
  .dfx-head .df-target-meta{font-size:9px;color:var(--df-faint)}
  .dfx-head .df-inject-chip{height:27px;border-radius:8px;background:var(--df-surface);border:1px solid var(--df-line)}
  .dfx-head .df-inject-label{font-size:11px}
  /* 总开关要一眼看出来：开=绿底绿边，关=灰底；点击直接切，不再只是状态灯。 */
  .dfx-head .df-inject-chip.is-on{background:var(--df-ok-soft);border-color:color-mix(in srgb,var(--df-ok) 42%,transparent);color:var(--df-ink)}
  .dfx-head .df-inject-chip.is-off{background:var(--df-surface-2);border-color:var(--df-line);color:var(--df-sub)}
  .dfx-head .df-inject-chip:disabled{opacity:.6;cursor:default}
  .dfx-head .df-inject-state{padding:0 4px;border-radius:4px;font-size:10px;font-weight:700;line-height:15px;background:var(--df-surface)}
  .dfx-head .df-inject-chip.is-on .df-inject-state{color:var(--df-ok)}
  .dfx-head .df-inject-chip.is-off .df-inject-state{color:var(--df-faint)}
  .dfx-head .df-inject-gear{height:27px;padding:0 7px;margin-left:6px;border-radius:8px;border:1px solid var(--df-line);
    background:var(--df-surface);color:var(--df-sub);display:inline-flex;align-items:center;cursor:pointer}
  .dfx-head .df-inject-gear:hover{background:var(--df-hover);color:var(--df-ink)}
  .df-zoom{font-size:10px;color:var(--df-faint)}
  .df-sevtag{font-size:9px;font-weight:700}

  /* ---------------------------------------------------------------- 提示词工作台 */
  /* 宽屏不再留一条只有六个按钮的左栏：层导航改成顶部六格，详情拿到整幅宽度，
     全屏时也不会出现导航下方的大片空白。 */
  .df-prompt-workbench{display:flex;flex-direction:column;gap:12px}
  .df-prompt-nav{padding:7px;border:1px solid var(--df-line);border-radius:var(--df-r);background:var(--df-surface);box-shadow:var(--df-shadow-1)}
  .df-prompt-navhd{padding:4px 7px 7px;font:9px/1 var(--df-mono);letter-spacing:.14em;text-transform:uppercase;color:var(--df-faint)}
  .df-prompt-items{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:5px}
  /* 顶部导航下方的「本层摘要」：一句话交代选中层的作用域、存储位置与生效条件，
     每次切换都有确定的阅读落点。 */
  .df-prompt-side{display:flex;align-items:center;flex-wrap:wrap;gap:5px 14px;margin-top:7px;padding:8px 7px 1px;border-top:1px solid var(--df-line-soft)}
  .df-prompt-sidehd{display:inline-flex;align-items:center;gap:7px;font-size:10px;font-weight:700;color:var(--df-sub)}
  .df-prompt-when{padding:2px 6px;border-radius:5px;font-size:9px;font-weight:700;line-height:1.35;background:var(--df-surface-2);border:1px solid var(--df-line-soft);color:var(--df-sub)}
  .df-prompt-when.is-live{background:var(--df-ok-soft);border-color:color-mix(in srgb,var(--df-ok) 32%,transparent);color:var(--df-ok)}
  .df-prompt-when.is-restart{background:var(--df-warn-soft);border-color:color-mix(in srgb,var(--df-warn) 32%,transparent);color:var(--df-warn)}
  .df-prompt-when.is-spawn{background:var(--df-info-soft);border-color:color-mix(in srgb,var(--df-info) 32%,transparent);color:var(--df-info)}
  .df-prompt-when.is-read{color:var(--df-faint)}
  .df-prompt-srow{display:inline-flex;gap:6px;font-size:9.5px;line-height:1.55;color:var(--df-faint)}
  .df-prompt-srow b{flex:none;font-weight:600;color:var(--df-sub)}
  .df-prompt-srow span{min-width:0;word-break:break-word}
  .df-prompt-show{flex:1 1 300px;min-width:0;font-size:9.5px;line-height:1.55;color:var(--df-faint)}
  .df-prompt-item{display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:8px;border-radius:8px;border:1px solid transparent;background:transparent;text-align:left;color:var(--df-sub);transition:background .14s,border-color .14s,color .14s}
  .df-prompt-item:hover{background:var(--df-hover);color:var(--df-ink)}
  .df-prompt-item.on{background:var(--df-accent-soft);border-color:color-mix(in srgb,var(--df-accent) 26%,transparent);color:var(--df-accent)}
  .df-prompt-ico{width:27px;height:27px;flex:0 0 auto;border-radius:7px;display:flex;align-items:center;justify-content:center;background:var(--df-surface-2);color:var(--df-sub)}
  .df-prompt-item.on .df-prompt-ico{background:var(--df-surface);color:var(--df-accent)}
  .df-prompt-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
  .df-prompt-copy strong{font-size:12px;font-weight:650;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .df-prompt-copy small{font-size:9.5px;line-height:1.35;color:var(--df-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .df-prompt-item.on .df-prompt-copy small{color:var(--df-accent);opacity:.75}
  .df-prompt-dot{width:6px;height:6px;flex:0 0 auto;border-radius:50%;background:var(--df-faint)}
  .df-prompt-dot.is-ok{background:var(--df-ok);box-shadow:0 0 0 3px var(--df-ok-soft)}
  .df-prompt-dot.is-warn{background:var(--df-warn);box-shadow:0 0 0 3px var(--df-warn-soft)}
  .df-prompt-dot.is-err{background:var(--df-err);box-shadow:0 0 0 3px var(--df-err-soft)}
  .df-prompt-dot.is-info{background:var(--df-info);box-shadow:0 0 0 3px var(--df-info-soft)}
  .df-prompt-foot{margin-top:7px;padding:9px 8px 1px;border-top:1px solid var(--df-line-soft);font-size:9px;line-height:1.5;color:var(--df-faint)}
  .df-prompt-detail{min-width:0}
  .df-prompt-detail>.df-ops{gap:12px}
  .df-prompt-detail>.df-ops>.df-opsbar{display:none}
  .df-prompt-detail .df-layers{display:none}
  .df-prompt-note{margin-top:0}
  /* 六格排不下完整层名时折成 3+3，而不是把中间几项截成省略号。 */
  @container (max-width: 1080px){
    .df-prompt-items{grid-template-columns:repeat(3,minmax(0,1fr))}
  }
  @container (max-width: 820px){
    .df-prompt-nav{padding:7px}
    .df-prompt-navhd,.df-prompt-foot{display:none}
    .df-prompt-items{gap:4px}
    .df-prompt-item{padding:8px;gap:6px}
    .df-prompt-side{gap:4px 10px;padding-top:7px}
    .df-prompt-show{display:none}
  }
  @container (max-width: 560px){
    .df-prompt-items{grid-template-columns:repeat(2,minmax(0,1fr))}
    .df-prompt-copy small{display:none}
    .df-prompt-ico{display:none}
  }
  `
  document.head.appendChild(el)
}


/* ---- lib/client/25-ui.js ---- */
/* 原子组件：按钮、卡片、表格、抽屉、空态、骨架、Toast、命令面板外壳。
   只做展示与交互，不发请求、不做业务推导。 */

function DfBtn(props) {
  const { kind, size, icon, iconRight, children, className, ...rest } = props
  const cls = dfCx('df-btn',
    kind && 'df-btn--' + kind,
    size && 'df-btn--' + size,
    !children && 'df-btn--icon',
    className)
  return h('button', Object.assign({ type: 'button', className: cls }, rest),
    icon ? dfIcon(icon, size === 'sm' ? 13 : 15) : null,
    children || null,
    iconRight ? dfIcon(iconRight, size === 'sm' ? 13 : 15) : null)
}

function DfChip(props) {
  return h('span', { className: dfCx('df-chip', props.kind && 'df-chip--' + props.kind, props.className), title: props.title },
    props.dot ? h('i', { className: 'df-dot' }) : null,
    props.children)
}

function DfKpi(props) {
  const spark = Array.isArray(props.spark) ? props.spark : null
  const max = spark && spark.length ? Math.max.apply(null, spark.concat([1])) : 1
  return h('div', { className: dfCx('df-kpi', props.accent && 'df-kpi--accent') },
    h('div', { className: 'df-kpi-l' }, props.icon ? dfIcon(props.icon, 13) : null, props.label),
    h('div', { className: 'df-kpi-v' }, String(props.value),
      props.unit ? h('small', null, props.unit) : null),
    props.foot ? h('div', { className: 'df-kpi-f', title: typeof props.foot === 'string' ? props.foot : undefined }, props.foot) : null,
    spark ? h('div', { className: 'df-spark' }, spark.map(function (v, i) {
      return h('i', { key: i, style: { height: Math.max(3, Math.round((Number(v) || 0) / max * 22)) + 'px' } })
    })) : null)
}

/* 横向状态带：一排「标签 + 数字 + 小字」，装在一张白卡的横条里。
   比一排 KPI 小格子轻得多 —— 首屏还是一整块白，切页时整屏明暗不会跳。 */
function DfStat(props) {
  return h('div', { className: dfCx('df-stat', props.accent && 'df-stat--accent') },
    h('span', { className: 'df-stat-l' }, props.icon ? dfIcon(props.icon, 13) : null, props.label),
    h('span', { className: 'df-stat-v' }, String(props.value),
      props.unit ? h('small', null, props.unit) : null,
      props.foot ? h('span', { className: 'df-stat-f', title: typeof props.foot === 'string' ? props.foot : undefined }, props.foot) : null)
  )
}

function DfCard(props) {
  return h('section', { className: dfCx('df-card', props.className) },
    props.title || props.actions
      ? h('div', { className: 'df-card-hd' },
        props.icon ? dfIcon(props.icon, 14) : null,
        h('b', null, props.title),
        props.sub ? h('span', { className: 'df-sub' }, props.sub) : null,
        props.actions ? h('div', { className: 'df-spacer' }) : null,
        props.actions || null)
      : null,
    h('div', { className: dfCx('df-card-bd', props.pad && 'df-card-bd--pad') }, props.children))
}

function DfEmpty(props) {
  return h('div', { className: 'df-empty' },
    h('div', { className: 'df-empty-ico' }, dfIcon(props.icon || 'info', 17)),
    h('b', null, props.title || '暂无数据'),
    props.hint ? h('span', null, props.hint) : null,
    props.action || null)
}

function DfSkeleton(props) {
  const lines = props.lines || 4
  /* 骨架屏只负责「占位」，不做 1.4s 循环闪光：切页时骨架平均寿命只有一两百毫秒，
     闪到一半就消失，看起来就是一下白闪。改成静态的浅底，切页干净。 */
  return h('div', { className: 'df-skel-wrap', style: { padding: props.pad === false ? 0 : '12px 14px' } },
    h('div', { className: 'df-skel', style: { height: 14, width: '32%', marginBottom: 12 } }),
    Array.from({ length: lines }).map(function (_, i) {
      return h('div', {
        key: i,
        className: 'df-skel df-skel--line',
        style: { width: (92 - (i % 3) * 14) + '%' },
      })
    }))
}

/* 切页那一瞬的极简占位：三个静态小点（不做呼吸动画），比整页骨架安静。 */
function DfInlineWait(props) {
  return h('div', { className: 'df-inline-wait', role: 'status', 'aria-label': (props && props.label) || '加载中' },
    h('i'), h('i'), h('i'))
}

function DfSpinner(props) {
  return h('span', { className: 'df-spin', style: props.style, 'aria-label': '加载中' })
}

function DfSeg(props) {
  return h('div', { className: 'df-seg', role: 'tablist' }, (props.items || []).map(function (it, i) {
    const key = it[0] !== undefined ? it[0] : it.key
    const label = it[1] !== undefined ? it[1] : it.label
    return h('button', {
      key: key !== undefined ? key : i,
      type: 'button',
      role: 'tab',
      'aria-selected': props.value === key ? 'true' : 'false',
      className: props.value === key ? 'on' : '',
      onClick: function () { if (props.onChange) props.onChange(key) },
    }, label)
  }))
}

function DfTabs(props) {
  return h('div', { className: 'df-tabs', role: 'tablist' }, (props.items || []).map(function (it) {
    const active = props.value === it.key
    return h('button', {
      key: it.key,
      type: 'button',
      role: 'tab',
      'aria-selected': active ? 'true' : 'false',
      className: dfCx('df-tab', active && 'on'),
      onClick: function () { if (props.onChange) props.onChange(it.key) },
    }, it.icon ? dfIcon(it.icon, 13) : null, it.label,
      it.count !== undefined ? h('span', { className: 'df-count' }, String(it.count)) : null)
  }))
}

function DfSearch(props) {
  const [local, setLocal] = useState(props.value || '')
  /* 回调存 ref：debounce 只建一次，但永远调到最新的 onChange（避免首个闭包定型）。 */
  const onChangeRef = useRef(props.onChange)
  onChangeRef.current = props.onChange
  const emit = useRef(null)
  if (!emit.current) {
    emit.current = dfDebounce(function (v) {
      if (onChangeRef.current) onChangeRef.current(v)
    }, props.delay || 160)
  }
  useEffect(function () { setLocal(props.value || '') }, [props.value])
  useEffect(function () {
    return function () { if (emit.current) emit.current.cancel() }
  }, [])
  return h('div', { className: 'df-search', style: props.style },
    h('span', { className: 'df-search-ico' }, dfIcon('search', 13)),
    h('input', {
      className: 'df-input',
      type: 'search',
      value: local,
      placeholder: props.placeholder || '搜索',
      onChange: function (e) {
        const v = e.target.value
        setLocal(v)
        emit.current(v)
      },
      onKeyDown: props.onKeyDown,
    }),
    local ? h('button', {
      className: 'df-search-clear',
      type: 'button',
      title: '清空',
      onClick: function () { setLocal(''); emit.current.cancel(); if (props.onChange) props.onChange('') },
    }, dfIcon('close', 12)) : null)
}

function DfField(props) {
  return h('div', { className: 'df-field', style: props.style },
    props.label ? h('label', { htmlFor: props.htmlFor }, props.label) : null,
    props.children,
    props.hint ? h('div', { className: 'df-hint' }, props.hint) : null)
}

function DfCopyBtn(props) {
  const [done, setDone] = useState(false)
  const timer = useRef(0)
  useEffect(function () {
    return function () { if (timer.current) clearTimeout(timer.current) }
  }, [])
  return h('button', {
    type: 'button',
    className: 'df-copy',
    title: props.title || '复制',
    onClick: function (e) {
      e.stopPropagation()
      dfCopy(props.text).then(function (ok) {
        if (!ok) { dfToast('复制失败', 'err'); return }
        setDone(true)
        dfToast(props.toast || '已复制', 'ok', 1200)
        timer.current = setTimeout(function () { setDone(false) }, 1200)
      })
    },
  }, dfIcon(done ? 'check' : 'copy', 12), props.label ? h('span', null, props.label) : null)
}

function DfDrawer(props) {
  return h('div', { className: 'df-drawer' },
    h('div', { className: 'df-drawer-hd' },
      h('div', { className: 'df-drawer-t' },
        h('b', null, props.title || '详情'),
        props.sub ? h('div', { className: 'df-sub' }, props.sub) : null),
      props.actions || null,
      h('button', {
        type: 'button',
        className: 'df-btn df-btn--ghost df-btn--icon',
        title: '关闭（Esc）',
        'aria-label': '关闭',
        onClick: props.onClose,
      }, dfIcon('close', 14))),
    h('div', { className: 'df-drawer-bd' }, props.children))
}

function DfKV(props) {
  return h('dl', { className: 'df-kv' }, (props.rows || []).map(function (r, i) {
    return h(react.Fragment, { key: i },
      h('dt', null, r[0]),
      h('dd', null, r[2] ? r[1] : dfDash(r[1])))
  }))
}

/**
 * 快速预览卡（peek）：点列表行就地弹出，只显示 6 个关键字段 + 复制 + 「查看完整」。
 *
 * 用在「扫一眼」的场景：通道、凭证、会话这类，用户多数只想确认一两个字段，
 * 不值得为它开一整页。深度阅读的详情（漏洞、资产、成果）仍然走 DfDetailPage。
 */
function DfPeek(props) {
  const d = props.data
  if (!d) return null
  const all = d.rows || []
  const rows = all.slice(0, props.maxRows || 6)
  const text = [d.title || ''].concat(all.map(function (r) {
    return r[0] + '：' + (r[1] === undefined || r[1] === null || r[1] === '' ? '—' : r[1])
  })).join('\n')
  return h('div', {
    className: 'df-peek',
    style: props.style,
    role: 'dialog',
    'aria-label': d.title || '快速预览',
  },
    h('div', { className: 'df-peek-hd' },
      h('div', { className: 'df-peek-tt' },
        h('b', null, d.title || '详情'),
        d.sub ? h('small', null, d.sub) : null),
      h('button', {
        type: 'button', className: 'df-peek-x', title: '关闭（Esc）',
        onClick: props.onClose,
      }, dfIcon('close', 13))),
    h('div', { className: 'df-peek-bd' },
      rows.length ? h(DfKV, { rows: rows }) : h('div', { className: 'df-note' }, '这条没有字段摘要')),
    h('div', { className: 'df-peek-ft' },
      all.length > rows.length
        ? h('span', { className: 'df-peek-more' }, '还有 ' + (all.length - rows.length) + ' 项')
        : null,
      h('span', { className: 'dfx-spacer' }),
      h(DfCopyBtn, { text: text, label: '复制', toast: '已复制' }),
      props.onExpand
        ? h(DfBtn, { size: 'sm', kind: 'primary', onClick: props.onExpand }, '查看完整')
        : null))
}

/**
 * 整页详情（iOS push 式下钻）：点列表进来，左上角返回，内容占满宽度。
 *
 * 为什么默认用它而不是右侧抽屉：安全工程师要长时间读请求/响应、复制证据、
 * 来回对照，抽屉把内容挤在 380px 里且没有明确返回路径。国内习惯是「点进去 = 一层新页面」。
 *
 * 数据接口沿用抽屉的 `{ title, sub, rows, node }`，调用方只需加 `mode: 'page'`。
 */
function DfDetailPage(props) {
  const close = props.onClose || function () {}
  return h('div', {
    className: 'dfx-page',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': props.title || '详情',
  },
    h('header', { className: 'dfx-page-hd' },
      h('button', {
        type: 'button',
        className: 'dfx-page-back',
        title: '返回（Esc）',
        onClick: close,
      },
        h('svg', {
          width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        }, h('path', { d: 'M15 18l-6-6 6-6' })),
        h('span', null, '返回')),
      h('div', { className: 'dfx-page-tt' },
        h('b', null, props.title || '详情'),
        props.sub ? h('small', null, props.sub) : null),
      h('span', { className: 'dfx-spacer' }),
      props.actions || null),
    h('div', { className: 'dfx-page-bd' },
      props.head || null,
      props.rows && props.rows.length ? h(DfKV, { rows: props.rows }) : null,
      props.node || null))
}

function DfToastHost() {
  const list = dfUseToasts()
  if (!list.length) return null
  return h('div', { className: 'df-toasts' }, list.map(function (t) {
    return h('div', { key: t.id, className: 'df-toast df-toast--' + (t.kind || 'info') },
      h('span', { className: 'df-toast-i' }, dfIcon(t.kind === 'ok' ? 'check' : (t.kind === 'err' ? 'alert' : 'info'), 14)),
      h('span', null, t.text))
  }))
}

/**
 * 可排序表格。
 * columns: [{ key, title, width, align, sortable, mono, ellipsis, render(row) }]
 */
function DfTable(props) {
  const [sort, setSort] = useState(props.sort || null)
  const rows = props.rows || []
  const cols = (props.columns || []).filter(Boolean)

  const ordered = sort && sort.key
    ? dfSortBy(rows, function (r) {
      const col = cols.filter(function (c) { return c.key === sort.key })[0]
      return col && col.sortValue ? col.sortValue(r) : r[sort.key]
    }, sort.dir)
    : rows

  return h('table', { className: dfCx('df-table', props.density && 'df-table--' + props.density, props.className) },
    h('thead', null, h('tr', null, cols.map(function (c) {
      const sorted = sort && sort.key === c.key
      return h('th', {
        key: c.key,
        className: dfCx(c.sortable && 'df-sortable', sorted && 'df-sorted', c.className),
        /* 表头跟单元格同向对齐：数字列的值靠右，表头留在左边会看着像错位。 */
        style: c.width || c.align
          ? Object.assign({}, c.width ? { width: c.width } : {}, c.align === 'right' ? { textAlign: 'right' } : (c.align === 'center' ? { textAlign: 'center' } : {}))
          : null,
        onClick: c.sortable ? function () {
          setSort(function (cur) {
            if (cur && cur.key === c.key) return cur.dir === 'asc' ? { key: c.key, dir: 'desc' } : null
            return { key: c.key, dir: 'asc' }
          })
        } : undefined,
      }, c.title, c.sortable
        ? h('span', { className: 'df-sortico' }, dfIcon(sorted && sort.dir === 'desc' ? 'arrowDown' : 'arrowUp', 10))
        : null)
    }))),
    h('tbody', null, ordered.map(function (row, i) {
      const key = props.rowKey ? props.rowKey(row, i) : (row.id !== undefined ? row.id : i)
      const sel = props.selectedKey !== undefined && props.selectedKey === key
      return h('tr', {
        key: key,
        className: dfCx(props.onRow && 'df-row--click', sel && 'df-row--sel',
          props.rowClassName ? props.rowClassName(row) : null),
        tabIndex: props.onRow ? 0 : undefined,
        onClick: props.onRow ? function () { props.onRow(row) } : undefined,
        onKeyDown: props.onRow ? function (e) {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          props.onRow(row)
        } : undefined,
      }, cols.map(function (c) {
        return h('td', {
          key: c.key,
          className: dfCx(c.align === 'right' && 'df-num', c.align === 'center' && 'df-tight',
            c.mono && 'df-mono', c.ellipsis && 'df-ellip', c.className),
          style: c.align === 'center' ? { textAlign: 'center' } : (c.align === 'right' ? { textAlign: 'right' } : null),
        }, c.render ? c.render(row) : dfDash(row[c.key]))
      }))
    })))
}

/* ---------------------------------------------------------------- Markdown
   报告预览只认报告生成器实际会产出的语法：标题 / 表格 / 列表 / 引用 / 代码块 /
   图片占位 / 粗体 / 行内代码。**不解析 HTML**，AI 写进报告的内容只当文本，
   避免把面板变成注入点。 */

function dfMdInline(text) {
  const src = String(text === undefined || text === null ? '' : text).replace(/<br\s*\/?>/gi, ' / ')
  const out = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g
  let last = 0
  let m
  let i = 0
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push(src.slice(last, m.index))
    const tok = m[0]
    if (tok.slice(0, 2) === '**') out.push(h('b', { key: 'b' + i }, tok.slice(2, -2)))
    else if (tok.charAt(0) === '`') out.push(h('code', { key: 'c' + i }, tok.slice(1, -1)))
    else out.push(h('em', { key: 'e' + i }, tok.slice(1, -1)))
    last = m.index + tok.length
    i += 1
  }
  if (last < src.length) out.push(src.slice(last))
  return out
}

function dfMdBlockStart(line) {
  return /^\s*$/.test(line)
    || /^#{1,6}\s/.test(line)
    || /^```/.test(line.trim())
    || /^>\s?/.test(line)
    || /^\s*([-*]|\d+\.)\s+/.test(line)
    || /^\s*\|/.test(line)
    || /^!\[[^\]]*\]\([^)]+\)\s*$/.test(line.trim())
    || /^\s*---+\s*$/.test(line)
}

function DfMarkdown(props) {
  const lines = String(props.source || '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let i = 0
  let key = 0
  const parseRow = function (s) {
    return s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (x) { return x.trim() })
  }

  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*$/.test(line)) { i += 1; continue }

    if (/^```/.test(line.trim())) {
      const buf = []
      i += 1
      while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i += 1 }
      i += 1
      blocks.push(h('pre', { key: key, className: 'df-md-code' }, h('code', null, buf.join('\n'))))
      key += 1
      continue
    }

    const hm = /^(#{1,6})\s+(.*)$/.exec(line)
    if (hm !== null) {
      const lvl = Math.min(hm[1].length, 4)
      blocks.push(h('h' + lvl, { key: key }, dfMdInline(hm[2])))
      key += 1
      i += 1
      continue
    }

    if (/^\s*---+\s*$/.test(line)) {
      blocks.push(h('hr', { key: key }))
      key += 1
      i += 1
      continue
    }

    const im = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line.trim())
    if (im !== null) {
      const file = String(im[2]).split(/[\\/]/).pop()
      blocks.push(h('figure', { key: key, className: 'df-md-fig' },
        h('figcaption', null,
          dfIcon('image', 12),
          h('b', null, im[1] || '证据截图'),
          h('code', { title: im[2] }, dfShort(file, 46)))))
      key += 1
      i += 1
      continue
    }

    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const head = parseRow(line)
      i += 2
      const rows = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(parseRow(lines[i])); i += 1 }
      blocks.push(h('div', { key: key, className: 'df-md-tblwrap' },
        h('table', { className: 'df-md-tbl' },
          h('thead', null, h('tr', null, head.map(function (c, ci) {
            return h('th', { key: ci }, dfMdInline(c))
          }))),
          h('tbody', null, rows.map(function (r, ri) {
            return h('tr', { key: ri }, r.map(function (c, ci) {
              return h('td', { key: ci }, dfMdInline(c))
            }))
          })))))
      key += 1
      continue
    }

    if (/^>\s?/.test(line)) {
      const buf = []
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i += 1 }
      blocks.push(h('blockquote', { key: key }, dfMdInline(buf.join(' '))))
      key += 1
      continue
    }

    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line)
      const items = []
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''))
        i += 1
      }
      blocks.push(h(ordered ? 'ol' : 'ul', { key: key }, items.map(function (t, ii) {
        return h('li', { key: ii }, dfMdInline(t))
      })))
      key += 1
      continue
    }

    const buf = [line]
    i += 1
    while (i < lines.length && !dfMdBlockStart(lines[i])) { buf.push(lines[i]); i += 1 }
    blocks.push(h('p', { key: key }, dfMdInline(buf.join(' '))))
    key += 1
  }

  if (blocks.length === 0) {
    return h(DfEmpty, { icon: 'fileText', title: '报告还没有内容', hint: '先记录成果与证据，再回来生成。' })
  }
  return h('div', { className: 'df-md' }, blocks)
}



/* ---- lib/client/26-layers.js ---- */
/* 提示词生效链路：把宿主真实存在的三层机制画成一条竖排链路。
   这里不读数据、不发请求，只负责把「是什么、管多大范围、何时生效、能不能改」摆清楚。
   宿主没有「用户级 agent / 项目级 agent」这两层：AGENTS.md 是工作区指令，不是 agent。 */

const DF_PROMPT_LAYERS = [
  {
    id: 'system', no: '01',
    title: '系统提示词', role: 'system 角色', scope: 'Agent 预设',
    purpose: '决定它是谁、能用哪些工具',
    items: [
      { label: '部署身份' },
      { label: '模式与工具' },
      { label: '主智能体人格', edit: true },
    ],
    when: '重启后生效', page: 'agents', pageLabel: '智能体',
  },
  {
    id: 'workspace', no: '02',
    title: '工作区指令', role: 'user 角色', scope: '当前工作目录',
    purpose: '补充这个项目里的做法与约束',
    items: [
      { label: '用户级' },
      { label: '共享级' },
      { label: '项目根' },
      { label: '上级目录' },
      { label: '当前目录' },
    ],
    when: '下一轮生效', page: 'instructions', pageLabel: '工作区指令',
  },
  {
    id: 'sub', no: '03',
    title: '子智能体会话', role: '继承预设', scope: '派发时创建',
    purpose: '不重设身份，只带任务与角色稿',
    items: [
      { label: '继承的预设' },
      { label: '任务提示词' },
      { label: '子智能体角色', edit: true },
    ],
    when: '派发时生效', page: 'agents', pageLabel: '智能体',
  },
]

function DfPromptLayers(props) {
  const focus = Array.isArray(props.focus) ? props.focus : (props.focus ? [props.focus] : [])
  const compact = props.compact === true

  function goto(id) {
    if (props.onGoto) props.onGoto(id)
  }

  return h('section', { className: dfCx('df-layers', compact && 'df-layers--compact') },
    h('div', { className: 'df-layers-hd' },
      dfIcon('layers', 14),
      h('b', null, props.title || '提示词生效链路'),
      props.note ? h('span', { className: 'df-layers-note' }, props.note) : null),

    h('div', { className: 'df-layers-body' }, DF_PROMPT_LAYERS.map(function (l) {
      const on = focus.indexOf(l.id) !== -1
      const canGo = !on && props.onGoto && l.page
      return h('div', {
        key: l.id,
        className: dfCx('df-layer', on && 'is-focus', canGo && 'is-link'),
        role: canGo ? 'button' : undefined,
        tabIndex: canGo ? 0 : undefined,
        onClick: canGo ? function () { goto(l.page) } : undefined,
        onKeyDown: canGo ? function (e) {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          goto(l.page)
        } : undefined,
      },
        h('div', { className: 'df-layer-no' }, l.no),

        h('div', { className: 'df-layer-main' },
          h('div', { className: 'df-layer-hd' },
            h('b', null, l.title),
            h('span', { className: 'df-layer-role' }, l.role),
            h('span', { className: 'df-layer-scope' }, l.scope),
            on ? h('span', { className: 'df-layer-here' }, '本页') : null),
          compact
            ? null
            : h('div', { className: 'df-layer-purpose' }, l.purpose),
          compact
            ? null
            : h('div', { className: 'df-layer-items' }, l.items.map(function (it) {
              return h('span', { key: it.label, className: dfCx('df-layer-item', it.edit && 'is-edit') },
                it.edit ? h('i', null) : null, it.label)
            }))),

        h('div', { className: 'df-layer-side' },
          h('span', { className: 'df-layer-when' }, dfIcon('clock', 11), l.when),
          canGo ? h('span', { className: 'df-layer-go' }, l.pageLabel + ' ›') : null))
    })),

    h('div', { className: 'df-layers-ft' },
      props.foot || '优先级：系统提示词高于工作区指令；工作区指令从宽泛到具体拼接，预算不足时先截断宽泛段。'))
}


/* ---- lib/client/30-app.js ---- */
/* 新外壳：几何、顶栏、分组导航、靶标、命令面板、抽屉、Toast。
   其它视图在 32-ops.js / 33-deliver.js / 35-knowledge.js；这里只做容器与全局交互。 */

/* 导航按「工作频率」排位，而不是按功能归类整齐排：
   作业（每轮都用）→ 交付（收尾才用）→ 资源（按需查）→ 配置（偶尔改）。
   组内同理：概览/资产/漏洞在前，日志这种排障用的垫底。
   这张表是固定的 —— 不做「最近访问自动置顶」，位置一旦记住就不该再变。 */
const DF_NAV = [
  { key: 'ops', label: '作业', items: [
    { key: 'overview', label: '概览', icon: 'grid' },
    { key: 'assets', label: '资产', icon: 'server' },
    { key: 'vulns', label: '漏洞', icon: 'bug' },
    { key: 'chain', label: '攻击链', icon: 'route' },
    { key: 'sessions', label: '通道', icon: 'link' },
    { key: 'log', label: '日志', icon: 'list' },
  ] },
  { key: 'deliver', label: '交付', items: [
    { key: 'score', label: '成果', icon: 'star' },
    { key: 'report', label: '报告', icon: 'fileText' },
  ] },
  { key: 'res', label: '资源', items: [
    { key: 'knowledge', label: '知识库', icon: 'book' },
    { key: 'skills', label: '技能库', icon: 'spark' },
    { key: 'tools', label: '工具', icon: 'wrench' },
  ] },
  { key: 'cfg', label: '配置', items: [
    { key: 'prompts', label: '提示词', icon: 'shield' },
    { key: 'env', label: '环境', icon: 'sliders' },
    { key: 'maintenance', label: '维护', icon: 'wrench' },
  ] },
]

/* 旧页名继续可用：外部跳转 / 老 localStorage / 顶栏提示条仍可能传这些 key。
   进入时统一落到「提示词」工作台，并带上默认层。 */
const DF_PROMPT_ALIASES = {
  inject: 'inject',
  agents: 'persona',
  persona: 'persona',
  roles: 'roles',
  instructions: 'instructions',
  context: 'context',
  'context-crack': 'context-crack',
  contextCrack: 'context-crack',
}

const DF_VIEWS = DF_NAV.reduce(function (acc, g) {
  g.items.forEach(function (it) { acc.push(Object.assign({ group: g.label }, it)) })
  return acc
}, [])

const DF_VIEW_KEYS = DF_VIEWS.map(function (v) { return v.key })

/* 未读红点：视图 key → digest 分区（方向不能反：hasNew(view) 用视图查分区） */
const DF_DIGEST_MAP = {
  assets: 'assets', vulns: 'findings', chain: 'chain', sessions: 'sessions',
  knowledge: 'knowledge', score: 'score', report: 'report',
  prompts: 'prompts', skills: 'skills',
}

const DF_KEY_GEOM = 'dsh-forge-client-geom-v4'
const DF_KEY_VIEW = 'dsh-forge-client-view-v4'
const DF_KEY_PROMPT_LAYER = 'dsh-forge-client-prompt-layer-v1'
const DF_KEY_ZOOM = 'dsh-forge-client-zoom-v4'
const DF_KEY_DRAWER = 'dsh-forge-client-drawer-v4'
const DF_KEY_SEEN = 'dsh-forge-client-seen-v4'
/* 侧栏是否收起。null = 跟随窗口宽度自动决定；true/false = 用户自己定过。 */
const DF_KEY_NAV = 'dsh-forge-client-nav-v5'
/* 沉浸模式：侧栏整个让出去，鼠标贴左边缘才浮出来。低频设置，单独存。 */
const DF_KEY_IMM = 'dsh-forge-client-immersive-v5'
const DF_ZOOM_STEPS = [0.85, 0.92, 1, 1.1, 1.2, 1.35, 1.5]

function dfLoadJson(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch (e) { return fallback }
}

function dfSaveJson(key, value) {
  try { window.localStorage.setItem(key, JSON.stringify(value)) } catch (e) { /* 隐私模式忽略 */ }
}

function dfViewport() {
  const root = document.getElementById('dsh-forge-client-root')
  let vw = root ? root.clientWidth : 0
  let vh = root ? root.clientHeight : 0
  if (!vw || vw < 400) vw = window.innerWidth || (typeof screen !== 'undefined' && screen.availWidth) || 1280
  if (!vh || vh < 300) vh = window.innerHeight || (typeof screen !== 'undefined' && screen.availHeight) || 800
  return { vw: vw, vh: vh }
}

function dfClampGeom(g, vw, vh) {
  const maxW = Math.max(360, vw - 16)
  const maxH = Math.max(280, vh - 24)
  const minW = Math.min(720, maxW)
  const minH = Math.min(460, maxH)
  const w = Math.min(Math.max(g.w || minW, minW), maxW)
  const hh = Math.min(Math.max(g.h || minH, minH), maxH)
  const x = Math.min(Math.max(8, g.x === undefined ? 8 : g.x), Math.max(8, vw - w - 8))
  const y = Math.min(Math.max(48, g.y === undefined ? 48 : g.y), Math.max(48, vh - hh - 8))
  return { x: x, y: y, w: w, h: hh }
}

function dfFullGeom(vw, vh) {
  return { x: 8, y: 48, w: Math.max(360, vw - 16), h: Math.max(280, vh - 56) }
}

function dfDefaultGeom() {
  const vp = dfViewport()
  const saved = dfLoadJson(DF_KEY_GEOM, null)
  if (saved && saved.w && saved.h) {
    return { geom: dfClampGeom(saved.maxed ? dfFullGeom(vp.vw, vp.vh) : saved, vp.vw, vp.vh), maxed: !!saved.maxed }
  }
  const w = Math.min(Math.max(900, Math.round(vp.vw * 0.84)), Math.max(360, vp.vw - 32), 1360)
  const hh = Math.min(Math.max(560, Math.round(vp.vh * 0.8)), Math.max(280, vp.vh - 72))
  return { geom: dfClampGeom({ x: Math.max(16, vp.vw - w - 32), y: 56, w: w, h: hh }, vp.vw, vp.vh), maxed: false }
}

/** 小窗口自动缩一档；用户手动选过就按用户的来。 */
function dfAutoZoom(vp) {
  if (vp.vw < 1000 || vp.vh < 640) return 0.88
  if (vp.vw < 1200 || vp.vh < 780) return 0.94
  return 1
}

const DF_PANEL_BUS = { open: null }

function DfApp(props) {
  const [open, setOpen] = useState(false)
  const [authOpen, setAuthOpen] = useState(false)
  const [pendingView, setPendingView] = useState('')
  const [navRequest, setNavRequest] = useState(null)
  /* 须知没读完之前不叠授权窗：两层遮罩只会让人不知道该点哪个。 */
  const [noticeAck, setNoticeAck] = useState(function () { return dfReadNoticeAck() })
  /* 右下角「安全」前面的圆点：红=未生效，绿=已生效。8 秒轮询，切会话/模式后能自己变。 */
  const [injectStatus, setInjectStatus] = useState(null)

  useEffect(function () {
    let alive = true
    function load() {
      dfHost('/dsh-forge/inject').then(function (r) {
        if (alive) setInjectStatus(r || { ok: false })
      }, function () {
        if (alive) setInjectStatus({ ok: false })
      })
    }
    load()
    const off = dfBustSubscribe(load)
    const timer = window.setInterval(function () {
      if (!document.hidden) load()
    }, 8000)
    return function () {
      alive = false
      off()
      window.clearInterval(timer)
    }
  }, [])

  const requestOpen = useCallback(function (view) {
    if (!dfAuthGranted()) {
      setPendingView(String(view || ''))
      setAuthOpen(true)
      return
    }
    setOpen(true)
    if (view) setNavRequest({ view: view, at: Date.now() })
  }, [])

  const toggle = useCallback(function () {
    if (open) { setOpen(false); return }
    requestOpen('')
  }, [open, requestOpen])

  useEffect(function () {
    if (props.ctx) {
      dfInstallHost(props.ctx)
      dfAuthSync()
    }
    DF_PANEL_BUS.open = requestOpen
    return function () {
      if (DF_PANEL_BUS.open === requestOpen) DF_PANEL_BUS.open = null
    }
  }, [requestOpen, props.ctx])

  useEffect(function () {
    const onKey = function (e) {
      if (!e.altKey || !(e.key === 's' || e.key === 'S')) return
      const tag = String((e.target && e.target.tagName) || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      e.preventDefault()
      toggle()
    }
    window.addEventListener('keydown', onKey)
    return function () { window.removeEventListener('keydown', onKey) }
  }, [toggle])

  function granted() {
    setAuthOpen(false)
    setOpen(true)
    if (pendingView) setNavRequest({ view: pendingView, at: Date.now() })
    setPendingView('')
  }

  const injectView = dfInjectView(injectStatus)
  const injectKnown = injectStatus && injectStatus.ok !== false
  const injectTone = !injectKnown ? 'warn' : injectView.active ? 'ok' : 'err'
  const injectDot = injectTone === 'ok' ? 'var(--df-ok-solid)' : injectTone === 'warn' ? 'var(--df-warn-solid)' : 'var(--df-err-solid)'
  const injectGlow = injectTone === 'ok' ? 'var(--df-ok-soft)' : injectTone === 'warn' ? 'var(--df-warn-soft)' : 'var(--df-err-soft)'
  const injectLabel = !injectKnown ? '破甲状态读取中'
    : injectView.active ? '破甲注入已生效'
      : !injectView.hasContent ? '破甲注入正文为空'
        : !injectView.enabled ? '破甲注入已关闭'
          : !injectView.covered ? '当前为' + dfModeLabel(injectView.mode) + '，不注入'
            : '破甲注入未生效'

  return h(react.Fragment, null,
    h('button', {
      className: 'dfx-launch',
      type: 'button',
      title: '安全面板（Alt+S） · ' + injectLabel,
      onClick: toggle,
    }, h('span', { className: 'df-dot', style: { background: injectDot, boxShadow: '0 0 0 3px ' + injectGlow } }), '安全'),
    open
      ? h(DfDock, {
        navRequest: navRequest,
        onClose: function () { setOpen(false) },
      })
      : null,
    h(DfWelcomeNotice, { onAck: function () { setNoticeAck(true) } }),
    authOpen && noticeAck
      ? h(DfAuthGate, {
        pending: pendingView,
        onCancel: function () { setAuthOpen(false); setPendingView('') },
        onGranted: granted,
      })
      : null)
}

function DfDock(props) {
  const initial = useRef(dfDefaultGeom()).current
  const [geom, setGeom] = useState(initial.geom)
  const [maxed, setMaxed] = useState(initial.maxed)
  const [vp, setVp] = useState(dfViewport)
  const [initialRoute] = useState(function () {
    const saved = dfLoadJson(DF_KEY_VIEW, 'overview')
    if (saved === 'prompts') {
      const layer = dfLoadJson(DF_KEY_PROMPT_LAYER, 'inject')
      return { view: 'prompts', layer: DF_PROMPT_ALIASES[layer] || 'inject' }
    }
    if (DF_PROMPT_ALIASES[saved]) return { view: 'prompts', layer: DF_PROMPT_ALIASES[saved] }
    return { view: DF_VIEW_KEYS.indexOf(saved) >= 0 ? saved : 'overview', layer: 'inject' }
  })
  const [view, setView] = useState(initialRoute.view)
  const [promptLayer, setPromptLayer] = useState(initialRoute.layer)
  const [zoomPref, setZoomPref] = useState(function () {
    const saved = dfLoadJson(DF_KEY_ZOOM, null)
    return typeof saved === 'number' && saved >= 0.6 && saved <= 2 ? saved : null
  })
  const [drawerW, setDrawerW] = useState(function () {
    const saved = dfLoadJson(DF_KEY_DRAWER, 380)
    return typeof saved === 'number' ? Math.min(620, Math.max(320, saved)) : 380
  })
  const [eng, setEng] = useState('')
  const [tick, setTick] = useState(0)
  /* 破甲注入状态是全局的：顶栏徽标和页面顶部提示条共用一份，避免各拉一次。 */
  const injectState = dfUseAsync(function () {
    return dfHost('/dsh-forge/inject')
  }, [tick])
  const [drawer, setDrawer] = useState(null)
  /* 快速预览卡：不占主区域，点行就地弹出；深度详情才切整页。 */
  const [peek, setPeek] = useState(null)
  const [peekAt, setPeekAt] = useState({ top: 120, left: 120, width: 360 })
  const lastRowRect = useRef(null)
  /* 矩阵行 → 资产页：带着目标资产 id 过去，到页面后自动打开它的抽屉。 */
  const [assetFocus, setAssetFocus] = useState('')
  const [palette, setPalette] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [navPref, setNavPref] = useState(function () { return dfLoadJson(DF_KEY_NAV, null) })
  const [immersive, setImmersive] = useState(function () { return dfLoadJson(DF_KEY_IMM, false) === true })
  const [digest, setDigest] = useState(null)
  const [seen, setSeen] = useState(function () { return dfLoadJson(DF_KEY_SEEN, {}) })
  /* 已经打开过的页：只藏不卸。回来时状态全在，不用重新请求。 */
  const [panes, setPanes] = useState(function () { return [view] })
  /* 每一页各自的滚动位置：切回来还停在原处。 */
  const scrollMemRef = useRef({})
  const engSeenRef = useRef('')

  const dragRef = useRef(null)
  const geomRef = useRef(geom)
  geomRef.current = geom
  /* 抽屉宽度在缩放后的坐标系里，拖拽位移要按缩放折算。 */
  const zoomRef = useRef(1)
  const preMaxRef = useRef(null)
  /* 面板根节点 + 上一次「画好的」主区快照，切页时用来铺残影。 */
  const containerRef = useRef(null)
  /* 上一次画好的内容：切页那一刻把它拷进残影层，等新页真正有东西了再撤。 */
  const lastMainRef = useRef(null)
  /* 残影最多顶多久。过了这段时间还没内容，就让它退场，换成页面自己的加载态 ——
     否则点了「维护」五秒不动，用户会以为点空了。 */
  const holdTimerRef = useRef(0)

  /* 顶栏宽度是硬约束：缩放调高或窗口变窄时，右侧的窗控（最大化/关闭）不能被
     dock 的 overflow 裁掉。按实测 scrollWidth 逐级收内容，比按窗口宽度猜阈值可靠。 */
  const headRef = useRef(null)
  const fitHead = useCallback(function () {
    const head = headRef.current
    if (!head) return
    head.removeAttribute('data-hd')
    let level = 0
    while (level < 3 && head.scrollWidth > head.clientWidth + 1) {
      level += 1
      head.setAttribute('data-hd', String(level))
    }
  }, [])

  /* 每轮渲染后重量：档位名、靶标名、环境文案都会改变顶栏占宽。 */
  useLayoutEffect(function () { fitHead() })

  useEffect(function () {
    let ro = null
    const head = headRef.current
    if (head && typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(function () { fitHead() })
      ro.observe(head)
    }
    window.addEventListener('resize', fitHead)
    return function () {
      if (ro) ro.disconnect()
      window.removeEventListener('resize', fitHead)
    }
  }, [fitHead])

  /* 打开过就留着：离开的页不卸载，切回来是「原样回来」。 */
  useEffect(function () {
    setPanes(function (cur) { return cur.indexOf(view) >= 0 ? cur : cur.concat([view]) })
  }, [view])

  /* 写操作会清缓存：让所有常驻页一起重取，别让后台那张停旧数据。 */
  useEffect(function () {
    return dfBustSubscribe(function () { setTick(function (t) { return t + 1 }) })
  }, [])

  /* 换靶标等于换了一整套数据：只留当前页，其余重新来过，
     否则会看到上一个靶标的内容。 */
  useEffect(function () {
    if (engSeenRef.current === eng) return
    engSeenRef.current = eng
    setPanes([view])
    scrollMemRef.current = {}
  }, [eng])

  /* 切回来时把滚动位置还原 —— 常驻页的意义就在这里，不是「重新打开」而是「回到原处」。 */
  useEffect(function () {
    const root = containerRef.current
    const main = root && root.querySelector('.dfx-main')
    if (!main) return
    main.scrollTop = scrollMemRef.current[view] || 0
  }, [view])

  /* 每次渲染后记下「画好的」内容 —— 点击切页那一刻它就是上一帧。
     注意：卡片壳出现了不算画好（维护页的壳一直在、里面还是骨架）。 */
  useEffect(function () {
    const root = containerRef.current
    const content = dfPaneContent(root)
    if (dfIsPainted(content)) lastMainRef.current = content
  })

  /* 视图画出真实内容后，把残影收掉，并记成下一次的「上一帧」。
     用 MutationObserver 等内容出现，不轮询。
     依赖里必须有 panes：新页是先渲染出 pane 再进 DOM 的，
     只看 view 的话这个 effect 会跑在「那一页还不存在」的那一帧，然后就再也不动了。 */
  useEffect(function () {
    const root = containerRef.current
    const content = dfPaneContent(root)
    if (!content) return undefined
    const settle = function () {
      if (holdTimerRef.current) { window.clearTimeout(holdTimerRef.current); holdTimerRef.current = 0 }
      lastMainRef.current = content
      root.querySelectorAll('.dfx-frame').forEach(dfFrameClear)
    }
    if (dfIsPainted(content)) { settle(); return undefined }
    const obs = new MutationObserver(function () {
      if (!dfIsPainted(content)) return
      obs.disconnect()
      settle()
    })
    obs.observe(content, { childList: true, subtree: true, attributes: true })
    return function () { obs.disconnect() }
  }, [view, eng, tick, panes])

  /* 从门禁/环境窗跳进来时换页（同一个对象引用只触发一次）。 */
  useEffect(function () {
    const req = props.navRequest
    if (!req || !req.view) return
    const alias = DF_PROMPT_ALIASES[req.view]
    if (alias) {
      setPromptLayer(alias)
      setView('prompts')
      return
    }
    if (DF_VIEW_KEYS.indexOf(req.view) >= 0) setView(req.view)
  }, [props.navRequest])

  const boot = dfUseAsync(function () { return dfBootstrap(true) }, [tick])

  const engagements = (boot.data && boot.data.engagements) || []
  const current = engagements.filter(function (e) { return e.id === eng })[0] || null

  useEffect(function () {
    if (!boot.data) return
    const list = boot.data.engagements || []
    const usable = list.filter(function (e) { return !e.broken })
    const fallback = boot.data.current || (usable[0] && usable[0].id) || ''
    if (!fallback) {
      /* 只剩缺库残骸时不要把它当当前靶标，否则每个页面都会打开失败；让它留在列表里可删。 */
      if (eng) setEng('')
      return
    }
    /* 跟随全局/模型当前靶标：会话里 open/bind 了新靶标，面板不用再手动切一次。 */
    const stale = !eng || !usable.some(function (e) { return e.id === eng })
    const moved = Boolean(boot.data.current) && String(boot.data.current) !== eng
    if (stale || moved) setEng(String(fallback))
  }, [boot.data])

  useEffect(function () { dfSaveJson(DF_KEY_VIEW, view) }, [view])
  useEffect(function () { dfSaveJson(DF_KEY_PROMPT_LAYER, promptLayer) }, [promptLayer])
  useEffect(function () {
    const id = setTimeout(function () {
      dfSaveJson(DF_KEY_GEOM, Object.assign({}, geom, { maxed: maxed }))
    }, 260)
    return function () { clearTimeout(id) }
  }, [geom, maxed])
  useEffect(function () { dfSaveJson(DF_KEY_ZOOM, zoomPref) }, [zoomPref])
  useEffect(function () { dfSaveJson(DF_KEY_DRAWER, drawerW) }, [drawerW])

  /* ── 视口变化 ────────────────────────────────────────────── */
  useEffect(function () {
    let timer = 0
    const apply = function () {
      const next = dfViewport()
      /* 布局抖动时会短暂量到极小尺寸：忽略，避免把面板夹成最小值。 */
      if (next.vw < 320 || next.vh < 240) return
      setVp(next)
      setGeom(function (g) { return dfClampGeom(maxed ? dfFullGeom(next.vw, next.vh) : g, next.vw, next.vh) })
    }
    const schedule = function () {
      if (timer) clearTimeout(timer)
      timer = setTimeout(apply, 180)
    }
    window.addEventListener('resize', schedule)
    let ro = null
    try {
      const root = document.getElementById('dsh-forge-client-root')
      if (root && typeof ResizeObserver === 'function') {
        ro = new ResizeObserver(schedule)
        ro.observe(root)
      }
    } catch (e) { /* 没有 ResizeObserver 就只靠 resize */ }
    return function () {
      if (timer) clearTimeout(timer)
      window.removeEventListener('resize', schedule)
      if (ro) ro.disconnect()
    }
  }, [maxed])

  /* ── 拖拽 / 缩放 / 抽屉宽度 ──────────────────────────────── */
  useEffect(function () {
    const apply = dfRaf(function (next) { setGeom(next) })
    const applyDrawer = dfRaf(function (w) { setDrawerW(w) })

    const onMove = function (e) {
      const d = dragRef.current
      if (!d) return
      if (d.mode === 'drawer') {
        const z = zoomRef.current || 1
        applyDrawer(Math.min(620, Math.max(320, d.dw - (e.clientX - d.sx) / z)))
        return
      }
      const next = dfViewport()
      if (d.mode === 'move') {
        if (d.maxed) {
          /* 最大化时拖标题：第一次真正移动才还原到最大化前的尺寸，避免单击标题就跳窗。 */
          const back = dfClampGeom(preMaxRef.current || { x: 24, y: 56, w: 1100, h: 760 }, next.vw, next.vh)
          d.maxed = false
          d.gx = back.x
          d.gy = back.y
          d.gw = back.w
          d.gh = back.h
          d.sx = e.clientX
          d.sy = e.clientY
          setMaxed(false)
          setGeom(back)
          return
        }
        const raw = { x: d.gx + (e.clientX - d.sx), y: d.gy + (e.clientY - d.sy), w: d.gw, h: d.gh }
        apply(dfClampGeom(raw, next.vw, next.vh))
      } else {
        const raw = {
          x: d.gx, y: d.gy,
          w: d.axis === 'h' ? d.gw : d.gw + (e.clientX - d.sx),
          h: d.axis === 'w' ? d.gh : d.gh + (e.clientY - d.sy),
        }
        apply(dfClampGeom(raw, next.vw, next.vh))
      }
    }
    const onUp = function () {
      const d = dragRef.current
      if (!d) return
      dragRef.current = null
      if (d.mode === 'drawer') dfSaveJson(DF_KEY_DRAWER, drawerW)
      else dfSaveJson(DF_KEY_GEOM, Object.assign({}, geomRef.current, { maxed: maxed }))
    }
    document.addEventListener('pointermove', onMove, { passive: true })
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onUp)
    return function () {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onUp)
      apply.cancel()
      applyDrawer.cancel()
    }
  }, [maxed, drawerW])

  function startMove(e) {
    if (e.button !== 0) return
    const el = e.target
    if (el && el.closest && el.closest('button, input, select, textarea, a, [data-nodrag]')) return
    const g = geomRef.current
    dragRef.current = { mode: 'move', maxed: maxed, sx: e.clientX, sy: e.clientY, gx: g.x, gy: g.y, gw: g.w, gh: g.h }
    e.preventDefault()
  }

  function startResize(e, axis) {
    if (e.button !== 0) return
    const g = geomRef.current
    dragRef.current = { mode: 'resize', axis: axis, sx: e.clientX, sy: e.clientY, gx: g.x, gy: g.y, gw: g.w, gh: g.h }
    e.preventDefault()
    e.stopPropagation()
  }

  function startDrawerResize(e) {
    if (e.button !== 0) return
    /* 以当前实际显示宽度为基准：极窄/窄窗里宽度的上限更低，
       不先归位的话会出现「往左拖不动、往右拖一下才动」的死区。 */
    const base = Math.min(drawerW, sideW)
    if (base !== drawerW) {
      setDrawerW(base)
      dfSaveJson(DF_KEY_DRAWER, base)
    }
    dragRef.current = { mode: 'drawer', sx: e.clientX, dw: base }
    e.preventDefault()
    e.stopPropagation()
  }

  function toggleMax() {
    const next = dfViewport()
    if (maxed) {
      const back = preMaxRef.current || dfClampGeom({ x: 24, y: 56, w: 1100, h: 760 }, next.vw, next.vh)
      setMaxed(false)
      setGeom(dfClampGeom(back, next.vw, next.vh))
    } else {
      preMaxRef.current = geomRef.current
      setMaxed(true)
      setGeom(dfClampGeom(dfFullGeom(next.vw, next.vh), next.vw, next.vh))
    }
  }

  const refresh = useCallback(function () {
    dfBust()
    setTick(function (t) { return t + 1 })
    setRefreshing(true)
    setTimeout(function () { setRefreshing(false) }, 650)
  }, [])

  /* ── 未读：45s 轮询 digest；当前页自动已读 ─────────────── */
  useEffect(function () {
    if (!eng) { setDigest(null); return undefined }
    let alive = true
    const pull = function () {
      if (document.hidden) return
      dfApi('consoleDigest', { engagement: eng }, { ttl: 0, force: true }).then(function (r) {
        if (alive && r && r.ok !== false) setDigest(r)
      })
    }
    pull()
    const id = setInterval(pull, 45000)
    return function () { alive = false; clearInterval(id) }
  }, [eng, tick])

  useEffect(function () {
    if (!eng || !digest) return
    const at = digest.sections && digest.sections[DF_DIGEST_MAP[view]] && digest.sections[DF_DIGEST_MAP[view]].at
    if (!at) return
    const per = seen[eng] || {}
    if (per[DF_DIGEST_MAP[view]] === at) return
    const next = Object.assign({}, seen)
    next[eng] = Object.assign({}, per)
    next[eng][DF_DIGEST_MAP[view]] = at
    setSeen(next)
    dfSaveJson(DF_KEY_SEEN, next)
  }, [view, eng, digest])

  function hasNew(viewKey) {
    if (!eng || !digest) return false
    const section = DF_DIGEST_MAP[viewKey]
    if (!section) return false
    const at = digest.sections && digest.sections[section] && digest.sections[section].at
    if (!at) return false
    return (seen[eng] || {})[section] !== at
  }

  /* ── 靶标操作 ────────────────────────────────────────────── */
  const [targetBusy, setTargetBusy] = useState(false)

  function switchTarget(id) {
    if (!id || id === eng) return
    setTargetBusy(true)
    dfApi('activateEngagement', { engagement: id }).then(function (r) {
      setTargetBusy(false)
      if (!r || r.ok === false) { dfToast((r && r.error) || '切换失败', 'err', 4000); return }
      dfBust()
      setEng(String(id))
      setDrawer(null)
      setTick(function (t) { return t + 1 })
      dfToast('已切换靶标', 'ok', 1600)
    })
  }

  function createTarget(name, list) {
    setTargetBusy(true)
    dfApi('openEngagement', { name: name, scope: list }).then(function (r) {
      setTargetBusy(false)
      if (!r || r.ok === false) { dfToast((r && r.error) || '创建失败', 'err', 4200); return }
      const id = r.engagement && r.engagement.id
      dfBust()
      setEng(String(id || ''))
      setDrawer(null)
      setTick(function (t) { return t + 1 })
      dfToast('已创建靶标：' + (name || id), 'ok', 2200)
    })
  }

  function deleteTarget(id, force, onDone) {
    setTargetBusy(true)
    dfApi('deleteEngagement', { engagement: id, confirm: id, force: !!force }).then(function (r) {
      setTargetBusy(false)
      if (!r || r.ok === false) {
        dfToast((r && r.error) || '删除失败', 'err', 5000)
        if (onDone) onDone(false)
        return
      }
      dfBust()
      const rest = engagements.filter(function (e) { return e.id !== id })
      const next = rest.filter(function (e) { return !e.broken })[0] || rest[0]
      setEng(next ? String(next.id) : '')
      setDrawer(null)
      setTick(function (t) { return t + 1 })
      if (next) dfToast('已删除靶标，已切到「' + (next.name || next.id) + '」', 'ok', 2400)
      else dfToast('已删除靶标', 'ok', 2000)
      if (onDone) onDone(true)
    })
  }

  function deleteTargets(ids, force, onDone) {
    const list = Array.isArray(ids) ? ids.map(String).filter(Boolean) : []
    if (!list.length) { if (onDone) onDone(false); return }
    setTargetBusy(true)
    dfApi('deleteEngagements', { engagements: list, confirm: true, force: !!force }).then(function (r) {
      setTargetBusy(false)
      const deleted = (r && Array.isArray(r.deleted)) ? r.deleted : []
      if ((!r || r.ok === false) && deleted.length === 0) {
        dfToast((r && r.error) || '批量删除失败', 'err', 5200)
        if (onDone) onDone(false)
        return
      }
      dfBust()
      const gone = new Set(r.deleted || list)
      const rest = engagements.filter(function (e) { return !gone.has(e.id) })
      const stillCurrent = rest.filter(function (e) { return e.id === eng && !e.broken })[0]
      const next = stillCurrent || rest.filter(function (e) { return !e.broken })[0] || rest[0]
      setEng(next ? String(next.id) : '')
      setDrawer(null)
      setTick(function (t) { return t + 1 })
      const n = (r.deleted || []).length || list.length
      const failed = Array.isArray(r.failed) ? r.failed : []
      dfToast('已删除 ' + n + ' 个靶标'
        + (failed.length ? '，' + failed.length + ' 个失败：' + failed.map(function (x) { return x.id }).join('、') : '')
        + (next ? '；已切到「' + (next.name || next.id) + '」' : ''), failed.length ? 'warn' : 'ok', 3200)
      if (onDone) onDone(true)
    })
  }

  /* ── 键盘 ────────────────────────────────────────────────── */
  useEffect(function () {
    const onKey = function (e) {
      const tag = String((e.target && e.target.tagName) || '').toLowerCase()
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select'
      if (dfModKey(e) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setPalette(function (p) { return !p })
        return
      }
      if (e.key === 'Escape') {
        if (palette) { setPalette(false); return }
        /* 弹窗（须知 / 授权）开着时 Esc 归弹窗，别顺手把面板也关了。 */
        if (document.querySelector('.df-modal')) return
        /* 正在输入时先退出输入：别让一次 Esc 把抽屉里的草稿一起关掉。 */
        if (typing) {
          if (e.target && typeof e.target.blur === 'function') e.target.blur()
          return
        }
        if (peek) { setPeek(null); return }
        if (drawer) { setDrawer(null); return }
        /* 菜单挂在自己身上：这里放行，由它 bubble 阶段收起，再按一次才关面板。
           靶标菜单、任务模式菜单都算 —— 只认其中一个的话，Esc 会把面板一起关掉。 */
        if (document.querySelector('.dfx-dock .df-menu')) return
        props.onClose()
        return
      }
      if (typing) return
      if (dfModKey(e) && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault()
        toggleImmersive()
        return
      }
      if (e.key === 'r' || e.key === 'R') {
        if (dfModKey(e)) return
        e.preventDefault()
        refresh()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return function () { window.removeEventListener('keydown', onKey, true) }
  }, [palette, drawer, peek, refresh, immersive])

  /* 切页那一刻就把上一页的画面扣下来当残影：点下去的时候旧 DOM 还在，
     等 React 换完之后再去取就只剩骨架了。读宿主状态的页面（维护）要扫安装目录，
     可能等好几秒 —— 这段时间屏幕上必须是「还停在上一页」，而不是一块空骨架。 */
  function navigate(key, focusAssetId) {
    const alias = DF_PROMPT_ALIASES[key]
    if (alias) {
      setPromptLayer(alias)
      key = 'prompts'
    }
    const root = containerRef.current
    const frame = root && root.querySelector('.dfx-frame')
    const content = dfPaneContent(root)
    const main = root && root.querySelector('.dfx-main')
    if (main) scrollMemRef.current[view] = main.scrollTop
    /* 目标页已经加载过（常驻）就直接切：它自己就有完整内容，残影反而多余。 */
    const cached = !!(root && root.querySelector('.dfx-pane[data-view="' + key + '"]'))
    if (frame && key !== view && !cached && dfIsPainted(content)) {
      /* 拷的是内容层（不是整个主区）：外面的 .dfx-frame 已经有同样的内边距，
         再套一层就会多缩进 18px、跟原页面错位。 */
      const clone = dfCloneFrame(content)
      if (clone) {
        clone.className = 'df-keepalive'
        clone.setAttribute('aria-hidden', 'true')
        /* 用户可能已经滚下去了：残影要跟当前滚动位置对齐，
           否则这几十毫秒里会先闪一下「回到顶部」。 */
        if (main && main.scrollTop > 0) clone.style.transform = 'translateY(-' + main.scrollTop + 'px)'
        frame.textContent = ''
        frame.appendChild(clone)
        dfFrameShow(frame, true)
        if (holdTimerRef.current) window.clearTimeout(holdTimerRef.current)
        holdTimerRef.current = window.setTimeout(function () {
          holdTimerRef.current = 0
          const box = containerRef.current
          const f = box && box.querySelector('.dfx-frame')
          if (!f) return
          const c = dfPaneContent(box)
          /* 宽限期到了还没内容就退场：让页面自己的加载态接管，
             不能让上一页一直挂着假装还在这儿。 */
          if (!dfIsPainted(c)) dfFrameClear(f)
        }, 260)
      }
    }
    setView(key)
    setDrawer(null)
    /* 矩阵行点进来时，带着 assetId 落到资产页并直接打开那台资产的详情。 */
    setAssetFocus(key === 'assets' && focusAssetId ? String(focusAssetId) : '')
  }

  function onMainClick(e) {
    const el = e.target && e.target.closest && e.target.closest('[data-sel]')
    if (!el) return
    try { setDrawer(JSON.parse(el.getAttribute('data-sel'))) } catch (err) { /* 忽略坏数据 */ }
  }

  const effectiveZoom = zoomPref || dfAutoZoom(vp)
  /* 生效宽度要按缩放折算：1.35 倍下 1065px 的窗只剩 ~790px，导航会横向裁掉。 */
  const effW = geom.w / effectiveZoom
  zoomRef.current = effectiveZoom
  const narrow = effW < 900 || vp.vw / effectiveZoom < 980
  /* 窄窗里抽屉最多 340：再宽就把主区压到没法看表了。 */
  const sideCap = narrow ? Math.min(340, Math.max(240, Math.round(effW * 0.55))) : Math.round(effW * 0.55)
  /* 再窄（150% 缩放 / 小窗）抽屉改成浮层：否则侧栏会把主区挤到只剩百来像素。 */
  const tight = effW < 620
  const sideW = tight
    ? Math.max(260, Math.min(drawerW, Math.round(effW * 0.92)))
    : Math.max(240, Math.min(drawerW, sideCap))
  /* 侧栏默认宽度 176px（图标 + 文字 + 分组标题）。窗口不够宽时自动收成 56px 的图标栏：
     内容区才是主角，导航不该把它挤到没法看表。用户手动定过就听用户的，
     但窗口窄到极限（<600）时仍然强制收起，否则主区只剩一条缝。 */
  const navMini = immersive ? false : (effW < 600 ? true : (navPref === null ? effW < 840 : !!navPref))

  /* 记录最后一次点击的列表行位置，peek 卡片就贴在它旁边弹出。 */
  useEffect(function () {
    function onDown(e) {
      const t = e.target
      if (!t || !t.closest) return
      const row = t.closest('tr, .df-vrow, .df-rowitem, .df-ri, .df-card')
      if (row) lastRowRect.current = row.getBoundingClientRect()
      if (peek && !t.closest('.df-peek')) setPeek(null)
    }
    document.addEventListener('pointerdown', onDown, true)
    return function () { document.removeEventListener('pointerdown', onDown, true) }
  }, [peek])

  function placePeek() {
    const r = lastRowRect.current
    const dockEl = document.querySelector('.dfx-dock')
    const box = dockEl ? dockEl.getBoundingClientRect() : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
    const width = 360
    const gap = 10
    let left = r ? r.right + gap : box.right - width - 14
    if (left + width > box.right - 10) left = (r ? r.left - width - gap : box.left + 14)
    left = Math.max(box.left + 10, Math.min(left, box.right - width - 10))
    let top = r ? r.top : box.top + 70
    top = Math.max(box.top + 56, Math.min(top, box.bottom - 260))
    return { top: Math.round(top), left: Math.round(left), width: width }
  }

  function inspect(d) {
    if (!d) return
    /* 长文本编辑自动铺满面板：380/740 宽的窗口里改几千字还是难受。 */
    if (d.maximize === true && !maxed) setMaxed(true)
    if (d.mode === 'peek') {
      setDrawer(null)
      setPeekAt(placePeek())
      setPeek(d)
      return
    }
    setPeek(null)
    setDrawer(d)
  }

  function toggleNav() {
    const next = !navMini
    setNavPref(next)
    dfSaveJson(DF_KEY_NAV, next)
  }

  /* 沉浸模式：侧栏不再占宽度，改成一个「贴左边缘才出现」的浮层。
     浮层不参与布局 —— 否则鼠标每次扫过左边缘，表格都会横向弹一下。 */
  function toggleImmersive() {
    const next = !immersive
    setImmersive(next)
    dfSaveJson(DF_KEY_IMM, next)
    if (next) dfToast('侧栏已隐藏：鼠标移到左边缘唤出，Ctrl+B 恢复', 'ok', 3600)
  }

  function zoomStep(dir) {
    const cur = effectiveZoom
    let i = 0
    let best = 0
    for (let k = 0; k < DF_ZOOM_STEPS.length; k += 1) {
      if (Math.abs(DF_ZOOM_STEPS[k] - cur) < Math.abs(DF_ZOOM_STEPS[best] - cur)) best = k
    }
    i = best + dir
    if (i < 0) i = 0
    if (i >= DF_ZOOM_STEPS.length) i = DF_ZOOM_STEPS.length - 1
    setZoomPref(DF_ZOOM_STEPS[i])
  }

  /* 操作在前、跳转在后：视图有 14 个，先列动作才不会被截断。 */
  const commands = [
    { key: 'act:refresh', label: '刷新数据', group: '操作', icon: 'refresh', run: refresh },
    { key: 'act:max', label: maxed ? '还原窗口' : '最大化窗口', group: '操作', icon: maxed ? 'restore' : 'max', run: toggleMax },
    { key: 'act:immersive', label: immersive ? '退出沉浸模式' : '沉浸模式（隐藏侧栏）', group: '操作', icon: 'focus', run: toggleImmersive },
    {
      key: 'act:open', label: '在新窗口打开', group: '操作', icon: 'external',
      run: function () {
        try { window.open(window.location.href.split('#')[0] + '#redteam-full', '_blank', 'noopener') } catch (err) { /* 宿主禁开窗 */ }
      },
    },
    { key: 'act:close', label: '关闭面板', group: '操作', icon: 'close', run: props.onClose },
  ].concat(DF_VIEWS.map(function (v) {
    return {
      key: 'view:' + v.key, label: v.label, group: v.group, icon: v.icon,
      run: function () { navigate(v.key) },
    }
  })).concat(DF_PROMPT_WORK_LAYERS.map(function (l) {
    return {
      key: 'prompt:' + l.id, label: '提示词 · ' + l.label, group: '提示词', icon: l.icon,
      run: function () { navigate(l.id) },
    }
  })).concat([
    { key: 'perm:read-only', label: '切到只读', group: '权限', icon: 'lock', preset: 'read-only' },
    { key: 'perm:workspace-write', label: '切到工作区可写', group: '权限', icon: 'shield', preset: 'workspace-write' },
    { key: 'perm:danger-full-access', label: '切到完全访问', group: '权限', icon: 'bolt', preset: 'danger-full-access' },
  ].map(function (c) {
    return Object.assign({}, c, {
      run: function () {
        dfSetPermission(c.preset, c.label.replace(/^切到/, '')).then(function () {
          dfToast('权限档位：' + c.label.replace(/^切到/, ''), 'ok', 2200)
        }, function (e) {
          dfToast(String((e && e.message) || e), 'err', 4800)
        })
      },
    })
  }))

  return h('div', {
    className: 'dfx-dock',
    ref: containerRef,
    'data-narrow': narrow ? '1' : '0',
    'data-tight': tight ? '1' : '0',
    'data-nav': immersive ? 'hidden' : 'rail',
    style: {
      left: geom.x, top: geom.y, width: geom.w, height: geom.h,
      pointerEvents: 'auto', WebkitAppRegion: 'no-drag',
    },
  },
    h('div', { className: 'dfx-inner', style: { zoom: effectiveZoom } },
      h('header', {
        className: 'dfx-head',
        ref: headRef,
        onPointerDown: startMove,
        onDoubleClick: function (e) {
          if (e.target && e.target.closest && e.target.closest('button, input, [data-nodrag]')) return
          toggleMax()
        },
      },
        h('span', { className: 'dfx-mark' }, dfIcon('shield', 13)),
        /* 顶栏只留产品名和当前上下文：副名、署名属于「说明」，放到关于页，
           不占每一屏都看得见的位置。 */
        h('span', { className: 'dfx-brand' }, 'SAFE'),
        h(DfTargetMenu, {
          engagements: engagements,
          current: eng,
          busy: targetBusy || boot.loading,
          onSwitch: switchTarget,
          onCreate: createTarget,
          onDelete: deleteTarget,
          onBulkDelete: deleteTargets,
        }),
        h(DfInjectChip, {
          state: injectState,
          onGoto: navigate,
          onChanged: function () {
            injectState.reload()
            setTick(function (n) { return n + 1 })
          },
        }),
        h('div', { className: 'dfx-spacer' }),
        h(DfPermChip),
        /* 沉浸模式里侧栏是隐藏的：顶栏留一个明确入口，任何时候都能点回来。 */
        immersive
          ? h('button', {
            type: 'button', className: 'df-iconbtn', 'data-nodrag': '1',
            title: '显示侧栏（Ctrl+B）',
            onClick: toggleImmersive,
          }, dfIcon('panelLeft', 15))
          : null,
        h('button', {
          type: 'button', className: 'df-topbtn', 'data-nodrag': '1',
          title: '命令面板（Ctrl/⌘+K）',
          onClick: function () { setPalette(true) },
        }, dfIcon('search', 13), h('span', { className: 'df-topbtn-t' }, '搜索'), h('kbd', null, 'Ctrl K')),
        h('button', {
          type: 'button', className: 'df-iconbtn', 'data-nodrag': '1',
          title: '刷新（R）',
          onClick: refresh,
        }, refreshing ? h(DfSpinner) : dfIcon('refresh', 14)),
        h('div', { className: 'df-zoom', 'data-nodrag': '1' },
          h('button', { type: 'button', title: '缩小', onClick: function () { zoomStep(-1) } }, dfIcon('minus', 11)),
          h('button', {
            type: 'button', className: 'df-zoom-v', title: '恢复自动缩放',
            onClick: function () { setZoomPref(null) },
          }, Math.round(effectiveZoom * 100) + '%'),
          h('button', { type: 'button', title: '放大', onClick: function () { zoomStep(1) } }, dfIcon('plus', 11))),
        h('button', {
          type: 'button', className: 'df-iconbtn', 'data-nodrag': '1',
          title: maxed ? '还原' : '最大化', onClick: toggleMax,
        }, dfIcon(maxed ? 'restore' : 'max', 14)),
        h('button', {
          type: 'button', className: 'df-iconbtn', 'data-nodrag': '1',
          title: '关闭（Esc）', onClick: props.onClose,
        }, dfIcon('close', 15))),

      h('div', { className: 'dfx-body' },
        /* 沉浸模式下贴左边缘出现：12px 热区，鼠标一进来侧栏就浮出来。
           它只是浮层，不占布局 —— 表格宽度不会因为鼠标扫过左边而跳动。 */
        immersive ? h('div', { className: 'dfx-navzone', 'aria-hidden': 'true' }) : null,
        /* 左侧常驻导航：分组名是真正的分区标题（不再是横条里的灰字），
           每一项都是「图标 + 文字」的整行入口。收起时只剩图标，分组用细线分隔。 */
        h('nav', {
          className: dfCx('dfx-nav', navMini && 'is-mini'),
          'aria-label': '面板导航',
        },
          h('div', { className: 'dfx-navlist' },
            DF_NAV.map(function (group) {
              return h('div', { key: group.key, className: 'dfx-ngrp-block' },
                h('div', { className: 'dfx-ngrp' }, group.label),
                group.items.map(function (it) {
                  return h('button', {
                    key: it.key,
                    type: 'button',
                    className: dfCx('dfx-navbtn', view === it.key && 'on'),
                    title: group.label + ' · ' + it.label,
                    'aria-current': view === it.key ? 'page' : undefined,
                    onClick: function () { navigate(it.key) },
                  },
                    dfIcon(it.icon, 15, 1.7),
                    h('span', { className: 'df-navtxt' }, it.label),
                    hasNew(it.key) ? h('i', { className: 'df-navdot' }) : null)
                }))
            })),
          h('div', { className: 'dfx-navfoot' },
            immersive
              ? h('button', {
                type: 'button',
                className: 'dfx-navfold',
                title: '退出沉浸（Ctrl+B）',
                onClick: toggleImmersive,
              },
                h('span', { className: 'dfx-navfold-ico' }, dfIcon('focus', 15, 1.7)),
                h('span', { className: 'df-navtxt' }, '退出沉浸'))
              : h(react.Fragment, null,
                h('button', {
                  type: 'button',
                  className: 'dfx-navfold',
                  title: navMini ? '展开侧栏' : '收起侧栏',
                  'aria-label': navMini ? '展开侧栏' : '收起侧栏',
                  onClick: toggleNav,
                },
                  h('span', { className: dfCx('dfx-navfold-ico', navMini && 'is-mini') }, dfIcon('panelLeft', 15, 1.7)),
                  h('span', { className: 'df-navtxt' }, navMini ? '展开侧栏' : '收起侧栏')),
                h('button', {
                  type: 'button',
                  className: 'dfx-navfold dfx-navfold--icon',
                  title: '沉浸模式：隐藏侧栏（Ctrl+B）',
                  'aria-label': '沉浸模式',
                  onClick: toggleImmersive,
                }, dfIcon('focus', 15, 1.7))))),

        h('main', {
          className: 'dfx-main', onClick: onMainClick, style: { position: 'relative' },
        },
          h(DfInjectBanner, {
            state: injectState,
            view: view,
            onGoto: navigate,
            onRetry: injectState.reload,
            onChanged: function () {
              injectState.reload()
              setTick(function (n) { return n + 1 })
            },
          }),
          /* 上一帧铺在底层：切页那一刻扣下上一页的画面钉在这儿，
             新页画出真实内容之前它一直顶着，所以中间不会出现空白或骨架。
             注意它只是「站位」用的 —— 新页有自己的不透明底色，随时可以把它盖住。 */
          h('div', { className: 'dfx-frame', 'data-view': view, 'aria-hidden': 'true' }),
          boot.error
            ? h(DfEmpty, { icon: 'alert', title: '读不到靶标列表', hint: boot.error })
            /* 页面常驻：去过的页只藏起来、不卸载。回来的时候数据、筛选、滚动位置全在，
               没有请求、没有骨架，跟浏览器标签页一样是「一下就回来」。
               第一次去某页才需要真的加载。 */
            : panes.map(function (v) {
              return h('div', {
                key: v,
                className: 'dfx-pane',
                'data-on': v === view ? '1' : '0',
                'data-view': v,
              },
                h(DfErrorBoundary, { key: 'pane:' + v + ':' + eng, inline: true },
                  h(DfViewHost, {
                    view: v, eng: eng, tick: tick, mode: dfTaskMode(),
                    targetName: current ? (current.name || current.id) : '',
                    engagements: engagements,
                    promptLayer: promptLayer,
                    onPromptLayer: setPromptLayer,
                    onGoto: navigate,
                    onInspect: inspect,
                    onCloseDrawer: function () { setDrawer(null) },
                    focusAsset: v === view ? assetFocus : '',
                    onFocusConsumed: function () { setAssetFocus('') },
                    onCreate: function () { setPalette(false) },
                  })))
            })),
        drawer && drawer.mode === 'page'
          ? h(DfDetailPage, {
            title: drawer.title || '详情',
            sub: drawer.sub || '',
            head: drawer.head,
            rows: drawer.rows,
            node: drawer.node,
            onClose: function () { setDrawer(null) },
            actions: drawer.rows && drawer.rows.length
              ? h(DfCopyBtn, {
                text: [drawer.title || ''].concat((drawer.rows || []).map(function (r) {
                  return r[0] + '：' + (r[1] === undefined || r[1] === null || r[1] === '' ? '—' : r[1])
                })).join('\n'),
                label: '复制',
                toast: '详情已复制',
              })
              : null,
          })
          : null,

      drawer && drawer.mode !== 'page'
        ? h('aside', { className: 'dfx-side', style: { width: sideW } },
            h('div', { className: 'dfx-side-grip', onPointerDown: startDrawerResize, title: '拖动调整宽度' }),
            h(DfDrawer, {
              title: drawer.title || '详情',
              sub: drawer.sub || '',
              onClose: function () { setDrawer(null) },
              actions: drawer.rows && drawer.rows.length
                ? h(DfCopyBtn, {
                  text: [drawer.title || ''].concat((drawer.rows || []).map(function (r) {
                    return r[0] + '：' + (r[1] === undefined || r[1] === null || r[1] === '' ? '—' : r[1])
                  })).join('\n'),
                  label: '复制',
                  toast: '详情已复制',
                })
                : null,
            },
              drawer.head || null,
              drawer.rows && drawer.rows.length ? h(DfKV, { rows: drawer.rows }) : null,
              drawer.node || null))
          : null),

      palette ? h(DfCommandPalette, {
        commands: commands,
        onClose: function () { setPalette(false) },
      }) : null),
    h(DfToastHost),
    peek
      ? h(DfPeek, {
        data: peek,
        style: peekAt,
        onClose: function () { setPeek(null) },
        onExpand: function () {
          const full = Object.assign({}, peek, { mode: 'page' })
          setPeek(null)
          setDrawer(full)
        },
      })
      : null,
    h('div', { className: 'dfx-rz dfx-rz-r', onPointerDown: function (e) { startResize(e, 'h') } }),
    h('div', { className: 'dfx-rz dfx-rz-b', onPointerDown: function (e) { startResize(e, 'w') } }),
    h('div', { className: 'dfx-resize', onPointerDown: function (e) { startResize(e, 'both') } }))
}

/* ---------------------------------------------------------------- 靶标下拉 */

/* 任务模式：只留已开发的渗透测试；攻防演练 / 修复复测等做完再放回来。 */
const DF_KEY_MODE = 'dsh-forge-task-mode-v1'

function dfTaskMode() {
  let raw = ''
  try { raw = String(window.localStorage.getItem(DF_KEY_MODE) || '') } catch (e) { raw = '' }
  raw = raw.replace(/^"+|"+$/g, '')
  return raw === 'pentest' ? raw : 'pentest'
}

/** 当前 dsh 模式；宿主没暴露时按红队处理（面板主场景）。 */
function dfCurrentAgentPreset() {
  try {
    const sid = dfCurrentSessionId()
    const sess = dfSessionSnapshot(sid)
    const preset = dfReadPreset(sess)
    if (preset) return preset
  } catch (e) { /* fall through */ }
  return 'redteam'
}

function dfScopeCovered(mode, scopes) {
  let m = String(mode || '').toLowerCase()
  if (/红队/.test(m)) m = 'redteam'
  else if (/破解/.test(m)) m = 'crack'
  const list = (Array.isArray(scopes) ? scopes : []).map(function (x) { return String(x || '').toLowerCase() })
  if (list.indexOf(m) >= 0) return true
  if (m.endsWith('-worker') && list.indexOf(m.slice(0, -7)) >= 0) return true
  return false
}

/* ---------------------------------------------------------------- 破甲注入状态

   破甲注入不是普通设置：没开的时候模型仍按原厂限制工作。
   面板内常驻一条状态条：
   · 已生效：绿色紧凑条，点进破甲注入页；
   · 原厂模式：灰色紧凑条，说明本来就不注入；
   · 该注入但没生效：黄色提示条 + 一键开启；
   · 破甲注入页自己显示完整状态，不在页内重复。 */

function dfInjectView(data) {
  const d = data || {}
  const mode = dfCurrentAgentPreset()
  const scopes = Array.isArray(d.scopes) ? d.scopes : []
  const covered = dfScopeCovered(mode, scopes)
  const hasContent = !!String(d.content || '').trim()
  const enabled = d.enabled !== false
  const patch = d.patch_state || null
  /* 只有核心补丁决定破甲开关能不能用；非核心失败只做提示。 */
  const coreReady = patch ? patch.core_complete === true : true
  const coreFailed = patch ? Number(patch.core_failed) || 0 : 0
  const corePending = patch ? Number(patch.core_pending) || 0 : 0
  const otherFailed = patch ? Number(patch.other_failed) || 0 : 0
  const otherPending = patch ? Number(patch.other_pending) || 0 : 0
  const patchReason = patch && typeof patch.reason === 'string' ? patch.reason : ''
  const patchPartial = !coreReady && (coreFailed + corePending > 0)
  return {
    d, mode, scopes, covered, hasContent, enabled, patch, patchReason,
    coreReady, coreFailed, corePending, otherFailed, otherPending, patchPartial,
    active: enabled && covered && hasContent,
  }
}

function dfModeLabel(id) {
  if (id === 'redteam') return '红队模式'
  if (id === 'crack') return '破解模式'
  if (id === 'standard') return '标准模式'
  if (id === 'minimal') return '极简模式'
  if (id === 'ptc') return 'PTC 模式'
  if (id === 'cordis') return '创造模式'
  return id || '未知模式'
}

/** 宿主给内建模式的 name 就是 id（standard / ptc…），这里统一翻成可读名。 */
function dfModeTitle(mode) {
  const id = typeof mode === 'string' ? mode : String((mode && mode.id) || '')
  const name = typeof mode === 'object' ? String((mode && mode.name) || '') : ''
  if (name && name !== id && !/^[a-z0-9._-]+$/i.test(name)) return name
  return dfModeLabel(id)
}

/** 只有渗透类模式才默认需要破甲注入；standard / 自定义模式不勾选时属正常。 */
function dfPentestMode(id) {
  let m = String(id || '').toLowerCase()
  if (/红队/.test(m)) m = 'redteam'
  if (/破解/.test(m)) m = 'crack'
  return m === 'redteam' || m === 'crack' || m === 'redteam-worker' || m === 'crack-worker'
}

function dfStockMode(id) {
  const m = String(id || '').toLowerCase()
  return m === 'standard' || m === 'minimal' || m === 'ptc' || m === 'cordis' || m === 'default'
}

/** 顶栏破甲状态：名字固定“破甲”，只显示状态；点击跳到「提示词 → 破甲注入」。 */
function DfInjectChip(props) {
  /* 顶栏只显示状态：开关放在「提示词 → 破甲注入」，避免日常误点。
     点击这里 = 打开那个页面，不是直接切换。 */
  const st = dfInjectView(props.state && props.state.data)
  const known = Boolean(props.state && props.state.data && st.d.ok !== false)
  const active = known && st.coreReady && st.active
  const dot = !known ? 'var(--df-warn-solid)'
    : !st.coreReady || !active ? 'var(--df-err-solid)'
      : 'var(--df-ok-solid)'
  const reason = !known ? '读取破甲状态失败'
    : !st.coreReady
      ? (st.patchReason === 'core-disabled' ? '核心补丁已停用'
        : st.patchReason === 'host-reset' ? '宿主更新后核心补丁已丢失，需重新写入'
        : st.patchPartial
          ? '核心补丁未完成：' + (st.coreFailed > 0 ? st.coreFailed + ' 条失败' : st.corePending + ' 条待写入')
          : '核心补丁尚未写入宿主')
      : active ? '破甲已生效'
        : !st.hasContent ? '破甲注入内容为空'
          : !st.enabled ? '破甲注入已关闭'
            : !st.covered ? '当前为' + dfModeLabel(st.mode) + '，未注入'
              : '破甲注入未生效'
  return h('button', {
    type: 'button',
    className: dfCx('dfx-tag', 'df-inject-chip', active ? 'is-on' : 'is-off'),
    title: reason + '；点击打开' + (st.coreReady ? '破甲注入设置' : '维护页写入宿主'),
    onClick: function () { if (props.onGoto) props.onGoto(st.coreReady ? 'inject' : 'maintenance') },
  },
    h('i', { className: 'df-inject-dot', style: { background: dot } }),
    h('span', { className: 'df-inject-label' }, '破甲'))
}

/** 该注入但没开时的黄色提示条；已生效/原厂模式由顶栏圆点表示，不再占页面。 */
function DfInjectBanner(props) {
  const [busy, setBusy] = useState(false)
  const st = dfInjectView(props.state && props.state.data)

  if (!props.state || props.state.loading || !props.state.data) return null
  /* 维护页自己就有完整状态，不再叠一条。 */
  if (props.view === 'maintenance' || st.d.ok === false) return null

  if (!st.coreReady) {
    return h('div', { className: 'df-inject-banner', role: 'status' },
      h('span', { className: 'df-ib-ico' }, dfIcon('alert', 16)),
      h('div', { className: 'df-ib-main' },
        h('b', null, st.patchReason === 'core-disabled'
          ? '核心补丁已停用'
          : st.patchReason === 'host-reset'
            ? '宿主更新后核心补丁已丢失'
            : (st.patchPartial ? '核心补丁未完成' : '核心补丁还没写入宿主')),
        h('span', null, st.patchReason === 'core-disabled'
          ? '核心补丁被停用后破甲开关不可用；重新启用并写入宿主即可恢复。'
          : st.patchReason === 'host-reset'
            ? '宿主更新/重置冲掉了补丁；点「写入宿主」重新写入后开关才会恢复。'
          : st.patchPartial
            ? (st.coreFailed > 0
              ? '有 ' + st.coreFailed + ' 条核心补丁失败；重试只补未写入的部分。'
              : '还有 ' + st.corePending + ' 条核心补丁待写入；重试只补未写入的部分。')
            : '核心补丁写入后破甲开关才可用；只装插件不算启用。')),
      h('div', { className: 'df-ib-act' },
        h(DfBtn, {
          size: 'sm', kind: 'primary', icon: 'wrench',
          onClick: function () { if (props.onGoto) props.onGoto('maintenance') },
        }, '去写入宿主')))
  }
  /* 非核心补丁失败不挡破甲：只在已生效时提一条静默提示，避免和下面的开启引导叠两条。 */
  const otherLost = st.otherFailed + st.otherPending
  if (st.active && otherLost > 0) {
    return h('div', { className: 'df-inject-banner is-soft', role: 'status' },
      h('span', { className: 'df-ib-ico' }, dfIcon('wrench', 16)),
      h('div', { className: 'df-ib-main' },
        h('b', null, otherLost + ' 条非核心补丁未写入'),
        h('span', null, '不影响破甲开关；需要时到维护页重试或还原。')),
      h('div', { className: 'df-ib-act' },
        h(DfBtn, {
          size: 'sm', kind: 'ghost', icon: 'wrench',
          onClick: function () { if (props.onGoto) props.onGoto('maintenance') },
        }, '去维护')))
  }
  /* 破甲注入页本身就有状态卡片；已生效/原厂模式由顶栏圆点表示。 */
  if (props.view === 'inject' || st.active) return null
  if (!st.covered && !dfPentestMode(st.mode)) return null

  function enable() {
    if (busy) return
    if (!st.hasContent) {
      if (props.onGoto) props.onGoto('inject')
      return
    }
    setBusy(true)
    const needScope = !st.covered && !!st.mode
    const step = needScope
      ? dfHostPost('/dsh-forge/inject', { action: 'setScopes', scopes: st.scopes.concat([st.mode]) })
      : Promise.resolve({ ok: true })
    step.then(function (r) {
      if (!r || r.ok === false) throw new Error((r && r.error) || '保存生效范围失败')
      return dfHostPost('/dsh-forge/inject', { action: 'setEnabled', enabled: true })
    }).then(function (r) {
      setBusy(false)
      if (!r || r.ok === false) { dfToast((r && r.error) || '开启失败', 'err', 4200); return }
      dfToast('破甲注入已开启，下一轮生效', 'ok', 2800)
      dfBust()
      if (props.onChanged) props.onChanged()
    }, function (e) {
      setBusy(false)
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  const title = !st.hasContent
    ? '破甲注入是空的'
    : !st.enabled
      ? '破甲注入已关闭'
      : '当前模式未包含在注入范围'
  const desc = !st.hasContent
    ? '没有内容时开启也不会生效；先写一份最简破甲稿，再回来开启。'
    : !st.enabled
      ? '关闭时模型仍按原厂限制工作：破甲、授权边界与输出纪律都不会生效。'
      : '当前模式「' + dfModeLabel(st.mode) + '」会使用原厂人格；把当前模式加入范围后即可生效。'
  const actionLabel = !st.hasContent
    ? '去写一份'
    : !st.enabled
      ? (st.covered ? '开启破甲注入' : '加入当前模式并开启')
      : '加入当前模式'

  return h('div', { className: 'df-inject-banner', role: 'status' },
    h('span', { className: 'df-ib-ico' }, dfIcon('shield', 16)),
    h('div', { className: 'df-ib-main' },
      h('b', null, title),
      h('span', null, desc)),
    h('div', { className: 'df-ib-act' },
      h(DfBtn, {
        size: 'sm', kind: 'primary', icon: 'check', disabled: busy,
        onClick: enable,
      }, busy ? '处理中…' : actionLabel),
      !st.hasContent
        ? null
        : h(DfBtn, {
          size: 'sm', kind: 'ghost', icon: 'prompt',
          onClick: function () { if (props.onGoto) props.onGoto('inject') },
        }, '去破甲注入')))
}

function DfTargetMenu(props) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState('list')
  const [name, setName] = useState('')
  const [scope, setScope] = useState('')
  const [scopeCheck, setScopeCheck] = useState(function () { return dfScopeParseText('') })
  const [stats, setStats] = useState(null)
  const [statsErr, setStatsErr] = useState('')
  const [statsBusy, setStatsBusy] = useState(false)
  const [selected, setSelected] = useState([])
  const boxRef = useRef(null)

  dfUseOutside(boxRef, function () { setOpen(false) }, open)

  /* Esc：表单层先回列表，再按一次才收起菜单。DfDock 会检测菜单存在后放行。 */
  useEffect(function () {
    if (!open) return undefined
    const onKey = function (e) {
      if (e.key !== 'Escape') return
      if (mode !== 'list') { setMode('list'); return }
      setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return function () { window.removeEventListener('keydown', onKey) }
  }, [open, mode])

  const list = props.engagements || []
  const cur = list.filter(function (e) { return e.id === props.current })[0] || null
  const selectedItems = list.filter(function (e) { return selected.indexOf(e.id) >= 0 })
  const selectedTotal = selectedItems.reduce(function (n, e) {
    const s = e.stats || {}
    return n + (Number(s.assets) || 0) + (Number(s.vulns) || 0)
      + (Number(s.credentials) || 0) + (Number(s.accesses) || 0)
  }, 0)

  useEffect(function () {
    if (!open || mode !== 'delete' || !props.current) return
    let alive = true
    setStatsBusy(true)
    setStatsErr('')
    setStats(null)
    dfApi('engagementStats', { engagement: props.current }).then(function (r) {
      if (!alive) return
      setStatsBusy(false)
      if (!r || r.ok === false) setStatsErr((r && r.error) || '读不到成果计数')
      else setStats(r.counts || null)
    })
    return function () { alive = false }
  }, [open, mode, props.current])

  function closeAll() {
    setOpen(false)
    setMode('list')
    setName('')
    setScope('')
    setScopeCheck(dfScopeParseText(''))
    setStats(null)
    setStatsErr('')
    setSelected([])
  }

  function toggleSelected(id) {
    setSelected(function (cur) {
      return cur.indexOf(id) >= 0 ? cur.filter(function (x) { return x !== id }) : cur.concat([id])
    })
  }

  const counts = stats || null
  const scopeErr = scopeCheck.errors.length > 0
  const scopeNoted = scopeCheck.items.filter(function (it) { return it.notes && it.notes.length })[0] || null
  const canCreate = !!name.trim() && !props.busy && !scopeErr

  function onScope(next) {
    setScope(next)
    setScopeCheck(dfScopeParseText(next))
  }

  return h('div', { className: 'df-target', ref: boxRef, 'data-nodrag': '1' },
    h('button', {
      type: 'button',
      className: dfCx('df-target-btn', open && 'is-open'),
      title: cur ? cur.name + '（' + cur.id + '）' : '选择靶标',
      onClick: function () { setOpen(function (o) { return !o }); setMode('list') },
    },
      dfIcon('target', 13),
      h('span', { className: 'df-target-name' }, cur ? cur.name : '未选择靶标'),
      cur && cur.stats
        ? h('span', { className: 'df-target-meta' }, String(cur.stats.assets || 0) + ' 资产')
        : null,
      dfIcon('chevron', 12)),

    open ? h('div', { className: 'df-menu' },
      mode === 'list' ? [
        h('div', { className: 'df-menu-hd' }, '靶标', h('span', { className: 'df-count' }, String(list.length))),
        h('div', { className: 'df-menu-list' },
          list.length
            ? list.map(function (e) {
              const s = e.stats || {}
              return h('button', {
                key: e.id, type: 'button',
                className: dfCx('df-menu-item', e.id === props.current && 'on', e.broken && 'is-broken'),
                onClick: function () {
                  if (e.broken) {
                    dfToast('该靶标数据不完整（' + ((e.missing || []).join('、') || '缺文件') + '），已选中，请用「批量删除」移除', 'warn', 4200)
                    setMode('bulk')
                    setSelected([e.id])
                    return
                  }
                  if (e.id !== props.current) props.onSwitch(e.id)
                  closeAll()
                },
              },
                h('span', { className: 'df-mi-ico' }, dfIcon(e.id === props.current ? 'check' : 'target', 13)),
                h('span', { className: 'df-mi-main' },
                  h('b', null, e.name || e.id, e.broken ? h('span', { className: 'dfx-spacer' }, ' · 数据损坏') : null),
                  h('span', null, String(s.assets || 0) + ' 资产 · ' + String(s.vulns || 0) + ' 漏洞 · ' + String(s.accesses || 0) + ' 访问')),
                h('span', { className: 'df-mi-side' }, e.broken ? '可删除' : dfAgo(e.created_at)))
            })
            : h('div', { className: 'df-menu-empty' }, '还没有靶标，先新建一个。')),
        h('div', { className: 'df-menu-ft' },
          h(DfBtn, { size: 'sm', icon: 'plus', onClick: function () { setMode('create') } }, '新建靶标'),
          list.length > 1 || list.some(function (e) { return e.broken })
            ? h(DfBtn, {
              size: 'sm', kind: 'ghost', icon: 'close',
              title: '批量删除靶标',
              onClick: function () { setSelected([]); setMode('bulk') },
            }, '批量删除')
            : null,
          h('span', { className: 'dfx-spacer' }),
          cur ? h(DfBtn, {
            size: 'sm', kind: 'ghost', icon: 'sliders',
            title: '编辑当前靶标的授权范围',
            onClick: function () {
              setName(cur.name || cur.id)
              onScope((cur.scope || []).join(', '))
              setMode('edit')
            },
          }, '编辑范围') : null,
          cur ? h(DfBtn, {
            size: 'sm', kind: 'ghost', icon: 'close',
            title: '删除当前靶标',
            onClick: function () { setMode('delete') },
          }, '删除') : null),
      ] : null,

      mode === 'edit' ? h('div', { className: 'df-menu-form' },
        h('div', { className: 'df-menu-hd' }, '编辑范围'),
        h(DfField, { label: '靶标' },
          h('input', { className: 'df-input', value: cur ? cur.name || cur.id : '', disabled: true })),
        h(DfField, { label: '范围（可空）' },
          h('input', {
            className: dfCx('df-input', scopeErr && 'is-err'), value: scope, autoFocus: true,
            placeholder: '10.20.30.0/24, oa.example.com',
            onChange: function (e) { onScope(e.target.value) },
            onKeyDown: function (e) { if (e.key === 'Enter') submitScope() },
          }),
          scopeErr
            ? h('div', { className: 'df-hint is-err' },
              (scopeCheck.errors[0].raw ? '「' + scopeCheck.errors[0].raw + '」：' : '')
              + scopeCheck.errors[0].message
              + (scopeCheck.errors.length > 1 ? '（另有 ' + String(scopeCheck.errors.length - 1) + ' 项也不合法）' : ''))
            : scopeCheck.items.length
              ? h('div', { className: 'df-hint' },
                '已识别 ' + String(scopeCheck.entries.length) + ' 项：'
                + scopeCheck.entries.slice(0, 3).join('、')
                + (scopeCheck.entries.length > 3 ? ' 等' : ''))
              : h('div', { className: 'df-hint' },
                '逗号或空格分隔；支持 IP、网段、IP 段、域名、*.通配、URL')),
        h('div', { className: 'df-menu-ft' },
          h(DfBtn, {
            size: 'sm', kind: 'primary', icon: 'check',
            disabled: !cur || props.busy || scopeErr,
            onClick: submitScope,
          }, props.busy ? '保存中…' : '保存范围'),
          h('span', { className: 'dfx-spacer' }),
          h(DfBtn, { size: 'sm', kind: 'ghost', onClick: function () { setMode('list') } }, '取消'))) : null,

      mode === 'create' ? h('div', { className: 'df-menu-form' },
        h('div', { className: 'df-menu-hd' }, '新建靶标'),
        h(DfField, { label: '靶标名称' },
          h('input', {
            className: 'df-input', autoFocus: true, value: name,
            placeholder: '例如：某集团-外网',
            onChange: function (e) { setName(e.target.value) },
          })),
        h(DfField, { label: '范围（可空）' },
          h('input', {
            className: dfCx('df-input', scopeErr && 'is-err'), value: scope,
            placeholder: '10.20.30.0/24, oa.example.com',
            onChange: function (e) { onScope(e.target.value) },
            onKeyDown: function (e) { if (e.key === 'Enter') submit() },
          }),
          scopeErr
            ? h('div', { className: 'df-hint is-err' },
              (scopeCheck.errors[0].raw ? '「' + scopeCheck.errors[0].raw + '」：' : '')
              + scopeCheck.errors[0].message
              + (scopeCheck.errors.length > 1 ? '（另有 ' + String(scopeCheck.errors.length - 1) + ' 项也不合法）' : ''))
            : scopeCheck.items.length
              ? h('div', { className: 'df-hint' },
                '已识别 ' + String(scopeCheck.entries.length) + ' 项：'
                + scopeCheck.entries.slice(0, 3).join('、')
                + (scopeCheck.entries.length > 3 ? ' 等' : ''),
                scopeNoted ? h('span', { className: 'df-hint-sub' }, ' · ' + scopeNoted.notes[0]) : null)
              : h('div', { className: 'df-hint' },
                '逗号或空格分隔；支持 IP、网段、IP 段、域名、*.通配、URL')),
        h('div', { className: 'df-menu-ft' },
          h(DfBtn, {
            size: 'sm', kind: 'primary', icon: 'check',
            disabled: !canCreate,
            onClick: submit,
          }, props.busy ? '创建中…' : '创建'),
          h('span', { className: 'dfx-spacer' }),
          h(DfBtn, { size: 'sm', kind: 'ghost', onClick: function () { setMode('list') } }, '返回')),
      ) : null,

      mode === 'bulk' ? h('div', { className: 'df-menu-form' },
        h('div', { className: 'df-menu-hd' },
          '批量删除靶标',
          h('span', { className: 'df-count' }, String(selected.length) + ' / ' + String(list.length))),
        h('div', { className: 'df-menu-list' },
          list.map(function (e) {
            const on = selected.indexOf(e.id) >= 0
            const s = e.stats || {}
            return h('button', {
              key: e.id, type: 'button',
              className: dfCx('df-menu-item', on && 'on', e.broken && 'is-broken'),
              onClick: function () { toggleSelected(e.id) },
            },
              h('span', { className: 'df-mi-ico' }, dfIcon(on ? 'check' : 'target', 13)),
              h('span', { className: 'df-mi-main' },
                h('b', null, e.name || e.id, e.broken ? h('span', { className: 'dfx-spacer' }, ' · 数据损坏') : null),
                h('span', null, String(s.assets || 0) + ' 资产 · ' + String(s.vulns || 0) + ' 漏洞 · '
                  + String(s.accesses || 0) + ' 访问'
                  + (e.broken ? ' · 缺 ' + ((e.missing || []).join('、') || '文件') : ''))),
              h('span', { className: 'df-mi-side' }, e.broken ? '可删除' : dfAgo(e.created_at)))
          })),
        selectedTotal > 0
          ? h('div', { className: 'df-menu-note is-warn' },
            '选中的靶标共有 ' + String(selectedTotal) + ' 条成果，删除会连同数据库一起清空。')
          : h('div', { className: 'df-menu-note' },
            '勾选要删除的靶标；缺库残骸也可以在这里清掉。'),
        h('div', { className: 'df-menu-ft' },
          h(DfBtn, {
            size: 'sm', kind: 'ghost',
            onClick: function () {
              setSelected(selected.length === list.length ? [] : list.map(function (e) { return e.id }))
            },
          }, selected.length === list.length ? '清空' : '全选'),
          h('span', { className: 'dfx-spacer' }),
          h(DfBtn, {
            size: 'sm', kind: 'solid-danger', icon: 'alert',
            disabled: props.busy || selected.length === 0,
            onClick: function () {
              props.onBulkDelete(selected, selectedTotal > 0, function (ok) { if (ok) closeAll() })
            },
          }, props.busy ? '删除中…' : (selectedTotal > 0 ? '删除选中（含成果）' : '删除选中')),
          h(DfBtn, { size: 'sm', kind: 'ghost', onClick: function () { setMode('list') } }, '取消')))
        : null,

      mode === 'delete' ? h('div', { className: 'df-menu-form' },
        h('div', { className: 'df-menu-hd' }, '删除靶标'),
        h('div', { className: 'df-menu-warn' },
          h('b', null, cur ? (cur.name || cur.id) : props.current),
          h('span', null, '删除后目录与数据库一起移除，不可恢复。')),
        statsBusy
          ? h('div', { className: 'df-menu-note' }, '正在统计成果…')
          : statsErr
            ? h('div', { className: 'df-menu-note is-err' }, statsErr)
            : counts
              ? h('div', { className: 'df-del-grid' },
                [['资产', counts.assets], ['漏洞', counts.vulns], ['凭据', counts.credentials], ['访问', counts.access]].map(function (r) {
                  return h('div', { key: r[0], className: 'df-del-cell' },
                    h('b', null, String(r[1] || 0)), h('span', null, r[0]))
                }))
              : null,
        counts && counts.total > 0
          ? h('div', { className: 'df-menu-note is-warn' }, '该靶标已有 ' + counts.total + ' 条成果，仍然删除会一并清空。')
          : null,
        h('div', { className: 'df-menu-ft' },
          h(DfBtn, {
            size: 'sm', kind: 'solid-danger', icon: 'alert',
            disabled: props.busy || !props.current,
            onClick: function () {
              props.onDelete(props.current, !!(counts && counts.total > 0), function (ok) { if (ok) closeAll() })
            },
          }, props.busy ? '删除中…' : (counts && counts.total > 0 ? '确认删除（含成果）' : '确认删除')),
          h('span', { className: 'dfx-spacer' }),
          h(DfBtn, { size: 'sm', kind: 'ghost', onClick: function () { setMode('list') } }, '取消')),
      ) : null)
      : null)

  function submit() {
    const n = name.trim()
    if (!n || props.busy) return
    const parsed = dfScopeParseText(scope)
    if (parsed.errors.length) {
      /* 兜底：按钮已禁用，但 Enter / 粘贴后立刻回车可能抢在重渲染之前 */
      setScopeCheck(parsed)
      return
    }
    props.onCreate(n, parsed.entries)
    closeAll()
  }

  function submitScope() {
    if (!cur || props.busy) return
    const parsed = dfScopeParseText(scope)
    if (parsed.errors.length) {
      setScopeCheck(parsed)
      return
    }
    props.onCreate(cur.name || cur.id, parsed.entries)
    closeAll()
  }
}

/* ---------------------------------------------------------------- 视图路由 */

/* 路由层只需要知道「哪些视图要等靶标接口」（其余视图本地就能画）。
   DfEngView 里到第一个判断之前不能有任何 hook，否则切视图时 React 会数错 hook。 */
const DF_DATA_VIEWS = ['overview', 'assets', 'vulns', 'chain', 'sessions', 'log', 'score', 'report']

/* 当前显示的那一页的内容层。页面常驻之后主区里躺着一堆 pane，
   只有 data-on="1" 的那一个是「现在屏幕上这一页」。 */
function dfPaneContent(root) {
  return root ? root.querySelector('.dfx-pane[data-on="1"] .df-viewbox') : null
}
  /* 每个视图的根节点都带 data-view：切页时主区知道「换上来的这页要不要等接口」。
     这里用普通 div 而不是 DfKeepAlive 包：那份「保留上一帧」的逻辑由主区（DfDock）统一做，
     残影层是主区底下的一个固定节点，不随视图重挂。 */
  function dfViewWrap(view, node) {
  return h('div', { className: 'df-viewbox', 'data-view': view }, node)
}

function DfViewHost(props) {
  const key = props.view + '::' + (props.eng || '') + '::' + props.tick
  const eng = props.eng
  if (props.view === 'knowledge') return dfViewWrap(props.view, h(DfKnowledge, { key: key, onInspect: props.onInspect }))
  if (props.view === 'skills') return dfViewWrap(props.view, h(DfSkills, { key: key, onInspect: props.onInspect, onCloseDrawer: props.onCloseDrawer }))
  if (props.view === 'env') return dfViewWrap(props.view, h(DfEnv, { key: key, onGoto: props.onGoto }))
  if (props.view === 'maintenance') return dfViewWrap(props.view, h(DfMaintenance, { key: key, tick: props.tick, onInspect: props.onInspect, onCloseDrawer: props.onCloseDrawer }))
  if (props.view === 'agents') return dfViewWrap(props.view, h(DfAgents, { key: key, eng: eng, tick: props.tick, onInspect: props.onInspect, onCloseDrawer: props.onCloseDrawer, onGoto: props.onGoto }))
  /* 工作区指令是全局面：没有靶标也要能改 AGENTS.md 链。 */
  if (props.view === 'instructions') {
    return dfViewWrap(props.view, h(DfInstructionsPage, {
      key: key, tick: props.tick,
      onInspect: props.onInspect, onCloseDrawer: props.onCloseDrawer, onGoto: props.onGoto,
    }))
  }
  /* 实际提示词是诊断页，只读宿主内存里的组装结果，同样不依赖靶标。 */
  if (props.view === 'context') {
    return dfViewWrap(props.view, h(DfContextMode, {
      key: key, mode: 'redteam', onInspect: props.onInspect, onCloseDrawer: props.onCloseDrawer, onGoto: props.onGoto,
    }))
  }
  if (props.view === 'inject') {
    return dfViewWrap(props.view, h(DfInjectPage, {
      key: key, tick: props.tick,
      onInspect: props.onInspect, onCloseDrawer: props.onCloseDrawer,
      onGoto: props.onGoto,
    }))
  }
  if (props.view === 'prompts') {
    return dfViewWrap(props.view, h(DfPromptWorkbench, {
      key: key + '::' + (props.promptLayer || 'inject'),
      tick: props.tick,
      eng: eng,
      layer: props.promptLayer,
      onLayer: props.onPromptLayer,
      onInspect: props.onInspect,
      onCloseDrawer: props.onCloseDrawer,
      onGoto: props.onGoto,
    }))
  }
  /* 工具清单是全局面：读配置与磁盘扫描，没有靶标也要能看。 */
  /* key 不带 tick：工具页自己用 tick 触发数据重载，写操作后不要整页重挂，
     否则红队/破解 tab、搜索和筛选会被重置回红队。 */
  if (props.view === 'tools') {
    return dfViewWrap(props.view, h(DfTools, {
      key: props.view, eng: eng, tick: props.tick, onInspect: props.onInspect,
      onCloseDrawer: props.onCloseDrawer,
    }))
  }
  if (!eng) {
    return dfViewWrap(props.view, h('div', { className: 'df-blank' },
      h(DfEmpty, {
        icon: 'target',
        title: '还没有靶标',
        hint: '新建一个靶标，或从列表中选择。',
      })))
  }
  return dfViewWrap(props.view, h(DfEngView, props))
}

function DfEngView(props) {
  const key = props.view + '::' + (props.eng || '') + '::' + props.tick
  const eng = props.eng
  if (props.view === 'overview') return h(DfOverview, { key: key, eng: eng, onGoto: props.onGoto, onInspect: props.onInspect })
  if (props.view === 'assets') {
    return h(DfAssets, {
      key: key, eng: eng, onInspect: props.onInspect,
      focusAsset: props.focusAsset, onFocusConsumed: props.onFocusConsumed,
    })
  }
  if (props.view === 'vulns') return h(DfVulns, { key: key, eng: eng, onInspect: props.onInspect, onCloseDrawer: props.onCloseDrawer })
  if (props.view === 'chain') return h(DfChain, { key: key, eng: eng, onInspect: props.onInspect })
  if (props.view === 'sessions') return h(DfSessions, { key: key, eng: eng, onInspect: props.onInspect })
  if (props.view === 'log') return h(DfLog, { key: key, eng: eng, onInspect: props.onInspect })
  if (props.view === 'score') return h(DfScore, { key: key, eng: eng, mode: props.mode, onGoto: props.onGoto, onInspect: props.onInspect })
  if (props.view === 'report') return h(DfReport, { key: key, eng: eng, mode: props.mode, targetName: props.targetName, onGoto: props.onGoto })
  return h(DfEmpty, { icon: 'info', title: '页面不可用' })
}

/* ---------------------------------------------------------------- 命令面板 */

/* ---------------------------------------------------------------- 权限档位

   权限是全局常态，不是某一页的设置项：放到顶栏常驻，一眼知道现在会不会被拦。
   读写的还是宿主 @deepseek-ai/dsh-permission-presets，面板不存第二份状态。 */

const DF_PERM_META = {
  'read-only': { icon: 'lock', tone: 'ok' },
  'workspace-write': { icon: 'shield', tone: 'info' },
  'danger-full-access': { icon: 'bolt', tone: 'warn' },
}

function dfPermMeta(value) {
  return DF_PERM_META[value] || { icon: 'shield', tone: 'none' }
}

/**
 * 切一档权限。顶栏 chip 和命令面板共用这一个入口。
 * @param {string} preset - 预设名（read-only / workspace-write / danger-full-access）。
 * @param {string} label - 给人看的名字，失败提示里用。
 * @returns {Promise<object>} 成功返回后端结果，失败抛出带文案的 Error。
 */
function dfSetPermission(preset, label) {
  return dfApi('permissionSet', { preset: preset }).then(function (r) {
    if (!r || r.ok === false) throw new Error((r && r.error) || '切换失败')
    /* 不发 dfBust()：档位不影响靶标数据，全清缓存会让所有常驻页闪一屏骨架。
       dfApi 成功后走 dfPermNotify()，顶栏 chip 与环境页说明卡各自重读。 */
    if (r.defaultSaved === false) {
      dfToast('已切到「' + label + '」，但新会话默认档没写进去：' + (r.defaultError || '未知原因'), 'err', 6000)
    }
    return r
  })
}

function DfPermChip() {
  const [data, setData] = useState(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState('')
  const boxRef = useRef(null)
  const menuRef = useRef(null)

  /* 弹层右对齐 chip；chip 靠左时（窄窗 + 高缩放）会顶出 dock 左边界，
     这时改锚 chip 左边。坐标在 zoom 上下文里，要按实际缩放折算。 */
  useLayoutEffect(function () {
    const box = boxRef.current
    const menu = menuRef.current
    if (!open || !box || !menu) return
    menu.style.left = ''
    menu.style.right = ''
    menu.style.width = ''
    const dock = box.closest ? box.closest('.dfx-dock') : null
    if (!dock) return
    const d = dock.getBoundingClientRect()
    const c = box.getBoundingClientRect()
    const m = menu.getBoundingClientRect()
    const z = box.offsetWidth ? (c.width / box.offsetWidth) : 1
    if (m.left < d.left + 8) {
      menu.style.right = 'auto'
      menu.style.left = ((d.left + 8 - c.left) / z) + 'px'
    }
    /* 高缩放 + 窄窗里 330px 也放不下：按剩余宽度收窄，宁可窄一点也不能被裁。 */
    const m2 = menu.getBoundingClientRect()
    if (m2.right > d.right - 8) {
      menu.style.width = Math.max(180, Math.floor((d.right - 8 - m2.left) / z)) + 'px'
    }
  }, [open])

  const reload = useCallback(function () {
    dfApi('permissionCatalog', {}, { ttl: 0 }).then(function (r) {
      setData(r && r.ok !== false ? r : { ok: false, error: (r && r.error) || '读取失败' })
    }, function (e) {
      setData({ ok: false, error: String((e && e.message) || e) })
    })
  }, [])

  useEffect(function () { reload() }, [reload])

  /* 别处改了档位（环境页说明、会话里打 /permission）顶栏要跟着变：
     权限有自己的通知通道，另外兜一个慢轮询，不靠事件总线。 */
  useEffect(function () {
    const off = dfPermSubscribe(reload)
    const id = setInterval(function () { if (!document.hidden) reload() }, 20000)
    return function () { off(); clearInterval(id) }
  }, [reload])

  useEffect(function () {
    if (!open) return undefined
    const onDown = function (e) {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = function (e) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return function () {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const options = data && Array.isArray(data.options) ? data.options : []
  const rawCurrent = data && data.current && data.current !== 'custom'
    ? data.current
    : ((data && data.defaultPreset) || '')
  /* 宿主把「越界是否询问」做成同档位的 -ask 孪生预设（原生 approval=ask）。
     面板仍然只展示三档，询问与否是一个开关，不把六个预设摊给用户。 */
  const isAsk = /-ask$/.test(rawCurrent)
  const level = rawCurrent.replace(/-ask$/, '')
  const levels = options.filter(function (o) { return o && !/-ask$/.test(o.value) })
  const levelOpt = levels.filter(function (o) { return o.value === level })[0]
  const meta = dfPermMeta(level)
  const label = (levelOpt && levelOpt.name) || '权限未知'
  const broken = !!(data && data.ok === false)
  const canAsk = level !== 'danger-full-access'

  function applyPreset(value, name) {
    if (busy || !value || value === rawCurrent) { setOpen(false); return }
    setBusy(value)
    dfSetPermission(value, name).then(function () {
      setBusy('')
      setOpen(false)
      dfToast('权限档位：' + name, 'ok', 2200)
      reload()
    }, function (e) {
      setBusy('')
      dfToast(String((e && e.message) || e), 'err', 4800)
    })
  }

  function pick(option) {
    if (busy || !option) { setOpen(false); return }
    const target = (isAsk && option.value !== 'danger-full-access') ? option.value + '-ask' : option.value
    const opt = options.filter(function (o) { return o.value === target })[0]
    applyPreset(target, (opt && opt.name) || option.name || target)
  }

  function toggleAsk() {
    if (!canAsk || busy) return
    const target = isAsk ? level : level + '-ask'
    const opt = options.filter(function (o) { return o.value === target })[0]
    applyPreset(target, (opt && opt.name) || target)
  }

  return h('div', { className: 'dfx-perm', ref: boxRef },
    h('button', {
      type: 'button', className: dfCx('dfx-perm-btn', open && 'is-open'),
      'data-tone': broken ? 'none' : meta.tone,
      'data-nodrag': '1',
      title: broken
        ? ('权限档位读取失败：' + (data.error || '未知原因'))
        : ('文件写入权限：' + label + (isAsk ? '（越界时询问）' : '') + '，点击切换'),
      onClick: function () { setOpen(function (o) { return !o }) },
    },
      dfIcon(broken ? 'alert' : meta.icon, 13),
      h('span', { className: 'dfx-perm-prefix' }, '权限'),
      h('span', { key: broken ? 'unknown' : rawCurrent, className: 'dfx-perm-name' }, broken ? '未知' : label),
      isAsk ? h('i', { className: 'dfx-perm-flag', title: '越界时询问' }) : null,
      dfIcon('chevron', 11)),
    open
      ? h('div', { className: 'df-menu dfx-perm-menu', ref: menuRef },
        h('div', { className: 'df-menu-hd' }, '文件写入权限'),
        broken || levels.length === 0
          ? h('div', { className: 'df-menu-empty' },
            broken
              ? ('读不到权限档位：' + (data.error || '未知原因'))
              : '宿主未提供权限预设')
          : h('div', { className: 'df-menu-list' }, levels.map(function (o) {
            const m = dfPermMeta(o.value)
            return h('button', {
              key: o.value,
              type: 'button',
              className: dfCx('df-menu-item', o.value === level && 'on'),
              disabled: !!busy,
              onClick: function () { pick(o) },
            },
              h('span', { className: 'df-mi-ico' }, dfIcon(m.icon, 14)),
              h('span', { className: 'df-mi-main' },
                h('b', null, o.name || o.value),
                h('span', null, busy && level === o.value ? '正在切换…' : (o.description || ''))),
              o.value === level ? h('span', { className: 'df-mi-side' }, '当前') : null)
          })),
        h('button', {
          type: 'button',
          className: dfCx('dfx-perm-ask', isAsk && 'on'),
          disabled: !canAsk || !!busy,
          title: canAsk ? '' : '完全访问已是最宽档，没有越界可申请',
          onClick: toggleAsk,
        },
          h('span', null, '越界时询问'),
          h('i', { className: 'dfx-perm-sw' })),
        h('div', { className: 'dfx-perm-foot' }, '只限制文件写入；命令照常执行。'))
      : null)
}

function DfCommandPalette(props) {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef(null)
  const listRef = useRef(null)
  const list = (props.commands || []).filter(function (c) {
    if (!q.trim()) return true
    const needle = q.trim().toLowerCase()
    return c.label.toLowerCase().indexOf(needle) >= 0 || String(c.group || '').toLowerCase().indexOf(needle) >= 0
  })
  const top = list.slice(0, 16)

  useEffect(function () {
    if (inputRef.current) inputRef.current.focus()
  }, [])

  useEffect(function () { setIdx(0) }, [q])

  /* 键盘移到列表底部时把选中项滚进视野（列表最高 320px，16 项放不下）。 */
  useEffect(function () {
    const box = listRef.current
    if (!box || !box.children[idx]) return
    const el = box.children[idx]
    if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' })
  }, [idx])

  function run(cmd) {
    if (!cmd) return
    props.onClose()
    cmd.run()
  }

  return h('div', { className: 'df-cmd-mask', onPointerDown: props.onClose },
    h('div', { className: 'df-cmd', onPointerDown: function (e) { e.stopPropagation() } },
      h('div', { className: 'df-cmd-in' },
        dfIcon('search', 15),
        h('input', {
          ref: inputRef,
          value: q,
          placeholder: '跳转视图、刷新、最大化…',
          onChange: function (e) { setQ(e.target.value) },
          onKeyDown: function (e) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(function (i) { return Math.min(top.length - 1, i + 1) }) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(function (i) { return Math.max(0, i - 1) }) }
            else if (e.key === 'Enter') { e.preventDefault(); run(top[idx]) }
            else if (e.key === 'Escape') { e.preventDefault(); props.onClose() }
          },
        }),
        h('kbd', { className: 'df-cmd-esc' }, 'Esc')),
      h('div', { className: 'df-cmd-list', ref: listRef },
        top.length
          ? top.map(function (c, i) {
            return h('div', {
              key: c.key,
              className: dfCx('df-cmd-item', i === idx && 'on'),
              onPointerEnter: function () { setIdx(i) },
              onClick: function () { run(c) },
            },
              dfIcon(c.icon || 'chevronRight', 14),
              h('span', null, c.label),
              h('span', { className: 'df-cmd-k' }, c.group || ''))
          })
          : h('div', { className: 'df-cmd-none' }, '没有匹配项')))
  )
}


/* ---- lib/client/32-ops.js ---- */
/* 作业六视图（P2）：概览 / 资产 / 漏洞 / 攻击链 / 通道 / 日志。
   只做取数与展示；详情统一进抽屉，写入走 dfApi 的显式 op。 */

const DF_SEV = {
  critical: { label: '严重', cls: 'critical' },
  high: { label: '高危', cls: 'high' },
  medium: { label: '中危', cls: 'medium' },
  low: { label: '低危', cls: 'low' },
  info: { label: '提示', cls: 'info' },
}

const DF_TEST_LABEL = {
  untested: '未侦察', testing: '侦察中', tested: '侦察完成',
  blocked: '受阻', abandoned: '已放弃', no_surface: '无攻击面',
}
const DF_TEST_KIND = {
  untested: 'line', testing: 'info', tested: 'ok',
  blocked: 'warn', abandoned: 'err', no_surface: 'line',
}

const DF_VULN_STATUS = {
  candidate: '候选', confirmed: '已确认', 'false-positive': '误报',
  exploited: '已利用', fixed: '已修复',
}
const DF_VULN_KIND = {
  candidate: 'warn', confirmed: 'info', 'false-positive': 'line',
  exploited: 'ok', fixed: 'line',
}

const DF_STAGE_LABEL = {
  recon: '侦察', vuln: '漏洞', exploit: '利用', access: '初始访问',
  pivot: '横向移动', data: '数据获取', other: '其他',
  internet: '外网', internal: '内网', boundary: '边界', target: '目标',
}

const DF_TUNNEL_STATUS = { active: '通', down: '断', closed: '已关', unknown: '未知' }
const DF_SHELL_STATUS = { online: '在线', offline: '离线', dead: '失效', unknown: '未知' }
const DF_VULN_SOURCE = {
  active: '主动发现', passive: '被动发现',
  'report-import': '报告导入', manual: '手工记录', human: '人工复核',
  nuclei: 'nuclei', burp: 'Burp', nessus: 'Nessus', fscan: 'fscan', httpx: 'httpx',
  curl: 'curl', sqlmap: 'sqlmap', nmap: 'nmap', agent: '智能体',
}
const DF_SECRET_TYPE = { password: '口令', hash: '哈希', key: '密钥', token: '令牌', cookie: 'Cookie', ticket: '票据' }

/** 来源写的是内部枚举时换成人话；认不出的原样显示，至少不丢信息。 */
function dfVulnSource(value) {
  const key = String(value || '').trim()
  if (!key) return '未标注'
  return DF_VULN_SOURCE[key] || DF_VULN_SOURCE[key.toLowerCase()] || key
}

/**
 * 置信度：库里有 0–1 的小数就换成百分比；没写就按状态给一句人话。
 * 导入的漏洞往往没有 confidence，直接显示「—」会像是面板把数据吃了。
 */
function dfConfidence(value) {
  const raw = value && value.confidence
  if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
    const n = Number(raw)
    if (isFinite(n)) return Math.round(n <= 1 ? n * 100 : n) + '%'
    return String(raw)
  }
  const status = value && value.status
  if (status === 'exploited') return '高（已复现）'
  if (status === 'confirmed') return '高（人工确认）'
  if (status === 'candidate') return '待验证'
  return '—'
}

/**
 * 放进 AI 草稿的靶标行。面板切换靶标只改全局「当前靶标」，不改会话绑定；
 * 不把 engagement 显式写进提示词，模型会按会话绑定写到旧靶标去。
 */
function dfEngagementLine(eng) {
  const id = String(eng || '').trim()
  if (!id) return ''
  return '靶标：' + id + '（调用 redteam 工具时带 args.engagement="' + id + '"）'
}

/** 从 target 取主机名（不带端口）；取不到返回空串。 */
function dfHostName(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'http://' + text)
    return String(u.hostname || '').replace(/^\[|\]$/g, '')
  } catch { return '' }
}

/** URL → 路径 + 查询串；给报文卡片抬头用。 */
function dfPathOf(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  try {
    const u = new URL(text)
    return (u.pathname || '/') + (u.search || '')
  } catch {
    return text.startsWith('/') ? text : ''
  }
}

const DF_ACT = {
  step: { label: '步骤', icon: 'route', bar: 'info' },
  vuln: { label: '漏洞', icon: 'bug', bar: 'err' },
  webshell: { label: 'WebShell', icon: 'terminal', bar: 'warn' },
  credential: { label: '凭据', icon: 'key', bar: 'ok' },
  shot: { label: '截图', icon: 'eye', bar: 'ok' },
}

const DF_ASSET_STATE = { live: '存活', unknown: '未知', dead: '下线' }
/* 优先级是英文枚举，直接显示 medium/low 对第一次打开的人没有意义。 */
const DF_PRIORITY = { critical: '紧急', high: '高', medium: '中', low: '低' }
const DF_PRIORITY_KIND = { critical: 'err', high: 'err', medium: 'warn', low: 'line' }

function dfPriorityLabel(p) {
  const key = String(p || '').toLowerCase()
  return DF_PRIORITY[key] || dfDash(p)
}

/* 覆盖矩阵的八类测试用内部类名，直接摆在列头上没人看得懂。
   这里换成动作化的名字 + 一句人话，表格上方再点明「格子是状态，不是按钮」。 */
const DF_MX_LABEL = {
  authn: '认证绕过',
  authz: '越权访问',
  injection: '注入执行',
  file: '文件与路径',
  ssrf: 'SSRF',
  logic: '业务逻辑',
  client: '前端/客户端',
  infra: '基础设施',
}
const DF_MX_HINT = {
  authn: '免登录 / 弱口令',
  authz: '读他人数据 / 提权',
  injection: 'SQLi / RCE / 模板',
  file: '上传 / 下载 / 穿越',
  ssrf: '服务端请求 / 元数据',
  logic: '价格 / 状态 / 并发',
  client: 'XSS / CSRF / CORS',
  infra: '暴露服务 / 云 / 默认口令',
}
const DF_MX_DESC = {
  authn: '认证绕过：没有账号、换账号或伪造令牌能不能进系统',
  authz: '越权访问：改 id / 租户 / 参数读他人数据，或普通账号做管理员操作',
  injection: '注入执行：SQLi、命令、模板、反序列化、XXE 能不能打到执行',
  file: '文件与路径：上传、下载、任意文件读取、路径穿越',
  ssrf: 'SSRF：服务端请求能不能打到内网、云元数据或本地服务',
  logic: '业务逻辑：价格、数量、优惠、退款、审批、状态机和并发竞态',
  client: '前端/客户端：XSS、CSRF、CORS、postMessage、DOM、Electron 和存储',
  infra: '基础设施：暴露服务、默认口令、Redis/ES/Docker/K8s、云存储和调试面',
}
/* 覆盖账本只有 4 个结论（coverage.status）。早先图例里的「受阻」并不在枚举里，
   真实会出现的「跳过」反而没有图例，这里一并纠正。 */
const DF_MX_STATUS = {
  tested: { label: '已测', desc: '已完成探测并记录结论（不代表存在漏洞）' },
  clean: { label: '干净', desc: '已测，确认无可利用点' },
  skipped: { label: '跳过', desc: '主动放弃：不适用 / 风险过高' },
  untested: { label: '未测', desc: '该类尚未测试' },
}

function dfSevMeta(sev) {
  return DF_SEV[String(sev || '').toLowerCase()] || DF_SEV.info
}

function DfSevBadge(props) {
  const meta = dfSevMeta(props.severity)
  return h('span', { className: 'df-sev df-sev--' + meta.cls, title: props.severity || '' },
    h('i'), meta.label)
}

function DfTestChip(props) {
  const key = String(props.status || 'untested')
  return h(DfChip, { kind: DF_TEST_KIND[key] || 'line' }, DF_TEST_LABEL[key] || key)
}

/* 覆盖矩阵是收口门认的那本账；资产级“侦察状态”单独显示，避免面板说已测、门禁说未测。 */
function DfCoverageChip(props) {
  const done = Number(props.done) || 0
  const total = Number(props.total) || 8
  const kind = done === 0 ? 'line' : (done >= total ? 'ok' : 'info')
  return h(DfChip, { kind: kind, title: (props.missing || []).join(' / ') }, done + '/' + total)
}

function DfVulnStatusChip(props) {
  const key = String(props.status || '')
  return h(DfChip, { kind: DF_VULN_KIND[key] || 'line' }, DF_VULN_STATUS[key] || dfDash(key))
}

function DfPortPills(props) {
  const ports = Array.isArray(props.ports) ? props.ports : []
  if (!ports.length) return h('span', { className: 'df-ri-side' }, '—')
  const shown = ports.slice(0, props.max || 4)
  return h('div', { className: 'df-portlist' }, shown.map(function (p, i) {
    const label = String(p.port) + (p.service ? '/' + p.service : '')
    return h('span', {
      key: i,
      className: 'df-port',
      title: [p.port, p.proto, p.service, p.product, p.version].filter(Boolean).join(' '),
    }, label)
  }), ports.length > shown.length
    ? h('span', { className: 'df-port df-port--more' }, '+' + (ports.length - shown.length))
    : null)
}

function DfAssetCell(props) {
  const a = props.asset || {}
  const name = a.primary_name || a.ip
  const extra = (a.names || []).filter(function (n) { return n.name && n.name !== name && n.name !== a.ip })[0]
  const sub = extra ? extra.name : (name && name !== a.ip ? name : '')
  return h('div', { className: 'df-asset' },
    h('div', { className: 'df-asset-ip' }, dfDash(a.ip)),
    sub ? h('div', { className: 'df-asset-name' }, dfShort(sub, 34)) : null)
}

function dfScopeLabel(scope) {
  if (scope === 'internal') return '内网'
  if (scope === 'external') return '外网'
  return '—'
}

/** 统一的错误/空白容器：都带重试入口。 */
function DfOpsError(props) {
  return h('div', { className: 'df-ops-blank' }, h(DfEmpty, {
    icon: 'alert',
    title: props.title || '读取失败',
    hint: props.error || '',
    action: props.onRetry ? h(DfBtn, { size: 'sm', icon: 'refresh', onClick: props.onRetry }, '重试') : null,
  }))
}

/* ---------------------------------------------------------------- 覆盖矩阵 */

function DfMatrix(props) {
  const m = props.matrix
  /* 这页的用途是「找还没测的地方」，所以默认把缺口最大的资产排在最前。 */
  const [order, setOrder] = useState('gap')
  if (!m || !Array.isArray(m.rows) || !m.rows.length) {
    return h(DfEmpty, { icon: 'grid', title: '还没有资产', hint: '资产收集完成后显示覆盖情况。' })
  }
  /* blocked 只在极老的数据里可能出现，映射留着兜底，图例里不再列。 */
  const short = { tested: '已测', clean: '干净', skipped: '跳过', blocked: '受阻', untested: '未测' }
  const statusOf = function (s) {
    return DF_MX_STATUS[s] || { label: short[s] || s, desc: '' }
  }
  const codeLabel = function (c) { return DF_MX_LABEL[c.code] || c.label }
  const rows = order === 'gap'
    ? m.rows.slice().sort(function (a, b) {
      const ga = a.total - a.done
      const gb = b.total - b.done
      if (ga !== gb) return gb - ga
      return String(a.ip).localeCompare(String(b.ip), 'zh-CN', { numeric: true })
    })
    : m.rows
  return h('div', { className: 'df-mxbox' },
    h('div', { className: 'df-mx-top' },
      h('div', { className: 'df-mx-legend' }, Object.keys(DF_MX_STATUS).map(function (k) {
        const st = DF_MX_STATUS[k]
        return h('span', { key: k, className: 'df-mx-lg', title: st.label + '：' + st.desc },
          h('i', { className: 'df-mx-dot df-mx-dot--' + k }), st.label)
      })),
      h('div', { className: 'df-mx-tools' },
        h(DfSeg, {
          value: order,
          items: [['gap', '缺口优先'], ['asset', '资产顺序']],
          onChange: function (v) { setOrder(v) },
        }))),
    h('div', { className: 'df-mx-note' },
      props.hint || '格子里是状态，点整行补测'),
    h('div', { className: 'df-mxwrap' },
      h('table', { className: 'df-mx' },
        h('thead', null, h('tr', null,
          h('th', { className: 'df-mx-an' }, h('span', { className: 'df-mx-l' }, '资产'),
            h('span', { className: 'df-mx-h' }, '还差几类')),
          m.classes.map(function (c) {
            return h('th', {
              key: c.code,
              className: 'df-mx-th',
              title: DF_MX_DESC[c.code] || c.label,
            },
              h('span', { className: 'df-mx-l' }, codeLabel(c)),
              h('span', { className: 'df-mx-h' }, DF_MX_HINT[c.code] || ''))
          }),
          h('th', { className: 'df-mx-go', title: '打开资产页补测' }, ''))),
        h('tbody', null, rows.map(function (r) {
          const gap = r.total - r.done
          return h('tr', {
            key: r.assetId,
            className: props.onPick ? 'df-row--click' : '',
            title: props.onPick ? '打开这台资产的详情' : undefined,
            onClick: props.onPick ? function () { props.onPick(r) } : undefined,
          },
            h('td', { className: 'df-mx-an', title: r.ip },
              h('div', { className: 'df-mx-aip' }, r.ip),
              h('div', { className: 'df-mx-sub' },
                gap === 0
                  ? h('span', { className: 'df-mx-sub--done' }, '已全部测过')
                  : (r.done === 0
                    ? (r.testStatus && r.testStatus !== 'untested'
                      ? h('span', { className: 'df-mx-sub--done' }, '已测（未分类）')
                      : h('span', { className: 'df-mx-gap df-mx-gap--all' }, '全部未测'))
                    : h('span', null,
                      r.done + '/5 测过 · ',
                      h('b', { className: 'df-mx-gap df-mx-gap--some' }, '差 ' + gap + ' 类'))))),
            m.classes.map(function (c) {
              const s = String(r.cells[c.code] || 'untested')
              const st = statusOf(s)
              return h('td', { key: c.code },
                h('span', {
                  className: 'df-cell df-cell--' + s,
                  title: (DF_MX_DESC[c.code] || c.label) + '\n' + st.label + '：' + st.desc,
                },
                  h('i'), st.label))
            }),
            h('td', { className: 'df-mx-go' }, '›'))
        })))))
}

/* ---------------------------------------------------------------- 概览 */

function DfOverview(props) {
  const eng = props.eng
  const state = dfUseAsync(function () {
    return Promise.all([
      dfApi('viewOverview', { engagement: eng }),
      dfApi('vulnStats', { engagement: eng }, { ttl: 15000 }),
    ]).then(function (r) {
      const ov = r[0] || {}
      if (ov.ok === false) throw new Error(ov.error || '读取概览失败')
      return { ov: ov, va: (r[1] && r[1].stats) || {} }
    })
  }, [eng, props.tick])

  if (state.loading && !state.data) return h(DfSkeleton, { lines: 8 })
  if (state.error || !state.data) {
    return h(DfOpsError, { title: '读取概览失败', error: state.error, onRetry: state.reload })
  }

  const ov = state.data.ov
  const va = state.data.va
  const s = ov.stats || {}
  const m = ov.matrix || { summary: {}, rows: [] }
  const sm = m.summary || {}
  const bySev = va.bySeverity || {}
  const next = ov.next || []
  /* 概览侧栏只当「扫一眼」用：截到 6 条，和左边待办卡的高度差不会拉太大。 */
  const activity = (ov.activity || []).slice(0, 6)

  return h('div', { className: 'df-ops' },
    h('div', { className: 'df-opsbar' },
      h('span', { className: 'df-ops-title' }, '作业概览'),
      h('span', { className: 'df-spacer' }),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', onClick: state.reload }, '刷新')),

    h('div', { className: 'df-kpis' },
      h(DfKpi, {
        label: '资产', icon: 'server', value: dfNum(s.assets || 0),
        foot: '存活 ' + dfNum(s.liveAssets || 0) + ' · 开放端口 ' + dfNum(s.openPorts || 0),
      }),
      h(DfKpi, {
        label: '覆盖率', icon: 'grid', value: dfPct(sm.tested, sm.assets),
        foot: dfNum(sm.tested || 0) + '/' + dfNum(sm.assets || 0) + ' 资产已有覆盖',
        accent: (sm.assets || 0) > 0 && (sm.tested || 0) === (sm.assets || 0),
      }),
      h(DfKpi, {
        label: '覆盖缺口', icon: 'alert', value: dfNum(sm.gaps || 0), unit: '格',
        foot: '零覆盖 ' + dfNum(sm.untouched || 0) + ' 个资产',
        accent: (sm.gaps || 0) > 0,
      }),
      h(DfKpi, {
        label: '漏洞', icon: 'bug', value: dfNum(s.vulns || 0),
        foot: '严重 ' + dfNum(bySev.critical || 0) + ' · 高危 ' + dfNum(bySev.high || 0),
      }),
      h(DfKpi, {
        label: '成果', icon: 'key', value: dfNum(s.accesses || 0), unit: '访问',
        foot: '凭据 ' + dfNum(s.credentials || 0) + ' · 服务 ' + dfNum(s.services || 0),
      })),

    h('div', { className: 'df-ov-cols' },
        h(DfCard, {
          className: 'df-ov-next',
          title: '下一步', icon: 'arrowRight',
          sub: next.length ? next.length + ' 条' : '没有缺口',
          actions: next.length ? h(DfBtn, {
            size: 'sm', kind: 'ghost', icon: 'list',
            onClick: function () { props.onGoto && props.onGoto('assets') },
          }, '去资产') : null,
        },
          next.length
            ? h('div', { className: 'df-rows' }, next.map(function (n, i) {
              const icon = n.kind === 'channel' ? 'link'
                : n.kind === 'deliver' ? 'fileText'
                  : (n.kind === 'evidence' ? 'alert' : (n.kind === 'verify' ? 'check' : 'target'))
              return h('div', {
                key: i,
                className: 'df-rowitem df-rowitem--click',
                onClick: function () {
                  if (!props.onGoto) return
                  props.onGoto(n.kind === 'channel' ? 'sessions'
                    : n.kind === 'deliver' ? 'report'
                      : (n.kind === 'evidence' || n.kind === 'verify') ? 'vulns' : 'assets')
                },
              },
                h('span', { className: 'df-next-ico' }, dfIcon(icon, 13)),
                h('span', { className: 'df-ri-main' }, n.text),
                h(DfChip, { kind: n.kind === 'channel' ? 'info' : n.kind === 'deliver' ? 'line' : (n.kind === 'evidence' ? 'err' : 'warn') }, n.why || n.kind))
            }))
            : h(DfEmpty, { icon: 'check', title: '没有待办的缺口', hint: '暂无缺口。' })),

        h(DfCard, {
          className: 'df-ov-log',
          title: '最近作业', icon: 'clock', sub: activity.length ? activity.length + ' 条' : '',
          actions: h(DfBtn, {
            size: 'sm', kind: 'ghost', icon: 'list',
            onClick: function () { props.onGoto && props.onGoto('log') },
          }, '全部日志'),
        },
          activity.length
            ? h('div', { className: 'df-rows' }, activity.map(function (a, i) {
              const meta = DF_ACT[a.kind] || DF_ACT.step
              return h('div', {
                key: i,
                className: 'df-rowitem df-rowitem--click',
                onClick: function () { props.onInspect && props.onInspect(dfActivityDrawer(a)) },
              },
                h('i', { className: 'df-ri-bar df-ri-bar--' + meta.bar }),
                h('span', { className: 'df-ri-main' }, a.title),
                h('span', { className: 'df-ri-side' }, dfAgo(a.at)))
            }))
            : h(DfEmpty, { icon: 'clock', title: '还没有作业记录' })),

        h(DfCard, {
          className: 'df-ov-mx',
          title: '覆盖矩阵', icon: 'grid',
          sub: '每台资产 × 八类测试',
          actions: h(DfBtn, {
            size: 'sm', kind: 'ghost', icon: 'list',
            onClick: function () { props.onGoto && props.onGoto('assets') },
          }, '去资产'),
        },
          h('div', { style: { padding: '10px 10px 10px' } },
            h(DfMatrix, {
              matrix: m,
              onPick: function (r) {
                if (props.onGoto) props.onGoto('assets', r && r.assetId)
              },
            })))))
}

/** 日志条目 → 抽屉结构（概览「最近作业」复用）。 */
function dfActivityDrawer(a) {
  const meta = DF_ACT[a.kind] || DF_ACT.step
  const status = a.kind === 'webshell'
    ? (DF_SHELL_STATUS[a.status] || a.status)
    : (a.kind === 'vuln' ? (DF_VULN_STATUS[a.status] || a.status) : '')
  const rows = [
    ['类型', meta.label],
    ['时间', dfTime(a.at, true)],
    ['来源', a.who === 'ai' ? 'AI' : dfDash(a.who)],
    ['来源阶段', DF_STAGE_LABEL[a.stage] || dfDash(a.stage)],
  ]
  if (a.severity) rows.push(['严重度', (DF_SEV[String(a.severity).toLowerCase()] || DF_SEV.info).label])
  if (status) rows.push(['状态', status])
  if (a.target) rows.push(['目标', a.target])
  if (a.tool) rows.push(['工具', a.tool])
  if (a.privilege) rows.push(['权限', a.privilege])
  if (a.result) rows.push(['结果', a.result])
  rows.push(['ID', a.id])
  return {
    title: a.title || meta.label,
    sub: meta.label + (a.who === 'ai' ? ' · AI' : ''),
    rows: rows,
    node: a.detail
      ? h('div', { className: 'df-detail' },
        h('section', { className: 'df-detail-sec' },
          h('h4', null, '详情'),
          h('pre', { className: 'df-evi' }, String(a.detail))))
      : null,
  }
}

/* ---------------------------------------------------------------- 资产 */

function DfAssets(props) {
  const eng = props.eng
  const [q, setQ] = useState('')
  const [st, setSt] = useState('')
  const [sort, setSort] = useState('todo')
  const [mode, setMode] = useState('table')
  const [selId, setSelId] = useState('')

  const state = dfUseAsync(function () {
    const jobs = [dfApi('assets', {
      engagement: eng, limit: 2000, sort: sort,
      q: q.trim() || undefined,
      test_status: st || undefined,
    })]
    if (mode === 'matrix') jobs.push(dfApi('viewMatrix', { engagement: eng }))
    return Promise.all(jobs).then(function (r) {
      const list = r[0] || {}
      if (list.ok === false) throw new Error(list.error || '读取资产失败')
      return { list: list, matrix: mode === 'matrix' ? r[1] : null }
    })
  }, [eng, props.tick, q, st, sort, mode])

  const data = state.data
  const rows = (data && data.list && data.list.items) || []
  const total = (data && data.list && data.list.total) || 0
  const matrix = data && data.matrix
  const sm = (matrix && matrix.summary) || {}

  /* 从概览矩阵点行进来的那台资产：数据到位后自动展开详情。 */
  useEffect(function () {
    if (!props.focusAsset || !rows.length) return
    let hit = null
    for (let i = 0; i < rows.length; i += 1) {
      if (String(rows[i].id) === String(props.focusAsset)) { hit = rows[i]; break }
    }
    if (!hit) return
    /* 顺手按 IP 过滤：从矩阵跳过来时，列表里就只剩这一台，不会出现「抽屉里是 A、列表里找不到 A」。 */
    setQ(hit.ip)
    setSelId(hit.id)
    if (props.onInspect) props.onInspect(dfAssetDrawer(hit, eng, state.reload))
    if (props.onFocusConsumed) props.onFocusConsumed()
  }, [props.focusAsset, rows.length])

  /* 卡片级操作：排序 + 视图切换。两个卡片（表格 / 矩阵）共用同一份。 */
  const viewActions = h('div', { className: 'df-opsbar' },
    h('select', {
      className: 'df-select', value: sort, title: '排序',
      onChange: function (e) { setSort(e.target.value) },
    },
      h('option', { value: 'todo' }, '待测优先'),
      h('option', { value: 'priority' }, '优先级'),
      h('option', { value: 'discovered' }, '最新发现'),
      h('option', { value: 'ports' }, '端口最多')),
    h(DfSeg, {
      value: mode, items: [['table', '表格'], ['matrix', '矩阵']],
      onChange: function (v) { setMode(v) },
    }))

  return h('div', { className: 'df-ops' },
    /* 标题行只放「页面级」的东西：标题、说明、搜索、状态筛选。
       视图切换和排序属于这张卡片的，放进卡片标题栏 —— 免得首屏两条横杠、重心下移。 */
    h('div', { className: 'df-opsbar' },
      h('span', { className: 'df-ops-title' }, '资产'),
      h('span', { className: 'df-ops-meta' }, '共 '
        + (state.loading && !data ? '—' : dfNum(total)) + ' 个'),
      h('span', { className: 'df-spacer' }),
      h(DfSearch, {
        value: q, placeholder: '搜索 IP / 域名 / 指纹 / 端口服务',
        onChange: function (v) { setQ(v) }, style: { width: 236 },
      }),
      h(DfSeg, {
        value: st,
        items: [['', '全部'], ['untested', '未测'], ['tested', '已测'], ['blocked', '受阻']],
        onChange: function (v) { setSt(v) },
      })),

    mode === 'matrix'
      ? h(DfCard, {
        title: '覆盖矩阵', icon: 'grid',
        sub: dfNum(sm.assets || 0) + ' 个资产 · 缺口 ' + dfNum(sm.gaps || 0) + ' 格',
        actions: viewActions,
      },
        h('div', { style: { padding: '0 8px 8px' } }, h(DfMatrix, {
          matrix: matrix,
          hint: '格子里是状态；点整行去补测',
        })))
      : h(DfCard, {
        title: '列表', icon: 'server', sub: rows.length !== total ? '显示 ' + rows.length + ' / ' + total : '',
        actions: viewActions,
      },
        state.error
          ? h(DfOpsError, { title: '读取资产失败', error: state.error, onRetry: state.reload })
          : rows.length
            ? h('div', { className: 'df-tablewrap' },
              h(DfTable, {
                rows: rows,
                rowKey: function (r) { return r.id },
                selectedKey: selId,
                onRow: function (r) {
                  setSelId(r.id)
                  if (props.onInspect) props.onInspect(dfAssetDrawer(r, eng, state.reload))
                },
                columns: [
                  { key: 'ip', title: '资产', width: '24%', sortable: true, render: function (r) { return h(DfAssetCell, { asset: r }) } },
                  {
                    key: 'coverage', title: '覆盖', width: 76,
                    sortValue: function (r) { return Number(r.coverage_done) || 0 },
                    render: function (r) {
                      return h(DfCoverageChip, { done: r.coverage_done, total: r.coverage_total, missing: r.coverage_missing })
                    },
                  },
                  {
                    key: 'test_status', title: '侦察', width: 92,
                    sortValue: function (r) { return DF_TEST_LABEL[r.test_status] || '未侦察' },
                    render: function (r) { return h(DfTestChip, { status: r.test_status }) },
                  },
                  {
                    key: 'priority', title: '优先级', width: 78,
                    render: function (r) {
                      if (!r.priority) return h('span', { className: 'df-ri-side' }, '—')
                      const kind = DF_PRIORITY_KIND[String(r.priority).toLowerCase()] || 'line'
                      return h(DfChip, { kind: kind }, dfPriorityLabel(r.priority))
                    },
                  },
                  { key: 'ports', title: '端口', render: function (r) { return h(DfPortPills, { ports: r.ports }) } },
                  {
                    key: 'scope', title: '范围', width: 66,
                    render: function (r) { return h(DfChip, { kind: r.scope === 'external' ? 'warn' : 'line' }, dfScopeLabel(r.scope)) },
                  },
                  {
                    key: 'discovered_at', title: '发现', width: 92, align: 'right',
                    sortValue: function (r) { return r.discovered_at || r.first_seen || '' },
                    render: function (r) { return dfAgo(r.discovered_at || r.first_seen) },
                  },
                ],
              }))
            : state.loading
              ? h(DfSkeleton, { lines: 6 })
              : h(DfEmpty, {
                icon: 'server', title: '没有匹配的资产',
                hint: q || st ? '换个关键词或清除筛选试试。' : '侦察结果还没有入库。',
              })))
}

function DfAssetTestBox(props) {
  const [status, setStatus] = useState(props.a.test_status || 'untested')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  function save() {
    if (busy) return
    setBusy(true)
    dfApi('assetTest', {
      engagement: props.eng, asset_id: props.a.id,
      status: status, test: String(note || '').trim(), updated_by: 'human',
    }).then(function (r) {
      setBusy(false)
      if (!r || r.ok === false) { dfToast((r && r.error) || '保存失败', 'err', 4200); return }
      dfBust()
      dfToast('已记录：' + (DF_TEST_LABEL[status] || status), 'ok', 1800)
      setNote('')
      if (props.onDone) props.onDone()
    }, function (e) {
      setBusy(false)
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  return h('section', { className: 'df-detail-sec' },
    h('div', { className: 'df-detail-hd' },
      h('h4', null, '人工记录'),
      h(DfTestChip, { status: status })),
    h('div', { className: 'df-hint' }, '资产级侦察/测试记录，AI 评估资产时会读取；八类覆盖以矩阵为准，不在这里代替。'),
    h(DfSeg, {
      value: status,
      items: [['untested', '未侦察'], ['tested', '侦察完成'], ['blocked', '受阻'], ['no_surface', '无攻击面'], ['abandoned', '放弃']],
      onChange: function (v) { setStatus(v) },
    }),
    h('textarea', {
      className: 'df-area', rows: 1, value: note,
      placeholder: '一句话结论：测了什么、结果如何（可空）',
      onChange: function (e) { setNote(e.target.value) },
      /* 和漏洞复核框一致：.df-area 默认 120px 太高，这里压到 60。 */
      style: { width: '100%', marginTop: 8, minHeight: 60, height: 60 },
    }),
    h('div', { style: { marginTop: 8 } },
      h(DfBtn, { size: 'sm', kind: 'primary', icon: 'check', disabled: busy, onClick: save }, busy ? '保存中…' : '保存记录')))
}

function dfAssetDrawer(a, eng, onDone) {
  const ports = Array.isArray(a.ports) ? a.ports : []
  const names = Array.isArray(a.names) ? a.names : []
  /* 同一指纹常挂在多个端口上（80/443 同为 nginx），抽屉里合并展示，避免重复 chip。 */
  const seenFp = {}
  const fps = (Array.isArray(a.fingerprints) ? a.fingerprints : []).filter(function (f) {
    const key = [f.category, f.vendor, f.product, f.version].filter(Boolean).join('|')
    if (key === '' || seenFp[key]) return false
    seenFp[key] = true
    return true
  })
  return {
    mode: 'page',
    title: a.ip,
    sub: a.primary_name || dfScopeLabel(a.scope) + '资产',
    rows: [
      ['IP', a.ip],
      ['主域名', a.primary_name],
      ['范围', dfScopeLabel(a.scope)],
      ['状态', DF_ASSET_STATE[a.state] || dfDash(a.state)],
      ['覆盖', (a.coverage_done || 0) + '/' + (a.coverage_total || 8) + (a.coverage_missing && a.coverage_missing.length ? '（缺：' + a.coverage_missing.join('、') + '）' : '')],
      ['侦察状态', DF_TEST_LABEL[a.test_status] || a.test_status],
      ['优先级', a.priority ? dfPriorityLabel(a.priority) : ''],
      ['开放端口', (a.open_port_count || ports.length) + ' 个'],
      ['发现时间', dfTime(a.discovered_at || a.first_seen)],
      ['最近活动', dfTime(a.last_seen)],
      ['潜在成果', a.potential],
      ['评估理由', a.assess_reason],
      ['测试备注', a.test_notes],
    ],
    node: h('div', { className: 'df-detail' },
      h('div', { style: { display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' } },
        h(DfBtn, {
          size: 'sm', kind: 'ghost', icon: 'spark',
          onClick: function () {
            const open = ports.filter(function (p) { return p.state === 'open' }).slice(0, 12)
            const portText = open.length ? open.map(function (p) { return p.port + '/' + (p.proto || 'tcp') }).join('、') : '暂无开放端口记录'
            dfDraftToComposer([
              '看一下这个资产（id=' + a.id + '）：' + a.ip + (a.primary_name ? '（' + a.primary_name + '）' : ''),
              dfEngagementLine(eng),
              '范围：' + dfScopeLabel(a.scope) + ' · 侦察状态：' + (DF_TEST_LABEL[a.test_status] || a.test_status || '未侦察')
                + ' · 覆盖：' + (a.coverage_done || 0) + '/' + (a.coverage_total || 8)
                + (a.coverage_missing && a.coverage_missing.length ? '（缺：' + a.coverage_missing.join('、') + '）' : ''),
              '开放端口：' + portText,
              '先判断优先测试哪个攻击面，必要时继续。',
            ].filter(Boolean).join('\n'), '已把资产放进输入框')
          },
        }, '请 AI 评估')),
      eng ? h(DfAssetTestBox, { eng: eng, a: a, onDone: onDone }) : null,
      names.length
        ? h('section', { className: 'df-detail-sec' },
          h('h4', null, '域名 / 主机名'),
          h('div', { className: 'df-chips' }, names.map(function (n, i) {
            return h(DfChip, { key: i, kind: 'line' }, n.name)
          })))
        : null,
      ports.length
        ? h('section', { className: 'df-detail-sec' },
          h('h4', null, '端口与服务'),
          h('div', { className: 'df-tablewrap df-tablewrap--flat' },
            h('table', { className: 'df-table df-table--compact' },
              h('thead', null, h('tr', null,
                h('th', null, '端口'), h('th', null, '服务'), h('th', null, '产品'), h('th', null, '来源'))),
              h('tbody', null, ports.map(function (p, i) {
                return h('tr', { key: i },
                  h('td', { className: 'df-mono' }, String(p.port) + '/' + (p.proto || 'tcp')),
                  h('td', null, dfDash(p.service)),
                  h('td', null, [p.product, p.version].filter(Boolean).join(' ') || '—'),
                  h('td', null, p.provenance === 'passive' ? '被动' : '主动'))
              })))))
        : null,
      fps.length
        ? h('section', { className: 'df-detail-sec' },
          h('h4', null, '指纹'),
          h('div', { className: 'df-chips' }, fps.map(function (f, i) {
            return h(DfChip, { key: i, kind: 'info' }, [f.vendor, f.product, f.version].filter(Boolean).join(' '))
          })))
        : null)
  }
}

/* ---------------------------------------------------------------- 漏洞 */

/* 人工复核：AI 只写 candidate / exploited，确认与误报由人做，理由落库。 */
function DfReviewBox(props) {
  const v = props.v
  const [note, setNote] = useState(v.review_note || '')
  const [busy, setBusy] = useState('')
  const pending = v.status === 'candidate' || v.status === 'exploited'

  function submit(verdict) {
    if (busy) return
    const text = String(note || '').trim()
    if (verdict === 'false-positive' && !text) { dfToast('标记误报需填写理由', 'err', 3000); return }
    setBusy(verdict)
    dfApi('reviewVuln', { engagement: props.eng, id: v.id, verdict: verdict, note: text, by: 'human' }).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '复核失败', 'err', 4200); return }
      dfBust()
      dfToast('已复核：' + (DF_VULN_STATUS[verdict] || verdict), 'ok', 1800)
      if (props.onDone) props.onDone(Object.assign({}, v, {
        status: verdict, review_note: text, reviewed_at: r.reviewed_at, reviewed_by: r.reviewed_by,
      }))
    })
  }

  return h('section', { className: 'df-detail-sec' },
    h('div', { className: 'df-detail-hd' },
      h('h4', null, '人工复核'),
      pending ? h(DfChip, { kind: 'warn' }, '待复核') : h(DfChip, { kind: 'ok' }, '已复核')),
    h('div', { className: 'df-hint' },
      pending
        ? '确认后才会进入报告；标记误报需填写理由。'
        : (v.reviewed_at
          ? '已由 ' + (v.reviewed_by || 'human') + ' 于 ' + dfTime(v.reviewed_at) + ' 复核。'
          : '缺少复核记录（旧数据），再点「确认成立」补全。')),
    h('textarea', {
      className: 'df-area', rows: 1, value: note,
      placeholder: '复核理由：判定成立或不成立的原因（标记误报时必填）',
      onChange: function (e) { setNote(e.target.value) },
      /* .df-area 默认 min-height 120px，这里单独压到 60：复核理由通常一两句话。 */
      style: { width: '100%', marginTop: 6, minHeight: 60, height: 60 },
    }),
    h('div', { style: { marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' } },
      h(DfBtn, { size: 'sm', kind: 'primary', icon: 'check', disabled: !!busy, onClick: function () { submit('confirmed') } }, busy === 'confirmed' ? '确认中…' : '确认成立'),
      h(DfBtn, { size: 'sm', kind: 'danger', icon: 'close', disabled: !!busy, onClick: function () { submit('false-positive') } }, busy === 'false-positive' ? '提交中…' : '标记误报'),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'check', disabled: !!busy, onClick: function () { submit('fixed') } }, '已修复'),
      pending ? null : h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', disabled: !!busy, onClick: function () { submit('candidate') } }, '退回候选')))
}

/* 人手工记一条发现：默认 candidate，仍走人工复核。 */
function DfManualVuln(props) {
  const [title, setTitle] = useState('')
  const [severity, setSeverity] = useState('medium')
  const [target, setTarget] = useState('')
  const [evidence, setEvidence] = useState('')
  const [busy, setBusy] = useState(false)
  const ok = !!title.trim() && !!evidence.trim()

  function save() {
    if (busy || !ok) return
    setBusy(true)
    dfApi('addVuln', {
      engagement: props.eng,
      title: title.trim(),
      severity: severity,
      target: target.trim(),
      evidence: evidence.trim(),
      source: 'manual',
      status: 'candidate',
      found_by_agent: 'human',
      confidence: 0.8,
    }).then(function (r) {
      setBusy(false)
      if (!r || r.ok === false) { dfToast((r && r.error) || '保存失败', 'err', 4200); return }
      dfBust()
      dfToast('已记录，状态为待复核', 'ok', 2200)
      if (props.onDone) props.onDone()
    }, function (e) {
      setBusy(false)
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  return h('div', { className: 'df-detail' },
    h('div', { className: 'df-note' }, '默认记为「候选」，人工复核后才进报告。'),
    h(DfField, { label: '标题' },
      h('input', { className: 'df-input', value: title, autoFocus: true, placeholder: '例如：后台管理弱口令', onChange: function (e) { setTitle(e.target.value) } })),
    h(DfField, { label: '严重度' },
      h('select', { className: 'df-select', value: severity, onChange: function (e) { setSeverity(e.target.value) } },
        ['critical', 'high', 'medium', 'low', 'info'].map(function (k) {
          return h('option', { key: k, value: k }, (DF_SEV[k] || DF_SEV.info).label)
        }))),
    h(DfField, { label: '目标' },
      h('input', { className: 'df-input', value: target, placeholder: 'https://host/path 或 ip:port', onChange: function (e) { setTarget(e.target.value) } })),
    h(DfField, { label: '证据（必填）' },
      h('textarea', { className: 'df-area', rows: 4, value: evidence, placeholder: '请求/响应、命令回显、截图路径…', onChange: function (e) { setEvidence(e.target.value) } })),
    h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
      h(DfBtn, { size: 'sm', kind: 'primary', icon: 'check', disabled: busy || !ok, onClick: save }, busy ? '保存中…' : '保存为候选'),
      h('span', { className: 'df-hint' }, ok ? '' : '标题和证据必填')))
}

/* ---------------------------------------------------------------- 复现报文 */

/** 状态码 → 颜色档位（沿用 chip 的 ok/info/warn/err）。 */
function dfStatusKind(status) {
  const n = Number(status)
  if (!isFinite(n)) return 'line'
  if (n >= 500) return 'err'
  if (n >= 400) return 'warn'
  if (n >= 300) return 'info'
  if (n >= 200) return 'ok'
  return 'line'
}

/** 原始报文按行上色：请求行/状态行加粗、头灰一点、正文原样。 */
function dfHttpLineSpans(text) {
  return String(text || '').replace(/\r/g, '').split('\n').map(function (line, i) {
    let cls = ''
    if (i === 0) {
      if (/^HTTP\/\d/.test(line)) cls = 'df-htp-status'
      else if (/^[A-Z][A-Z0-9-]*\s+\S+/.test(line)) cls = 'df-htp-start'
    }
    if (!cls && /^[A-Za-z0-9_.-]+:/.test(line)) cls = 'df-htp-head'
    return h('span', { key: i, className: cls || undefined }, line + '\n')
  })
}

/**
 * 一张 Burp 风格的报文卡：抬头是方法 + 路径 + 状态码，下面左右两栏
 * Request / Response，内容就是可复制的原始报文。
 */
function DfHttpPacket(props) {
  const p = props.p || {}
  const request = String(p.request || '')
  const response = String(p.response || '')
  const rawStatus = p.status
  const statusNumber = Number(rawStatus)
  const status = rawStatus === null || rawStatus === undefined || String(rawStatus).trim() === ''
    || !isFinite(statusNumber) ? null : statusNumber
  const statusText = status === null ? '' : (httpStatusText(status) || '')
  const path = p.path || dfPathOf(p.url) || p.url || '/'
  return h('div', { className: 'df-pkt' },
    h('div', { className: 'df-pkt-hd' },
      props.index ? h('span', { className: 'df-pkt-i' }, '#' + props.index) : null,
      h('b', { className: 'df-pkt-m' }, p.method || 'GET'),
      h('span', { className: 'df-pkt-u', title: p.url || path }, path),
      status !== null
        ? h('span', { className: 'df-pkt-st df-pkt-st--' + dfStatusKind(status) },
          String(status) + (statusText ? ' ' + statusText : ''))
        : null,
      p.label ? h('span', { className: 'df-pkt-tag', title: p.label }, dfShort(p.label, 42)) : null,
      h('span', { className: 'dfx-spacer' }),
      h(DfCopyBtn, { text: httpPacketText(p), label: '复制报文', toast: '报文已复制' })),
    h('div', { className: 'df-pkt-grid' + (response ? '' : ' df-pkt-grid--one') },
      h('div', { className: 'df-pkt-col' },
        h('div', { className: 'df-pkt-cap' }, 'Request'),
        h('pre', { className: 'df-pkt-raw' }, dfHttpLineSpans(request || '（没有请求）'))),
      response
        ? h('div', { className: 'df-pkt-col' },
          h('div', { className: 'df-pkt-cap' }, 'Response'),
          h('pre', { className: 'df-pkt-raw' }, dfHttpLineSpans(response)))
        : null))
}

/**
 * 证据区：能整理成报文就按 Burp 的样子显示，整理不出来就退回原文。
 * 原文始终留在「证据原文」折叠里，方便核对整理时有没有丢东西。
 */
function DfEvidence(props) {
  const text = String(props.text || '')
  const packets = props.skipPackets === true ? [] : parseHttpPackets(text, { base: props.target || '' })
  const copyText = packets.length
    ? packets.map(function (p) { return httpPacketText(p) }).join('\n\n')
    : text
  return h('section', { className: 'df-detail-sec' },
    h('div', { className: 'df-detail-hd' },
      h('h4', null, packets.length ? '复现报文' : '证据原文'),
      packets.length ? h(DfChip, { kind: 'info' }, packets.length + ' 条 · Burp 格式') : null,
      h(DfCopyBtn, {
        text: copyText,
        label: packets.length ? '复制报文' : '复制',
        toast: packets.length ? '报文已复制' : '证据已复制',
      })),
    packets.length
      ? h('div', { className: 'df-pkt-list' },
        packets.map(function (p, i) {
          return h(DfHttpPacket, { key: i, p: p, index: i + 1 })
        }),
        h('details', { className: 'df-evi-raw' },
          h('summary', null, '证据原文（排版前）'),
          h('pre', { className: 'df-evi' }, text)))
      : h('pre', { className: 'df-evi' }, text))
}

function DfVulns(props) {
  const eng = props.eng
  const [sev, setSev] = useState('')
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')

  const state = dfUseAsync(function () {
    return dfApi('vulns', {
      engagement: eng, limit: 1000,
      severity: sev || undefined,
      status: status || undefined,
      q: q.trim() || undefined,
    }).then(function (r) {
      if (r && r.ok === false) throw new Error(r.error || '读取漏洞失败')
      return r || {}
    })
  }, [eng, props.tick, sev, status, q])

  const rows = (state.data && state.data.items) || []
  const stats = (state.data && state.data.stats) || {}
  const bySev = stats.bySeverity || {}
  const byStatus = stats.byStatus || {}

  function openManual() {
    if (!props.onInspect) return
    props.onInspect({
      title: '手工记录漏洞',
      sub: '人工补记 · 默认待复核',
      node: h(DfManualVuln, {
        eng: eng,
        onDone: function () {
          state.reload()
          if (props.onCloseDrawer) props.onCloseDrawer()
        },
      }),
    })
  }

  function drawerFor(v) {
    return {
      /* 漏洞详情走整页下钻（像微信/钉钉点进一条详情），不再挤右侧抽屉。 */
      mode: 'page',
      title: v.title,
      sub: (DF_SEV[String(v.severity || '').toLowerCase()] || DF_SEV.info).label + ' · ' + (DF_VULN_STATUS[v.status] || dfDash(v.status)),
      rows: [
        ['严重度', (DF_SEV[String(v.severity || '').toLowerCase()] || DF_SEV.info).label],
        ['状态', DF_VULN_STATUS[v.status] || v.status],
        ['资产', v.asset_ip || dfHostName(v.target)],
        ['目标', v.target || v.asset_ip],
        ['CVE', v.cve || '无'],
        ['置信度', dfConfidence(v)],
        ['来源', dfVulnSource(v.source)],
        ['发现者', v.found_by_agent || v.agent || '未记录'],
        ['发现时间', dfTime(v.found_at)],
        ['产出', v.gained || v.impact],
      ],
      node: h('div', { className: 'df-detail' },
        h('div', { style: { display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' } },
          h(DfBtn, {
            size: 'sm', kind: 'ghost', icon: 'spark',
            onClick: function () {
              dfDraftToComposer([
                '复核这条漏洞（id=' + v.id + '）：' + (v.title || '未命名'),
                '目标：' + (v.target || v.asset_ip || '') + ' · 严重度：' + (DF_SEV[String(v.severity || '').toLowerCase()] || DF_SEV.info).label + ' · 状态：' + (DF_VULN_STATUS[v.status] || v.status),
                dfEngagementLine(eng),
                '证据：' + (String(v.evidence || '').trim() ? dfShort(v.evidence, 280) : '（还没写证据）'),
                '请复现一次：可复现则补充证据；不可复现请说明原因，等待人工标记误报。',
              ].filter(Boolean).join('\n'), '已把漏洞放进输入框')
            },
          }, '让 AI 复核'),
          h(DfBtn, {
            size: 'sm', kind: 'ghost', icon: 'terminal',
            onClick: function () {
              dfDraftToComposer([
                '为这条漏洞生成可直接复现的命令（id=' + v.id + '）：' + (v.title || '未命名'),
                '目标：' + (v.target || v.asset_ip || '') + ' · 类型线索：' + (v.cve || '无 CVE') + ' · 严重度：' + (DF_SEV[String(v.severity || '').toLowerCase()] || DF_SEV.info).label,
                dfEngagementLine(eng),
                '证据：' + (String(v.evidence || '').trim() ? dfShort(v.evidence, 240) : '（还没写证据）'),
                '要求：给 curl / sqlmap / 对应工具的命令行，标注每个参数含义和预期回显；不要执行，我来确认。',
              ].filter(Boolean).join('\n'), '已让 AI 生成复现命令')
            },
          }, '复现命令')),
        h(DfReviewBox, {
          eng: eng, v: v,
          onDone: function (next) {
            state.reload()
            props.onInspect && props.onInspect(drawerFor(next))
          },
        }),
        v.evidence
          ? h(DfEvidence, {
            text: String(v.evidence),
            target: v.target || '',
            skipPackets: Array.isArray(v.http_evidence) && v.http_evidence.length > 0,
          })
          : h('div', { className: 'df-note' }, '先补证据，报告才有内容。'),
        Array.isArray(v.http_evidence) && v.http_evidence.length
          ? h('section', { className: 'df-detail-sec' },
            h('div', { className: 'df-detail-hd' },
              h('h4', null, 'HTTP 证据'),
              h(DfChip, { kind: 'info' }, v.http_evidence.length + ' 条 · Burp 格式')),
            h('div', { className: 'df-pkt-list' }, v.http_evidence.map(function (e, i) {
              return h(DfHttpPacket, {
                key: i,
                index: v.http_evidence.length > 1 ? i + 1 : 0,
                p: {
                  method: e.method || 'GET',
                  url: e.url || '',
                  path: dfPathOf(e.url) || e.url || '/',
                  status: e.status,
                  request: e.request || '',
                  response: e.response || '',
                  label: e.label || e.note || '',
                },
              })
            })))
          : null,
        h(DfShots, { eng: eng, vulnId: v.id, assetId: v.asset_id, target: v.target }))
    }
  }

  const sevTiles = [
    { key: '', cls: 'all', label: '全部', n: stats.total || 0 },
    { key: 'critical', cls: 'critical', label: '严重', n: bySev.critical || 0 },
    { key: 'high', cls: 'high', label: '高危', n: bySev.high || 0 },
    { key: 'medium', cls: 'medium', label: '中危', n: bySev.medium || 0 },
    { key: 'low', cls: 'low', label: '低危', n: bySev.low || 0 },
  ]
  const missingEvidence = Math.max(0, (stats.total || 0) - (stats.withEvidence || 0))

  return h('div', { className: 'df-ops' },
    h('div', { className: 'df-opsbar' },
      h('span', { className: 'df-ops-title' }, '漏洞成果'),
      h('span', { className: 'df-ops-meta' }, '按严重度排序'),
      h('span', { className: 'df-spacer' }),
      h(DfSearch, {
        value: q, placeholder: '搜索标题 / CVE / 目标 / 证据',
        onChange: function (v) { setQ(v) }, style: { width: 230 },
      }),
      h(DfSeg, {
        value: status,
        items: [['', '任意状态'], ['pending', '待复核'], ['candidate', '候选'], ['confirmed', '已确认'], ['exploited', '已利用'], ['false-positive', '误报'], ['fixed', '已修复']],
        onChange: function (v) { setStatus(v) },
      }),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'plus', onClick: openManual }, '手工记录'),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', onClick: state.reload }, '刷新')),

    /* 四个等级各自成块：数字 + 颜色，点一下就筛。比 KPI 更能说明「轻重」。 */
    h('div', { className: 'df-sevbar' }, sevTiles.map(function (t) {
      return h('button', {
        key: t.cls, type: 'button',
        className: 'df-sevbtn df-sevbtn--' + t.cls + (sev === t.key ? ' on' : ''),
        onClick: function () { setSev(t.key) },
        title: t.key === '' ? '显示全部漏洞' : '只看' + t.label,
        'aria-pressed': sev === t.key,
      },
        h('span', { className: 'df-sb-l' }, h('i'), t.label),
        h('span', { className: 'df-sb-v' }, dfNum(t.n)),
        sev === t.key ? h('span', { className: 'df-sb-on' }, '✓') : null)
    })),

    h(DfCard, {
      title: '漏洞清单', icon: 'bug',
      sub: '待复核 ' + dfNum(stats.pendingReview || 0)
        + ' · 已确认 ' + dfNum(byStatus.confirmed || 0)
        + ' · 已利用 ' + dfNum(byStatus.exploited || 0)
        + ' · 缺证据 ' + dfNum(missingEvidence),
      actions: q || sev || status
        ? h(DfBtn, {
          size: 'sm', kind: 'ghost', icon: 'close',
          onClick: function () { setQ(''); setSev(''); setStatus('') },
        }, '清除筛选')
        : null,
    },
      state.error
        ? h(DfOpsError, { title: '读取漏洞失败', error: state.error, onRetry: state.reload })
        : rows.length
          ? h('div', { className: 'df-vlist' }, rows.map(function (v) {
            const meta = dfSevMeta(v.severity)
            const hasEvidence = String(v.evidence || '').trim() !== ''
            return h('button', {
              key: v.id, type: 'button',
              className: 'df-vrow df-vrow--' + meta.cls,
              onClick: function () { props.onInspect && props.onInspect(drawerFor(v)) },
            },
              h('span', { className: 'df-vrow-rail' }),
              h('span', { className: 'df-vrow-main' },
                h('span', { className: 'df-vrow-hd' },
                  h(DfSevBadge, { severity: v.severity }),
                  h('span', { className: 'df-vrow-t' }, v.title || '（未填标题）')),
                h('span', { className: 'df-vrow-m' },
                  h('span', { className: 'df-vrow-ip' }, dfDash(v.asset_ip || dfHostName(v.target))),
                  h('span', { className: 'df-vrow-sep' }, '·'),
                  h(DfVulnStatusChip, { status: v.status }),
                  v.status === 'candidate' || v.status === 'exploited'
                    ? h(DfChip, { kind: 'warn' }, '待复核') : null,
                  v.cve ? h(DfChip, { kind: 'info' }, v.cve) : null,
                  hasEvidence
                    ? h(DfChip, { kind: 'ok' }, '有证据')
                    : h(DfChip, { kind: 'err' }, '缺证据'),
                  v.target && v.target !== v.asset_ip
                    ? h('span', { className: 'df-vrow-url', title: v.target }, dfShort(v.target, 44))
                    : null)),
              h('span', { className: 'df-vrow-right' },
                h('span', { className: 'df-vrow-ago' }, dfAgo(v.found_at)),
                h('span', { className: 'df-vrow-go' }, '›')))
          }))
          : state.loading
            ? h(DfSkeleton, { lines: 6 })
            : h(DfEmpty, {
              icon: 'bug', title: '没有匹配的漏洞',
              hint: q || sev || status ? '换个条件试试。' : '漏洞发现后会在这里按严重度排队。',
            })))
}

/* ---------------------------------------------------------------- 工具 */

const DF_TOOL_STATUS = {
  '': ['未标注', 'line'],
  available: ['可用', 'ok'],
  deprecated: ['不建议', 'warn'],
  blocked: ['建议停用', 'err'],
}

const DF_TOOL_SOURCE = {
  config: '手动指定',
  toolkit: '工具箱',
  binDir: '附加目录',
  path: '系统 PATH',
  usage: '使用记录',
  catalog: '内置清单',
  toolbox: '工具箱发现',
  default: '插件默认目录',
  user: '用户指定目录',
  model: '模型安装',
  manual: '手动登记',
  hidden: '已移除',
}

/** 清单行是否真的有可执行文件。 */
function dfToolReady(t) {
  const a = t && t.avail
  if (t && t.path && t.missing !== true) return true
  if (!a) return false
  if (a.exists === false) return false
  return !!a.path
}

/** 默认“已登记”：模型 open/learn/use/run 过、人标注/编辑过，或确实调用过。
    单纯扫描到目录不算登记；否则同步一次工具目录就会把整库噪音摊到默认列表。 */
function dfToolPrimary(t, mode) {
  if (!t) return false
  if (t.uses > 0 || t.recipe || t.purpose || t.status) return true
  if (Array.isArray(t.tags) && t.tags.length > 0) return true
  return (t.registered === true)
}

function DfToolBox(props) {
  const t = props.t
  const [note, setNote] = useState(t.note || '')
  const [busy, setBusy] = useState('')
  const [purpose, setPurpose] = useState(t.purpose || '')
  const [tags, setTags] = useState(Array.isArray(t.tags) ? t.tags.join(', ') : '')
  const [recipe, setRecipe] = useState((t.recipe && t.recipe.command) || t.command || '')
  const [recipeNote, setRecipeNote] = useState((t.recipe && t.recipe.note) || '')
  const [metaBusy, setMetaBusy] = useState(false)
  /* 路径与这条工具的身份：内置清单项用 id，扫出来的用 key。 */
  const toolId = (t.avail && t.avail.id) ? t.avail.id : t.key
  const initialPath = t.path || (t.avail && (t.avail.path || t.avail.configuredPath)) || ''
  const [toolPath, setToolPath] = useState(initialPath)
  const [pathBusy, setPathBusy] = useState(false)
  const [forgetArmed, setForgetArmed] = useState(false)

  useEffect(function () {
    setPurpose(t.purpose || '')
    setTags(Array.isArray(t.tags) ? t.tags.join(', ') : '')
    setRecipe((t.recipe && t.recipe.command) || t.command || '')
    setRecipeNote((t.recipe && t.recipe.note) || '')
    setNote(t.note || '')
  }, [t.name, t.purpose, t.tags, t.recipe, t.command, t.note])

  useEffect(function () { setToolPath(initialPath) }, [t.name, initialPath])

  function save(next) {
    if (busy) return
    setBusy(next || 'clear')
    dfApi('toolSet', {
      engagement: props.eng, mode: props.mode || 'redteam',
      name: t.name, status: next, note: String(note || '').trim(), by: 'human',
    }).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '保存失败', 'err', 4200); return }
      dfBust()
      dfToast('已保存标注', 'ok', 1600)
      if (props.onDone) props.onDone(r)
    })
  }

  function saveMeta() {
    if (metaBusy) return
    setMetaBusy(true)
    dfApi('toolboxMeta', {
      mode: props.mode || 'redteam', name: t.name,
      purpose: purpose,
      tags: tags,
      recipe: recipe,
      note: recipeNote,
    }, { ttl: 0 }).then(function (r) {
      setMetaBusy(false)
      if (!r || r.ok === false) { dfToast((r && r.error) || '保存工具卡片失败', 'err', 4200); return }
      dfBust()
      dfToast('已保存工具卡片', 'ok', 1600)
      if (props.onDone) props.onDone(r)
    }).catch(function (e) {
      setMetaBusy(false)
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  function savePath() {
    if (pathBusy) return
    const value = String(toolPath || '').trim()
    if (!value) { dfToast('填一个可执行文件的绝对路径', 'err', 3200); return }
    setPathBusy(true)
    dfApi('toolboxPath', { mode: props.mode || 'redteam', name: toolId, path: value }, { ttl: 0 })
      .then(function (r) {
        setPathBusy(false)
        if (!r || r.ok === false) { dfToast((r && r.error) || '保存路径失败', 'err', 4200); return }
        dfBust()
        dfToast('路径已保存', 'ok', 1800)
        if (props.onDone) props.onDone(Object.assign({}, r, { hidden: false }))
      }, function (e) {
        setPathBusy(false)
        dfToast(String((e && e.message) || e), 'err', 4200)
      })
  }

  function forget() {
    if (!forgetArmed) {
      setForgetArmed(true)
      window.setTimeout(function () { setForgetArmed(false) }, 5000)
      return
    }
    setForgetArmed(false)
    if (pathBusy) return
    setPathBusy(true)
    dfApi('toolboxForget', { mode: props.mode || 'redteam', name: toolId }, { ttl: 0 })
      .then(function (r) {
        setPathBusy(false)
        if (!r || r.ok === false) { dfToast((r && r.error) || '移除失败', 'err', 4200); return }
        dfBust()
        dfToast('已从工具页移除：' + t.name, 'ok', 2400)
        if (props.onClose) props.onClose()
      }, function (e) {
        setPathBusy(false)
        dfToast(String((e && e.message) || e), 'err', 4200)
      })
  }

  return h('div', null,
    h('section', { className: 'df-detail-sec' },
      h('h4', null, '可执行文件路径'),
      h('div', { className: 'df-hint' }, t.hidden
        ? '这条已移除；填一个有效路径并保存就会恢复。'
        : '保存后写进环境配置；文件必须存在。移除后可在「已移除」里填路径恢复。'),
      h('input', {
        className: 'df-input', value: toolPath, placeholder: '例如 C:\\tools\\nmap.exe',
        onChange: function (e) { setToolPath(e.target.value) },
        style: { width: '100%', marginTop: 6 },
      }),
      h('div', { style: { marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' } },
        h(DfBtn, {
          size: 'sm', kind: 'primary', icon: 'check',
          disabled: pathBusy, onClick: savePath,
        }, pathBusy ? '处理中…' : t.hidden ? '保存并恢复' : '保存路径'),
        t.hidden ? null : h(DfBtn, {
          size: 'sm', kind: 'danger', icon: 'close',
          disabled: pathBusy, onClick: forget,
        }, forgetArmed ? '确认移除' : '移除这条'))),
    h('section', { className: 'df-detail-sec' },
      h('h4', null, '工具卡片'),
      h('div', { className: 'df-hint' }, '用途、tags 和 recipe 会直接进入 AI 的 toolbox 检索。'),
      h('input', {
        className: 'df-input', value: purpose, placeholder: '用途，例如：内网端口扫描',
        onChange: function (e) { setPurpose(e.target.value) },
        style: { width: '100%', marginTop: 6 },
      }),
      h('input', {
        className: 'df-input', value: tags, placeholder: 'tags，用逗号分隔，例如：recon, port, scan',
        onChange: function (e) { setTags(e.target.value) },
        style: { width: '100%', marginTop: 6 },
      }),
      h('textarea', {
        className: 'df-area', rows: 3, value: recipe,
        placeholder: '常用命令，例如：nmap -sV -Pn -p- <target>；留空则清除',
        onChange: function (e) { setRecipe(e.target.value) },
        style: { width: '100%', marginTop: 6 },
      }),
      h('input', {
        className: 'df-input', value: recipeNote, placeholder: '命令备注（可选）',
        onChange: function (e) { setRecipeNote(e.target.value) },
        style: { width: '100%', marginTop: 6 },
      }),
      h('div', { style: { marginTop: 8 } },
        h(DfBtn, {
          size: 'sm', kind: 'primary', icon: 'check',
          disabled: metaBusy, onClick: saveMeta,
        }, metaBusy ? '保存中…' : '保存工具卡片'))),
    h('section', { className: 'df-detail-sec' },
      h('h4', null, '人工标注'),
    h('div', { className: 'df-hint' },
      '仅作 AI 选型参考，不拦截直接调用。'),
    h('textarea', {
      className: 'df-area', rows: 2, value: note,
      placeholder: '备注：为什么可用 / 为什么不建议（例如噪声大、易打崩设备）',
      onChange: function (e) { setNote(e.target.value) },
      style: { width: '100%', marginTop: 6 },
    }),
    h('div', { style: { marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' } },
      h(DfBtn, { size: 'sm', kind: 'primary', icon: 'check', disabled: !!busy, onClick: function () { save('available') } }, '可用'),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'close', disabled: !!busy, onClick: function () { save('deprecated') } }, '不建议'),
      h(DfBtn, { size: 'sm', kind: 'danger', icon: 'close', disabled: !!busy, onClick: function () { save('blocked') } }, '建议停用'),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', disabled: !!busy, onClick: function () { save('') } }, '清除标注'))))
}

/* 工具页的 tab 选择放在模块级：切页或写操作后组件重挂时，不要退回红队。 */
let dfToolsMode = 'redteam'

function DfTools(props) {
  const eng = props.eng
  const [mode, setModeState] = useState(dfToolsMode)
  function setMode(next) {
    dfToolsMode = next === 'crack' ? 'crack' : 'redteam'
    setModeState(dfToolsMode)
  }
  const [filter, setFilter] = useState('all')
  const [q, setQ] = useState('')
  const [showSystem, setShowSystem] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [visible, setVisible] = useState(120)
  const [rootInput, setRootInput] = useState('')
  const [rootBusy, setRootBusy] = useState('')
  const state = dfUseAsync(function () {
    if (mode === 'crack') {
      return dfApi('tools', { mode: 'crack' }).then(function (usage) {
        return { usage: usage || {}, cfg: {} }
      }).catch(function () {
        return { usage: { ok: false, items: [] }, cfg: {} }
      })
    }
    return Promise.all([
      dfApi('tools', { engagement: eng, mode: 'redteam' }).catch(function () { return { ok: false, items: [] } }),
      dfApi('platformConfigGet', {}, { ttl: 60000 }).catch(function () { return {} }),
    ]).then(function (pair) {
      return { usage: pair[0] || {}, cfg: pair[1] || {} }
    })
  }, [eng, props.tick, mode])

  useEffect(function () { setVisible(120) }, [q, filter, showAll, mode])

  const usageItems = (state.data && state.data.usage && state.data.usage.items) || []
  const usage = (state.data && state.data.usage) || {}
  const cfg = (state.data && state.data.cfg) || {}
  const rootsAll = Array.isArray(usage.toolbox_discovered_roots) ? usage.toolbox_discovered_roots : []
  const bothFailed = !state.loading && usage.ok === false && cfg.ok !== true
  /* 工具清单来自实际磁盘扫描 + 手动指定；不再用内置目录去列“应该装但没装”的工具。 */
  const inv = cfg.inventory
  const availItems = inv && Array.isArray(inv.items)
    ? inv.items.concat(Array.isArray(inv.catalog) ? inv.catalog : [])
    : ((cfg.tools && cfg.tools.items) || []).filter(function (a) { return !!a.path })

  /* 工具名归一：环境检查用 id，使用记录用命令名，两边对齐后才能合并。 */
  function toolKey(name) {
    return String(name || '').toLowerCase().replace(/\\/g, '/').split('/').pop().split(/\s+/)[0]
      .replace(/\.(exe|py|ps1|bat|cmd|sh|js|pl|rb)$/i, '')
  }

  const map = new Map()
  for (const a of availItems) {
    const key = toolKey(a.name || a.label || a.id)
    if (!key) continue
    map.set(key, {
      key: key, name: a.name || a.label || a.id, avail: a, uses: 0,
      status: '', note: '', source: 'avail',
      purpose: a.purpose || '', command: a.command || '', install: a.install || '',
      category: a.category || '', isSystem: a.system === true,
    })
  }
  for (const u of usageItems) {
    const key = toolKey(u.name)
    if (!key) continue
    const row = map.get(key) || { key: key, name: u.name, avail: null, uses: 0, status: '', note: '', source: 'usage' }
    row.uses = u.uses || 0
    row.last_seen = u.last_seen
    row.first_seen = u.first_seen
    row.status = u.status || ''
    row.note = u.note || ''
    row.updated_by = u.updated_by
    row.kind = u.kind
    row.usage = u
    map.set(key, row)
  }
  /* 已移除的条目保留恢复入口：默认不显示，只有「已移除」筛选里能看到。 */
  const hiddenItems = []
    .concat(inv && Array.isArray(inv.hidden) ? inv.hidden : [])
    .concat(Array.isArray(usage.hidden) ? usage.hidden : [])
  for (const h of hiddenItems) {
    const key = toolKey(h.key || h.name || h.id)
    if (!key || map.has(key)) continue
    map.set(key, {
      key: key, name: h.name || h.key || key,
      avail: Object.assign({}, h, { source: 'hidden', hidden: true, path: null, exists: false }),
      uses: 0, status: '', note: '', source: 'hidden', hidden: true,
      purpose: h.purpose || '', command: h.command || '', install: h.install || '',
      category: h.category || '', isSystem: false,
    })
  }
  let rows = Array.from(map.values())
  const SYS_KEYS = ['curl', 'wget', 'python', 'python3', 'powershell', 'pwsh', 'cmd', 'bash', 'sh',
    'nc', 'ncat', 'netcat', 'openssl', 'ssh', 'scp', 'socat', 'git', 'node', 'java',
    'go', 'gcc', 'g++', 'tar', '7z', 'zip', 'unzip', 'findstr', 'grep', 'awk', 'sed']
  rows.forEach(function (r) {
    if (r.isSystem === undefined) r.isSystem = SYS_KEYS.indexOf(r.key) >= 0
  })
  const countRows = rows.filter(function (r) { return !r.hidden })
  const hiddenCount = rows.length - countRows.length
  const readyCount = countRows.filter(function (r) { return dfToolReady(r) }).length
  const missingCount = countRows.filter(function (r) {
    return r.missing === true || (r.avail && r.avail.exists === false)
  }).length
  const usedCount = countRows.filter(function (r) { return r.uses > 0 }).length
  const blockedCount = countRows.filter(function (r) { return r.status === 'blocked' }).length
  const systemCount = countRows.filter(function (r) { return r.isSystem }).length
  const catalogCount = countRows.filter(function (r) { return r.avail && r.avail.source === 'catalog' }).length

  useEffect(function () {
    if (hiddenCount === 0 && filter === 'hidden') setFilter('all')
  }, [hiddenCount, filter])

  const query = q.trim().toLowerCase()
  const showSys = showSystem || query.length > 0
  const allCount = countRows.length
  const primaryCount = countRows.filter(function (r) { return dfToolPrimary(r, mode) }).length
  rows = rows.filter(function (r) {
    if (filter === 'hidden') {
      if (!r.hidden) return false
      if (!query) return true
      return (r.name + ' ' + (r.key || '')).toLowerCase().includes(query)
    }
    if (r.hidden) return false
    if (!showSys && r.isSystem) return false
    if (!showAll && !query && !dfToolPrimary(r, mode)) return false
    if (filter === 'missing' && !(r.missing === true || (r.avail && r.avail.exists === false))) return false
    if (filter === 'ready' && !dfToolReady(r)) return false
    if (filter === 'used' && !(r.uses > 0)) return false
    if (filter === 'marked' && !r.status) return false
    if (!query) return true
    return (r.name + ' ' + (r.key || '') + ' ' + (r.purpose || '') + ' ' + (r.note || '')).toLowerCase().includes(query)
  })
  rows.sort(function (a, b) {
    const rank = function (r) {
      if (r.status === 'blocked') return 0
      if (dfToolReady(r)) return 1
      if (r.uses > 0) return 2
      if (r.avail && r.avail.exists === false && r.avail.source !== 'catalog') return 3
      return 4
    }
    return rank(a) - rank(b) || (b.uses - a.uses) || a.name.localeCompare(b.name)
  })
  const totalFiltered = rows.length
  const shownRows = rows.slice(0, visible)
  const filterItems = [['all', '全部'], ['ready', '就绪'], ['missing', '未安装'], ['used', '用过'], ['marked', '有标注']]
  if (hiddenCount > 0) filterItems.push(['hidden', '已移除 ' + dfNum(hiddenCount)])

  function rescan() {
    /* 破解没有平台工具箱配置，重扫就是重新扫描破解 registry 的发现目录。 */
    if (mode === 'crack') {
      dfApi('toolboxSync', { mode: 'crack' }, { ttl: 0 }).then(function (r) {
        if (!r || r.ok === false) { dfToast((r && r.error) || '重扫失败', 'err', 4200); return }
        dfToast('已重新扫描破解工具：' + (r.count || 0) + ' 个'
          + (r.truncated ? '（达到扫描上限，列表已截断）' : ''), r.truncated ? 'warn' : 'ok', 3200)
        state.reload()
      }).catch(function (e) { dfToast(String((e && e.message) || e), 'err', 4200) })
      return
    }
    const dir = String(cfg.toolkitDir || (cfg.config && cfg.config.toolkitDir) || '').trim()
    if (!dir) { dfToast('先选择一个工具箱目录', 'err', 3200); return }
    dfApi('platformAssignToolkit', { dir: dir }).then(function (r) {
      if (!r || r.ok === false) { dfToast((r && r.error) || '重扫失败', 'err', 4200); return }
      dfToast('已重新扫描工具', 'ok', 2000)
      dfBust()
      state.reload()
    }).catch(function (e) { dfToast(String((e && e.message) || e), 'err', 4200) })
  }

  function syncToolbox() {
    dfApi('toolboxSync', { mode: mode }, { ttl: 0 }).then(function (r) {
      if (!r || r.ok === false) { dfToast((r && r.error) || '同步工具箱失败', 'err', 4200); return }
      dfToast('工具箱已同步：' + (r.count || 0) + ' 个工具'
        + (r.truncated ? '（达到扫描上限，列表已截断）' : ''), r.truncated ? 'warn' : 'ok', 3600)
      state.reload()
    }).catch(function (e) { dfToast(String((e && e.message) || e), 'err', 4200) })
  }

  function addToolRoot() {
    const dir = String(rootInput || '').trim()
    if (!dir) { dfToast('先填一个工具目录', 'err', 3200); return }
    if (rootBusy) return
    setRootBusy('add')
    dfApi('toolboxAddRoot', { dir: dir, mode: mode }, { ttl: 0 }).then(function (r) {
      setRootBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '添加目录失败', 'err', 4200); return }
      setRootInput('')
      dfToast('已添加并同步：' + (r.count || 0) + ' 个工具', 'ok', 2400)
      state.reload()
    }).catch(function (e) {
      setRootBusy('')
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  function removeToolRoot(dir, source) {
    if (rootBusy) return
    if (source === 'config') {
      const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm('移除「' + dir + '」后，该目录会从平台配置里删除；\n'
          + '这个目录对应的手动工具路径也会移除（文件本身不动，子目录里的其它根保留）。\n\n继续？')
        : true
      if (!ok) return
    }
    setRootBusy('remove:' + dir)
    dfApi('toolboxRemoveRoot', { dir: dir, mode: mode }, { ttl: 0 }).then(function (r) {
      setRootBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '移除目录失败', 'err', 4200); return }
      const removed = r.config && Array.isArray(r.config.removed_tools) ? r.config.removed_tools.length : 0
      dfToast('已移除并同步：' + (r.count || 0) + ' 个工具'
        + (removed ? '，同时移除 ' + removed + ' 条手动工具路径' : ''), 'ok', 3200)
      state.reload()
    }).catch(function (e) {
      setRootBusy('')
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  function drawerFor(t) {
    const avail = t.avail || {}
    const ready = dfToolReady(t)
    const notInstalled = avail.source === 'catalog'
    const hidden = t.hidden === true
    return {
      title: t.name,
      sub: (hidden ? '已移除（填有效路径可恢复）' : ready ? '已就绪' : t.missing ? '已从发现目录消失' : notInstalled ? '未安装' : avail.exists === false ? '配置路径不存在' : '未登记可用性')
        + (t.purpose ? ' · ' + t.purpose : '')
        + ' · ' + (t.uses || 0) + ' 次',
      rows: [
        ['用途', t.purpose || ''],
        ['标签', Array.isArray(t.tags) ? t.tags.join(' · ') : ''],
        ['风险', t.risk || ''],
        ['可用性', ready ? '就绪' : t.missing ? '已从发现目录消失（重新同步或移除该目录）' : notInstalled ? '未安装（内置清单）' : (avail.source ? '不可用（' + (avail.note || '配置路径不存在') + '）' : '未在磁盘或使用记录里出现')],
        ['路径', t.path || avail.path || avail.configuredPath],
        ['发现方式', DF_TOOL_SOURCE[avail.source] || DF_TOOL_SOURCE[t.toolbox_source] || DF_TOOL_SOURCE[t.source] || ''],
        ['使用次数', String(t.uses || 0)],
        ['最近使用', dfAgo(t.last_seen || '')],
        ['首次登记', dfTime(t.first_seen)],
        ['当前标注', (DF_TOOL_STATUS[t.status || ''] || DF_TOOL_STATUS[''])[0]],
      ],
      node: h('div', { className: 'df-detail' },
        (t.recipe && t.recipe.command) || t.command
          ? h('section', { className: 'df-detail-sec' },
            h('div', { className: 'df-detail-hd' },
              h('h4', null, t.recipe && t.recipe.command ? '已固化用法' : '常用命令'),
              h(DfCopyBtn, { text: (t.recipe && t.recipe.command) || t.command, label: '复制', toast: '命令已复制' })),
            h('pre', { className: 'df-code' }, (t.recipe && t.recipe.command) || t.command),
            t.recipe && t.recipe.note ? h('div', { className: 'df-note' }, t.recipe.note) : null,
            h('div', { className: 'df-formfoot' },
              h(DfBtn, {
                size: 'sm', kind: 'ghost', icon: 'spark',
                onClick: function () {
                  dfDraftToComposer([
                    '用 ' + t.name + ' 执行：' + ((t.recipe && t.recipe.command) || t.command),
                    '目标：<填目标>',
                    dfEngagementLine(eng),
                    '执行前先确认目标在授权范围内；回显落库/留证。',
                  ].filter(Boolean).join('\n'), '已把命令放进输入框')
                },
              }, '让 AI 执行')))
          : null,
        t.install
          ? h('div', { className: 'df-note' }, '安装：' + t.install)
          : null,
        avail.exists === false && !notInstalled && !t.hidden
          ? h('div', { className: 'df-note df-note--warn' },
            '这条是你在环境里手动指定的路径，但文件不在了。改路径或清空这一项后点「重扫工具」。')
          : null,
        h(DfToolBox, {
          eng: eng, mode: mode, t: t,
          onClose: props.onCloseDrawer,
          onDone: function (next) {
            state.reload()
            props.onInspect && props.onInspect(drawerFor(Object.assign({}, t, next)))
          },
        }),
        t.note ? h('div', { className: 'df-note' }, t.note) : null),
    }
  }

  return h('div', { className: 'df-ops' },
    h('div', { className: 'df-opsbar' },
      h('span', { className: 'df-ops-title' }, '工具'),
      h(DfSeg, {
        value: mode,
        items: [['redteam', '红队'], ['crack', '破解']],
        onChange: function (v) { setMode(v) },
      }),
      h('span', { className: 'df-ops-meta' }, '就绪 ' + dfNum(readyCount)
        + ' · 用过 ' + dfNum(usedCount) + ' · 已登记 ' + dfNum(primaryCount)),
      h('span', { className: 'df-spacer' }),
      h(DfSearch, { value: q, placeholder: '搜索工具 / 用途', onChange: function (v) { setQ(v) }, style: { width: 200 } }),
      h(DfSeg, {
        value: filter,
        items: filterItems,
        onChange: function (v) { setFilter(v) },
      }),
      h(DfBtn, {
        size: 'sm', kind: 'ghost', icon: 'list',
        onClick: function () { setShowAll(function (v) { return !v }) },
      }, showAll ? '只看已登记' : '全部发现 ' + dfNum(allCount)),
      h(DfBtn, {
        size: 'sm', kind: 'ghost', icon: 'terminal',
        onClick: function () { setShowSystem(function (v) { return !v }) },
      }, showSystem ? '隐藏系统命令' : '系统命令 ' + dfNum(systemCount)),
      h(DfBtn, {
        size: 'sm', kind: 'ghost', icon: 'folder', onClick: rescan,
        disabled: mode === 'redteam'
          && !String(cfg.toolkitDir || (cfg.config && cfg.config.toolkitDir) || '').trim(),
      }, '重扫'),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', onClick: syncToolbox }, '同步工具箱'),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', onClick: state.reload }, '刷新')),

    h(DfCard, {
      title: '工具发现目录', icon: 'folder',
      sub: '只扫这些目录，不扫整条 PATH；插件默认目录固定，手动指定/用户目录可移除',
    },
      h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
        h('input', {
          className: 'df-input', value: rootInput,
          placeholder: '例如 C:\\tools\\redteam 或 ~/.dsh/tools',
          onChange: function (e) { setRootInput(e.target.value) },
          onKeyDown: function (e) { if (e.key === 'Enter') addToolRoot() },
          style: { flex: '1 1 320px', minWidth: 220 },
        }),
        h(DfBtn, {
          size: 'sm', kind: 'primary', icon: 'plus',
          disabled: !!rootBusy, onClick: addToolRoot,
        }, rootBusy === 'add' ? '添加中…' : '添加目录')),
      usage.toolbox_truncated
        ? h('div', { className: 'df-note df-note--warn', style: { marginTop: 8 } },
          '上次扫描达到 1200 个可执行文件上限，工具列表可能不完整；收窄发现目录后重新同步。')
        : null,
      rootsAll.length
        ? h('div', { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 } },
          rootsAll.map(function (r) {
            const src = DF_TOOL_SOURCE[r.source] || r.source || ''
            const removable = r.source === 'user' || r.source === 'config'
            return h('div', {
              key: r.path,
              style: {
                display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
                padding: '6px 8px', border: '1px solid var(--df-line, #2a2f3a)', borderRadius: 6,
              },
            },
              h('span', { className: 'df-mono', style: { flex: '1 1 320px', wordBreak: 'break-all' } }, r.path),
              src ? h(DfChip, { kind: 'line' }, src) : null,
              removable
                ? h(DfBtn, {
                  size: 'sm', kind: 'ghost', icon: 'close',
                  title: r.source === 'config' ? '从平台配置移除该目录（含该目录下已登记的工具路径）' : '从发现目录移除',
                  disabled: !!rootBusy, onClick: function () { removeToolRoot(r.path, r.source) },
                }, rootBusy === 'remove:' + r.path ? '移除中…' : '移除')
                : null)
          }))
        : h('div', { className: 'df-hint', style: { marginTop: 8 } },
          '还没有扫描记录。添加目录后会自动同步，也可以先点上方「同步工具箱」。')),

    h(DfCard, {
      title: '工具清单', icon: 'wrench',
      sub: '就绪 ' + dfNum(readyCount) + ' · 未安装 ' + dfNum(catalogCount) + ' · 用过 ' + dfNum(usedCount),
      actions: q || filter !== 'all'
        ? h(DfBtn, {
          size: 'sm', kind: 'ghost', icon: 'close',
          onClick: function () { setQ(''); setFilter('all') },
        }, '清除筛选')
        : null,
    },
      state.error || bothFailed
        ? h(DfOpsError, {
          title: '读取工具清单失败',
          error: state.error || usage.error || cfg.error || '工具接口与环境配置接口都不可用',
          onRetry: state.reload,
        })
        : rows.length
          ? h(react.Fragment, null,
            h('div', { className: 'df-tool-grid' }, shownRows.map(function (t) {
            const meta = DF_TOOL_STATUS[t.status || ''] || DF_TOOL_STATUS['']
            const ready = dfToolReady(t)
            const src = DF_TOOL_SOURCE[(t.avail || {}).source] || DF_TOOL_SOURCE[t.source] || ''
            const notInstalled = (t.avail || {}).source === 'catalog'
            return h('button', {
              key: t.key, type: 'button',
              className: 'df-vrow df-vrow--info',
              onClick: function () { props.onInspect && props.onInspect(drawerFor(t)) },
            },
              h('span', { className: 'df-vrow-rail' }),
              h('span', { className: 'df-vrow-main' },
                h('span', { className: 'df-vrow-hd' },
                  h('span', { className: 'df-vrow-t df-mono' }, t.name),
                  ready
                    ? h(DfChip, { kind: 'ok' }, '就绪')
                    : t.missing
                      ? h(DfChip, { kind: 'err' }, '已消失')
                      : notInstalled
                        ? h(DfChip, { kind: 'line' }, '未安装')
                        : t.avail
                          ? h(DfChip, { kind: 'err' }, '路径失效')
                          : h(DfChip, { kind: 'line' }, '仅使用记录'),
                  t.status ? h(DfChip, { kind: meta[1] }, meta[0]) : null,
                  t.isSystem ? h(DfChip, { kind: 'line' }, '系统命令') : null),
                h('span', { className: 'df-vrow-m' },
                  t.purpose
                    ? h('span', { className: 'df-vrow-url', title: t.purpose }, dfShort(t.purpose, 46))
                    : (src ? h('span', { className: 'df-vrow-ip' }, src) : null),
                  h('span', { className: 'df-vrow-sep' }, '·'),
                  h('span', { className: 'df-vrow-url' }, dfNum(t.uses) + ' 次'
                    + (t.uses ? ' · 最近 ' + dfAgo(t.last_seen || '') : ' · 还没用过')),
                  t.note ? h('span', { className: 'df-vrow-url', title: t.note }, dfShort(t.note, 28)) : null)),
              h('span', { className: 'df-vrow-right' },
                h('span', { className: 'df-vrow-go' }, '›')))
            })),
            totalFiltered > shownRows.length
              ? h('div', { style: { display: 'flex', justifyContent: 'center', marginTop: 12 } },
                h(DfBtn, {
                  size: 'sm', kind: 'ghost', icon: 'list',
                  onClick: function () { setVisible(function (v) { return v + 120 }) },
                }, '显示更多（剩余 ' + dfNum(totalFiltered - shownRows.length) + '）'))
              : null)
          : state.loading
            ? h(DfSkeleton, { lines: 6 })
            : h(DfEmpty, {
              icon: 'wrench', title: q || filter !== 'all' ? '没有匹配的工具' : '还没有登记工具',
              hint: q || filter !== 'all'
                ? '换个条件试试。'
                : '默认只显示模型登记或实际调用过的工具。已发现 ' + dfNum(allCount)
                  + ' 个，点上方「全部发现」查看；模型用 toolbox find 检索、open/run 后会出现在这里。',
            })))
}

/* ---------------------------------------------------------------- 攻击链 */

function DfChain(props) {
  const eng = props.eng
  const state = dfUseAsync(function () {
    return dfApi('chain', { engagement: eng, limit: 500 }).then(function (r) {
      if (r && r.ok === false) throw new Error(r.error || '读取攻击链失败')
      return r || {}
    })
  }, [eng, props.tick])

  const rows = (state.data && state.data.items) || []
  const stages = new Set()
  const assets = new Set()
  const vulns = new Set()
  rows.forEach(function (s) {
    if (s.stage_code) stages.add(s.stage_code)
    if (s.asset_ip) assets.add(s.asset_ip)
    if (s.vuln_id) vulns.add(s.vuln_id)
  })

  function drawerFor(s) {
    return {
      title: s.title,
      sub: '第 ' + s.seq + ' 步 · ' + (DF_STAGE_LABEL[s.stage_code] || s.stage_code || '其他'),
      rows: [
        ['阶段', DF_STAGE_LABEL[s.stage_code] || s.stage_code],
        ['序号', s.seq],
        ['工具', s.tool],
        ['结果', s.result],
        ['资产', s.asset_ip],
        ['漏洞', s.vuln_title],
        ['CVE', s.vuln_cve],
        ['执行者', s.recorded_by || s.agent],
        ['记录时间', dfTime(s.recorded_at, true)],
      ],
      node: s.detail
        ? h('section', { className: 'df-detail-sec' },
          h('h4', null, '详细记录'),
          h('pre', { className: 'df-evi' }, String(s.detail)))
        : null,
    }
  }

  return h('div', { className: 'df-ops' },
    /* 顶栏一行标题 + 一条横向数字带：跟漏洞页首屏同一种节奏，
       切页时不会从「一块大白卡」突然变成「一屏小格子」。 */
    h('div', { className: 'df-opsbar' },
      h('span', { className: 'df-ops-title' }, '攻击链'),
      h('span', { className: 'df-spacer' }),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', onClick: state.reload }, '刷新')),

    h('div', { className: 'df-statsbar' },
      h(DfStat, { label: '步骤', icon: 'route', value: dfNum(rows.length) }),
      h(DfStat, { label: '阶段', icon: 'layers', value: dfNum(stages.size) }),
      h(DfStat, { label: '涉及资产', icon: 'server', value: dfNum(assets.size) }),
      h(DfStat, { label: '关联漏洞', icon: 'bug', value: dfNum(vulns.size) })),

    h(DfCard, { title: '步骤', icon: 'route', sub: '' },
      state.error
        ? h(DfOpsError, { title: '读取攻击链失败', error: state.error, onRetry: state.reload })
        : rows.length
          ? h('div', { className: 'df-tl df-tl--pad' }, rows.map(function (s, i) {
            const stage = DF_STAGE_LABEL[s.stage_code] || s.stage_code || '其他'
            return h('div', {
              key: s.id || i,
              className: 'df-tl-item',
              onClick: function () { props.onInspect && props.onInspect(drawerFor(s)) },
            },
              h('div', { className: 'df-tl-h' },
                h('span', { className: 'df-seq' }, String(s.seq || i + 1)),
                h('span', null, s.title),
                s.vuln_severity ? h(DfSevBadge, { severity: s.vuln_severity }) : null,
                h('span', { className: 'df-tl-t' }, dfAgo(s.recorded_at))),
              h('div', { className: 'df-tl-d' },
                h(DfChip, { kind: 'line' }, stage),
                s.tool ? h('span', { className: 'df-chain-tool' }, s.tool) : null,
                s.asset_ip ? h('span', { className: 'df-mono' }, s.asset_ip) : null),
              s.result ? h('div', { className: 'df-tl-r' }, s.result) : null)
          }))
          : state.loading
            ? h(DfSkeleton, { lines: 8 })
            : h(DfEmpty, { icon: 'route', title: '还没有攻击步骤', hint: '按记录顺序显示。' })))
}

/* ---------------------------------------------------------------- 通道 */

function DfSessions(props) {
  const eng = props.eng
  const [tab, setTab] = useState('webshell')
  const state = dfUseAsync(function () {
    return Promise.all([
      dfApi('sessions', { engagement: eng }),
      dfApi('credentials', { engagement: eng, limit: 1000 }),
      dfApi('access', { engagement: eng, limit: 1000 }),
    ]).then(function (r) {
      const s = r[0] || {}
      if (s.ok === false) throw new Error(s.error || '读取通道失败')
      return {
        shells: s.webshells || [],
        tunnels: s.tunnels || [],
        totals: s.totals || {},
        creds: (r[1] && r[1].items) || [],
        access: (r[2] && r[2].items) || [],
      }
    })
  }, [eng, props.tick])

  const d = state.data || { shells: [], tunnels: [], creds: [], access: [], totals: {} }
  const t = d.totals || {}

  function shellDrawer(w) {
    return {
      mode: 'peek',
      title: w.url,
      sub: (w.shell_type || 'WebShell') + ' · ' + (DF_SHELL_STATUS[w.status] || dfDash(w.status)),
      rows: [
        ['URL', w.url],
        ['类型', w.shell_type],
        ['状态', DF_SHELL_STATUS[w.status] || w.status],
        ['密码', w.pass_key],
        ['权限', w.privilege],
        ['资产', w.asset_ip],
        ['最近检查', dfTime(w.last_check)],
        ['检查备注', w.check_note],
        ['备注', w.note],
      ],
      node: null,
    }
  }

  function tunnelDrawer(x) {
    return {
      mode: 'peek',
      title: x.listen || x.entry || x.reach || '隧道',
      sub: (x.entry_kind_label || x.entry_kind || '未声明入口') + ' · ' + (DF_TUNNEL_STATUS[x.status] || dfDash(x.status)),
      rows: [
        ['本地监听', x.listen],
        ['可达范围', x.reach],
        ['入口', x.entry],
        ['类型', x.kind],
        ['入口类型', x.entry_kind_label || x.entry_kind],
        ['是否越界', x.legit === true ? '是（视为突破）' : (x.legit === false ? '否（仅限本机）' : '待确认')],
        ['状态', DF_TUNNEL_STATUS[x.status] || x.status],
        ['资产', x.asset_ip],
        ['WebShell', x.webshell_url],
        ['命令', x.command],
        ['最近检查', dfTime(x.last_check)],
        ['备注', x.note],
      ],
      node: null,
    }
  }

  function credDrawer(c) {
    return {
      mode: 'peek',
      title: [c.host, c.username].filter(Boolean).join(' · ') || '凭据',
      sub: c.privilege || '',
      rows: [
        ['主机', c.host],
        ['账号', c.username],
        ['权限', c.privilege],
        ['密钥类型', DF_SECRET_TYPE[c.secret_type] || c.secret_type],
        ['密钥', c.secret_value],
        ['密钥引用', c.secret_ref],
        ['来源', c.source],
        ['工具', c.tool],
        ['发现时间', dfTime(c.found_at)],
        ['备注', c.note],
      ],
      node: null,
    }
  }

  function accessDrawer(a) {
    return {
      mode: 'peek',
      title: a.host,
      sub: (a.method || '访问') + ' · ' + dfDash(a.privilege),
      rows: [
        ['主机', a.host],
        ['账号', a.username],
        ['方式', a.method],
        ['权限', a.privilege],
        ['会话引用', a.session_ref],
        ['获得时间', dfTime(a.obtained_at)],
        ['备注', a.note],
      ],
      node: null,
    }
  }

  const tabs = [
    { key: 'webshell', label: 'WebShell', icon: 'terminal', count: d.shells.length },
    { key: 'tunnel', label: '隧道', icon: 'link', count: d.tunnels.length },
    { key: 'credential', label: '凭据', icon: 'key', count: d.creds.length },
    { key: 'access', label: '访问', icon: 'lock', count: d.access.length },
  ]

  return h('div', { className: 'df-ops' },
    /* 首屏节奏跟漏洞页对齐：标题栏 → 一条横向数字带 → 一整块白卡。
       原来一进来是四张 KPI 小格子，从别的页切过来整屏明暗会突跳。 */
    h('div', { className: 'df-opsbar' },
      h('span', { className: 'df-ops-title' }, '通道'),
      h('span', { className: 'df-spacer' }),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', onClick: state.reload }, '刷新')),

    h('div', { className: 'df-statsbar' },
      h(DfStat, {
        label: 'WebShell', icon: 'terminal', value: dfNum(t.webshellsOnline || 0),
        foot: '共 ' + dfNum(t.webshells || 0) + ' · 离线 ' + dfNum(Math.max(0, (t.webshells || 0) - (t.webshellsOnline || 0))),
        accent: (t.webshellsOnline || 0) > 0,
      }),
      h(DfStat, {
        label: '隧道', icon: 'link', value: dfNum(t.tunnelsActive || 0),
        foot: '共 ' + dfNum(t.tunnels || 0) + ' · 越界 ' + dfNum(t.tunnelsLegit || 0) + ' · 自建 ' + dfNum(t.tunnelsSelfOnly || 0),
      }),
      h(DfStat, {
        label: '凭据', icon: 'key', value: dfNum(t.credentials || 0),
        foot: '有密钥 ' + dfNum(d.creds.filter(function (c) { return String(c.secret_value || '').trim() !== '' }).length) + ' 条',
      }),
      h(DfStat, { label: '访问', icon: 'lock', value: dfNum(t.access || 0), foot: '可在目标上交互' })),

    h(DfCard, null,
      h(DfTabs, { items: tabs, value: tab, onChange: function (k) { setTab(k) } }),
      state.error
        ? h(DfOpsError, { title: '读取通道失败', error: state.error, onRetry: state.reload })
        : tab === 'webshell'
          ? (d.shells.length
            ? h('div', { className: 'df-tablewrap' },
              h(DfTable, {
                rows: d.shells, rowKey: function (r) { return r.id },
                onRow: function (r) { props.onInspect && props.onInspect(shellDrawer(r)) },
                columns: [
                  { key: 'url', title: 'URL', ellipsis: true, width: '34%', render: function (r) { return h('span', { className: 'df-mono' }, r.url) } },
                  { key: 'shell_type', title: '类型', width: 92, render: function (r) { return h(DfChip, { kind: 'line' }, dfDash(r.shell_type)) } },
                  { key: 'privilege', title: '权限', width: 92, render: function (r) { return dfDash(r.privilege) } },
                  {
                    key: 'status', title: '状态', width: 80,
                    render: function (r) {
                      return h(DfChip, { kind: r.status === 'online' ? 'ok' : (r.status === 'offline' || r.status === 'dead' ? 'err' : 'line'), dot: true }, DF_SHELL_STATUS[r.status] || dfDash(r.status))
                    },
                  },
                  { key: 'note', title: '备注', width: '16%', ellipsis: true, render: function (r) { return dfDash(r.note) } },
                  { key: 'last_check', title: '最近检查', width: 96, align: 'right', render: function (r) { return dfAgo(r.last_check) } },
                ],
              }))
            : h(DfEmpty, { icon: 'terminal', title: '还没有 WebShell', hint: '登记首个立足点。' }))
          : tab === 'tunnel'
            ? (d.tunnels.length
              ? h('div', { className: 'df-tablewrap' },
                h(DfTable, {
                  rows: d.tunnels, rowKey: function (r) { return r.id },
                  onRow: function (r) { props.onInspect && props.onInspect(tunnelDrawer(r)) },
                  columns: [
                    { key: 'listen', title: '本地监听', width: '20%', render: function (r) { return h('span', { className: 'df-mono' }, dfDash(r.listen)) } },
                    { key: 'reach', title: '可达', width: '18%', render: function (r) { return h('span', { className: 'df-mono' }, dfDash(r.reach || r.entry)) } },
                    { key: 'kind', title: '类型', width: 88, render: function (r) { return h(DfChip, { kind: 'line' }, dfDash(r.kind)) } },
                    {
                      key: 'entry_kind', title: '入口类型', width: 160,
                      render: function (r) { return h(DfChip, { kind: r.legit === true ? 'ok' : (r.legit === false ? 'warn' : 'line') }, r.entry_kind_label || r.entry_kind || '待确认') },
                    },
                    {
                      key: 'status', title: '状态', width: 76,
                      render: function (r) { return h(DfChip, { kind: r.status === 'active' ? 'ok' : 'err', dot: true }, DF_TUNNEL_STATUS[r.status] || dfDash(r.status)) },
                    },
                    { key: 'note', title: '备注', ellipsis: true, render: function (r) { return dfDash(r.note) } },
                  ],
                }))
              : h(DfEmpty, { icon: 'link', title: '还没有隧道', hint: 'suo5 / socks5 / ssh -R 都记在这里。' }))
            : tab === 'credential'
              ? (d.creds.length
                ? h('div', { className: 'df-tablewrap' },
                  h(DfTable, {
                    rows: d.creds, rowKey: function (r) { return r.id },
                    onRow: function (r) { props.onInspect && props.onInspect(credDrawer(r)) },
                    columns: [
                      { key: 'host', title: '主机', width: '26%', render: function (r) { return h('span', { className: 'df-mono' }, dfDash(r.host)) } },
                      { key: 'username', title: '账号', width: '20%' },
                      { key: 'privilege', title: '权限', width: 90, render: function (r) { return h(DfChip, { kind: /admin|system|root/i.test(String(r.privilege || '')) ? 'err' : 'line' }, dfDash(r.privilege)) } },
                      { key: 'source', title: '来源', width: 110, render: function (r) { return dfDash(r.source) } },
                      { key: 'found_at', title: '发现', align: 'right', width: 92, render: function (r) { return dfAgo(r.found_at) } },
                    ],
                  }))
                : h(DfEmpty, { icon: 'key', title: '还没有凭据', hint: '口令、哈希、票据都算凭据。' }))
              : (d.access.length
                ? h('div', { className: 'df-tablewrap' },
                  h(DfTable, {
                    rows: d.access, rowKey: function (r) { return r.id },
                    onRow: function (r) { props.onInspect && props.onInspect(accessDrawer(r)) },
                    columns: [
                      { key: 'host', title: '主机', width: '26%', render: function (r) { return h('span', { className: 'df-mono' }, dfDash(r.host)) } },
                      { key: 'username', title: '账号', width: '18%' },
                      { key: 'method', title: '方式', width: 110, render: function (r) { return dfDash(r.method) } },
                      { key: 'privilege', title: '权限', width: 90, render: function (r) { return h(DfChip, { kind: 'info' }, dfDash(r.privilege)) } },
                      { key: 'obtained_at', title: '获得', align: 'right', width: 92, render: function (r) { return dfAgo(r.obtained_at) } },
                    ],
                  }))
                : h(DfEmpty, { icon: 'lock', title: '还没有可控访问', hint: '登记交互式会话。' }))))
}

/* ---------------------------------------------------------------- 日志 */

function DfLog(props) {
  const eng = props.eng
  const [kind, setKind] = useState('')
  const [cursor, setCursor] = useState('')
  const [acc, setAcc] = useState([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const first = dfUseAsync(function () {
    return dfApi('viewActivity', { engagement: eng, limit: 100 }).then(function (r) {
      if (r && r.ok === false) throw new Error(r.error || '读取日志失败')
      return r || {}
    })
  }, [eng, props.tick])

  useEffect(function () {
    if (!first.data) return
    setAcc(first.data.items || [])
    setCursor(first.data.nextCursor || '')
  }, [first.data])

  function loadMore() {
    if (!cursor || loading) return
    setLoading(true)
    dfApi('viewActivity', { engagement: eng, limit: 100, after: cursor }).then(function (r) {
      setLoading(false)
      if (!r || r.ok === false) { setErr((r && r.error) || '加载失败'); return }
      setAcc(function (cur) { return cur.concat(r.items || []) })
      setCursor(r.nextCursor || '')
    }, function (e) {
      setLoading(false)
      setErr(String((e && e.message) || e))
    })
  }

  const rows = kind ? acc.filter(function (a) { return a.kind === kind }) : acc
  const total = (first.data && first.data.total) || acc.length

  return h('div', { className: 'df-ops' },
    h('div', { className: 'df-opsbar' },
      h('span', { className: 'df-ops-title' }, '作业日志'),
      h('span', { className: 'df-ops-meta' }, '工具调用、写入与检查'),
      h('span', { className: 'df-spacer' }),
      h(DfSeg, {
        value: kind,
        items: [['', '全部'], ['step', '步骤'], ['vuln', '漏洞'], ['webshell', 'WebShell'], ['credential', '凭据'], ['shot', '截图']],
        onChange: function (k) { setKind(k) },
      }),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', onClick: first.reload }, '刷新')),

    h(DfCard, { title: '记录', icon: 'list', sub: kind
      ? '筛选 ' + dfNum(rows.length) + ' 条 · 已载入 ' + dfNum(acc.length)
      : '总计 ' + dfNum(total) + ' 条 · 已载入 ' + acc.length },
      first.error || err
        ? h(DfOpsError, { title: '读取日志失败', error: first.error || err, onRetry: first.reload })
        : rows.length
          ? h(react.Fragment, null,
            h('div', { className: 'df-tl df-tl--pad' }, rows.map(function (a, i) {
              const meta = DF_ACT[a.kind] || DF_ACT.step
              return h('div', {
                key: (a.kind || '') + ':' + (a.id || i) + ':' + i,
                className: 'df-tl-item',
                onClick: function () { props.onInspect && props.onInspect(dfActivityDrawer(a)) },
              },
                h('div', { className: 'df-tl-h' },
                  h('span', { className: 'df-act-ico' }, dfIcon(meta.icon, 13)),
                  h('span', null, a.title),
                  h('span', { className: 'df-tl-t' }, dfTime(a.at, true))),
                a.tool || a.target
                  ? h('div', { className: 'df-tl-d' },
                    a.tool ? h('span', { className: 'df-chain-tool' }, a.tool) : null,
                    a.target ? h('span', { className: 'df-mono' }, a.target) : null)
                  : null)
            })),
            cursor
              ? h('div', { className: 'df-more' },
                h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'arrowDown', onClick: loadMore, disabled: loading },
                  loading ? '加载中…' : '加载更多'))
              : null)
          : first.loading
            ? h(DfSkeleton, { lines: 8 })
            : h(DfEmpty, { icon: 'list', title: kind ? '该类型还没有记录' : '还没有作业记录' })))
}


/* ---- lib/client/33-deliver.js ---- */
/* 交付两视图（P0）：成果（正常渗透=交付自检，护网=计分板）/ 报告导出。
   数据全由 store-core 的 deliverables / scores / scoreReport / report 产出，这里只做展示与导出；
   评分写入仍走智能体，界面上不提供自由加分，避免总分被手工刷高。 */

/* ---------------------------------------------------------------- 证据截图 */

/* 原图缓存 + 缩略图缓存。列表只渲染缩略图，点开才用原图。 */
const dfShotCache = new Map()
const DF_SHOT_CACHE_CAP = 80

function dfShotCacheSet(key, value) {
  if (dfShotCache.size >= DF_SHOT_CACHE_CAP && !dfShotCache.has(key)) {
    const first = dfShotCache.keys().next().value
    if (first !== undefined) dfShotCache.delete(first)
  }
  dfShotCache.set(key, value)
}

/** 生成缩略图：长边最多 360px，列表不直接显示原图。 */
function dfMakeThumb(dataUrl) {
  return new Promise(function (resolve) {
    const img = new Image()
    img.onload = function () {
      try {
        const max = 360
        const scale = Math.min(1, max / Math.max(img.naturalWidth || 1, img.naturalHeight || 1))
        const w = Math.max(1, Math.round((img.naturalWidth || 1) * scale))
        const h = Math.max(1, Math.round((img.naturalHeight || 1) * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        canvas.getContext('2d').drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/webp', 0.72))
      } catch {
        resolve(dataUrl)
      }
    }
    img.onerror = function () { resolve(dataUrl) }
    img.src = dataUrl
  })
}

/**
 * 单张截图：列表用缩略图，lightbox 用 full 取原图。
 * 原图只拉一次，缩略图从同一份 base64 生成并缓存。
 */
function DfShotThumb(props) {
  const [src, setSrc] = useState('')
  const [err, setErr] = useState('')
  useEffect(function () {
    let alive = true
    setSrc('')
    setErr('')
    const key = String(props.eng) + ':' + String(props.id)
    const cached = dfShotCache.get(key)
    if (cached && (props.full ? cached.full : cached.thumb)) {
      setSrc(props.full ? cached.full : cached.thumb)
      return function () { alive = false }
    }
    dfApi('shotData', { engagement: props.eng, id: props.id }).then(function (r) {
      if (!alive) return
      if (!r || r.ok === false) { setErr((r && r.error) || '读取失败'); return }
      const full = 'data:' + (r.mime || 'image/png') + ';base64,' + r.base64
      dfMakeThumb(full).then(function (thumb) {
        dfShotCacheSet(key, { full: full, thumb: thumb })
        if (alive) setSrc(props.full ? full : thumb)
      })
    }, function (e) {
      if (alive) setErr(String((e && e.message) || e))
    })
    return function () { alive = false }
  }, [props.eng, props.id, props.full])

  if (err) return h('span', { className: 'df-shot-ph', title: err }, '读取失败')
  if (!src) return h('span', { className: 'df-shot-ph' }, '加载中…')
  return h('img', { src: src, alt: props.alt || '证据截图', loading: 'lazy' })
}

/** 点缩略图后的原图查看器：只在这里加载原图。 */
function DfShotLightbox(props) {
  useEffect(function () {
    function onKey(e) { if (e.key === 'Escape') props.onClose() }
    document.addEventListener('keydown', onKey)
    return function () { document.removeEventListener('keydown', onKey) }
  }, [props.onClose])
  return h('div', {
    className: 'df-shot-lightbox',
    role: 'dialog',
    'aria-modal': 'true',
    onClick: props.onClose,
  },
    h('button', {
      type: 'button',
      className: 'df-shot-lightbox-x',
      title: '关闭（Esc）',
      onClick: function (e) { e.stopPropagation(); props.onClose() },
    }, '×'),
    h('div', {
      className: 'df-shot-lightbox-body',
      onClick: function (e) { e.stopPropagation() },
    },
      h(DfShotThumb, { eng: props.eng, id: props.id, alt: props.alt, full: true }),
      h('div', { className: 'df-shot-lightbox-cap' },
        dfDash(props.alt || '证据截图'), props.capturedAt ? ' · ' + dfTime(props.capturedAt, true) : '')))
}

/** 只读图库：评分抽屉里的代表图用它（截图已在 scores 返回里）。 */
function DfShotGallery(props) {
  const [openId, setOpenId] = useState(null)
  const shots = Array.isArray(props.shots) ? props.shots : []
  const open = shots.filter(function (s) { return Number(s.id) === Number(openId) })[0] || null
  return h('div', null,
    h('div', { className: 'df-shots' }, shots.map(function (sh) {
      return h('div', { key: sh.id, className: 'df-shot' },
        h('button', {
          type: 'button',
          className: 'df-shot-b',
          title: '点击查看原图',
          onClick: function () { setOpenId(openId === sh.id ? null : sh.id) },
        }, h(DfShotThumb, { eng: props.eng, id: sh.id, alt: sh.label })),
        h('div', { className: 'df-shot-cap', title: [sh.label, sh.captured_at].filter(Boolean).join(' · ') },
          (sh.kind === 'card' ? '证据卡 · ' : '') + dfDash(sh.label || dfTime(sh.captured_at))))
    })),
    open
      ? h(DfShotLightbox, {
        eng: props.eng,
        id: open.id,
        alt: open.label,
        capturedAt: open.captured_at,
        onClose: function () { setOpenId(null) },
      })
      : null)
}

/** 文件 → dataURL。只用来读本地选择，不落到别处。 */
function dfReadFile(file) {
  return new Promise(function (resolve, reject) {
    const reader = new FileReader()
    reader.onload = function () { resolve(String(reader.result || '')) }
    reader.onerror = function () { reject(new Error('读取文件失败：' + (file && file.name))) }
    reader.readAsDataURL(file)
  })
}

/**
 * 可写图库：漏洞抽屉里上传 / 预览 / 删除现场截图。
 * 上传走 shotAdd（base64 直接入库拷贝），不上传原路径，避免面板下次打开时文件已被移动。
 */
function DfShots(props) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmId, setConfirmId] = useState(null)
  const [openId, setOpenId] = useState(null)
  const confirmTimer = useRef(0)

  const load = useCallback(function () {
    setLoading(true)
    setOpenId(null)
    dfApi('shots', {
      engagement: props.eng,
      vuln_id: props.vulnId === undefined ? undefined : props.vulnId,
      asset_id: props.assetId === undefined ? undefined : props.assetId,
      point_code: props.pointCode || undefined,
      limit: 60,
    }).then(function (r) {
      setLoading(false)
      if (!r || r.ok === false) { setErr((r && r.error) || '读取截图失败'); return }
      setErr('')
      setItems(r.items || [])
    }, function (e) {
      setLoading(false)
      setErr(String((e && e.message) || e))
    })
  }, [props.eng, props.vulnId, props.assetId, props.pointCode])

  useEffect(function () {
    load()
    return function () { if (confirmTimer.current) clearTimeout(confirmTimer.current) }
  }, [load])

  function del(id) {
    if (confirmId !== id) {
      setConfirmId(id)
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
      confirmTimer.current = setTimeout(function () { setConfirmId(null) }, 2600)
      return
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    setConfirmId(null)
    setBusy(true)
    dfApi('shotDelete', { engagement: props.eng, id: id }).then(function (r) {
      setBusy(false)
      if (!r || r.ok === false) { dfToast((r && r.error) || '删除失败', 'err', 4200); return }
      dfToast('截图已删除', 'ok', 1800)
      load()
    }, function (e) {
      setBusy(false)
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  function upload(files) {
    const list = Array.prototype.slice.call(files || [])
    if (!list.length) return
    const tooBig = list.filter(function (f) { return f.size > 4 * 1024 * 1024 })[0]
    if (tooBig) { dfToast(tooBig.name + ' 超过 4 MB（桥接单次请求上限 8 MB）', 'err', 4600); return }
    setBusy(true)
    let okCount = 0
    let failMsg = ''
    list.reduce(function (p, file) {
      return p.then(function () {
        return dfReadFile(file).then(function (dataUrl) {
          return dfApi('shotAdd', {
            engagement: props.eng,
            shot: {
              vuln_id: props.vulnId === undefined ? null : props.vulnId,
              asset_id: props.assetId === undefined ? null : props.assetId,
              point_code: props.pointCode || undefined,
              target: props.target || null,
              label: String(file.name || '').replace(/\.[^.]+$/, '').slice(0, 80),
              kind: 'screenshot',
              data_base64: String(dataUrl).replace(/^data:[^,]+,/, ''),
            },
          }).then(function (r) {
            if (!r || r.ok === false) { failMsg = (r && r.error) || '上传失败'; return }
            okCount += 1
          })
        })
      })
    }, Promise.resolve()).then(function () {
      setBusy(false)
      if (okCount > 0) dfToast('已上传 ' + okCount + ' 张截图', 'ok', 2000)
      if (failMsg) dfToast(failMsg, 'err', 4600)
      load()
    })
  }

  return h('section', { className: 'df-detail-sec' },
    h('div', { className: 'df-detail-hd' },
      h('h4', null, '证据截图' + (items.length ? ' · ' + items.length + ' 张' : '')),
      h('label', { className: 'df-btn df-btn--sm df-btn--ghost df-upload', title: 'PNG / JPEG / WebP，单张 ≤ 4 MB' },
        dfIcon('upload', 13),
        h('span', null, busy ? '上传中…' : '上传'),
        h('input', {
          type: 'file',
          accept: 'image/png,image/jpeg,image/webp',
          multiple: true,
          disabled: busy,
          onChange: function (e) {
            upload(e.target.files)
            e.target.value = ''
          },
        }))),
    err
      ? h('div', { className: 'df-note df-note--warn' }, err)
      : loading
        ? h('div', { className: 'df-note' }, '正在读取截图…')
        : items.length
          ? h('div', null,
            h('div', { className: 'df-shots' }, items.map(function (sh) {
              return h('div', { key: sh.id, className: 'df-shot' },
                h('button', {
                  type: 'button',
                  className: 'df-shot-b',
                  title: '点击查看原图',
                  onClick: function () { setOpenId(openId === sh.id ? null : sh.id) },
                }, h(DfShotThumb, { eng: props.eng, id: sh.id, alt: sh.label })),
                h('div', { className: 'df-shot-cap', title: [sh.label, sh.captured_at].filter(Boolean).join(' · ') },
                  (sh.kind === 'card' ? '证据卡 · ' : '') + dfDash(sh.label || dfTime(sh.captured_at))),
                h('button', {
                  type: 'button',
                  className: dfCx('df-shot-del', confirmId === sh.id && 'is-on'),
                  title: confirmId === sh.id ? '再点一次确认删除' : '删除',
                  disabled: busy,
                  onClick: function (e) { e.stopPropagation(); del(sh.id) },
                }, dfIcon('trash', 11)))
            })),
            openId
              ? (function () {
                const open = items.filter(function (x) { return x.id === openId })[0] || {}
                return h(DfShotLightbox, {
                  eng: props.eng,
                  id: openId,
                  alt: open.label,
                  capturedAt: open.captured_at,
                  onClose: function () { setOpenId(null) },
                })
              })()
              : null)
          : h('div', { className: 'df-note' }, '回显、后台页、数据样本都可以传上来。'))
}

/** 当前靶标下的全量证据截图：浏览器截图/上传图即使没挂漏洞，也能在这里看到。 */
function DfAllShots(props) {
  const state = dfUseAsync(function () {
    return dfApi('shots', { engagement: props.eng, limit: 200 }).then(function (r) {
      if (!r || r.ok === false) throw new Error((r && r.error) || '读取截图失败')
      return r
    })
  }, [props.eng, props.tick])
  const items = (state.data && state.data.items) || []
  return h(DfCard, {
    title: '全部证据截图',
    icon: 'image',
    sub: items.length ? '共 ' + dfNum(items.length) + ' 张 · 点击缩略图看原图' : '还没有截图',
  },
    state.error
      ? h(DfOpsError, { title: '读取截图失败', error: state.error, onRetry: state.reload })
      : state.loading && !state.data
        ? h(DfSkeleton, { lines: 4 })
        : items.length
          ? h(DfShotGallery, { eng: props.eng, shots: items })
          : h('div', { className: 'df-note' }, '浏览器截图、漏洞截图和手工上传的图都会汇总到这里。'))
}

/* ---------------------------------------------------------------- 交付自检 */

/**
 * 正常渗透的「成果」：报告会收录哪些漏洞，以及每条的材料齐不齐。
 *
 * 收录口径和报告完全一致，所以这里几条、报告就几条。每行盯三件事：
 * 有没有复现请求、有没有证据截图、有没有写证据 —— 缺哪样，SRC 那边就会打回来。
 */
function DfDeliverables(props) {
  const eng = props.eng
  const [only, setOnly] = useState('all')
  const state = dfUseAsync(function () {
    return dfApi('deliverables', { engagement: eng }).then(function (r) {
      if (!r || r.ok === false) throw new Error((r && r.error) || '读取交付清单失败')
      return r
    })
  }, [eng, props.tick])

  const d = state.data || {}
  const items = d.items || []
  const s = d.stats || {}
  const rows = only === 'gap'
    ? items.filter(function (it) { return !it.ready })
    : only === 'ready'
      ? items.filter(function (it) { return it.ready })
      : items

  function drawerFor(it) {
    return {
      /* 成果详情要逐条核对证据/材料是否齐全，走整页下钻。 */
      mode: 'page',
      title: it.title || '（未填标题）',
      sub: (DF_SEV[String(it.severity || '').toLowerCase()] || DF_SEV.info).label
        + ' · ' + (DF_VULN_STATUS[it.status] || it.status || '—'),
      rows: [
        ['严重度', (DF_SEV[String(it.severity || '').toLowerCase()] || DF_SEV.info).label],
        ['资产', it.asset_ip],
        ['目标', it.target],
        ['CVE', it.cve],
        ['复现请求', it.http > 0 ? it.http + ' 条' : '缺'],
        ['证据截图', it.shots > 0 ? it.shots + ' 张' : '缺'],
        ['危害与证据', it.evidence ? '已写' : '缺'],
        ['报告收录', '是（已验证/已利用且中危以上）'],
      ],
      node: h('div', { className: 'df-detail' },
        h('section', { className: 'df-detail-sec' },
          h('h4', null, '收录条件'),
          h('div', { className: 'df-detail-p' },
            '只收录已确认 / 已利用且中危以上的漏洞。'))),
    }
  }

  return h('div', { className: 'df-ops' },
    h('div', { className: 'df-opsbar' },
      h('span', { className: 'df-ops-title' }, '成果'),
      h('span', { className: 'df-ops-meta' }, '报告收录范围'),
      h('span', { className: 'df-spacer' }),
      h(DfSeg, {
        value: only,
        items: [['all', '全部'], ['ready', '已齐'], ['gap', '待补齐']],
        onChange: function (v) { setOnly(v) },
      }),
      h(DfBtn, {
        size: 'sm', kind: 'ghost', icon: 'fileText',
        onClick: function () { props.onGoto && props.onGoto('report') },
      }, '生成报告'),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', onClick: state.reload }, '刷新')),

    h('div', { className: 'df-statsbar' },
      h(DfStat, {
        label: '可交付漏洞', icon: 'bug', value: dfNum(s.total || 0),
        foot: '严重 ' + dfNum((s.bySeverity || {}).critical || 0)
          + ' · 高危 ' + dfNum((s.bySeverity || {}).high || 0),
      }),
      h(DfStat, {
        label: '材料已齐', icon: 'check', value: dfNum(s.ready || 0),
        foot: (s.total || 0) > 0 ? '占比 ' + dfPct(s.ready, s.total) : '还没有可交付漏洞',
        accent: (s.total || 0) > 0 && s.ready === s.total,
      }),
      h(DfStat, {
        label: '缺复现请求', icon: 'terminal', value: dfNum(s.noHttp || 0),
        foot: s.noHttp ? 'HTTP 漏洞没有请求原文' : 'HTTP 漏洞都有请求原文',
        accent: (s.noHttp || 0) > 0,
      }),
      h(DfStat, {
        label: '缺证据截图', icon: 'image', value: dfNum(s.noShots || 0),
        foot: s.noShots ? '交付前每张都要补' : '全部有截图',
        accent: (s.noShots || 0) > 0,
      })),

    h(DfCard, {
      title: '交付清单', icon: 'check',
      sub: (s.total || 0) ? '共 ' + dfNum(s.total) + ' 条 · 未收录 ' + dfNum(s.filteredOut || 0) + ' 条（待验证/误报/低危）' : '',
    },
      state.error
        ? h(DfOpsError, { title: '读取交付清单失败', error: state.error, onRetry: state.reload })
        : state.loading && !state.data
          ? h(DfSkeleton, { lines: 8 })
          : rows.length
            ? h('div', { className: 'df-tablewrap' },
              h(DfTable, {
                rows: rows, rowKey: function (r) { return r.id },
                /* 六列在最小面板宽度（720）下会差 20px 把「交付」列挤出卡片。
                   固定布局让百分比列真正让位，标题自己省略（悬浮看全名）。 */
                className: 'df-table--fixed',
                onRow: function (r) { props.onInspect && props.onInspect(drawerFor(r)) },
                columns: [
                  {
                    key: 'title', title: '漏洞', width: '34%',
                    render: function (r) {
                      return h('span', { className: 'df-dvc' },
                        h(DfSevBadge, { severity: r.severity }),
                        h('span', { className: 'df-dvc-t', title: r.title }, r.title || '（未填标题）'))
                    },
                  },
                  { key: 'asset_ip', title: '资产', width: 112, render: function (r) { return h('span', { className: 'df-mono' }, dfDash(r.asset_ip)) } },
                  {
                    key: 'http', title: '复现请求', width: 84, align: 'right',
                    render: function (r) {
                      return r.http > 0
                        ? h(DfChip, { kind: 'ok' }, dfNum(r.http) + ' 条')
                        : h(DfChip, { kind: 'warn' }, '缺')
                    },
                  },
                  {
                    key: 'shots', title: '截图', width: 72, align: 'right',
                    render: function (r) {
                      return r.shots > 0
                        ? h(DfChip, { kind: 'ok' }, dfNum(r.shots) + ' 张')
                        : h(DfChip, { kind: 'warn' }, '缺')
                    },
                  },
                  {
                    key: 'status', title: '状态', width: 84,
                    render: function (r) { return h(DfVulnStatusChip, { status: r.status }) },
                  },
                  {
                    key: 'ready', title: '交付', width: 76, align: 'right',
                    render: function (r) {
                      return r.ready
                        ? h(DfChip, { kind: 'ok', dot: true }, '可交付')
                        : h(DfChip, { kind: 'line' }, '待补齐')
                    },
                  },
                ],
              }))
            : h(DfEmpty, {
              icon: 'check',
              title: only === 'gap' ? '没有待补齐的漏洞' : '还没有可交付的漏洞',
              hint: only === 'gap'
                ? '材料都齐了，可以直接出报告。'
                : '只收录已确认 / 已利用且中危以上的漏洞。',
            })),
    h(DfAllShots, { eng: eng, tick: props.tick }))
}

/* ---------------------------------------------------------------- 成果 */

function DfScore(props) {
  return h(DfDeliverables, {
    eng: props.eng, tick: props.tick,
    onInspect: props.onInspect, onGoto: props.onGoto,
  })
}

/* ---------------------------------------------------------------- 报告导出 */

function DfReport(props) {
  return h(DfPentestReport, props)
}

/**
 * 正常渗透的「报告」：**默认不生成**。
 *
 * 为什么不默认生成：
 *   · 报告会吃 token（AI 润色）、也要人花时间审；
 *   · 多数项目根本不需要交付报告；
 *   · 一进页面就渲染一份文档，会让人误以为「报告已经在跑了」。
 *
 * 所以这里是一个三段式：
 *   ① 聚合   —— 只显示「会收录什么、料齐不齐」，全部本地计算，零请求零 token；
 *   ② 生成   —— 显式点一次，把结构化草稿写成 reports/report.md（仍然不调模型）；
 *   ③ 文档   —— 生成后才有正文，可复制 / 下载 / 让 AI 润色后覆盖同一个文件。
 */
function DfPentestReport(props) {
  const eng = props.eng
  const [busy, setBusy] = useState('')
  const [confirm, setConfirm] = useState(false)
  /* 报告门返回 needsCloseout 时记下缺口，按钮切到“强制生成”；修完可先“重新检查”。 */
  const [blocked, setBlocked] = useState(null)

  const state = dfUseAsync(function () {
    return Promise.all([
      dfApi('reportState', { engagement: eng }),
      dfApi('reportRead', { engagement: eng }),
    ]).then(function (r) {
      const st = r[0] || {}
      if (st.ok === false) throw new Error(st.error || '读取报告状态失败')
      return { st: st, doc: r[1] || {} }
    })
  }, [eng, props.tick])

  const st = (state.data && state.data.st) || {}
  const doc = (state.data && state.data.doc) || {}
  const md = String(doc.markdown || '')
  const ready = String(doc.at || '') !== ''
  const total = Number(st.total || 0)
  const pending = Number(st.pending_review || 0)
  const blockedCount = blocked
    ? (Number(blocked.untestedAssets) || 0) + (Number(blocked.matrixGaps) || 0)
      + (Number(blocked.noEvidence) || 0) + (Number(blocked.noHttp) || 0) + (Number(blocked.evidenceMismatch) || 0)
      + (Number(blocked.openHypotheses) || 0) + (Number(blocked.chainGaps) || 0)
      + (Number(blocked.tunnelGaps) || 0) + (Number(blocked.webshellGaps) || 0)
    : 0

  /* 切靶标时清掉上一个靶标的收口缺口，避免把 force 带到新项目。 */
  useEffect(function () { setBlocked(null) }, [eng])

  /* 「确认」只停留 5 秒：报告是显式动作，但也不想让人误点一下就落文件。 */
  useEffect(function () {
    if (!confirm) return undefined
    const t = window.setTimeout(function () { setConfirm(false) }, 5000)
    return function () { window.clearTimeout(t) }
  }, [confirm])

  function generate(force) {
    if (busy || total === 0) return
    setConfirm(false)
    setBusy('gen')
    dfApi('reportGenerate', {
      engagement: eng, title: '渗透测试报告', draft: pending > 0, force: force === true,
    }).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) {
        if (r && r.needsCloseout) {
          setBlocked({
            untestedAssets: Number(r.untestedAssets) || 0,
            matrixGaps: Number(r.matrixGaps) || 0,
            noEvidence: Array.isArray(r.noEvidence) ? r.noEvidence.length : 0,
            noHttp: Array.isArray(r.noHttp) ? r.noHttp.length : 0,
            evidenceMismatch: Array.isArray(r.evidenceMismatch) ? r.evidenceMismatch.length : 0,
            openHypotheses: Number(r.openHypotheses) || 0,
            chainGaps: Number(r.chainGaps) || 0,
            tunnelGaps: Number(r.tunnelGaps) || 0,
            webshellGaps: Number(r.webshellGaps) || 0,
            error: r.error || '收口未清零',
          })
          dfToast('收口未清零：先补缺口再点「重新检查」；确认要交再点「强制生成」', 'err', 5600)
          return
        }
        dfToast((r && r.error) || '生成失败', 'err', 4200)
        return
      }
      setBlocked(null)
      dfBust()
      dfToast((pending > 0 ? '已生成草稿（' + dfNum(pending) + ' 条待复核）：' : '报告已生成：')
        + dfNum(String(r.markdown || '').length) + ' 字符', 'ok', 3000)
      state.reload()
    }, function (e) {
      setBusy('')
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  function toggleNeed(next) {
    dfApi('reportMark', { engagement: eng, needReport: next }).then(function (r) {
      if (!r || r.ok === false) { dfToast((r && r.error) || '保存失败', 'err', 3600); return }
      state.reload()
    })
  }

  function download() {
    if (!md) return
    const name = '渗透测试报告-' + String(props.targetName || eng) + '-' + dfDay(new Date().toISOString()) + '.md'
    if (dfDownload(name, md, 'text/markdown')) dfToast('已导出 ' + name, 'ok', 2600)
    else dfToast('导出失败：浏览器阻止了下载', 'err', 4200)
  }

  /* 交给 AI 润色的指令：把文件路径写清楚，要求原地覆盖，
     这样 AI 改完面板刷新就能看到 —— 不需要用户再复制粘贴回来。 */
  function aiPrompt() {
    const path = String(doc.path || st.path || 'reports/report.md')
    return [
      '你在整理一份授权的渗透测试交付报告。材料就在下面（同时已存成 Markdown 文件）。',
      '',
      '写作要求：',
      '1. 事实准确：不要编造材料里没有的资产、端口、CVE、凭据；缺的地方写「待确认」。',
      '2. 结构：概述 / 测试范围与方法 / 风险概要 / 漏洞详情（每条含 影响、复现步骤、修复建议、证据）/ 附录。',
      '3. 复现步骤要让工程师能照着做；语言客观，不夸大、不写营销词。',
      '4. 改完后用同样的 Markdown **覆盖写回** 这个文件：' + path,
      '',
      '--- 当前报告草稿 ---',
      '',
      md,
    ].join('\n')
  }

  function copyPrompt() {
    dfCopy(aiPrompt()).then(function (ok) {
      dfToast(ok ? '指令已复制：发给 AI 即可，改完会覆盖同一个文件' : '复制失败', ok ? 'ok' : 'err', 3200)
    })
  }

  const stats = [
    { label: '可交付漏洞', icon: 'bug', value: dfNum(total), foot: '报告只会收录这些' },
    { label: '材料已齐', icon: 'check', value: dfNum(st.ready || 0), foot: total === 0 ? '还没有可交付漏洞' : (st.ready === total ? '都可以生成' : '差 ' + dfNum(total - (st.ready || 0)) + ' 条：缺请求或截图'), accent: total > 0 && st.ready === total },
    { label: '缺复现请求', icon: 'terminal', value: dfNum(st.no_http || 0), foot: (st.no_http || 0) > 0 ? '报告里没有请求原文' : '全部有请求原文', accent: (st.no_http || 0) > 0 },
    { label: '缺证据截图', icon: 'image', value: dfNum(st.no_shots || 0), foot: (st.no_shots || 0) > 0 ? '交付前每张都要补' : '全部有截图', accent: (st.no_shots || 0) > 0 },
  ]

  return h('div', { className: 'df-ops' },
    h('div', { className: 'df-opsbar' },
      h('span', { className: 'df-ops-title' }, '报告'),
      h('span', { className: 'df-ops-meta' }, state.loading && !state.data
        ? '读取中…'
        : ready
          ? '生成于 ' + dfTime(doc.at, true) + ' · ' + dfNum(md.length) + ' 字符'
          : '尚未生成'),
      h('span', { className: 'df-spacer' }),
      /* 项目级开关：这个项目到底要不要交付报告。关着也能手动生成，只是不主动提醒。 */
      h('label', { className: 'df-switch', title: '本项目是否需要交付报告（只影响概览的提醒，不会自动生成）' },
        h('input', {
          type: 'checkbox',
          checked: !!st.need_report,
          onChange: function (e) { toggleNeed(e.target.checked) },
        }),
        h('i'), '需要交付报告'),
      ready ? h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', onClick: state.reload }, '刷新') : null),

    h('div', { className: 'df-statsbar' }, stats.map(function (k, i) {
      return h(DfStat, Object.assign({ key: i }, k))
    })),

    state.error
      ? h(DfOpsError, { title: '读取报告失败', error: state.error, onRetry: state.reload })
      : ready
        ? h(DfCard, {
          title: '报告正文', icon: 'fileText',
          sub: '',
          actions: h('div', { className: 'df-btnrow' },
            h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'spark', onClick: copyPrompt }, '复制给 AI 润色'),
            h(DfCopyBtn, { text: md, label: '复制', toast: '报告 Markdown 已复制' }),
            h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'download', onClick: download }, '下载 .md'),
            blocked
              ? h(DfBtn, {
                size: 'sm', kind: 'ghost', icon: 'refresh', disabled: busy === 'gen',
                onClick: function () { generate(false) },
              }, '重新检查')
              : null,
            h(DfBtn, {
              size: 'sm', kind: 'ghost', icon: 'refresh',
              disabled: busy === 'gen',
              onClick: function () {
                if (blocked) { generate(true); return }
                if (!confirm) { setConfirm(true); return }
                generate(false)
              },
            }, busy === 'gen'
              ? '生成中…'
              : blocked
                ? '强制生成（缺口 ' + dfNum(blockedCount) + '）'
                : confirm ? '确认覆盖重写' : (pending > 0 ? '重新生成草稿' : '重新生成'))),
        },
          h('div', { className: 'df-report-meta' },
            st.report_draft ? h(DfChip, { kind: 'warn' }, '草稿 · ' + dfNum(pending) + ' 条待复核') : null,
            blocked ? h(DfChip, { kind: 'warn' }, '收口缺口 ' + dfNum(blockedCount)) : null,
            h('span', null, '生成于 ' + dfTime(doc.at, true)),
            h('span', null, '文件 ' + dfShort(String(doc.path || ''), 46) + ' · AI 润色会覆盖原文件'),
            h('span', { className: 'df-spacer' }),
            h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'check', onClick: function () { props.onGoto && props.onGoto('score') } }, '回到成果清单')),
          h('div', { className: 'df-report-bd' }, h(DfMarkdown, { source: md })))
        : h(DfCard, { title: '生成前检查', icon: 'fileText', sub: total > 0 ? '' : '还没有可交付漏洞' },
          h('div', { className: 'df-gen' },
            h('ul', { className: 'df-gen-list' },
              h('li', null, h('b', null, '包含'), h('span', null, '漏洞详情、复现请求、影响、修复建议，以及攻击路径与已控资产')),
              h('li', null, h('b', null, '不包含'), h('span', null, '待验证 / 误报 / 低危记录，以及任何分值'))),
            h('div', { className: 'df-gen-act' },
              h(DfBtn, {
                size: 'md', kind: 'primary', icon: confirm ? 'check' : 'fileText',
                disabled: total === 0 || busy === 'gen',
                onClick: function () {
                  if (blocked) { generate(true); return }
                  if (!confirm) { setConfirm(true); return }
                  generate(false)
                },
              }, busy === 'gen'
                ? '生成中…'
                : blocked
                  ? '强制生成（缺口 ' + dfNum(blockedCount) + '）'
                  : confirm
                    ? (pending > 0 ? '确认生成草稿' : '确认生成（约 1 秒）')
                    : (pending > 0 ? '生成草稿' : '生成报告')),
              blocked
                ? h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', disabled: busy === 'gen', onClick: function () { generate(false) } }, '重新检查')
                : null,
              blocked
                ? h('div', { className: 'df-note df-note--warn', style: { flex: '1 1 100%' } },
                  '收口未清零：未测资产 ' + dfNum(blocked.untestedAssets) + '、矩阵空格 ' + dfNum(blocked.matrixGaps) + '、无证据 ' + dfNum(blocked.noEvidence) + '、HTTP 漏洞缺报文 ' + dfNum(blocked.noHttp) + '、证据不同源 ' + dfNum(blocked.evidenceMismatch) + '、未关假设 ' + dfNum(blocked.openHypotheses) + '、步骤缺口 ' + dfNum(blocked.chainGaps) + '、通道缺口 ' + dfNum(blocked.tunnelGaps) + '/' + dfNum(blocked.webshellGaps) + '。修完点「重新检查」；确认要交再点「强制生成」。')
                : pending > 0
                  ? h('div', { className: 'df-note df-note--warn', style: { flex: '1 1 100%' } },
                    '还有 ' + dfNum(pending) + ' 条待复核，只能生成草稿。',
                    h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'bug', onClick: function () { props.onGoto && props.onGoto('vulns') } }, '去复核'))
                  : (total === 0
                  ? h('span', { className: 'df-note' }, '先在漏洞页确认发现，报告才有内容。')
                  : (total > (Number(st.ready) || 0)
                    ? h('span', { className: 'df-note' }, dfNum(total - (Number(st.ready) || 0)) + ' 条材料未补齐，生成后内容会不完整。')
                    : h('span', { className: 'df-note' }, '材料已齐备，可以直接生成。')))))))
}

/* ---------------------------------------------------------------- 成果 */


/* ---- lib/client/35-knowledge.js ---- */
/* 资源与配置视图（P3）：知识库 / 技能库 / 环境 / 提示词 / 维护（占位）。
   只做取数与展示；详情进抽屉，写入走 dfApi 的显式 op。 */

const DF_POC_KIND = {
  poc: 'POC', exp: 'EXP', script: '脚本', template: '模板',
  payload: 'Payload', lesson: '经验',
}

const DF_SKILL_KIND = { bundle: '目录', flat: '单文件' }

const DF_TPL_SEV = {
  critical: '严重', high: '高', medium: '中', low: '低', info: '信息', unknown: '—',
}

function dfCatName(list, code) {
  const hit = (list || []).filter(function (c) { return c.code === code })[0]
  return hit ? hit.name : (code || '未归类')
}

function dfCatOptions(list) {
  return (list || []).filter(function (c) { return (c.n || 0) > 0 })
}

/* ---------------------------------------------------------------- 知识库 */

/** 抽屉里的 POC 正文：按需拉 pocGet，避免列表把全文一起带走。 */
function DfPocBody(props) {
  const state = dfUseAsync(function () {
    return dfApi('pocGet', { id: props.id }, { ttl: 0 }).then(function (r) {
      if (!r || r.ok === false) throw new Error((r && r.error) || '读取 POC 失败')
      return r
    })
  }, [props.id])

  if (state.loading && !state.data) return h(DfSkeleton, { lines: 6 })
  if (state.error || !state.data) {
    return h(DfOpsError, { title: '读取 POC 失败', error: state.error, onRetry: state.reload })
  }
  const p = state.data
  const content = String(p.content || '')
  return h('div', { className: 'df-detail' },
    p.description ? h('section', { className: 'df-detail-sec' },
      h('h4', null, '说明'),
      h('div', { className: 'df-detail-p' }, p.description)) : null,
    p.usage ? h('section', { className: 'df-detail-sec' },
      h('h4', null, '用法'),
      h('pre', { className: 'df-code' }, String(p.usage))) : null,
    p.verified_note ? h('section', { className: 'df-detail-sec' },
      h('h4', null, '验证结论'),
      h('div', { className: 'df-detail-p' }, p.verified_note)) : null,
    h('section', { className: 'df-detail-sec' },
      h('div', { className: 'df-detail-hd' },
        h('h4', null, '正文 · ' + dfNum(content.length) + ' 字符'),
        content ? h(DfCopyBtn, { text: content, label: '复制', toast: 'POC 正文已复制' }) : null),
      content
        ? h('pre', { className: 'df-code' }, content)
        : h('div', { className: 'df-note' }, '这条只登记了元数据，还没有正文。')),
    p.tags ? h('section', { className: 'df-detail-sec' },
      h('h4', null, '标签'),
      h('div', { className: 'df-chips' }, String(p.tags).split(/[\s,，]+/).filter(Boolean).map(function (t, i) {
        return h(DfChip, { key: i, kind: 'line' }, t)
      }))) : null)
}

function DfKnowledge(props) {
  const [tab, setTab] = useState('poc')
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('')
  const [verified, setVerified] = useState(false)

  const statsState = dfUseAsync(function () {
    return dfApi('templateStats', {}, { ttl: 120000 }).then(function (r) {
      return (r && r.stats) || {}
    })
  }, [])

  const poc = dfUseAsync(function () {
    return dfApi('pocSearch', {
      q: q.trim() || undefined,
      category: cat || undefined,
      verified: verified || undefined,
      limit: 500,
    }).then(function (r) {
      if (!r || r.ok === false) throw new Error((r && r.error) || '读取知识库失败')
      return r
    })
  }, [q, cat, verified, props.tick])

  const tpl = dfUseAsync(function () {
    if (tab !== 'template') return Promise.resolve(null)
    return dfApi('templateSearch', {
      q: q.trim() || undefined,
      category: cat || undefined,
      limit: 120,
    }).then(function (r) {
      if (!r || r.ok === false) throw new Error((r && r.error) || '读取模板失败')
      return r
    })
  }, [tab, q, cat, props.tick])

  const pocStats = (poc.data && poc.data.stats) || {}
  const tplStats = statsState.data || {}
  const cats = tab === 'poc' ? (pocStats.byCategory || []) : (tplStats.byCategory || [])
  const pocRows = (poc.data && poc.data.items) || []
  const tplRows = (tpl.data && tpl.data.items) || []

  function openPoc(p) {
    if (!props.onInspect) return
    props.onInspect({
      title: p.title,
      sub: [dfCatName(pocStats.byCategory, p.category), DF_POC_KIND[p.kind] || p.kind].filter(Boolean).join(' · '),
      rows: [
        ['编号', p.cve],
        ['组件', p.component],
        ['版本', p.versions],
        ['语言', p.language],
        ['来源', p.source],
        ['验证', Number(p.verified) === 1 ? '已验证' : '未验证'],
        ['命中', p.hit_count ? p.hit_count + ' 次' : '—'],
        ['更新时间', dfTime(p.updated_at)],
        ['路径', p.path],
      ],
      node: h(DfPocBody, { id: p.id }),
    })
  }

  function openTpl(t) {
    if (!props.onInspect) return
    props.onInspect({
      title: t.name,
      sub: dfCatName(tplStats.byCategory, t.category) + ' · ' + (DF_TPL_SEV[String(t.severity || 'unknown')] || t.severity || '—'),
      rows: [
        ['模板名', t.name],
        ['严重度', DF_TPL_SEV[String(t.severity || 'unknown')] || t.severity],
        ['归类', dfCatName(tplStats.byCategory, t.category)],
        ['标签', t.tags],
        ['路径', t.path],
      ],
      node: h('div', { className: 'df-detail' },
        h('section', { className: 'df-detail-sec' },
          h('div', { className: 'df-detail-hd' },
            h('h4', null, '模板路径'),
            h(DfCopyBtn, { text: String(t.path || ''), label: '复制', toast: '路径已复制' })),
          h('pre', { className: 'df-code' }, String(t.path || ''))),
        h('div', { className: 'df-note' }, '模板由 nuclei 执行，这里只做检索。')),
    })
  }

  const loading = tab === 'poc' ? (poc.loading && !poc.data) : (tpl.loading && !tpl.data)
  const error = tab === 'poc' ? poc.error : tpl.error

  return h('div', { className: 'df-ops' },
    h('div', { className: 'df-opsbar' },
      h('span', { className: 'df-ops-title' }, '知识库'),
      h('span', { className: 'df-ops-meta' }, 'POC 与 nuclei 模板'),
      h('span', { className: 'df-spacer' }),
      h(DfSeg, {
        value: tab,
        items: [['poc', '沉淀 POC'], ['template', 'nuclei 模板']],
        onChange: function (k) { setTab(k); setCat('') },
      })),

    h('div', { className: 'df-statsbar' },
      h(DfStat, { label: '沉淀', icon: 'book', value: dfNum(pocStats.total || 0), foot: '已验证 ' + dfNum(pocStats.verified || 0) + ' · 有正文 ' + dfNum(pocStats.withContent || 0) }),
      h(DfStat, { label: '被复用', icon: 'refresh', value: dfNum(pocStats.reused || 0), foot: '命中过至少一次' }),
      h(DfStat, { label: 'nuclei 模板', icon: 'layers', value: dfNum(tplStats.total || 0), foot: 'CVE 模板 ' + dfNum(tplStats.cve || 0) }),
      h(DfStat, { label: '归类', icon: 'filter', value: dfNum(dfCatOptions(cats).length), foot: tab === 'poc' ? '有沉淀的类目' : '模板覆盖的类目' })),

    h(DfCard, null,
      h('div', { className: 'df-opsbar df-opsbar--pad' },
        h(DfSearch, {
          value: q, placeholder: tab === 'poc' ? '搜索标题 / CVE / 组件 / 正文' : '搜索模板名 / 路径 / 标签',
          onChange: function (v) { setQ(v) }, style: { width: 260 },
        }),
        h('select', {
          className: 'df-select', value: cat, title: '归类',
          onChange: function (e) { setCat(e.target.value) },
        },
          h('option', { value: '' }, '全部归类'),
          dfCatOptions(cats).map(function (c) {
            return h('option', { key: c.code, value: c.code }, c.name + '（' + c.n + '）')
          })),
        tab === 'poc'
          ? h('label', { className: 'df-switch' },
            h('input', {
              type: 'checkbox', checked: verified,
              onChange: function (e) { setVerified(e.target.checked) },
            }),
            h('i'), '只看已验证')
          : null,
        h('span', { className: 'df-spacer' }),
        h('span', { className: 'df-ops-meta' },
          loading
            ? '共 — 条'
            : tab === 'poc'
              ? '共 ' + dfNum(pocRows.length) + ' 条'
              : (tpl.data
                ? (q.trim() || cat
                  ? '命中 ' + dfNum(tpl.data.matched || 0) + ' / ' + dfNum(tpl.data.total || 0)
                  : '共 ' + dfNum(tpl.data.total || 0) + ' 个模板')
                : ''))),

      loading
        ? h('div', { className: 'df-ops-blank' }, h(DfSkeleton, { lines: 6 }))
        : error
          ? h(DfOpsError, { title: '读取知识库失败', error: error, onRetry: tab === 'poc' ? poc.reload : tpl.reload })
          : tab === 'poc'
            ? (pocRows.length
              ? h('div', { className: 'df-tablewrap' },
                h(DfTable, {
                  rows: pocRows,
                  rowKey: function (r) { return r.id },
                  onRow: openPoc,
                  columns: [
                    {
                      key: 'title', title: '条目', width: '40%',
                      render: function (r) {
                        return h('div', { className: 'df-vuln-t' }, r.title,
                          h('small', null, [r.component, r.versions, r.cve].filter(Boolean).join(' · ') || r.code))
                      },
                    },
                    {
                      key: 'category', title: '归类', width: 150,
                      render: function (r) {
                        const name = dfCatName(pocStats.byCategory, r.category)
                        return h(DfChip, { kind: name === '未归类' ? 'line' : 'info' }, name)
                      },
                    },
                    {
                      key: 'kind', title: '类型', width: 76,
                      render: function (r) { return h(DfChip, { kind: 'line' }, DF_POC_KIND[r.kind] || dfDash(r.kind)) },
                    },
                    {
                      key: 'verified', title: '验证', width: 80,
                      render: function (r) {
                        return Number(r.verified) === 1
                          ? h(DfChip, { kind: 'ok', dot: true }, '已验证')
                          : h(DfChip, { kind: 'line' }, '未验证')
                      },
                    },
                    {
                      key: 'updated_at', title: '更新', width: 92, align: 'right',
                      sortValue: function (r) { return r.updated_at || '' },
                      render: function (r) { return dfAgo(r.updated_at) },
                    },
                  ],
                }))
              : h(DfEmpty, {
                icon: 'book',
                title: q || cat || verified ? '没有匹配的条目' : '知识库还是空的',
                hint: q || cat || verified ? '换个关键词或清除筛选试试。' : '验证有效的 POC / 经验回填后会出现在这里。',
              }))
            : (tplRows.length
              ? h('div', { className: 'df-tablewrap' },
                h(DfTable, {
                  rows: tplRows,
                  rowKey: function (r, i) { return r.path || i },
                  onRow: openTpl,
                  columns: [
                    { key: 'name', title: '模板', width: '38%', render: function (r) { return h('span', { className: 'df-nm' }, dfDash(r.name)) } },
                    {
                      key: 'category', title: '归类', width: 150,
                      render: function (r) { return h(DfChip, { kind: 'info' }, dfCatName(tplStats.byCategory, r.category)) },
                    },
                    {
                      key: 'severity', title: '严重度', width: 78,
                      render: function (r) {
                        const s = String(r.severity || 'unknown')
                        return h(DfChip, { kind: s === 'critical' || s === 'high' ? 'err' : (s === 'medium' ? 'warn' : 'line') }, DF_TPL_SEV[s] || s)
                      },
                    },
                    { key: 'path', title: '路径', ellipsis: true, render: function (r) { return h('span', { className: 'df-mono' }, dfDash(r.path)) } },
                  ],
                }))
              : h(DfEmpty, {
                icon: 'layers',
                title: q || cat ? '没有匹配的模板' : '输入关键词开始检索',
                hint: q || cat
                  ? '换一个组件名 / CVE / 标签试试。'
                  : '本机模板库共 ' + dfNum(tplStats.total || 0) + ' 个，按组件名、CVE 或路径检索。',
              })))
  )
}

/* ---------------------------------------------------------------- 技能库 */

const DF_SKILL_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function dfSkillPost(body) {
  return dfHttp('/dsh-forge/skills', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  }, { ttl: 0 }).then(function (r) {
    return r || { ok: false, error: '技能接口没有返回内容' }
  })
}

function dfReadBase64(file) {
  return new Promise(function (resolve, reject) {
    const fr = new FileReader()
    fr.onload = function () {
      const s = String(fr.result || '')
      resolve(s.slice(s.indexOf(',') + 1))
    }
    fr.onerror = function () { reject(new Error('读取文件失败')) }
    fr.readAsDataURL(file)
  })
}

/** 技能编辑：正文 + 说明；新建时 id 可填，保存后回列表。 */
function DfSkillEditor(props) {
  const isNew = !props.id
  const [id, setId] = useState(String(props.id || ''))
  const [desc, setDesc] = useState(String(props.description || ''))
  const [text, setText] = useState(String(props.content || ''))
  const [busy, setBusy] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)

  useEffect(function () {
    if (!confirmDel) return undefined
    const t = window.setTimeout(function () { setConfirmDel(false) }, 5000)
    return function () { window.clearTimeout(t) }
  }, [confirmDel])

  const idOk = DF_SKILL_ID_RE.test(id.trim())
  const canSave = idOk && String(text).trim().length > 0 && !busy
  const size = new Blob([text]).size

  function save() {
    if (!canSave) return
    setBusy('save')
    dfSkillPost({ op: 'save', id: id.trim(), content: text, description: desc }).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '保存失败', 'err', 4600); return }
      dfToast(isNew ? '技能已创建：' + id.trim() : '技能已保存', 'ok', 2400)
      if (props.onSaved) props.onSaved(r)
    })
  }

  function del() {
    if (!id.trim() || busy) return
    setBusy('del')
    dfSkillPost({ op: 'delete', id: id.trim() }).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '删除失败', 'err', 4600); return }
      dfToast('已删除 ' + id.trim(), 'ok', 2400)
      if (props.onDeleted) props.onDeleted()
    })
  }

  return h('div', { className: 'df-detail' },
    h('section', { className: 'df-detail-sec' },
      h('div', { className: 'df-formgrid' },
        h(DfField, { label: '技能 ID', hint: isNew ? '小写字母与连字符，例如 code-review；保存后不可修改' : '保存后不可修改' },
          h('input', {
            className: 'df-input', value: id, disabled: !isNew, spellCheck: false,
            placeholder: 'code-review',
            onChange: function (e) { setId(e.target.value) },
          })),
        h(DfField, { label: '说明（description）', hint: '模型靠它判断什么时候调用' },
          h('input', {
            className: 'df-input', value: desc, spellCheck: false,
            placeholder: '什么时候该用这个技能',
            onChange: function (e) { setDesc(e.target.value) },
          })))),

    h('section', { className: 'df-detail-sec' },
      h('div', { className: 'df-detail-hd' },
        h('h4', null, 'SKILL.md · ' + dfNum(String(text).length) + ' 字符 · ' + dfNum(Math.round(size / 102.4) / 10) + ' KB'),
        h(DfCopyBtn, { text: text, label: '复制', toast: '技能正文已复制' })),
      h('textarea', {
        className: 'df-area df-area--code', rows: 16, value: text, spellCheck: false,
        placeholder: '---\ndescription: 一句话说明何时调用\n---\n\n正文…',
        onChange: function (e) { setText(e.target.value) },
      }),
      h('div', { className: 'df-hint' }, '保存时自动补齐 name / description。')),

    h('div', { className: 'df-formfoot' },
      h(DfBtn, {
        size: 'sm', kind: confirmDel ? 'solid-danger' : 'danger', icon: 'trash',
        disabled: !!busy || isNew,
        onBlur: function () { setConfirmDel(false) },
        onClick: function () {
          if (!confirmDel) { setConfirmDel(true); return }
          setConfirmDel(false)
          del()
        },
      }, busy === 'del' ? '删除中…' : (confirmDel ? '确认删除' : '删除')),
      h('span', { className: 'df-spacer' }),
      h(DfBtn, { size: 'sm', kind: 'primary', icon: 'check', disabled: !canSave, onClick: save },
        busy === 'save' ? '保存中…' : (isNew ? '创建' : '保存'))))
}

/** 按需拉正文再进编辑器（列表只给元数据）。 */
function DfSkillBodyEditor(props) {
  const state = dfUseAsync(function () {
    return dfSkillPost({ op: 'read', id: props.id }).then(function (r) {
      if (!r || r.ok === false) throw new Error((r && r.error) || '读取技能失败')
      return r
    })
  }, [props.id])

  if (state.loading && !state.data) return h(DfSkeleton, { lines: 8 })
  if (state.error || !state.data) {
    return h(DfOpsError, { title: '读取技能失败', error: state.error || (state.data && state.data.error), onRetry: state.reload })
  }
  const s = state.data
  return h(DfSkillEditor, {
    id: s.id,
    description: s.description,
    content: s.content,
    onSaved: props.onSaved,
    onDeleted: props.onDeleted,
  })
}

function DfSkills(props) {
  const [q, setQ] = useState('')
  const [kind, setKind] = useState('')
  const [impBusy, setImpBusy] = useState('')
  const zipRef = useRef(null)
  const dirRef = useRef(null)
  const state = dfUseAsync(function () {
    /* 对接 lib/index.js 的 skillsHttpHandler：op=status 返回 { skills: [...] }。 */
    return dfHttp('/dsh-forge/skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'status' }),
    }).then(function (r) {
      if (r && r.ok === false) throw new Error(r.error || '技能接口返回错误')
      return r || {}
    })
  }, [props.tick])

  /* 导入成功后刷新列表；抽屉里的编辑保存后同样回列表。 */
  function reloadAll() {
    if (props.onCloseDrawer) props.onCloseDrawer()
    state.reload()
  }

  function doneImport(r, label) {
    setImpBusy('')
    if (!r || r.ok === false) { dfToast((r && r.error) || (label + '失败'), 'err', 5200); return }
    const n = Array.isArray(r.imported) ? r.imported.length : 0
    dfToast(n ? ('已导入 ' + dfNum(n) + ' 个技能') : '没有找到可导入的技能', n ? 'ok' : 'info', 3200)
    state.reload()
  }

  function importZip(file) {
    if (!file || impBusy) return
    if (file.size > 9 * 1024 * 1024) { dfToast('压缩包太大（上限 9 MB）', 'err', 4200); return }
    setImpBusy('zip')
    dfReadBase64(file).then(function (data) {
      return dfSkillPost({ op: 'import', name: file.name, data: data })
    }).then(function (r) { doneImport(r, '导入') }, function (e) {
      setImpBusy('')
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  function importFolder(fileList) {
    const files = Array.from(fileList || [])
    if (!files.length || impBusy) return
    setImpBusy('dir')
    const picked = []
    let total = 0
    const next = function (i) {
      if (i >= files.length || total > 9 * 1024 * 1024 || picked.length >= 200) return Promise.resolve()
      const f = files[i]
      if (f.size > 9 * 1024 * 1024) return next(i + 1)
      total += f.size
      return dfReadBase64(f).then(function (b64) {
        picked.push({
          path: f.webkitRelativePath || f.name,
          content: b64,
          encoding: 'base64',
        })
        return next(i + 1)
      })
    }
    next(0).then(function () {
      if (!picked.length) { setImpBusy(''); dfToast('没读到文件夹里的文件', 'err', 4200); return null }
      const name = String(picked[0].path).split('/')[0] || 'skill'
      return dfSkillPost({ op: 'import', name: name, files: picked })
    }).then(function (r) {
      if (r) doneImport(r, '导入')
    }, function (e) {
      setImpBusy('')
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  /* 切页那一瞬只看得到一行小点：整页骨架太吵，换成「干等」的极简占位。 */
  if (state.loading && !state.data) return h(DfInlineWait)
  if (state.error) {
    return h(DfOpsError, { title: '读取技能失败', error: state.error, onRetry: state.reload })
  }
  const all = Array.isArray(state.data.skills) ? state.data.skills : []
  const term = q.trim().toLowerCase()
  const rows = all.filter(function (s) {
    if (kind && s.kind !== kind) return false
    if (!term) return true
    return [s.id, s.description, s.path].filter(Boolean).join(' ').toLowerCase().indexOf(term) >= 0
  })

  function open(s) {
    if (!props.onInspect) return
    props.onInspect({
      title: s.id,
      sub: (DF_SKILL_KIND[s.kind] || s.kind || '技能') + ' · ' + (s.valid === false ? '格式异常' : '可用'),
      rows: [
        ['技能', s.id],
        ['说明', s.description],
        ['形式', DF_SKILL_KIND[s.kind] || s.kind],
        ['大小', s.size ? dfNum(Math.round(s.size / 102.4) / 10) + ' KB' : '—'],
        ['路径', s.path],
      ],
      node: h(DfSkillBodyEditor, {
        id: s.id,
        onSaved: reloadAll,
        onDeleted: reloadAll,
      }),
    })
  }

  function createSkill() {
    if (!props.onInspect) return
    props.onInspect({
      title: '新建技能',
      sub: '保存后自动加载',
      rows: [],
      node: h(DfSkillEditor, { onSaved: reloadAll }),
    })
  }

  return h('div', { className: 'df-ops' },
    h('div', { className: 'df-opsbar' },
      h('span', { className: 'df-ops-title' }, '技能库'),
      h('span', { className: 'df-ops-meta' }, '目录型技能需要 SKILL.md'),
      h('span', { className: 'df-spacer' }),
      h(DfSearch, { value: q, placeholder: '搜索技能名 / 说明', onChange: function (v) { setQ(v) }, style: { width: 200 } }),
      h(DfSeg, {
        value: kind,
        items: [['', '全部'], ['bundle', '目录'], ['flat', '单文件']],
        onChange: function (v) { setKind(v) },
      })),

    h('div', { className: 'df-statsbar' },
      h(DfStat, { label: '技能', icon: 'spark', value: dfNum(all.length) }),
      h(DfStat, { label: '可用', icon: 'check', value: dfNum(all.filter(function (x) { return x.valid !== false }).length) }),
      h(DfStat, { label: '目录型', icon: 'folder', value: dfNum(all.filter(function (x) { return x.kind === 'bundle' }).length) }),
      h(DfStat, { label: '单文件', icon: 'list', value: dfNum(all.filter(function (x) { return x.kind === 'flat' }).length) })),

    h(DfCard, {
      title: '技能清单', icon: 'spark',
      sub: '用户技能目录',
      actions: h('div', { className: 'df-opsbar' },
        h('input', {
          type: 'file', ref: zipRef, accept: '.zip,.skill,.tgz', style: { display: 'none' },
          onChange: function (e) {
            const f = e.target.files && e.target.files[0]
            e.target.value = ''
            if (f) importZip(f)
          },
        }),
        h('input', {
          type: 'file', ref: dirRef, webkitdirectory: '', multiple: true, style: { display: 'none' },
          onChange: function (e) {
            const list = e.target.files
            e.target.value = ''
            if (list && list.length) importFolder(list)
          },
        }),
        h('div', { className: 'df-btnrow' },
          h(DfBtn, {
            size: 'sm', kind: 'ghost', icon: 'upload', disabled: !!impBusy,
            onClick: function () { if (zipRef.current) zipRef.current.click() },
          }, impBusy === 'zip' ? '导入中…' : '导入'),
          h(DfBtn, {
            size: 'sm', kind: 'ghost', icon: 'folder', disabled: !!impBusy,
            onClick: function () { if (dirRef.current) dirRef.current.click() },
          }, impBusy === 'dir' ? '导入中…' : '文件夹'),
          h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'plus', onClick: createSkill }, '新建'))),
    },
      rows.length
        ? h('div', { className: 'df-tablewrap' },
          h(DfTable, {
            rows: rows,
            rowKey: function (r, i) { return r.id || i },
            onRow: open,
            columns: [
              {
                key: 'id', title: '技能', width: '34%',
                render: function (r) {
                  return h('div', { className: 'df-vuln-t' }, r.id,
                    h('small', { title: r.description || '' }, dfShort(r.description || '没有说明', 96)))
                },
              },
              { key: 'kind', title: '形式', width: 82, render: function (r) { return h(DfChip, { kind: 'line' }, DF_SKILL_KIND[r.kind] || dfDash(r.kind)) } },
              { key: 'size', title: '大小', width: 82, align: 'right', render: function (r) { return r.size ? dfNum(Math.round(r.size / 102.4) / 10) + ' KB' : '—' } },
              {
                key: 'valid', title: '状态', width: 82,
                render: function (r) {
                  return r.valid === false
                    ? h(DfChip, { kind: 'err', dot: true }, '异常')
                    : h(DfChip, { kind: 'ok', dot: true }, '可用')
                },
              },
              { key: 'path', title: '路径', ellipsis: true, render: function (r) { return h('span', { className: 'df-mono' }, dfDash(r.path)) } },
            ],
          }))
        : h(DfEmpty, {
          icon: 'spark',
          title: all.length ? '没有匹配的技能' : '没有找到技能',
          hint: all.length ? '换个关键词或形式试试。' : '技能放在用户技能目录下；目录型技能需要 SKILL.md。',
        }))
  )
}

/* ---------------------------------------------------------------- 环境 */

/**
 * 环境页：工具路径、凭据、工具就绪度。
 *
 * 权限档位入口在顶栏常驻 chip，本页不重复；这里只报「找到几个工具」。
 */
/** 外部接入的一行：图标、名称、状态、说明、操作。 */
function DfSvcRow(props) {
  return h('div', { className: 'df-svc' },
    h('span', { className: 'df-svc-ico' }, dfIcon(props.icon || 'link', 15)),
    h('div', { className: 'df-svc-main' },
      h('div', { className: 'df-svc-title' },
        h('b', null, props.title),
        props.chip ? h(DfChip, { kind: props.chipKind || 'ok' }, props.chip) : null),
      h('div', { className: 'df-svc-desc' }, props.desc)),
    h('div', { className: 'df-svc-actions' }, props.actions),
    props.extra ? h('div', { className: 'df-svc-extra' }, props.extra) : null)
}

function DfEnv(props) {
  const state = dfUseAsync(function () {
    return dfApi('platformConfigGet', {}, { ttl: 0 }).then(function (r) {
      if (r && r.ok === false) throw new Error(r.error || '读取配置失败')
      return r || {}
    })
  }, [props.tick])

  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState('')
  const [vps, setVps] = useState({ host: '', port: 22, user: '', password: '', auth: '', configured: false })
  const [vpsBusy, setVpsBusy] = useState('')
  const [vpsWizard, setVpsWizard] = useState(false)
  const [vpsPortEdit, setVpsPortEdit] = useState(false)
  const [vpsChoice, setVpsChoice] = useState(null)
  const [vpsMode, setVpsMode] = useState('key')
  const [vpsRemember, setVpsRemember] = useState(true)
  const [clearArmed, setClearArmed] = useState(false)
  const [fofaClear, setFofaClear] = useState(false)
  const [fofaEdit, setFofaEdit] = useState(false)
  const [nativeConfirm, setNativeConfirm] = useState(false)
  const [ceye, setCeye] = useState({ domain: '', token: '', configured: false })
  const [ceyeBusy, setCeyeBusy] = useState('')
  const [ceyeClear, setCeyeClear] = useState(false)
  const [ceyeEdit, setCeyeEdit] = useState(false)
  const [egressBusy, setEgressBusy] = useState(false)
  const [egressResult, setEgressResult] = useState(null)

  useEffect(function () {
    if (!state.data) return
    const c = state.data.config || state.data
    const env = c.env || {}
    const vs = state.data.vps || {}
    setDraft({
      platform: c.platform || 'auto',
      /* 没填过时把实际生效的 dsh 默认目录显示出来，用户可以直接改成别的。 */
      toolkitDir: c.toolkitDir || state.data.toolkitDir || '',
      nucleiTemplatesDir: c.nucleiTemplatesDir || '',
      binDirs: (Array.isArray(c.binDirs) ? c.binDirs : []).join('\n'),
      egressProxy: (c.egress && c.egress.proxy) || '',
      egressNoProxy: (c.egress && c.egress.noProxy) || '',
      FOFA_KEY: env.FOFA_KEY || '',
    })
    setVps({
      host: vs.host || env.REDTEAM_VPS_ADDR || '',
      port: Number(vs.port || env.REDTEAM_VPS_PORT) || 22,
      user: vs.user || env.REDTEAM_VPS_USER || '',
      password: '',
      auth: vs.auth || env.REDTEAM_VPS_AUTH || '',
      configured: !!vs.configured,
      native: !!vs.native,
    })
    const oast = state.data.oast || {}
    setCeye({ domain: oast.domain || '', token: '', configured: !!oast.configured })
  }, [state.data])

  if (state.loading && !state.data) return h(DfSkeleton, { lines: 6 })
  if (state.error || !state.data) {
    return h(DfOpsError, { title: '读取环境配置失败', error: state.error, onRetry: state.reload })
  }

  const data = state.data
  const d = draft || {}

  function set(key, value) {
    setDraft(function (cur) { return Object.assign({}, cur || {}, { [key]: value }) })
  }

  function save() {
    if (busy) return
    setBusy('save')
    const config = {
      platform: d.platform || 'auto',
      toolkitDir: String(d.toolkitDir || '').trim(),
      nucleiTemplatesDir: String(d.nucleiTemplatesDir || '').trim(),
      binDirs: String(d.binDirs || '').split(/\r?\n/).map(function (x) { return x.trim() }).filter(Boolean),
      egress: {
        proxy: String(d.egressProxy || '').trim(),
        noProxy: String(d.egressNoProxy || '').trim(),
      },
    }
    dfApi('platformConfigSave', { config: config }).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '保存失败', 'err', 4200); return }
      dfToast('环境配置已保存', 'ok', 2400)
      state.reload()
      testEgress()
    }, function (e) {
      setBusy('')
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  function testEgress() {
    if (egressBusy) return
    setEgressBusy(true)
    dfApi('egressTest', {}, { ttl: 0 }).then(function (r) {
      setEgressBusy(false)
      setEgressResult(r || null)
    }, function (e) {
      setEgressBusy(false)
      setEgressResult({ ok: false, error: String((e && e.message) || e) })
    })
  }

  function clearFofa() {
    if (busy) return
    if (!fofaClear) {
      setFofaClear(true)
      window.setTimeout(function () { setFofaClear(false) }, 5000)
      return
    }
    setFofaClear(false)
    setBusy('fofa')
    dfApi('fofaClear', {}, { ttl: 0 }).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '清除失败', 'err', 4200); return }
      set('FOFA_KEY', '')
      dfToast('FOFA KEY 已清除', 'ok', 2400)
      state.reload()
    }, function (e) {
      setBusy('')
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  function saveFofa() {
    if (busy) return
    const key = String(d.FOFA_KEY || '').trim()
    const configured = !!(data.fofa && data.fofa.configured)
    if (!key && !configured) { dfToast('填 FOFA KEY', 'err', 3000); return }
    setBusy('fofaSave')
    dfApi('platformConfigSave', { config: { env: { FOFA_KEY: key } } }, { ttl: 0 }).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '保存失败', 'err', 4200); return }
      setFofaEdit(false)
      set('FOFA_KEY', '')
      dfToast(key ? 'FOFA KEY 已保存' : 'FOFA 配置未变', 'ok', 2400)
      state.reload()
    }, function (e) {
      setBusy('')
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  function vpsSet(key, value) {
    setVps(function (cur) { return Object.assign({}, cur, { [key]: value }) })
  }

  function vpsAuthLabel() {
    if (!vps.auth) return '未配置'
    if (vps.auth === 'key') return vps.configured ? '密钥登录' : '密钥缺失'
    if (vps.auth === 'password') return vps.configured ? '密码 · 已加密' : '密码 · 密文缺失'
    if (vps.auth === 'session') return vps.configured ? '密码 · 仅本次' : '密码 · 需重输'
    return vps.auth
  }

  function testVps() {
    if (vpsBusy) return
    if (!String(vps.host || '').trim() || !String(vps.user || '').trim()) {
      dfToast('先填主机和账号', 'err', 3000)
      return
    }
    const canReuse = !vps.password && (vps.auth === 'password' || vps.auth === 'session') && vps.configured
    if (!String(vps.password || '') && !canReuse) {
      dfToast('先填密码再测试', 'err', 3000)
      return
    }
    setVpsBusy('test')
    dfApi('vpsTest', {
      host: vps.host, port: Number(vps.port) || 22, user: vps.user,
      password: vps.password, useStored: canReuse,
    }, { ttl: 0 }).then(function (r) {
      setVpsBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '连接失败', 'err', 5200); return }
      setVpsMode(r.pubkeyAuth === 'no' ? 'password' : 'key')
      setVpsRemember(true)
      setVpsChoice({ latencyMs: Number(r.latencyMs) || 0, pubkeyAuth: r.pubkeyAuth || 'unknown' })
    }, function (e) {
      setVpsBusy('')
      dfToast(String((e && e.message) || e), 'err', 5200)
    })
  }

  function applyVps() {
    if (vpsBusy) return
    const keyMode = vpsMode === 'key'
    const mode = keyMode ? 'key' : (vpsRemember ? 'password' : 'session')
    setVpsBusy('apply')
    dfApi('vpsApply', {
      host: vps.host,
      port: Number(vps.port) || 22,
      user: vps.user,
      password: vps.password,
      useStored: !vps.password && vps.configured && (vps.auth === 'password' || vps.auth === 'session'),
      mode: mode,
      remember: mode === 'password',
    }, { ttl: 0 }).then(function (r) {
      setVpsBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '配置失败', 'err', 5600); return }
      setVpsChoice(null)
      setVpsWizard(false)
      setVps(function (cur) { return Object.assign({}, cur, { password: '', auth: r.auth, configured: true }) })
      dfToast(keyMode ? '已改用密钥登录' : (mode === 'password' ? '密码已加密保存' : '仅本次会话使用密码'), 'ok', 3000)
      state.reload()
    }, function (e) {
      setVpsBusy('')
      dfToast(String((e && e.message) || e), 'err', 5600)
    })
  }

  function clearVps() {
    if (vpsBusy) return
    if (!clearArmed) {
      setClearArmed(true)
      window.setTimeout(function () { setClearArmed(false) }, 5000)
      return
    }
    setClearArmed(false)
    setVpsBusy('clear')
    dfApi('vpsClear', {}, { ttl: 0 }).then(function (r) {
      setVpsBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '清除失败', 'err', 4200); return }
      setVps({ host: '', port: 22, user: '', password: '', auth: '', configured: false, native: false })
      setVpsWizard(false)
      if (r && r.warning) dfToast(r.warning, 'err', 7000)
      else dfToast('已清除 VPS 配置', 'ok', 2400)
      state.reload()
    }, function (e) {
      setVpsBusy('')
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  function toggleNative() {
    if (vpsBusy) return
    if (vps.auth !== 'key') return
    if (vps.native) { applyNative(false); return }
    setNativeConfirm(true)
  }

  function applyNative(enabled) {
    if (vpsBusy) return
    setVpsBusy('native')
    dfApi('vpsNative', { enabled: !!enabled }, { ttl: 0 }).then(function (r) {
      setVpsBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '切换失败', 'err', 4200); return }
      setNativeConfirm(false)
      setVps(function (cur) { return Object.assign({}, cur, { native: !!enabled }) })
      dfToast(enabled ? '已开启原生 ssh 模式' : '已切回面板代跑', 'ok', 2600)
      state.reload()
    }, function (e) {
      setVpsBusy('')
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  function saveCeye() {
    if (ceyeBusy) return
    if (!String(ceye.domain || '').trim()) { dfToast('填 CEYE 域名', 'err', 3000); return }
    setCeyeBusy('save')
    dfApi('oastSave', {
      domain: ceye.domain,
      token: ceye.token,
      test: true,
    }, { ttl: 0 }).then(function (r) {
      setCeyeBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '保存失败', 'err', 5200); return }
      setCeye(function (cur) { return Object.assign({}, cur, { token: '', configured: true }) })
      setCeyeEdit(false)
      dfToast('CEYE 已保存', 'ok', 2600)
      state.reload()
    }, function (e) {
      setCeyeBusy('')
      dfToast(String((e && e.message) || e), 'err', 5200)
    })
  }

  function clearCeye() {
    if (ceyeBusy) return
    if (!ceyeClear) {
      setCeyeClear(true)
      window.setTimeout(function () { setCeyeClear(false) }, 5000)
      return
    }
    setCeyeClear(false)
    setCeyeBusy('clear')
    dfApi('oastClear', {}, { ttl: 0 }).then(function (r) {
      setCeyeBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '清除失败', 'err', 4200); return }
      setCeye({ domain: '', token: '', configured: false })
      dfToast('已清除 CEYE', 'ok', 2400)
      state.reload()
    }, function (e) {
      setCeyeBusy('')
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  return h('div', { className: 'df-ops' },
    h(DfCard, {
      title: '本地工具', icon: 'folder',
      actions: h('div', { className: 'df-opsbar' },
        h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', onClick: state.reload }, '重读'),
        h(DfBtn, {
          size: 'sm', kind: 'primary', icon: 'check', disabled: !!busy,
          onClick: function () { save() },
        }, busy === 'save' ? '保存中…' : '保存')),
    },
      h('div', { className: 'df-formgrid' },
        h('div', { className: 'df-field' },
          h('label', null, '工具箱目录'),
          h('input', {
            className: 'df-input', value: d.toolkitDir || '', placeholder: '例如 C:\\tools\\redteam-kit',
            onChange: function (e) { set('toolkitDir', e.target.value) },
          })),
        h('div', { className: 'df-field' },
          h('label', null, 'nuclei 模板目录'),
          h('input', {
            className: 'df-input', value: d.nucleiTemplatesDir || '', placeholder: 'nuclei-templates 根目录',
            onChange: function (e) { set('nucleiTemplatesDir', e.target.value) },
          })),
        h('div', { className: 'df-field df-field--wide' },
          h('label', null, '附加搜索目录'),
          h('textarea', {
            className: 'df-area df-area--list', rows: 2, value: d.binDirs || '',
            placeholder: '一行一个目录；绿色版工具放这里也能被找到',
            onChange: function (e) { set('binDirs', e.target.value) },
          })))),
      h('div', { className: 'df-note' },
        data.inventory && data.inventory.total
          ? '当前扫描到 ' + dfNum(data.inventory.total) + ' 个工具文件（含手动指定）；在「工具」页查看、标注或重扫。'
          : '还没有扫描到工具文件。填好目录后保存，或到「工具」页点「重扫」。'),

    h(DfCard, {
      title: '网络出口', icon: 'cloud',
      sub: 'AI 执行 curl / nuclei / ffuf 时走这个代理；不改 dsh 自身流量',
      actions: h('div', { className: 'df-opsbar' },
        h(DfBtn, {
          size: 'sm', kind: 'ghost', icon: 'refresh', disabled: egressBusy,
          onClick: function () { testEgress() },
        }, egressBusy ? '测试中…' : '测试出口'),
        h(DfBtn, {
          size: 'sm', kind: 'primary', icon: 'check', disabled: !!busy,
          onClick: function () { save() },
        }, busy === 'save' ? '保存中…' : '保存')),
    },
      h('div', { className: 'df-formgrid' },
        h('div', { className: 'df-field' },
          h('label', null, '代理地址'),
          h('input', {
            className: 'df-input', value: d.egressProxy || '',
            placeholder: '127.0.0.1:1080（有密码写 user:pass@127.0.0.1:1080）',
            onChange: function (e) { set('egressProxy', e.target.value) },
          })),
        h('div', { className: 'df-field' },
          h('label', null, '不走代理'),
          h('input', {
            className: 'df-input', value: d.egressNoProxy || '',
            placeholder: '内网网段，例如 10.0.0.0/8,192.168.0.0/16',
            onChange: function (e) { set('egressNoProxy', e.target.value) },
          }))),
      h('div', { className: 'df-note' },
        '只填 IP:端口 —— http 与 socks5 是同一个端口，两种协议都会写进系统提示，AI 按任务选；代理要认证就写 user:pass@IP:端口。留空表示直连。'),
      egressResult
        ? h('div', { className: 'df-note', style: { marginTop: 6 } },
          egressResult.ok === false
            ? '出口测试失败：' + (egressResult.error || '未知错误')
            : (egressResult.mode === 'proxy'
              ? '出口可用：' + (egressResult.proxy || '代理')
                + (egressResult.schemes
                  ? ' · 可用协议 ' + Object.keys(egressResult.schemes).filter(function (k) {
                    return egressResult.schemes[k] && egressResult.schemes[k].ok
                  }).map(function (k) { return k === 'socks5' ? 'socks5' : 'http' }).join(' / ')
                  : '')
              : egressResult.mode === 'direct'
                ? (String(d.egressProxy || '').trim()
                  ? '配置的代理没连上，当前按直连（检查地址 / 端口 / 是否需要启动 Burp）'
                  : '直连')
                : '不可用')
            + (egressResult.configured_error ? ' · 你填的代理：' + egressResult.configured_error : '')
            + (egressResult.detail ? ' · ' + egressResult.detail : ''))
        : null),

    h(DfCard, {
      title: '外部接入', icon: 'link',
    },
      h('div', { className: 'df-svc-list' },
        h(DfSvcRow, {
          icon: 'crosshair', title: 'FOFA',
          chip: data.fofa && data.fofa.configured ? '已配' : '未配',
          chipKind: data.fofa && data.fofa.configured ? 'ok' : 'err',
          desc: '资产测绘 API',
          actions: [
            h(DfBtn, {
              size: 'sm', kind: 'ghost', icon: 'sliders',
              onClick: function () { setFofaEdit(true) },
            }, '配置'),
            data.fofa && data.fofa.configured
              ? h(DfBtn, {
                size: 'sm', kind: fofaClear ? 'danger' : 'ghost', icon: 'trash',
                disabled: !!busy, onClick: clearFofa,
              }, busy === 'fofa' ? '清除中…' : (fofaClear ? '确认清除' : '清除'))
              : null,
          ],
        }),
        h(DfSvcRow, {
          icon: 'server', title: 'VPS',
          chip: vps.configured ? vpsAuthLabel() : '未配置',
          chipKind: vps.configured ? 'ok' : 'err',
          desc: vps.configured
            ? (vps.user ? vps.user + '@' : '') + vps.host + ' · 端口 ' + (vps.port || 22)
            : '反弹、隧道、文件传输',
          actions: [
            h(DfBtn, {
              size: 'sm', kind: vps.configured ? 'ghost' : 'primary', icon: 'link',
              disabled: !!vpsBusy,
              onClick: function () { setVpsChoice(null); setVpsPortEdit(false); setVpsWizard(true) },
            }, vps.configured ? '重新配置' : '连接'),
            vps.configured
              ? h(DfBtn, {
                size: 'sm', kind: clearArmed ? 'danger' : 'ghost', icon: 'trash',
                disabled: !!vpsBusy, onClick: clearVps,
              }, vpsBusy === 'clear' ? '清除中…' : (clearArmed ? '确认清除' : '清除'))
              : null,
          ],
          extra: vps.configured && vps.auth === 'key'
            ? h('div', { className: 'df-vps-native' },
              h('label', { className: 'df-check' },
                h('input', {
                  type: 'checkbox', checked: !!vps.native,
                  disabled: !!vpsBusy, onChange: toggleNative,
                }),
                h('span', null, '原生 ssh 模式')),
              h('span', { className: 'df-hint' }, vps.native
                ? '模型可直接 ssh / scp / 隧道，也能读取私钥。'
                : '默认由面板代跑，模型拿不到私钥。'))
            : null,
        }),
        h(DfSvcRow, {
          icon: 'cloud', title: 'CEYE',
          chip: ceye.configured ? '已配置' : '未配置',
          chipKind: ceye.configured ? 'ok' : 'err',
          desc: ceye.configured ? ceye.domain : 'DNS / HTTP 回连记录',
          actions: [
            h(DfBtn, {
              size: 'sm', kind: 'ghost', icon: 'sliders',
              onClick: function () { setCeyeEdit(true) },
            }, '配置'),
            ceye.configured
              ? h(DfBtn, {
                size: 'sm', kind: ceyeClear ? 'danger' : 'ghost', icon: 'trash',
                disabled: !!ceyeBusy, onClick: clearCeye,
              }, ceyeBusy === 'clear' ? '清除中…' : (ceyeClear ? '确认清除' : '清除'))
              : null,
          ],
        }))),

    fofaEdit
      ? h('div', { className: 'df-mask df-portal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '配置 FOFA' },
        h('div', { className: 'df-modal' },
          h('div', { className: 'df-modal-hd' },
            h('div', { className: 'df-mh-t' },
              h('h2', null, 'FOFA KEY'),
              h('p', null, '资产测绘 API'))),
          h('div', { className: 'df-modal-bd' },
            h('div', { className: 'df-field' },
              h('label', null, 'API Key'),
              h('input', {
                className: 'df-input', type: 'password', autoComplete: 'new-password',
                value: d.FOFA_KEY || '',
                placeholder: data.fofa && data.fofa.configured ? '已配置；留空不修改' : 'FOFA API key',
                autoFocus: true,
                onChange: function (e) { set('FOFA_KEY', e.target.value) },
              }),
              h('div', { className: 'df-hint' }, '只存本机，DPAPI 加密；不会写进报告。'))),
          h('div', { className: 'df-modal-ft' },
            h(DfBtn, { kind: 'ghost', onClick: function () { setFofaEdit(false) } }, '取消'),
            h('span', { className: 'df-spacer' }),
            h(DfBtn, {
              kind: 'primary', icon: 'check', disabled: !!busy, onClick: saveFofa,
            }, busy === 'fofaSave' ? '保存中…' : '保存'))))
      : null,

    ceyeEdit
      ? h('div', { className: 'df-mask df-portal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '配置 CEYE' },
        h('div', { className: 'df-modal' },
          h('div', { className: 'df-modal-hd' },
            h('div', { className: 'df-mh-t' },
              h('h2', null, 'CEYE'),
              h('p', null, 'DNS / HTTP 回连记录'))),
          h('div', { className: 'df-modal-bd' },
            h('div', { className: 'df-field' },
              h('label', null, 'CEYE 域名'),
              h('input', {
                className: 'df-input', value: ceye.domain || '', placeholder: '例如 abc123.ceye.io',
                onChange: function (e) { setCeye(function (cur) { return Object.assign({}, cur, { domain: e.target.value }) }) },
              })),
            h('div', { className: 'df-field' },
              h('label', null, 'Token'),
              h('input', {
                className: 'df-input', type: 'password', autoComplete: 'new-password',
                value: ceye.token || '',
                placeholder: ceye.configured ? '已保存；留空不修改' : 'CEYE API token',
                onChange: function (e) { setCeye(function (cur) { return Object.assign({}, cur, { token: e.target.value }) }) },
              }),
              h('div', { className: 'df-hint' }, 'Token 加密保存，不进提示词。'))),
          h('div', { className: 'df-modal-ft' },
            h(DfBtn, { kind: 'ghost', onClick: function () { setCeyeEdit(false) } }, '取消'),
            h('span', { className: 'df-spacer' }),
            h(DfBtn, {
              kind: 'primary', icon: 'check', disabled: !!ceyeBusy, onClick: saveCeye,
            }, ceyeBusy === 'save' ? '保存中…' : '测试并保存'))))
      : null,

    vpsWizard
      ? h('div', { className: 'df-mask df-portal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '连接 VPS' },
        h('div', { className: 'df-modal' },
          h('div', { className: 'df-modal-hd' },
            h('div', { className: 'df-mh-t' },
              h('h2', null, vpsChoice ? '选择登录方式' : '连接 VPS'),
              h('p', null, vpsChoice ? ('已连通 · ' + vpsChoice.latencyMs + ' ms') : '先测通，再决定用密钥还是密码。'))),
          h('div', { className: 'df-modal-bd' },
            vpsChoice
              ? h('div', null,
                h('label', {
                  className: 'df-vps-opt' + (vpsMode === 'key' ? ' on' : '') + (vpsChoice.pubkeyAuth === 'no' ? ' is-off' : ''),
                  onClick: vpsChoice.pubkeyAuth === 'no' ? null : function () { setVpsMode('key') },
                },
                  h('input', {
                    type: 'radio', checked: vpsMode === 'key', disabled: vpsChoice.pubkeyAuth === 'no',
                    onChange: function () { setVpsMode('key') },
                  }),
                  h('div', null,
                    h('b', null, '改用密钥登录（推荐）'),
                    h('p', null, vpsChoice.pubkeyAuth === 'no'
                      ? '服务器未开启公钥登录（PubkeyAuthentication no），先在 VPS 开启或继续用密码。'
                      : '密码只用于安装公钥，装完立即丢弃。私钥加密保存，模型拿不到；命令与文件传输由面板代跑。'))),
                h('label', { className: 'df-vps-opt' + (vpsMode === 'password' ? ' on' : ''), onClick: function () { setVpsMode('password') } },
                  h('input', {
                    type: 'radio', checked: vpsMode === 'password',
                    onChange: function () { setVpsMode('password') },
                  }),
                  h('div', null,
                    h('b', null, '继续用账号密码'),
                    h('p', null, '密码必须加密保存或仅本次使用；命令由面板代跑，功能受限。'))),
                vpsMode === 'password'
                  ? h('div', { className: 'df-vps-sub' },
                    h('label', { className: 'df-check' },
                      h('input', {
                        type: 'checkbox', checked: vpsRemember,
                        onChange: function (e) { setVpsRemember(e.target.checked) },
                      }),
                      h('span', null, '记住密码（DPAPI 加密）')),
                    h('div', { className: 'df-hint' }, vpsRemember
                      ? '同一 Windows 账户下的程序仍可能解密，安全性低于密钥。'
                      : '只在本次会话使用，重启后需要重新输入。'))
                  : null,
                vpsChoice.pubkeyAuth === 'no'
                  ? h('div', { className: 'df-hint', style: { marginTop: 10 } },
                    '开启方法：VPS 上编辑 /etc/ssh/sshd_config（及 sshd_config.d），设 PubkeyAuthentication yes，再 systemctl reload ssh。')
                  : null)
              : h('div', null,
                h('div', { className: 'df-field' },
                  h('label', null, '主机'),
                  h('input', {
                    className: 'df-input', value: vps.host || '', placeholder: 'IP 或域名', autoFocus: true,
                    onChange: function (e) { vpsSet('host', e.target.value) },
                  })),
                h('div', { className: 'df-field' },
                  h('label', null, '账号'),
                  h('input', {
                    className: 'df-input', value: vps.user || '', placeholder: '例如 ubuntu',
                    onChange: function (e) { vpsSet('user', e.target.value) },
                  })),
                h('div', { className: 'df-field' },
                  h('label', null, '密码'),
                  h('input', {
                    className: 'df-input', type: 'password', autoComplete: 'new-password',
                    value: vps.password || '',
                    placeholder: vps.configured && (vps.auth === 'password' || vps.auth === 'session')
                      ? '已保存密码；留空沿用'
                      : 'VPS 登录密码',
                    onChange: function (e) { vpsSet('password', e.target.value) },
                  })),
                vpsPortEdit
                  ? h('div', { className: 'df-field' },
                    h('label', null, '端口'),
                    h('input', {
                      className: 'df-input', type: 'number', min: 1, max: 65535, value: vps.port || 22,
                      onChange: function (e) { vpsSet('port', e.target.value) },
                    }))
                  : h('div', { className: 'df-hint' }, '端口 ' + (vps.port || 22) + '　',
                    h('a', {
                      href: '#',
                      onClick: function (e) { e.preventDefault(); setVpsPortEdit(true) },
                    }, '改端口')))),
          h('div', { className: 'df-modal-ft' },
            h(DfBtn, {
              kind: 'ghost',
              onClick: function () { setVpsWizard(false); setVpsChoice(null); setVpsPortEdit(false) },
            }, '取消'),
            h('span', { className: 'df-spacer' }),
            vpsChoice
              ? h(DfBtn, {
                kind: 'primary', icon: 'check', disabled: !!vpsBusy, onClick: applyVps,
              }, vpsBusy === 'apply' ? '配置中…' : '确认')
              : h(DfBtn, {
                kind: 'primary', icon: 'link', disabled: !!vpsBusy, onClick: testVps,
              }, vpsBusy === 'test' ? '测试中…' : '测试连接'))))
      : null,

    nativeConfirm
      ? h('div', { className: 'df-mask df-portal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '开启原生 ssh' },
        h('div', { className: 'df-modal' },
          h('div', { className: 'df-modal-hd' },
            h('div', { className: 'df-mh-t' },
              h('h2', null, '开启原生 ssh 模式'),
              h('p', null, '可用性最高，但模型能直接拿到私钥。'))),
          h('div', { className: 'df-modal-bd' },
            h('p', null, '开启后模型可以直接 ssh / scp / ssh -L，不再经过面板代跑。'),
            h('p', null, '私钥会以可用文件形式放在本机，模型和同账户进程都能读取；只在你信任本机和模型时开启。')),
          h('div', { className: 'df-modal-ft' },
            h(DfBtn, { kind: 'ghost', onClick: function () { setNativeConfirm(false) } }, '取消'),
            h('span', { className: 'df-spacer' }),
            h(DfBtn, {
              kind: 'primary', icon: 'check', disabled: !!vpsBusy,
              onClick: function () { applyNative(true) },
            }, vpsBusy === 'native' ? '开启中…' : '确认开启'))))
      : null
  )
}

/* ---------------------------------------------------------------- 提示词 */

/** 角色稿变体：只负责把变体载入编辑器，点“保存”才写当前靶标/模式。 */
function DfRoleTemplateBar(props) {
  const [items, setItems] = useState([])
  const [defaultContent, setDefaultContent] = useState('')
  const [busy, setBusy] = useState('')
  const [saveOpen, setSaveOpen] = useState(false)
  const [name, setName] = useState('')
  const mode = props.mode || 'redteam'

  function load() {
    dfHostPost('/dsh-forge/role-templates', { op: 'status', mode: mode, role: props.role }).then(function (r) {
      if (!r || r.ok === false) return
      setItems(Array.isArray(r.items) ? r.items : [])
      setDefaultContent(String(r.default_content || ''))
    })
  }

  useEffect(load, [props.role, mode])

  function pick(id) {
    if (!id) return
    if (id === '__default') {
      props.onLoad(defaultContent)
      dfToast('已载入模式默认稿，点“保存”生效', 'info', 2400)
      return
    }
    setBusy('load')
    dfHostPost('/dsh-forge/role-templates', { op: 'read', mode: mode, role: props.role, id: id }).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '读取变体失败', 'err', 4200); return }
      props.onLoad(String(r.content || ''))
      dfToast('已载入变体，点“保存”生效', 'info', 2400)
    })
  }

  function save() {
    if (!name.trim() || busy) return
    setBusy('save')
    dfHostPost('/dsh-forge/role-templates', {
      op: 'save', mode: mode, role: props.role, name: name.trim(), content: props.text,
    }).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '保存变体失败', 'err', 4200); return }
      dfToast('已存为变体', 'ok', 1800)
      setSaveOpen(false)
      setName('')
      load()
    })
  }

  return h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 } },
    h('span', { className: 'df-label' }, '变体'),
    h('select', {
      className: 'df-select', value: '', style: { width: 210, flex: 'none' },
      onChange: function (e) { pick(e.target.value) },
    },
      h('option', { value: '' }, '载入变体…'),
      h('option', { value: '__default' }, '模式默认'),
      items.map(function (t) {
        return h('option', { key: t.id, value: t.id }, t.name + '（' + dfNum(t.chars) + ' 字符）')
      })),
    busy === 'load' ? h('span', { className: 'df-hint' }, '载入中…') : null,
    saveOpen
      ? h('span', { style: { display: 'inline-flex', gap: 6, alignItems: 'center' } },
        h('input', {
          className: 'df-input', value: name, autoFocus: true, placeholder: '变体名称',
          style: { width: 150 }, onChange: function (e) { setName(e.target.value) },
        }),
        h(DfBtn, { size: 'sm', kind: 'primary', icon: 'check', disabled: !!busy || !name.trim(), onClick: save }, busy === 'save' ? '保存中…' : '保存'),
        h(DfBtn, { size: 'sm', kind: 'ghost', onClick: function () { setSaveOpen(false); setName('') } }, '取消'))
      : h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'plus', onClick: function () { setSaveOpen(true) } }, '另存为变体'))
}

/* 工作区指令编辑器：dsh 原生 AGENTS.md / CLAUDE.md。 */
function DfInstructionEditor(props) {
  const [text, setText] = useState('')
  const [orig, setOrig] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const dirty = loaded && text !== orig

  useEffect(function () {
    let alive = true
    setLoaded(false)
    setErr('')
    dfHostPost('/dsh-forge/instructions', { action: 'read', path: props.file.path }).then(function (r) {
      if (!alive) return
      if (!r || r.ok === false) {
        setErr((r && r.error) || '读取指令文件失败')
        setLoaded(true)
        return
      }
      const content = String(r.content || '')
      setText(content)
      setOrig(content)
      setLoaded(true)
    })
    return function () { alive = false }
  }, [props.file.path])

  function save() {
    if (busy || !dirty) return
    setBusy(true)
    dfHostPost('/dsh-forge/instructions', { action: 'save', path: props.file.path, content: text }).then(function (r) {
      setBusy(false)
      if (!r || r.ok === false) { dfToast((r && r.error) || '保存失败', 'err', 4200); return }
      setOrig(text)
      dfToast('已保存，下一轮生效', 'ok', 2200)
      if (props.onSaved) props.onSaved(r)
    })
  }

  if (!loaded) return h('div', { className: 'df-detail' }, h('div', { className: 'df-note' }, '读取中…'))
  return h('div', { className: 'df-detail' },
    err ? h('div', { className: 'df-note', style: { color: 'var(--df-err)' } }, err) : null,
    h('div', { className: 'df-note' }, 'DeepSeek Harness 按 用户级 → 项目根 → 当前目录 顺序拼接；总预算 64KB，超出会截断。'),
    h('textarea', {
      className: 'df-area df-area--code', rows: 18, value: text, spellCheck: false,
      style: { width: '100%', minHeight: 320 },
      onChange: function (e) { setText(e.target.value) },
    }),
    h('div', { className: 'df-formfoot' },
      h('span', { className: 'df-ops-meta' }, dfNum(text.length) + ' 字符 · 下一轮生效'),
      h('span', { className: 'df-spacer' }),
      h(DfBtn, { size: 'sm', kind: 'primary', icon: 'check', disabled: busy || !dirty, onClick: save }, busy ? '保存中…' : '保存')))
}

/**
 * 破甲注入生效范围：模式可能越来越多，卡片里只放摘要；完整列表在抽屉里搜索、全选。
 * 保存时一次性写回，避免每勾一下就打一次接口。
 */
function DfScopePicker(props) {
  const [sel, setSel] = useState(function () {
    return Array.isArray(props.scopes) ? props.scopes.slice() : []
  })
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const modes = Array.isArray(props.modes) ? props.modes : []
  const cur = String(props.current || '')
  const query = q.trim().toLowerCase()
  const shown = modes.filter(function (m) {
    if (!query) return true
    return [dfModeTitle(m), m.id, m.description].map(function (x) { return String(x || '') }).join(' ').toLowerCase().includes(query)
  })

  function toggle(id) {
    setSel(function (list) {
      return list.indexOf(id) >= 0 ? list.filter(function (x) { return x !== id }) : list.concat([id])
    })
  }

  function save() {
    if (busy) return
    setBusy(true)
    dfHostPost('/dsh-forge/inject', { action: 'setScopes', scopes: sel }).then(function (r) {
      setBusy(false)
      if (!r || r.ok === false) { dfToast((r && r.error) || '保存失败', 'err', 4200); return }
      dfToast('生效范围已更新，下一轮生效', 'ok', 2200)
      if (props.onSaved) props.onSaved(sel)
      if (props.onClose) props.onClose()
    }, function (e) {
      setBusy(false)
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  return h('div', { className: 'df-detail' },
    h('div', { className: 'df-note' }, '勾选的模式才启用破甲注入；没勾的模式保持 DeepSeek Harness 原生人格。'),
    h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', margin: '10px 0', flexWrap: 'wrap' } },
      h(DfSearch, { value: q, placeholder: '搜索模式 / 用途', onChange: setQ, style: { flex: '1 1 180px' } }),
      h(DfBtn, { size: 'sm', kind: 'ghost', onClick: function () { setSel(modes.map(function (m) { return m.id })) } }, '全选'),
      h(DfBtn, { size: 'sm', kind: 'ghost', onClick: function () { setSel([]) } }, '清空'),
      cur ? h(DfBtn, { size: 'sm', kind: 'ghost', onClick: function () { setSel([cur]) } }, '仅当前') : null),

    shown.length
      ? h('div', { className: 'df-vlist' }, shown.map(function (m) {
        const on = sel.indexOf(m.id) >= 0
        return h('label', {
          key: m.id,
          className: dfCx('df-check', on && 'is-on'),
          style: { border: '1px solid var(--df-line)' },
        },
          h('input', { type: 'checkbox', checked: on, onChange: function () { toggle(m.id) } }),
          h('span', null, h('b', null, dfModeTitle(m)),
            m.id === cur ? h('small', { style: { marginLeft: 6, opacity: 0.7 } }, '当前模式') : null,
            m.description ? h('small', { style: { display: 'block', opacity: 0.72 } }, m.description) : null))
      }))
      : h(DfEmpty, { icon: 'layers', title: '没有匹配的模式', hint: '换个关键词试试。' }),

    h('div', { className: 'df-formfoot' },
      h('span', { className: 'df-ops-meta' }, '已选 ' + dfNum(sel.length) + ' / ' + dfNum(modes.length) + ' 个模式'),
      h('span', { className: 'df-spacer' }),
      h(DfBtn, { size: 'sm', kind: 'ghost', disabled: !!busy, onClick: props.onClose }, '取消'),
      h(DfBtn, { size: 'sm', kind: 'primary', icon: 'check', disabled: !!busy, onClick: save },
        busy ? '保存中…' : '保存范围')))
}

/* 破甲注入：模板、范围、开关、编辑、恢复默认。 */
function DfMainInject(props) {
  const state = dfUseAsync(function () {
    return dfHost('/dsh-forge/inject')
  }, [props.tick])
  const [busy, setBusy] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(function () {
    if (!confirmReset) return undefined
    const t = window.setTimeout(function () { setConfirmReset(false) }, 5000)
    return function () { window.clearTimeout(t) }
  }, [confirmReset])
  useEffect(function () {
    if (!confirmDelete) return undefined
    const t = window.setTimeout(function () { setConfirmDelete(false) }, 5000)
    return function () { window.clearTimeout(t) }
  }, [confirmDelete])

  const d = state.data || {}
  const templates = Array.isArray(d.templates) ? d.templates : []
  const modes = Array.isArray(d.modes) && d.modes.length
    ? d.modes
    : [{ id: 'redteam', name: '红队' }, { id: 'crack', name: '破解' }]
  const scopes = Array.isArray(d.scopes) ? d.scopes : []
  const enabled = d.enabled !== false
  /* 核心补丁没写进宿主时，开关先置灰：先能破甲，再谈开关。关闭操作始终可用。 */
  const patch = d.patch_state || null
  const coreReady = patch ? patch.core_complete === true : true
  const coreFailed = patch ? Number(patch.core_failed) || 0 : 0
  const corePending = patch ? Number(patch.core_pending) || 0 : 0
  const coreDisabled = !!(patch && patch.reason === 'core-disabled')
  const hostReset = !!(patch && patch.reason === 'host-reset')
  const coreBlocked = !enabled && !coreReady
  const content = String(d.content || '')
  const template = String(d.template || '')
  const current = templates.find(function (t) { return t.id === template })
  const currentName = template === 'custom'
    ? '自定义'
    : (current ? current.name : (template || '—'))
  const scopeNames = scopes.map(function (id) {
    const hit = modes.find(function (m) { return m.id === id })
    return hit ? dfModeTitle(hit) : dfModeLabel(id)
  })
  const currentMode = dfCurrentAgentPreset()
  const currentHit = modes.find(function (m) { return m.id === currentMode })
  const currentModeName = currentHit ? dfModeTitle(currentHit) : dfModeLabel(currentMode)
  const currentCovered = dfScopeCovered(currentMode, scopes)
  const currentStock = dfStockMode(currentMode)
  const builtin = template === 'minimal' || template === 'redteam'
  const canDelete = !builtin && template !== 'custom' && !!current

  function post(action, extra) {
    if (busy) return Promise.resolve(null)
    setBusy(action)
    return dfHostPost('/dsh-forge/inject', Object.assign({ action: action }, extra || {})).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) {
        dfToast((r && r.error) || '操作失败', 'err', 4600)
        return r
      }
      if (props.onChanged) props.onChanged()
      dfBust()
      return r
    }, function (e) {
      setBusy('')
      dfToast(String(e && e.message ? e.message : e), 'err', 4600)
      return null
    })
  }

  function applyTemplate(id) {
    if (!id || busy) return
    post('applyTemplate', { id: id }).then(function (r) {
      if (r && r.ok !== false) dfToast('已切换模板，下一轮生效', 'ok', 2200)
    })
  }

  function openScopes() {
    if (!props.onInspect) return
    props.onInspect({
      title: '破甲注入生效范围',
      sub: '已选 ' + dfNum(scopes.length) + ' / ' + dfNum(modes.length) + ' 个模式',
      node: h(DfScopePicker, {
        modes: modes,
        scopes: scopes,
        current: dfCurrentAgentPreset(),
        onClose: props.onCloseDrawer,
        onSaved: function () {
          if (props.onChanged) props.onChanged()
          dfBust()
        },
      }),
    })
  }

  function openEditor() {
    if (!props.onInspect) return
    props.onInspect({
      mode: 'page',
      maximize: true,
      title: '编辑破甲注入',
      sub: currentName + ' · ' + dfNum(content.length) + ' 字符',
      rows: [
        ['模板', currentName],
        ['生效', enabled ? (scopeNames.join('、') || '未选择模式') : '已关闭'],
        ['大小', dfNum(content.length) + ' 字符 · 约 ' + dfNum(Math.ceil(content.length / 2)) + ' Token'],
      ],
      node: h(DfOperatorEditor, {
        content: content,
        onSave: function (text) {
          return dfHostPost('/dsh-forge/inject', { action: 'saveContent', content: text })
        },
        onDone: function () { if (props.onChanged) props.onChanged(); dfBust() },
      }),
    })
  }

  function openSaver() {
    if (!props.onInspect) return
    props.onInspect({
      title: '另存为模板',
      sub: '只保存破甲注入内容',
      node: h(DfTemplateSaver, {
        content: content,
        onDone: function (r) {
          const saved = r && r.saved
          if (saved && saved.id) applyTemplate(saved.id)
          else if (props.onChanged) props.onChanged()
          if (props.onCloseDrawer) props.onCloseDrawer()
        },
      }),
    })
  }

  function reset() {
    if (!confirmReset) { setConfirmReset(true); return }
    post('reset').then(function (r) {
      if (r && r.ok !== false) {
        setConfirmReset(false)
        dfToast('已恢复最简破甲', 'ok', 2600)
      }
    })
  }

  function removeTemplate() {
    if (!confirmDelete) { setConfirmDelete(true); return }
    post('deleteTemplate', { id: template }).then(function (r) {
      if (r && r.ok !== false) {
        setConfirmDelete(false)
        dfToast('模板已删除', 'ok', 2000)
      }
    })
  }

  if (state.loading && !state.data) {
    return h(DfCard, { title: '破甲注入', icon: 'prompt', sub: '读取中' },
      h(DfSkeleton, { lines: 4 }))
  }
  if (state.error || d.ok === false) {
    return h(DfCard, { title: '破甲注入', icon: 'prompt' },
      h(DfOpsError, { title: '读取破甲注入失败', error: state.error || d.error, onRetry: state.reload }))
  }

  return h(DfCard, {
    title: '破甲注入', icon: 'prompt',
    sub: '唯一的破甲开关（顶栏只显示状态）+ 模板 + 范围',
  },
    h('div', { className: 'df-inject-hero' + (enabled ? ' is-on' : '') },
      h('div', { className: 'df-ih-main' },
        h('b', null, enabled ? '破甲注入已开启' : '破甲注入已关闭'),
        h('span', null, '当前模式：' + currentModeName + ' · ' + (
          enabled
            ? (currentCovered ? (content.trim() ? '已生效' : '正文为空，未生效') : '当前模式未在范围，未生效')
            : '总开关关闭，未生效'))),
      h(DfBtn, {
        kind: enabled ? 'danger' : 'primary', icon: enabled ? 'pause' : 'check',
        disabled: !!busy || coreBlocked,
        title: coreBlocked
          ? (coreDisabled
            ? '核心补丁已停用；重新启用并写入宿主后可用'
            : hostReset
              ? '宿主更新后核心补丁已丢失；重新写入后可用'
            : '核心补丁未写入宿主：' + (coreFailed > 0
              ? coreFailed + ' 条失败'
              : (corePending > 0 ? corePending + ' 条待写入' : '尚未写入')) + '，先去维护页写入')
          : null,
        onClick: function () {
          if (coreBlocked) {
            dfToast(coreDisabled
              ? '核心补丁已停用，破甲开关暂不可用；先到维护页重新启用'
              : hostReset
                ? '宿主更新后核心补丁已丢失；先到维护页重新写入'
                : '核心补丁未写入宿主，破甲开关暂不可用；先到维护页写入', 'err', 4200)
            if (props.onGoto) props.onGoto('maintenance')
            return
          }
          post('setEnabled', { enabled: !enabled })
        },
      }, busy ? '处理中…' : (enabled ? '关闭破甲注入' : (coreBlocked
        ? (coreDisabled ? '核心补丁已停用' : (hostReset ? '核心补丁已丢失' : '核心补丁未写入'))
        : '开启破甲注入')))),
    coreBlocked
      ? h('div', {
        className: 'df-note df-note--warn',
        style: { marginBottom: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      },
        h('span', { style: { flex: '1 1 220px' } },
          coreDisabled
            ? '核心补丁被停用，破甲开关暂不可用。到「配置 → 维护」重新启用核心补丁并写入宿主。'
            : hostReset
              ? '宿主更新/重置冲掉了核心补丁，破甲开关暂不可用。到「配置 → 维护 → 写入宿主」重新写入。'
              : '核心补丁还没写进宿主，破甲开关暂不可用。到「配置 → 维护 → 写入宿主」写入后再开启。'),
        props.onGoto
          ? h(DfBtn, {
            size: 'sm', kind: 'primary', icon: 'wrench',
            onClick: function () { props.onGoto('maintenance') },
          }, '去写入宿主')
          : null)
      : null,
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 } },
      h('span', { className: 'df-label' }, '模板'),
      h('select', {
        className: 'df-select', value: template === 'custom' ? '' : template,
        disabled: !!busy,
        style: { width: 220 },
        onChange: function (e) { applyTemplate(e.target.value) },
      },
        template === 'custom' ? h('option', { value: '' }, '自定义（未保存为模板）') : null,
        templates.map(function (t) {
          return h('option', { key: t.id, value: t.id },
            t.name + (t.builtin ? '' : ' · 自定义'))
        })),
      canDelete ? h(DfBtn, {
        size: 'sm', kind: confirmDelete ? 'danger' : 'ghost', icon: 'trash', disabled: !!busy,
        onClick: removeTemplate,
        onBlur: function () { setConfirmDelete(false) },
      }, busy === 'deleteTemplate' ? '删除中…' : (confirmDelete ? '确认删除模板' : '删除模板')) : null),

    h('div', { className: 'df-note', style: { marginBottom: 8 } },
      '当前模式：' + currentModeName + ' · ' + (
        currentCovered
          ? (enabled ? (content.trim() ? '已生效' : '正文为空，未生效') : '总开关关闭，未生效')
          : currentStock
            ? '原厂模式，不注入。要启用破甲，请在 DeepSeek Harness 的模式菜单切到红队/破解模式，再新建任务（切换预设只影响新任务）。'
            : '未加入生效范围，点「管理」加入。')),

    h('div', { className: 'df-scope-line' },
      h('div', { className: 'df-scope-main' },
        h('span', { className: 'df-label' }, '生效范围'),
        scopeNames.length
          ? h('div', { className: 'df-scope-chips' },
            scopeNames.slice(0, 4).map(function (name) {
              return h(DfChip, { key: name, kind: 'line' }, name)
            }),
            scopeNames.length > 4
              ? h(DfChip, { key: 'more', kind: 'line' }, '+' + dfNum(scopeNames.length - 4))
              : null)
          : h('span', { className: 'df-hint' }, '未选择模式，破甲注入不会生效')),
      h(DfBtn, {
        size: 'sm', kind: 'ghost', icon: 'sliders', disabled: !!busy,
        onClick: openScopes,
      }, '管理')),

    h('div', { className: 'df-note' }, '没勾的模式保持 DeepSeek Harness 原生人格；改动下一轮生效。'),
    content
      ? h('pre', { className: 'df-evi', style: { whiteSpace: 'pre-wrap', marginTop: 8, maxHeight: 150, overflow: 'auto' } }, dfCtxPreview(content))
      : h(DfEmpty, { icon: 'prompt', title: '破甲注入是空的', hint: '点“编辑”写一份，或恢复默认。' }),

    h(DfInjectSelfCheck, { content: content, tick: props.tick }),

    h('div', { className: 'df-formfoot' },
      h('span', { className: 'df-ops-meta' }, dfNum(content.length) + ' 字符 · 模板：' + currentName),
      h('span', { className: 'df-spacer' }),
      h(DfBtn, { size: 'sm', kind: 'primary', icon: 'prompt', disabled: !!busy, onClick: openEditor }, '编辑'),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'fileText', disabled: !!busy, onClick: openSaver }, '存为模板'),
      h(DfBtn, {
        size: 'sm', kind: confirmReset ? 'danger' : 'ghost', icon: 'restore', disabled: !!busy,
        onClick: reset, onBlur: function () { setConfirmReset(false) },
      }, busy === 'reset' ? '恢复中…' : (confirmReset ? '确认恢复最简' : '恢复默认'))))
}

/** 破甲自检：拿宿主内存里的实际组装，检查注入正文是否真的进了 system prompt。 */
function DfInjectSelfCheck(props) {
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState(null)

  function check() {
    if (busy) return
    setBusy(true)
    dfHost('/dsh-forge/assembled').then(function (r) {
      setBusy(false)
      if (!r || r.ok === false) {
        setRes({ state: 'error', msg: (r && r.error) || '读不到实际组装' })
        return
      }
      if (r.empty) {
        setRes({ state: 'empty', msg: '还没有捕获到组装结果；先在当前会话发一条消息，再点「重新检查」。' })
        return
      }
      const secs = Array.isArray(r.sections) ? r.sections : []
      const preview = dfCtxPreview(String(props.content || ''))
      const probes = preview.split('\n').map(function (x) { return x.trim() })
        .filter(function (x) { return x.length >= 8 }).slice(0, 3)
      let hit = null
      for (let i = 0; i < secs.length && !hit; i += 1) {
        const text = String(secs[i].text || '')
        if (probes.some(function (p) { return text.includes(p) })) hit = secs[i]
      }
      if (hit) {
        setRes({ state: 'ok', msg: '已确认：注入正文已进入本次 system prompt。', section: hit.name, mode: r.mode, at: r.at })
      } else {
        setRes({
          state: 'miss',
          msg: '本次组装里没有找到注入正文。当前会话可能不是红队/破解模式，或改动后还没发新消息。',
          mode: r.mode,
          sections: secs.map(function (s) { return s.name }).slice(0, 8),
        })
      }
    }, function (e) {
      setBusy(false)
      setRes({ state: 'error', msg: String((e && e.message) || e) })
    })
  }

  useEffect(function () { check() }, [props.tick])

  const meta = !res ? ['未检查', 'line']
    : res.state === 'ok' ? ['已确认注入', 'ok']
      : res.state === 'empty' ? ['还没发消息', 'warn']
        : res.state === 'miss' ? ['未注入', 'err']
          : ['检查失败', 'err']

  return h('section', { className: 'df-detail-sec' },
    h('div', { className: 'df-detail-hd' },
      h('h4', null, '破甲自检'),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', disabled: busy, onClick: check },
        busy ? '检查中…' : '重新检查')),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
      h(DfChip, { kind: meta[1], dot: true }, meta[0]),
      res && res.mode ? h('span', { className: 'df-hint' }, '组装模式：' + dfModeTitle(res.mode)) : null),
    h('div', { className: 'df-note' }, res ? res.msg : '用宿主实际组装核对，不靠猜。'),
    res && res.section ? h('div', { className: 'df-note' }, '命中段：' + res.section) : null,
    res && res.sections ? h('div', { className: 'df-note' }, '本次段名：' + res.sections.join(' / ')) : null,
    h('div', { className: 'df-note' },
      '“已确认注入”只说明注入正文进了 system prompt；模型是否按破甲风格回答，还要在会话里实际提问验证。改动后先发一条消息，再检查。'))
}

/** 破甲注入独立页：开关、模板、范围、正文都在这里，避免和提示词页混在一起。 */
function DfInjectPage(props) {
  const [tick, setTick] = useState(0)
  function bump() {
    setTick(function (t) { return t + 1 })
    if (props.onChanged) props.onChanged()
  }
  return h('div', { className: 'df-ops' },
    h('div', { className: 'df-opsbar' },
      h('span', { className: 'df-ops-title' }, '破甲注入'),
      h('span', { className: 'df-ops-meta' }, '决定模型是否按授权边界工作'),
      h('span', { className: 'df-spacer' }),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', onClick: bump }, '刷新')),

    h(DfMainInject, {
      tick: tick + props.tick,
      onChanged: bump,
      onInspect: props.onInspect,
      onCloseDrawer: props.onCloseDrawer,
      onGoto: props.onGoto,
    }),

    h(DfCard, { title: '怎么判断是否生效', icon: 'info',
      actions: props.onGoto
        ? h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'users', onClick: function () { props.onGoto('agents') } }, '去智能体层')
        : null,
    },
      h('div', { className: 'df-note' },
        '当前模式已注入时，顶栏「破甲注入」圆点是绿色；没生效是红色，读取中是黄色。'),
      h('div', { className: 'df-note', style: { marginTop: 6 } },
        '破甲注入只负责“能不能做 + 输出纪律”；主智能体人格、子智能体提示词在左侧对应层按模式管理。')))
}

/* 工作区指令：dsh 原生 AGENTS.md / CLAUDE.md 链，外加写入用户级 AGENTS.md 的规则片段。
   原来「提示词」页里的破甲注入、角色稿、技能、身份都只是跳转卡片，已全部移除；
   同一个功能只保留一个入口。 */
function dfInstructionTitle(f) {
  const name = f.name || 'AGENTS.md'
  if (f.scope === 'user-global') return '用户级 ' + name
  if (f.scope === 'agents-global') return '共享级 ' + name
  if (f.scope === 'root') return '项目根 ' + name
  if (f.scope === 'cwd') return '当前目录 ' + name
  return '上级目录 ' + name
}

function dfInstructionWhere(f) {
  if (f.scope === 'user-global') return '所有项目都生效'
  if (f.scope === 'agents-global') return '~/.agents 共享给所有项目'
  if (f.scope === 'root') return '项目根目录'
  if (f.scope === 'cwd') return '当前工作目录'
  return '当前目录的上级'
}

/* 工作区指令的真实加载顺序；序号是 5 级中的位置，缺哪一级就跳号，不重排。 */
const DF_INSTRUCTION_TIERS = {
  'user-global': { no: '1/5', label: '用户级', where: '$DSH_HOME/AGENTS.md · 所有项目' },
  'agents-global': { no: '2/5', label: '共享级', where: '~/.agents/AGENTS.md · 所有项目' },
  'root': { no: '3/5', label: '项目根', where: '项目根目录' },
  'ancestor': { no: '4/5', label: '上级目录', where: '项目根到当前目录之间' },
  'cwd': { no: '5/5', label: '当前目录', where: '当前工作目录' },
}

function dfInstructionTier(f) {
  return DF_INSTRUCTION_TIERS[f.scope] || DF_INSTRUCTION_TIERS.ancestor
}

function DfInstructionsPage(props) {
  const [tick, setTick] = useState(0)
  const insState = dfUseAsync(function () {
    return dfHost('/dsh-forge/instructions')
  }, [props.tick, tick])

  const ins = insState.data || {}
  const files = Array.isArray(ins.files) ? ins.files : []
  const existing = files.filter(function (f) { return f.exists })

  /* 按真实加载顺序分组；同组内保留服务端给的候选文件顺序。 */
  const groups = []
  const byScope = {}
  files.forEach(function (f) {
    let g = byScope[f.scope]
    if (!g) {
      g = { key: f.scope, tier: dfInstructionTier(f), rows: [] }
      byScope[f.scope] = g
      groups.push(g)
    }
    g.rows.push(f)
  })

  function bump() { setTick(function (t) { return t + 1 }) }

  function openInstruction(f) {
    if (!props.onInspect) return
    props.onInspect({
      mode: 'page',
      maximize: true,
      title: dfInstructionTitle(f),
      sub: dfInstructionWhere(f) + ' · ' + (f.exists ? dfBytes(f.size) : '未创建'),
      rows: [
        ['位置', dfInstructionWhere(f)],
        ['路径', f.path],
        ['生效', '下一轮生效 · 合并成一条 user 角色基线消息'],
      ],
      node: h(DfInstructionEditor, {
        file: f,
        onSaved: function (r) {
          if (r && Number.isFinite(r.size)) f.size = r.size
          f.exists = true
          bump()
          openInstruction(f)
        },
      }),
    })
  }

  return h('div', { className: 'df-ops' },
    h('div', { className: 'df-opsbar' },
      h('span', { className: 'df-ops-title' }, '工作区指令'),
      h('span', { className: 'df-ops-meta' }, 'AGENTS.md · 用户级 → 共享级 → 项目根 → 当前目录'),
      h('span', { className: 'df-spacer' }),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', onClick: bump }, '刷新')),

    h(DfPromptLayers, {
      focus: ['workspace'],
      onGoto: props.onGoto,
      note: '本页管第 2 层；这些文件不是 agent，只是工作区指令。',
    }),

    h('div', { className: 'df-kpis' },
      h(DfKpi, {
        label: '已创建文件', icon: 'list',
        value: dfNum(existing.length),
        foot: '5 级中已列出 ' + dfNum(files.length) + ' 个位置',
      }),
      h(DfKpi, {
        label: '已写入', icon: 'fileText',
        value: ins.totalBytes ? dfBytes(ins.totalBytes) : '0 B',
        foot: ins.budgetBytes ? '预算 ' + dfBytes(ins.budgetBytes) : '总预算 64 KB',
      })),

    h(DfCard, {
      title: 'DeepSeek Harness 会读取的文件', icon: 'list',
      sub: ins.cwd ? '当前工作目录：' + ins.cwd : '还没有工作目录',
    },
      h('div', { className: 'df-note' },
        '从宽泛到具体合并成一条 user 角色基线消息；总预算 64KB，超出先截断宽泛段。'),
      insState.loading && !insState.data
        ? h(DfSkeleton, { lines: 3 })
        : insState.error || ins.ok === false
          ? h(DfOpsError, { title: '读取工作区指令失败', error: insState.error || ins.error, onRetry: insState.reload })
          : groups.length
            ? h('div', { className: 'df-tierlist' }, groups.map(function (g) {
              return h('div', { key: g.key, className: 'df-tiergroup' },
                h('div', { className: 'df-tierhd' },
                  h('span', { className: 'df-tierno' }, g.tier.no),
                  h('span', { className: 'df-tiert' }, g.tier.label),
                  h('span', { className: 'df-tierw' }, g.tier.where),
                  h('span', { className: 'df-tiern' }, dfNum(g.rows.length) + ' 个文件')),
                h('div', { className: 'df-vlist df-vlist--flat' }, g.rows.map(function (f) {
                  return h('button', {
                    key: f.path, type: 'button', className: 'df-vrow df-vrow--info',
                    onClick: function () { openInstruction(f) },
                  },
                    h('span', { className: 'df-vrow-rail' }),
                    h('span', { className: 'df-vrow-main' },
                      h('span', { className: 'df-vrow-hd' },
                        h('span', { className: 'df-vrow-t' }, dfInstructionTitle(f)),
                        h(DfChip, { kind: f.exists ? 'line' : 'warn' }, f.exists ? '已创建' : '未创建'),
                        h('span', { className: 'df-chip df-chip--line' }, dfBytes(f.size || 0))),
                      h('span', { className: 'df-vrow-m' },
                        h('span', { className: 'df-vrow-ip' }, dfInstructionWhere(f)),
                        h('span', { className: 'df-vrow-sep' }, '·'),
                        h('span', { className: 'df-vrow-url' }, f.path))),
                    h('span', { className: 'df-vrow-right' }, h('span', { className: 'df-vrow-go' }, '›')))
                })))
            }))
            : h(DfEmpty, { icon: 'list', title: '还没有工作区指令', hint: '用户级 AGENTS.md 可以在这里新建。' })),

    h('div', { className: 'df-note', style: { marginTop: 14 } },
      '规则片段是预置的一段约束，点「写入 AGENTS.md」会整段覆盖用户级 AGENTS.md（自动备份）。'
      + '已经手改过用户级文件时，先在上面编辑或先备份，不要直接覆盖。'),
    h(DfRulesPanel, {
      tick: props.tick + tick,
      onInspect: props.onInspect,
      onCloseDrawer: props.onCloseDrawer,
      onChanged: bump,
    }))
}



/* ---- lib/client/36-prompts.js ---- */
/* 提示词工作台：把破甲注入 / 智能体 / 工作区指令 / 实际提示词收成一个 master-detail。
   页面结构变了，业务仍由原来的四个组件负责；这里只做导航和外壳，不复制 API 逻辑。 */

const DF_PROMPT_WORK_LAYERS = [
  {
    id: 'inject', label: '破甲注入', icon: 'shield',
    meta: '下一轮 · 正文 / 模板 / 范围',
  },
  {
    id: 'persona', label: '主智能体人格', icon: 'target',
    meta: '重启后 · 模式级',
  },
  {
    id: 'roles', label: '子智能体角色稿', icon: 'users',
    meta: '角色稿 · 红队下一轮 / 破解派发时',
  },
  {
    id: 'instructions', label: '工作区指令', icon: 'list',
    meta: '下一轮 · 5 级 AGENTS.md 链',
  },
  {
    id: 'context', label: '红队实际提示词', icon: 'layers',
    meta: '只读 · 红队会话组装结果',
  },
  {
    id: 'context-crack', label: '破解实际提示词', icon: 'layers',
    meta: '只读 · 破解会话组装结果',
  },
]

/* 顶部六格按编辑链路排：注入 → 人格 → 角色稿 → 工作区指令 → 红队 / 破解快照。
   每格的小字自己带生效时机；下面的本层摘要只描述该层真实口径，不复制编辑控件。 */
const DF_PROMPT_LAYER_INFO = {
  inject: {
    when: '下一轮', tone: 'live', scope: '勾选的模式',
    store: 'prompt-inject.md',
    how: '正文、模板、范围保存后下一轮生效；总开关只切启停，不需要重启。',
  },
  persona: {
    when: '重启后', tone: 'restart', scope: '模式级',
    store: '预设文件',
    how: '宿主启动时读取人格；改完需要重启 DeepSeek Harness。',
  },
  roles: {
    when: '派发时', tone: 'spawn', scope: '红队按靶标 · 破解按模式',
    store: '角色稿文件',
    how: '红队角色稿下一轮生效；破解角色稿派发时读取，已派发的会话不受影响。',
  },
  instructions: {
    when: '下一轮', tone: 'live', scope: '工作区',
    store: 'AGENTS.md · 5 级文件链',
    how: '用户级 → 共享级 → 项目根 → 上级目录 → 当前目录，按顺序合并；保存后下一轮生效。',
  },
  context: {
    when: '只读', tone: 'read', scope: '红队会话',
    store: '宿主内存 · 重启清空',
    how: '最近一次实际组装的分段、工具与运行时上下文；不能在面板里改。',
  },
  'context-crack': {
    when: '只读', tone: 'read', scope: '破解会话',
    store: '宿主内存 · 重启清空',
    how: '最近一次实际组装的分段、工具与运行时上下文；不能在面板里改。',
  },
}

function DfPromptWorkbench(props) {
  const [tick, setTick] = useState(0)
  const layer = props.layer || 'inject'
  const injectState = dfUseAsync(function () {
    return dfHost('/dsh-forge/inject')
  }, [props.tick, tick])
  const st = injectState.data || {}
  const injectOn = st.ok !== false && st.enabled === true

  function bump() { setTick(function (n) { return n + 1 }) }

  function go(id) {
    if (DF_PROMPT_WORK_LAYERS.some(function (l) { return l.id === id })) {
      if (props.onLayer) props.onLayer(id)
      return
    }
    if (props.onGoto) props.onGoto(id)
  }

  function metaFor(id) {
    if (id === 'inject') return injectOn ? '已开启 · 下一轮' : '未开启 · 点此检查'
    return (DF_PROMPT_WORK_LAYERS.find(function (l) { return l.id === id }) || {}).meta || ''
  }

  function dotFor(id) {
    if (id === 'inject') return injectOn ? 'is-ok' : 'is-err'
    if (id === 'context' || id === 'context-crack') return 'is-info'
    if (id === 'persona') return 'is-warn'
    return 'is-warn'
  }

  const common = {
    tick: props.tick + tick,
    onInspect: props.onInspect,
    onCloseDrawer: props.onCloseDrawer,
    onGoto: go,
    onChanged: function () { injectState.reload() },
  }

  let detail = null
  if (layer === 'persona' || layer === 'roles') {
    detail = h(DfAgents, Object.assign({ key: 'prompt-' + layer, focus: layer }, common, { eng: props.eng }))
  } else if (layer === 'instructions') {
    detail = h(DfInstructionsPage, Object.assign({ key: 'prompt-instructions' }, common))
  } else if (layer === 'context' || layer === 'context-crack') {
    detail = h(DfContextMode, Object.assign(
      { key: 'prompt-' + layer, mode: layer === 'context-crack' ? 'crack' : 'redteam' }, common))
  } else {
    detail = h(DfInjectPage, Object.assign({ key: 'prompt-inject' }, common))
  }

  return h('div', { className: 'df-ops df-prompt-workbench-wrap' },
    h('div', { className: 'df-opsbar' },
      h('span', { className: 'df-ops-title' }, '提示词'),
      h('span', { className: 'df-ops-meta' }, '一处编辑 · 下一轮 / 重启 / 派发时三种生效口径'),
      h('span', { className: 'df-spacer' }),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', onClick: bump }, '刷新')),

    h('div', { className: 'df-prompt-workbench' },
      h('aside', { className: 'df-prompt-nav', 'aria-label': '提示词层' },
        h('div', { className: 'df-prompt-navhd' }, '提示词层'),
        h('div', { className: 'df-prompt-items' }, DF_PROMPT_WORK_LAYERS.map(function (l) {
          return h('button', {
            key: l.id,
            type: 'button',
            className: dfCx('df-prompt-item', layer === l.id && 'on'),
            'aria-current': layer === l.id ? 'true' : undefined,
            onClick: function () { if (props.onLayer) props.onLayer(l.id) },
          },
            h('span', { className: 'df-prompt-ico' }, dfIcon(l.icon, 14)),
            h('span', { className: 'df-prompt-copy' },
              h('strong', null, l.label),
              h('small', null, metaFor(l.id))),
            h('i', { className: dfCx('df-prompt-dot', dotFor(l.id)) }))
        })),
        (function () {
          const info = DF_PROMPT_LAYER_INFO[layer] || DF_PROMPT_LAYER_INFO.inject
          return h('div', { className: 'df-prompt-side' },
            h('div', { className: 'df-prompt-sidehd' },
              h('span', null, '本层摘要'),
              h('span', { className: 'df-prompt-when is-' + info.tone }, info.when)),
            h('div', { className: 'df-prompt-srow' }, h('b', null, '作用域'), h('span', null, info.scope)),
            h('div', { className: 'df-prompt-srow' }, h('b', null, '存储'), h('span', null, info.store)),
            h('div', { className: 'df-prompt-show' }, info.how))
        })(),
        h('div', { className: 'df-prompt-foot' },
          '保存后按各自时机生效；实际提示词只读，编辑入口在对应层。')),

      h('div', { className: 'df-prompt-detail', 'data-layer': layer }, detail)),

    h('div', { className: 'df-note df-prompt-note' },
      '工作台只收拢入口，不复制 API：破甲注入仍走 /dsh-forge/inject，智能体仍走预设 / 角色稿接口，工作区指令仍是 AGENTS.md 文件链。'))
}



/* ---- lib/client/37-maintain.js ---- */
/* 维护页（P4）：宿主补丁 / 钩子 / 更新。
   规则片段已经并入「工作区指令」页，避免同一个 AGENTS.md 有两个入口。
   数据来自宿主的 /dsh-forge/* 接口（core / rules / update 同一份实现），
   这里只负责取数、分组和展示；应用补丁之类的动作一律转发给宿主。 */

const DF_PATCH_STATUS = {
  applied: {
    label: '已应用', kind: 'ok',
    hint: '这条补丁已经写进当前宿主。',
    next: '按「何时生效」判断是下一轮对话生效，还是要重启客户端。',
  },
  pending: {
    label: '待应用', kind: 'warn',
    hint: '宿主里还是官方原文，这条补丁尚未写入。',
    next: '点「写入宿主」处理；写入成功后会变成「已应用」。',
  },
  skipped: {
    label: '已跳过', kind: 'line',
    hint: '宿主文件里找不到这条补丁要改的原文，或该段本来就不存在。',
    next: '这不是失败，通常不需要处理；可选补丁和版本/布局差异会显示为已跳过。',
  },
  ready: {
    label: '可应用', kind: 'info',
    hint: '当前宿主可以写入这条补丁。',
    next: '点「写入宿主」即可。',
  },
  na: {
    label: '不适用', kind: 'line',
    hint: '当前宿主类型或平台不需要这条补丁。',
    next: '不需要处理，也不计入失败。',
  },
  unbound: {
    label: '未绑定宿主', kind: 'line',
    hint: '还没有定位到 DeepSeek Harness 宿主目录。',
    next: '点「写入宿主」绑定宿主后再看状态。',
  },
  dep: {
    label: '未安装依赖', kind: 'line',
    hint: '这条补丁依赖额外的插件或预设，当前环境没有安装。',
    next: '装上对应依赖后才会出现开关；现在不会写入，也不计入失败。',
  },
  failed: {
    label: '失败', kind: 'err',
    hint: '写入过程中出错。',
    next: '先重试；仍然失败再点「还原全部」，或查看宿主日志。',
  },
  pattern_not_found: {
    label: '未匹配', kind: 'err',
    hint: '严格补丁的目标原文没有对上，通常是宿主版本变了。',
    next: '重新写入；仍然失败说明当前宿主版本和这条补丁不兼容。',
  },
  unmatched: {
    label: '未匹配', kind: 'err',
    hint: '严格补丁的目标原文没有对上，通常是宿主版本变了。',
    next: '重新写入；仍然失败说明当前宿主版本和这条补丁不兼容。',
  },
  missing_file: {
    label: '文件缺失', kind: 'line',
    hint: '补丁要修改的宿主文件不存在。',
    next: '可选补丁会跳过；非可选说明宿主安装不完整。',
  },
  off: {
    label: '已关闭', kind: 'line',
    hint: '这条补丁被停用，不会写入宿主。',
    next: '重新启用后再点「写入宿主」。',
  },
}

function dfPatchMeta(status) {
  return DF_PATCH_STATUS[status] || { label: dfDash(status), kind: 'line', hint: '', next: '' }
}

function dfPatchStatusIcon(status) {
  if (status === 'applied' || status === 'ready') return 'check'
  if (status === 'pending') return 'clock'
  if (status === 'failed' || status === 'pattern_not_found'
    || status === 'unmatched' || status === 'missing_file') return 'alert'
  return 'info'
}

/* 补丁标签：服务端只发标签名，这里统一给颜色和说明。
   核心排第一，列表里也按“核心优先”排序。 */
const DF_PATCH_TAG_ORDER = ['核心', '提示词', '权限', '工具', '稳定', '兼容', '预设', '可选', '桌面']

const DF_PATCH_TAGS = {
  核心: { tone: 'core', hint: '破甲链路必需；全部启用并写入后破甲开关才可用' },
  提示词: { tone: 'info', hint: '改系统提示、身份句或注入位置' },
  权限: { tone: 'warn', hint: '改审批、拒绝、hook 拦截等权限行为' },
  工具: { tone: 'ok', hint: '改 read / bash / 网页抓取等工具能力' },
  稳定: { tone: 'line', hint: '修崩溃、竞态、兜底和重启异常' },
  兼容: { tone: 'line', hint: '适配旧版本、第三方代理或官方更新' },
  预设: { tone: 'line', hint: '只对某个内置/自建预设生效' },
  可选: { tone: 'line', hint: '依赖额外插件或预设；没装时不会生效' },
  桌面: { tone: 'line', hint: '只对桌面客户端生效' },
}

function DfPatchTag(props) {
  const meta = DF_PATCH_TAGS[props.tag] || { tone: 'line', hint: '' }
  return h('span', {
    className: 'df-ptag df-ptag--' + meta.tone,
    title: meta.hint,
  }, props.tag)
}

/* 列表和抽屉都要显示补丁编号：同一组（例如 1/2/3）合并成一行，
   编号写成 #1–3，方便对照审计清单；不连续时逐个列出。 */
function dfPatchIdsLabel(r) {
  const ids = (Array.isArray(r.ids) && r.ids.length ? r.ids : [r.id])
    .map(Number).sort(function (a, b) { return a - b })
  if (ids.length <= 1) return '#' + ids[0]
  const contiguous = ids.every(function (id, i) { return i === 0 || id === ids[i - 1] + 1 })
  return '#' + (contiguous ? ids[0] + '–' + ids[ids.length - 1] : ids.join(','))
}

/* ---------------------------------------------------------------- 补丁 */

function DfPatchPanel(props) {
  const [tag, setTag] = useState('')
  const [status, setStatus] = useState('')
  const [onlyOff, setOnlyOff] = useState(false)
  const [tech, setTech] = useState(false)
  const [busy, setBusy] = useState('')
  const [presetBusy, setPresetBusy] = useState('')
  const [schemeBusy, setSchemeBusy] = useState('')
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveId, setSaveId] = useState('')
  const [saveName, setSaveName] = useState('')
  const [saveBusy, setSaveBusy] = useState(false)
  const [prefBusy, setPrefBusy] = useState(0)
  const [confirmOff, setConfirmOff] = useState(0)
  const [confirmRevert, setConfirmRevert] = useState(false)
  const [confirmApply, setConfirmApply] = useState(false)

  /* 「写入宿主」会改宿主源码，二次确认；8 秒不点自动收回。 */
  useEffect(function () {
    if (!confirmApply) return undefined
    const t = window.setTimeout(function () { setConfirmApply(false) }, 8000)
    return function () { window.clearTimeout(t) }
  }, [confirmApply])

  /* 「确认还原」只停留 5 秒：不点就自动回到普通按钮，避免误触后一直挂着。 */
  useEffect(function () {
    if (!confirmRevert) return undefined
    const t = window.setTimeout(function () { setConfirmRevert(false) }, 5000)
    return function () { window.clearTimeout(t) }
  }, [confirmRevert])

  const state = dfUseAsync(function () {
    return dfHost('/dsh-forge/status')
  }, [props.tick])

  if (state.loading && !state.data) {
    /* 读宿主状态要扫安装目录，首次 5–10 秒。
       不先摆骨架再换字 —— 那等于在 1.2 秒时又换一次屏，看得见地跳一下。
       开屏就是这一句，只有一个状态，到点直接换成真内容。 */
    return h('div', { className: 'df-wait' },
      h('div', { className: 'df-wait-badge' }, dfIcon('wrench', 16)),
      h('p', null, '正在读取宿主补丁状态…'),
      h('span', null, '首次要扫描安装目录，通常需要 5–10 秒。'))
  }
  const d = state.data || {}
  if (d.ok === false) {
    return h(DfCard, { title: '宿主补丁', icon: 'wrench' },
      h(DfOpsError, {
        title: '读不到宿主状态',
        error: d.error || state.error,
        onRetry: state.reload,
      }))
  }

  const names = d.patch_names || {}
  /* 依赖没装的可选补丁：列表里灰显、开关禁用，不参与统计。 */
  const optional = Array.isArray(d.optional_patches) ? d.optional_patches : []
  /* 没有宿主（app.asar 重新封装 / 未解包）时 display_patches 是空的。
     这不是没补丁，而是补丁定义还没绑定到宿主 —— 把定义列出来，状态标「未绑定宿主」。 */
  const unbound = d.patches_bound === false || (!d.ai_base && !!d.missing_ai_base)
  const defs = Array.isArray(d.patch_defs) ? d.patch_defs : []
  const listed = (Array.isArray(d.patches) && d.patches.length)
    ? d.patches
    : (unbound ? defs.map(function (x) { return Object.assign({}, x, { status: 'unbound' }) }) : [])
  const all = listed.map(function (p) {
    return Object.assign({}, p, {
      name: p.name || names[String(p.id)] || ('补丁 #' + p.id),
      title: p.title || '',
      what: p.what || '',
      on: p.on || '',
      off: p.off || '',
      effect: p.effect || '',
      note: p.note || '',
      tags: Array.isArray(p.tags) ? p.tags : [],
      essential: p.essential === true,
      enabled: p.enabled !== false,
    })
  })
  /* 核心永远排最前：用户先看到“破甲链路”，再看到通用补丁。 */
  const allSorted = all.slice().sort(function (a, b) {
    return (b.essential ? 1 : 0) - (a.essential ? 1 : 0) || a.id - b.id
  })
  const tagCounts = {}
  all.forEach(function (p) {
    (p.tags || []).forEach(function (t) { tagCounts[t] = (tagCounts[t] || 0) + 1 })
  })
  /* 依赖没装的可选补丁不在 all 里，但「可选」筛选要能把它们一起列出来。 */
  optional.forEach(function (o) {
    const list = Array.isArray(o.tags) && o.tags.length ? o.tags : ['可选']
    list.forEach(function (t) { tagCounts[t] = (tagCounts[t] || 0) + 1 })
  })
  const tags = DF_PATCH_TAG_ORDER.filter(function (t) { return tagCounts[t] })
  const statuses = []
  all.forEach(function (p) {
    if (p.status && statuses.indexOf(p.status) < 0) statuses.push(p.status)
  })
  const rows = allSorted.filter(function (p) {
    if (tag && (p.tags || []).indexOf(tag) < 0) return false
    if (status && p.status !== status) return false
    if (onlyOff && p.enabled !== false) return false
    return true
  })
  /* 可选依赖补丁：显示在列表里，但开关禁用（依赖没装 = 无法启动），不参与统计。 */
  const depRows = optional.map(function (o) {
    return Object.assign({}, o, {
      status: 'dep', enabled: false, optionalDep: true,
      tags: Array.isArray(o.tags) ? o.tags : ['可选'],
    })
  })
  const showDeps = (!tag || tag === '可选') && !status && !onlyOff
  const shownRows = rows.concat(showDeps ? depRows : [])
  const coreAll = all.filter(function (p) { return p.essential })
  const coreOn = coreAll.filter(function (p) { return p.enabled !== false }).length
  const offCount = all.filter(function (p) { return p.enabled === false }).length

  /* 方案只改启停偏好，不动宿主；真正生效仍要点「写入宿主」。
     推荐 = 通用补丁全开，只关掉依赖第三方插件/预设的适配（可选）。 */
  function idsForRows(list) {
    const out = []
    list.forEach(function (r) {
      (Array.isArray(r.ids) && r.ids.length ? r.ids : [r.id]).forEach(function (id) {
        if (out.indexOf(id) < 0) out.push(id)
      })
    })
    return out.sort(function (a, b) { return a - b })
  }
  const allIds = idsForRows(all)
  const coreIds = idsForRows(coreAll)
  /* 可选适配既可能在正常列表里（依赖已装），也可能只在 optional 列表里（依赖未装）。
     推荐方案要把两种情况都关掉，否则“推荐”看起来等于“全开”。 */
  const optionalIds = idsForRows(all.filter(function (p) {
    return (p.tags || []).indexOf('可选') >= 0
  }).concat(optional))
  const allKnownIds = Array.from(new Set(allIds.concat(optionalIds)))
    .sort(function (a, b) { return a - b })
  const presetTargets = {
    recommended: optionalIds,
    /* 仅核心要把可选适配也关掉；否则它们不在正常列表里，会被漏掉。 */
    core: allKnownIds.filter(function (id) { return coreIds.indexOf(id) < 0 }),
  }
  const presetLabels = { recommended: '推荐', core: '仅核心' }
  const offNow = (Array.isArray(d.patch_disabled) ? d.patch_disabled : [])
    .filter(function (id) { return allIds.indexOf(id) >= 0 })
  function sameIdSet(list, target) {
    if (list.length !== target.length) return false
    const set = new Set(target)
    return list.every(function (id) { return set.has(id) })
  }
  /* 可选适配本来就默认不启用，比较“当前方案”时不算差异；
     否则全新安装、通用补丁全开时会被误判成“自定义”。 */
  const offGeneral = offNow.filter(function (id) { return optionalIds.indexOf(id) < 0 })
  const presetNow = ['recommended', 'core'].filter(function (key) {
    const target = presetTargets[key].filter(function (id) { return optionalIds.indexOf(id) < 0 })
    return sameIdSet(offGeneral, target)
  })[0] || 'custom'
  const schemes = Array.isArray(d.patch_schemes) ? d.patch_schemes : []
  const schemeNow = schemes.filter(function (s) {
    const ids = (Array.isArray(s.disabled) ? s.disabled : [])
      .filter(function (id) { return allIds.indexOf(id) >= 0 })
    return sameIdSet(offNow, ids)
  })[0] || null
  const presetName = schemeNow
    ? schemeNow.name
    : (presetNow === 'recommended' ? '推荐' : (presetNow === 'core' ? '仅核心' : '自定义'))

  /* 行点击 → 右侧抽屉：英文标识、层、状态、何时生效，加上“做什么 / 备注”。
     列表里一行放不下的解释放这里，不占表格宽度。 */
  function openPatch(r) {
    if (!props.onInspect) return
    const m = dfPatchMeta(r.status)
    const offNow = Array.isArray(d.patch_disabled) ? d.patch_disabled : []
    const offInGroup = (Array.isArray(r.ids) && r.ids.length ? r.ids : [r.id])
      .filter(function (id) { return offNow.indexOf(id) >= 0 })
    props.onInspect({
      title: r.title || r.name,
      sub: [r.layer, m.label, r.optionalDep ? '需要 ' + (r.dependency || '可选插件') : ''].filter(Boolean).join(' · '),
      rows: [
        ['编号', dfPatchIdsLabel(r) + ((r.ids || []).length > 1 ? '（同组一起启停）' : '')],
        ['英文标识', r.name],
        ['层', r.layer],
        ...(r.optionalDep
          ? [['依赖', r.dependency || '可选插件'], ['启用', '装上依赖后才能启用']]
          : [['开关', r.enabled === false
            ? (r.partial
              ? '部分停用：' + offInGroup.map(function (id) { return '#' + id }).join('、') + ' 已停用，点开关按整组处理'
              : '已停用（应用时跳过）')
            : '已启用']]),
        ['何时生效', r.effect || '重启 DeepSeek Harness 后生效'],
      ],
      head: h('div', { className: 'df-patch-status df-patch-status--' + m.kind },
        h('span', { className: 'df-patch-status-ico' }, dfIcon(dfPatchStatusIcon(r.status), 17)),
        h('div', { className: 'df-patch-status-main' },
          h('span', { className: 'df-patch-status-badge' }, m.label),
          h('b', null, m.hint || m.label),
          m.next ? h('span', { className: 'df-patch-status-next' }, m.next) : null)),
      node: h('div', { className: 'df-detail df-patch-detail' },
        r.essential ? h('div', { className: 'df-note df-note--warn' }, '核心补丁：停用或写入失败后，破甲开关会置灰，注入链路可能直接失效。') : null,
        h('div', { className: 'df-ptags' },
          (r.tags || []).map(function (t) { return h(DfPatchTag, { key: t, tag: t }) })),
        r.what ? h('section', { className: 'df-detail-sec df-patch-sec' },
          h('div', { className: 'df-detail-hd' }, h('h4', null, '作用')),
          h('div', { className: 'df-detail-p' }, r.what)) : null,
        r.on ? h('section', { className: 'df-detail-sec df-patch-sec is-on' },
          h('div', { className: 'df-detail-hd' }, h('h4', null, '开启后')),
          h('div', { className: 'df-detail-p' }, r.on)) : null,
        r.off ? h('section', { className: 'df-detail-sec df-patch-sec is-off' },
          h('div', { className: 'df-detail-hd' }, h('h4', null, '关闭后')),
          h('div', { className: 'df-detail-p' }, r.off)) : null,
        r.note ? h('div', { className: 'df-note df-note--warn' }, '注意：' + r.note) : null,
        r.optionalDep ? h('div', { className: 'df-note' }, '依赖没装时这条补丁不会写入，也不会计入失败。') : null),
    })
  }

  /* 单条开关：只改偏好，不动宿主；真正生效要重新点「写入宿主」。
     核心补丁用两段式确认（不用 window.confirm，避免阻塞渲染线程）。 */
  function togglePatch(r) {
    if (prefBusy) return
    const turningOff = r.enabled !== false
    if (turningOff && r.essential && confirmOff !== r.id) {
      setConfirmOff(r.id)
      dfToast('「' + (r.title || r.name) + '」是核心补丁，再点一次确认停用', 'warn', 5000)
      window.setTimeout(function () { setConfirmOff(0) }, 5000)
      return
    }
    setConfirmOff(0)
    const off = new Set(Array.isArray(d.patch_disabled) ? d.patch_disabled : [])
    /* 显示层会把同一组补丁合并成一行（例如 1/2/3），停用要整组一起停，
       否则只停 lead、组内其它补丁还会被写进宿主。 */
    const ids = Array.isArray(r.ids) && r.ids.length ? r.ids : [r.id]
    for (const id of ids) {
      if (turningOff) off.add(id)
      else off.delete(id)
    }
    const next = [...off].sort(function (a, b) { return a - b })
    setPrefBusy(r.id)
    dfHostPost('/dsh-forge/patch-prefs', { disabled: next }).then(function (res) {
      setPrefBusy(0)
      if (!res || res.ok === false) {
        dfToast((res && res.error) || '保存补丁开关失败', 'err', 5200)
        return
      }
      dfToast(
        (turningOff
          ? '已停用「' + (r.title || r.name) + '」'
          : '已启用「' + (r.title || r.name) + '」')
        + (ids.length > 1 ? '（' + dfPatchIdsLabel(r) + ' 整组）' : '')
        + (turningOff ? '；点「写入宿主」才会从宿主撤掉' : '；点「写入宿主」写入宿主'),
        'ok', 4600
      )
      state.reload()
      dfBust()
    })
  }

  /* 方案切换只改启用集合；宿主里的旧补丁要等「写入宿主」才会撤掉。 */
  function applyPreset(key) {
    if (presetBusy) return
    const target = presetTargets[key]
    const currentAll = (Array.isArray(d.patch_disabled) ? d.patch_disabled : [])
      .map(Number)
      .filter(function (id) { return allKnownIds.indexOf(id) >= 0 })
    if (sameIdSet(currentAll, target)) {
      dfToast('已经是「' + presetLabels[key] + '」方案', 'info', 2400)
      return
    }
    setPresetBusy(key)
    dfHostPost('/dsh-forge/patch-prefs', { disabled: target }).then(function (res) {
      setPresetBusy('')
      if (!res || res.ok === false) {
        dfToast((res && res.error) || '切换方案失败', 'err', 5200)
        return
      }
      dfToast('已切换为「' + presetLabels[key] + '」；点「写入宿主」后生效', 'ok', 4600)
      state.reload()
      dfBust()
    }, function (e) {
      setPresetBusy('')
      dfToast(String(e && e.message ? e.message : e), 'err', 4600)
    })
  }

  /* 自定义方案：只存启停集合，不复制补丁定义。 */
  function applyScheme(s) {
    if (schemeBusy) return
    setSchemeBusy(s.id)
    dfHostPost('/dsh-forge/patch-prefs', { action: 'applyScheme', id: s.id }).then(function (res) {
      setSchemeBusy('')
      if (!res || res.ok === false) {
        dfToast((res && res.error) || '应用方案失败', 'err', 5200)
        return
      }
      dfToast('已应用方案「' + s.name + '」；点「写入宿主」后生效', 'ok', 4600)
      state.reload()
      dfBust()
    }, function (e) {
      setSchemeBusy('')
      dfToast(String(e && e.message ? e.message : e), 'err', 4600)
    })
  }

  function removeScheme(s) {
    if (schemeBusy) return
    setSchemeBusy('del:' + s.id)
    dfHostPost('/dsh-forge/patch-prefs', { action: 'deleteScheme', id: s.id }).then(function (res) {
      setSchemeBusy('')
      if (!res || res.ok === false) {
        dfToast((res && res.error) || '删除方案失败', 'err', 5200)
        return
      }
      dfToast('已删除方案「' + s.name + '」', 'ok', 2600)
      state.reload()
      dfBust()
    }, function (e) {
      setSchemeBusy('')
      dfToast(String(e && e.message ? e.message : e), 'err', 4600)
    })
  }

  function openSaveScheme(asNew) {
    const base = schemeNow ? schemeNow.name : '我的方案'
    setSaveId(asNew ? '' : (schemeNow ? schemeNow.id : ''))
    setSaveName(asNew ? base + ' 副本' : base)
    setSaveOpen(true)
  }

  function saveSchemeNow() {
    if (saveBusy) return
    const name = saveName.trim()
    if (!name) { dfToast('先给方案起个名字', 'err', 2600); return }
    setSaveBusy(true)
    dfHostPost('/dsh-forge/patch-prefs', {
      action: 'saveScheme',
      id: saveId || undefined,
      name: name,
      disabled: Array.isArray(d.patch_disabled) ? d.patch_disabled : [],
    }).then(function (res) {
      setSaveBusy(false)
      if (!res || res.ok === false) {
        dfToast((res && res.error) || '保存方案失败', 'err', 5200)
        return
      }
      setSaveOpen(false)
      dfToast('已保存方案「' + name + '」', 'ok', 3000)
      state.reload()
      dfBust()
    }, function (e) {
      setSaveBusy(false)
      dfToast(String(e && e.message ? e.message : e), 'err', 4600)
    })
  }

  function act(path, label) {
    if (busy) return
    setBusy(label)
    if (label === 'apply') {
      dfToast('正在写入宿主；首次解包 app.asar 可能要 1–3 分钟，请别关面板', 'ok', 6000)
    }
    dfHostPost(path, {}).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '操作失败', 'err', 5200); return }
      if (label === 'apply' && r.complete === false) {
        const coreFailed = Number(r.core_failed) || 0
        const corePending = Number(r.core_pending) || 0
        const otherLost = (Number(r.other_failed) || 0) + (Number(r.other_pending) || 0)
        if (r.core_complete === false) {
          dfToast(coreFailed > 0
            ? '核心补丁未写入：' + coreFailed + ' 条失败；破甲开关暂不可用，请重试或还原'
            : (corePending > 0
              ? '核心补丁还有 ' + corePending + ' 条待写入；破甲开关暂不可用'
              : '核心补丁未写入或已停用；破甲开关暂不可用'), 'err', 7600)
        } else if (otherLost > 0) {
          dfToast('核心补丁已写入' + (r.restarting ? '，客户端正在重启' : '')
            + '；非核心补丁 ' + otherLost + ' 条未写入，不影响破甲', r.restarting ? 'ok' : 'info', 7200)
        } else {
          dfToast('宿主校验未通过；请重试或还原', 'err', 6800)
        }
      } else if (r.restarting) dfToast('补丁已写入，客户端正在重启', 'ok', 5000)
      else if (r.reverted !== undefined) dfToast('已还原 ' + dfNum(r.reverted) + ' 条补丁，重启后生效', 'ok', 4200)
      else if (r.applied !== undefined) dfToast('已应用 ' + dfNum(r.applied) + ' 条，待应用 ' + dfNum(d.patches_pending || 0), 'ok', 4200)
      else dfToast('已完成', 'ok', 2400)
      dfBust()
      state.reload()
    })
  }

  const total = Number(d.patches_total || 0) || all.length
  const applied = Number(d.patches_applied || 0)
  const pending = Number(d.patches_pending || 0)
  const enabledCount = all.filter(function (r) { return r.enabled !== false }).length
  const disabledCount = all.length - enabledCount
  const stampMismatch = Boolean(
    d.plugin_version && d.patch_stamp && d.patch_stamp.version
    && String(d.plugin_version) !== String(d.patch_stamp.version)
  )

  return h('div', { className: 'df-ops' },
    h('div', { className: 'df-kpis' },
      h(DfKpi, {
        label: '已应用', icon: 'check', value: dfNum(applied),
        foot: '启用 ' + dfNum(enabledCount) + ' 条'
          + (disabledCount ? ' · 停用 ' + dfNum(disabledCount) : '')
          + (coreAll.length ? ' · 核心 ' + dfNum(coreOn) + '/' + dfNum(coreAll.length) : '')
          + (unbound ? ' · 未绑定宿主' : ''),
        accent: !unbound && total > 0 && applied === total,
      }),
      h(DfKpi, {
        label: '待应用', icon: 'clock', value: dfNum(pending),
        foot: unbound ? '点「写入宿主」绑定并写入' : (pending ? '点「写入宿主」写进宿主' : '没有待应用补丁'),
      })),

    /* 这里最容易和「破甲开关」搞混：先把两个概念分开写清楚。 */
    h('div', { className: 'df-note' },
      '这里做的是「把插件装进宿主」：写入补丁后，破甲注入、权限预置、回退这些能力才会生效。'
      + '破甲本身的开关在「提示词 → 破甲注入」，不在这里。'),
    d.missing_ai_base ? h('div', { className: 'df-note df-note--warn' }, d.missing_ai_base) : null,
    d.asar_still_sealed ? h('div', { className: 'df-note' }, '宿主还是密封包：点「写入宿主」会解开 app.asar 并自动重启客户端（约 1–3 分钟）。') : null,
    stampMismatch
      ? h('div', { className: 'df-note' },
        '补丁是在旧版本写入的，建议重新写入以对齐当前版本。')
      : null,
    d.patches_lost ? h('div', { className: 'df-note df-note--warn' }, '宿主更新或重启后补丁记录已失效，点「写入宿主」重新写入。') : null,
    disabledCount
      ? h('div', { className: 'df-note df-note--warn' },
        '已停用 ' + dfNum(disabledCount) + ' 条：点「写入宿主」会先还原宿主、再只写启用的补丁，让宿主和开关保持一致。')
      : null,
    /* 可选依赖已经作为灰色行放进上面的列表，这里不再重复说明。 */

    h(DfCard, {
      title: '宿主补丁', icon: 'wrench',
      sub: '一次性的安装动作：把插件改写写进宿主源码，不是破甲开关',
      actions: h('div', { className: 'df-opsbar' },
        h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', onClick: state.reload }, '刷新'),
        h(DfBtn, {
          size: 'sm', kind: confirmRevert ? 'danger' : 'ghost', icon: 'restore', disabled: !!busy,
          onBlur: function () { setConfirmRevert(false) },
          onClick: function () {
            if (!confirmRevert) { setConfirmRevert(true); return }
            setConfirmRevert(false)
            act('/dsh-forge/revert', 'revert')
          },
        }, busy === 'revert' ? '还原中…' : (confirmRevert ? '确认还原' : '还原全部')),
        h(DfBtn, {
          size: 'sm', kind: confirmApply ? 'danger' : 'primary', icon: 'check', disabled: !!busy,
          onBlur: function () { setConfirmApply(false) },
          onClick: function () {
            if (!confirmApply) { setConfirmApply(true); return }
            setConfirmApply(false)
            act('/dsh-forge/apply', 'apply')
          },
        }, busy === 'apply' ? '写入中…' : (confirmApply ? '确认写入宿主' : '写入宿主'))),
    },
      /* 方案：只改启用集合，点「写入宿主」后才作用到宿主。 */
      h('div', { className: 'df-presetbar' },
        h('span', { className: 'df-ops-meta' }, '方案'),
        ['recommended', 'core'].map(function (key) {
          return h('button', {
            key: key,
            type: 'button',
            className: dfCx('df-agent-mode', !schemeNow && presetNow === key && 'is-on', presetBusy === key && 'is-busy'),
            title: key === 'recommended'
              ? '核心 + 通用修复；依赖第三方插件/预设的适配默认关闭'
              : '只启用 12 条核心补丁',
            onClick: function () { applyPreset(key) },
          }, presetBusy === key ? '切换中…' : presetLabels[key])
        }),
        schemes.map(function (s) {
          const active = schemeNow && schemeNow.id === s.id
          return h('span', { key: s.id, className: dfCx('df-scheme-chip', active && 'is-on') },
            h('button', {
              type: 'button',
              className: 'df-scheme-name',
              title: '应用自定义方案「' + s.name + '」',
              onClick: function () { applyScheme(s) },
            }, schemeBusy === s.id ? '应用中…' : s.name),
            h('button', {
              type: 'button',
              className: 'df-scheme-x',
              title: '删除方案（不会改当前开关）',
              onClick: function () { removeScheme(s) },
            }, schemeBusy === 'del:' + s.id ? '…' : '×'))
        }),
        h('span', { className: 'df-ops-meta' }, '当前：' + presetName),
        saveOpen
          ? h('span', { className: 'df-scheme-save' },
            h('input', {
              className: 'df-input',
              style: { width: 148, height: 26 },
              value: saveName,
              maxLength: 40,
              placeholder: '方案名',
              spellCheck: false,
              onChange: function (e) { setSaveName(e.target.value) },
              onKeyDown: function (e) { if (e.key === 'Enter') saveSchemeNow() },
            }),
            h(DfBtn, {
              size: 'sm', kind: 'primary', icon: 'check',
              disabled: saveBusy || !saveName.trim(),
              onClick: saveSchemeNow,
            }, saveBusy ? '保存中…' : '保存'),
            h(DfBtn, {
              size: 'sm', kind: 'ghost',
              onClick: function () { setSaveOpen(false) },
            }, '取消'))
          : h(react.Fragment, null,
            h(DfBtn, {
              size: 'sm', kind: 'ghost', icon: 'plus',
              onClick: function () { openSaveScheme(false) },
            }, schemeNow ? '保存当前方案' : '存为方案'),
            schemeNow
              ? h(DfBtn, {
                size: 'sm', kind: 'ghost',
                onClick: function () { openSaveScheme(true) },
              }, '另存为')
              : null),
        h('span', { className: 'df-spacer' }),
        h('button', {
          type: 'button',
          className: dfCx('df-agent-mode', onlyOff && 'is-on'),
          title: '只显示已停用的补丁，方便重装后核对',
          onClick: function () { setOnlyOff(function (v) { return !v }) },
        }, '只看已停用 ' + dfNum(offCount))),
      /* 标签筛选：核心第一，点一下只看这一类；再点一次取消。 */
      h('div', { className: 'df-tagbar' },
        h('button', {
          type: 'button',
          className: dfCx('df-agent-mode', !tag && 'is-on'),
          onClick: function () { setTag('') },
        }, '全部 ' + dfNum(all.length + optional.length)),
        tags.map(function (t) {
          return h('button', {
            key: t,
            type: 'button',
            className: dfCx('df-agent-mode', 'df-tag-chip', t === '核心' && 'is-core', tag === t && 'is-on'),
            title: DF_PATCH_TAGS[t] ? DF_PATCH_TAGS[t].hint : '',
            onClick: function () { setTag(tag === t ? '' : t) },
          }, t + ' ' + dfNum(tagCounts[t]))
        })),
      h('div', { className: 'df-opsbar df-opsbar--pad' },
        h('select', {
          className: 'df-select', value: status,
          onChange: function (e) { setStatus(e.target.value) },
        },
          h('option', { value: '' }, '全部状态'),
          statuses.map(function (s) {
            return h('option', { key: s, value: s }, dfPatchMeta(s).label)
          })),
        h('span', { className: 'df-ops-meta' }, '待应用 = 还没写入 · 已跳过 = 原文对不上，不是失败 · 点行看详情'),
        h('span', { className: 'df-spacer' }),
        h(DfBtn, {
          size: 'sm', kind: 'ghost', icon: 'list',
          onClick: function () { setTech(function (v) { return !v }) },
        }, tech ? '隐藏技术标识' : '技术标识'),
        h('span', { className: 'df-ops-meta' }, '显示 ' + dfNum(shownRows.length) + ' / ' + dfNum(all.length + depRows.length) + ' 项')),

      shownRows.length
        ? h('div', { className: 'df-tablewrap' },
          h(DfTable, {
            rows: shownRows,
            rowKey: function (r) { return r.id },
            rowClassName: function (r) { return r.essential ? 'df-row--core' : null },
            onRow: function (r) { openPatch(r) },
            columns: [
              {
                key: 'id', title: '编号', width: 72,
                render: function (r) {
                  return h('span', {
                    className: 'df-mono',
                    title: (Array.isArray(r.ids) && r.ids.length > 1)
                      ? '同组补丁 ' + r.ids.map(function (id) { return '#' + id }).join('、') + ' 一起启停'
                      : '补丁 #' + r.id,
                  }, dfPatchIdsLabel(r))
                },
              },
              /* 默认给人看的那列：中文名 + 一句人话。英文大写在「技术标识」里才显示，
                 否则一屏 WORKSPACE_CONTEXT_INTRO 没人看得懂。 */
              {
                key: 'title', title: '补丁', ellipsis: true,
                render: function (r) {
                  const main = r.title || r.name
                  const sub = tech
                    ? (r.name + (r.what ? ' · ' + r.what : ''))
                    : (r.what || r.name)
                  return h('span', {
                    className: dfCx('df-pname', r.enabled === false && 'is-off'),
                    title: main + (r.what ? ' — ' + r.what : ''),
                  },
                    h('b', null, main, r.essential ? h('em', { className: 'df-pname-core' }, '核心') : null),
                    h('small', null, sub))
                },
              },
              {
                key: 'tags', title: '标签', width: 190,
                render: function (r) {
                  const list = r.tags || []
                  return h('div', { className: 'df-ptags' },
                    list.length
                      ? list.map(function (t) { return h(DfPatchTag, { key: t, tag: t }) })
                      : h('span', { className: 'df-hint' }, '未分类'))
                },
              },
              {
                key: 'status', title: '状态', width: 96,
                render: function (r) {
                  const m = dfPatchMeta(r.status)
                  return h(DfChip, { kind: m.kind, dot: true, title: m.hint || m.label }, m.label)
                },
              },
              {
                key: 'enabled', title: '启用', width: 54, align: 'center',
                render: function (r) {
                  if (r.optionalDep) {
                    return h('span', { className: 'df-hint', title: '需要 ' + (r.dependency || '可选插件') + '；装上后才能启用' }, '—')
                  }
                  const on = r.enabled !== false
                  return h('label', {
                    className: dfCx('df-switch', 'df-switch--sm', prefBusy === r.id && 'is-busy', confirmOff === r.id && 'is-confirm'),
                    title: on
                      ? (r.essential ? '核心补丁：再点一次才停用' : '已启用：应用时写入宿主')
                      : (r.partial ? '部分停用：组内还有补丁在启用，点一下按整组恢复' : '已停用：应用时跳过并从宿主撤掉'),
                    onClick: function (e) { e.stopPropagation() },
                  },
                    h('input', {
                      type: 'checkbox',
                      checked: on,
                      disabled: prefBusy === r.id,
                      onChange: function () { togglePatch(r) },
                    }),
                    h('i'))
                },
              },
            ],
          }))
        : (unbound
          ? h(DfEmpty, {
            icon: 'wrench',
            title: '补丁定义已加载，还没有绑定宿主',
            hint: '点「写入宿主」解开密封包并写入这 ' + dfNum(all.length) + ' 条补丁；写入后重启客户端生效。',
          })
          : h(DfEmpty, { icon: 'wrench', title: '没有匹配的补丁', hint: '换一个标签或状态筛选试试。' })))
  )
}

/* ---------------------------------------------------------------- 规则集 */

function DfRuleEditor(props) {
  const isNew = !props.id
  const [id, setId] = useState(String(props.id || ''))
  const [name, setName] = useState(String(props.name || ''))
  const [text, setText] = useState(String(props.content || ''))
  const [busy, setBusy] = useState('')

  const idOk = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id.trim())
  const canSave = idOk && String(text).trim().length > 0 && !busy

  function save() {
    if (!canSave) return
    setBusy('save')
    dfHostPost('/dsh-forge/rules', {
      op: 'save', id: id.trim(), name: name.trim(), content: text, target: 'AGENTS.md',
    }).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '保存失败', 'err', 4200); return }
      dfToast(isNew ? '规则片段已创建' : '规则片段已保存', 'ok', 2200)
      if (props.onSaved) props.onSaved(id.trim(), text)
    })
  }

  return h('div', { className: 'df-detail' },
    h('section', { className: 'df-detail-sec' },
      h('div', { className: 'df-formgrid' },
        h(DfField, { label: '规则 ID', hint: isNew ? '字母或数字开头，可用 . _ -；例如 redteam-strict' : '保存后不可修改' },
          h('input', {
            className: 'df-input', value: id, disabled: !isNew, spellCheck: false,
            placeholder: 'redteam-strict',
            onChange: function (e) { setId(e.target.value) },
          })),
        h(DfField, { label: '名称', hint: '列表里显示，可留空' },
          h('input', {
            className: 'df-input', value: name, spellCheck: false,
            placeholder: '红队严格约束',
            onChange: function (e) { setName(e.target.value) },
          })))),

    h('div', { className: 'df-note' }, '启用后整段写入用户级 AGENTS.md。这是 DeepSeek Harness 的用户级指令文件，和「提示词 → 工作区指令」层上面的「用户级 AGENTS.md」是同一份。'),

    h('section', { className: 'df-detail-sec' },
      h('div', { className: 'df-detail-hd' },
        h('h4', null, '规则正文 · ' + dfNum(String(text).length) + ' 字符'),
        h(DfCopyBtn, { text: text, label: '复制', toast: '规则已复制' })),
      h('textarea', {
        className: 'df-area df-area--code', rows: 16, value: text, spellCheck: false,
        placeholder: '写清楚约束、边界和禁止项；启用后会整段写进目标文件。',
        onChange: function (e) { setText(e.target.value) },
      })),

    h('div', { className: 'df-formfoot' },
      h('span', { className: 'df-ops-meta' }, '保存后需在列表点「写入 AGENTS.md」'),
      h('span', { className: 'df-spacer' }),
      h(DfBtn, { size: 'sm', kind: 'primary', icon: 'check', disabled: !canSave, onClick: save },
        busy === 'save' ? '保存中…' : (isNew ? '创建' : '保存'))))
}

/** 规则写入 / 删除：都会改动文件，两步确认，5 秒不点自动退回。 */
function DfRuleActions(props) {
  const [ask, setAsk] = useState(false)
  const [writeAsk, setWriteAsk] = useState(false)
  useEffect(function () {
    if (!ask) return undefined
    const t = window.setTimeout(function () { setAsk(false) }, 5000)
    return function () { window.clearTimeout(t) }
  }, [ask])
  useEffect(function () {
    if (!writeAsk) return undefined
    const t = window.setTimeout(function () { setWriteAsk(false) }, 5000)
    return function () { window.clearTimeout(t) }
  }, [writeAsk])
  return h(react.Fragment, null,
    h(DfBtn, {
      size: 'sm', kind: writeAsk ? 'danger' : 'ghost', icon: 'check',
      disabled: props.busy || props.active,
      onBlur: function () { setWriteAsk(false) },
      onClick: function () {
        if (props.active || props.busy) return
        if (!writeAsk) { setWriteAsk(true); return }
        setWriteAsk(false)
        props.onActivate()
      },
    }, props.activating ? '写入中…' : (props.active ? '已写入' : (writeAsk ? '确认覆盖 AGENTS.md' : '写入 AGENTS.md'))),
    h(DfBtn, {
      size: 'sm', kind: ask ? 'solid-danger' : 'danger', icon: 'trash',
      disabled: props.busy,
      onBlur: function () { setAsk(false) },
      onClick: function () {
        if (!ask) { setAsk(true); return }
        setAsk(false)
        props.onDelete()
      },
    }, props.deleting ? '删除中…' : (ask ? '确认删除' : '删除')))
}

function DfRulesPanel(props) {
  const [busy, setBusy] = useState('')
  /* 还原会重写用户级 AGENTS.md，必须两步确认，5 秒不点自动退回。 */
  const [resetAsk, setResetAsk] = useState(false)
  const state = dfUseAsync(function () {
    return dfHostPost('/dsh-forge/rules', { op: 'status' })
  }, [props.tick])

  useEffect(function () {
    if (!resetAsk) return undefined
    const t = window.setTimeout(function () { setResetAsk(false) }, 5000)
    return function () { window.clearTimeout(t) }
  }, [resetAsk])

  if (state.loading && !state.data) return h(DfSkeleton, { lines: 8 })
  const d = state.data || {}
  if (d.ok === false) {
    return h(DfCard, { title: '规则片段', icon: 'list' },
      h(DfOpsError, { title: '读不到规则片段', error: d.error || state.error, onRetry: state.reload }))
  }

  const rules = d.rules || []
  const active = d.active || ''

  function act(op, id, extra) {
    if (busy) return
    setBusy(op + ':' + (id || ''))
    dfHostPost('/dsh-forge/rules', Object.assign({ op: op, id: id }, extra || {})).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '操作失败', 'err', 4600); return }
      dfToast(op === 'activate' ? '已写入用户级 AGENTS.md' : (op === 'delete' ? '已删除' : '已还原出厂指令'), 'ok', 2400)
      if (props.onChanged) props.onChanged()
      if (props.onCloseDrawer) props.onCloseDrawer()
      state.reload()
    })
  }

  function open(r) {
    if (!props.onInspect) return
    props.onInspect({
      mode: 'page',
      maximize: true,
      title: r.name || r.id,
      sub: 'AGENTS.md' + (r.id === active ? ' · 已写入' : ''),
      rows: [],
      node: h('div', { className: 'df-detail' },
        h(DfRuleBody, {
          id: r.id,
          onSaved: function () { state.reload() },
        }),
        h('div', { className: 'df-formfoot' },
          h(DfRuleActions, {
            active: r.id === active,
            busy: !!busy,
            activating: busy === 'activate:' + r.id,
            deleting: busy === 'delete:' + r.id,
            onActivate: function () { act('activate', r.id) },
            onDelete: function () { act('delete', r.id) },
          }))),
    })
  }

  function createRule() {
    if (!props.onInspect) return
    props.onInspect({
      title: '新建规则片段',
      sub: '保存后回列表，点「写入 AGENTS.md」才生效',
      rows: [],
      node: h(DfRuleEditor, {
        onSaved: function () {
          if (props.onCloseDrawer) props.onCloseDrawer()
          state.reload()
        },
      }),
    })
  }

  return h('div', { className: 'df-ops' },
    h('div', { className: 'df-kpis' },
      h(DfKpi, { label: '规则片段', icon: 'list', value: dfNum(rules.length) }),
      h(DfKpi, { label: '当前写入', icon: 'check', value: active ? '1' : '0', foot: active ? (rules.filter(function (r) { return r.id === active })[0] || {}).name : '没有写入规则片段' }),
      h(DfKpi, { label: '写入位置', icon: 'prompt', value: 'AGENTS.md', foot: active ? (d.agents_synced ? '内容已同步' : '目标文件未同步') : '不写入文件' })),

    h(DfCard, {
      title: '规则片段', icon: 'list', sub: '预置约束 · 写入用户级 AGENTS.md',
      actions: h('div', { className: 'df-opsbar' },
        h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'plus', onClick: createRule }, '新建'),
        h(DfBtn, {
          size: 'sm', kind: resetAsk ? 'danger' : 'ghost', icon: 'restore', disabled: !!busy,
          onBlur: function () { setResetAsk(false) },
          onClick: function () {
            if (busy) return
            if (!resetAsk) { setResetAsk(true); return }
            setResetAsk(false)
            act('reset', '')
          },
        }, busy === 'reset:' ? '还原中…' : (resetAsk ? '确认还原出厂指令' : '还原出厂指令'))),
    },
      rules.length
        ? h('div', { className: 'df-tablewrap' },
          h(DfTable, {
            rows: rules,
            rowKey: function (r) { return r.id },
            onRow: open,
            columns: [
              {
                key: 'name', title: '片段', width: '56%',
                render: function (r) {
                  return h('div', { className: 'df-vuln-t' }, r.name || r.id,
                    h('small', null, r.id))
                },
              },
              {
                key: 'active', title: '状态', width: 100,
                render: function (r) {
                  return r.id === active
                    ? h(DfChip, { kind: 'ok', dot: true }, '已写入')
                    : h(DfChip, { kind: 'line' }, '未写入')
                },
              },
              {
                key: 'sync', title: '已写入', width: 100, align: 'right',
                render: function (r) {
                  if (r.id !== active) return '—'
                  return d.agents_synced ? h(DfChip, { kind: 'ok' }, '是') : h(DfChip, { kind: 'warn' }, '否')
                },
              },
            ],
          }))
        : h(DfEmpty, { icon: 'list', title: '还没有规则片段', hint: '由智能体沉淀。' }),

      h('div', { className: 'df-note' }, '「写入 AGENTS.md」会整段覆盖用户级 AGENTS.md（自动备份）。项目目录的指令请在「提示词 → 工作区指令」层的文件列表里改。'))
  )
}

/* ---------------------------------------------------------------- 规则正文 */

/** 规则正文按需拉取（列表只给元数据）。 */
function DfRuleBody(props) {
  const state = dfUseAsync(function () {
    return dfHostPost('/dsh-forge/rules', { op: 'read', id: props.id })
  }, [props.id])

  if (state.loading && !state.data) return h(DfSkeleton, { lines: 8 })
  if (!state.data || state.data.ok === false) {
    return h(DfOpsError, { title: '读取规则失败', error: (state.data && state.data.error) || state.error, onRetry: state.reload })
  }
  return h(DfRuleEditor, {
    id: props.id, name: state.data.name, content: state.data.content,
    onSaved: props.onSaved,
  })
}

/* ---------------------------------------------------------------- 钩子 */

function DfHooksPanel(props) {
  const [busy, setBusy] = useState(false)
  const state = dfUseAsync(function () {
    return dfHost('/dsh-forge/hooks-deny')
  }, [props.tick])
  const status = dfUseAsync(function () {
    return dfHost('/dsh-forge/status')
  }, [props.tick])
  const d = state.data || {}
  /* hooksDenyBypass=true → 忽略第三方 hooks 的拒绝/中断（默认）。
     界面用「跟随 / 忽略」两种决定权表达，避免「开关叫拦截、按钮写不拦截」的双重否定。 */
  const ignoreHooks = d.hooksDenyBypass !== false
  const patchStatus = (status.data && status.data.patch_status) || {}
  const hookRows = (status.data && status.data.hook_patches) || []
  const targets = [30, 31, 64, 65]
  const present = targets.some(function (id) {
    const s = patchStatus[id]
    return s && s !== 'na'
  })

  if (state.loading && !state.data) return h(DfSkeleton, { lines: 6 })

  function applyMode(next) {
    if (busy || next === (ignoreHooks ? 'ignore' : 'follow')) return
    const bypass = next === 'ignore'
    setBusy(true)
    dfHostPost('/dsh-forge/hooks-deny', { hooksDenyBypass: bypass }).then(function (r) {
      setBusy(false)
      if (!r || r.ok === false) { dfToast((r && r.error) || '设置失败', 'err', 4600); return }
      dfToast(bypass ? '已改为忽略 hooks：拒绝/中断都不采纳' : '已改为跟随 hooks：按它们的决定执行', 'ok', 3000)
      state.reload()
    })
  }

  return h('div', { className: 'df-ops' },
    h('div', { className: 'df-kpis' },
      h(DfKpi, {
        label: 'hooks 决定权', icon: 'shield', value: ignoreHooks ? '忽略' : '跟随', accent: ignoreHooks,
        foot: ignoreHooks ? 'hooks 说拒绝/停止时，继续执行' : 'hooks 说拒绝/停止时，照做',
      }),
      h(DfKpi, { label: '生效范围', icon: 'users', value: '本机', foot: '只影响 hooks，不改 DeepSeek Harness 权限' })),

    h(DfCard, { title: 'hooks 决定权', icon: 'shield', sub: '第三方 hooks 会在命令执行前后插规则；这里决定 dsh 要不要听' },
      h('div', { className: 'df-formgrid' },
        h('div', { className: 'df-field df-field--wide' },
          h(DfSeg, {
            value: ignoreHooks ? 'ignore' : 'follow',
            items: [['follow', '跟随 hooks'], ['ignore', '忽略 hooks']],
            onChange: function (k) { applyMode(k) },
          }),
          h('div', { className: 'df-hint' },
            '跟随：hooks 判拒绝、要求停止时照做。忽略：继续执行，并改写下面列出的宿主补丁。'),
          present
            ? null
            : h('div', { className: 'df-hint' }, '本机没装 hooks 适配器，这个选择暂时不产生影响。'),
          h('div', { className: 'df-hint' }, '改完要重新点「补丁 → 写入宿主」才会写进宿主。')))),

    /* 这 4 条补丁由本页决定权统一控制，补丁列表里不再重复列一遍。 */
    hookRows.length
      ? h(DfCard, {
        title: '忽略 hooks 时改写的补丁',
        icon: 'list',
        sub: '选「跟随 hooks」不会写这些；选「忽略 hooks」才会应用',
      },
        h('div', { className: 'df-vlist' }, hookRows.map(function (p) {
          const m = dfPatchMeta(p.status)
          return h('div', { className: 'df-vrow', key: p.id },
            h('span', { className: 'df-vrow-main' },
              h('span', { className: 'df-vrow-hd' },
                h('span', { className: 'df-vrow-t' }, p.title || p.name),
                h(DfChip, { kind: m.kind, dot: true }, m.label)),
              h('span', { className: 'df-vrow-m' }, p.what || '')))
        })))
      : null
  )
}

/* ---------------------------------------------------------------- 更新 */

function dfSize(bytes) {
  const n = Number(bytes) || 0
  if (!n) return '—'
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  return Math.max(1, Math.round(n / 1024)) + ' KB'
}

function dfDay(text) {
  if (!text) return '—'
  const t = new Date(text)
  if (isNaN(t.getTime())) return '—'
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0')
}

/* 版本列表的列。正式/测试两条通道一起列出来，靠通道标签区分。 */
const DF_UPDATE_COLS = [
  {
    key: 'version', title: '版本', width: '96px',
    render: function (r) { return h('span', { className: 'df-mono' }, r.version || r.ref) },
  },
  {
    key: 'channel', title: '通道', width: '72px',
    render: function (r) {
      return h(DfChip, { kind: r.channel === 'beta' ? 'warn' : 'line' }, r.channel === 'beta' ? '测试' : '正式')
    },
  },
  { key: 'publishedAt', title: '发布', width: '96px', render: function (r) { return dfDay(r.publishedAt) } },
  { key: 'size', title: '大小', width: '72px', align: 'right', render: function (r) { return dfSize(r.size) } },
  {
    key: 'state', title: '状态', width: '88px',
    render: function (r) {
      if (r.current) return h(DfChip, { kind: 'ok' }, '当前')
      if (r.latest) return h(DfChip, { kind: 'info' }, '最新')
      return h('span', { className: 'df-sub' }, '—')
    },
  },
]

function DfUpdatePanel(props) {
  const [busy, setBusy] = useState('')
  const [result, setResult] = useState(null)
  const [prefetched, setPrefetched] = useState(null)
  const [confirmUn, setConfirmUn] = useState(false)
  const [riskBusy, setRiskBusy] = useState('')
  const state = dfUseAsync(function () {
    return dfHost('/dsh-forge/status')
  }, [props.tick])
  const d = state.data || {}
  const info = result || d.update || {}
  const channel = info.channel || d.channel || 'stable'
  const versions = (info.versions || []).filter(function (v) { return v && (v.version || v.ref) })

  /* 卸载不可撤销：二次确认 5 秒不点自动撤回。 */
  useEffect(function () {
    if (!confirmUn) return undefined
    const t = window.setTimeout(function () { setConfirmUn(false) }, 5000)
    return function () { window.clearTimeout(t) }
  }, [confirmUn])

  /* 进页面自动检测一次。服务端有 60 秒 memo + ETag，不会把匿名额度打光。 */
  useEffect(function () {
    let alive = true
    setBusy('check')
    dfHost('/dsh-forge/update').then(function (r) {
      if (!alive) return
      setBusy('')
      setResult(r)
    })
    return function () { alive = false }
  }, [props.tick])

  function risk(path, label, okText) {
    if (riskBusy) return
    setRiskBusy(label)
    dfHostPost(path, {}).then(function (r) {
      setRiskBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '操作失败', 'err', 5200); return }
      dfToast(okText, 'ok', 4200)
    })
  }

  function check() {
    if (busy) return
    setBusy('check')
    setPrefetched(null)
    dfHost('/dsh-forge/update').then(function (r) {
      setBusy('')
      setResult(r)
      if (!r || r.ok === false) { dfToast((r && r.error) || '检测失败', 'err', 5200); return }
      if (r.localOnly) { dfToast(r.note || '未配置发布源', 'info', 3600); return }
      if (r.hasUpdate) dfToast('有新版本 ' + r.remoteVersion, 'info', 4200)
      else dfToast('已是最新（' + (r.localVersion || d.plugin_version || '—') + '）', 'ok', 2600)
    })
  }

  /* 只切通道不装包：先选车道，再点「更新」才会真的覆盖文件。 */
  function setChannel(next) {
    if (busy || next === channel) return
    setBusy('channel')
    dfHostPost('/dsh-forge/update', { op: 'channel', channel: next, apply: false }).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '切换通道失败', 'err', 5200); return }
      setResult(r)
      dfToast(next === 'beta' ? '已切到测试版通道' : '已切到正式版通道', 'ok', 3000)
    })
  }

  /* 下载 + SHA256 校验，不落盘覆盖；确认包是好的再点应用。 */
  function download() {
    if (busy) return
    setBusy('prefetch')
    setPrefetched(null)
    dfHostPost('/dsh-forge/update', { op: 'prefetch', ref: info.updateTarget || '', channel: channel }).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '下载失败', 'err', 6500); return }
      setPrefetched(r)
      dfToast('校验通过 · ' + dfSize(r.size), 'ok', 3600)
    })
  }

  function apply() {
    if (busy) return
    setBusy('apply')
    dfHostPost('/dsh-forge/update', { op: 'apply', ref: info.updateTarget || '', channel: channel }).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '更新失败', 'err', 8000); return }
      setResult(r)
      if (r.needsFullQuit) dfToast('文件已更新，请完全退出 DeepSeek Harness 再启动', 'info', 9000)
      else if (r.needsRetry) dfToast(r.error || '文件已更新，但补丁没有重新应用', 'err', 9000)
      else dfToast('已更新，正在重启 DeepSeek Harness…', 'ok', 6000)
    })
  }

  function install(row) {
    if (busy || !row || row.current) return
    setBusy('apply')
    dfHostPost('/dsh-forge/update', { op: 'switch', ref: row.ref, channel: row.channel }).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '安装失败', 'err', 8000); return }
      setResult(r)
      if (r.needsFullQuit) dfToast('文件已更新，请完全退出 DeepSeek Harness 再启动', 'info', 9000)
      else if (r.needsRetry) dfToast(r.error || '文件已更新，但补丁没有重新应用', 'err', 9000)
      else dfToast('已切到 ' + row.version + '，正在重启 DeepSeek Harness…', 'ok', 6000)
    })
  }

  const canApply = Boolean(info.hasUpdate) && !info.localOnly
  const target = info.remoteVersion || info.updateTarget || ''

  return h('div', { className: 'df-ops' },
    h('div', { className: 'df-kpis' },
      h(DfKpi, { label: '当前版本', icon: 'shield', value: d.plugin_version || info.localVersion || '—' }),
      h(DfKpi, {
        label: '通道', icon: 'route', value: info.channelLabel || d.channelLabel || '正式版',
        foot: info.pin ? ('固定在 ' + info.pin) : '跟随发布',
      }),
      h(DfKpi, { label: '远端', icon: 'cloud', value: result ? (info.remoteVersion || '—') : '未检测' }),
      h(DfKpi, {
        label: '结论', icon: 'check',
        value: result ? (info.hasUpdate ? '可更新' : (info.localOnly ? '本地版' : '最新')) : '—',
        foot: info.repo || d.update && d.update.repo || '',
      })),

    h(DfCard, {
      title: '更新', icon: 'cloud', sub: '应用后会重启客户端',
      actions: h('div', { className: 'df-opsbar' },
        h(DfBtn, { size: 'sm', icon: 'refresh', disabled: Boolean(busy), onClick: check },
          busy === 'check' ? '检测中…' : '检测更新'),
        canApply ? h(DfBtn, { size: 'sm', icon: 'download', disabled: Boolean(busy), onClick: download },
          busy === 'prefetch' ? '下载中…' : '下载并校验') : null,
        canApply ? h(DfBtn, { size: 'sm', kind: 'primary', icon: 'upload', disabled: Boolean(busy), onClick: apply },
          busy === 'apply' ? '安装中…' : '更新到 ' + target) : null),
    },
      h('div', { className: 'df-detail' },
        h('div', { className: 'df-opsbar df-opsbar--wrap' },
          h(DfSeg, {
            value: channel,
            items: [['stable', '正式版'], ['beta', '测试版']],
            onChange: function (next) { setChannel(next) },
          }),
          h('span', { className: 'df-sub' }, channel === 'beta' ? '测试通道：预发布版本，可能不稳定' : '正式通道：只收稳定版本')),

        h('div', { className: 'df-detail-p' },
          info.note || (result && result.error)
          || (result ? (info.hasUpdate ? '发现新版本 ' + target + '，可以先下载校验再更新。' : '已经是最新版本。') : '正在检测发布源…')),

        result && result.localOnly
          ? h('div', { className: 'df-note' }, '未配置发布源，需手动更新。')
          : null,

        prefetched
          ? h('div', { className: 'df-note' },
            '安装包已校验 · ' + prefetched.asset + ' · ' + dfSize(prefetched.size)
            + (prefetched.verified ? ' · 与发布清单一致' : ' · 发布方未提供校验值'))
          : null,

        /* 发行包只含运行时文件（lib / presets / skills / bin / 构建产物），
           不含交接文档与开发脚本；应用前先校验 SHA256，失败就中止，不留半包。
           这些是发布实现，页面上只讲用户关心的事：动什么、安不安全。 */
        h('div', { className: 'df-note' },
          '更新只替换插件文件，不影响靶标数据；安装前会校验完整性，失败就中止。'))),

    h(DfCard, {
      title: '版本', icon: 'layers', sub: versions.length ? versions.length + ' 个可安装版本' : '还没有读到版本列表',
      actions: h('div', { className: 'df-opsbar' },
        h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', disabled: Boolean(busy), onClick: check }, '刷新')),
    },
      versions.length
        ? h(DfTable, {
          className: 'df-table--fixed',
          columns: DF_UPDATE_COLS.concat([{
            key: 'act', title: '', width: '84px', align: 'right',
            render: function (r) {
              if (r.current) return h('span', { className: 'df-sub' }, '—')
              return h(DfBtn, {
                size: 'sm', kind: 'ghost', disabled: Boolean(busy),
                title: '安装这个版本',
                onClick: function (e) { if (e && e.stopPropagation) e.stopPropagation(); install(r) },
              }, r.latest ? '更新' : '回滚')
            },
          }]),
          rows: versions,
          rowKey: function (r) { return r.ref || r.id },
          density: 'sm',
        })
        : h(DfEmpty, {
          icon: 'layers', title: '还没有版本',
          hint: result && result.localOnly ? '未配置发布源' : '点「检测更新」重新拉取发布列表',
        })),

    /* 作者署名放这里而不是顶栏主名：标题栏挂个人 ID 会让面板读起来像个人 demo，
       但「谁做的」总该有个地方说得出口 —— 这一块就是那个地方。 */
    h(DfCard, { title: '关于', icon: 'info' },
      h('div', { className: 'df-detail' },
        h('div', { className: 'df-detail-p' }, 'SAFE · 面向授权项目的渗透测试工作台，把靶标、资产、漏洞、成果与报告串联成一条完整工作流。'),
        h('div', { className: 'df-about' },
          h('div', { className: 'df-about-row' },
            h('span', null, '作者'),
            h('b', null, 'lrxG'),
            h('span', { className: 'df-about-tag' }, '面板与插件')),
          h('div', { className: 'df-about-row' },
            h('span', null, '发行'),
            h('b', null, info.repo || 'github.com/lrxG/dsh-forge'),
            h('span', { className: 'df-about-tag' }, 'GitHub Releases')),
          h('div', { className: 'df-about-row' },
            h('span', null, '面板版本'),
            h('b', null, d.plugin_version || '—'),
            h('span', { className: 'df-about-tag' }, d.channelLabel || '正式版'))),
        h('div', { className: 'df-note' }, '更新不影响靶标数据、报告与截图。'))),

    h(DfCard, {
      title: '维护操作', icon: 'wrench', sub: '会重启客户端或移除插件文件',
    },
      h('div', { className: 'df-formgrid' },
        h('div', { className: 'df-field' },
          h('label', null, '重启 DeepSeek Harness'),
          h('div', { className: 'df-hint' }, '补丁写入后没自动重启时用；面板会跟着宿主一起重开。'),
          h('div', { className: 'df-formfoot' },
            h(DfBtn, {
              size: 'sm', kind: 'ghost', icon: 'refresh', disabled: !!riskBusy,
              onClick: function () { risk('/dsh-forge/restart', 'restart', '已发起重启，DeepSeek Harness 会自己重开') },
            }, riskBusy === 'restart' ? '重启中…' : '立即重启'))),
        h('div', { className: 'df-field' },
          h('label', null, '卸载插件'),
          h('div', { className: 'df-hint' }, '还原所有改动、移除插件文件并重启客户端；不可撤销。'),
          h('div', { className: 'df-formfoot' },
            h(DfBtn, {
              size: 'sm', kind: confirmUn ? 'solid-danger' : 'danger', icon: 'trash',
              disabled: !!riskBusy,
              onBlur: function () { setConfirmUn(false) },
              onClick: function () {
                if (!confirmUn) { setConfirmUn(true); return }
                setConfirmUn(false)
                risk('/dsh-forge/uninstall', 'uninstall', '已卸载并还原，正在重启…')
              },
            }, riskBusy === 'uninstall' ? '卸载中…' : (confirmUn ? '确认卸载' : '卸载插件'))))))
  )
}

/* ---------------------------------------------------------------- 入口 */

function DfMaintenance(props) {
  const [tab, setTab] = useState('patch')
  const state = dfUseAsync(function () {
    return dfHost('/dsh-forge/status')
  }, [props.tick])
  const d = state.data || {}
  const pending = Number(d.patches_pending || 0)

  return h('div', { className: 'df-ops' },
    /* 设置页也走同一套首屏：标题 + 说明 + 状态。分段标签留在卡片里，
       因为它是「这一页内部的几个板块」，不是页面级导航。 */
    h('div', { className: 'df-opsbar' },
      h('span', { className: 'df-ops-title' }, '维护'),
      h('span', { className: 'df-spacer' }),
      h('span', { className: 'df-ops-meta' },
        d.ok === false ? '宿主接口不可用' : (d.surface
          ? ((d.surface === 'desktop' ? '桌面版' : d.surface === 'web' ? 'Web 版' : d.surface) + ' · ' + (d.plugin_version || '—'))
          : '正在读取宿主状态…'))),

    h(DfCard, null,
      h('div', { className: 'df-opsbar df-opsbar--pad' },
        h(DfSeg, {
          value: tab,
          items: [
            ['patch', '补丁' + (pending ? ' · ' + pending : '')],
            ['hooks', '钩子'],
            ['update', '更新'],
          ],
          onChange: function (k) { setTab(k) },
        })),
      h('div', { className: 'df-maint' },
        tab === 'patch' ? h(DfPatchPanel, { tick: props.tick, onInspect: props.onInspect }) : null,
        tab === 'hooks' ? h(DfHooksPanel, { tick: props.tick }) : null,
        tab === 'update' ? h(DfUpdatePanel, { tick: props.tick }) : null))
  )
}


/* ---- lib/client/38-gates.js ---- */
/* 门禁与宿主集成（P4 收尾）。
   · 用户须知：首装一次，勾一次不再弹（localStorage）。
   · 红队面板授权：5 秒倒计时 + 声明滚到底 + 三项勾选；授权落在
     $DSH_HOME/redteam/drill-grant.json，卸载时随之清除。
   · 回退：往 conversation.input.right 注入「回退」，走宿主同一份 /dsh-forge/rewind。
   宿主服务由 apply 注入；拿不到时整体降级，不阻断宿主自身功能。 */

const DF_NOTICE_KEY = 'dsh-forge-user-notice-v1'
const DF_AUTH_KEY = 'dsh-forge-drill-auth'
const DF_DRAFT_KEY = 'dshp-rewind-draft:'
const DF_ARM_KEY = 'dshp-rewind-arm:'
const DF_FILL_DELAYS = [0, 50, 180, 400, 800]
const DF_ARM_TTL_MS = 45 * 1000

const DF_LEGAL_HTML = `
<h3>严正法律免责与合规使用声明</h3>
<p>本声明在进入红队面板前必须全文阅读。本项目是非营利开源项目，遵守国家法律法规及所在平台的规范，仅供学习与研究、技术参考。严禁任何主体把本项目用于商业售卖、付费倒卖或黑灰产牟利。</p>
<p>开发者坚决反对并严禁任何形式的违法犯罪，绝不支持、不鼓励、不协助未授权网络攻击、漏洞利用、数据窃取、非法侵入计算机信息系统，或生成违法违禁内容。任何将本项目用于违法犯罪的行为，均与开发者无关，由行为人依法独立承担全部法律责任。不得以科研、教学、测试、演示或内部学习为由规避下列条款。</p>
<h3>1. 本仓库不含违法内容</h3>
<p>SAFE 发布的代码、文档、补丁与默认提示词不是木马、后门、未授权渗透工具、勒索软件、撞库脚本，也不是针对公网或第三方系统的攻击载荷。项目不提供违法内容，也不教唆、组织、协助实施违法犯罪。</p>
<h3>2. 本机操作不构成对外授权</h3>
<p>应用补丁、写入、回滚、卸载，都在本机文件和本机进程内完成。这些操作不对任何公网主机或未授权系统进行扫描、探测、入侵或攻击发包，也不得把本机当作跳板。</p>
<p>插件若开启检测更新，仅可能访问本插件自己的 GitHub 仓库以核对版本。该访问与对第三方系统的网络攻击无关，不能被解释为对外渗透的授权。</p>
<h3>3. 允许使用的范围</h3>
<p>只允许用在你能证明有权处理的环境：本人有权管理的本机官方 Harness；离线的本地合成靶标；所有者已经出具合法书面授权的网络安全演练靶场；合规实验室里的受控环境。书面授权要能对应具体目标、时间和范围。只填写一个单位名称，或只有口头说法，不构成授权。</p>
<p>未经所有者合法书面授权的目标、公网在线系统、生产业务，以及能源、交通、水利、金融、公共服务、电子政务等关键信息基础设施，都不得作为演练对象。</p>
<h3>4. 必须遵守的法律，按条、款</h3>
<p>《中华人民共和国刑法》第二百八十五条第一款：禁止违反国家规定，侵入国家事务、国防建设、尖端科学技术领域的计算机信息系统。</p>
<p>同条第二款：禁止侵入前款规定以外的计算机信息系统，或者用其他技术手段，获取该系统中存储、处理或者传输的数据，或者对该系统实施非法控制。</p>
<p>同条第三款：禁止提供专门用于侵入、非法控制计算机信息系统的程序、工具；明知他人实施侵入、非法控制而为其提供程序、工具，同样禁止。</p>
<p>第二百八十六条第一款：禁止对计算机信息系统功能进行删除、修改、增加、干扰，造成系统不能正常运行。</p>
<p>同条第二款：禁止对系统中存储、处理或者传输的数据和应用程序进行删除、修改、增加。</p>
<p>同条第三款：禁止故意制作、传播计算机病毒等破坏性程序，影响计算机系统正常运行。</p>
<p>第二百八十七条：禁止利用计算机实施金融诈骗、盗窃、贪污、挪用公款、窃取国家秘密或者其他犯罪。</p>
<p>第二百八十七条之一第一款第（一）项：禁止设立用于实施诈骗、传授犯罪方法、制作或者销售违禁物品、管制物品等违法犯罪活动的网站、通讯群组。</p>
<p>同款第（二）项：禁止发布有关制作或者销售毒品、枪支、淫秽物品等违禁物品、管制物品或者其他违法犯罪的信息。</p>
<p>同款第（三）项：禁止为实施诈骗等违法犯罪活动发布信息。</p>
<p>第二百八十七条之二：禁止明知他人利用信息网络实施犯罪，仍为其提供技术支持，或者提供广告推广、支付结算等帮助。</p>
<p>第二百五十三条之一第一款、第三款：禁止向他人出售或者提供公民个人信息；禁止窃取或者以其他方法非法获取公民个人信息。</p>
<p>《中华人民共和国网络安全法》第十三条第二款：使用网络不得危害网络安全，不得利用网络从事危害国家安全、荣誉和利益，煽动颠覆国家政权、推翻社会主义制度，煽动分裂国家、破坏国家统一，宣扬恐怖主义、极端主义，宣扬民族仇恨、民族歧视，传播暴力、淫秽色情信息，编造、传播虚假信息扰乱经济秩序和社会秩序，以及侵害他人名誉、隐私、知识产权和其他合法权益等活动。</p>
<p>第十四条：禁止利用网络从事危害未成年人身心健康的活动。</p>
<p>第二十九条：禁止非法侵入他人网络、干扰他人网络正常功能、窃取网络数据；禁止提供专门用于侵入网络、干扰网络正常功能及防护措施、窃取网络数据的程序、工具；明知他人从事危害网络安全的活动，禁止为其提供技术支持、广告推广、支付结算等帮助。</p>
<p>第三十三条：公共通信和信息服务、能源、交通、水利、金融、公共服务、电子政务等关键信息基础设施实行重点保护。未获合法授权，不得侵入、干扰或破坏。</p>
<p>第四十六条：禁止窃取或者以其他非法方式获取个人信息，禁止非法出售或者非法向他人提供个人信息。</p>
<p>第四十八条：禁止设立用于实施诈骗，传授犯罪方法，制作或者销售违禁物品、管制物品等违法犯罪活动的网站、通讯群组；禁止利用网络发布涉及上述违法犯罪活动的信息。</p>
<p>第五十条：发送的电子信息、提供的应用软件不得设置恶意程序，不得含有法律、行政法规禁止发布或者传输的信息。</p>
<p>《中华人民共和国数据安全法》第八条：开展数据处理活动，不得危害国家安全、公共利益，不得损害个人、组织的合法权益。</p>
<p>第三十二条第一款：收集数据应当采取合法、正当的方式，不得窃取或者以其他非法方式获取数据。</p>
<p>同条第二款：法律、行政法规对收集、使用数据的目的和范围有规定的，只能在该目的和范围内收集、使用。</p>
<p>第五十一条：窃取或者以其他非法方式获取数据，或者因此损害个人、组织合法权益的，依照有关法律、行政法规处罚。</p>
<p>《中华人民共和国个人信息保护法》第五条：处理个人信息应当合法、正当、必要、诚信，不得通过误导、欺诈、胁迫等方式处理。</p>
<p>第六条第一款、第二款：处理个人信息应当具有明确、合理的目的，并与该目的直接相关，采取对个人权益影响最小的方式；收集限于实现处理目的的最小范围，不得过度收集。</p>
<p>第十条：禁止非法收集、使用、加工、传输他人个人信息，禁止非法买卖、提供或者公开他人个人信息；禁止从事危害国家安全、公共利益的个人信息处理活动。</p>
<p>第十三条：没有取得个人同意，也不属于订立履行合同所必需、履行法定职责、应对突发、公共利益新闻舆论、处理本人已经合法公开的信息，以及法律行政法规规定的其他情形之一的，不得处理个人信息。</p>
<p>第二十八条、第二十九条：生物识别、医疗健康、金融账户、行踪轨迹，以及不满十四周岁未成年人的个人信息，属于敏感个人信息。没有特定目的、充分必要性和严格保护措施，并且没有取得个人单独同意的，不得处理。</p>
<p>此外还须遵守其他现行有效的法律、行政法规、监管规定，以及所使用模型的服务条款与滥用政策。</p>
<h3>5. 据此禁止的方向</h3>
<p>未授权进入。禁止把没有书面授权的单位、域名、地址、公网系统、生产业务或关键信息基础设施登记为靶标，禁止对其扫描、探测、侵入、控制或发包。对应刑法第二百八十五条第一款、第二款，网络安全法第二十九条、第三十三条。</p>
<p>破坏与恶意程序。禁止删除、修改、增加、干扰他人系统功能或其中的数据、应用程序；禁止制作、传播病毒、勒索程序或其他破坏性程序；禁止在信息或软件中设置恶意程序。对应刑法第二百八十六条第一款至第三款，网络安全法第五十条。</p>
<p>工具与帮助。禁止把本项目或本机提供给他人，用于侵入、非法控制或窃取数据；禁止明知对方在实施网络犯罪，仍提供程序、工具、技术支持、广告推广或支付结算。对应刑法第二百八十五条第三款、第二百八十七条之二，网络安全法第二十九条。</p>
<p>数据。禁止窃取、非法收集、超范围使用、泄露、出售或向他人提供业务数据、账号、口令和其他受保护数据。对应数据安全法第八条、第三十二条、第五十一条。</p>
<p>个人信息。禁止非法收集、使用、加工、传输、买卖、提供或公开他人个人信息；禁止过度收集；禁止以误导、欺诈、胁迫方式处理；禁止擅自处理生物识别、医疗健康、金融账户、行踪轨迹和儿童个人信息。对应刑法第二百五十三条之一第一款、第三款，网络安全法第四十六条，个人信息保护法第五条、第六条、第十条、第十三条、第二十八条、第二十九条。</p>
<p>诈骗与违法信息。禁止设立或利用网站、群组实施诈骗、传授犯罪方法、制作或销售违禁物品、管制物品；禁止发布此类信息；禁止利用计算机实施诈骗、盗窃、贪污、挪用公款、窃取国家秘密。对应刑法第二百八十七条、第二百八十七条之一第一款第（一）项至第（三）项，网络安全法第四十八条。</p>
<p>内容。禁止生成或传播危害国家安全、荣誉和利益的内容，禁止煽动颠覆、分裂，禁止恐怖主义、极端主义、民族仇恨，禁止暴力、淫秽色情、赌博，禁止编造虚假信息扰乱经济秩序和社会秩序，禁止侵害名誉、隐私、知识产权，禁止危害未成年人身心健康的内容。对应网络安全法第十三条第二款、第十四条。</p>
<p>结果扩散。演练中形成的记录、资产信息和文件，只留在书面授权写明的目标和期限里，不得交给无权获知的人，也不得改作授权以外的用途。</p>
<h3>6. 责任由使用者承担</h3>
<p>本项目依据 MIT 协议按现状提供。开发者不就完整性、安全性与适用性作保证。使用者对自己的下载、部署、运行、修改、传播，以及全部输入与输出，承担独立、完全的民事、行政及刑事法律责任。作者与贡献者不承担因滥用产生的直接、间接或连带责任。</p>
<p>勾选确认的是操作者本人，不能代替没有阅读本声明的人，也不能把别人的系统说成已经授权。</p>
<h3>7. 违约即终止授权</h3>
<p>一旦用于非法攻击、恶意活动或上述任一禁止方向，使用许可自该行为发生之日起自动终止，且不可撤销。必须立即停止使用，并销毁本项目的代码、脚本与衍生数据，依法承担责任。授权终止后，红队面板不得继续打开或继续使用。</p>
<h3>8. 与 DeepSeek 官方的关系</h3>
<p>本项目是独立的开源项目，与 DeepSeek 官方或其关联主体没有隶属、商业合作、授权或官方背书。文中的「官方」只表示评测对象是使用者本机安装的官方 DeepSeek Harness 软件包，不代表 DeepSeek 官方开发、认可或担保本插件。</p>
<p>文末。倒计时结束、滚到这里并勾选全部三项，才表示你以本人身份认可本声明，并完成本次红队面板授权。</p>
`

/* ---------------------------------------------------------------- 宿主服务 */

const dfHostSvc = { ctx: null, sessions: null, workspace: null, conversation: null }
let dfRewindSeenAt = 0
let dfArmedFill = { sessionId: '', text: '', at: 0 }
let dfPendingDraft = { sessionId: '', text: '', at: 0 }

function dfInstallHost(ctx) {
  if (!ctx || typeof ctx !== 'object') return
  dfHostSvc.ctx = ctx
  try { if (ctx.sessions) dfHostSvc.sessions = ctx.sessions } catch (e) { /* 旧宿主可能没有 */ }
  try { if (ctx.uiWorkspace) dfHostSvc.workspace = ctx.uiWorkspace } catch (e) { /* ignore */ }
  try { if (ctx.conversation) dfHostSvc.conversation = ctx.conversation } catch (e) { /* ignore */ }
}

function dfCurrentSessionId() {
  try {
    const sel = dfHostSvc.workspace && dfHostSvc.workspace.selection
      ? dfHostSvc.workspace.selection.getSnapshot && dfHostSvc.workspace.selection.getSnapshot()
      : null
    if (sel && typeof sel.sessionId === 'string' && sel.sessionId) return sel.sessionId
  } catch (e) { /* ignore */ }
  try {
    const snap = dfHostSvc.sessions && dfHostSvc.sessions.list && dfHostSvc.sessions.list.getSnapshot
      ? dfHostSvc.sessions.list.getSnapshot()
      : null
    if (snap && typeof snap.current === 'string' && snap.current) return snap.current
  } catch (e) { /* ignore */ }
  return ''
}

function dfSessionKnown(sessionId) {
  if (!sessionId) return false
  try {
    const snap = dfHostSvc.sessions && dfHostSvc.sessions.list && dfHostSvc.sessions.list.getSnapshot
      ? dfHostSvc.sessions.list.getSnapshot()
      : null
    if (!snap) return false
    if (snap.byId && Object.prototype.hasOwnProperty.call(snap.byId, sessionId)) return true
    if (Array.isArray(snap.ids) && snap.ids.indexOf(sessionId) >= 0) return true
  } catch (e) { /* ignore */ }
  return false
}

function dfSessionSnapshot(sessionId) {
  if (!sessionId) return null
  try {
    const snap = dfHostSvc.sessions && dfHostSvc.sessions.list && dfHostSvc.sessions.list.getSnapshot
      ? dfHostSvc.sessions.list.getSnapshot()
      : null
    if (snap && snap.byId && snap.byId[sessionId]) return snap.byId[sessionId]
  } catch (e) { /* ignore */ }
  try {
    const actx = dfHostSvc.sessions && typeof dfHostSvc.sessions.scope === 'function'
      ? dfHostSvc.sessions.scope(sessionId) : undefined
    const face = actx && dfHostSvc.sessions && typeof dfHostSvc.sessions.sessionOf === 'function'
      ? dfHostSvc.sessions.sessionOf(actx) : undefined
    if (face && typeof face.getSnapshot === 'function') return face.getSnapshot()
    if (face) return face
  } catch (e) { /* ignore */ }
  return null
}

function dfWaitMs(ms) {
  return new Promise(function (resolve) { window.setTimeout(resolve, ms) })
}

/* ---------------------------------------------------------------- 须知 / 授权 */

function dfReadNoticeAck() {
  try { return window.localStorage.getItem(DF_NOTICE_KEY) === '1' } catch (e) { return false }
}

function dfWriteNoticeAck() {
  try { window.localStorage.setItem(DF_NOTICE_KEY, '1') } catch (e) { /* ignore */ }
}

const dfAuthState = { ready: false, granted: false, posting: 0, subs: new Set() }

function dfAuthReadLocal() {
  try { return window.localStorage.getItem(DF_AUTH_KEY) === '1' } catch (e) { return false }
}

function dfAuthGranted() {
  return dfAuthState.ready ? dfAuthState.granted : dfAuthReadLocal()
}

function dfAuthSet(ok) {
  dfAuthState.ready = true
  dfAuthState.granted = !!ok
  try {
    if (ok) window.localStorage.setItem(DF_AUTH_KEY, '1')
    else window.localStorage.removeItem(DF_AUTH_KEY)
  } catch (e) { /* ignore */ }
  dfAuthState.subs.forEach(function (fn) { try { fn(dfAuthState.granted) } catch (e) { /* ignore */ } })
}

/** 授权：本地先记住，再尽力同步到当前安装目录。 */
function dfAuthGrant() {
  dfAuthSet(true)
  dfAuthState.posting += 1
  return dfHttp('/dsh-forge/drill-grant', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }, { ttl: 0 }).then(function (r) {
    dfAuthState.posting = Math.max(0, dfAuthState.posting - 1)
    return r
  }, function (e) {
    dfAuthState.posting = Math.max(0, dfAuthState.posting - 1)
    return { ok: false, error: String((e && e.message) || e) }
  })
}

/** 与安装目录里的授权对齐：文件没了（例如卸载后重装）就重新确认。 */
function dfAuthSync() {
  return dfHttp('/dsh-forge/drill-grant', {}, { ttl: 0 }).then(function (r) {
    if (!r || r.ok === false) return r
    if (dfAuthState.posting > 0) return r
    dfAuthSet(!!r.granted)
    return r
  }, function () { return null })
}

/* ---------------------------------------------------------------- 规则：红队模式 */

function dfRedteamPreset(value) {
  const text = String(value || '').trim()
  if (!text) return false
  if (text === 'redteam') return true
  if (/^red[\s_-]*team$/i.test(text)) return true
  const label = text.replace(/不是红队/g, '').replace(/非红队/g, '')
  return /红队/.test(label)
}

function dfReadPreset(sess) {
  if (!sess || typeof sess !== 'object') return ''
  try { if (sess.projectionValues && typeof sess.projectionValues.agentPreset === 'string') return sess.projectionValues.agentPreset } catch (e) { /* ignore */ }
  try { if (typeof sess.agentPreset === 'string') return sess.agentPreset } catch (e) { /* ignore */ }
  try { if (sess.header && typeof sess.header.agentPreset === 'string') return sess.header.agentPreset } catch (e) { /* ignore */ }
  return ''
}

function dfIsRedteamActive() {
  const sid = dfCurrentSessionId()
  if (sid) {
    const sess = dfSessionSnapshot(sid)
    if (dfRedteamPreset(dfReadPreset(sess))) return true
  }
  /* 宿主没暴露会话字段时退回语义化标记；只认明确的「红队模式」文本。 */
  try {
    if (document.querySelector("[data-agent-preset='redteam'],[data-preset-id='redteam'],[data-mode='redteam']")) return true
    const nodes = document.querySelectorAll(
      "[class*='seat' i][class*='label' i],[class*='preset' i][class*='label' i],[title*='红队']"
    )
    for (let i = 0; i < nodes.length; i += 1) {
      const text = String(nodes[i].textContent || '').replace(/\s+/g, ' ').trim()
      if (/红队模式/.test(text)) return true
    }
  } catch (e) { /* ignore */ }
  return false
}

/* ---------------------------------------------------------------- 输入框回退 */

function dfConversationFace() {
  if (dfHostSvc.conversation) return dfHostSvc.conversation
  const ctx = dfHostSvc.ctx
  if (ctx && typeof ctx.get === 'function') {
    try { return ctx.get('conversation') } catch (e) { /* ignore */ }
  }
  return undefined
}

function dfConversationInput(sessionId) {
  try {
    const input = dfConversationFace() && dfConversationFace().input
    if (!input || !sessionId) return null
    if (typeof input.shell === 'function') {
      try { return input.shell(sessionId) } catch (e) { /* 会话还没挂上 */ }
    }
    const sessions = dfHostSvc.sessions
    const actx = sessions && typeof sessions.scope === 'function' ? sessions.scope(sessionId) : undefined
    if (typeof input.for === 'function' && actx) return input.for(actx)
    return null
  } catch (e) {
    return null
  }
}

function dfHostSvcSetDraft(sessionId, text) {
  if (!sessionId) return false
  try {
    const input = dfConversationInput(sessionId)
    if (input && typeof input.setDraft === 'function') {
      input.setDraft(text || '')
      return true
    }
  } catch (e) { /* ignore */ }
  return false
}

/** 把一段文字放进当前会话输入框（不自动发送，用户确认后自己发）。 */
function dfDraftToComposer(text, okLabel) {
  const sid = dfCurrentSessionId()
  if (!sid) {
    dfToast('先在 DeepSeek Harness 里打开一个会话，再把内容放进输入框', 'err', 3600)
    return false
  }
  if (!dfHostSvcSetDraft(sid, text)) {
    dfToast('当前会话输入框不可用，请手动复制', 'err', 3600)
    return false
  }
  dfToast((okLabel || '已放入输入框') + '，确认后发送', 'ok', 3200)
  return true
}

function dfFillComposer(inputActions, text) {
  if (inputActions && typeof inputActions.setDraft === 'function') {
    try { inputActions.setDraft(text || '') } catch (e) { /* ignore */ }
  }
}

function dfLiveDraft(sessionId, inputActions) {
  try {
    const fromActions = inputActions && inputActions.state && inputActions.state.getSnapshot
      ? inputActions.state.getSnapshot() : null
    if (fromActions && typeof fromActions.draft === 'string') return fromActions.draft
  } catch (e) { /* ignore */ }
  try {
    const input = dfConversationInput(sessionId)
    const snap = input && input.state && input.state.getSnapshot ? input.state.getSnapshot() : null
    if (snap && typeof snap.draft === 'string') return snap.draft
  } catch (e) { /* ignore */ }
  return ''
}

function dfIsPluginDraft(text) {
  const value = String(text || '').trim()
  if (!value) return false
  return /^\[MNEMON\]/i.test(value)
    || /MNEMON RUNTIME MEMORY SNAPSHOT/i.test(value)
    || /^MNEMON VIEW TOOLS/im.test(value)
}

function dfWriteDraft(sessionId, text) {
  if (!sessionId) return
  const value = dfIsPluginDraft(text) ? '' : (text || '')
  dfPendingDraft = { sessionId: sessionId, text: value, at: Date.now() }
  try { window.sessionStorage.setItem(DF_DRAFT_KEY + sessionId, value) } catch (e) { /* ignore */ }
}

function dfPeekDraft(sessionId) {
  if (!sessionId) return ''
  if (dfPendingDraft.sessionId === sessionId && dfPendingDraft.text) return dfPendingDraft.text
  try { return window.sessionStorage.getItem(DF_DRAFT_KEY + sessionId) || '' } catch (e) { return '' }
}

function dfClearStoredDraft(sessionId) {
  if (!sessionId) return
  if (dfPendingDraft.sessionId === sessionId) dfPendingDraft = { sessionId: '', text: '', at: 0 }
  try { window.sessionStorage.removeItem(DF_DRAFT_KEY + sessionId) } catch (e) { /* ignore */ }
  try { window.sessionStorage.removeItem(DF_ARM_KEY + sessionId) } catch (e) { /* ignore */ }
}

function dfArmFill(sessionId, text) {
  if (!sessionId || !text || dfIsPluginDraft(text)) return
  const at = Date.now()
  dfArmedFill = { sessionId: sessionId, text: text, at: at }
  dfWriteDraft(sessionId, text)
  try { window.sessionStorage.setItem(DF_ARM_KEY + sessionId, String(at)) } catch (e) { /* ignore */ }
}

function dfTakeArmedFill(sessionId) {
  if (!sessionId) return ''
  let text = ''
  let at = 0
  if (dfArmedFill.sessionId === sessionId && dfArmedFill.text) {
    text = dfArmedFill.text
    at = dfArmedFill.at
  } else {
    text = dfPeekDraft(sessionId)
    try { at = Number(window.sessionStorage.getItem(DF_ARM_KEY + sessionId) || 0) } catch (e) { at = 0 }
  }
  if (!text || !at || Date.now() - at > DF_ARM_TTL_MS) {
    if (text && (!at || Date.now() - at > DF_ARM_TTL_MS)) dfClearStoredDraft(sessionId)
    return ''
  }
  dfClearStoredDraft(sessionId)
  dfArmedFill = { sessionId: '', text: '', at: 0 }
  return text
}

function dfScheduleFill(sessionId, text, inputActions) {
  if (!sessionId || !text || dfIsPluginDraft(text)) return function () {}
  let stopped = false
  let filled = false
  const timers = []
  const tryFill = function () {
    if (stopped) return
    const current = dfLiveDraft(sessionId, inputActions)
    if (filled && current !== text) { stopped = true; return }
    if (current && current !== text) { stopped = true; return }
    dfFillComposer(inputActions, text)
    dfHostSvcSetDraft(sessionId, text)
    filled = true
  }
  DF_FILL_DELAYS.forEach(function (ms) { timers.push(window.setTimeout(tryFill, ms)) })
  return function () {
    stopped = true
    timers.forEach(function (id) { try { window.clearTimeout(id) } catch (e) { /* ignore */ } })
  }
}

async function dfDropQueue(sessionId) {
  const sessions = dfHostSvc.sessions
  if (!sessions || !sessionId) return
  const drop = async function () {
    try {
      const actx = typeof sessions.scope === 'function' ? sessions.scope(sessionId) : undefined
      const face = typeof sessions.sessionOf === 'function' ? sessions.sessionOf(actx) : undefined
      const snap = face && typeof face.getSnapshot === 'function' ? face.getSnapshot() : face
      const queue = (snap && snap.queue) || []
      for (let i = 0; i < queue.length; i += 1) {
        const id = queue[i] && (queue[i].id || queue[i].itemId)
        if (!id) continue
        try { await face.updateQueue(id, { kind: 'remove' }) } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
  }
  await drop()
  window.setTimeout(function () { drop() }, 80)
}

async function dfOpenSession(sessionId) {
  if (!sessionId) return
  const sessions = dfHostSvc.sessions
  const workspace = dfHostSvc.workspace
  let lastError = null
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (sessions && typeof sessions.refresh === 'function' && !dfSessionKnown(sessionId)) {
      try { await sessions.refresh() } catch (e) { lastError = e }
    }
    const known = dfSessionKnown(sessionId)
    if (known || (sessions && typeof sessions.open === 'function')) {
      try {
        if (workspace && typeof workspace.openSession === 'function') workspace.openSession(sessionId)
        else if (sessions && typeof sessions.open === 'function') sessions.open(sessionId)
        else throw new Error('无法打开回退后的会话')
        const selected = workspace && workspace.selection && workspace.selection.getSnapshot
          ? (workspace.selection.getSnapshot() || {}).sessionId : ''
        if (!workspace || selected === sessionId) {
          await dfDropQueue(sessionId)
          window.setTimeout(function () { dfDropQueue(sessionId) }, 250)
          return
        }
      } catch (e) {
        lastError = e
      }
    }
    await dfWaitMs(120)
  }
  throw new Error((lastError && lastError.message) || '回退后的会话没有打开')
}

/* ---------------------------------------------------------------- 须知 / 授权 UI */

function DfWelcomeNotice(props) {
  const [open, setOpen] = useState(function () { return !dfReadNoticeAck() })
  const [checked, setChecked] = useState(false)
  if (!open) return null
  return h('div', { className: 'df-mask df-portal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '用户须知' },
    h('div', { className: 'df-modal' },
      h('div', { className: 'df-modal-hd' },
        h('span', { className: 'df-mark' }, dfIcon('shield', 15)),
        h('div', { className: 'df-mh-t' },
          h('h2', null, '用户须知'),
          h('p', null, '首次安装请阅读以下说明；确认后不再弹出。'))),
      h('div', { className: 'df-modal-bd' },
        h('div', { className: 'df-warnbox' },
          '本插件本体永久免费，付费仅为人工知识服务（部署指导、讲解、答疑）。任何把插件本体包装成付费商品出售的行为均不被授权。'),
        h('p', null, '本插件是 DeepSeek Harness 的本机网络安全红队插件：在受控本机环境中调整提示词与补丁、做授权范围内的红队面板操作。'),
        h('h3', null, '禁止事项'),
        h('p', null, '禁止将本项目用于未授权的网络攻击、入侵、窃取数据、破坏系统或任何违法犯罪。'),
        h('p', null, '禁止商业售卖、付费倒卖、黑灰产牟利，以及未经授权对本仓库的再分发。'),
        h('p', null, '使用者须自行遵守所在地法律法规与平台规范；违法后果由行为人自行承担，与作者无关。'),
        h('p', null, '破解模式仅用于自有或授权样本；禁止对他人软件破解后传播盗版、倒卖或用于牟利。')),
      h('div', { className: 'df-modal-ft' },
        h('label', { className: 'df-check' + (checked ? ' is-on' : '') },
          h('input', {
            type: 'checkbox', checked: checked,
            onChange: function (e) { setChecked(!!(e && e.target && e.target.checked)) },
          }),
          h('span', null, '我已阅读并理解上述用户须知，同意合法合规使用。')),
        h('span', { className: 'df-spacer' }),
        h(DfBtn, {
          kind: 'primary', icon: 'check', disabled: !checked,
          onClick: function () {
            if (!checked) return
            dfWriteNoticeAck()
            setOpen(false)
            if (props.onAck) props.onAck()
          },
        }, '我已知晓并继续'))))
}

function DfAuthGate(props) {
  const [left, setLeft] = useState(5)
  const [readEnd, setReadEnd] = useState(false)
  const [checks, setChecks] = useState({ read: false, scope: false, ban: false })
  const [busy, setBusy] = useState(false)
  const legalRef = useRef(null)

  useEffect(function () {
    const id = window.setInterval(function () {
      setLeft(function (n) {
        if (n <= 1) { window.clearInterval(id); return 0 }
        return n - 1
      })
    }, 1000)
    return function () { window.clearInterval(id) }
  }, [])

  useEffect(function () {
    const el = legalRef.current
    if (el && el.scrollHeight <= el.clientHeight + 4) setReadEnd(true)
  }, [])

  /* Esc 等同「暂不进入」：授权窗不该只能点按钮才退得出去。 */
  useEffect(function () {
    const onKey = function (e) {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      if (props.onCancel) props.onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return function () { window.removeEventListener('keydown', onKey, true) }
  }, [props.onCancel])

  const locked = left > 0 || !readEnd
  const ready = !locked && checks.read && checks.scope && checks.ban
  const hint = left > 0
    ? '请阅读声明。' + left + ' 秒后才能勾选。'
    : (readEnd ? '倒计时已结束。请勾选全部三项。' : '倒计时已结束。请把声明滚到文末，再勾选。')

  function onScroll() {
    const el = legalRef.current
    if (!el) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 8) setReadEnd(true)
  }

  function toggle(key) {
    if (locked) return
    setChecks(function (prev) {
      const next = Object.assign({}, prev)
      next[key] = !next[key]
      return next
    })
  }

  function confirm() {
    if (!ready || busy) return
    setBusy(true)
    dfAuthGrant().then(function () {
      setBusy(false)
      if (props.onGranted) props.onGranted()
    }, function () {
      setBusy(false)
      if (props.onGranted) props.onGranted()
    })
  }

  const items = [
    ['read', '我已读完《安全与禁止违法声明》，并认可其中的全部条款。'],
    ['scope', '我确认只用在本机已授权环境、离线靶标或合规演练中。'],
    ['ban', '我确认禁止任何违法用途。未完成本授权，不得使用红队面板。'],
  ]

  return h('div', { className: 'df-mask df-portal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '红队面板授权确认' },
    h('div', { className: 'df-modal df-modal--wide' },
      h('div', { className: 'df-modal-hd' },
        h('span', { className: 'df-mark is-warn' }, dfIcon('shield', 15)),
        h('div', { className: 'df-mh-t' },
          h('h2', null, '红队面板授权确认'),
          h('p', null, '第一次进入红队面板，或打开全面浏览，都要先完成本窗。'))),
      h('div', { className: 'df-modal-bd' },
        h('div', { className: 'df-warnbox' },
          '安全警告：红队面板只用于你有权管理的本机、离线靶标，或已书面授权的演练环境。未经授权的渗透、攻击、窃取和破坏一律禁止。'),
        h('div', {
          className: 'df-legal', ref: legalRef, onScroll: onScroll,
          dangerouslySetInnerHTML: { __html: DF_LEGAL_HTML },
        }),
        h('div', { className: 'df-modal-hint' }, hint),
        items.map(function (row) {
          return h('label', {
            key: row[0],
            className: dfCx('df-check', locked && 'is-locked', checks[row[0]] && !locked && 'is-on'),
          },
            h('input', {
              type: 'checkbox', checked: !!checks[row[0]], disabled: locked,
              onChange: function () { toggle(row[0]) },
            }),
            h('span', null, row[1]))
        })),
      h('div', { className: 'df-modal-ft' },
        h(DfBtn, { kind: 'ghost', onClick: function () { if (props.onCancel) props.onCancel() } }, '暂不进入'),
        h('span', { className: 'df-spacer' }),
        h(DfBtn, { kind: 'primary', icon: 'check', disabled: !ready || busy, onClick: confirm },
          busy ? '授权中…' : (ready ? '确认授权并进入红队面板' : '确认授权')))))
}

/* ---------------------------------------------------------------- 回退按钮 */

function DfRewindMenu(props) {
  const node = h('div', {
    className: 'df-rewind-menu df-portal',
    role: 'menu',
    ref: props.menuRef,
    style: props.pos
      ? { left: props.pos.left + 'px', top: props.pos.top + 'px' }
      : { left: '8px', bottom: '48px', transform: 'none' },
  },
    h('button', {
      type: 'button', className: 'df-rewind-item',
      onMouseDown: function (e) { e.preventDefault(); e.stopPropagation() },
      onClick: function (e) { e.preventDefault(); e.stopPropagation(); props.onPick('once') },
    },
      h('b', null, '回退一次'),
      h('span', null, '把这一轮发出去的那句放回输入框，并清掉这一轮')),
    h('button', {
      type: 'button', className: 'df-rewind-item',
      onMouseDown: function (e) { e.preventDefault(); e.stopPropagation() },
      onClick: function (e) { e.preventDefault(); e.stopPropagation(); props.onPick('round') },
    },
      h('b', null, '回退上一轮'),
      h('span', null, '把这一轮发出去的那句放回输入框；子代理也只撤这一轮')))

  try {
    const rd = require('react-dom')
    if (rd && typeof rd.createPortal === 'function' && typeof document !== 'undefined') {
      return rd.createPortal(node, document.body)
    }
  } catch (e) { /* 没有 portal 就挂在按钮旁 */ }
  return node
}

function DfRewindButton(props) {
  const sessionId = props.sessionId || dfCurrentSessionId()
  const inputActions = props.inputActions
  const wrapRef = useRef(null)
  const menuRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [menu, setMenu] = useState(false)
  const [menuPos, setMenuPos] = useState(null)

  useEffect(function () {
    if (!sessionId) return undefined
    const armed = dfTakeArmedFill(sessionId)
    if (!armed) return undefined
    return dfScheduleFill(sessionId, armed, inputActions)
  }, [sessionId, inputActions])

  useEffect(function () {
    if (!menu) return undefined
    const onDoc = function (e) {
      if (wrapRef.current && wrapRef.current.contains(e.target)) return
      if (menuRef.current && menuRef.current.contains(e.target)) return
      setMenu(false)
    }
    document.addEventListener('mousedown', onDoc)
    return function () { document.removeEventListener('mousedown', onDoc) }
  }, [menu])

  function run(mode) {
    if (!sessionId || busy) return
    setBusy(true)
    setMenu(false)
    setNotice('')
    dfHttp('/dsh-forge/rewind', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId, mode: mode }),
    }, { ttl: 0 }).then(function (data) {
      if (!data || !data.ok || !data.sessionId || data.cleared === false) {
        throw new Error((data && data.error) || '没有清掉之前发送的内容')
      }
      if (data.at) dfRewindSeenAt = data.at
      const text = dfIsPluginDraft(data.text) ? '' : (data.text || '')
      dfArmFill(data.sessionId, text)
      return dfOpenSession(data.sessionId).then(function () {
        dfScheduleFill(data.sessionId, text)
        setBusy(false)
      })
    }).catch(function (e) {
      setBusy(false)
      const text = '回退失败：' + String((e && e.message) || e)
      setNotice(text)
      dfToast(text, 'err', 5200)
    })
  }

  function toggleMenu(e) {
    if (e) { e.preventDefault(); e.stopPropagation() }
    if (!sessionId || busy) return
    if (menu) { setMenu(false); return }
    const rect = wrapRef.current && wrapRef.current.getBoundingClientRect
      ? wrapRef.current.getBoundingClientRect() : null
    if (rect) {
      setMenuPos({ left: Math.max(8, rect.right - 250), top: Math.max(8, rect.top - 8) })
    } else {
      setMenuPos(null)
    }
    setNotice('')
    setMenu(true)
  }

  const label = busy ? '回退中…' : (notice ? dfShort(notice, 14) : '回退')
  return h('div', { className: 'df-rewind-wrap', ref: wrapRef },
    h('button', {
      type: 'button',
      className: 'df-rewind',
      title: notice || '回退上一句',
      'aria-label': '回退',
      'aria-expanded': menu ? 'true' : 'false',
      disabled: busy || !sessionId,
      onMouseDown: function (e) { e.preventDefault() },
      onClick: toggleMenu,
    },
      h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true },
        h('path', {
          fill: 'currentColor',
          d: 'M7.2 3.2 3.4 7l3.8 3.8V8.6c2.8 0 4.7.7 5.9 2.3-.2-2.8-1.9-5.2-5.9-5.6V3.2z',
        })),
      label),
    menu ? h(DfRewindMenu, {
      pos: menuPos,
      menuRef: menuRef,
      onPick: run,
    }) : null)
}

/** 出错时退回一个纯文字按钮，绝不让插槽把宿主输入框带崩。 */
class DfRewindSafe extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error) {
    try { console.error('[dsh-forge] rewind slot:', error) } catch (e) { /* ignore */ }
  }
  render() {
    if (this.state.failed) {
      return h('button', {
        type: 'button', className: 'df-rewind', title: '回退',
        onMouseDown: function (e) { e.preventDefault() },
        onClick: function () { dfToast('回退按钮不可用：宿主接口变化', 'err', 3600) },
      }, '回退')
    }
    return h(DfRewindButton, this.props)
  }
}

let dfRewindInstalled = false

/** 注入口:回退按钮。slot / effect 都拿不到时静默跳过。 */
function dfInstallRewind(host) {
  if (dfRewindInstalled || !host) return
  const slots = host.slots || (dfHostSvc.ctx && dfHostSvc.ctx.slots)
  if (!slots || typeof slots.inject !== 'function') return
  dfRewindInstalled = true
  try {
    slots.inject('conversation.input.right', function () {
      return slots.register({
        name: 'conversation.input.right',
        id: 'dsh-forge-rewind',
        order: 20,
        inject: function (sessionId) { return { sessionId: sessionId } },
      }, DfRewindSafe)
    })
  } catch (e) {
    dfRewindInstalled = false
    try { console.warn('[dsh-forge] rewind slot skipped:', e && e.message) } catch (e2) { /* ignore */ }
    return
  }
  /* 别处触发的回退（CLI / 旧面板）也要把输入框填上。 */
  try {
    const start = function () {
      return window.setInterval(function () {
        dfHttp('/dsh-forge/rewind', {}, { ttl: 0 }).then(function (data) {
          if (!data || !data.sessionId || !data.at || data.at <= dfRewindSeenAt) return
          dfRewindSeenAt = data.at
          const current = dfCurrentSessionId()
          if (current && current !== data.parentId) return
          const text = dfIsPluginDraft(data.text) ? '' : (data.text || '')
          dfArmFill(data.sessionId, text)
          dfOpenSession(data.sessionId).then(function () {
            dfScheduleFill(data.sessionId, text)
          }, function () { /* ignore */ })
        }, function () { /* ignore */ })
      }, 1500)
    }
    if (typeof host.effect === 'function') host.effect(start, 'dsh-forge: rewind watch')
    else start()
  } catch (e) { /* watch 是锦上添花，失败不影响按钮 */ }
}


/* ---- lib/client/39-context.js ---- */
/* 上下文：把进入模型的东西摊开（操作员注入 / 规则 / 人格 / 技能 / 工具 / DeepSeek Harness 内置），
   只让真正生效的层可编辑；模板只改操作员注入层。 */

function DfContextToken(props) {
  return h('span', { className: 'df-chip df-chip--line', title: '按 2 字符 ≈ 1 Token 粗估' },
    '约 ' + dfNum(props.tokens || 0) + ' Token')
}

/** Token 数字：小值直接给，大值用 K / M，避免满屏 tk 看不出量级。 */
function dfTok(n) {
  const v = Number(n) || 0
  if (v >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'K'
  return String(Math.round(v))
}

/** 预览时去掉 ChatML / project 信封，正文编辑时仍保留原样。 */
function dfCtxPreview(text) {
  return String(text || '')
    .replace(/<\|im_start\|>\s*system:\s*/gi, '')
    .replace(/<\/?project_instructions>/gi, '')
    .trim()
}

/** 把组装段的内部名称翻成人话；不把 harness:xxx 这类调试名直接摊给用户。 */
const DF_SECTION_LABEL = {
  'harness:identity': '顶层身份',
  'harness:source': 'Harness 源码参考',
  'deployment:persona': '部署人格',
  'deployment:persona-prefix': '人格前缀',
  'deployment:persona-suffix': '人格后缀',
  'persona': '部署人格',
  'persona-prefix': '人格前缀',
  'dsh-forge': '破甲注入',
  'dsh-forge:contract': '工作流契约',
  'dsh-forge:identity': '插件身份段',
  'dsh-forge:settle': '预算收尾',
  'dsh-forge:post': '附加提示',
  'dshfg-objective': '任务目标',
  'dshfg-redteam-role': '角色设定',
  'agent-instructions': '工作区指令',
  'skills': '技能目录',
  'skill': '技能目录',
  'tools': '工具定义',
  'plan:policy': '计划模式策略',
  'plan-mode': '计划模式',
  'compaction': '压缩摘要',
  'workspace': '工作区信息',
  'mcp-resource-servers': 'MCP 资源服务',
  'app:web-surface': 'Web 界面说明',
  'ui:deliverable-file-references': '交付文件引用',
}
function dfSectionLabel(name) {
  const n = String(name || '')
  if (/^tool:/.test(n)) return '工具 · ' + n.slice(5)
  if (/^context:/.test(n)) return '上下文 · ' + n.slice(8)
  if (/^instructions:/.test(n)) return '工作区指令 · ' + n.slice(13)
  return DF_SECTION_LABEL[n] || '其他提示段'
}

/* 组装段 → 生效链路的三层。子会话角色只在派发子智能体时出现。 */
const DF_LAYER_SHORT = { system: '系统', workspace: '指令', sub: '子会话' }
const DF_LAYER_NAME = { system: '系统提示词层', workspace: '工作区指令层', sub: '子会话层' }

function dfSectionLayer(name) {
  const n = String(name || '')
  if (n === 'agent-instructions' || /^instructions:/.test(n)) return 'workspace'
  if (n === 'dshfg-redteam-role') return 'sub'
  return 'system'
}

/* 实际组装有几十个分段（tool:* / context:* 等），逐条画只会得到一屏「其他提示段」。
   这里按操作员能认的提示词层聚合；原始分段顺序仍可在「查看全文」里核对。 */
const DF_ACTUAL_BUCKETS = [
  { id: 'operator', label: '破甲注入', layer: 'system', match: function (n) { return n === 'dsh-forge' } },
  { id: 'contract', label: '工作流契约', layer: 'system', match: function (n) { return n === 'dsh-forge:contract' } },
  { id: 'plugin-extra', label: '插件附加提示', layer: 'system', match: function (n) { return /^dsh-forge:/.test(n) || /^dshfg-/.test(n) } },
  { id: 'persona', label: '主智能体人格', layer: 'system', match: function (n) { return /^persona/.test(n) || /^deployment:persona/.test(n) } },
  { id: 'instructions', label: '工作区指令', layer: 'workspace', match: function (n) { return n === 'agent-instructions' || /^instructions:/.test(n) } },
  { id: 'skills', label: '技能目录', layer: 'system', match: function (n) { return n === 'skills' || n === 'skill' } },
  { id: 'compaction', label: '压缩摘要', layer: 'system', match: function (n) { return n === 'compaction' } },
  { id: 'tools', label: '工具定义', layer: 'system', tag: '工具', match: function (n) { return n === 'tools' || /^tool:/.test(n) } },
  { id: 'contexts', label: '运行时上下文', layer: 'system', tag: '上下文', match: function (n) { return /^context:/.test(n) } },
  { id: 'builtin', label: 'DeepSeek Harness 内置', layer: 'system', match: function () { return true } },
]

/** 把实际组装聚合成分层用量；工具与 runtime context 的汇总项也算进对应桶。 */
function dfActualGroups(actual) {
  const byId = new Map()
  function push(bucket, chars) {
    const n = Number(chars) || 0
    if (n <= 0) return
    const cur = byId.get(bucket.id)
    if (cur) { cur.chars += n; return }
    byId.set(bucket.id, { id: bucket.id, label: bucket.label, layer: bucket.layer, tag: bucket.tag, chars: n })
  }
  const secs = actual && Array.isArray(actual.sections) ? actual.sections : []
  secs.forEach(function (s) {
    const name = String((s && s.name) || '')
    const bucket = DF_ACTUAL_BUCKETS.find(function (b) { return b.match(name) }) || DF_ACTUAL_BUCKETS[DF_ACTUAL_BUCKETS.length - 1]
    push(bucket, s && s.chars)
  })
  const toolBucket = DF_ACTUAL_BUCKETS.find(function (b) { return b.id === 'tools' })
  const ctxBucket = DF_ACTUAL_BUCKETS.find(function (b) { return b.id === 'contexts' })
  push(toolBucket, (actual && actual.tools || {}).chars)
  push(ctxBucket, (actual && actual.contexts || {}).chars)
  const rows = Array.from(byId.values()).map(function (r) {
    return Object.assign({}, r, {
      tokens: Math.ceil(r.chars / 2),
      forge: r.id === 'operator' || r.id === 'contract' || r.id === 'plugin-extra',
      label: r.id === 'tools' && actual && actual.tools && actual.tools.count
        ? '工具定义（' + dfNum(actual.tools.count) + ' 个）' : r.label,
    })
  })
  rows.sort(function (a, b) { return b.chars - a.chars })
  return rows
}

function dfRowLayer(l) {
  const id = String((l && l.id) || '')
  if (id === 'dsh-agent-instructions' || /^instructions:/.test(id)) return 'workspace'
  return 'system'
}

/** 操作员注入编辑器：保存后下一轮生效，不需要重启。 */
function DfOperatorEditor(props) {
  const [text, setText] = useState(props.content || '')
  const [busy, setBusy] = useState(false)
  const dirty = text !== (props.content || '')

  function save() {
    if (busy) return
    if (!String(text || '').trim()) { dfToast('破甲注入不能为空', 'err', 3000); return }
    setBusy(true)
    const write = props.onSave
      ? props.onSave(text)
      : dfHostPost('/dsh-forge/context', { action: 'saveOperator', content: text })
    Promise.resolve(write).then(function (r) {
      setBusy(false)
      if (!r || r.ok === false) { dfToast((r && r.error) || '保存失败', 'err', 4200); return }
      dfToast('已保存，下一轮生效', 'ok', 2200)
      if (props.onDone) props.onDone(r)
    }, function (e) {
      setBusy(false)
      dfToast(String(e && e.message ? e.message : e), 'err', 4200)
    })
  }

  return h('div', { className: 'df-detail' },
    h('div', { className: 'df-note' }, '改完下一轮生效；宿主内建身份不在这里。'),
    h('div', { className: 'df-note', style: { marginTop: 6 } }, '保留 <|im_start|>system: 信封和 <project_instructions> 标签，删了注入会失效。'),
    h('textarea', {
      className: 'df-area df-area--doc', value: text, rows: 20, spellCheck: false,
      style: { width: '100%', fontFamily: 'var(--df-mono)', fontSize: 13, lineHeight: 1.7 },
      onChange: function (e) { setText(e.target.value) },
    }),
    h('div', { style: { display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' } },
      h(DfBtn, { size: 'sm', kind: 'primary', icon: 'check', disabled: busy || !dirty, onClick: save }, busy ? '保存中…' : '保存'),
      h('span', { className: 'df-hint' }, String(text || '').length + ' 字符 · 约 ' + dfNum(Math.ceil(String(text || '').length / 2)) + ' Token'),
      h('span', { className: 'dfx-spacer' }),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', disabled: busy || !dirty, onClick: function () { setText(props.content || '') } }, '还原')))
}

/** 另存当前注入为模板。 */
function DfTemplateSaver(props) {
  const [name, setName] = useState('')
  const [text, setText] = useState(props.content || '')
  const [busy, setBusy] = useState(false)

  function save() {
    if (busy) return
    if (!name.trim()) { dfToast('给模板起个名字', 'err', 2600); return }
    setBusy(true)
    dfHostPost('/dsh-forge/context', { action: 'saveTemplate', name: name.trim(), content: text }).then(function (r) {
      setBusy(false)
      if (!r || r.ok === false) { dfToast((r && r.error) || '保存失败', 'err', 4200); return }
      dfToast('模板已保存', 'ok', 1800)
      if (props.onDone) props.onDone(r)
    })
  }

  return h('div', { className: 'df-detail' },
    h('div', { className: 'df-note' }, '只保存操作员注入层；应用会覆盖当前注入。'),
    h('label', { className: 'df-label', style: { display: 'block', marginTop: 8 } }, '模板名称'),
    h('input', {
      className: 'df-input', value: name, autoFocus: true, placeholder: '例如：红队-简洁版 / 逆向-只读',
      onChange: function (e) { setName(e.target.value) }, style: { width: '100%', marginTop: 4 },
    }),
    h('label', { className: 'df-label', style: { display: 'block', marginTop: 10 } }, '内容'),
    h('textarea', {
      className: 'df-area', value: text, rows: 16,
      style: { width: '100%', minHeight: 280, fontFamily: 'var(--df-mono)', fontSize: 12.5 },
      onChange: function (e) { setText(e.target.value) },
    }),
    h('div', { style: { marginTop: 10 } },
      h(DfBtn, { size: 'sm', kind: 'primary', icon: 'check', disabled: busy, onClick: save }, busy ? '保存中…' : '保存为模板')))
}

function DfContextMode(props) {
  const [tick, setTick] = useState(0)
  /* 每个模式各拉各的清单与快照：红队 / 破解的每轮固定开销完全不同。 */
  const mode = props.mode || 'redteam'
  const state = dfUseAsync(function () {
    return dfHost('/dsh-forge/context?mode=' + encodeURIComponent(mode)).then(function (r) {
      if (!r || r.ok === false) throw new Error((r && r.error) || '读取上下文失败')
      return r
    })
  }, [props.tick, tick])

  const d = state.data || {}
  const layers = d.layers || []

  function reload() { state.reload(); setTick(function (t) { return t + 1 }) }

  /* 本次实际提示词全文只存在宿主内存里，重启即清；这里按需拉取，不落盘。 */
  function openAssembled() {
    if (!props.onInspect) return
    dfHost('/dsh-forge/assembled?mode=' + encodeURIComponent(mode)).then(function (r) {
      if (!r || r.ok === false) { dfToast((r && r.error) || '读取失败', 'err', 4200); return }
      if (r.empty) { dfToast('还没有捕获到组装结果，先发一条消息', 'info', 3600); return }
      const secs = r.sections || []
      const body = secs.map(function (s) {
        return '===== ' + dfSectionLabel(s.name) + ' · ' + dfNum(s.chars || 0) + ' 字符 =====\n' + String(s.text || '')
      }).join('\n\n')
      const toolJson = (r.tools && r.tools.json) ? JSON.stringify(r.tools.json, null, 2) : ''
      const full = toolJson ? body + '\n\n===== 工具定义 =====\n' + toolJson : body
      props.onInspect({
        title: '本次实际提示词',
        sub: (r.mode ? r.mode + ' · ' : '') + dfTime(r.at) + ' · ' + dfNum(secs.length) + ' 段',
        rows: [
          ['模式', r.mode || '—'],
          ['总字符', dfNum(r.totalChars || 0) + ' · 约 ' + dfNum(Math.ceil((r.totalChars || 0) / 2)) + ' Token'],
          ['工具', dfNum((r.tools || {}).count || 0) + ' 个'],
          ['来源', '宿主内存 · 重启后清空'],
        ],
        node: h('div', { className: 'df-detail' },
          h('div', { className: 'df-note' }, '这是宿主实际交给模型的那一份，只读。修改时在左侧提示词工作台切换到对应层。'),
          h('div', { className: 'df-detail-hd' },
            h('h4', null, '全文 · ' + dfNum(full.length) + ' 字符'),
            h(DfCopyBtn, { text: full, label: '复制全文', toast: '已复制本次提示词' })),
          h('pre', {
            className: 'df-evi',
            style: { whiteSpace: 'pre-wrap', maxHeight: '62vh', overflow: 'auto', fontSize: 12 },
          }, full)),
      })
    }, function (e) {
      dfToast(String(e && e.message ? e.message : e), 'err', 4200)
    })
  }

  function openLayer(l) {
    const editHint = l.id === 'operator' ? '在「提示词 → 破甲注入」层编辑'
      : l.id === 'persona' ? '在「提示词 → 主智能体人格」层编辑（重启生效）'
        : l.id === 'dsh-agent-instructions' || /^instructions:/.test(l.id) ? '在「提示词 → 工作区指令」层编辑 AGENTS.md'
          : l.editable === 'file' ? '在对应页面或文件里改'
            : '由 DeepSeek Harness 或插件代码生成，面板不提供编辑'
    props.onInspect && props.onInspect({
      title: l.label,
      sub: (l.group || '') + ' · ' + (l.effective ? '会进入上下文' : '按需进入'),
      rows: [
        ['作用域', l.scope],
        ['来源', l.source],
        ['大小', (l.chars || 0) + ' 字符 · 约 ' + dfNum(l.tokens || 0) + ' Token'],
        ['可编辑', editHint],
        ['路径', l.path],
      ],
      node: h('div', { className: 'df-detail' },
        l.note ? h('div', { className: 'df-note' }, l.note) : null,
        l.preview ? h('section', { className: 'df-detail-sec' },
          h('h4', null, '预览'),
          h('pre', { className: 'df-evi', style: { whiteSpace: 'pre-wrap' } }, l.preview)) : null,
        l.id === 'operator'
          ? h('div', { style: { marginTop: 10 } }, h(DfBtn, {
            size: 'sm', kind: 'primary', icon: 'prompt',
            onClick: function () {
              if (props.onCloseDrawer) props.onCloseDrawer()
              if (props.onGoto) props.onGoto('inject')
            },
          }, '去破甲注入页编辑'))
          : null),
    })
  }

  const hasActual = Boolean(d.actual && Array.isArray(d.actual.sections))
  const toolEstTokens = d.toolEstimate && d.toolEstimate.chars > 0 ? Math.ceil(d.toolEstimate.chars / 2) : 0
  /* 已有实际组装快照时，KPI 用宿主真报的总额（段 + 工具 + 运行时上下文），
     不再拿全局工具表去补，否则两个模式的数字会一样。 */
  const fixedTokens = hasActual
    ? Math.ceil((d.actual.totalChars || 0) / 2)
    : ((d.total || {}).tokens || 0) + toolEstTokens
  /* 读取失败也用同一张卡说明原因：只按有没有 usage 对象判断，不按 ok 判断。 */
  const usage = d.usage && typeof d.usage === 'object' ? d.usage : null

  return h('div', null,
    state.error
      ? h(DfOpsError, { title: '读取上下文失败', error: state.error, onRetry: reload })
      : h('div', null,
        h(DfPromptLayers, {
          compact: true,
          onGoto: props.onGoto,
          note: '只读核对：三层按顺序进入同一份提示词。',
          foot: '子会话层只在派发子智能体时出现；主会话的组装结果里没有这一层。',
        }),

        h('div', { className: 'df-kpis', style: { marginBottom: 12, marginTop: 12 } },
          h(DfKpi, {
            label: '每轮固定附加', icon: 'layers', value: dfTok(fixedTokens),
            foot: hasActual ? '约 Token · 实际组装（含工具与运行时上下文）' : '约 Token · 含工具定义估算，不含内建段',
            accent: false,
          }),
          h(DfKpi, {
            label: '已知来源', icon: 'list',
            value: dfNum(layers.length),
            foot: '只读；编辑入口在各自页面',
          }),
          h(DfKpi, {
            label: '累计真实用量', icon: 'db',
            value: usage && usage.available ? dfTok(usage.totalTokens) : '—',
            foot: usage && usage.available
              ? 'Token · 当前任务树（含子智能体）'
              : usage && (usage.reason === 'error' || usage.ok === false)
                ? '用量读取失败 · 详情见下'
                : '暂无存活任务根会话',
          })),

        d.actual
          ? (function () {
            const groups = dfActualGroups(d.actual)
            const maxChars = Math.max(1, ...groups.map(function (g) { return g.chars || 0 }))
            const totalToken = Math.ceil((d.actual.totalChars || 0) / 2)
            return h(DfCard, {
              title: '每轮固定附加（实际）', icon: 'list',
              sub: dfTime(d.actual.at) + ' · 约 ' + dfTok(totalToken) + ' Token（不含你发的那条消息）',
              actions: h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'list', onClick: openAssembled }, '查看全文'),
            },
              h('div', { className: 'df-ctx-bars' }, groups.map(function (g) {
                const pct = Math.max(2, Math.round((g.chars / maxChars) * 100))
                return h('div', { key: g.id, className: 'df-ctx-bar' + (g.forge ? ' is-forge' : '') },
                  h('span', { className: 'df-ctx-bar-name' },
                    h('em', { className: 'df-ctx-bar-tag is-' + g.layer }, g.tag || DF_LAYER_SHORT[g.layer]),
                    g.label),
                  h('span', { className: 'df-ctx-bar-track' }, h('i', { style: { width: pct + '%' } })),
                  h('span', { className: 'df-ctx-bar-num' }, dfTok(g.tokens)))
              })),
              h('div', { className: 'df-note', style: { marginTop: 8 } },
                '按提示词层聚合（工具、破甲注入、人格、工作区指令等）；原始分段顺序在「查看全文」里。'))
          })()
          : (function () {
            const toolEst = d.toolEstimate && d.toolEstimate.chars > 0 ? d.toolEstimate : null
            const rowsAll = layers.filter(function (l) { return l.chars > 0 }).sort(function (a, b) { return b.chars - a.chars })
            const knownRows = toolEst
              ? rowsAll.concat([{
                id: 'tool-schemas',
                label: '工具定义（' + dfNum(toolEst.count) + ' 个'
                  + (toolEst.scope === 'global' ? ' · 宿主全局表' : '') + '，按 schema 估算）',
                chars: toolEst.chars,
                tokens: Math.ceil(toolEst.chars / 2),
              }]).sort(function (a, b) { return b.chars - a.chars })
              : rowsAll
            const totalTokens = ((d.total || {}).tokens || 0) + (toolEst ? Math.ceil(toolEst.chars / 2) : 0)
            const maxChars = Math.max(1, ...knownRows.map(function (l) { return l.chars || 0 }))
            return h(DfCard, {
              title: '每轮固定附加（估算）', icon: 'layers',
              sub: toolEst
                ? (toolEst.scope === 'global'
                  ? '没有该模式的活会话；工具按宿主全局表估算，可能偏小'
                  : '按该模式当前会话的工具表 + 已知文件估算 · 不含你发的那条消息')
                : '按已知文件估算 · 不含你发的那条消息',
              actions: h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'list', onClick: openAssembled }, '查看全文'),
            },
              knownRows.length
                ? h('div', { className: 'df-ctx-bars' }, knownRows.map(function (l) {
                  const pct = Math.max(2, Math.round(((l.chars || 0) / maxChars) * 100))
                  return h('div', { key: l.id, className: 'df-ctx-bar' },
                    h('span', { className: 'df-ctx-bar-name' }, l.label),
                    h('span', { className: 'df-ctx-bar-track' }, h('i', { style: { width: pct + '%' } })),
                    h('span', { className: 'df-ctx-bar-num' }, dfTok(l.tokens || 0)))
                }))
                : h('div', { className: 'df-note' }, '还没有可估算的固定内容。'),
              h('div', { className: 'df-note', style: { marginTop: 8 } },
                '合计约 ' + dfTok(totalTokens) + ' Token；发一条消息后会换成「实际组装」，'
                + '由 DeepSeek Harness 报出完整段和工具定义（含内建段，通常更大）。'))
          })(),

        usage
          ? (function () {
            const total = usage.totalTokens || 0
            const realPrompt = usage.promptTokens || 0
            const sub = usage.subagentBuckets || {}
            const subTotal = (sub.uncachedInputTokens || 0) + (sub.cacheReadTokens || 0)
              + (sub.cacheWriteTokens || 0) + (sub.outputTokens || 0)
            const requests = (usage.requests && usage.requests.root) || 0

            /* 常驻部分按「最近一次实际组装 × 主会话已结算请求次数」累计。
               子智能体有自己的角色稿和工具视图，不能拿主会话的分段去乘它们的请求。 */
            const actual = d.actual && Array.isArray(d.actual.sections) ? d.actual : null
            let rows = []
            if (actual) {
              rows = dfActualGroups(actual).map(function (g) {
                return Object.assign({}, g, { n: g.tokens * requests })
              }).filter(function (r) { return r.n > 0 })
                .sort(function (a, b) { return b.n - a.n })
            }
            const residentTotal = rows.reduce(function (sum, r) { return sum + r.n }, 0)
            const maxN = Math.max(1, ...rows.map(function (r) { return r.n }))
            const share = function (n) {
              return residentTotal > 0 ? Math.round((n / residentTotal) * 100) : 0
            }
            const p = usage.pressure || {}
            const pTokens = typeof p.projectedTokens === 'number' ? p.projectedTokens
              : typeof p.pressureTokens === 'number' ? p.pressureTokens : null
            const window = typeof p.contextWindow === 'number' ? p.contextWindow : null

            return h(DfCard, {
              title: '常驻上下文累计（估算）', icon: 'layers',
              sub: dfTime(usage.at) + ' · ' + dfNum(usage.sessions ? usage.sessions.total : 1) + ' 个会话'
                + ' · 主会话 ' + dfNum(requests) + ' 次请求',
            },
              residentTotal > 0
                ? h('div', { className: 'df-ctx-bars' }, rows.map(function (r) {
                  const pct = Math.max(2, Math.round((r.n / maxN) * 100))
                  return h('div', { key: r.id, className: 'df-ctx-bar' + (r.forge ? ' is-forge' : '') },
                    h('span', { className: 'df-ctx-bar-name' },
                      r.layer ? h('em', { className: 'df-ctx-bar-tag is-' + r.layer }, r.tag || DF_LAYER_SHORT[r.layer]) : null,
                      r.label),
                    h('span', { className: 'df-ctx-bar-track' }, h('i', { style: { width: pct + '%' } })),
                    h('span', { className: 'df-ctx-bar-num' }, dfTok(r.n) + ' · ' + share(r.n) + '%'))
                }))
                : h('div', { className: 'df-note' },
                  usage.available
                    ? actual
                      ? (requests === 0
                        ? '主会话还没有已结算的请求；发生一次模型调用后这里才开始累计。'
                        : '最近一次组装没有可累计的常驻分段。')
                      : '还没有捕获到实际组装结果；先发一条消息，才能按常驻部分累计。'
                    : usage.note || '当前任务树还没有可读的真实用量。'),
              residentTotal > 0
                ? h('div', { className: 'df-note', style: { marginTop: 8 } },
                  '合计约 ' + dfTok(residentTotal) + ' Token = 最近一次每轮固定附加 × '
                    + dfNum(requests) + ' 次主会话请求。')
                : null,
              usage.available && total > 0
                ? (function () {
                  const pct = residentTotal > 0 && realPrompt > 0
                    ? Math.round((residentTotal / realPrompt) * 100) : null
                  return h('div', { className: 'df-note', style: { marginTop: 8 } },
                    '真实累计 ' + dfTok(total) + ' Token'
                      + (subTotal > 0 ? ' · 其中子智能体 ' + dfTok(subTotal) : '')
                      + (pct === null ? ''
                        : pct <= 100
                          ? ' · 主会话常驻估算约占真实输入 ' + pct + '%'
                          : ' · 常驻估算约合真实输入的 ' + pct + '%（最近一次组装带的段比早期请求多，早期请求更短）'))
                })()
                : null,
              h('div', { className: 'df-note', style: { marginTop: 4 } },
                '常驻部分按字符 ÷ 2 估算，请求次数取主会话已结算的 LLM 步数；'
                + '不含逐轮增长的对话历史，子智能体也不并入这份拆分。真实总量只统计根会话与它派出的子智能体，'
                + '不折 fork 子会话重复继承的前缀。'),
              pTokens === null ? null : h('div', { className: 'df-note', style: { marginTop: 4 } },
                '最近一次请求压力：约 ' + dfTok(pTokens) + ' Token'
                + (window ? ' / 窗口 ' + dfTok(window) + '（' + Math.round((pTokens / window) * 100) + '%）' : '')
                + (usage.skipped ? ' · ' + dfNum(usage.skipped) + ' 个子会话读不到用量' : ''))
            )
          })()
          : null,

        h(DfCard, {
          title: '只读清单', icon: 'list',
          sub: '共 ' + dfNum(layers.length) + ' 项 · 不能在这里改',
        },
          h('div', { className: 'df-vlist' }, layers.map(function (l) {
            return h('button', {
              key: l.id, type: 'button', className: 'df-vrow df-vrow--info',
              onClick: function () { openLayer(l) },
            },
              h('span', { className: 'df-vrow-rail' }),
              h('span', { className: 'df-vrow-main' },
                h('span', { className: 'df-vrow-hd' },
                  h('span', { className: 'df-vrow-t' }, l.label),
                  h(DfChip, { kind: 'line' }, DF_LAYER_NAME[dfRowLayer(l)]),
                  h(DfChip, { kind: l.editable === 'none' ? 'line' : l.editable === 'inline' ? 'ok' : 'info' },
                    l.editable === 'none' ? '只读' : l.editable === 'inline' ? '可改' : '文件'),
                  l.effective ? null : h(DfChip, { kind: 'warn' }, '按需'),
                  l.chars
                    ? h(DfContextToken, { tokens: l.tokens })
                    : l.effective && l.editable === 'none'
                      ? h(DfChip, { kind: 'line' }, '代码生成')
                      : null),
                h('span', { className: 'df-vrow-m' },
                  h('span', { className: 'df-vrow-ip' }, l.group),
                  h('span', { className: 'df-vrow-sep' }, '·'),
                  h('span', { className: 'df-vrow-url' }, l.scope))),
              h('span', { className: 'df-vrow-right' },
                h('span', { className: 'df-vrow-ago' }, l.chars ? dfNum(l.chars) + ' 字符' : ''),
                h('span', { className: 'df-vrow-go' }, '›')))
          }))),

        h('div', { className: 'df-note', style: { marginTop: 12 } },
          d.note || 'Token 为估算值。')))
}



/* ---- lib/client/40-agents.js ---- */
/* 智能体：按模式看提示词与子智能体，再管并发。
   提示词来源不是一套：
   · 红队：主会话人格在 preset，子智能体角色稿按靶标存；
   · 破解：主会话人格由模块代码生成，子智能体角色稿是模式级文件；
   · 标准/极简/PTC/等宿主模式：没有插件提示词，只读。 */

function dfAgentsMode(mode) {
  if (mode === 'one-shot') return '一次性'
  if (mode === 'continuable') return '可继续'
  return String(mode || '')
}

function dfAgentsActivity(activity) {
  if (activity === 'running') return '执行中'
  if (activity === 'inactive') return '已结束'
  return String(activity || '')
}

function dfAgentsSource(source) {
  if (source === 'settings') return '面板设置'
  if (source === 'env') return '环境变量'
  if (source === 'default') return '默认值'
  if (source === 'preview') return '预览环境'
  return String(source || '')
}

function dfAgentModeKind(mode) {
  if (mode === 'redteam') return 'redteam'
  if (mode === 'crack') return 'crack'
  return 'host'
}

/** 子智能体提示词编辑器：红队写当前靶标，破解写模式级文件。 */
function DfAgentPromptEditor(props) {
  const [text, setText] = useState(String(props.content || ''))
  const [busy, setBusy] = useState('')
  const [confirm, setConfirm] = useState(false)

  useEffect(function () {
    if (!confirm) return undefined
    const t = window.setTimeout(function () { setConfirm(false) }, 5000)
    return function () { window.clearTimeout(t) }
  }, [confirm])

  function save() {
    if (busy) return
    if (!String(text).trim()) {
      dfToast('子智能体提示词不能为空；要恢复默认请点「恢复默认」', 'err', 4200)
      return
    }
    setBusy('save')
    Promise.resolve(props.onSave(text)).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '保存失败', 'err', 4200); return }
      dfToast('已保存，下一轮生效', 'ok', 2200)
      if (props.onDone) props.onDone()
    }, function (e) {
      setBusy('')
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  function reset() {
    if (!confirm) { setConfirm(true); return }
    if (busy) return
    setBusy('reset')
    Promise.resolve(props.onReset()).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '恢复失败', 'err', 4200); return }
      setConfirm(false)
      dfToast('已恢复模式默认稿', 'ok', 2200)
      if (props.onDone) props.onDone()
    }, function (e) {
      setBusy('')
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  return h('div', { className: 'df-detail' },
    h(DfRoleTemplateBar, {
      mode: props.mode,
      role: props.role,
      text: text,
      onLoad: function (t) { setText(t); setConfirm(false) },
    }),
    h('div', { className: 'df-note' }, (props.scope || '') + ' · 保存后下一轮生效'),
    h('div', { className: 'df-note df-note--warn' },
      '子智能体提示词不能为空；落库、证据、状态、派活这些底线由插件自动附加，删正文不会删掉契约。'),
    h('textarea', {
      className: 'df-area df-area--code', rows: 16, value: text, spellCheck: false,
      onChange: function (e) { setText(e.target.value) },
    }),
    h('div', { className: 'df-formfoot' },
      h('span', { className: 'df-ops-meta' }, dfNum(String(text).length) + ' 字符'),
      h('span', { className: 'df-spacer' }),
      h(DfBtn, {
        size: 'sm', kind: confirm ? 'danger' : 'ghost', icon: 'restore',
        disabled: !!busy, onClick: reset, onBlur: function () { setConfirm(false) },
      }, busy === 'reset' ? '恢复中…' : (confirm ? '确认恢复默认' : '恢复默认')),
      h(DfBtn, {
        size: 'sm', kind: 'primary', icon: 'check', disabled: !!busy, onClick: save,
      }, busy === 'save' ? '保存中…' : '保存')))
}

/** 主智能体人格编辑器：两种模式共用；模板按模式+角色隔离。 */
function DfPersonaEditorBase(props) {
  const [text, setText] = useState(String(props.content || ''))
  const [busy, setBusy] = useState('')
  const [confirm, setConfirm] = useState(false)
  const installed = props.installed !== false

  useEffect(function () {
    setText(String(props.content || ''))
  }, [props.content])

  useEffect(function () {
    if (!confirm) return undefined
    const t = window.setTimeout(function () { setConfirm(false) }, 5000)
    return function () { window.clearTimeout(t) }
  }, [confirm])

  function save() {
    if (busy) return
    if (!String(text).trim()) { dfToast('人格不能为空', 'err', 3000); return }
    setBusy('save')
    Promise.resolve(props.onSave(text)).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '保存失败', 'err', 4800); return }
      dfToast('人格已保存，重启 DeepSeek Harness 后生效', 'ok', 3200)
      if (props.onDone) props.onDone()
    }, function (e) {
      setBusy('')
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  function reset() {
    if (!confirm) { setConfirm(true); return }
    if (busy) return
    setBusy('reset')
    Promise.resolve(props.onReset()).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '恢复失败', 'err', 4800); return }
      setConfirm(false)
      dfToast('已恢复内置默认人格，重启 DeepSeek Harness 后生效', 'ok', 3200)
      if (props.onDone) props.onDone()
    }, function (e) {
      setBusy('')
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  return h('div', { className: 'df-detail' },
    h(DfRoleTemplateBar, {
      mode: props.mode,
      role: '__persona__',
      text: text,
      onLoad: function (t) { setText(t); setConfirm(false) },
    }),
    h('div', { className: 'df-note' }, (props.scope || '') + ' · 保存后重启 DeepSeek Harness 生效'),
    h('textarea', {
      className: 'df-area df-area--code', rows: 16, value: text, spellCheck: false,
      onChange: function (e) { setText(e.target.value) },
    }),
    h('div', { className: 'df-formfoot' },
      h('span', { className: 'df-ops-meta' }, dfNum(String(text).length) + ' 字符'),
      h('span', { className: 'df-spacer' }),
      h(DfBtn, {
        size: 'sm', kind: confirm ? 'danger' : 'ghost', icon: 'restore',
        disabled: !!busy || !installed, onClick: reset, onBlur: function () { setConfirm(false) },
      }, busy === 'reset' ? '恢复中…' : (confirm ? '确认恢复默认' : '恢复默认')),
      h(DfBtn, {
        size: 'sm', kind: 'primary', icon: 'check', disabled: !!busy || !installed, onClick: save,
      }, busy === 'save' ? '保存中…' : '保存')))
}

function DfAgents(props) {
  const [tick, setTick] = useState(0)
  const [follow, setFollow] = useState(true)
  const [liveMode, setLiveMode] = useState(function () { return dfCurrentAgentPreset() })
  const [mode, setMode] = useState(function () {
    const cur = dfCurrentAgentPreset()
    return cur === 'redteam' || cur === 'crack' ? cur : 'redteam'
  })

  /* 两个会话同时开着时，面板只管理一个模式：默认跟随当前 dsh 会话；
     手动点模式 chip 后固定，避免编辑到一半被别人切会话打断。 */
  useEffect(function () {
    const t = window.setInterval(function () {
      const cur = dfCurrentAgentPreset()
      setLiveMode(function (prev) { return prev === cur ? prev : cur })
      if (follow && (cur === 'redteam' || cur === 'crack')) {
        setMode(function (prev) { return prev === cur ? prev : cur })
      }
    }, 1200)
    return function () { window.clearInterval(t) }
  }, [follow])

  const injectState = dfUseAsync(function () {
    return dfHost('/dsh-forge/inject')
  }, [props.tick, tick])
  const modes = (injectState.data && injectState.data.modes) || []
  const modeOptions = modes.length ? modes : [
    { id: 'redteam', name: '红队模式' },
    { id: 'crack', name: '破解模式' },
  ]
  const modeInfo = modeOptions.find(function (m) { return m.id === mode })
  const modeName = modeInfo ? dfModeTitle(modeInfo) : dfModeLabel(mode)
  const kind = dfAgentModeKind(mode)

  const promptState = dfUseAsync(function () {
    let p
    if (kind === 'redteam') {
      p = props.eng
        ? dfApi('prompts', { engagement: props.eng }, { ttl: 0 })
        : Promise.resolve({ ok: true, roles: [] })
    } else if (kind === 'crack') {
      p = dfHost('/dsh-forge/crack-agents')
    } else {
      p = Promise.resolve({ ok: true, roles: [], main: null })
    }
    /* 标上这一份数据属于哪个模式：切模式时旧数据还在，不能拿来当新模式显示。 */
    return Promise.resolve(p).then(function (r) { return Object.assign({ __kind: kind }, r || {}) })
  }, [kind, props.eng, props.tick, tick])

  const mainState = dfUseAsync(function () {
    return kind === 'redteam' ? dfHost('/dsh-forge/preset-prompt') : Promise.resolve(null)
  }, [kind, tick, props.tick])

  const agentState = dfUseAsync(function () {
    return dfApi('agentsStatus', {}, { ttl: 0, force: true })
  }, [props.tick, tick])
  const [draft, setDraft] = useState('')
  const [savingMax, setSavingMax] = useState(false)

  useEffect(function () {
    const m = agentState.data && agentState.data.max
    if (typeof m === 'number') setDraft(String(m))
  }, [agentState.data && agentState.data.max])

  function bump() { setTick(function (t) { return t + 1 }) }

  const data = promptState.data && promptState.data.__kind === kind ? promptState.data : {}
  const dataReady = Boolean(promptState.data && promptState.data.__kind === kind)
  const subs = kind === 'redteam'
    ? (Array.isArray(data.roles) ? data.roles : []).map(function (r) {
      return {
        id: r.role, label: r.title || r.role, content: r.content || '',
        chars: String(r.content || '').length, updated_at: r.updated_at,
        planner: !!r.planner, scope: '当前靶标', note: r.planner ? '主会话参考稿，不派发' : '子智能体提示词',
      }
    })
    : kind === 'crack'
      ? (Array.isArray(data.roles) ? data.roles : []).map(function (r) {
        return Object.assign({}, r, {
          label: r.label || r.id,
          scope: '整个破解模式',
          note: r.note || '破解子智能体提示词',
        })
      })
      : []

  let main = null
  if (kind === 'redteam') {
    const d = mainState.data
    if (d && d.ok !== false) {
      main = {
        label: '红队指挥官',
        content: String(d.prefix || ''),
        chars: String(d.prefix || '').length,
        scope: '红队模式 · 重启 DeepSeek Harness 生效',
        editable: true,
        installed: d.installed !== false,
        note: d.installed ? '只替换 persona.prefix，其余预设行不动。' : '预设未安装，当前显示包内模板。',
      }
    }
  } else if (kind === 'crack') {
    main = data.main || null
  } else {
    main = {
      label: modeName + '主智能体',
      content: '',
      chars: 0,
      scope: '宿主模式 · 只读',
      editable: false,
      note: '宿主内建模式没有插件提示词；要改请在预设/宿主代码里改，面板不提供假编辑。',
    }
  }

  function openMain() {
    if (!props.onInspect || !main) return
    setFollow(false)
    if (main.editable) {
      const common = {
        key: 'persona:' + kind,
        mode: kind,
        content: main.content,
        scope: main.scope,
        installed: main.installed !== false,
        onDone: function () { mainState.reload(); promptState.reload(); bump() },
      }
      props.onInspect({
        mode: 'page',
        maximize: true,
        title: '编辑主智能体人格 · ' + (kind === 'redteam' ? '红队' : '破解'),
        sub: main.scope,
        node: kind === 'redteam'
          ? h(DfPersonaEditorBase, Object.assign({}, common, {
            onSave: function (text) { return dfHostPost('/dsh-forge/preset-prompt', { action: 'savePrefix', content: text }) },
            onReset: function () { return dfHostPost('/dsh-forge/preset-prompt', { action: 'resetPrefix' }) },
          }))
          : h(DfPersonaEditorBase, Object.assign({}, common, {
            onSave: function (text) { return dfHostPost('/dsh-forge/crack-agents', { action: 'saveMain', content: text }) },
            onReset: function () { return dfHostPost('/dsh-forge/crack-agents', { action: 'resetMain' }) },
          })),
      })
      return
    }
    props.onInspect({
      title: main.label,
      sub: main.scope,
      rows: [['来源', kind === 'crack' ? '破解模块代码生成' : '宿主内建'], ['字符', dfNum(main.content.length)]],
      node: h('div', { className: 'df-detail' },
        h('div', { className: 'df-note' }, main.note || '面板不提供编辑。'),
        main.content
          ? h('pre', { className: 'df-evi', style: { whiteSpace: 'pre-wrap', maxHeight: '60vh', overflow: 'auto' } }, main.content)
          : null),
    })
  }

  function openSub(a) {
    if (!props.onInspect) return
    setFollow(false)
    const common = {
      key: 'agent:' + kind + ':' + a.id,
      content: a.content,
      scope: a.scope,
      onDone: function () { promptState.reload(); bump() },
    }
    props.onInspect({
      mode: 'page',
      maximize: true,
      title: a.label,
      sub: a.scope + (a.planner ? ' · 主会话参考稿，不派发' : ' · 子智能体'),
      rows: [
        ['代码', a.id],
        ['作用域', a.scope],
        ['字符', dfNum(a.chars)],
        ['更新', a.updated_at ? dfAgo(a.updated_at) : '—'],
      ],
      node: kind === 'redteam'
        ? h(DfAgentPromptEditor, Object.assign({}, common, {
          mode: 'redteam', role: a.id,
          onSave: function (text) { return dfApi('savePrompt', { engagement: props.eng, role: a.id, content: text }) },
          onReset: function () { return dfApi('resetPrompts', { engagement: props.eng, role: a.id }) },
        }))
        : h(DfAgentPromptEditor, Object.assign({}, common, {
          mode: 'crack', role: a.id,
          onSave: function (text) { return dfHostPost('/dsh-forge/crack-agents', { action: 'save', id: a.id, content: text }) },
          onReset: function () { return dfHostPost('/dsh-forge/crack-agents', { action: 'reset', id: a.id }) },
        })),
    })
  }

  const agentsData = agentState.data || {}
  const agentsError = agentsData.ok === false ? String(agentsData.error || '并发状态读取失败') : ''
  const max = Number(agentsData.max) || 0
  const used = Number(agentsData.used) || 0
  /* 服务端 MAX_AGENTS_LIMIT 是 32；读取失败时不能把滑块放到 64。 */
  const limit = Number(agentsData.limit) || 32
  const running = Array.isArray(agentsData.running) ? agentsData.running : []
  const n = Number(draft)
  const canSaveMax = isFinite(n) && n >= 1 && n <= limit && Math.floor(n) === n && n !== max

  function saveMax() {
    if (!canSaveMax || savingMax) return
    setSavingMax(true)
    dfApi('setAgentsMax', { max: n }).then(function (r) {
      setSavingMax(false)
      if (!r || r.ok === false) { dfToast((r && r.error) || '保存失败', 'err', 4000); return }
      dfToast('并发上限已改为 ' + (r.max !== undefined ? r.max : n), 'ok', 2200)
      agentState.reload()
    }, function (e) {
      setSavingMax(false)
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  const liveManager = liveMode === 'redteam' || liveMode === 'crack'
  const followText = !follow
    ? '已固定，点模式 chip 或打开开关继续跟随'
    : liveManager
      ? '自动跟随'
      : '当前是宿主模式，未自动切换；仍管理 ' + dfModeLabel(mode)

  return h('div', { className: 'df-ops' },
    h('div', { className: 'df-opsbar' },
      h('span', { className: 'df-ops-title' }, '智能体'),
      h('span', { className: 'df-ops-meta' }, '主智能体人格 · 子智能体提示词 · 并发'),
      h('span', { className: 'df-spacer' }),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', onClick: bump }, '刷新')),

    h('div', { className: 'df-agent-modes' },
      h('span', { className: 'df-ops-meta' }, '管理模式'),
      modeOptions.map(function (m) {
        return h('button', {
          key: m.id,
          type: 'button',
          className: dfCx('df-agent-mode', m.id === mode && 'is-on'),
          title: m.description || dfModeTitle(m),
          onClick: function () { setFollow(false); setMode(m.id) },
        }, dfModeTitle(m))
      }),
      h('span', { className: 'df-spacer' }),
      h('label', { className: 'df-switch', title: '当前 DeepSeek Harness 会话切到红队/破解时，本页自动跟着切' },
        h('input', {
          type: 'checkbox', checked: follow,
          onChange: function (e) { setFollow(e.target.checked) },
        }),
        h('i', null),
        h('span', null, follow ? '跟随会话' : '已固定'))),

    h('div', { className: 'df-note' },
      '当前 DeepSeek Harness 会话：' + dfModeLabel(liveMode) + ' · ' + followText),

    h(DfPromptLayers, {
      focus: ['system', 'sub'],
      onGoto: props.onGoto,
      note: '本页管第 1、3 层；第 2 层是 AGENTS.md，不是 agent。',
    }),

    props.focus === 'roles' ? null : h(DfCard, {
      title: '主智能体人格', icon: 'target', sub: main ? main.scope : modeName + ' · 读取中',
      actions: main && main.editable
        ? h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'prompt', onClick: openMain }, '编辑人格')
        : main ? h(DfChip, { kind: 'line' }, '只读') : null,
    },
      (mainState.loading && kind === 'redteam' && !main) || (kind === 'crack' && !dataReady && promptState.loading)
        ? h(DfSkeleton, { lines: 3 })
        : kind === 'redteam' && (mainState.error || (mainState.data && mainState.data.ok === false))
          ? h(DfOpsError, {
            title: '读取红队主智能体人格失败',
            error: mainState.error || (mainState.data && mainState.data.error),
            onRetry: mainState.reload,
          })
          : kind === 'crack' && (promptState.error || data.ok === false)
            ? h(DfOpsError, {
              title: '读取破解主智能体人格失败',
              error: promptState.error || data.error,
              onRetry: promptState.reload,
            })
            : main
              ? h('div', null,
                h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 } },
                  h(DfChip, { kind: 'line' }, dfNum(main.chars) + ' 字符'),
                  h(DfChip, { kind: 'line' }, kind === 'redteam' ? 'Agent 预设 persona' : kind === 'crack' ? (main.custom ? '已自定义' : '内置默认') : '宿主内建')),
                h('div', { className: 'df-note' }, main.note || ''),
                main.content
                  ? h('pre', { className: 'df-evi', style: { whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto', marginTop: 6 } }, String(main.content).slice(0, 600))
                  : null)
              : h(DfEmpty, { icon: 'info', title: '没有可显示的主智能体人格', hint: '该模式可能没有插件人格。' })),

    props.focus === 'persona' ? null : h(DfCard, {
      title: '子智能体提示词', icon: 'users',
      sub: kind === 'redteam'
        ? (props.eng ? '当前靶标 · ' + dfNum(subs.length) + ' 个 · 派发时生效' : '先选靶标')
        : kind === 'crack'
          ? '整个破解模式 · ' + dfNum(subs.length) + ' 个 · 派发时生效'
          : '该模式没有插件子智能体',
    },
      kind === 'host'
        ? h('div', { className: 'df-note' }, modeName + ' 是宿主模式，插件没有可管理的子智能体提示词。要启用破甲注入请在左侧「破甲注入」层操作。')
        : kind === 'redteam' && !props.eng
          ? h(DfEmpty, { icon: 'target', title: '还没有靶标', hint: '红队子智能体提示词按靶标隔离，先新建或选择靶标。' })
          : !dataReady && promptState.loading
            ? h(DfSkeleton, { lines: 4 })
            : promptState.error || data.ok === false
              ? h(DfOpsError, { title: '读取子智能体提示词失败', error: promptState.error || data.error, onRetry: promptState.reload })
              : subs.length
                ? h('div', { className: 'df-vlist' }, subs.map(function (a) {
                  return h('button', {
                    key: a.id, type: 'button', className: 'df-vrow df-vrow--info',
                    onClick: function () { openSub(a) },
                  },
                    h('span', { className: 'df-vrow-rail' }),
                    h('span', { className: 'df-vrow-main' },
                      h('span', { className: 'df-vrow-hd' },
                        h('span', { className: 'df-vrow-t' }, a.label),
                        h(DfChip, { kind: 'line' }, '代码 ' + a.id),
                        a.planner ? h(DfChip, { kind: 'warn' }, '参考稿') : null,
                        kind === 'crack' && a.customized ? h(DfChip, { kind: 'info' }, '已改') : null),
                      h('span', { className: 'df-vrow-m' },
                        h('span', { className: 'df-vrow-ip' }, dfNum(a.chars) + ' 字符'),
                        h('span', { className: 'df-vrow-sep' }, '·'),
                        h('span', { className: 'df-vrow-url' }, a.scope))),
                    h('span', { className: 'df-vrow-right' }, h('span', { className: 'df-vrow-go' }, '›')))
                }))
                : h(DfEmpty, { icon: 'users', title: '没有子智能体提示词', hint: '该模式没有返回提示词。' })),

    props.focus === 'persona' ? null : h(DfCard, {
      title: '子智能体并发', icon: 'bolt',
      sub: '上限 ' + dfNum(limit) + ' · 正在执行 ' + dfNum(used) + ' · 改动立即生效',
    },
      agentsError
        ? h('div', { className: 'df-note df-note--warn', style: { margin: '0 0 8px' } }, '并发状态读取失败：' + agentsError)
        : null,
      h('div', { className: 'df-statsbar' },
        h(DfStat, { label: '并发上限', icon: 'users', value: max, unit: '个', foot: '来源 · ' + dfAgentsSource(agentsData.source) }),
        h(DfStat, { label: '正在执行', icon: 'bolt', value: used, accent: used > 0, foot: used ? '占用中' : '空闲' }),
        h(DfStat, { label: '可用槽位', icon: 'check', value: Number(agentsData.free) || 0, foot: '上限 ' + limit }),
        h(DfStat, { label: '子会话总数', icon: 'layers', value: Number(agentsData.total_children) || 0 })),

      h('div', { className: 'df-agents-set' },
        h('div', { className: 'df-agents-slider' },
          h('input', {
            type: 'range', min: 1, max: limit, value: isFinite(n) ? Math.min(n, limit) : max,
            onChange: function (e) { setDraft(e.target.value) },
          }),
          h('div', { className: 'df-agents-scale' },
            h('span', null, '1 · 串行'), h('span', null, String(limit)))),
        h('div', { className: 'df-agents-num' },
          h('input', {
            className: 'df-input', type: 'number', min: 1, max: limit, value: draft,
            onChange: function (e) { setDraft(e.target.value) },
            onKeyDown: function (e) { if (e.key === 'Enter') saveMax() },
          }),
          h(DfBtn, { kind: 'primary', icon: 'check', disabled: !canSaveMax || savingMax, onClick: saveMax },
            savingMax ? '保存中…' : '保存'))),
      agentsData.note ? h('div', { className: 'df-hint', style: { padding: '0 14px 12px' } }, agentsData.note) : null,

      running.length
        ? h('div', { className: 'df-rows', style: { padding: '0 14px 12px' } }, running.map(function (r, i) {
          return h('div', { className: 'df-rowitem', key: i },
            h('i', { className: 'df-ri-bar df-ri-bar--info' }),
            h('span', { className: 'df-ri-main' }, r.label || String(r.id || '子会话')),
            h('span', { className: 'df-chip df-chip--info' }, r.activity ? dfAgentsActivity(r.activity) : '执行中'),
            h('span', { className: 'df-ri-side' }, dfAgentsMode(r.mode)))
        }))
        : h('div', { className: 'df-note', style: { padding: '0 14px 12px' } }, '当前没有子智能体在运行。')),
  )
}


return module.exports;
}});
