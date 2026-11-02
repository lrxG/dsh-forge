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

export { parseHttpPackets, httpPacketText, httpStatusText, httpHostName, httpPathOf }
