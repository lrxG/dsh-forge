/* 原子组件：按钮、卡片、表格、抽屉、空态、骨架、Toast、命令面板外壳。
   只做展示与交互，不发请求、不做业务推导。 */

function DfBtn(props) {
  const { kind, size, icon, iconRight, children, className, ...rest } = props
  const cls = dfCx('df-btn',
    kind && 'df-btn--' + kind,
    size && 'df-btn--' + size,
    !children && 'df-btn--icon',
    className)
  return h('button', Object.assign({ type: 'button', className: cls }, rest),
    icon ? dfIcon(icon, size === 'sm' ? 13 : 15) : null,
    children || null,
    iconRight ? dfIcon(iconRight, size === 'sm' ? 13 : 15) : null)
}

function DfChip(props) {
  return h('span', { className: dfCx('df-chip', props.kind && 'df-chip--' + props.kind, props.className), title: props.title },
    props.dot ? h('i', { className: 'df-dot' }) : null,
    props.children)
}

function DfKpi(props) {
  const spark = Array.isArray(props.spark) ? props.spark : null
  const max = spark && spark.length ? Math.max.apply(null, spark.concat([1])) : 1
  return h('div', { className: dfCx('df-kpi', props.accent && 'df-kpi--accent') },
    h('div', { className: 'df-kpi-l' }, props.icon ? dfIcon(props.icon, 13) : null, props.label),
    h('div', { className: 'df-kpi-v' }, String(props.value),
      props.unit ? h('small', null, props.unit) : null),
    props.foot ? h('div', { className: 'df-kpi-f', title: typeof props.foot === 'string' ? props.foot : undefined }, props.foot) : null,
    spark ? h('div', { className: 'df-spark' }, spark.map(function (v, i) {
      return h('i', { key: i, style: { height: Math.max(3, Math.round((Number(v) || 0) / max * 22)) + 'px' } })
    })) : null)
}

/* 横向状态带：一排「标签 + 数字 + 小字」，装在一张白卡的横条里。
   比一排 KPI 小格子轻得多 —— 首屏还是一整块白，切页时整屏明暗不会跳。 */
function DfStat(props) {
  return h('div', { className: dfCx('df-stat', props.accent && 'df-stat--accent') },
    h('span', { className: 'df-stat-l' }, props.icon ? dfIcon(props.icon, 13) : null, props.label),
    h('span', { className: 'df-stat-v' }, String(props.value),
      props.unit ? h('small', null, props.unit) : null,
      props.foot ? h('span', { className: 'df-stat-f', title: typeof props.foot === 'string' ? props.foot : undefined }, props.foot) : null)
  )
}

function DfCard(props) {
  return h('section', { className: dfCx('df-card', props.className) },
    props.title || props.actions
      ? h('div', { className: 'df-card-hd' },
        props.icon ? dfIcon(props.icon, 14) : null,
        h('b', null, props.title),
        props.sub ? h('span', { className: 'df-sub' }, props.sub) : null,
        props.actions ? h('div', { className: 'df-spacer' }) : null,
        props.actions || null)
      : null,
    h('div', { className: dfCx('df-card-bd', props.pad && 'df-card-bd--pad') }, props.children))
}

function DfEmpty(props) {
  return h('div', { className: 'df-empty' },
    h('div', { className: 'df-empty-ico' }, dfIcon(props.icon || 'info', 17)),
    h('b', null, props.title || '暂无数据'),
    props.hint ? h('span', null, props.hint) : null,
    props.action || null)
}

function DfSkeleton(props) {
  const lines = props.lines || 4
  /* 骨架屏只负责「占位」，不做 1.4s 循环闪光：切页时骨架平均寿命只有一两百毫秒，
     闪到一半就消失，看起来就是一下白闪。改成静态的浅底，切页干净。 */
  return h('div', { className: 'df-skel-wrap', style: { padding: props.pad === false ? 0 : '12px 14px' } },
    h('div', { className: 'df-skel', style: { height: 14, width: '32%', marginBottom: 12 } }),
    Array.from({ length: lines }).map(function (_, i) {
      return h('div', {
        key: i,
        className: 'df-skel df-skel--line',
        style: { width: (92 - (i % 3) * 14) + '%' },
      })
    }))
}

