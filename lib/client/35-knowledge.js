/* 资源与配置视图（P3）：知识库 / 技能库 / 环境 / 提示词 / 维护（占位）。
   只做取数与展示；详情进抽屉，写入走 dfApi 的显式 op。 */

const DF_POC_KIND = {
  poc: 'POC', exp: 'EXP', script: '脚本', template: '模板',
  payload: 'Payload', lesson: '经验',
}

const DF_SKILL_KIND = { bundle: '目录', flat: '单文件' }

const DF_TPL_SEV = {
  critical: '严重', high: '高', medium: '中', low: '低', info: '信息', unknown: '—',
}

function dfCatName(list, code) {
  const hit = (list || []).filter(function (c) { return c.code === code })[0]
  return hit ? hit.name : (code || '未归类')
}

function dfCatOptions(list) {
  return (list || []).filter(function (c) { return (c.n || 0) > 0 })
}

/* ---------------------------------------------------------------- 知识库 */

/** 抽屉里的 POC 正文：按需拉 pocGet，避免列表把全文一起带走。 */
function DfPocBody(props) {
  const state = dfUseAsync(function () {
    return dfApi('pocGet', { id: props.id }, { ttl: 0 }).then(function (r) {
      if (!r || r.ok === false) throw new Error((r && r.error) || '读取 POC 失败')
      return r
    })
  }, [props.id])

  if (state.loading && !state.data) return h(DfSkeleton, { lines: 6 })
  if (state.error || !state.data) {
    return h(DfOpsError, { title: '读取 POC 失败', error: state.error, onRetry: state.reload })
  }
  const p = state.data
  const content = String(p.content || '')
  return h('div', { className: 'df-detail' },
    p.description ? h('section', { className: 'df-detail-sec' },
      h('h4', null, '说明'),
      h('div', { className: 'df-detail-p' }, p.description)) : null,
    p.usage ? h('section', { className: 'df-detail-sec' },
      h('h4', null, '用法'),
      h('pre', { className: 'df-code' }, String(p.usage))) : null,
    p.verified_note ? h('section', { className: 'df-detail-sec' },
      h('h4', null, '验证结论'),
      h('div', { className: 'df-detail-p' }, p.verified_note)) : null,
    h('section', { className: 'df-detail-sec' },
      h('div', { className: 'df-detail-hd' },
        h('h4', null, '正文 · ' + dfNum(content.length) + ' 字符'),
        content ? h(DfCopyBtn, { text: content, label: '复制', toast: 'POC 正文已复制' }) : null),
      content
        ? h('pre', { className: 'df-code' }, content)
        : h('div', { className: 'df-note' }, '这条只登记了元数据，还没有正文。')),
    p.tags ? h('section', { className: 'df-detail-sec' },
      h('h4', null, '标签'),
      h('div', { className: 'df-chips' }, String(p.tags).split(/[\s,，]+/).filter(Boolean).map(function (t, i) {
        return h(DfChip, { key: i, kind: 'line' }, t)
      }))) : null)
}

function DfKnowledge(props) {
  const [tab, setTab] = useState('poc')
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('')
  const [verified, setVerified] = useState(false)

  const statsState = dfUseAsync(function () {
    return dfApi('templateStats', {}, { ttl: 120000 }).then(function (r) {
      return (r && r.stats) || {}
    })
  }, [])

  const poc = dfUseAsync(function () {
    return dfApi('pocSearch', {
      q: q.trim() || undefined,
      category: cat || undefined,
      verified: verified || undefined,
      limit: 500,
    }).then(function (r) {
      if (!r || r.ok === false) throw new Error((r && r.error) || '读取知识库失败')
      return r
    })
  }, [q, cat, verified, props.tick])

  const tpl = dfUseAsync(function () {
    if (tab !== 'template') return Promise.resolve(null)
    return dfApi('templateSearch', {
      q: q.trim() || undefined,
      category: cat || undefined,
      limit: 120,
    }).then(function (r) {
      if (!r || r.ok === false) throw new Error((r && r.error) || '读取模板失败')
      return r
    })
  }, [tab, q, cat, props.tick])

  const pocStats = (poc.data && poc.data.stats) || {}
  const tplStats = statsState.data || {}
  const cats = tab === 'poc' ? (pocStats.byCategory || []) : (tplStats.byCategory || [])
  const pocRows = (poc.data && poc.data.items) || []
  const tplRows = (tpl.data && tpl.data.items) || []

  function openPoc(p) {
    if (!props.onInspect) return
    props.onInspect({
      title: p.title,
      sub: [dfCatName(pocStats.byCategory, p.category), DF_POC_KIND[p.kind] || p.kind].filter(Boolean).join(' · '),
      rows: [
        ['编号', p.cve],
        ['组件', p.component],
        ['版本', p.versions],
        ['语言', p.language],
        ['来源', p.source],
        ['验证', Number(p.verified) === 1 ? '已验证' : '未验证'],
        ['命中', p.hit_count ? p.hit_count + ' 次' : '—'],
        ['更新时间', dfTime(p.updated_at)],
        ['路径', p.path],
      ],
      node: h(DfPocBody, { id: p.id }),
    })
  }

  function openTpl(t) {
    if (!props.onInspect) return
    props.onInspect({
      title: t.name,
      sub: dfCatName(tplStats.byCategory, t.category) + ' · ' + (DF_TPL_SEV[String(t.severity || 'unknown')] || t.severity || '—'),
      rows: [
        ['模板名', t.name],
        ['严重度', DF_TPL_SEV[String(t.severity || 'unknown')] || t.severity],
        ['归类', dfCatName(tplStats.byCategory, t.category)],
        ['标签', t.tags],
        ['路径', t.path],
      ],
      node: h('div', { className: 'df-detail' },
        h('section', { className: 'df-detail-sec' },
          h('div', { className: 'df-detail-hd' },
            h('h4', null, '模板路径'),
            h(DfCopyBtn, { text: String(t.path || ''), label: '复制', toast: '路径已复制' })),
          h('pre', { className: 'df-code' }, String(t.path || ''))),
        h('div', { className: 'df-note' }, '模板由 nuclei 执行，这里只做检索。')),
    })
  }

  const loading = tab === 'poc' ? (poc.loading && !poc.data) : (tpl.loading && !tpl.data)
  const error = tab === 'poc' ? poc.error : tpl.error

  return h('div', { className: 'df-ops' },
    h('div', { className: 'df-opsbar' },
      h('span', { className: 'df-ops-title' }, '知识库'),
      h('span', { className: 'df-ops-meta' }, 'POC 与 nuclei 模板'),
      h('span', { className: 'df-spacer' }),
      h(DfSeg, {
        value: tab,
        items: [['poc', '沉淀 POC'], ['template', 'nuclei 模板']],
        onChange: function (k) { setTab(k); setCat('') },
      })),

    h('div', { className: 'df-statsbar' },
      h(DfStat, { label: '沉淀', icon: 'book', value: dfNum(pocStats.total || 0), foot: '已验证 ' + dfNum(pocStats.verified || 0) + ' · 有正文 ' + dfNum(pocStats.withContent || 0) }),
      h(DfStat, { label: '被复用', icon: 'refresh', value: dfNum(pocStats.reused || 0), foot: '命中过至少一次' }),
      h(DfStat, { label: 'nuclei 模板', icon: 'layers', value: dfNum(tplStats.total || 0), foot: 'CVE 模板 ' + dfNum(tplStats.cve || 0) }),
      h(DfStat, { label: '归类', icon: 'filter', value: dfNum(dfCatOptions(cats).length), foot: tab === 'poc' ? '有沉淀的类目' : '模板覆盖的类目' })),

    h(DfCard, null,
      h('div', { className: 'df-opsbar df-opsbar--pad' },
        h(DfSearch, {
          value: q, placeholder: tab === 'poc' ? '搜索标题 / CVE / 组件 / 正文' : '搜索模板名 / 路径 / 标签',
          onChange: function (v) { setQ(v) }, style: { width: 260 },
        }),
        h('select', {
          className: 'df-select', value: cat, title: '归类',
          onChange: function (e) { setCat(e.target.value) },
        },
          h('option', { value: '' }, '全部归类'),
          dfCatOptions(cats).map(function (c) {
            return h('option', { key: c.code, value: c.code }, c.name + '（' + c.n + '）')
          })),
        tab === 'poc'
          ? h('label', { className: 'df-switch' },
            h('input', {
              type: 'checkbox', checked: verified,
              onChange: function (e) { setVerified(e.target.checked) },
            }),
            h('i'), '只看已验证')
          : null,
        h('span', { className: 'df-spacer' }),
        h('span', { className: 'df-ops-meta' },
          loading
            ? '共 — 条'
            : tab === 'poc'
              ? '共 ' + dfNum(pocRows.length) + ' 条'
              : (tpl.data
                ? (q.trim() || cat
                  ? '命中 ' + dfNum(tpl.data.matched || 0) + ' / ' + dfNum(tpl.data.total || 0)
                  : '共 ' + dfNum(tpl.data.total || 0) + ' 个模板')
                : ''))),

      loading
        ? h('div', { className: 'df-ops-blank' }, h(DfSkeleton, { lines: 6 }))
        : error
          ? h(DfOpsError, { title: '读取知识库失败', error: error, onRetry: tab === 'poc' ? poc.reload : tpl.reload })
          : tab === 'poc'
            ? (pocRows.length
              ? h('div', { className: 'df-tablewrap' },
                h(DfTable, {
                  rows: pocRows,
                  rowKey: function (r) { return r.id },
                  onRow: openPoc,
                  columns: [
                    {
                      key: 'title', title: '条目', width: '40%',
                      render: function (r) {
                        return h('div', { className: 'df-vuln-t' }, r.title,
                          h('small', null, [r.component, r.versions, r.cve].filter(Boolean).join(' · ') || r.code))
                      },
                    },
                    {
                      key: 'category', title: '归类', width: 150,
                      render: function (r) {
                        const name = dfCatName(pocStats.byCategory, r.category)
                        return h(DfChip, { kind: name === '未归类' ? 'line' : 'info' }, name)
                      },
                    },
                    {
                      key: 'kind', title: '类型', width: 76,
                      render: function (r) { return h(DfChip, { kind: 'line' }, DF_POC_KIND[r.kind] || dfDash(r.kind)) },
                    },
                    {
                      key: 'verified', title: '验证', width: 80,
                      render: function (r) {
                        return Number(r.verified) === 1
                          ? h(DfChip, { kind: 'ok', dot: true }, '已验证')
                          : h(DfChip, { kind: 'line' }, '未验证')
                      },
                    },
                    {
                      key: 'updated_at', title: '更新', width: 92, align: 'right',
                      sortValue: function (r) { return r.updated_at || '' },
                      render: function (r) { return dfAgo(r.updated_at) },
                    },
                  ],
                }))
              : h(DfEmpty, {
                icon: 'book',
                title: q || cat || verified ? '没有匹配的条目' : '知识库还是空的',
                hint: q || cat || verified ? '换个关键词或清除筛选试试。' : '验证有效的 POC / 经验回填后会出现在这里。',
              }))
            : (tplRows.length
              ? h('div', { className: 'df-tablewrap' },
                h(DfTable, {
                  rows: tplRows,
                  rowKey: function (r, i) { return r.path || i },
                  onRow: openTpl,
                  columns: [
                    { key: 'name', title: '模板', width: '38%', render: function (r) { return h('span', { className: 'df-nm' }, dfDash(r.name)) } },
                    {
                      key: 'category', title: '归类', width: 150,
                      render: function (r) { return h(DfChip, { kind: 'info' }, dfCatName(tplStats.byCategory, r.category)) },
                    },
                    {
                      key: 'severity', title: '严重度', width: 78,
                      render: function (r) {
                        const s = String(r.severity || 'unknown')
                        return h(DfChip, { kind: s === 'critical' || s === 'high' ? 'err' : (s === 'medium' ? 'warn' : 'line') }, DF_TPL_SEV[s] || s)
                      },
                    },
                    { key: 'path', title: '路径', ellipsis: true, render: function (r) { return h('span', { className: 'df-mono' }, dfDash(r.path)) } },
                  ],
                }))
              : h(DfEmpty, {
                icon: 'layers',
                title: q || cat ? '没有匹配的模板' : '输入关键词开始检索',
                hint: q || cat
                  ? '换一个组件名 / CVE / 标签试试。'
                  : '本机模板库共 ' + dfNum(tplStats.total || 0) + ' 个，按组件名、CVE 或路径检索。',
              })))
  )
}

