/**
 * 扫描器输出 → importBundle 的 assets 结构。
 *
 * 只做搬运和解析，不做判断：算不算资产、provenance 怎么标、要不要建边，
 * 由调用方（模型 / 工具）决定。解析不出来的行进 note，不静默丢弃。
 *
 * 支持的格式：
 *   fscan  txt（默认）与 json
 *   httpx  jsonl 与 txt
 *   nmap   xml
 *   nuclei jsonl（同时产出资产与漏洞）
 *   burp   xml（issue 列表 → 漏洞）
 *   nessus xml（ReportHost/ReportItem → 资产与漏洞）
 *
 * 解析器只搬运，不判定：nuclei/nessus/burp 的命中一律当 candidate，
 * 由人工复核后才算成果（见 vuln.review_*）。

/** 去掉 ANSI 颜色与 fscan 的方框装饰字符 */
function clean(line) {
  return String(line || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/[\u2500-\u257f]/g, '')
    .trim()
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function isIPv4(text) {
  const m = IPV4.exec(text)
  if (!m) return false
  for (let i = 1; i <= 4; i += 1) {
    const n = Number(m[i])
    if (!Number.isInteger(n) || n < 0 || n > 255) return false
  }
  return true
}

/** 把 `[Product:X] Banner:Y` 这类尾巴拆成 product / banner */
function splitTail(rest) {
  const out = { product: '', banner: '' }
  const productMatch = /\[Product:([^\]]*)\]/.exec(rest)
  if (productMatch) out.product = productMatch[1].trim()
  const bannerMatch = /Banner:(.*)$/i.exec(rest)
  if (bannerMatch) out.banner = bannerMatch[1].trim()
  return out
}

/**
 * fscan 单行：`[*] 1.2.3.4:445   microsoft-ds [Product:Microsoft Windows SMB2] Banner:(...)`
 * 也吃 `[+]` / `[-]` 前缀；没有端口号的（存活行）跳过。
 */
function parseFscanLine(raw) {
  const line = clean(raw)
  if (!line) return null
  const m = /^(?:\[\*\]|\[\+\]|\[-\]|\[!\])\s*(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})\s+(.*)$/.exec(line)
  if (!m) return null
  const ip = m[1]
  const port = Number(m[2])
  if (!isIPv4(ip) || !Number.isInteger(port) || port < 1 || port > 65535) return null
  const rest = m[3].trim()
  if (/^(microsoft-ds|microsoft-ds|netbios-ssn)$/i.test(rest) && !/Product:/i.test(rest)) {
    return { ip, port, service: rest }
  }
  /* 第一个词是服务名，其后是尾巴 */
  const spaceAt = rest.search(/\s/)
  const service = (spaceAt === -1 ? rest : rest.slice(0, spaceAt)).trim()
  const tail = spaceAt === -1 ? '' : rest.slice(spaceAt).trim()
  const extra = splitTail(tail)
  /* 形如 `ssh open` / `http 200` 这类状态词不算服务名 */
  if (/^(open|closed|filtered)$/i.test(service)) {
    const second = tail.split(/\s+/)[0] || ''
    return { ip, port, service: second, ...extra }
  }
  return { ip, port, service, ...extra }
}