/* 切页那一瞬的极简占位：三个静态小点（不做呼吸动画），比整页骨架安静。 */
function DfInlineWait(props) {
  return h('div', { className: 'df-inline-wait', role: 'status', 'aria-label': (props && props.label) || '加载中' },
    h('i'), h('i'), h('i'))
}

function DfSpinner(props) {
  return h('span', { className: 'df-spin', style: props.style, 'aria-label': '加载中' })
}

function DfSeg(props) {
  return h('div', { className: 'df-seg', role: 'tablist' }, (props.items || []).map(function (it, i) {
    const key = it[0] !== undefined ? it[0] : it.key
    const label = it[1] !== undefined ? it[1] : it.label
    return h('button', {
      key: key !== undefined ? key : i,
      type: 'button',
      role: 'tab',
      'aria-selected': props.value === key ? 'true' : 'false',
      className: props.value === key ? 'on' : '',
      onClick: function () { if (props.onChange) props.onChange(key) },
    }, label)
  }))
}

function DfTabs(props) {
  return h('div', { className: 'df-tabs', role: 'tablist' }, (props.items || []).map(function (it) {
    const active = props.value === it.key
    return h('button', {
      key: it.key,
      type: 'button',
      role: 'tab',
      'aria-selected': active ? 'true' : 'false',
      className: dfCx('df-tab', active && 'on'),
      onClick: function () { if (props.onChange) props.onChange(it.key) },
    }, it.icon ? dfIcon(it.icon, 13) : null, it.label,
      it.count !== undefined ? h('span', { className: 'df-count' }, String(it.count)) : null)
  }))
}

function DfSearch(props) {
  const [local, setLocal] = useState(props.value || '')
  /* 回调存 ref：debounce 只建一次，但永远调到最新的 onChange（避免首个闭包定型）。 */
  const onChangeRef = useRef(props.onChange)
  onChangeRef.current = props.onChange
  const emit = useRef(null)
  if (!emit.current) {
    emit.current = dfDebounce(function (v) {
      if (onChangeRef.current) onChangeRef.current(v)
    }, props.delay || 160)
  }
  useEffect(function () { setLocal(props.value || '') }, [props.value])
  useEffect(function () {
    return function () { if (emit.current) emit.current.cancel() }
  }, [])
  return h('div', { className: 'df-search', style: props.style },
    h('span', { className: 'df-search-ico' }, dfIcon('search', 13)),
    h('input', {
      className: 'df-input',
      type: 'search',
      value: local,
      placeholder: props.placeholder || '搜索',
      onChange: function (e) {
        const v = e.target.value
        setLocal(v)
        emit.current(v)
      },
      onKeyDown: props.onKeyDown,
    }),
    local ? h('button', {
      className: 'df-search-clear',
      type: 'button',
      title: '清空',
      onClick: function () { setLocal(''); emit.current.cancel(); if (props.onChange) props.onChange('') },
    }, dfIcon('close', 12)) : null)
}

function DfField(props) {
  return h('div', { className: 'df-field', style: props.style },
    props.label ? h('label', { htmlFor: props.htmlFor }, props.label) : null,
    props.children,
    props.hint ? h('div', { className: 'df-hint' }, props.hint) : null)
}

function DfCopyBtn(props) {
  const [done, setDone] = useState(false)
  const timer = useRef(0)
  useEffect(function () {
    return function () { if (timer.current) clearTimeout(timer.current) }
  }, [])
  return h('button', {
    type: 'button',
    className: 'df-copy',
    title: props.title || '复制',
    onClick: function (e) {
      e.stopPropagation()
      dfCopy(props.text).then(function (ok) {
        if (!ok) { dfToast('复制失败', 'err'); return }
        setDone(true)
        dfToast(props.toast || '已复制', 'ok', 1200)
        timer.current = setTimeout(function () { setDone(false) }, 1200)
      })
    },
  }, dfIcon(done ? 'check' : 'copy', 12), props.label ? h('span', null, props.label) : null)
}