/* ---------------------------------------------------------------- 技能库 */

const DF_SKILL_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function dfSkillPost(body) {
  return dfHttp('/dsh-forge/skills', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  }, { ttl: 0 }).then(function (r) {
    return r || { ok: false, error: '技能接口没有返回内容' }
  })
}

function dfReadBase64(file) {
  return new Promise(function (resolve, reject) {
    const fr = new FileReader()
    fr.onload = function () {
      const s = String(fr.result || '')
      resolve(s.slice(s.indexOf(',') + 1))
    }
    fr.onerror = function () { reject(new Error('读取文件失败')) }
    fr.readAsDataURL(file)
  })
}

/** 技能编辑：正文 + 说明；新建时 id 可填，保存后回列表。 */
function DfSkillEditor(props) {
  const isNew = !props.id
  const [id, setId] = useState(String(props.id || ''))
  const [desc, setDesc] = useState(String(props.description || ''))
  const [text, setText] = useState(String(props.content || ''))
  const [busy, setBusy] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)

  useEffect(function () {
    if (!confirmDel) return undefined
    const t = window.setTimeout(function () { setConfirmDel(false) }, 5000)
    return function () { window.clearTimeout(t) }
  }, [confirmDel])

  const idOk = DF_SKILL_ID_RE.test(id.trim())
  const canSave = idOk && String(text).trim().length > 0 && !busy
  const size = new Blob([text]).size

  function save() {
    if (!canSave) return
    setBusy('save')
    dfSkillPost({ op: 'save', id: id.trim(), content: text, description: desc }).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '保存失败', 'err', 4600); return }
      dfToast(isNew ? '技能已创建：' + id.trim() : '技能已保存', 'ok', 2400)
      if (props.onSaved) props.onSaved(r)
    })
  }

  function del() {
    if (!id.trim() || busy) return
    setBusy('del')
    dfSkillPost({ op: 'delete', id: id.trim() }).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '删除失败', 'err', 4600); return }
      dfToast('已删除 ' + id.trim(), 'ok', 2400)
      if (props.onDeleted) props.onDeleted()
    })
  }

  return h('div', { className: 'df-detail' },
    h('section', { className: 'df-detail-sec' },
      h('div', { className: 'df-formgrid' },
        h(DfField, { label: '技能 ID', hint: isNew ? '小写字母与连字符，例如 code-review；保存后不可修改' : '保存后不可修改' },
          h('input', {
            className: 'df-input', value: id, disabled: !isNew, spellCheck: false,
            placeholder: 'code-review',
            onChange: function (e) { setId(e.target.value) },
          })),
        h(DfField, { label: '说明（description）', hint: '模型靠它判断什么时候调用' },
          h('input', {
            className: 'df-input', value: desc, spellCheck: false,
            placeholder: '什么时候该用这个技能',
            onChange: function (e) { setDesc(e.target.value) },
          })))),

    h('section', { className: 'df-detail-sec' },
      h('div', { className: 'df-detail-hd' },
        h('h4', null, 'SKILL.md · ' + dfNum(String(text).length) + ' 字符 · ' + dfNum(Math.round(size / 102.4) / 10) + ' KB'),
        h(DfCopyBtn, { text: text, label: '复制', toast: '技能正文已复制' })),
      h('textarea', {
        className: 'df-area df-area--code', rows: 16, value: text, spellCheck: false,
        placeholder: '---\ndescription: 一句话说明何时调用\n---\n\n正文…',
        onChange: function (e) { setText(e.target.value) },
      }),
      h('div', { className: 'df-hint' }, '保存时自动补齐 name / description。')),

    h('div', { className: 'df-formfoot' },
      h(DfBtn, {
        size: 'sm', kind: confirmDel ? 'solid-danger' : 'danger', icon: 'trash',
        disabled: !!busy || isNew,
        onBlur: function () { setConfirmDel(false) },
        onClick: function () {
          if (!confirmDel) { setConfirmDel(true); return }
          setConfirmDel(false)
          del()
        },
      }, busy === 'del' ? '删除中…' : (confirmDel ? '确认删除' : '删除')),
      h('span', { className: 'df-spacer' }),
      h(DfBtn, { size: 'sm', kind: 'primary', icon: 'check', disabled: !canSave, onClick: save },
        busy === 'save' ? '保存中…' : (isNew ? '创建' : '保存'))))
}

/** 按需拉正文再进编辑器（列表只给元数据）。 */
function DfSkillBodyEditor(props) {
  const state = dfUseAsync(function () {
    return dfSkillPost({ op: 'read', id: props.id }).then(function (r) {
      if (!r || r.ok === false) throw new Error((r && r.error) || '读取技能失败')
      return r
    })
  }, [props.id])

  if (state.loading && !state.data) return h(DfSkeleton, { lines: 8 })
  if (state.error || !state.data) {
    return h(DfOpsError, { title: '读取技能失败', error: state.error || (state.data && state.data.error), onRetry: state.reload })
  }
  const s = state.data
  return h(DfSkillEditor, {
    id: s.id,
    description: s.description,
    content: s.content,
    onSaved: props.onSaved,
    onDeleted: props.onDeleted,
  })
}

