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