function DfDrawer(props) {
  return h('div', { className: 'df-drawer' },
    h('div', { className: 'df-drawer-hd' },
      h('div', { className: 'df-drawer-t' },
        h('b', null, props.title || '详情'),
        props.sub ? h('div', { className: 'df-sub' }, props.sub) : null),
      props.actions || null,
      h('button', {
        type: 'button',
        className: 'df-btn df-btn--ghost df-btn--icon',
        title: '关闭（Esc）',
        'aria-label': '关闭',
        onClick: props.onClose,
      }, dfIcon('close', 14))),
    h('div', { className: 'df-drawer-bd' }, props.children))
}

function DfKV(props) {
  return h('dl', { className: 'df-kv' }, (props.rows || []).map(function (r, i) {
    return h(react.Fragment, { key: i },
      h('dt', null, r[0]),
      h('dd', null, r[2] ? r[1] : dfDash(r[1])))
  }))
}

/**
 * 快速预览卡（peek）：点列表行就地弹出，只显示 6 个关键字段 + 复制 + 「查看完整」。
 *
 * 用在「扫一眼」的场景：通道、凭证、会话这类，用户多数只想确认一两个字段，
 * 不值得为它开一整页。深度阅读的详情（漏洞、资产、成果）仍然走 DfDetailPage。
 */
function DfPeek(props) {
  const d = props.data
  if (!d) return null
  const all = d.rows || []
  const rows = all.slice(0, props.maxRows || 6)
  const text = [d.title || ''].concat(all.map(function (r) {
    return r[0] + '：' + (r[1] === undefined || r[1] === null || r[1] === '' ? '—' : r[1])
  })).join('\n')
  return h('div', {
    className: 'df-peek',
    style: props.style,
    role: 'dialog',
    'aria-label': d.title || '快速预览',
  },
    h('div', { className: 'df-peek-hd' },
      h('div', { className: 'df-peek-tt' },
        h('b', null, d.title || '详情'),
        d.sub ? h('small', null, d.sub) : null),
      h('button', {
        type: 'button', className: 'df-peek-x', title: '关闭（Esc）',
        onClick: props.onClose,
      }, dfIcon('close', 13))),
    h('div', { className: 'df-peek-bd' },
      rows.length ? h(DfKV, { rows: rows }) : h('div', { className: 'df-note' }, '这条没有字段摘要')),
    h('div', { className: 'df-peek-ft' },
      all.length > rows.length
        ? h('span', { className: 'df-peek-more' }, '还有 ' + (all.length - rows.length) + ' 项')
        : null,
      h('span', { className: 'dfx-spacer' }),
      h(DfCopyBtn, { text: text, label: '复制', toast: '已复制' }),
      props.onExpand
        ? h(DfBtn, { size: 'sm', kind: 'primary', onClick: props.onExpand }, '查看完整')
        : null))
}

/**
 * 整页详情（iOS push 式下钻）：点列表进来，左上角返回，内容占满宽度。
 *
 * 为什么默认用它而不是右侧抽屉：安全工程师要长时间读请求/响应、复制证据、
 * 来回对照，抽屉把内容挤在 380px 里且没有明确返回路径。国内习惯是「点进去 = 一层新页面」。
 *
 * 数据接口沿用抽屉的 `{ title, sub, rows, node }`，调用方只需加 `mode: 'page'`。
 */
function DfDetailPage(props) {
  const close = props.onClose || function () {}
  return h('div', {
    className: 'dfx-page',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': props.title || '详情',
  },
    h('header', { className: 'dfx-page-hd' },
      h('button', {
        type: 'button',
        className: 'dfx-page-back',
        title: '返回（Esc）',
        onClick: close,
      },
        h('svg', {
          width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        }, h('path', { d: 'M15 18l-6-6 6-6' })),
        h('span', null, '返回')),
      h('div', { className: 'dfx-page-tt' },
        h('b', null, props.title || '详情'),
        props.sub ? h('small', null, props.sub) : null),
      h('span', { className: 'dfx-spacer' }),
      props.actions || null),
    h('div', { className: 'dfx-page-bd' },
      props.head || null,
      props.rows && props.rows.length ? h(DfKV, { rows: props.rows }) : null,
      props.node || null))
}

