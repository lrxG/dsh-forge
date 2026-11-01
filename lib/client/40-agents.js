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
