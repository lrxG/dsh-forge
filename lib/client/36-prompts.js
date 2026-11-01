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