function DfToastHost() {
  const list = dfUseToasts()
  if (!list.length) return null
  return h('div', { className: 'df-toasts' }, list.map(function (t) {
    return h('div', { key: t.id, className: 'df-toast df-toast--' + (t.kind || 'info') },
      h('span', { className: 'df-toast-i' }, dfIcon(t.kind === 'ok' ? 'check' : (t.kind === 'err' ? 'alert' : 'info'), 14)),
      h('span', null, t.text))
  }))
}

/**
 * 可排序表格。
 * columns: [{ key, title, width, align, sortable, mono, ellipsis, render(row) }]
 */
function DfTable(props) {
  const [sort, setSort] = useState(props.sort || null)
  const rows = props.rows || []
  const cols = (props.columns || []).filter(Boolean)

  const ordered = sort && sort.key
    ? dfSortBy(rows, function (r) {
      const col = cols.filter(function (c) { return c.key === sort.key })[0]
      return col && col.sortValue ? col.sortValue(r) : r[sort.key]
    }, sort.dir)
    : rows

  return h('table', { className: dfCx('df-table', props.density && 'df-table--' + props.density, props.className) },
    h('thead', null, h('tr', null, cols.map(function (c) {
      const sorted = sort && sort.key === c.key
      return h('th', {
        key: c.key,
        className: dfCx(c.sortable && 'df-sortable', sorted && 'df-sorted', c.className),
        /* 表头跟单元格同向对齐：数字列的值靠右，表头留在左边会看着像错位。 */
        style: c.width || c.align
          ? Object.assign({}, c.width ? { width: c.width } : {}, c.align === 'right' ? { textAlign: 'right' } : (c.align === 'center' ? { textAlign: 'center' } : {}))
          : null,
        onClick: c.sortable ? function () {
          setSort(function (cur) {
            if (cur && cur.key === c.key) return cur.dir === 'asc' ? { key: c.key, dir: 'desc' } : null
            return { key: c.key, dir: 'asc' }
          })
        } : undefined,
      }, c.title, c.sortable
        ? h('span', { className: 'df-sortico' }, dfIcon(sorted && sort.dir === 'desc' ? 'arrowDown' : 'arrowUp', 10))
        : null)
    }))),
    h('tbody', null, ordered.map(function (row, i) {
      const key = props.rowKey ? props.rowKey(row, i) : (row.id !== undefined ? row.id : i)
      const sel = props.selectedKey !== undefined && props.selectedKey === key
      return h('tr', {
        key: key,
        className: dfCx(props.onRow && 'df-row--click', sel && 'df-row--sel',
          props.rowClassName ? props.rowClassName(row) : null),
        tabIndex: props.onRow ? 0 : undefined,
        onClick: props.onRow ? function () { props.onRow(row) } : undefined,
        onKeyDown: props.onRow ? function (e) {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          props.onRow(row)
        } : undefined,
      }, cols.map(function (c) {
        return h('td', {
          key: c.key,
          className: dfCx(c.align === 'right' && 'df-num', c.align === 'center' && 'df-tight',
            c.mono && 'df-mono', c.ellipsis && 'df-ellip', c.className),
          style: c.align === 'center' ? { textAlign: 'center' } : (c.align === 'right' ? { textAlign: 'right' } : null),
        }, c.render ? c.render(row) : dfDash(row[c.key]))
      }))
    })))
}

/* ---------------------------------------------------------------- Markdown
   报告预览只认报告生成器实际会产出的语法：标题 / 表格 / 列表 / 引用 / 代码块 /
   图片占位 / 粗体 / 行内代码。**不解析 HTML**，AI 写进报告的内容只当文本，
   避免把面板变成注入点。 */