/** httpx jsonl 一行。整行必须是合法 JSON 且带 url 字段，否则返回 null 让文本解析兜底。 */
function parseHttpxJson(line) {
  const text = String(line || '').trim()
  if (!text.startsWith('{')) return null
  let j
  try { j = JSON.parse(text) } catch { return null }
  const url = typeof j.url === 'string' ? j.url : (typeof j.input === 'string' ? j.input : '')
  if (!url || !/^https?:\/\//i.test(url)) return null
  let host = ''
  let port = 0
  let proto = 'tcp'
  try {
    const u = new URL(url)
    host = u.hostname
    port = u.port ? Number(u.port) : (/^https:/i.test(u.protocol) ? 443 : 80)
  } catch { return null }
  if (!host) return null
  const hostIsIp = isIPv4(host)
  const entry = {
    ip: hostIsIp ? host : '',
    hostname: hostIsIp ? '' : host,
    port,
    proto,
    service: 'http',
    url,
    title: typeof j.title === 'string' ? j.title : '',
    product: typeof j.webserver === 'string' ? j.webserver : (typeof j.server === 'string' ? j.server : ''),
    status: typeof j.status_code === 'number' ? j.status_code : undefined,
    tech: Array.isArray(j.tech) ? j.tech.filter((x) => typeof x === 'string') : [],
  }
  return entry
}

/** httpx txt 一行：`https://a.example.com [200] [标题] [nginx]` */
function parseHttpxText(line) {
  const text = clean(line)
  if (!text) return null
  /* 整行看起来是 JSON 时交给 JSON 解析，别把字段名吞进 URL */
  if (text.startsWith('{')) return null
  const urlMatch = /(https?:\/\/[^\s\]]+)/i.exec(text)
  if (!urlMatch) return null
  const url = urlMatch[1]
  if (!/^https?:\/\/[^/?#"\\]+\.[^/?#"\\]*(?:[/:?#]|$)/i.test(url) && !/^https?:\/\/\d{1,3}(?:\.\d{1,3}){3}/i.test(url)) return null
  let host = ''
  let port = 0
  try {
    const u = new URL(url)
    host = u.hostname
    port = u.port ? Number(u.port) : (/^https:/i.test(u.protocol) ? 443 : 80)
  } catch { return null }
  const hostIsIp = isIPv4(host)
  const brackets = [...text.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1].trim()).filter(Boolean)
  const status = brackets.length > 0 && /^\d{3}$/.test(brackets[0]) ? Number(brackets[0]) : undefined
  const rest = brackets.slice(status === undefined ? 0 : 1)
  return {
    ip: hostIsIp ? host : '',
    hostname: hostIsIp ? '' : host,
    port,
    proto: 'tcp',
    service: 'http',
    url,
    title: rest[0] || '',
    product: rest[1] || '',
    status,
    tech: [],
  }
}

/** nmap xml：<host><address addr=…><ports><port portid protocol><state state="open"/><service name product version/></port> */
function parseNmapXml(text) {
  const out = []
  const hostBlocks = String(text).match(/<host[\s\S]*?<\/host>/g) || []
  for (const block of hostBlocks) {
    const addr = /<address[^>]*addr="([^"]+)"[^>]*addrtype="ipv4"/.exec(block)
      || /<address[^>]*addrtype="ipv4"[^>]*addr="([^"]+)"/.exec(block)
    if (!addr || !isIPv4(addr[1])) continue
    const ip = addr[1]
    const hostname = /<hostname[^>]*name="([^"]+)"/.exec(block)
    const ports = block.match(/<port[\s\S]*?<\/port>/g) || []
    for (const p of ports) {
      if (!/<state[^>]*state="open"/.test(p)) continue
      const portId = /<port[^>]*portid="(\d+)"/.exec(p)
      if (!portId) continue
      const protoM = /<port[^>]*protocol="([^"]+)"/.exec(p)
      const name = /<service[^>]*name="([^"]*)"/.exec(p)
      const product = /<service[^>]*product="([^"]*)"/.exec(p)
      const version = /<service[^>]*version="([^"]*)"/.exec(p)
      out.push({
        ip,
        hostname: hostname ? hostname[1] : '',
        port: Number(portId[1]),
        proto: protoM && protoM[1] === 'udp' ? 'udp' : 'tcp',
        service: name ? name[1] : '',
        product: product ? product[1] : '',
        version: version ? version[1] : '',
      })
    }
  }
  return out
}

/** 统一截断：证据只留可读的一段，整段输出留在扫描文件里。 */
function clipText(text, max = 4000) {
  const s = String(text || '').trim()
  return s.length > max ? s.slice(0, max) + '\n…（截断，完整内容见扫描输出文件）' : s
}

