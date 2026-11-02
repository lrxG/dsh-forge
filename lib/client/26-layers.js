/* 提示词生效链路：把宿主真实存在的三层机制画成一条竖排链路。
   这里不读数据、不发请求，只负责把「是什么、管多大范围、何时生效、能不能改」摆清楚。
   宿主没有「用户级 agent / 项目级 agent」这两层：AGENTS.md 是工作区指令，不是 agent。 */

const DF_PROMPT_LAYERS = [
  {
    id: 'system', no: '01',
    title: '系统提示词', role: 'system 角色', scope: 'Agent 预设',
    purpose: '决定它是谁、能用哪些工具',
    items: [
      { label: '部署身份' },
      { label: '模式与工具' },
      { label: '主智能体人格', edit: true },
    ],
    when: '重启后生效', page: 'agents', pageLabel: '智能体',
  },
  {
    id: 'workspace', no: '02',
    title: '工作区指令', role: 'user 角色', scope: '当前工作目录',
    purpose: '补充这个项目里的做法与约束',
    items: [
      { label: '用户级' },
      { label: '共享级' },
      { label: '项目根' },
      { label: '上级目录' },
      { label: '当前目录' },
    ],
    when: '下一轮生效', page: 'instructions', pageLabel: '工作区指令',
  },
  {
    id: 'sub', no: '03',
    title: '子智能体会话', role: '继承预设', scope: '派发时创建',
    purpose: '不重设身份，只带任务与角色稿',
    items: [
      { label: '继承的预设' },
      { label: '任务提示词' },
      { label: '子智能体角色', edit: true },
    ],
    when: '派发时生效', page: 'agents', pageLabel: '智能体',
  },
]

function DfPromptLayers(props) {
  const focus = Array.isArray(props.focus) ? props.focus : (props.focus ? [props.focus] : [])
  const compact = props.compact === true

  function goto(id) {
    if (props.onGoto) props.onGoto(id)
  }

  return h('section', { className: dfCx('df-layers', compact && 'df-layers--compact') },
    h('div', { className: 'df-layers-hd' },
      dfIcon('layers', 14),
      h('b', null, props.title || '提示词生效链路'),
      props.note ? h('span', { className: 'df-layers-note' }, props.note) : null),

    h('div', { className: 'df-layers-body' }, DF_PROMPT_LAYERS.map(function (l) {
      const on = focus.indexOf(l.id) !== -1
      const canGo = !on && props.onGoto && l.page
      return h('div', {
        key: l.id,
        className: dfCx('df-layer', on && 'is-focus', canGo && 'is-link'),
        role: canGo ? 'button' : undefined,
        tabIndex: canGo ? 0 : undefined,
        onClick: canGo ? function () { goto(l.page) } : undefined,
        onKeyDown: canGo ? function (e) {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          goto(l.page)
        } : undefined,
      },
        h('div', { className: 'df-layer-no' }, l.no),

        h('div', { className: 'df-layer-main' },
          h('div', { className: 'df-layer-hd' },
            h('b', null, l.title),
            h('span', { className: 'df-layer-role' }, l.role),
            h('span', { className: 'df-layer-scope' }, l.scope),
            on ? h('span', { className: 'df-layer-here' }, '本页') : null),
          compact
            ? null
            : h('div', { className: 'df-layer-purpose' }, l.purpose),
          compact
            ? null
            : h('div', { className: 'df-layer-items' }, l.items.map(function (it) {
              return h('span', { key: it.label, className: dfCx('df-layer-item', it.edit && 'is-edit') },
                it.edit ? h('i', null) : null, it.label)
            }))),

        h('div', { className: 'df-layer-side' },
          h('span', { className: 'df-layer-when' }, dfIcon('clock', 11), l.when),
          canGo ? h('span', { className: 'df-layer-go' }, l.pageLabel + ' ›') : null))
    })),

    h('div', { className: 'df-layers-ft' },
      props.foot || '优先级：系统提示词高于工作区指令；工作区指令从宽泛到具体拼接，预算不足时先截断宽泛段。'))
}