function DfSkills(props) {
  const [q, setQ] = useState('')
  const [kind, setKind] = useState('')
  const [impBusy, setImpBusy] = useState('')
  const zipRef = useRef(null)
  const dirRef = useRef(null)
  const state = dfUseAsync(function () {
    /* 对接 lib/index.js 的 skillsHttpHandler：op=status 返回 { skills: [...] }。 */
    return dfHttp('/dsh-forge/skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'status' }),
    }).then(function (r) {
      if (r && r.ok === false) throw new Error(r.error || '技能接口返回错误')
      return r || {}
    })
  }, [props.tick])

  /* 导入成功后刷新列表；抽屉里的编辑保存后同样回列表。 */
  function reloadAll() {
    if (props.onCloseDrawer) props.onCloseDrawer()
    state.reload()
  }

  function doneImport(r, label) {
    setImpBusy('')
    if (!r || r.ok === false) { dfToast((r && r.error) || (label + '失败'), 'err', 5200); return }
    const n = Array.isArray(r.imported) ? r.imported.length : 0
    dfToast(n ? ('已导入 ' + dfNum(n) + ' 个技能') : '没有找到可导入的技能', n ? 'ok' : 'info', 3200)
    state.reload()
  }

  function importZip(file) {
    if (!file || impBusy) return
    if (file.size > 9 * 1024 * 1024) { dfToast('压缩包太大（上限 9 MB）', 'err', 4200); return }
    setImpBusy('zip')
    dfReadBase64(file).then(function (data) {
      return dfSkillPost({ op: 'import', name: file.name, data: data })
    }).then(function (r) { doneImport(r, '导入') }, function (e) {
      setImpBusy('')
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  function importFolder(fileList) {
    const files = Array.from(fileList || [])
    if (!files.length || impBusy) return
    setImpBusy('dir')
    const picked = []
    let total = 0
    const next = function (i) {
      if (i >= files.length || total > 9 * 1024 * 1024 || picked.length >= 200) return Promise.resolve()
      const f = files[i]
      if (f.size > 9 * 1024 * 1024) return next(i + 1)
      total += f.size
      return dfReadBase64(f).then(function (b64) {
        picked.push({
          path: f.webkitRelativePath || f.name,
          content: b64,
          encoding: 'base64',
        })
        return next(i + 1)
      })
    }
    next(0).then(function () {
      if (!picked.length) { setImpBusy(''); dfToast('没读到文件夹里的文件', 'err', 4200); return null }
      const name = String(picked[0].path).split('/')[0] || 'skill'
      return dfSkillPost({ op: 'import', name: name, files: picked })
    }).then(function (r) {
      if (r) doneImport(r, '导入')
    }, function (e) {
      setImpBusy('')
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  /* 切页那一瞬只看得到一行小点：整页骨架太吵，换成「干等」的极简占位。 */
  if (state.loading && !state.data) return h(DfInlineWait)
  if (state.error) {
    return h(DfOpsError, { title: '读取技能失败', error: state.error, onRetry: state.reload })
  }
  const all = Array.isArray(state.data.skills) ? state.data.skills : []
  const term = q.trim().toLowerCase()
  const rows = all.filter(function (s) {
    if (kind && s.kind !== kind) return false
    if (!term) return true
    return [s.id, s.description, s.path].filter(Boolean).join(' ').toLowerCase().indexOf(term) >= 0
  })

  function open(s) {
    if (!props.onInspect) return
    props.onInspect({
      title: s.id,
      sub: (DF_SKILL_KIND[s.kind] || s.kind || '技能') + ' · ' + (s.valid === false ? '格式异常' : '可用'),
      rows: [
        ['技能', s.id],
        ['说明', s.description],
        ['形式', DF_SKILL_KIND[s.kind] || s.kind],
        ['大小', s.size ? dfNum(Math.round(s.size / 102.4) / 10) + ' KB' : '—'],
        ['路径', s.path],
      ],
      node: h(DfSkillBodyEditor, {
        id: s.id,
        onSaved: reloadAll,
        onDeleted: reloadAll,
      }),
    })
  }

  function createSkill() {
    if (!props.onInspect) return
    props.onInspect({
      title: '新建技能',
      sub: '保存后自动加载',
      rows: [],
      node: h(DfSkillEditor, { onSaved: reloadAll }),
    })
  }

  return h('div', { className: 'df-ops' },
    h('div', { className: 'df-opsbar' },
      h('span', { className: 'df-ops-title' }, '技能库'),
      h('span', { className: 'df-ops-meta' }, '目录型技能需要 SKILL.md'),
      h('span', { className: 'df-spacer' }),
      h(DfSearch, { value: q, placeholder: '搜索技能名 / 说明', onChange: function (v) { setQ(v) }, style: { width: 200 } }),
      h(DfSeg, {
        value: kind,
        items: [['', '全部'], ['bundle', '目录'], ['flat', '单文件']],
        onChange: function (v) { setKind(v) },
      })),

    h('div', { className: 'df-statsbar' },
      h(DfStat, { label: '技能', icon: 'spark', value: dfNum(all.length) }),
      h(DfStat, { label: '可用', icon: 'check', value: dfNum(all.filter(function (x) { return x.valid !== false }).length) }),
      h(DfStat, { label: '目录型', icon: 'folder', value: dfNum(all.filter(function (x) { return x.kind === 'bundle' }).length) }),
      h(DfStat, { label: '单文件', icon: 'list', value: dfNum(all.filter(function (x) { return x.kind === 'flat' }).length) })),

    h(DfCard, {
      title: '技能清单', icon: 'spark',
      sub: '用户技能目录',
      actions: h('div', { className: 'df-opsbar' },
        h('input', {
          type: 'file', ref: zipRef, accept: '.zip,.skill,.tgz', style: { display: 'none' },
          onChange: function (e) {
            const f = e.target.files && e.target.files[0]
            e.target.value = ''
            if (f) importZip(f)
          },
        }),
        h('input', {
          type: 'file', ref: dirRef, webkitdirectory: '', multiple: true, style: { display: 'none' },
          onChange: function (e) {
            const list = e.target.files
            e.target.value = ''
            if (list && list.length) importFolder(list)
          },
        }),
        h('div', { className: 'df-btnrow' },
          h(DfBtn, {
            size: 'sm', kind: 'ghost', icon: 'upload', disabled: !!impBusy,
            onClick: function () { if (zipRef.current) zipRef.current.click() },
          }, impBusy === 'zip' ? '导入中…' : '导入'),
          h(DfBtn, {
            size: 'sm', kind: 'ghost', icon: 'folder', disabled: !!impBusy,
            onClick: function () { if (dirRef.current) dirRef.current.click() },
          }, impBusy === 'dir' ? '导入中…' : '文件夹'),
          h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'plus', onClick: createSkill }, '新建'))),
    },
      rows.length
        ? h('div', { className: 'df-tablewrap' },
          h(DfTable, {
            rows: rows,
            rowKey: function (r, i) { return r.id || i },
            onRow: open,
            columns: [
              {
                key: 'id', title: '技能', width: '34%',
                render: function (r) {
                  return h('div', { className: 'df-vuln-t' }, r.id,
                    h('small', { title: r.description || '' }, dfShort(r.description || '没有说明', 96)))
                },
              },
              { key: 'kind', title: '形式', width: 82, render: function (r) { return h(DfChip, { kind: 'line' }, DF_SKILL_KIND[r.kind] || dfDash(r.kind)) } },
              { key: 'size', title: '大小', width: 82, align: 'right', render: function (r) { return r.size ? dfNum(Math.round(r.size / 102.4) / 10) + ' KB' : '—' } },
              {
                key: 'valid', title: '状态', width: 82,
                render: function (r) {
                  return r.valid === false
                    ? h(DfChip, { kind: 'err', dot: true }, '异常')
                    : h(DfChip, { kind: 'ok', dot: true }, '可用')
                },
              },
              { key: 'path', title: '路径', ellipsis: true, render: function (r) { return h('span', { className: 'df-mono' }, dfDash(r.path)) } },
            ],
          }))
        : h(DfEmpty, {
          icon: 'spark',
          title: all.length ? '没有匹配的技能' : '没有找到技能',
          hint: all.length ? '换个关键词或形式试试。' : '技能放在用户技能目录下；目录型技能需要 SKILL.md。',
        }))
  )
}

/* ---------------------------------------------------------------- 环境 */

/**
 * 环境页：工具路径、凭据、工具就绪度。
 *
 * 权限档位入口在顶栏常驻 chip，本页不重复；这里只报「找到几个工具」。
 */
/** 外部接入的一行：图标、名称、状态、说明、操作。 */
function DfSvcRow(props) {
  return h('div', { className: 'df-svc' },
    h('span', { className: 'df-svc-ico' }, dfIcon(props.icon || 'link', 15)),
    h('div', { className: 'df-svc-main' },
      h('div', { className: 'df-svc-title' },
        h('b', null, props.title),
        props.chip ? h(DfChip, { kind: props.chipKind || 'ok' }, props.chip) : null),
      h('div', { className: 'df-svc-desc' }, props.desc)),
    h('div', { className: 'df-svc-actions' }, props.actions),
    props.extra ? h('div', { className: 'df-svc-extra' }, props.extra) : null)
}

function DfEnv(props) {
  const state = dfUseAsync(function () {
    return dfApi('platformConfigGet', {}, { ttl: 0 }).then(function (r) {
      if (r && r.ok === false) throw new Error(r.error || '读取配置失败')
      return r || {}
    })
  }, [props.tick])

  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState('')
  const [vps, setVps] = useState({ host: '', port: 22, user: '', password: '', auth: '', configured: false })
  const [vpsBusy, setVpsBusy] = useState('')
  const [vpsWizard, setVpsWizard] = useState(false)
  const [vpsPortEdit, setVpsPortEdit] = useState(false)
  const [vpsChoice, setVpsChoice] = useState(null)
  const [vpsMode, setVpsMode] = useState('key')
  const [vpsRemember, setVpsRemember] = useState(true)
  const [clearArmed, setClearArmed] = useState(false)
  const [fofaClear, setFofaClear] = useState(false)
  const [fofaEdit, setFofaEdit] = useState(false)
  const [nativeConfirm, setNativeConfirm] = useState(false)
  const [ceye, setCeye] = useState({ domain: '', token: '', configured: false })
  const [ceyeBusy, setCeyeBusy] = useState('')
  const [ceyeClear, setCeyeClear] = useState(false)
  const [ceyeEdit, setCeyeEdit] = useState(false)
  const [egressBusy, setEgressBusy] = useState(false)
  const [egressResult, setEgressResult] = useState(null)

  useEffect(function () {
    if (!state.data) return
    const c = state.data.config || state.data
    const env = c.env || {}
    const vs = state.data.vps || {}
    setDraft({
      platform: c.platform || 'auto',
      /* 没填过时把实际生效的 dsh 默认目录显示出来，用户可以直接改成别的。 */
      toolkitDir: c.toolkitDir || state.data.toolkitDir || '',
      nucleiTemplatesDir: c.nucleiTemplatesDir || '',
      binDirs: (Array.isArray(c.binDirs) ? c.binDirs : []).join('\n'),
      egressProxy: (c.egress && c.egress.proxy) || '',
      egressNoProxy: (c.egress && c.egress.noProxy) || '',
      FOFA_KEY: env.FOFA_KEY || '',
    })
    setVps({
      host: vs.host || env.REDTEAM_VPS_ADDR || '',
      port: Number(vs.port || env.REDTEAM_VPS_PORT) || 22,
      user: vs.user || env.REDTEAM_VPS_USER || '',
      password: '',
      auth: vs.auth || env.REDTEAM_VPS_AUTH || '',
      configured: !!vs.configured,
      native: !!vs.native,
    })
    const oast = state.data.oast || {}
    setCeye({ domain: oast.domain || '', token: '', configured: !!oast.configured })
  }, [state.data])

  if (state.loading && !state.data) return h(DfSkeleton, { lines: 6 })
  if (state.error || !state.data) {
    return h(DfOpsError, { title: '读取环境配置失败', error: state.error, onRetry: state.reload })
  }

  const data = state.data
  const d = draft || {}

  function set(key, value) {
    setDraft(function (cur) { return Object.assign({}, cur || {}, { [key]: value }) })
  }

  function save() {
    if (busy) return
    setBusy('save')
    const config = {
      platform: d.platform || 'auto',
      toolkitDir: String(d.toolkitDir || '').trim(),
      nucleiTemplatesDir: String(d.nucleiTemplatesDir || '').trim(),
      binDirs: String(d.binDirs || '').split(/\r?\n/).map(function (x) { return x.trim() }).filter(Boolean),
      egress: {
        proxy: String(d.egressProxy || '').trim(),
        noProxy: String(d.egressNoProxy || '').trim(),
      },
    }
    dfApi('platformConfigSave', { config: config }).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '保存失败', 'err', 4200); return }
      dfToast('环境配置已保存', 'ok', 2400)
      state.reload()
      testEgress()
    }, function (e) {
      setBusy('')
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  function testEgress() {
    if (egressBusy) return
    setEgressBusy(true)
    dfApi('egressTest', {}, { ttl: 0 }).then(function (r) {
      setEgressBusy(false)
      setEgressResult(r || null)
    }, function (e) {
      setEgressBusy(false)
      setEgressResult({ ok: false, error: String((e && e.message) || e) })
    })
  }

  function clearFofa() {
    if (busy) return
    if (!fofaClear) {
      setFofaClear(true)
      window.setTimeout(function () { setFofaClear(false) }, 5000)
      return
    }
    setFofaClear(false)
    setBusy('fofa')
    dfApi('fofaClear', {}, { ttl: 0 }).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '清除失败', 'err', 4200); return }
      set('FOFA_KEY', '')
      dfToast('FOFA KEY 已清除', 'ok', 2400)
      state.reload()
    }, function (e) {
      setBusy('')
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  function saveFofa() {
    if (busy) return
    const key = String(d.FOFA_KEY || '').trim()
    const configured = !!(data.fofa && data.fofa.configured)
    if (!key && !configured) { dfToast('填 FOFA KEY', 'err', 3000); return }
    setBusy('fofaSave')
    dfApi('platformConfigSave', { config: { env: { FOFA_KEY: key } } }, { ttl: 0 }).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '保存失败', 'err', 4200); return }
      setFofaEdit(false)
      set('FOFA_KEY', '')
      dfToast(key ? 'FOFA KEY 已保存' : 'FOFA 配置未变', 'ok', 2400)
      state.reload()
    }, function (e) {
      setBusy('')
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  function vpsSet(key, value) {
    setVps(function (cur) { return Object.assign({}, cur, { [key]: value }) })
  }

  function vpsAuthLabel() {
    if (!vps.auth) return '未配置'
    if (vps.auth === 'key') return vps.configured ? '密钥登录' : '密钥缺失'
    if (vps.auth === 'password') return vps.configured ? '密码 · 已加密' : '密码 · 密文缺失'
    if (vps.auth === 'session') return vps.configured ? '密码 · 仅本次' : '密码 · 需重输'
    return vps.auth
  }

  function testVps() {
    if (vpsBusy) return
    if (!String(vps.host || '').trim() || !String(vps.user || '').trim()) {
      dfToast('先填主机和账号', 'err', 3000)
      return
    }
    const canReuse = !vps.password && (vps.auth === 'password' || vps.auth === 'session') && vps.configured
    if (!String(vps.password || '') && !canReuse) {
      dfToast('先填密码再测试', 'err', 3000)
      return
    }
    setVpsBusy('test')
    dfApi('vpsTest', {
      host: vps.host, port: Number(vps.port) || 22, user: vps.user,
      password: vps.password, useStored: canReuse,
    }, { ttl: 0 }).then(function (r) {
      setVpsBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '连接失败', 'err', 5200); return }
      setVpsMode(r.pubkeyAuth === 'no' ? 'password' : 'key')
      setVpsRemember(true)
      setVpsChoice({ latencyMs: Number(r.latencyMs) || 0, pubkeyAuth: r.pubkeyAuth || 'unknown' })
    }, function (e) {
      setVpsBusy('')
      dfToast(String((e && e.message) || e), 'err', 5200)
    })
  }

  function applyVps() {
    if (vpsBusy) return
    const keyMode = vpsMode === 'key'
    const mode = keyMode ? 'key' : (vpsRemember ? 'password' : 'session')
    setVpsBusy('apply')
    dfApi('vpsApply', {
      host: vps.host,
      port: Number(vps.port) || 22,
      user: vps.user,
      password: vps.password,
      useStored: !vps.password && vps.configured && (vps.auth === 'password' || vps.auth === 'session'),
      mode: mode,
      remember: mode === 'password',
    }, { ttl: 0 }).then(function (r) {
      setVpsBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '配置失败', 'err', 5600); return }
      setVpsChoice(null)
      setVpsWizard(false)
      setVps(function (cur) { return Object.assign({}, cur, { password: '', auth: r.auth, configured: true }) })
      dfToast(keyMode ? '已改用密钥登录' : (mode === 'password' ? '密码已加密保存' : '仅本次会话使用密码'), 'ok', 3000)
      state.reload()
    }, function (e) {
      setVpsBusy('')
      dfToast(String((e && e.message) || e), 'err', 5600)
    })
  }

  function clearVps() {
    if (vpsBusy) return
    if (!clearArmed) {
      setClearArmed(true)
      window.setTimeout(function () { setClearArmed(false) }, 5000)
      return
    }
    setClearArmed(false)
    setVpsBusy('clear')
    dfApi('vpsClear', {}, { ttl: 0 }).then(function (r) {
      setVpsBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '清除失败', 'err', 4200); return }
      setVps({ host: '', port: 22, user: '', password: '', auth: '', configured: false, native: false })
      setVpsWizard(false)
      if (r && r.warning) dfToast(r.warning, 'err', 7000)
      else dfToast('已清除 VPS 配置', 'ok', 2400)
      state.reload()
    }, function (e) {
      setVpsBusy('')
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  function toggleNative() {
    if (vpsBusy) return
    if (vps.auth !== 'key') return
    if (vps.native) { applyNative(false); return }
    setNativeConfirm(true)
  }

  function applyNative(enabled) {
    if (vpsBusy) return
    setVpsBusy('native')
    dfApi('vpsNative', { enabled: !!enabled }, { ttl: 0 }).then(function (r) {
      setVpsBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '切换失败', 'err', 4200); return }
      setNativeConfirm(false)
      setVps(function (cur) { return Object.assign({}, cur, { native: !!enabled }) })
      dfToast(enabled ? '已开启原生 ssh 模式' : '已切回面板代跑', 'ok', 2600)
      state.reload()
    }, function (e) {
      setVpsBusy('')
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  function saveCeye() {
    if (ceyeBusy) return
    if (!String(ceye.domain || '').trim()) { dfToast('填 CEYE 域名', 'err', 3000); return }
    setCeyeBusy('save')
    dfApi('oastSave', {
      domain: ceye.domain,
      token: ceye.token,
      test: true,
    }, { ttl: 0 }).then(function (r) {
      setCeyeBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '保存失败', 'err', 5200); return }
      setCeye(function (cur) { return Object.assign({}, cur, { token: '', configured: true }) })
      setCeyeEdit(false)
      dfToast('CEYE 已保存', 'ok', 2600)
      state.reload()
    }, function (e) {
      setCeyeBusy('')
      dfToast(String((e && e.message) || e), 'err', 5200)
    })
  }

  function clearCeye() {
    if (ceyeBusy) return
    if (!ceyeClear) {
      setCeyeClear(true)
      window.setTimeout(function () { setCeyeClear(false) }, 5000)
      return
    }
    setCeyeClear(false)
    setCeyeBusy('clear')
    dfApi('oastClear', {}, { ttl: 0 }).then(function (r) {
      setCeyeBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '清除失败', 'err', 4200); return }
      setCeye({ domain: '', token: '', configured: false })
      dfToast('已清除 CEYE', 'ok', 2400)
      state.reload()
    }, function (e) {
      setCeyeBusy('')
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  return h('div', { className: 'df-ops' },
    h(DfCard, {
      title: '本地工具', icon: 'folder',
      actions: h('div', { className: 'df-opsbar' },
        h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', onClick: state.reload }, '重读'),
        h(DfBtn, {
          size: 'sm', kind: 'primary', icon: 'check', disabled: !!busy,
          onClick: function () { save() },
        }, busy === 'save' ? '保存中…' : '保存')),
    },
      h('div', { className: 'df-formgrid' },
        h('div', { className: 'df-field' },
          h('label', null, '工具箱目录'),
          h('input', {
            className: 'df-input', value: d.toolkitDir || '', placeholder: '例如 C:\\tools\\redteam-kit',
            onChange: function (e) { set('toolkitDir', e.target.value) },
          })),
        h('div', { className: 'df-field' },
          h('label', null, 'nuclei 模板目录'),
          h('input', {
            className: 'df-input', value: d.nucleiTemplatesDir || '', placeholder: 'nuclei-templates 根目录',
            onChange: function (e) { set('nucleiTemplatesDir', e.target.value) },
          })),
        h('div', { className: 'df-field df-field--wide' },
          h('label', null, '附加搜索目录'),
          h('textarea', {
            className: 'df-area df-area--list', rows: 2, value: d.binDirs || '',
            placeholder: '一行一个目录；绿色版工具放这里也能被找到',
            onChange: function (e) { set('binDirs', e.target.value) },
          })))),
      h('div', { className: 'df-note' },
        data.inventory && data.inventory.total
          ? '当前扫描到 ' + dfNum(data.inventory.total) + ' 个工具文件（含手动指定）；在「工具」页查看、标注或重扫。'
          : '还没有扫描到工具文件。填好目录后保存，或到「工具」页点「重扫」。'),

    h(DfCard, {
      title: '网络出口', icon: 'cloud',
      sub: 'AI 执行 curl / nuclei / ffuf 时走这个代理；不改 dsh 自身流量',
      actions: h('div', { className: 'df-opsbar' },
        h(DfBtn, {
          size: 'sm', kind: 'ghost', icon: 'refresh', disabled: egressBusy,
          onClick: function () { testEgress() },
        }, egressBusy ? '测试中…' : '测试出口'),
        h(DfBtn, {
          size: 'sm', kind: 'primary', icon: 'check', disabled: !!busy,
          onClick: function () { save() },
        }, busy === 'save' ? '保存中…' : '保存')),
    },
      h('div', { className: 'df-formgrid' },
        h('div', { className: 'df-field' },
          h('label', null, '代理地址'),
          h('input', {
            className: 'df-input', value: d.egressProxy || '',
            placeholder: '127.0.0.1:1080（有密码写 user:pass@127.0.0.1:1080）',
            onChange: function (e) { set('egressProxy', e.target.value) },
          })),
        h('div', { className: 'df-field' },
          h('label', null, '不走代理'),
          h('input', {
            className: 'df-input', value: d.egressNoProxy || '',
            placeholder: '内网网段，例如 10.0.0.0/8,192.168.0.0/16',
            onChange: function (e) { set('egressNoProxy', e.target.value) },
          }))),
      h('div', { className: 'df-note' },
        '只填 IP:端口 —— http 与 socks5 是同一个端口，两种协议都会写进系统提示，AI 按任务选；代理要认证就写 user:pass@IP:端口。留空表示直连。'),
      egressResult
        ? h('div', { className: 'df-note', style: { marginTop: 6 } },
          egressResult.ok === false
            ? '出口测试失败：' + (egressResult.error || '未知错误')
            : (egressResult.mode === 'proxy'
              ? '出口可用：' + (egressResult.proxy || '代理')
                + (egressResult.schemes
                  ? ' · 可用协议 ' + Object.keys(egressResult.schemes).filter(function (k) {
                    return egressResult.schemes[k] && egressResult.schemes[k].ok
                  }).map(function (k) { return k === 'socks5' ? 'socks5' : 'http' }).join(' / ')
                  : '')
              : egressResult.mode === 'direct'
                ? (String(d.egressProxy || '').trim()
                  ? '配置的代理没连上，当前按直连（检查地址 / 端口 / 是否需要启动 Burp）'
                  : '直连')
                : '不可用')
            + (egressResult.configured_error ? ' · 你填的代理：' + egressResult.configured_error : '')
            + (egressResult.detail ? ' · ' + egressResult.detail : ''))
        : null),

    h(DfCard, {
      title: '外部接入', icon: 'link',
    },
      h('div', { className: 'df-svc-list' },
        h(DfSvcRow, {
          icon: 'crosshair', title: 'FOFA',
          chip: data.fofa && data.fofa.configured ? '已配' : '未配',
          chipKind: data.fofa && data.fofa.configured ? 'ok' : 'err',
          desc: '资产测绘 API',
          actions: [
            h(DfBtn, {
              size: 'sm', kind: 'ghost', icon: 'sliders',
              onClick: function () { setFofaEdit(true) },
            }, '配置'),
            data.fofa && data.fofa.configured
              ? h(DfBtn, {
                size: 'sm', kind: fofaClear ? 'danger' : 'ghost', icon: 'trash',
                disabled: !!busy, onClick: clearFofa,
              }, busy === 'fofa' ? '清除中…' : (fofaClear ? '确认清除' : '清除'))
              : null,
          ],
        }),
        h(DfSvcRow, {
          icon: 'server', title: 'VPS',
          chip: vps.configured ? vpsAuthLabel() : '未配置',
          chipKind: vps.configured ? 'ok' : 'err',
          desc: vps.configured
            ? (vps.user ? vps.user + '@' : '') + vps.host + ' · 端口 ' + (vps.port || 22)
            : '反弹、隧道、文件传输',
          actions: [
            h(DfBtn, {
              size: 'sm', kind: vps.configured ? 'ghost' : 'primary', icon: 'link',
              disabled: !!vpsBusy,
              onClick: function () { setVpsChoice(null); setVpsPortEdit(false); setVpsWizard(true) },
            }, vps.configured ? '重新配置' : '连接'),
            vps.configured
              ? h(DfBtn, {
                size: 'sm', kind: clearArmed ? 'danger' : 'ghost', icon: 'trash',
                disabled: !!vpsBusy, onClick: clearVps,
              }, vpsBusy === 'clear' ? '清除中…' : (clearArmed ? '确认清除' : '清除'))
              : null,
          ],
          extra: vps.configured && vps.auth === 'key'
            ? h('div', { className: 'df-vps-native' },
              h('label', { className: 'df-check' },
                h('input', {
                  type: 'checkbox', checked: !!vps.native,
                  disabled: !!vpsBusy, onChange: toggleNative,
                }),
                h('span', null, '原生 ssh 模式')),
              h('span', { className: 'df-hint' }, vps.native
                ? '模型可直接 ssh / scp / 隧道，也能读取私钥。'
                : '默认由面板代跑，模型拿不到私钥。'))
            : null,
        }),
        h(DfSvcRow, {
          icon: 'cloud', title: 'CEYE',
          chip: ceye.configured ? '已配置' : '未配置',
          chipKind: ceye.configured ? 'ok' : 'err',
          desc: ceye.configured ? ceye.domain : 'DNS / HTTP 回连记录',
          actions: [
            h(DfBtn, {
              size: 'sm', kind: 'ghost', icon: 'sliders',
              onClick: function () { setCeyeEdit(true) },
            }, '配置'),
            ceye.configured
              ? h(DfBtn, {
                size: 'sm', kind: ceyeClear ? 'danger' : 'ghost', icon: 'trash',
                disabled: !!ceyeBusy, onClick: clearCeye,
              }, ceyeBusy === 'clear' ? '清除中…' : (ceyeClear ? '确认清除' : '清除'))
              : null,
          ],
        }))),

    fofaEdit
      ? h('div', { className: 'df-mask df-portal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '配置 FOFA' },
        h('div', { className: 'df-modal' },
          h('div', { className: 'df-modal-hd' },
            h('div', { className: 'df-mh-t' },
              h('h2', null, 'FOFA KEY'),
              h('p', null, '资产测绘 API'))),
          h('div', { className: 'df-modal-bd' },
            h('div', { className: 'df-field' },
              h('label', null, 'API Key'),
              h('input', {
                className: 'df-input', type: 'password', autoComplete: 'new-password',
                value: d.FOFA_KEY || '',
                placeholder: data.fofa && data.fofa.configured ? '已配置；留空不修改' : 'FOFA API key',
                autoFocus: true,
                onChange: function (e) { set('FOFA_KEY', e.target.value) },
              }),
              h('div', { className: 'df-hint' }, '只存本机，DPAPI 加密；不会写进报告。'))),
          h('div', { className: 'df-modal-ft' },
            h(DfBtn, { kind: 'ghost', onClick: function () { setFofaEdit(false) } }, '取消'),
            h('span', { className: 'df-spacer' }),
            h(DfBtn, {
              kind: 'primary', icon: 'check', disabled: !!busy, onClick: saveFofa,
            }, busy === 'fofaSave' ? '保存中…' : '保存'))))
      : null,

    ceyeEdit
      ? h('div', { className: 'df-mask df-portal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '配置 CEYE' },
        h('div', { className: 'df-modal' },
          h('div', { className: 'df-modal-hd' },
            h('div', { className: 'df-mh-t' },
              h('h2', null, 'CEYE'),
              h('p', null, 'DNS / HTTP 回连记录'))),
          h('div', { className: 'df-modal-bd' },
            h('div', { className: 'df-field' },
              h('label', null, 'CEYE 域名'),
              h('input', {
                className: 'df-input', value: ceye.domain || '', placeholder: '例如 abc123.ceye.io',
                onChange: function (e) { setCeye(function (cur) { return Object.assign({}, cur, { domain: e.target.value }) }) },
              })),
            h('div', { className: 'df-field' },
              h('label', null, 'Token'),
              h('input', {
                className: 'df-input', type: 'password', autoComplete: 'new-password',
                value: ceye.token || '',
                placeholder: ceye.configured ? '已保存；留空不修改' : 'CEYE API token',
                onChange: function (e) { setCeye(function (cur) { return Object.assign({}, cur, { token: e.target.value }) }) },
              }),
              h('div', { className: 'df-hint' }, 'Token 加密保存，不进提示词。'))),
          h('div', { className: 'df-modal-ft' },
            h(DfBtn, { kind: 'ghost', onClick: function () { setCeyeEdit(false) } }, '取消'),
            h('span', { className: 'df-spacer' }),
            h(DfBtn, {
              kind: 'primary', icon: 'check', disabled: !!ceyeBusy, onClick: saveCeye,
            }, ceyeBusy === 'save' ? '保存中…' : '测试并保存'))))
      : null,

    vpsWizard
      ? h('div', { className: 'df-mask df-portal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '连接 VPS' },
        h('div', { className: 'df-modal' },
          h('div', { className: 'df-modal-hd' },
            h('div', { className: 'df-mh-t' },
              h('h2', null, vpsChoice ? '选择登录方式' : '连接 VPS'),
              h('p', null, vpsChoice ? ('已连通 · ' + vpsChoice.latencyMs + ' ms') : '先测通，再决定用密钥还是密码。'))),
          h('div', { className: 'df-modal-bd' },
            vpsChoice
              ? h('div', null,
                h('label', {
                  className: 'df-vps-opt' + (vpsMode === 'key' ? ' on' : '') + (vpsChoice.pubkeyAuth === 'no' ? ' is-off' : ''),
                  onClick: vpsChoice.pubkeyAuth === 'no' ? null : function () { setVpsMode('key') },
                },
                  h('input', {
                    type: 'radio', checked: vpsMode === 'key', disabled: vpsChoice.pubkeyAuth === 'no',
                    onChange: function () { setVpsMode('key') },
                  }),
                  h('div', null,
                    h('b', null, '改用密钥登录（推荐）'),
                    h('p', null, vpsChoice.pubkeyAuth === 'no'
                      ? '服务器未开启公钥登录（PubkeyAuthentication no），先在 VPS 开启或继续用密码。'
                      : '密码只用于安装公钥，装完立即丢弃。私钥加密保存，模型拿不到；命令与文件传输由面板代跑。'))),
                h('label', { className: 'df-vps-opt' + (vpsMode === 'password' ? ' on' : ''), onClick: function () { setVpsMode('password') } },
                  h('input', {
                    type: 'radio', checked: vpsMode === 'password',
                    onChange: function () { setVpsMode('password') },
                  }),
                  h('div', null,
                    h('b', null, '继续用账号密码'),
                    h('p', null, '密码必须加密保存或仅本次使用；命令由面板代跑，功能受限。'))),
                vpsMode === 'password'
                  ? h('div', { className: 'df-vps-sub' },
                    h('label', { className: 'df-check' },
                      h('input', {
                        type: 'checkbox', checked: vpsRemember,
                        onChange: function (e) { setVpsRemember(e.target.checked) },
                      }),
                      h('span', null, '记住密码（DPAPI 加密）')),
                    h('div', { className: 'df-hint' }, vpsRemember
                      ? '同一 Windows 账户下的程序仍可能解密，安全性低于密钥。'
                      : '只在本次会话使用，重启后需要重新输入。'))
                  : null,
                vpsChoice.pubkeyAuth === 'no'
                  ? h('div', { className: 'df-hint', style: { marginTop: 10 } },
                    '开启方法：VPS 上编辑 /etc/ssh/sshd_config（及 sshd_config.d），设 PubkeyAuthentication yes，再 systemctl reload ssh。')
                  : null)
              : h('div', null,
                h('div', { className: 'df-field' },
                  h('label', null, '主机'),
                  h('input', {
                    className: 'df-input', value: vps.host || '', placeholder: 'IP 或域名', autoFocus: true,
                    onChange: function (e) { vpsSet('host', e.target.value) },
                  })),
                h('div', { className: 'df-field' },
                  h('label', null, '账号'),
                  h('input', {
                    className: 'df-input', value: vps.user || '', placeholder: '例如 ubuntu',
                    onChange: function (e) { vpsSet('user', e.target.value) },
                  })),
                h('div', { className: 'df-field' },
                  h('label', null, '密码'),
                  h('input', {
                    className: 'df-input', type: 'password', autoComplete: 'new-password',
                    value: vps.password || '',
                    placeholder: vps.configured && (vps.auth === 'password' || vps.auth === 'session')
                      ? '已保存密码；留空沿用'
                      : 'VPS 登录密码',
                    onChange: function (e) { vpsSet('password', e.target.value) },
                  })),
                vpsPortEdit
                  ? h('div', { className: 'df-field' },
                    h('label', null, '端口'),
                    h('input', {
                      className: 'df-input', type: 'number', min: 1, max: 65535, value: vps.port || 22,
                      onChange: function (e) { vpsSet('port', e.target.value) },
                    }))
                  : h('div', { className: 'df-hint' }, '端口 ' + (vps.port || 22) + '　',
                    h('a', {
                      href: '#',
                      onClick: function (e) { e.preventDefault(); setVpsPortEdit(true) },
                    }, '改端口')))),
          h('div', { className: 'df-modal-ft' },
            h(DfBtn, {
              kind: 'ghost',
              onClick: function () { setVpsWizard(false); setVpsChoice(null); setVpsPortEdit(false) },
            }, '取消'),
            h('span', { className: 'df-spacer' }),
            vpsChoice
              ? h(DfBtn, {
                kind: 'primary', icon: 'check', disabled: !!vpsBusy, onClick: applyVps,
              }, vpsBusy === 'apply' ? '配置中…' : '确认')
              : h(DfBtn, {
                kind: 'primary', icon: 'link', disabled: !!vpsBusy, onClick: testVps,
              }, vpsBusy === 'test' ? '测试中…' : '测试连接'))))
      : null,

    nativeConfirm
      ? h('div', { className: 'df-mask df-portal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '开启原生 ssh' },
        h('div', { className: 'df-modal' },
          h('div', { className: 'df-modal-hd' },
            h('div', { className: 'df-mh-t' },
              h('h2', null, '开启原生 ssh 模式'),
              h('p', null, '可用性最高，但模型能直接拿到私钥。'))),
          h('div', { className: 'df-modal-bd' },
            h('p', null, '开启后模型可以直接 ssh / scp / ssh -L，不再经过面板代跑。'),
            h('p', null, '私钥会以可用文件形式放在本机，模型和同账户进程都能读取；只在你信任本机和模型时开启。')),
          h('div', { className: 'df-modal-ft' },
            h(DfBtn, { kind: 'ghost', onClick: function () { setNativeConfirm(false) } }, '取消'),
            h('span', { className: 'df-spacer' }),
            h(DfBtn, {
              kind: 'primary', icon: 'check', disabled: !!vpsBusy,
              onClick: function () { applyNative(true) },
            }, vpsBusy === 'native' ? '开启中…' : '确认开启'))))
      : null
  )
}

/* ---------------------------------------------------------------- 提示词 */

/** 角色稿变体：只负责把变体载入编辑器，点“保存”才写当前靶标/模式。 */
function DfRoleTemplateBar(props) {
  const [items, setItems] = useState([])
  const [defaultContent, setDefaultContent] = useState('')
  const [busy, setBusy] = useState('')
  const [saveOpen, setSaveOpen] = useState(false)
  const [name, setName] = useState('')
  const mode = props.mode || 'redteam'

  function load() {
    dfHostPost('/dsh-forge/role-templates', { op: 'status', mode: mode, role: props.role }).then(function (r) {
      if (!r || r.ok === false) return
      setItems(Array.isArray(r.items) ? r.items : [])
      setDefaultContent(String(r.default_content || ''))
    })
  }

  useEffect(load, [props.role, mode])

  function pick(id) {
    if (!id) return
    if (id === '__default') {
      props.onLoad(defaultContent)
      dfToast('已载入模式默认稿，点“保存”生效', 'info', 2400)
      return
    }
    setBusy('load')
    dfHostPost('/dsh-forge/role-templates', { op: 'read', mode: mode, role: props.role, id: id }).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '读取变体失败', 'err', 4200); return }
      props.onLoad(String(r.content || ''))
      dfToast('已载入变体，点“保存”生效', 'info', 2400)
    })
  }

  function save() {
    if (!name.trim() || busy) return
    setBusy('save')
    dfHostPost('/dsh-forge/role-templates', {
      op: 'save', mode: mode, role: props.role, name: name.trim(), content: props.text,
    }).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '保存变体失败', 'err', 4200); return }
      dfToast('已存为变体', 'ok', 1800)
      setSaveOpen(false)
      setName('')
      load()
    })
  }

  return h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 } },
    h('span', { className: 'df-label' }, '变体'),
    h('select', {
      className: 'df-select', value: '', style: { width: 210, flex: 'none' },
      onChange: function (e) { pick(e.target.value) },
    },
      h('option', { value: '' }, '载入变体…'),
      h('option', { value: '__default' }, '模式默认'),
      items.map(function (t) {
        return h('option', { key: t.id, value: t.id }, t.name + '（' + dfNum(t.chars) + ' 字符）')
      })),
    busy === 'load' ? h('span', { className: 'df-hint' }, '载入中…') : null,
    saveOpen
      ? h('span', { style: { display: 'inline-flex', gap: 6, alignItems: 'center' } },
        h('input', {
          className: 'df-input', value: name, autoFocus: true, placeholder: '变体名称',
          style: { width: 150 }, onChange: function (e) { setName(e.target.value) },
        }),
        h(DfBtn, { size: 'sm', kind: 'primary', icon: 'check', disabled: !!busy || !name.trim(), onClick: save }, busy === 'save' ? '保存中…' : '保存'),
        h(DfBtn, { size: 'sm', kind: 'ghost', onClick: function () { setSaveOpen(false); setName('') } }, '取消'))
      : h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'plus', onClick: function () { setSaveOpen(true) } }, '另存为变体'))
}

