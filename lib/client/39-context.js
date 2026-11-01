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

