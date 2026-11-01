/**
 * 真实浏览器工具（红队）。
 *
 * 目标：dsh 自己拥有一个和用户日常 Chrome 隔离的浏览器：
 *   · 本机安装的 Chrome/Edge，默认 headed，保留真实 GPU/字体/Canvas 指纹；
 *   · 独立 user-data-dir：$DSH_HOME/browser/profile，不碰用户日常 profile；
 *   · 手动启动 + CDP 连接，避免 Playwright 的 --enable-automation 痕迹；
 *   · 只有需要登录态、真实指纹、点击/填表、登录后请求时才用，普通页面先 curl/headless。
 *
 * 不依赖 Playwright：Node 22+ 自带 WebSocket，直接说 CDP。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, isAbsolute } from 'node:path'
import { loadDefineTool } from '../tool-loader.js'
import { bindEngagement, boundEngagementOf } from './session-bindings.js'
import { loadPlatformConfig, redteamRoot } from './platform-config.js'
import { cookieHeader, oldestInactive, pickTarget, tabRows } from './browser-tabs.js'

const defineTool = loadDefineTool()

export const name = 'dsh-forge-redteam-browser'
export const inject = ['tools']

const DEFAULT_PORT = 9222
const MAX_TEXT = 12000
const networkByPort = new Map()
/* 会话按 target 缓存（一个端口下可以有多页），当前页按端口记；lastUsed 用来淘汰闲置标签页。 */
const sessionsByTarget = new Map()
const currentByPort = new Map()
const lastUsed = new Map()
const MAX_TABS = 8

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function home() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function browserRoot() {
  return join(home(), 'browser')
}

function defaultProfile() {
  return join(browserRoot(), 'profile')
}

function screenshotsDir() {
  return join(browserRoot(), 'screenshots')
}

function statePath() {
  return join(browserRoot(), 'state.json')
}

function readState() {
  try { return JSON.parse(readFileSync(statePath(), 'utf8')) } catch { return null }
}

function writeState(state) {
  mkdirSync(browserRoot(), { recursive: true })
  writeFileSync(statePath(), JSON.stringify(state, null, 2), 'utf8')
}

function clearState() {
  try { rmSync(statePath(), { force: true }) } catch { /* ignore */ }
}

function safeProfile(value) {
  const raw = String(value || 'profile').trim() || 'profile'
  return raw.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64) || 'profile'
}

/**
 * profile 只认名字，不认路径：一律落在 $DSH_HOME/browser 下。
 * 传绝对路径或带分隔符的名字直接拒——否则 Chrome 会把 user-data-dir 建到靶标目录里
 * （实测有人在 src-intigriti 下留了 709 MB 的 browser-profile）。
 */
function resolveProfile(value) {
  if (value === undefined || value === null || String(value).trim() === '') return defaultProfile()
  const name = String(value).trim()
  if (/[\\/:]/.test(name) || name === '.' || name === '..') {
    throw new Error('profile 只能是名字（字母/数字/._-），不能传路径：所有 profile 固定放在 $DSH_HOME/browser 下，换名字就是换 profile')
  }
  return join(browserRoot(), safeProfile(name))
}

function proxyFromConfig() {
  try {
    const cfg = loadPlatformConfig(redteamRoot())
    const raw = String((cfg && cfg.egress && cfg.egress.proxy) || '').trim()
    return raw
  } catch { return '' }
}

function chromeCandidates() {
  if (process.platform === 'win32') {
    return [
      join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ].filter(Boolean)
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']
}

function findChrome() {
  return chromeCandidates().find((p) => p && existsSync(p)) || ''
}

async function probe(port) {
  if (typeof fetch !== 'function') return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 1500)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ctrl.signal })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Chrome 在自己的 user-data-dir 里写 DevToolsActivePort：第一行端口，第二行浏览器级 ws 路径。
 * state.json 丢了或过期时靠它接回同一个实例——端口可能不是 9222（当年被占过），所以不按端口猜。
 * ws 路径必须与 /json/version 报的一致，否则那个端口已被别的浏览器复用。
 */