/* 工作区指令编辑器：dsh 原生 AGENTS.md / CLAUDE.md。 */
function DfInstructionEditor(props) {
  const [text, setText] = useState('')
  const [orig, setOrig] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const dirty = loaded && text !== orig

  useEffect(function () {
    let alive = true
    setLoaded(false)
    setErr('')
    dfHostPost('/dsh-forge/instructions', { action: 'read', path: props.file.path }).then(function (r) {
      if (!alive) return
      if (!r || r.ok === false) {
        setErr((r && r.error) || '读取指令文件失败')
        setLoaded(true)
        return
      }
      const content = String(r.content || '')
      setText(content)
      setOrig(content)
      setLoaded(true)
    })
    return function () { alive = false }
  }, [props.file.path])

  function save() {
    if (busy || !dirty) return
    setBusy(true)
    dfHostPost('/dsh-forge/instructions', { action: 'save', path: props.file.path, content: text }).then(function (r) {
      setBusy(false)
      if (!r || r.ok === false) { dfToast((r && r.error) || '保存失败', 'err', 4200); return }
      setOrig(text)
      dfToast('已保存，下一轮生效', 'ok', 2200)
      if (props.onSaved) props.onSaved(r)
    })
  }

  if (!loaded) return h('div', { className: 'df-detail' }, h('div', { className: 'df-note' }, '读取中…'))
  return h('div', { className: 'df-detail' },
    err ? h('div', { className: 'df-note', style: { color: 'var(--df-err)' } }, err) : null,
    h('div', { className: 'df-note' }, 'DeepSeek Harness 按 用户级 → 项目根 → 当前目录 顺序拼接；总预算 64KB，超出会截断。'),
    h('textarea', {
      className: 'df-area df-area--code', rows: 18, value: text, spellCheck: false,
      style: { width: '100%', minHeight: 320 },
      onChange: function (e) { setText(e.target.value) },
    }),
    h('div', { className: 'df-formfoot' },
      h('span', { className: 'df-ops-meta' }, dfNum(text.length) + ' 字符 · 下一轮生效'),
      h('span', { className: 'df-spacer' }),
      h(DfBtn, { size: 'sm', kind: 'primary', icon: 'check', disabled: busy || !dirty, onClick: save }, busy ? '保存中…' : '保存')))
}

