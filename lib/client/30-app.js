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