async function adoptActivePort(profile) {
  let port = 0
  let wsPath = ''
  try {
    const lines = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)
    port = Number(String(lines[0] || '').trim())
    wsPath = String(lines[1] || '').trim()
  } catch { return null }
  if (!port || !wsPath) return null
  const version = await probe(port)
  if (!version || !version.webSocketDebuggerUrl) return null
  if (!String(version.webSocketDebuggerUrl).endsWith(wsPath)) return null
  return { port, version }
}

async function startChrome(args = {}) {
  const profile = resolveProfile(args.profile)
  mkdirSync(profile, { recursive: true })

  const wantedPort = Number(args.port) || DEFAULT_PORT
  const state = readState()
  if (state && state.profile === profile && await probe(state.port)) {
    return { ok: true, reused: true, port: Number(state.port), profile, pid: state.pid, headless: Boolean(state.headless) }
  }

  /* state.json 丢了/过期而 Chrome 还活着时，接回同一个实例；
     否则会拿同一个 profile 再 spawn 一个，新进程不监听端口（报「profile 已被另一个实例占用」）。 */
  const adopted = await adoptActivePort(profile)
  if (adopted) {
    writeState({
      pid: null,
      port: adopted.port,
      profile,
      headless: null,
      chrome: findChrome() || null,
      proxy: proxyFromConfig() || null,
      started_at: new Date().toISOString(),
      adopted: true,
    })
    return {
      ok: true,
      reused: true,
      adopted: true,
      port: adopted.port,
      profile,
      pid: null,
      headless: null,
      browser: adopted.version.Browser || '',
      note: '接上已在运行的同一个 profile 实例（state.json 丢失或过期时走这条）',
    }
  }

  /* 端口被别的 Chrome 占了就顺延，避免接错实例。 */
  let port = wantedPort
  for (let i = 0; i < 10; i += 1) {
    if (!(await probe(port))) break
    port += 1
  }
  if (await probe(port)) throw new Error(`浏览器调试端口 ${wantedPort}–${port} 都被占用；先关掉占用的 Chrome 或换端口`)

  const chrome = findChrome()
  if (!chrome) throw new Error('找不到 Chrome / Edge；先安装 Chrome，或把 chrome.exe 加入 PATH')

  const headless = args.headless === true
  const proxy = String(args.proxy || proxyFromConfig() || '').trim()
  const flags = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
  ]
  if (headless) flags.push('--headless=new')
  if (proxy) flags.push(`--proxy-server=${proxy}`)

  const child = spawn(chrome, flags, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.unref()

  let version = null
  for (let i = 0; i < 60; i += 1) {
    await sleep(250)
    version = await probe(port)
    if (version) break
  }
  if (!version) {
    try { child.kill() } catch { /* ignore */ }
    throw new Error('Chrome 已启动但没有监听调试端口；可能是 profile 已被另一个实例占用，关掉同 profile 的窗口再试')
  }

  writeState({
    pid: child.pid,
    port,
    profile,
    headless,
    chrome,
    proxy: proxy || null,
    started_at: new Date().toISOString(),
  })
  return {
    ok: true,
    reused: false,
    port,
    profile,
    pid: child.pid,
    headless,
    browser: version.Browser || '',
    note: headless ? 'headless 会改变指纹；真实浏览器建议不传 headless' : 'headed 真实浏览器；登录一次后 profile 会保留',
  }
}

async function listPages(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  if (!res.ok) throw new Error('读取标签页列表失败：' + res.status)
  const list = await res.json()
  return Array.isArray(list) ? list.filter((t) => t && t.type === 'page' && t.webSocketDebuggerUrl) : []
}

async function createPage(port, url) {
  const targetUrl = url ? String(url) : 'about:blank'
  let res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(targetUrl)}`, { method: 'PUT' })
  if (!res.ok) res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(targetUrl)}`, { method: 'POST' })
  if (!res.ok) throw new Error('创建浏览器标签页失败：' + res.status)
  return res.json()
}

