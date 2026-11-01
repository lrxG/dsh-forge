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