/** 各种扫描器的等级词 → 库里的五档 */
function severityOf(raw) {
  const s = String(raw || '').trim().toLowerCase()
  if (/^(critical|严重|4)$/.test(s)) return 'critical'
  if (/^(high|高危|3)$/.test(s)) return 'high'
  if (/^(medium|中危|2)$/.test(s)) return 'medium'
  if (/^(low|低危|1)$/.test(s)) return 'low'
  return 'info'
}

/** `https://host:8443/x` 或 `host` → `{ host, port, url }`；认不出返回 null。 */
function targetParts(raw) {
  const text = String(raw || '').trim()
  if (!text) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : ''
  try {
    const u = new URL(withScheme || 'http://' + text)
    const host = u.hostname.replace(/^\[|\]$/g, '')
    if (!host) return null
    const explicit = u.port ? Number(u.port) : 0
    const port = explicit || (/^https:/i.test(u.protocol) ? 443 : 80)
    return { host, port, url: withScheme ? text : '' }
  } catch { return null }
}

/** nuclei jsonl：一行一个命中，资产与漏洞一起产出。 */
function parseNucleiJsonl(text) {
  const assets = []
  const findings = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let j
    try { j = JSON.parse(trimmed) } catch { continue }
    const template = String(j['template-id'] || j.templateID || '').trim()
    const matched = String(j['matched-at'] || j['matched'] || j.host || '').trim()
    if (!template && !matched) continue
    const info = j.info && typeof j.info === 'object' ? j.info : {}
    const host = String(j.ip || '').trim()
    const parts = targetParts(matched || j.host || '')
    const port = Number(j.port) || (parts ? parts.port : 0)
    const isIp = isIPv4(host)
    const urlHost = parts ? parts.host : ''
    const hostname = urlHost && !isIPv4(urlHost) ? urlHost : ''
    if (isIp || hostname) {
      assets.push({
        ip: isIp ? host : '',
        hostname: isIp ? '' : hostname,
        port: port || 0,
        proto: 'tcp',
        service: 'http',
        url: parts && parts.url ? parts.url : (matched.startsWith('http') ? matched : ''),
        title: String(info.name || '').trim(),
        product: '',
      })
    }
    const cveList = info.classification && Array.isArray(info.classification['cve-id'])
      ? info.classification['cve-id'].filter((x) => typeof x === 'string')
      : []
    const evidence = [
      template ? 'template: ' + template : '',
      j['matcher-name'] ? 'matcher: ' + j['matcher-name'] : '',
      matched ? 'matched-at: ' + matched : '',
      j['curl-command'] ? 'curl: ' + j['curl-command'] : '',
    ].filter(Boolean).join('\n')
    findings.push({
      title: String(info.name || template || 'nuclei 命中').trim(),
      severity: severityOf(info.severity),
      cve: cveList[0] || '',
      target: matched || (parts ? parts.host + ':' + parts.port : ''),
      source: 'nuclei',
      evidence: clipText(evidence),
      ip: isIp ? host : '',
      hostname: isIp ? '' : hostname,
      port: port || 0,
      assetKey: isIp ? host : hostname,
    })
  }
  return { assets, findings }
}

/** Burp XML（issue 列表）：只取 <issue>，站点地图导出不在这里处理。 */
function parseBurpXml(text) {
  const findings = []
  const blocks = String(text || '').match(/<issue>[\s\S]*?<\/issue>/g) || []
  const pick = (block, tag) => {
    const m = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>').exec(block)
    return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : ''
  }
  for (const block of blocks) {
    const name = pick(block, 'name')
    if (!name) continue
    const host = pick(block, 'host')
    const path = pick(block, 'path')
    const location = pick(block, 'location')
    const url = /^https?:\/\//i.test(host)
      ? host.replace(/\/+$/, '') + (path && path !== '/' ? (path.startsWith('/') ? path : '/' + path) : '')
      : ''
    const parts = targetParts(url || host)
    const detail = pick(block, 'issueDetail') || pick(block, 'issueBackground')
    findings.push({
      title: name,
      severity: severityOf(pick(block, 'severity')),
      cve: '',
      target: url || (parts ? parts.host + ':' + parts.port : host) || location,
      source: 'burp',
      evidence: clipText([
        detail,
        location ? 'location: ' + location : '',
        pick(block, 'confidence') ? 'confidence: ' + pick(block, 'confidence') : '',
      ].filter(Boolean).join('\n')),
      ip: parts && isIPv4(parts.host) ? parts.host : '',
      hostname: parts && !isIPv4(parts.host) ? parts.host : '',
      port: parts ? parts.port : 0,
      assetKey: parts ? parts.host : '',
    })
  }
  return { assets: [], findings }
}