/**
 * 破甲注入生效范围：模式可能越来越多，卡片里只放摘要；完整列表在抽屉里搜索、全选。
 * 保存时一次性写回，避免每勾一下就打一次接口。
 */
function DfScopePicker(props) {
  const [sel, setSel] = useState(function () {
    return Array.isArray(props.scopes) ? props.scopes.slice() : []
  })
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const modes = Array.isArray(props.modes) ? props.modes : []
  const cur = String(props.current || '')
  const query = q.trim().toLowerCase()
  const shown = modes.filter(function (m) {
    if (!query) return true
    return [dfModeTitle(m), m.id, m.description].map(function (x) { return String(x || '') }).join(' ').toLowerCase().includes(query)
  })

  function toggle(id) {
    setSel(function (list) {
      return list.indexOf(id) >= 0 ? list.filter(function (x) { return x !== id }) : list.concat([id])
    })
  }

  function save() {
    if (busy) return
    setBusy(true)
    dfHostPost('/dsh-forge/inject', { action: 'setScopes', scopes: sel }).then(function (r) {
      setBusy(false)
      if (!r || r.ok === false) { dfToast((r && r.error) || '保存失败', 'err', 4200); return }
      dfToast('生效范围已更新，下一轮生效', 'ok', 2200)
      if (props.onSaved) props.onSaved(sel)
      if (props.onClose) props.onClose()
    }, function (e) {
      setBusy(false)
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  return h('div', { className: 'df-detail' },
    h('div', { className: 'df-note' }, '勾选的模式才启用破甲注入；没勾的模式保持 DeepSeek Harness 原生人格。'),
    h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', margin: '10px 0', flexWrap: 'wrap' } },
      h(DfSearch, { value: q, placeholder: '搜索模式 / 用途', onChange: setQ, style: { flex: '1 1 180px' } }),
      h(DfBtn, { size: 'sm', kind: 'ghost', onClick: function () { setSel(modes.map(function (m) { return m.id })) } }, '全选'),
      h(DfBtn, { size: 'sm', kind: 'ghost', onClick: function () { setSel([]) } }, '清空'),
      cur ? h(DfBtn, { size: 'sm', kind: 'ghost', onClick: function () { setSel([cur]) } }, '仅当前') : null),

    shown.length
      ? h('div', { className: 'df-vlist' }, shown.map(function (m) {
        const on = sel.indexOf(m.id) >= 0
        return h('label', {
          key: m.id,
          className: dfCx('df-check', on && 'is-on'),
          style: { border: '1px solid var(--df-line)' },
        },
          h('input', { type: 'checkbox', checked: on, onChange: function () { toggle(m.id) } }),
          h('span', null, h('b', null, dfModeTitle(m)),
            m.id === cur ? h('small', { style: { marginLeft: 6, opacity: 0.7 } }, '当前模式') : null,
            m.description ? h('small', { style: { display: 'block', opacity: 0.72 } }, m.description) : null))
      }))
      : h(DfEmpty, { icon: 'layers', title: '没有匹配的模式', hint: '换个关键词试试。' }),

    h('div', { className: 'df-formfoot' },
      h('span', { className: 'df-ops-meta' }, '已选 ' + dfNum(sel.length) + ' / ' + dfNum(modes.length) + ' 个模式'),
      h('span', { className: 'df-spacer' }),
      h(DfBtn, { size: 'sm', kind: 'ghost', disabled: !!busy, onClick: props.onClose }, '取消'),
      h(DfBtn, { size: 'sm', kind: 'primary', icon: 'check', disabled: !!busy, onClick: save },
        busy ? '保存中…' : '保存范围')))
}

/* 破甲注入：模板、范围、开关、编辑、恢复默认。 */
function DfMainInject(props) {
  const state = dfUseAsync(function () {
    return dfHost('/dsh-forge/inject')
  }, [props.tick])
  const [busy, setBusy] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(function () {
    if (!confirmReset) return undefined
    const t = window.setTimeout(function () { setConfirmReset(false) }, 5000)
    return function () { window.clearTimeout(t) }
  }, [confirmReset])
  useEffect(function () {
    if (!confirmDelete) return undefined
    const t = window.setTimeout(function () { setConfirmDelete(false) }, 5000)
    return function () { window.clearTimeout(t) }
  }, [confirmDelete])

  const d = state.data || {}
  const templates = Array.isArray(d.templates) ? d.templates : []
  const modes = Array.isArray(d.modes) && d.modes.length
    ? d.modes
    : [{ id: 'redteam', name: '红队' }, { id: 'crack', name: '破解' }]
  const scopes = Array.isArray(d.scopes) ? d.scopes : []
  const enabled = d.enabled !== false
  /* 核心补丁没写进宿主时，开关先置灰：先能破甲，再谈开关。关闭操作始终可用。 */
  const patch = d.patch_state || null
  const coreReady = patch ? patch.core_complete === true : true
  const coreFailed = patch ? Number(patch.core_failed) || 0 : 0
  const corePending = patch ? Number(patch.core_pending) || 0 : 0
  const coreDisabled = !!(patch && patch.reason === 'core-disabled')
  const hostReset = !!(patch && patch.reason === 'host-reset')
  const coreBlocked = !enabled && !coreReady
  const content = String(d.content || '')
  const template = String(d.template || '')
  const current = templates.find(function (t) { return t.id === template })
  const currentName = template === 'custom'
    ? '自定义'
    : (current ? current.name : (template || '—'))
  const scopeNames = scopes.map(function (id) {
    const hit = modes.find(function (m) { return m.id === id })
    return hit ? dfModeTitle(hit) : dfModeLabel(id)
  })
  const currentMode = dfCurrentAgentPreset()
  const currentHit = modes.find(function (m) { return m.id === currentMode })
  const currentModeName = currentHit ? dfModeTitle(currentHit) : dfModeLabel(currentMode)
  const currentCovered = dfScopeCovered(currentMode, scopes)
  const currentStock = dfStockMode(currentMode)
  const builtin = template === 'minimal' || template === 'redteam'
  const canDelete = !builtin && template !== 'custom' && !!current

  function post(action, extra) {
    if (busy) return Promise.resolve(null)
    setBusy(action)
    return dfHostPost('/dsh-forge/inject', Object.assign({ action: action }, extra || {})).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) {
        dfToast((r && r.error) || '操作失败', 'err', 4600)
        return r
      }
      if (props.onChanged) props.onChanged()
      dfBust()
      return r
    }, function (e) {
      setBusy('')
      dfToast(String(e && e.message ? e.message : e), 'err', 4600)
      return null
    })
  }

  function applyTemplate(id) {
    if (!id || busy) return
    post('applyTemplate', { id: id }).then(function (r) {
      if (r && r.ok !== false) dfToast('已切换模板，下一轮生效', 'ok', 2200)
    })
  }

  function openScopes() {
    if (!props.onInspect) return
    props.onInspect({
      title: '破甲注入生效范围',
      sub: '已选 ' + dfNum(scopes.length) + ' / ' + dfNum(modes.length) + ' 个模式',
      node: h(DfScopePicker, {
        modes: modes,
        scopes: scopes,
        current: dfCurrentAgentPreset(),
        onClose: props.onCloseDrawer,
        onSaved: function () {
          if (props.onChanged) props.onChanged()
          dfBust()
        },
      }),
    })
  }

  function openEditor() {
    if (!props.onInspect) return
    props.onInspect({
      mode: 'page',
      maximize: true,
      title: '编辑破甲注入',
      sub: currentName + ' · ' + dfNum(content.length) + ' 字符',
      rows: [
        ['模板', currentName],
        ['生效', enabled ? (scopeNames.join('、') || '未选择模式') : '已关闭'],
        ['大小', dfNum(content.length) + ' 字符 · 约 ' + dfNum(Math.ceil(content.length / 2)) + ' Token'],
      ],
      node: h(DfOperatorEditor, {
        content: content,
        onSave: function (text) {
          return dfHostPost('/dsh-forge/inject', { action: 'saveContent', content: text })
        },
        onDone: function () { if (props.onChanged) props.onChanged(); dfBust() },
      }),
    })
  }

  function openSaver() {
    if (!props.onInspect) return
    props.onInspect({
      title: '另存为模板',
      sub: '只保存破甲注入内容',
      node: h(DfTemplateSaver, {
        content: content,
        onDone: function (r) {
          const saved = r && r.saved
          if (saved && saved.id) applyTemplate(saved.id)
          else if (props.onChanged) props.onChanged()
          if (props.onCloseDrawer) props.onCloseDrawer()
        },
      }),
    })
  }

  function reset() {
    if (!confirmReset) { setConfirmReset(true); return }
    post('reset').then(function (r) {
      if (r && r.ok !== false) {
        setConfirmReset(false)
        dfToast('已恢复最简破甲', 'ok', 2600)
      }
    })
  }

  function removeTemplate() {
    if (!confirmDelete) { setConfirmDelete(true); return }
    post('deleteTemplate', { id: template }).then(function (r) {
      if (r && r.ok !== false) {
        setConfirmDelete(false)
        dfToast('模板已删除', 'ok', 2000)
      }
    })
  }

  if (state.loading && !state.data) {
    return h(DfCard, { title: '破甲注入', icon: 'prompt', sub: '读取中' },
      h(DfSkeleton, { lines: 4 }))
  }
  if (state.error || d.ok === false) {
    return h(DfCard, { title: '破甲注入', icon: 'prompt' },
      h(DfOpsError, { title: '读取破甲注入失败', error: state.error || d.error, onRetry: state.reload }))
  }

  return h(DfCard, {
    title: '破甲注入', icon: 'prompt',
    sub: '唯一的破甲开关（顶栏只显示状态）+ 模板 + 范围',
  },
    h('div', { className: 'df-inject-hero' + (enabled ? ' is-on' : '') },
      h('div', { className: 'df-ih-main' },
        h('b', null, enabled ? '破甲注入已开启' : '破甲注入已关闭'),
        h('span', null, '当前模式：' + currentModeName + ' · ' + (
          enabled
            ? (currentCovered ? (content.trim() ? '已生效' : '正文为空，未生效') : '当前模式未在范围，未生效')
            : '总开关关闭，未生效'))),
      h(DfBtn, {
        kind: enabled ? 'danger' : 'primary', icon: enabled ? 'pause' : 'check',
        disabled: !!busy || coreBlocked,
        title: coreBlocked
          ? (coreDisabled
            ? '核心补丁已停用；重新启用并写入宿主后可用'
            : hostReset
              ? '宿主更新后核心补丁已丢失；重新写入后可用'
            : '核心补丁未写入宿主：' + (coreFailed > 0
              ? coreFailed + ' 条失败'
              : (corePending > 0 ? corePending + ' 条待写入' : '尚未写入')) + '，先去维护页写入')
          : null,
        onClick: function () {
          if (coreBlocked) {
            dfToast(coreDisabled
              ? '核心补丁已停用，破甲开关暂不可用；先到维护页重新启用'
              : hostReset
                ? '宿主更新后核心补丁已丢失；先到维护页重新写入'
                : '核心补丁未写入宿主，破甲开关暂不可用；先到维护页写入', 'err', 4200)
            if (props.onGoto) props.onGoto('maintenance')
            return
          }
          post('setEnabled', { enabled: !enabled })
        },
      }, busy ? '处理中…' : (enabled ? '关闭破甲注入' : (coreBlocked
        ? (coreDisabled ? '核心补丁已停用' : (hostReset ? '核心补丁已丢失' : '核心补丁未写入'))
        : '开启破甲注入')))),
    coreBlocked
      ? h('div', {
        className: 'df-note df-note--warn',
        style: { marginBottom: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      },
        h('span', { style: { flex: '1 1 220px' } },
          coreDisabled
            ? '核心补丁被停用，破甲开关暂不可用。到「配置 → 维护」重新启用核心补丁并写入宿主。'
            : hostReset
              ? '宿主更新/重置冲掉了核心补丁，破甲开关暂不可用。到「配置 → 维护 → 写入宿主」重新写入。'
              : '核心补丁还没写进宿主，破甲开关暂不可用。到「配置 → 维护 → 写入宿主」写入后再开启。'),
        props.onGoto
          ? h(DfBtn, {
            size: 'sm', kind: 'primary', icon: 'wrench',
            onClick: function () { props.onGoto('maintenance') },
          }, '去写入宿主')
          : null)
      : null,
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 } },
      h('span', { className: 'df-label' }, '模板'),
      h('select', {
        className: 'df-select', value: template === 'custom' ? '' : template,
        disabled: !!busy,
        style: { width: 220 },
        onChange: function (e) { applyTemplate(e.target.value) },
      },
        template === 'custom' ? h('option', { value: '' }, '自定义（未保存为模板）') : null,
        templates.map(function (t) {
          return h('option', { key: t.id, value: t.id },
            t.name + (t.builtin ? '' : ' · 自定义'))
        })),
      canDelete ? h(DfBtn, {
        size: 'sm', kind: confirmDelete ? 'danger' : 'ghost', icon: 'trash', disabled: !!busy,
        onClick: removeTemplate,
        onBlur: function () { setConfirmDelete(false) },
      }, busy === 'deleteTemplate' ? '删除中…' : (confirmDelete ? '确认删除模板' : '删除模板')) : null),

    h('div', { className: 'df-note', style: { marginBottom: 8 } },
      '当前模式：' + currentModeName + ' · ' + (
        currentCovered
          ? (enabled ? (content.trim() ? '已生效' : '正文为空，未生效') : '总开关关闭，未生效')
          : currentStock
            ? '原厂模式，不注入。要启用破甲，请在 DeepSeek Harness 的模式菜单切到红队/破解模式，再新建任务（切换预设只影响新任务）。'
            : '未加入生效范围，点「管理」加入。')),

    h('div', { className: 'df-scope-line' },
      h('div', { className: 'df-scope-main' },
        h('span', { className: 'df-label' }, '生效范围'),
        scopeNames.length
          ? h('div', { className: 'df-scope-chips' },
            scopeNames.slice(0, 4).map(function (name) {
              return h(DfChip, { key: name, kind: 'line' }, name)
            }),
            scopeNames.length > 4
              ? h(DfChip, { key: 'more', kind: 'line' }, '+' + dfNum(scopeNames.length - 4))
              : null)
          : h('span', { className: 'df-hint' }, '未选择模式，破甲注入不会生效')),
      h(DfBtn, {
        size: 'sm', kind: 'ghost', icon: 'sliders', disabled: !!busy,
        onClick: openScopes,
      }, '管理')),

    h('div', { className: 'df-note' }, '没勾的模式保持 DeepSeek Harness 原生人格；改动下一轮生效。'),
    content
      ? h('pre', { className: 'df-evi', style: { whiteSpace: 'pre-wrap', marginTop: 8, maxHeight: 150, overflow: 'auto' } }, dfCtxPreview(content))
      : h(DfEmpty, { icon: 'prompt', title: '破甲注入是空的', hint: '点“编辑”写一份，或恢复默认。' }),

    h(DfInjectSelfCheck, { content: content, tick: props.tick }),

    h('div', { className: 'df-formfoot' },
      h('span', { className: 'df-ops-meta' }, dfNum(content.length) + ' 字符 · 模板：' + currentName),
      h('span', { className: 'df-spacer' }),
      h(DfBtn, { size: 'sm', kind: 'primary', icon: 'prompt', disabled: !!busy, onClick: openEditor }, '编辑'),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'fileText', disabled: !!busy, onClick: openSaver }, '存为模板'),
      h(DfBtn, {
        size: 'sm', kind: confirmReset ? 'danger' : 'ghost', icon: 'restore', disabled: !!busy,
        onClick: reset, onBlur: function () { setConfirmReset(false) },
      }, busy === 'reset' ? '恢复中…' : (confirmReset ? '确认恢复最简' : '恢复默认'))))
}