async function closePage(port, id) {
  const res = await fetch(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(id)}`)
  sessionsByTarget.delete(id)
  lastUsed.delete(id)
  if (currentByPort.get(port) === id) currentByPort.delete(port)
  if (!res.ok) throw new Error('关闭标签页失败：' + res.status)
  return true
}

/* 当前页还在就用它（换页/被关就退回第一页）；一页都没有就开一个空白页。 */
async function getPageTarget(port) {
  const pages = await listPages(port)
  const currentId = currentByPort.get(port)
  const current = currentId ? pages.find((t) => String(t.id || '') === String(currentId)) : null
  if (current) return current
  if (pages.length > 0) {
    currentByPort.set(port, String(pages[0].id || ''))
    return pages[0]
  }
  const created = await createPage(port, 'about:blank')
  currentByPort.set(port, String(created.id || ''))
  return created
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.seq = 0
    this.pending = new Map()
    this.handlers = new Map()
    this.closed = false
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时（10s）')), 10000)
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      this.ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP WebSocket 连接失败')) }, { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      let msg
      try { msg = JSON.parse(String(event.data)) } catch { return }
      if (msg.id !== undefined && msg.id !== null) {
        const entry = this.pending.get(msg.id)
        if (!entry) return
        this.pending.delete(msg.id)
        if (msg.error) entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
        else entry.resolve(msg.result)
        return
      }
      if (msg.method) {
        for (const fn of this.handlers.get(msg.method) || []) {
          try { fn(msg.params || {}) } catch { /* ignore */ }
        }
      }
    })
    this.ws.addEventListener('close', () => {
      this.closed = true
      for (const [, entry] of this.pending) entry.reject(new Error('CDP 连接已关闭'))
      this.pending.clear()
    })
  }

  async send(method, params = {}) {
    await this.ready
    if (this.closed) throw new Error('CDP 连接已关闭')
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (e) {
        this.pending.delete(id)
        reject(e)
      }
    })
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, [])
    this.handlers.get(method).push(fn)
  }

  close() {
    this.closed = true
    try { this.ws.close() } catch { /* ignore */ }
  }
}

async function connect(port) {
  if (typeof WebSocket !== 'function') throw new Error('当前 Node 没有全局 WebSocket（需要 Node 22+）')
  const target = await getPageTarget(port)
  const targetId = String(target.id || '')
  currentByPort.set(port, targetId)
  const existing = sessionsByTarget.get(targetId)
  if (existing && !existing.cdp.closed) {
    lastUsed.set(targetId, Date.now())
    return existing
  }
  const cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Network.enable')

  const network = []
  networkByPort.set(port, network)
  const upsert = (requestId) => {
    let row = network.find((n) => n.id === requestId)
    if (!row) {
      row = { id: requestId, method: '', url: '', type: '', status: null, mime: '', error: '' }
      network.push(row)
      if (network.length > 300) network.shift()
    }
    return row
  }
  cdp.on('Network.requestWillBeSent', (p) => {
    const row = upsert(p.requestId)
    row.method = p.request?.method || ''
    row.url = p.request?.url || ''
    row.type = p.type || ''
  })
  cdp.on('Network.responseReceived', (p) => {
    const row = upsert(p.requestId)
    row.status = p.response?.status ?? null
    row.mime = p.response?.mimeType || ''
    row.url = p.response?.url || row.url
  })
  cdp.on('Network.loadingFailed', (p) => {
    const row = upsert(p.requestId)
    row.error = p.errorText || 'failed'
  })

  const session = { port, cdp, target, network }
  sessionsByTarget.set(targetId, session)
  lastUsed.set(targetId, Date.now())
  return session
}

async function evalValue(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  })
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text || '页面脚本执行失败'
    throw new Error(text)
  }
  return result.result?.value
}

async function waitReady(cdp, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      const state = await evalValue(cdp, 'document.readyState')
      if (state === 'complete' || state === 'interactive') return true
    } catch { /* 页面还在导航 */ }
    await sleep(250)
  }
  return false
}

async function pageInfo(cdp) {
  try {
    return await evalValue(cdp, '({ url: location.href, title: document.title })')
  } catch {
    return { url: '', title: '' }
  }
}

async function openUrl(cdp, url) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('url 必须是 http/https')
  await cdp.send('Page.navigate', { url: String(url) })
  const ready = await waitReady(cdp)
  return { ...(await pageInfo(cdp)), ready }
}

function hostOf(url) {
  try { return new URL(String(url)).hostname } catch { return '' }
}

async function tabsAction(port) {
  const pages = await listPages(port)
  return { total: pages.length, tabs: tabRows(pages, currentByPort.get(port)) }
}

async function newTab(port, url) {
  if (url && !/^https?:\/\//i.test(String(url))) throw new Error('url 必须是 http/https')
  const created = await createPage(port, url)
  const createdId = String(created.id || '')
  currentByPort.set(port, createdId)
  lastUsed.set(createdId, Date.now())
  /* 页太多就把最久没用过的非当前页关掉，别让标签页堆着 */
  const after = await listPages(port)
  const closed = []
  for (const id of oldestInactive(after, createdId, lastUsed, MAX_TABS)) {
    try { await closePage(port, id); closed.push(id) } catch { /* 关不掉就留着 */ }
  }
  const session = await connect(port)
  const ready = await waitReady(session.cdp)
  return { ok: true, id: createdId, ...(await pageInfo(session.cdp)), ready, closed, tabs: (await tabsAction(port)).tabs }
}

async function switchTab(port, selector) {
  const pages = await listPages(port)
  const target = pickTarget(pages, selector)
  if (!target) throw new Error('找不到标签页：' + (selector === undefined ? '(空)' : selector) + '（先用 tabs 看列表）')
  const id = String(target.id || '')
  currentByPort.set(port, id)
  lastUsed.set(id, Date.now())
  const session = await connect(port)
  return { ok: true, id, ...(await pageInfo(session.cdp)) }
}

async function closeTab(port, selector) {
  const pages = await listPages(port)
  if (pages.length === 0) return { ok: true, closed: null, note: '没有打开的标签页' }
  /* 只剩一页时不当最后那个关，Chrome 关掉最后一个页会直接退出 */
  if (pages.length === 1) {
    return { ok: false, closed: null, note: '只剩一个标签页，关掉会让浏览器退出；要收工用 stop', tabs: tabRows(pages, currentByPort.get(port)) }
  }
  let target = pickTarget(pages, selector)
  if (!target) throw new Error('找不到标签页：' + (selector === undefined ? '(空)' : selector) + '（先用 tabs 看列表）')
  const id = String(target.id || '')
  await closePage(port, id)
  const rest = await listPages(port)
  const nextId = String((rest[0] && rest[0].id) || '')
  if (nextId) {
    currentByPort.set(port, nextId)
    lastUsed.set(nextId, Date.now())
  }
  return { ok: true, closed: id, tabs: tabRows(rest, nextId) }
}

/**
 * 取整套 Cookie（含 HttpOnly），并给出能直接塞进 curl -H 的头。
 * 登录态交给发包工具时用它，不要用 eval 读 document.cookie——HttpOnly 的那部分读不到。
 */
async function cookiesAction(cdp, args) {
  const info = await pageInfo(cdp)
  const host = String(args.host || '').trim().toLowerCase() || hostOf(info.url)
  let cookies = []
  try {
    const res = await cdp.send('Storage.getCookies', {})
    cookies = Array.isArray(res && res.cookies) ? res.cookies : []
  } catch { /* 老版本没有 Storage.getCookies */ }
  if (cookies.length === 0) {
    try {
      const urls = info.url && /^https?:\/\//i.test(info.url) ? { urls: [info.url] } : {}
      const res = await cdp.send('Network.getCookies', urls)
      cookies = Array.isArray(res && res.cookies) ? res.cookies : []
    } catch { cookies = [] }
  }
  const rows = cookies
    .filter((c) => c && c.name)
    .map((c) => ({
      name: c.name,
      domain: c.domain,
      path: c.path,
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
      expires: c.expires === undefined ? null : c.expires,
      value: String(c.value === undefined || c.value === null ? '' : c.value),
    }))
  const matched = String(args.host || '').trim()
    ? rows.filter((c) => c.domain && (host === String(c.domain).replace(/^\./, '') || host.endsWith('.' + String(c.domain).replace(/^\./, ''))))
    : rows
  const header = cookieHeader(rows, host)
  const limit = Math.max(1, Math.min(Number(args.limit) || 100, 300))
  return {
    ok: true,
    host: host || null,
    total: rows.length,
    matched: matched.length,
    header: header.length > 8000 ? header.slice(0, 8000) : header,
    header_truncated: header.length > 8000,
    cookies: rows.slice(0, limit),
    truncated: rows.length > limit,
  }
}

async function snapshot(cdp) {
  const value = await evalValue(cdp, `(() => {
    const text = document.body ? String(document.body.innerText || '') : '';
    const nodes = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"]'))
      .slice(0, 100)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          text: String(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().slice(0, 120),
          name: el.getAttribute('name') || '',
          type: el.getAttribute('type') || '',
          href: el.tagName === 'A' ? String(el.href || '') : '',
          visible: r.width > 0 && r.height > 0,
        };
      });
    return { url: location.href, title: document.title, text: text.slice(0, ${MAX_TEXT}), elements: nodes };
  })()`)
  return value
}

async function click(cdp, selector) {
  const rect = await evalValue(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(String(selector || ''))});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
  })()`)
  if (!rect) throw new Error('找不到元素：' + selector)
  if (rect.width <= 0 || rect.height <= 0) {
    const ok = await evalValue(cdp, `(() => { const el = document.querySelector(${JSON.stringify(String(selector || ''))}); if (!el) return false; el.click(); return true })()`)
    if (!ok) throw new Error('元素不可点击：' + selector)
    return { clicked: true, fallback: 'element.click()' }
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  return { clicked: true, x: rect.x, y: rect.y }
}