/** Nessus XML：<ReportHost name> 下每个 <ReportItem> 既是一条端口，也是一条漏洞。 */
function parseNessusXml(text) {
  const assets = []
  const findings = []
  const attr = (block, key) => {
    const m = new RegExp(key + '="([^"]*)"').exec(block)
    return m ? m[1] : ''
  }
  const pick = (block, tag) => {
    const m = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>').exec(block)
    return m ? m[1].trim() : ''
  }
  const hosts = String(text || '').match(/<ReportHost[\s\S]*?<\/ReportHost>/g) || []
  for (const hostBlock of hosts) {
    const hostName = attr(/^<ReportHost[^>]*>/.exec(hostBlock)?.[0] || '', 'name')
    if (!hostName) continue
    const isIp = isIPv4(hostName)
    const items = hostBlock.match(/<ReportItem[\s\S]*?<\/ReportItem>/g) || []
    for (const item of items) {
      const port = Number(attr(/^<ReportItem[^>]*>/.exec(item)?.[0] || '', 'port')) || 0
      const svc = attr(/^<ReportItem[^>]*>/.exec(item)?.[0] || '', 'svc_name')
      if (port > 0) {
        assets.push({
          ip: isIp ? hostName : '',
          hostname: isIp ? '' : hostName,
          port,
          proto: 'tcp',
          service: svc || '',
        })
      }
      const pluginName = attr(/^<ReportItem[^>]*>/.exec(item)?.[0] || '', 'pluginName')
      const severity = Number(attr(/^<ReportItem[^>]*>/.exec(item)?.[0] || '', 'severity'))
      const cve = pick(item, 'cve').split(/[\s,;]+/).filter(Boolean)[0] || ''
      const output = pick(item, 'plugin_output')
      if (!pluginName || severity === 0) continue
      findings.push({
        title: pluginName,
        severity: severityOf(severity),
        cve,
        target: hostName + (port ? ':' + port : ''),
        source: 'nessus',
        evidence: clipText([
          output,
          pick(item, 'risk_factor') ? 'risk: ' + pick(item, 'risk_factor') : '',
          pick(item, 'solution') ? 'solution: ' + pick(item, 'solution') : '',
        ].filter(Boolean).join('\n')),
        ip: isIp ? hostName : '',
        hostname: isIp ? '' : hostName,
        port,
        assetKey: hostName,
      })
    }
  }
  return { assets, findings }
}