/** 破甲自检：拿宿主内存里的实际组装，检查注入正文是否真的进了 system prompt。 */
function DfInjectSelfCheck(props) {
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState(null)

  function check() {
    if (busy) return
    setBusy(true)
    dfHost('/dsh-forge/assembled').then(function (r) {
      setBusy(false)
      if (!r || r.ok === false) {
        setRes({ state: 'error', msg: (r && r.error) || '读不到实际组装' })
        return
      }
      if (r.empty) {
        setRes({ state: 'empty', msg: '还没有捕获到组装结果；先在当前会话发一条消息，再点「重新检查」。' })
        return
      }
      const secs = Array.isArray(r.sections) ? r.sections : []
      const preview = dfCtxPreview(String(props.content || ''))
      const probes = preview.split('\n').map(function (x) { return x.trim() })
        .filter(function (x) { return x.length >= 8 }).slice(0, 3)
      let hit = null
      for (let i = 0; i < secs.length && !hit; i += 1) {
        const text = String(secs[i].text || '')
        if (probes.some(function (p) { return text.includes(p) })) hit = secs[i]
      }
      if (hit) {
        setRes({ state: 'ok', msg: '已确认：注入正文已进入本次 system prompt。', section: hit.name, mode: r.mode, at: r.at })
      } else {
        setRes({
          state: 'miss',
          msg: '本次组装里没有找到注入正文。当前会话可能不是红队/破解模式，或改动后还没发新消息。',
          mode: r.mode,
          sections: secs.map(function (s) { return s.name }).slice(0, 8),
        })
      }
    }, function (e) {
      setBusy(false)
      setRes({ state: 'error', msg: String((e && e.message) || e) })
    })
  }

  useEffect(function () { check() }, [props.tick])

  const meta = !res ? ['未检查', 'line']
    : res.state === 'ok' ? ['已确认注入', 'ok']
      : res.state === 'empty' ? ['还没发消息', 'warn']
        : res.state === 'miss' ? ['未注入', 'err']
          : ['检查失败', 'err']

  return h('section', { className: 'df-detail-sec' },
    h('div', { className: 'df-detail-hd' },
      h('h4', null, '破甲自检'),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', disabled: busy, onClick: check },
        busy ? '检查中…' : '重新检查')),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
      h(DfChip, { kind: meta[1], dot: true }, meta[0]),
      res && res.mode ? h('span', { className: 'df-hint' }, '组装模式：' + dfModeTitle(res.mode)) : null),
    h('div', { className: 'df-note' }, res ? res.msg : '用宿主实际组装核对，不靠猜。'),
    res && res.section ? h('div', { className: 'df-note' }, '命中段：' + res.section) : null,
    res && res.sections ? h('div', { className: 'df-note' }, '本次段名：' + res.sections.join(' / ')) : null,
    h('div', { className: 'df-note' },
      '“已确认注入”只说明注入正文进了 system prompt；模型是否按破甲风格回答，还要在会话里实际提问验证。改动后先发一条消息，再检查。'))
}

