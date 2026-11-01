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