function group(rows) {
  const byKey = new Map()
  const skipped = []
  for (const row of rows) {
    const key = row.ip || row.hostname
    if (!key) { skipped.push(row); continue }
    let asset = byKey.get(key)
    if (!asset) {
      asset = { ip: row.ip || '', primary_name: row.hostname || '', names: [], ports: [], _ports: new Set() }
      byKey.set(key, asset)
    }
    if (row.hostname && !asset.names.some((n) => n.name === row.hostname)) {
      asset.names.push({ name: row.hostname, kind: 'domain' })
    }
    if (row.hostname && !asset.primary_name) asset.primary_name = row.hostname
    /* 只记主机、没有端口的行（nuclei 某些命中）：资产照建，不造 0 号端口 */
    if (!(Number(row.port) > 0)) continue
    const pkey = (row.proto || 'tcp') + ':' + row.port
    if (asset._ports.has(pkey)) {
      /* 同端口再次出现：只补 details，不重复建端口 */
      const existing = asset.ports.find((p) => (p.proto || 'tcp') + ':' + p.port === pkey)
      if (existing) {
        if (!existing.url && row.url) existing.url = row.url
        if (!existing.title && row.title) existing.title = row.title
        if (!existing.product && row.product) existing.product = row.product
        if (!existing.banner && row.banner) existing.banner = row.banner
      }
      continue
    }
    asset._ports.add(pkey)
    const port = {
      port: row.port,
      proto: row.proto || 'tcp',
      service: row.service || '',
    }
    if (row.product) port.product = row.product
    if (row.version) port.version = row.version
    if (row.banner) port.banner = row.banner
    if (row.url) port.url = row.url
    if (row.title) port.title = row.title
    if (Array.isArray(row.tech) && row.tech.length > 0) {
      port.fingerprints = row.tech.map((t) => ({ category: 'Web技术', product: t, evidence: 'httpx tech-detect' }))
    }
    asset.ports.push(port)
  }
  for (const asset of byKey.values()) delete asset._ports
  return { assets: [...byKey.values()], skipped }
}

/**
 * 解析一份扫描输出。
 * @param {string} text 文件内容
 * @param {string} format  fscan | httpx | nmap | nuclei | burp | nessus | auto
 * @returns {{ assets, skipped, findings, format, lines, matched }}
 */
export function parseScanOutput(text, format = 'auto') {
  const raw = String(text || '')
  const lines = raw.split(/\r?\n/)
  let fmt = String(format || 'auto').toLowerCase()
  if (fmt === 'auto') {
    if (/<nmaprun/i.test(raw)) fmt = 'nmap'
    else if (/"template-id"\s*:/.test(raw)) fmt = 'nuclei'
    else if (/<NessusClientData_v2|<ReportHost[\s>]/i.test(raw)) fmt = 'nessus'
    else if (/<issues[\s>]|<issue>/i.test(raw)) fmt = 'burp'
    else if (/^\s*\{.*"url"\s*:/m.test(raw)) fmt = 'httpx-jsonl'
    else if (/https?:\/\//.test(raw) && /\[\d{3}\]/.test(raw)) fmt = 'httpx'
    else fmt = 'fscan'
  }

  let rows = []
  let findings = []
  let matched = 0
  if (fmt === 'nmap') {
    rows = parseNmapXml(raw)
    matched = rows.length
  } else if (fmt === 'nuclei') {
    const parsed = parseNucleiJsonl(raw)
    rows = parsed.assets
    findings = parsed.findings
    matched = rows.length
  } else if (fmt === 'burp') {
    findings = parseBurpXml(raw).findings
  } else if (fmt === 'nessus') {
    const parsed = parseNessusXml(raw)
    rows = parsed.assets
    findings = parsed.findings
    matched = rows.length
  } else if (fmt === 'httpx' || fmt === 'httpx-jsonl' || fmt === 'httpx-json') {
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const row = parseHttpxJson(trimmed) || parseHttpxText(trimmed)
      if (row) { rows.push(row); matched += 1 }
    }
  } else if (fmt === 'fscan-json') {
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed[0] !== '{') continue
      try {
        const j = JSON.parse(trimmed)
        if (typeof j.host === 'string' && j.port) {
          rows.push({ ip: j.host, port: Number(j.port), service: j.type || j.service || '' })
          matched += 1
        }
      } catch { /* 非 JSON 行跳过 */ }
    }
  } else {
    for (const line of lines) {
      const row = parseFscanLine(line)
      if (row) { rows.push(row); matched += 1 }
    }
  }

  const grouped = group(rows)
  return {
    format: fmt,
    lines: lines.length,
    matched,
    assets: grouped.assets,
    skipped: grouped.skipped.length,
    findings,
  }
}

export default { parseScanOutput }