async function fill(cdp, selector, value) {
  const result = await evalValue(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(String(selector || ''))});
    if (!el) return null;
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, ${JSON.stringify(String(value ?? ''))});
    else el.value = ${JSON.stringify(String(value ?? ''))};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { tag: el.tagName.toLowerCase(), value: el.value };
  })()`)
  if (!result) throw new Error('找不到输入框：' + selector)
  return result
}

async function press(cdp, key) {
  const k = String(key || 'Enter')
  const map = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Space: 32 }
  const base = {
    key: k,
    code: k,
    windowsVirtualKeyCode: map[k] || 0,
    nativeVirtualKeyCode: map[k] || 0,
  }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  return { pressed: k }
}

function resolveStore(ctx) {
  try { return ctx.redteam } catch { /* ignore */ }
  try { return ctx.get('redteam') } catch { return null }
}

/* 与 tools.js 的 resolveEngagement 同一口径：显式 > 本会话绑定 > 单靶标自动绑。
   多靶标但未绑定时绝不采纳全局「当前靶标」——截图会写库，猜错就是串靶标。 */
function resolveEngagement(ctx, exec, args) {
  const explicit = String(args.engagement || '').trim()
  if (explicit) return explicit
  try {
    const bound = boundEngagementOf(exec)
    if (bound) return bound
  } catch { /* ignore */ }
  const store = resolveStore(ctx)
  let list = []
  try {
    list = store && typeof store.listEngagements === 'function' ? store.listEngagements() : []
  } catch { list = [] }
  if (list.length === 1) {
    try { bindEngagement(exec, list[0].id) } catch { /* 绑定失败仍然用这个唯一靶标 */ }
    return list[0].id
  }
  if (list.length === 0) return ''
  throw new Error('本会话尚未绑定靶标，浏览器截图不会猜全局「当前靶标」。请先 redteam_session_bind 或 redteam_engagement_open。')
}

async function screenshot(cdp, ctx, exec, args) {
  /* 先解析靶标再截图：多靶标未绑定时直接报错，避免写完文件才发现没入库。 */
  const engagement = resolveEngagement(ctx, exec, args)
  const full = args.full_page === true
  const result = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: full,
  })
  const buf = Buffer.from(result.data, 'base64')
  const info = await pageInfo(cdp)
  let out = ''
  if (args.path) {
    out = isAbsolute(String(args.path)) ? String(args.path) : join(browserRoot(), String(args.path))
  } else {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    out = join(screenshotsDir(), `${stamp}.png`)
  }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, buf)

  const store = resolveStore(ctx)
  let shot = null
  if (store && engagement) {
    try {
      shot = store.addShot(engagement, {
        data_base64: result.data,
        kind: 'screenshot',
        vuln_id: args.vuln_id === undefined || args.vuln_id === null ? null : Number(args.vuln_id),
        asset_id: args.asset_id === undefined || args.asset_id === null ? null : Number(args.asset_id),
        target: info.url || null,
        label: String(args.label || info.title || info.url || '浏览器截图').slice(0, 120),
        note: String(args.note || '').trim() || null,
        source_ref: info.url || null,
        agent: 'browser',
      })
    } catch (e) {
      shot = { ok: false, error: String(e && e.message ? e.message : e) }
    }
  }
  return {
    ok: true, path: out, bytes: buf.length, url: info.url, title: info.title, shot,
    ...(shot === null && store
      ? { hint: '还没有靶标：截图只落磁盘、未入库。先 redteam_engagement_open 或 redteam_session_bind。' }
      : {}),
  }
}

async function status() {
  const state = readState()
  const live = state ? await probe(state.port) : null
  let tabs = null
  if (live) {
    try { tabs = (await listPages(Number(state.port))).length } catch { tabs = null }
  }
  return {
    ok: true,
    running: Boolean(live),
    state: live ? state : null,
    profile: state?.profile || defaultProfile(),
    port: live ? Number(state.port) : null,
    stale: Boolean(state && !live),
    ...(tabs === null ? {} : { tabs }),
  }
}

async function stop(ctx) {
  const state = readState()
  const port = Number(state?.port) || null
  const currentId = port ? currentByPort.get(port) : null
  let session = currentId ? sessionsByTarget.get(currentId) : null
  /* 接上来（adopted）的实例没有 pid，关它只能走 CDP；缓存里没有会话就现连一次。 */
  if (!session && port) {
    try { session = await connect(port) } catch { session = null }
  }
  if (session) {
    try { await session.cdp.send('Browser.close') } catch { /* ignore */ }
  }
  for (const [, s] of sessionsByTarget) {
    try { s.cdp.close() } catch { /* ignore */ }
  }
  sessionsByTarget.clear()
  currentByPort.clear()
  lastUsed.clear()
  if (state && state.pid) {
    await sleep(300)
    try { process.kill(Number(state.pid)) } catch { /* 已经退出 */ }
  }
  clearState()
  if (port) networkByPort.delete(port)
  return { ok: true, stopped: Boolean(state), port }
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'browser',
    description: '真实浏览器（本机 Chrome/Edge，独立 profile，默认 headed + CDP）。需要登录态、真实指纹、点击/填表、抓登录后请求时用；**搜索或抓取通道报错（401、被挡、只有 JS 外壳）也用它换路**——开搜索引擎、或直接开那个页面。普通页面仍先 curl/headless。多页用 open 的 new_tab（默认复用当前页）；一页要挂着不动的、另一页去打，用完后 closetab 关掉——超过 8 页会自动淘汰最久没用的那页。cookies 给出整套 Cookie 和能直接塞进 curl 的头（含 HttpOnly，eval 读 document.cookie 读不到）。动作：start/status/open/snapshot/click/fill/press/eval/screenshot/network/tabs/switch/closetab/cookies/stop。',
    parameters: {
      action: { type: 'string', required: true, description: 'start | status | open | snapshot | click | fill | press | eval | screenshot | network | tabs | switch | closetab | cookies | stop' },
      args: { type: 'object', additionalProperties: true, description: '动作参数；open:{url,new_tab?}；switch/closetab:{tab:序号|url子串|id}；cookies:{host?,limit?}；click/fill:{selector,value}；screenshot:{vuln_id?,full_page?,label?}' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] },
    async execute(args, exec) {
      const action = String(args && args.action || '').trim().toLowerCase()
      const inner = (args && args.args && typeof args.args === 'object' && !Array.isArray(args.args)) ? Object.assign({}, args.args) : {}
      /* 和 redteam 入口一致：模型有时把参数平铺在顶层，而不是放进 args。 */
      for (const [k, v] of Object.entries(args || {})) {
        if (k !== 'action' && k !== 'args' && inner[k] === undefined) inner[k] = v
      }
      try {
        if (action === 'start') return JSON.stringify(await startChrome(inner), null, 2)
        if (action === 'status') return JSON.stringify(await status(), null, 2)
        if (action === 'stop') return JSON.stringify(await stop(ctx), null, 2)

        const state = readState()
        if (!state) throw new Error('浏览器还没启动：先 browser({action:"start"})')
        const port = Number(state.port)

        /* 这几个动作自己挑页/换页，不能先按当前页建连接 */
        if (action === 'tabs') return JSON.stringify({ ok: true, ...(await tabsAction(port)) }, null, 2)
        if (action === 'switch') return JSON.stringify(await switchTab(port, inner.tab), null, 2)
        if (action === 'closetab') return JSON.stringify(await closeTab(port, inner.tab), null, 2)
        if (action === 'open' && inner.new_tab === true) return JSON.stringify(await newTab(port, inner.url), null, 2)

        const session = await connect(port)
        const cdp = session.cdp

        if (action === 'open') return JSON.stringify({ ok: true, ...(await openUrl(cdp, inner.url)) }, null, 2)
        if (action === 'snapshot') return JSON.stringify({ ok: true, ...(await snapshot(cdp)) }, null, 2)
        if (action === 'click') return JSON.stringify({ ok: true, ...(await click(cdp, inner.selector)) }, null, 2)
        if (action === 'fill') return JSON.stringify({ ok: true, ...(await fill(cdp, inner.selector, inner.value)) }, null, 2)
        if (action === 'press') return JSON.stringify({ ok: true, ...(await press(cdp, inner.key)) }, null, 2)
        if (action === 'eval') {
          const value = await evalValue(cdp, String(inner.script || 'null'))
          const text = typeof value === 'string' ? value : JSON.stringify(value)
          return JSON.stringify({ ok: true, value: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '…' : text }, null, 2)
        }
        if (action === 'cookies') return JSON.stringify(await cookiesAction(cdp, inner), null, 2)
        if (action === 'screenshot') return JSON.stringify(await screenshot(cdp, ctx, exec, inner), null, 2)
        if (action === 'network') {
          const list = networkByPort.get(port) || []
          const limit = Math.max(1, Math.min(Number(inner.limit) || 50, 200))
          const items = list.slice(-limit).map((n) => ({ ...n }))
          if (inner.clear === true) list.length = 0
          return JSON.stringify({ ok: true, items, total: items.length }, null, 2)
        }
        return JSON.stringify({ ok: false, error: '未知动作：' + (action || '(空)'), actions: ['start', 'status', 'open', 'snapshot', 'click', 'fill', 'press', 'eval', 'screenshot', 'network', 'tabs', 'switch', 'closetab', 'cookies', 'stop'] }, null, 2)
      } catch (error) {
        return JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }, null, 2)
      }
    },
  }))
}