/** 破甲注入独立页：开关、模板、范围、正文都在这里，避免和提示词页混在一起。 */
function DfInjectPage(props) {
  const [tick, setTick] = useState(0)
  function bump() {
    setTick(function (t) { return t + 1 })
    if (props.onChanged) props.onChanged()
  }
  return h('div', { className: 'df-ops' },
    h('div', { className: 'df-opsbar' },
      h('span', { className: 'df-ops-title' }, '破甲注入'),
      h('span', { className: 'df-ops-meta' }, '决定模型是否按授权边界工作'),
      h('span', { className: 'df-spacer' }),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', onClick: bump }, '刷新')),

    h(DfMainInject, {
      tick: tick + props.tick,
      onChanged: bump,
      onInspect: props.onInspect,
      onCloseDrawer: props.onCloseDrawer,
      onGoto: props.onGoto,
    }),

    h(DfCard, { title: '怎么判断是否生效', icon: 'info',
      actions: props.onGoto
        ? h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'users', onClick: function () { props.onGoto('agents') } }, '去智能体层')
        : null,
    },
      h('div', { className: 'df-note' },
        '当前模式已注入时，顶栏「破甲注入」圆点是绿色；没生效是红色，读取中是黄色。'),
      h('div', { className: 'df-note', style: { marginTop: 6 } },
        '破甲注入只负责“能不能做 + 输出纪律”；主智能体人格、子智能体提示词在左侧对应层按模式管理。')))
}