function dfMdInline(text) {
  const src = String(text === undefined || text === null ? '' : text).replace(/<br\s*\/?>/gi, ' / ')
  const out = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g
  let last = 0
  let m
  let i = 0
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push(src.slice(last, m.index))
    const tok = m[0]
    if (tok.slice(0, 2) === '**') out.push(h('b', { key: 'b' + i }, tok.slice(2, -2)))
    else if (tok.charAt(0) === '`') out.push(h('code', { key: 'c' + i }, tok.slice(1, -1)))
    else out.push(h('em', { key: 'e' + i }, tok.slice(1, -1)))
    last = m.index + tok.length
    i += 1
  }
  if (last < src.length) out.push(src.slice(last))
  return out
}

function dfMdBlockStart(line) {
  return /^\s*$/.test(line)
    || /^#{1,6}\s/.test(line)
    || /^```/.test(line.trim())
    || /^>\s?/.test(line)
    || /^\s*([-*]|\d+\.)\s+/.test(line)
    || /^\s*\|/.test(line)
    || /^!\[[^\]]*\]\([^)]+\)\s*$/.test(line.trim())
    || /^\s*---+\s*$/.test(line)
}

function DfMarkdown(props) {
  const lines = String(props.source || '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let i = 0
  let key = 0
  const parseRow = function (s) {
    return s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (x) { return x.trim() })
  }

  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*$/.test(line)) { i += 1; continue }

    if (/^```/.test(line.trim())) {
      const buf = []
      i += 1
      while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i += 1 }
      i += 1
      blocks.push(h('pre', { key: key, className: 'df-md-code' }, h('code', null, buf.join('\n'))))
      key += 1
      continue
    }

    const hm = /^(#{1,6})\s+(.*)$/.exec(line)
    if (hm !== null) {
      const lvl = Math.min(hm[1].length, 4)
      blocks.push(h('h' + lvl, { key: key }, dfMdInline(hm[2])))
      key += 1
      i += 1
      continue
    }

    if (/^\s*---+\s*$/.test(line)) {
      blocks.push(h('hr', { key: key }))
      key += 1
      i += 1
      continue
    }

    const im = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line.trim())
    if (im !== null) {
      const file = String(im[2]).split(/[\\/]/).pop()
      blocks.push(h('figure', { key: key, className: 'df-md-fig' },
        h('figcaption', null,
          dfIcon('image', 12),
          h('b', null, im[1] || '证据截图'),
          h('code', { title: im[2] }, dfShort(file, 46)))))
      key += 1
      i += 1
      continue
    }

    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const head = parseRow(line)
      i += 2
      const rows = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(parseRow(lines[i])); i += 1 }
      blocks.push(h('div', { key: key, className: 'df-md-tblwrap' },
        h('table', { className: 'df-md-tbl' },
          h('thead', null, h('tr', null, head.map(function (c, ci) {
            return h('th', { key: ci }, dfMdInline(c))
          }))),
          h('tbody', null, rows.map(function (r, ri) {
            return h('tr', { key: ri }, r.map(function (c, ci) {
              return h('td', { key: ci }, dfMdInline(c))
            }))
          })))))
      key += 1
      continue
    }

    if (/^>\s?/.test(line)) {
      const buf = []
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i += 1 }
      blocks.push(h('blockquote', { key: key }, dfMdInline(buf.join(' '))))
      key += 1
      continue
    }

    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line)
      const items = []
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''))
        i += 1
      }
      blocks.push(h(ordered ? 'ol' : 'ul', { key: key }, items.map(function (t, ii) {
        return h('li', { key: ii }, dfMdInline(t))
      })))
      key += 1
      continue
    }

    const buf = [line]
    i += 1
    while (i < lines.length && !dfMdBlockStart(lines[i])) { buf.push(lines[i]); i += 1 }
    blocks.push(h('p', { key: key }, dfMdInline(buf.join(' '))))
    key += 1
  }

  if (blocks.length === 0) {
    return h(DfEmpty, { icon: 'fileText', title: '报告还没有内容', hint: '先记录成果与证据，再回来生成。' })
  }
  return h('div', { className: 'df-md' }, blocks)
}