/* 工作区指令：dsh 原生 AGENTS.md / CLAUDE.md 链，外加写入用户级 AGENTS.md 的规则片段。
   原来「提示词」页里的破甲注入、角色稿、技能、身份都只是跳转卡片，已全部移除；
   同一个功能只保留一个入口。 */
function dfInstructionTitle(f) {
  const name = f.name || 'AGENTS.md'
  if (f.scope === 'user-global') return '用户级 ' + name
  if (f.scope === 'agents-global') return '共享级 ' + name
  if (f.scope === 'root') return '项目根 ' + name
  if (f.scope === 'cwd') return '当前目录 ' + name
  return '上级目录 ' + name
}

function dfInstructionWhere(f) {
  if (f.scope === 'user-global') return '所有项目都生效'
  if (f.scope === 'agents-global') return '~/.agents 共享给所有项目'
  if (f.scope === 'root') return '项目根目录'
  if (f.scope === 'cwd') return '当前工作目录'
  return '当前目录的上级'
}

/* 工作区指令的真实加载顺序；序号是 5 级中的位置，缺哪一级就跳号，不重排。 */
const DF_INSTRUCTION_TIERS = {
  'user-global': { no: '1/5', label: '用户级', where: '$DSH_HOME/AGENTS.md · 所有项目' },
  'agents-global': { no: '2/5', label: '共享级', where: '~/.agents/AGENTS.md · 所有项目' },
  'root': { no: '3/5', label: '项目根', where: '项目根目录' },
  'ancestor': { no: '4/5', label: '上级目录', where: '项目根到当前目录之间' },
  'cwd': { no: '5/5', label: '当前目录', where: '当前工作目录' },
}

function dfInstructionTier(f) {
  return DF_INSTRUCTION_TIERS[f.scope] || DF_INSTRUCTION_TIERS.ancestor
}

function DfInstructionsPage(props) {
  const [tick, setTick] = useState(0)
  const insState = dfUseAsync(function () {
    return dfHost('/dsh-forge/instructions')
  }, [props.tick, tick])

  const ins = insState.data || {}
  const files = Array.isArray(ins.files) ? ins.files : []
  const existing = files.filter(function (f) { return f.exists })

  /* 按真实加载顺序分组；同组内保留服务端给的候选文件顺序。 */
  const groups = []
  const byScope = {}
  files.forEach(function (f) {
    let g = byScope[f.scope]
    if (!g) {
      g = { key: f.scope, tier: dfInstructionTier(f), rows: [] }
      byScope[f.scope] = g
      groups.push(g)
    }
    g.rows.push(f)
  })

  function bump() { setTick(function (t) { return t + 1 }) }

  function openInstruction(f) {
    if (!props.onInspect) return
    props.onInspect({
      mode: 'page',
      maximize: true,
      title: dfInstructionTitle(f),
      sub: dfInstructionWhere(f) + ' · ' + (f.exists ? dfBytes(f.size) : '未创建'),
      rows: [
        ['位置', dfInstructionWhere(f)],
        ['路径', f.path],
        ['生效', '下一轮生效 · 合并成一条 user 角色基线消息'],
      ],
      node: h(DfInstructionEditor, {
        file: f,
        onSaved: function (r) {
          if (r && Number.isFinite(r.size)) f.size = r.size
          f.exists = true
          bump()
          openInstruction(f)
        },
      }),
    })
  }

  return h('div', { className: 'df-ops' },
    h('div', { className: 'df-opsbar' },
      h('span', { className: 'df-ops-title' }, '工作区指令'),
      h('span', { className: 'df-ops-meta' }, 'AGENTS.md · 用户级 → 共享级 → 项目根 → 当前目录'),
      h('span', { className: 'df-spacer' }),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', onClick: bump }, '刷新')),

    h(DfPromptLayers, {
      focus: ['workspace'],
      onGoto: props.onGoto,
      note: '本页管第 2 层；这些文件不是 agent，只是工作区指令。',
    }),

    h('div', { className: 'df-kpis' },
      h(DfKpi, {
        label: '已创建文件', icon: 'list',
        value: dfNum(existing.length),
        foot: '5 级中已列出 ' + dfNum(files.length) + ' 个位置',
      }),
      h(DfKpi, {
        label: '已写入', icon: 'fileText',
        value: ins.totalBytes ? dfBytes(ins.totalBytes) : '0 B',
        foot: ins.budgetBytes ? '预算 ' + dfBytes(ins.budgetBytes) : '总预算 64 KB',
      })),

    h(DfCard, {
      title: 'DeepSeek Harness 会读取的文件', icon: 'list',
      sub: ins.cwd ? '当前工作目录：' + ins.cwd : '还没有工作目录',
    },
      h('div', { className: 'df-note' },
        '从宽泛到具体合并成一条 user 角色基线消息；总预算 64KB，超出先截断宽泛段。'),
      insState.loading && !insState.data
        ? h(DfSkeleton, { lines: 3 })
        : insState.error || ins.ok === false
          ? h(DfOpsError, { title: '读取工作区指令失败', error: insState.error || ins.error, onRetry: insState.reload })
          : groups.length
            ? h('div', { className: 'df-tierlist' }, groups.map(function (g) {
              return h('div', { key: g.key, className: 'df-tiergroup' },
                h('div', { className: 'df-tierhd' },
                  h('span', { className: 'df-tierno' }, g.tier.no),
                  h('span', { className: 'df-tiert' }, g.tier.label),
                  h('span', { className: 'df-tierw' }, g.tier.where),
                  h('span', { className: 'df-tiern' }, dfNum(g.rows.length) + ' 个文件')),
                h('div', { className: 'df-vlist df-vlist--flat' }, g.rows.map(function (f) {
                  return h('button', {
                    key: f.path, type: 'button', className: 'df-vrow df-vrow--info',
                    onClick: function () { openInstruction(f) },
                  },
                    h('span', { className: 'df-vrow-rail' }),
                    h('span', { className: 'df-vrow-main' },
                      h('span', { className: 'df-vrow-hd' },
                        h('span', { className: 'df-vrow-t' }, dfInstructionTitle(f)),
                        h(DfChip, { kind: f.exists ? 'line' : 'warn' }, f.exists ? '已创建' : '未创建'),
                        h('span', { className: 'df-chip df-chip--line' }, dfBytes(f.size || 0))),
                      h('span', { className: 'df-vrow-m' },
                        h('span', { className: 'df-vrow-ip' }, dfInstructionWhere(f)),
                        h('span', { className: 'df-vrow-sep' }, '·'),
                        h('span', { className: 'df-vrow-url' }, f.path))),
                    h('span', { className: 'df-vrow-right' }, h('span', { className: 'df-vrow-go' }, '›')))
                })))
            }))
            : h(DfEmpty, { icon: 'list', title: '还没有工作区指令', hint: '用户级 AGENTS.md 可以在这里新建。' })),

    h('div', { className: 'df-note', style: { marginTop: 14 } },
      '规则片段是预置的一段约束，点「写入 AGENTS.md」会整段覆盖用户级 AGENTS.md（自动备份）。'
      + '已经手改过用户级文件时，先在上面编辑或先备份，不要直接覆盖。'),
    h(DfRulesPanel, {
      tick: props.tick + tick,
      onInspect: props.onInspect,
      onCloseDrawer: props.onCloseDrawer,
      onChanged: bump,
    }))
}

