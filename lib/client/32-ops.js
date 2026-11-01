/* 作业六视图（P2）：概览 / 资产 / 漏洞 / 攻击链 / 通道 / 日志。
   只做取数与展示；详情统一进抽屉，写入走 dfApi 的显式 op。 */

const DF_SEV = {
  critical: { label: '严重', cls: 'critical' },
  high: { label: '高危', cls: 'high' },
  medium: { label: '中危', cls: 'medium' },
  low: { label: '低危', cls: 'low' },
  info: { label: '提示', cls: 'info' },
}

const DF_TEST_LABEL = {
  untested: '未侦察', testing: '侦察中', tested: '侦察完成',
  blocked: '受阻', abandoned: '已放弃', no_surface: '无攻击面',
}
const DF_TEST_KIND = {
  untested: 'line', testing: 'info', tested: 'ok',
  blocked: 'warn', abandoned: 'err', no_surface: 'line',
}

const DF_VULN_STATUS = {
  candidate: '候选', confirmed: '已确认', 'false-positive': '误报',
  exploited: '已利用', fixed: '已修复',
}
const DF_VULN_KIND = {
  candidate: 'warn', confirmed: 'info', 'false-positive': 'line',
  exploited: 'ok', fixed: 'line',
}

const DF_STAGE_LABEL = {
  recon: '侦察', vuln: '漏洞', exploit: '利用', access: '初始访问',
  pivot: '横向移动', data: '数据获取', other: '其他',
  internet: '外网', internal: '内网', boundary: '边界', target: '目标',
}

const DF_TUNNEL_STATUS = { active: '通', down: '断', closed: '已关', unknown: '未知' }
const DF_SHELL_STATUS = { online: '在线', offline: '离线', dead: '失效', unknown: '未知' }
const DF_VULN_SOURCE = {
  active: '主动发现', passive: '被动发现',
  'report-import': '报告导入', manual: '手工记录', human: '人工复核',
  nuclei: 'nuclei', burp: 'Burp', nessus: 'Nessus', fscan: 'fscan', httpx: 'httpx',
  curl: 'curl', sqlmap: 'sqlmap', nmap: 'nmap', agent: '智能体',
}
const DF_SECRET_TYPE = { password: '口令', hash: '哈希', key: '密钥', token: '令牌', cookie: 'Cookie', ticket: '票据' }

/** 来源写的是内部枚举时换成人话；认不出的原样显示，至少不丢信息。 */
function dfVulnSource(value) {
  const key = String(value || '').trim()
  if (!key) return '未标注'
  return DF_VULN_SOURCE[key] || DF_VULN_SOURCE[key.toLowerCase()] || key
}

/**
 * 置信度：库里有 0–1 的小数就换成百分比；没写就按状态给一句人话。
 * 导入的漏洞往往没有 confidence，直接显示「—」会像是面板把数据吃了。
 */
function dfConfidence(value) {
  const raw = value && value.confidence
  if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
    const n = Number(raw)
    if (isFinite(n)) return Math.round(n <= 1 ? n * 100 : n) + '%'
    return String(raw)
  }
  const status = value && value.status
  if (status === 'exploited') return '高（已复现）'
  if (status === 'confirmed') return '高（人工确认）'
  if (status === 'candidate') return '待验证'
  return '—'
}

/**
 * 放进 AI 草稿的靶标行。面板切换靶标只改全局「当前靶标」，不改会话绑定；
 * 不把 engagement 显式写进提示词，模型会按会话绑定写到旧靶标去。
 */
function dfEngagementLine(eng) {
  const id = String(eng || '').trim()
  if (!id) return ''
  return '靶标：' + id + '（调用 redteam 工具时带 args.engagement="' + id + '"）'
}

/** 从 target 取主机名（不带端口）；取不到返回空串。 */
function dfHostName(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'http://' + text)
    return String(u.hostname || '').replace(/^\[|\]$/g, '')
  } catch { return '' }
}

/** URL → 路径 + 查询串；给报文卡片抬头用。 */
function dfPathOf(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  try {
    const u = new URL(text)
    return (u.pathname || '/') + (u.search || '')
  } catch {
    return text.startsWith('/') ? text : ''
  }
}

const DF_ACT = {
  step: { label: '步骤', icon: 'route', bar: 'info' },
  vuln: { label: '漏洞', icon: 'bug', bar: 'err' },
  webshell: { label: 'WebShell', icon: 'terminal', bar: 'warn' },
  credential: { label: '凭据', icon: 'key', bar: 'ok' },
  shot: { label: '截图', icon: 'eye', bar: 'ok' },
}

const DF_ASSET_STATE = { live: '存活', unknown: '未知', dead: '下线' }
/* 优先级是英文枚举，直接显示 medium/low 对第一次打开的人没有意义。 */
const DF_PRIORITY = { critical: '紧急', high: '高', medium: '中', low: '低' }
const DF_PRIORITY_KIND = { critical: 'err', high: 'err', medium: 'warn', low: 'line' }

function dfPriorityLabel(p) {
  const key = String(p || '').toLowerCase()
  return DF_PRIORITY[key] || dfDash(p)
}

/* 覆盖矩阵的八类测试用内部类名，直接摆在列头上没人看得懂。
   这里换成动作化的名字 + 一句人话，表格上方再点明「格子是状态，不是按钮」。 */
const DF_MX_LABEL = {
  authn: '认证绕过',
  authz: '越权访问',
  injection: '注入执行',
  file: '文件与路径',
  ssrf: 'SSRF',
  logic: '业务逻辑',
  client: '前端/客户端',
  infra: '基础设施',
}
const DF_MX_HINT = {
  authn: '免登录 / 弱口令',
  authz: '读他人数据 / 提权',
  injection: 'SQLi / RCE / 模板',
  file: '上传 / 下载 / 穿越',
  ssrf: '服务端请求 / 元数据',
  logic: '价格 / 状态 / 并发',
  client: 'XSS / CSRF / CORS',
  infra: '暴露服务 / 云 / 默认口令',
}
const DF_MX_DESC = {
  authn: '认证绕过：没有账号、换账号或伪造令牌能不能进系统',
  authz: '越权访问：改 id / 租户 / 参数读他人数据，或普通账号做管理员操作',
  injection: '注入执行：SQLi、命令、模板、反序列化、XXE 能不能打到执行',
  file: '文件与路径：上传、下载、任意文件读取、路径穿越',
  ssrf: 'SSRF：服务端请求能不能打到内网、云元数据或本地服务',
  logic: '业务逻辑：价格、数量、优惠、退款、审批、状态机和并发竞态',
  client: '前端/客户端：XSS、CSRF、CORS、postMessage、DOM、Electron 和存储',
  infra: '基础设施：暴露服务、默认口令、Redis/ES/Docker/K8s、云存储和调试面',
}
/* 覆盖账本只有 4 个结论（coverage.status）。早先图例里的「受阻」并不在枚举里，
   真实会出现的「跳过」反而没有图例，这里一并纠正。 */
const DF_MX_STATUS = {
  tested: { label: '已测', desc: '已完成探测并记录结论（不代表存在漏洞）' },
  clean: { label: '干净', desc: '已测，确认无可利用点' },
  skipped: { label: '跳过', desc: '主动放弃：不适用 / 风险过高' },
  untested: { label: '未测', desc: '该类尚未测试' },
}

function dfSevMeta(sev) {
  return DF_SEV[String(sev || '').toLowerCase()] || DF_SEV.info
}

function DfSevBadge(props) {
  const meta = dfSevMeta(props.severity)
  return h('span', { className: 'df-sev df-sev--' + meta.cls, title: props.severity || '' },
    h('i'), meta.label)
}

function DfTestChip(props) {
  const key = String(props.status || 'untested')
  return h(DfChip, { kind: DF_TEST_KIND[key] || 'line' }, DF_TEST_LABEL[key] || key)
}

/* 覆盖矩阵是收口门认的那本账；资产级“侦察状态”单独显示，避免面板说已测、门禁说未测。 */
function DfCoverageChip(props) {
  const done = Number(props.done) || 0
  const total = Number(props.total) || 8
  const kind = done === 0 ? 'line' : (done >= total ? 'ok' : 'info')
  return h(DfChip, { kind: kind, title: (props.missing || []).join(' / ') }, done + '/' + total)
}

function DfVulnStatusChip(props) {
  const key = String(props.status || '')
  return h(DfChip, { kind: DF_VULN_KIND[key] || 'line' }, DF_VULN_STATUS[key] || dfDash(key))
}

function DfPortPills(props) {
  const ports = Array.isArray(props.ports) ? props.ports : []
  if (!ports.length) return h('span', { className: 'df-ri-side' }, '—')
  const shown = ports.slice(0, props.max || 4)
  return h('div', { className: 'df-portlist' }, shown.map(function (p, i) {
    const label = String(p.port) + (p.service ? '/' + p.service : '')
    return h('span', {
      key: i,
      className: 'df-port',
      title: [p.port, p.proto, p.service, p.product, p.version].filter(Boolean).join(' '),
    }, label)
  }), ports.length > shown.length
    ? h('span', { className: 'df-port df-port--more' }, '+' + (ports.length - shown.length))
    : null)
}

function DfAssetCell(props) {
  const a = props.asset || {}
  const name = a.primary_name || a.ip
  const extra = (a.names || []).filter(function (n) { return n.name && n.name !== name && n.name !== a.ip })[0]
  const sub = extra ? extra.name : (name && name !== a.ip ? name : '')
  return h('div', { className: 'df-asset' },
    h('div', { className: 'df-asset-ip' }, dfDash(a.ip)),
    sub ? h('div', { className: 'df-asset-name' }, dfShort(sub, 34)) : null)
}

function dfScopeLabel(scope) {
  if (scope === 'internal') return '内网'
  if (scope === 'external') return '外网'
  return '—'
}

/** 统一的错误/空白容器：都带重试入口。 */
function DfOpsError(props) {
  return h('div', { className: 'df-ops-blank' }, h(DfEmpty, {
    icon: 'alert',
    title: props.title || '读取失败',
    hint: props.error || '',
    action: props.onRetry ? h(DfBtn, { size: 'sm', icon: 'refresh', onClick: props.onRetry }, '重试') : null,
  }))
}

/* ---------------------------------------------------------------- 覆盖矩阵 */

function DfMatrix(props) {
  const m = props.matrix
  /* 这页的用途是「找还没测的地方」，所以默认把缺口最大的资产排在最前。 */
  const [order, setOrder] = useState('gap')
  if (!m || !Array.isArray(m.rows) || !m.rows.length) {
    return h(DfEmpty, { icon: 'grid', title: '还没有资产', hint: '资产收集完成后显示覆盖情况。' })
  }
  /* blocked 只在极老的数据里可能出现，映射留着兜底，图例里不再列。 */
  const short = { tested: '已测', clean: '干净', skipped: '跳过', blocked: '受阻', untested: '未测' }
  const statusOf = function (s) {
    return DF_MX_STATUS[s] || { label: short[s] || s, desc: '' }
  }
  const codeLabel = function (c) { return DF_MX_LABEL[c.code] || c.label }
  const rows = order === 'gap'
    ? m.rows.slice().sort(function (a, b) {
      const ga = a.total - a.done
      const gb = b.total - b.done
      if (ga !== gb) return gb - ga
      return String(a.ip).localeCompare(String(b.ip), 'zh-CN', { numeric: true })
    })
    : m.rows
  return h('div', { className: 'df-mxbox' },
    h('div', { className: 'df-mx-top' },
      h('div', { className: 'df-mx-legend' }, Object.keys(DF_MX_STATUS).map(function (k) {
        const st = DF_MX_STATUS[k]
        return h('span', { key: k, className: 'df-mx-lg', title: st.label + '：' + st.desc },
          h('i', { className: 'df-mx-dot df-mx-dot--' + k }), st.label)
      })),
      h('div', { className: 'df-mx-tools' },
        h(DfSeg, {
          value: order,
          items: [['gap', '缺口优先'], ['asset', '资产顺序']],
          onChange: function (v) { setOrder(v) },
        }))),
    h('div', { className: 'df-mx-note' },
      props.hint || '格子里是状态，点整行补测'),
    h('div', { className: 'df-mxwrap' },
      h('table', { className: 'df-mx' },
        h('thead', null, h('tr', null,
          h('th', { className: 'df-mx-an' }, h('span', { className: 'df-mx-l' }, '资产'),
            h('span', { className: 'df-mx-h' }, '还差几类')),
          m.classes.map(function (c) {
            return h('th', {
              key: c.code,
              className: 'df-mx-th',
              title: DF_MX_DESC[c.code] || c.label,
            },
              h('span', { className: 'df-mx-l' }, codeLabel(c)),
              h('span', { className: 'df-mx-h' }, DF_MX_HINT[c.code] || ''))
          }),
          h('th', { className: 'df-mx-go', title: '打开资产页补测' }, ''))),
        h('tbody', null, rows.map(function (r) {
          const gap = r.total - r.done
          return h('tr', {
            key: r.assetId,
            className: props.onPick ? 'df-row--click' : '',
            title: props.onPick ? '打开这台资产的详情' : undefined,
            onClick: props.onPick ? function () { props.onPick(r) } : undefined,
          },
            h('td', { className: 'df-mx-an', title: r.ip },
              h('div', { className: 'df-mx-aip' }, r.ip),
              h('div', { className: 'df-mx-sub' },
                gap === 0
                  ? h('span', { className: 'df-mx-sub--done' }, '已全部测过')
                  : (r.done === 0
                    ? (r.testStatus && r.testStatus !== 'untested'
                      ? h('span', { className: 'df-mx-sub--done' }, '已测（未分类）')
                      : h('span', { className: 'df-mx-gap df-mx-gap--all' }, '全部未测'))
                    : h('span', null,
                      r.done + '/5 测过 · ',
                      h('b', { className: 'df-mx-gap df-mx-gap--some' }, '差 ' + gap + ' 类'))))),
            m.classes.map(function (c) {
              const s = String(r.cells[c.code] || 'untested')
              const st = statusOf(s)
              return h('td', { key: c.code },
                h('span', {
                  className: 'df-cell df-cell--' + s,
                  title: (DF_MX_DESC[c.code] || c.label) + '\n' + st.label + '：' + st.desc,
                },
                  h('i'), st.label))
            }),
            h('td', { className: 'df-mx-go' }, '›'))
        })))))
}

/* ---------------------------------------------------------------- 概览 */

function DfOverview(props) {
  const eng = props.eng
  const state = dfUseAsync(function () {
    return Promise.all([
      dfApi('viewOverview', { engagement: eng }),
      dfApi('vulnStats', { engagement: eng }, { ttl: 15000 }),
    ]).then(function (r) {
      const ov = r[0] || {}
      if (ov.ok === false) throw new Error(ov.error || '读取概览失败')
      return { ov: ov, va: (r[1] && r[1].stats) || {} }
    })
  }, [eng, props.tick])

  if (state.loading && !state.data) return h(DfSkeleton, { lines: 8 })
  if (state.error || !state.data) {
    return h(DfOpsError, { title: '读取概览失败', error: state.error, onRetry: state.reload })
  }

  const ov = state.data.ov
  const va = state.data.va
  const s = ov.stats || {}
  const m = ov.matrix || { summary: {}, rows: [] }
  const sm = m.summary || {}
  const bySev = va.bySeverity || {}
  const next = ov.next || []
  /* 概览侧栏只当「扫一眼」用：截到 6 条，和左边待办卡的高度差不会拉太大。 */
  const activity = (ov.activity || []).slice(0, 6)

  return h('div', { className: 'df-ops' },
    h('div', { className: 'df-opsbar' },
      h('span', { className: 'df-ops-title' }, '作业概览'),
      h('span', { className: 'df-spacer' }),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', onClick: state.reload }, '刷新')),

    h('div', { className: 'df-kpis' },
      h(DfKpi, {
        label: '资产', icon: 'server', value: dfNum(s.assets || 0),
        foot: '存活 ' + dfNum(s.liveAssets || 0) + ' · 开放端口 ' + dfNum(s.openPorts || 0),
      }),
      h(DfKpi, {
        label: '覆盖率', icon: 'grid', value: dfPct(sm.tested, sm.assets),
        foot: dfNum(sm.tested || 0) + '/' + dfNum(sm.assets || 0) + ' 资产已有覆盖',
        accent: (sm.assets || 0) > 0 && (sm.tested || 0) === (sm.assets || 0),
      }),
      h(DfKpi, {
        label: '覆盖缺口', icon: 'alert', value: dfNum(sm.gaps || 0), unit: '格',
        foot: '零覆盖 ' + dfNum(sm.untouched || 0) + ' 个资产',
        accent: (sm.gaps || 0) > 0,
      }),
      h(DfKpi, {
        label: '漏洞', icon: 'bug', value: dfNum(s.vulns || 0),
        foot: '严重 ' + dfNum(bySev.critical || 0) + ' · 高危 ' + dfNum(bySev.high || 0),
      }),
      h(DfKpi, {
        label: '成果', icon: 'key', value: dfNum(s.accesses || 0), unit: '访问',
        foot: '凭据 ' + dfNum(s.credentials || 0) + ' · 服务 ' + dfNum(s.services || 0),
      })),

    h('div', { className: 'df-ov-cols' },
        h(DfCard, {
          className: 'df-ov-next',
          title: '下一步', icon: 'arrowRight',
          sub: next.length ? next.length + ' 条' : '没有缺口',
          actions: next.length ? h(DfBtn, {
            size: 'sm', kind: 'ghost', icon: 'list',
            onClick: function () { props.onGoto && props.onGoto('assets') },
          }, '去资产') : null,
        },
          next.length
            ? h('div', { className: 'df-rows' }, next.map(function (n, i) {
              const icon = n.kind === 'channel' ? 'link'
                : n.kind === 'deliver' ? 'fileText'
                  : (n.kind === 'evidence' ? 'alert' : (n.kind === 'verify' ? 'check' : 'target'))
              return h('div', {
                key: i,
                className: 'df-rowitem df-rowitem--click',
                onClick: function () {
                  if (!props.onGoto) return
                  props.onGoto(n.kind === 'channel' ? 'sessions'
                    : n.kind === 'deliver' ? 'report'
                      : (n.kind === 'evidence' || n.kind === 'verify') ? 'vulns' : 'assets')
                },
              },
                h('span', { className: 'df-next-ico' }, dfIcon(icon, 13)),
                h('span', { className: 'df-ri-main' }, n.text),
                h(DfChip, { kind: n.kind === 'channel' ? 'info' : n.kind === 'deliver' ? 'line' : (n.kind === 'evidence' ? 'err' : 'warn') }, n.why || n.kind))
            }))
            : h(DfEmpty, { icon: 'check', title: '没有待办的缺口', hint: '暂无缺口。' })),

        h(DfCard, {
          className: 'df-ov-log',
          title: '最近作业', icon: 'clock', sub: activity.length ? activity.length + ' 条' : '',
          actions: h(DfBtn, {
            size: 'sm', kind: 'ghost', icon: 'list',
            onClick: function () { props.onGoto && props.onGoto('log') },
          }, '全部日志'),
        },
          activity.length
            ? h('div', { className: 'df-rows' }, activity.map(function (a, i) {
              const meta = DF_ACT[a.kind] || DF_ACT.step
              return h('div', {
                key: i,
                className: 'df-rowitem df-rowitem--click',
                onClick: function () { props.onInspect && props.onInspect(dfActivityDrawer(a)) },
              },
                h('i', { className: 'df-ri-bar df-ri-bar--' + meta.bar }),
                h('span', { className: 'df-ri-main' }, a.title),
                h('span', { className: 'df-ri-side' }, dfAgo(a.at)))
            }))
            : h(DfEmpty, { icon: 'clock', title: '还没有作业记录' })),

        h(DfCard, {
          className: 'df-ov-mx',
          title: '覆盖矩阵', icon: 'grid',
          sub: '每台资产 × 八类测试',
          actions: h(DfBtn, {
            size: 'sm', kind: 'ghost', icon: 'list',
            onClick: function () { props.onGoto && props.onGoto('assets') },
          }, '去资产'),
        },
          h('div', { style: { padding: '10px 10px 10px' } },
            h(DfMatrix, {
              matrix: m,
              onPick: function (r) {
                if (props.onGoto) props.onGoto('assets', r && r.assetId)
              },
            })))))
}

/** 日志条目 → 抽屉结构（概览「最近作业」复用）。 */
function dfActivityDrawer(a) {
  const meta = DF_ACT[a.kind] || DF_ACT.step
  const status = a.kind === 'webshell'
    ? (DF_SHELL_STATUS[a.status] || a.status)
    : (a.kind === 'vuln' ? (DF_VULN_STATUS[a.status] || a.status) : '')
  const rows = [
    ['类型', meta.label],
    ['时间', dfTime(a.at, true)],
    ['来源', a.who === 'ai' ? 'AI' : dfDash(a.who)],
    ['来源阶段', DF_STAGE_LABEL[a.stage] || dfDash(a.stage)],
  ]
  if (a.severity) rows.push(['严重度', (DF_SEV[String(a.severity).toLowerCase()] || DF_SEV.info).label])
  if (status) rows.push(['状态', status])
  if (a.target) rows.push(['目标', a.target])
  if (a.tool) rows.push(['工具', a.tool])
  if (a.privilege) rows.push(['权限', a.privilege])
  if (a.result) rows.push(['结果', a.result])
  rows.push(['ID', a.id])
  return {
    title: a.title || meta.label,
    sub: meta.label + (a.who === 'ai' ? ' · AI' : ''),
    rows: rows,
    node: a.detail
      ? h('div', { className: 'df-detail' },
        h('section', { className: 'df-detail-sec' },
          h('h4', null, '详情'),
          h('pre', { className: 'df-evi' }, String(a.detail))))
      : null,
  }
}

/* ---------------------------------------------------------------- 资产 */

function DfAssets(props) {
  const eng = props.eng
  const [q, setQ] = useState('')
  const [st, setSt] = useState('')
  const [sort, setSort] = useState('todo')
  const [mode, setMode] = useState('table')
  const [selId, setSelId] = useState('')

  const state = dfUseAsync(function () {
    const jobs = [dfApi('assets', {
      engagement: eng, limit: 2000, sort: sort,
      q: q.trim() || undefined,
      test_status: st || undefined,
    })]
    if (mode === 'matrix') jobs.push(dfApi('viewMatrix', { engagement: eng }))
    return Promise.all(jobs).then(function (r) {
      const list = r[0] || {}
      if (list.ok === false) throw new Error(list.error || '读取资产失败')
      return { list: list, matrix: mode === 'matrix' ? r[1] : null }
    })
  }, [eng, props.tick, q, st, sort, mode])

  const data = state.data
  const rows = (data && data.list && data.list.items) || []
  const total = (data && data.list && data.list.total) || 0
  const matrix = data && data.matrix
  const sm = (matrix && matrix.summary) || {}

  /* 从概览矩阵点行进来的那台资产：数据到位后自动展开详情。 */
  useEffect(function () {
    if (!props.focusAsset || !rows.length) return
    let hit = null
    for (let i = 0; i < rows.length; i += 1) {
      if (String(rows[i].id) === String(props.focusAsset)) { hit = rows[i]; break }
    }
    if (!hit) return
    /* 顺手按 IP 过滤：从矩阵跳过来时，列表里就只剩这一台，不会出现「抽屉里是 A、列表里找不到 A」。 */
    setQ(hit.ip)
    setSelId(hit.id)
    if (props.onInspect) props.onInspect(dfAssetDrawer(hit, eng, state.reload))
    if (props.onFocusConsumed) props.onFocusConsumed()
  }, [props.focusAsset, rows.length])

  /* 卡片级操作：排序 + 视图切换。两个卡片（表格 / 矩阵）共用同一份。 */
  const viewActions = h('div', { className: 'df-opsbar' },
    h('select', {
      className: 'df-select', value: sort, title: '排序',
      onChange: function (e) { setSort(e.target.value) },
    },
      h('option', { value: 'todo' }, '待测优先'),
      h('option', { value: 'priority' }, '优先级'),
      h('option', { value: 'discovered' }, '最新发现'),
      h('option', { value: 'ports' }, '端口最多')),
    h(DfSeg, {
      value: mode, items: [['table', '表格'], ['matrix', '矩阵']],
      onChange: function (v) { setMode(v) },
    }))

  return h('div', { className: 'df-ops' },
    /* 标题行只放「页面级」的东西：标题、说明、搜索、状态筛选。
       视图切换和排序属于这张卡片的，放进卡片标题栏 —— 免得首屏两条横杠、重心下移。 */
    h('div', { className: 'df-opsbar' },
      h('span', { className: 'df-ops-title' }, '资产'),
      h('span', { className: 'df-ops-meta' }, '共 '
        + (state.loading && !data ? '—' : dfNum(total)) + ' 个'),
      h('span', { className: 'df-spacer' }),
      h(DfSearch, {
        value: q, placeholder: '搜索 IP / 域名 / 指纹 / 端口服务',
        onChange: function (v) { setQ(v) }, style: { width: 236 },
      }),
      h(DfSeg, {
        value: st,
        items: [['', '全部'], ['untested', '未测'], ['tested', '已测'], ['blocked', '受阻']],
        onChange: function (v) { setSt(v) },
      })),

    mode === 'matrix'
      ? h(DfCard, {
        title: '覆盖矩阵', icon: 'grid',
        sub: dfNum(sm.assets || 0) + ' 个资产 · 缺口 ' + dfNum(sm.gaps || 0) + ' 格',
        actions: viewActions,
      },
        h('div', { style: { padding: '0 8px 8px' } }, h(DfMatrix, {
          matrix: matrix,
          hint: '格子里是状态；点整行去补测',
        })))
      : h(DfCard, {
        title: '列表', icon: 'server', sub: rows.length !== total ? '显示 ' + rows.length + ' / ' + total : '',
        actions: viewActions,
      },
        state.error
          ? h(DfOpsError, { title: '读取资产失败', error: state.error, onRetry: state.reload })
          : rows.length
            ? h('div', { className: 'df-tablewrap' },
              h(DfTable, {
                rows: rows,
                rowKey: function (r) { return r.id },
                selectedKey: selId,
                onRow: function (r) {
                  setSelId(r.id)
                  if (props.onInspect) props.onInspect(dfAssetDrawer(r, eng, state.reload))
                },
                columns: [
                  { key: 'ip', title: '资产', width: '24%', sortable: true, render: function (r) { return h(DfAssetCell, { asset: r }) } },
                  {
                    key: 'coverage', title: '覆盖', width: 76,
                    sortValue: function (r) { return Number(r.coverage_done) || 0 },
                    render: function (r) {
                      return h(DfCoverageChip, { done: r.coverage_done, total: r.coverage_total, missing: r.coverage_missing })
                    },
                  },
                  {
                    key: 'test_status', title: '侦察', width: 92,
                    sortValue: function (r) { return DF_TEST_LABEL[r.test_status] || '未侦察' },
                    render: function (r) { return h(DfTestChip, { status: r.test_status }) },
                  },
                  {
                    key: 'priority', title: '优先级', width: 78,
                    render: function (r) {
                      if (!r.priority) return h('span', { className: 'df-ri-side' }, '—')
                      const kind = DF_PRIORITY_KIND[String(r.priority).toLowerCase()] || 'line'
                      return h(DfChip, { kind: kind }, dfPriorityLabel(r.priority))
                    },
                  },
                  { key: 'ports', title: '端口', render: function (r) { return h(DfPortPills, { ports: r.ports }) } },
                  {
                    key: 'scope', title: '范围', width: 66,
                    render: function (r) { return h(DfChip, { kind: r.scope === 'external' ? 'warn' : 'line' }, dfScopeLabel(r.scope)) },
                  },
                  {
                    key: 'discovered_at', title: '发现', width: 92, align: 'right',
                    sortValue: function (r) { return r.discovered_at || r.first_seen || '' },
                    render: function (r) { return dfAgo(r.discovered_at || r.first_seen) },
                  },
                ],
              }))
            : state.loading
              ? h(DfSkeleton, { lines: 6 })
              : h(DfEmpty, {
                icon: 'server', title: '没有匹配的资产',
                hint: q || st ? '换个关键词或清除筛选试试。' : '侦察结果还没有入库。',
              })))
}

function DfAssetTestBox(props) {
  const [status, setStatus] = useState(props.a.test_status || 'untested')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  function save() {
    if (busy) return
    setBusy(true)
    dfApi('assetTest', {
      engagement: props.eng, asset_id: props.a.id,
      status: status, test: String(note || '').trim(), updated_by: 'human',
    }).then(function (r) {
      setBusy(false)
      if (!r || r.ok === false) { dfToast((r && r.error) || '保存失败', 'err', 4200); return }
      dfBust()
      dfToast('已记录：' + (DF_TEST_LABEL[status] || status), 'ok', 1800)
      setNote('')
      if (props.onDone) props.onDone()
    }, function (e) {
      setBusy(false)
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  return h('section', { className: 'df-detail-sec' },
    h('div', { className: 'df-detail-hd' },
      h('h4', null, '人工记录'),
      h(DfTestChip, { status: status })),
    h('div', { className: 'df-hint' }, '资产级侦察/测试记录，AI 评估资产时会读取；八类覆盖以矩阵为准，不在这里代替。'),
    h(DfSeg, {
      value: status,
      items: [['untested', '未侦察'], ['tested', '侦察完成'], ['blocked', '受阻'], ['no_surface', '无攻击面'], ['abandoned', '放弃']],
      onChange: function (v) { setStatus(v) },
    }),
    h('textarea', {
      className: 'df-area', rows: 1, value: note,
      placeholder: '一句话结论：测了什么、结果如何（可空）',
      onChange: function (e) { setNote(e.target.value) },
      /* 和漏洞复核框一致：.df-area 默认 120px 太高，这里压到 60。 */
      style: { width: '100%', marginTop: 8, minHeight: 60, height: 60 },
    }),
    h('div', { style: { marginTop: 8 } },
      h(DfBtn, { size: 'sm', kind: 'primary', icon: 'check', disabled: busy, onClick: save }, busy ? '保存中…' : '保存记录')))
}

function dfAssetDrawer(a, eng, onDone) {
  const ports = Array.isArray(a.ports) ? a.ports : []
  const names = Array.isArray(a.names) ? a.names : []
  /* 同一指纹常挂在多个端口上（80/443 同为 nginx），抽屉里合并展示，避免重复 chip。 */
  const seenFp = {}
  const fps = (Array.isArray(a.fingerprints) ? a.fingerprints : []).filter(function (f) {
    const key = [f.category, f.vendor, f.product, f.version].filter(Boolean).join('|')
    if (key === '' || seenFp[key]) return false
    seenFp[key] = true
    return true
  })
  return {
    mode: 'page',
    title: a.ip,
    sub: a.primary_name || dfScopeLabel(a.scope) + '资产',
    rows: [
      ['IP', a.ip],
      ['主域名', a.primary_name],
      ['范围', dfScopeLabel(a.scope)],
      ['状态', DF_ASSET_STATE[a.state] || dfDash(a.state)],
      ['覆盖', (a.coverage_done || 0) + '/' + (a.coverage_total || 8) + (a.coverage_missing && a.coverage_missing.length ? '（缺：' + a.coverage_missing.join('、') + '）' : '')],
      ['侦察状态', DF_TEST_LABEL[a.test_status] || a.test_status],
      ['优先级', a.priority ? dfPriorityLabel(a.priority) : ''],
      ['开放端口', (a.open_port_count || ports.length) + ' 个'],
      ['发现时间', dfTime(a.discovered_at || a.first_seen)],
      ['最近活动', dfTime(a.last_seen)],
      ['潜在成果', a.potential],
      ['评估理由', a.assess_reason],
      ['测试备注', a.test_notes],
    ],
    node: h('div', { className: 'df-detail' },
      h('div', { style: { display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' } },
        h(DfBtn, {
          size: 'sm', kind: 'ghost', icon: 'spark',
          onClick: function () {
            const open = ports.filter(function (p) { return p.state === 'open' }).slice(0, 12)
            const portText = open.length ? open.map(function (p) { return p.port + '/' + (p.proto || 'tcp') }).join('、') : '暂无开放端口记录'
            dfDraftToComposer([
              '看一下这个资产（id=' + a.id + '）：' + a.ip + (a.primary_name ? '（' + a.primary_name + '）' : ''),
              dfEngagementLine(eng),
              '范围：' + dfScopeLabel(a.scope) + ' · 侦察状态：' + (DF_TEST_LABEL[a.test_status] || a.test_status || '未侦察')
                + ' · 覆盖：' + (a.coverage_done || 0) + '/' + (a.coverage_total || 8)
                + (a.coverage_missing && a.coverage_missing.length ? '（缺：' + a.coverage_missing.join('、') + '）' : ''),
              '开放端口：' + portText,
              '先判断优先测试哪个攻击面，必要时继续。',
            ].filter(Boolean).join('\n'), '已把资产放进输入框')
          },
        }, '请 AI 评估')),
      eng ? h(DfAssetTestBox, { eng: eng, a: a, onDone: onDone }) : null,
      names.length
        ? h('section', { className: 'df-detail-sec' },
          h('h4', null, '域名 / 主机名'),
          h('div', { className: 'df-chips' }, names.map(function (n, i) {
            return h(DfChip, { key: i, kind: 'line' }, n.name)
          })))
        : null,
      ports.length
        ? h('section', { className: 'df-detail-sec' },
          h('h4', null, '端口与服务'),
          h('div', { className: 'df-tablewrap df-tablewrap--flat' },
            h('table', { className: 'df-table df-table--compact' },
              h('thead', null, h('tr', null,
                h('th', null, '端口'), h('th', null, '服务'), h('th', null, '产品'), h('th', null, '来源'))),
              h('tbody', null, ports.map(function (p, i) {
                return h('tr', { key: i },
                  h('td', { className: 'df-mono' }, String(p.port) + '/' + (p.proto || 'tcp')),
                  h('td', null, dfDash(p.service)),
                  h('td', null, [p.product, p.version].filter(Boolean).join(' ') || '—'),
                  h('td', null, p.provenance === 'passive' ? '被动' : '主动'))
              })))))
        : null,
      fps.length
        ? h('section', { className: 'df-detail-sec' },
          h('h4', null, '指纹'),
          h('div', { className: 'df-chips' }, fps.map(function (f, i) {
            return h(DfChip, { key: i, kind: 'info' }, [f.vendor, f.product, f.version].filter(Boolean).join(' '))
          })))
        : null)
  }
}

/* ---------------------------------------------------------------- 漏洞 */

/* 人工复核：AI 只写 candidate / exploited，确认与误报由人做，理由落库。 */
function DfReviewBox(props) {
  const v = props.v
  const [note, setNote] = useState(v.review_note || '')
  const [busy, setBusy] = useState('')
  const pending = v.status === 'candidate' || v.status === 'exploited'

  function submit(verdict) {
    if (busy) return
    const text = String(note || '').trim()
    if (verdict === 'false-positive' && !text) { dfToast('标记误报需填写理由', 'err', 3000); return }
    setBusy(verdict)
    dfApi('reviewVuln', { engagement: props.eng, id: v.id, verdict: verdict, note: text, by: 'human' }).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '复核失败', 'err', 4200); return }
      dfBust()
      dfToast('已复核：' + (DF_VULN_STATUS[verdict] || verdict), 'ok', 1800)
      if (props.onDone) props.onDone(Object.assign({}, v, {
        status: verdict, review_note: text, reviewed_at: r.reviewed_at, reviewed_by: r.reviewed_by,
      }))
    })
  }

  return h('section', { className: 'df-detail-sec' },
    h('div', { className: 'df-detail-hd' },
      h('h4', null, '人工复核'),
      pending ? h(DfChip, { kind: 'warn' }, '待复核') : h(DfChip, { kind: 'ok' }, '已复核')),
    h('div', { className: 'df-hint' },
      pending
        ? '确认后才会进入报告；标记误报需填写理由。'
        : (v.reviewed_at
          ? '已由 ' + (v.reviewed_by || 'human') + ' 于 ' + dfTime(v.reviewed_at) + ' 复核。'
          : '缺少复核记录（旧数据），再点「确认成立」补全。')),
    h('textarea', {
      className: 'df-area', rows: 1, value: note,
      placeholder: '复核理由：判定成立或不成立的原因（标记误报时必填）',
      onChange: function (e) { setNote(e.target.value) },
      /* .df-area 默认 min-height 120px，这里单独压到 60：复核理由通常一两句话。 */
      style: { width: '100%', marginTop: 6, minHeight: 60, height: 60 },
    }),
    h('div', { style: { marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' } },
      h(DfBtn, { size: 'sm', kind: 'primary', icon: 'check', disabled: !!busy, onClick: function () { submit('confirmed') } }, busy === 'confirmed' ? '确认中…' : '确认成立'),
      h(DfBtn, { size: 'sm', kind: 'danger', icon: 'close', disabled: !!busy, onClick: function () { submit('false-positive') } }, busy === 'false-positive' ? '提交中…' : '标记误报'),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'check', disabled: !!busy, onClick: function () { submit('fixed') } }, '已修复'),
      pending ? null : h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', disabled: !!busy, onClick: function () { submit('candidate') } }, '退回候选')))
}

/* 人手工记一条发现：默认 candidate，仍走人工复核。 */
function DfManualVuln(props) {
  const [title, setTitle] = useState('')
  const [severity, setSeverity] = useState('medium')
  const [target, setTarget] = useState('')
  const [evidence, setEvidence] = useState('')
  const [busy, setBusy] = useState(false)
  const ok = !!title.trim() && !!evidence.trim()

  function save() {
    if (busy || !ok) return
    setBusy(true)
    dfApi('addVuln', {
      engagement: props.eng,
      title: title.trim(),
      severity: severity,
      target: target.trim(),
      evidence: evidence.trim(),
      source: 'manual',
      status: 'candidate',
      found_by_agent: 'human',
      confidence: 0.8,
    }).then(function (r) {
      setBusy(false)
      if (!r || r.ok === false) { dfToast((r && r.error) || '保存失败', 'err', 4200); return }
      dfBust()
      dfToast('已记录，状态为待复核', 'ok', 2200)
      if (props.onDone) props.onDone()
    }, function (e) {
      setBusy(false)
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  return h('div', { className: 'df-detail' },
    h('div', { className: 'df-note' }, '默认记为「候选」，人工复核后才进报告。'),
    h(DfField, { label: '标题' },
      h('input', { className: 'df-input', value: title, autoFocus: true, placeholder: '例如：后台管理弱口令', onChange: function (e) { setTitle(e.target.value) } })),
    h(DfField, { label: '严重度' },
      h('select', { className: 'df-select', value: severity, onChange: function (e) { setSeverity(e.target.value) } },
        ['critical', 'high', 'medium', 'low', 'info'].map(function (k) {
          return h('option', { key: k, value: k }, (DF_SEV[k] || DF_SEV.info).label)
        }))),
    h(DfField, { label: '目标' },
      h('input', { className: 'df-input', value: target, placeholder: 'https://host/path 或 ip:port', onChange: function (e) { setTarget(e.target.value) } })),
    h(DfField, { label: '证据（必填）' },
      h('textarea', { className: 'df-area', rows: 4, value: evidence, placeholder: '请求/响应、命令回显、截图路径…', onChange: function (e) { setEvidence(e.target.value) } })),
    h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
      h(DfBtn, { size: 'sm', kind: 'primary', icon: 'check', disabled: busy || !ok, onClick: save }, busy ? '保存中…' : '保存为候选'),
      h('span', { className: 'df-hint' }, ok ? '' : '标题和证据必填')))
}

/* ---------------------------------------------------------------- 复现报文 */

/** 状态码 → 颜色档位（沿用 chip 的 ok/info/warn/err）。 */
function dfStatusKind(status) {
  const n = Number(status)
  if (!isFinite(n)) return 'line'
  if (n >= 500) return 'err'
  if (n >= 400) return 'warn'
  if (n >= 300) return 'info'
  if (n >= 200) return 'ok'
  return 'line'
}

/** 原始报文按行上色：请求行/状态行加粗、头灰一点、正文原样。 */
function dfHttpLineSpans(text) {
  return String(text || '').replace(/\r/g, '').split('\n').map(function (line, i) {
    let cls = ''
    if (i === 0) {
      if (/^HTTP\/\d/.test(line)) cls = 'df-htp-status'
      else if (/^[A-Z][A-Z0-9-]*\s+\S+/.test(line)) cls = 'df-htp-start'
    }
    if (!cls && /^[A-Za-z0-9_.-]+:/.test(line)) cls = 'df-htp-head'
    return h('span', { key: i, className: cls || undefined }, line + '\n')
  })
}

/**
 * 一张 Burp 风格的报文卡：抬头是方法 + 路径 + 状态码，下面左右两栏
 * Request / Response，内容就是可复制的原始报文。
 */
function DfHttpPacket(props) {
  const p = props.p || {}
  const request = String(p.request || '')
  const response = String(p.response || '')
  const rawStatus = p.status
  const statusNumber = Number(rawStatus)
  const status = rawStatus === null || rawStatus === undefined || String(rawStatus).trim() === ''
    || !isFinite(statusNumber) ? null : statusNumber
  const statusText = status === null ? '' : (httpStatusText(status) || '')
  const path = p.path || dfPathOf(p.url) || p.url || '/'
  return h('div', { className: 'df-pkt' },
    h('div', { className: 'df-pkt-hd' },
      props.index ? h('span', { className: 'df-pkt-i' }, '#' + props.index) : null,
      h('b', { className: 'df-pkt-m' }, p.method || 'GET'),
      h('span', { className: 'df-pkt-u', title: p.url || path }, path),
      status !== null
        ? h('span', { className: 'df-pkt-st df-pkt-st--' + dfStatusKind(status) },
          String(status) + (statusText ? ' ' + statusText : ''))
        : null,
      p.label ? h('span', { className: 'df-pkt-tag', title: p.label }, dfShort(p.label, 42)) : null,
      h('span', { className: 'dfx-spacer' }),
      h(DfCopyBtn, { text: httpPacketText(p), label: '复制报文', toast: '报文已复制' })),
    h('div', { className: 'df-pkt-grid' + (response ? '' : ' df-pkt-grid--one') },
      h('div', { className: 'df-pkt-col' },
        h('div', { className: 'df-pkt-cap' }, 'Request'),
        h('pre', { className: 'df-pkt-raw' }, dfHttpLineSpans(request || '（没有请求）'))),
      response
        ? h('div', { className: 'df-pkt-col' },
          h('div', { className: 'df-pkt-cap' }, 'Response'),
          h('pre', { className: 'df-pkt-raw' }, dfHttpLineSpans(response)))
        : null))
}

/**
 * 证据区：能整理成报文就按 Burp 的样子显示，整理不出来就退回原文。
 * 原文始终留在「证据原文」折叠里，方便核对整理时有没有丢东西。
 */
function DfEvidence(props) {
  const text = String(props.text || '')
  const packets = props.skipPackets === true ? [] : parseHttpPackets(text, { base: props.target || '' })
  const copyText = packets.length
    ? packets.map(function (p) { return httpPacketText(p) }).join('\n\n')
    : text
  return h('section', { className: 'df-detail-sec' },
    h('div', { className: 'df-detail-hd' },
      h('h4', null, packets.length ? '复现报文' : '证据原文'),
      packets.length ? h(DfChip, { kind: 'info' }, packets.length + ' 条 · Burp 格式') : null,
      h(DfCopyBtn, {
        text: copyText,
        label: packets.length ? '复制报文' : '复制',
        toast: packets.length ? '报文已复制' : '证据已复制',
      })),
    packets.length
      ? h('div', { className: 'df-pkt-list' },
        packets.map(function (p, i) {
          return h(DfHttpPacket, { key: i, p: p, index: i + 1 })
        }),
        h('details', { className: 'df-evi-raw' },
          h('summary', null, '证据原文（排版前）'),
          h('pre', { className: 'df-evi' }, text)))
      : h('pre', { className: 'df-evi' }, text))
}

function DfVulns(props) {
  const eng = props.eng
  const [sev, setSev] = useState('')
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')

  const state = dfUseAsync(function () {
    return dfApi('vulns', {
      engagement: eng, limit: 1000,
      severity: sev || undefined,
      status: status || undefined,
      q: q.trim() || undefined,
    }).then(function (r) {
      if (r && r.ok === false) throw new Error(r.error || '读取漏洞失败')
      return r || {}
    })
  }, [eng, props.tick, sev, status, q])

  const rows = (state.data && state.data.items) || []
  const stats = (state.data && state.data.stats) || {}
  const bySev = stats.bySeverity || {}
  const byStatus = stats.byStatus || {}

  function openManual() {
    if (!props.onInspect) return
    props.onInspect({
      title: '手工记录漏洞',
      sub: '人工补记 · 默认待复核',
      node: h(DfManualVuln, {
        eng: eng,
        onDone: function () {
          state.reload()
          if (props.onCloseDrawer) props.onCloseDrawer()
        },
      }),
    })
  }

  function drawerFor(v) {
    return {
      /* 漏洞详情走整页下钻（像微信/钉钉点进一条详情），不再挤右侧抽屉。 */
      mode: 'page',
      title: v.title,
      sub: (DF_SEV[String(v.severity || '').toLowerCase()] || DF_SEV.info).label + ' · ' + (DF_VULN_STATUS[v.status] || dfDash(v.status)),
      rows: [
        ['严重度', (DF_SEV[String(v.severity || '').toLowerCase()] || DF_SEV.info).label],
        ['状态', DF_VULN_STATUS[v.status] || v.status],
        ['资产', v.asset_ip || dfHostName(v.target)],
        ['目标', v.target || v.asset_ip],
        ['CVE', v.cve || '无'],
        ['置信度', dfConfidence(v)],
        ['来源', dfVulnSource(v.source)],
        ['发现者', v.found_by_agent || v.agent || '未记录'],
        ['发现时间', dfTime(v.found_at)],
        ['产出', v.gained || v.impact],
      ],
      node: h('div', { className: 'df-detail' },
        h('div', { style: { display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' } },
          h(DfBtn, {
            size: 'sm', kind: 'ghost', icon: 'spark',
            onClick: function () {
              dfDraftToComposer([
                '复核这条漏洞（id=' + v.id + '）：' + (v.title || '未命名'),
                '目标：' + (v.target || v.asset_ip || '') + ' · 严重度：' + (DF_SEV[String(v.severity || '').toLowerCase()] || DF_SEV.info).label + ' · 状态：' + (DF_VULN_STATUS[v.status] || v.status),
                dfEngagementLine(eng),
                '证据：' + (String(v.evidence || '').trim() ? dfShort(v.evidence, 280) : '（还没写证据）'),
                '请复现一次：可复现则补充证据；不可复现请说明原因，等待人工标记误报。',
              ].filter(Boolean).join('\n'), '已把漏洞放进输入框')
            },
          }, '让 AI 复核'),
          h(DfBtn, {
            size: 'sm', kind: 'ghost', icon: 'terminal',
            onClick: function () {
              dfDraftToComposer([
                '为这条漏洞生成可直接复现的命令（id=' + v.id + '）：' + (v.title || '未命名'),
                '目标：' + (v.target || v.asset_ip || '') + ' · 类型线索：' + (v.cve || '无 CVE') + ' · 严重度：' + (DF_SEV[String(v.severity || '').toLowerCase()] || DF_SEV.info).label,
                dfEngagementLine(eng),
                '证据：' + (String(v.evidence || '').trim() ? dfShort(v.evidence, 240) : '（还没写证据）'),
                '要求：给 curl / sqlmap / 对应工具的命令行，标注每个参数含义和预期回显；不要执行，我来确认。',
              ].filter(Boolean).join('\n'), '已让 AI 生成复现命令')
            },
          }, '复现命令')),
        h(DfReviewBox, {
          eng: eng, v: v,
          onDone: function (next) {
            state.reload()
            props.onInspect && props.onInspect(drawerFor(next))
          },
        }),
        v.evidence
          ? h(DfEvidence, {
            text: String(v.evidence),
            target: v.target || '',
            skipPackets: Array.isArray(v.http_evidence) && v.http_evidence.length > 0,
          })
          : h('div', { className: 'df-note' }, '先补证据，报告才有内容。'),
        Array.isArray(v.http_evidence) && v.http_evidence.length
          ? h('section', { className: 'df-detail-sec' },
            h('div', { className: 'df-detail-hd' },
              h('h4', null, 'HTTP 证据'),
              h(DfChip, { kind: 'info' }, v.http_evidence.length + ' 条 · Burp 格式')),
            h('div', { className: 'df-pkt-list' }, v.http_evidence.map(function (e, i) {
              return h(DfHttpPacket, {
                key: i,
                index: v.http_evidence.length > 1 ? i + 1 : 0,
                p: {
                  method: e.method || 'GET',
                  url: e.url || '',
                  path: dfPathOf(e.url) || e.url || '/',
                  status: e.status,
                  request: e.request || '',
                  response: e.response || '',
                  label: e.label || e.note || '',
                },
              })
            })))
          : null,
        h(DfShots, { eng: eng, vulnId: v.id, assetId: v.asset_id, target: v.target }))
    }
  }

  const sevTiles = [
    { key: '', cls: 'all', label: '全部', n: stats.total || 0 },
    { key: 'critical', cls: 'critical', label: '严重', n: bySev.critical || 0 },
    { key: 'high', cls: 'high', label: '高危', n: bySev.high || 0 },
    { key: 'medium', cls: 'medium', label: '中危', n: bySev.medium || 0 },
    { key: 'low', cls: 'low', label: '低危', n: bySev.low || 0 },
  ]
  const missingEvidence = Math.max(0, (stats.total || 0) - (stats.withEvidence || 0))

  return h('div', { className: 'df-ops' },
    h('div', { className: 'df-opsbar' },
      h('span', { className: 'df-ops-title' }, '漏洞成果'),
      h('span', { className: 'df-ops-meta' }, '按严重度排序'),
      h('span', { className: 'df-spacer' }),
      h(DfSearch, {
        value: q, placeholder: '搜索标题 / CVE / 目标 / 证据',
        onChange: function (v) { setQ(v) }, style: { width: 230 },
      }),
      h(DfSeg, {
        value: status,
        items: [['', '任意状态'], ['pending', '待复核'], ['candidate', '候选'], ['confirmed', '已确认'], ['exploited', '已利用'], ['false-positive', '误报'], ['fixed', '已修复']],
        onChange: function (v) { setStatus(v) },
      }),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'plus', onClick: openManual }, '手工记录'),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', onClick: state.reload }, '刷新')),

    /* 四个等级各自成块：数字 + 颜色，点一下就筛。比 KPI 更能说明「轻重」。 */
    h('div', { className: 'df-sevbar' }, sevTiles.map(function (t) {
      return h('button', {
        key: t.cls, type: 'button',
        className: 'df-sevbtn df-sevbtn--' + t.cls + (sev === t.key ? ' on' : ''),
        onClick: function () { setSev(t.key) },
        title: t.key === '' ? '显示全部漏洞' : '只看' + t.label,
        'aria-pressed': sev === t.key,
      },
        h('span', { className: 'df-sb-l' }, h('i'), t.label),
        h('span', { className: 'df-sb-v' }, dfNum(t.n)),
        sev === t.key ? h('span', { className: 'df-sb-on' }, '✓') : null)
    })),

    h(DfCard, {
      title: '漏洞清单', icon: 'bug',
      sub: '待复核 ' + dfNum(stats.pendingReview || 0)
        + ' · 已确认 ' + dfNum(byStatus.confirmed || 0)
        + ' · 已利用 ' + dfNum(byStatus.exploited || 0)
        + ' · 缺证据 ' + dfNum(missingEvidence),
      actions: q || sev || status
        ? h(DfBtn, {
          size: 'sm', kind: 'ghost', icon: 'close',
          onClick: function () { setQ(''); setSev(''); setStatus('') },
        }, '清除筛选')
        : null,
    },
      state.error
        ? h(DfOpsError, { title: '读取漏洞失败', error: state.error, onRetry: state.reload })
        : rows.length
          ? h('div', { className: 'df-vlist' }, rows.map(function (v) {
            const meta = dfSevMeta(v.severity)
            const hasEvidence = String(v.evidence || '').trim() !== ''
            return h('button', {
              key: v.id, type: 'button',
              className: 'df-vrow df-vrow--' + meta.cls,
              onClick: function () { props.onInspect && props.onInspect(drawerFor(v)) },
            },
              h('span', { className: 'df-vrow-rail' }),
              h('span', { className: 'df-vrow-main' },
                h('span', { className: 'df-vrow-hd' },
                  h(DfSevBadge, { severity: v.severity }),
                  h('span', { className: 'df-vrow-t' }, v.title || '（未填标题）')),
                h('span', { className: 'df-vrow-m' },
                  h('span', { className: 'df-vrow-ip' }, dfDash(v.asset_ip || dfHostName(v.target))),
                  h('span', { className: 'df-vrow-sep' }, '·'),
                  h(DfVulnStatusChip, { status: v.status }),
                  v.status === 'candidate' || v.status === 'exploited'
                    ? h(DfChip, { kind: 'warn' }, '待复核') : null,
                  v.cve ? h(DfChip, { kind: 'info' }, v.cve) : null,
                  hasEvidence
                    ? h(DfChip, { kind: 'ok' }, '有证据')
                    : h(DfChip, { kind: 'err' }, '缺证据'),
                  v.target && v.target !== v.asset_ip
                    ? h('span', { className: 'df-vrow-url', title: v.target }, dfShort(v.target, 44))
                    : null)),
              h('span', { className: 'df-vrow-right' },
                h('span', { className: 'df-vrow-ago' }, dfAgo(v.found_at)),
                h('span', { className: 'df-vrow-go' }, '›')))
          }))
          : state.loading
            ? h(DfSkeleton, { lines: 6 })
            : h(DfEmpty, {
              icon: 'bug', title: '没有匹配的漏洞',
              hint: q || sev || status ? '换个条件试试。' : '漏洞发现后会在这里按严重度排队。',
            })))
}

/* ---------------------------------------------------------------- 工具 */

const DF_TOOL_STATUS = {
  '': ['未标注', 'line'],
  available: ['可用', 'ok'],
  deprecated: ['不建议', 'warn'],
  blocked: ['建议停用', 'err'],
}

const DF_TOOL_SOURCE = {
  config: '手动指定',
  toolkit: '工具箱',
  binDir: '附加目录',
  path: '系统 PATH',
  usage: '使用记录',
  catalog: '内置清单',
  toolbox: '工具箱发现',
  default: '插件默认目录',
  user: '用户指定目录',
  model: '模型安装',
  manual: '手动登记',
  hidden: '已移除',
}

/** 清单行是否真的有可执行文件。 */
function dfToolReady(t) {
  const a = t && t.avail
  if (t && t.path && t.missing !== true) return true
  if (!a) return false
  if (a.exists === false) return false
  return !!a.path
}

/** 默认“已登记”：模型 open/learn/use/run 过、人标注/编辑过，或确实调用过。
    单纯扫描到目录不算登记；否则同步一次工具目录就会把整库噪音摊到默认列表。 */
function dfToolPrimary(t, mode) {
  if (!t) return false
  if (t.uses > 0 || t.recipe || t.purpose || t.status) return true
  if (Array.isArray(t.tags) && t.tags.length > 0) return true
  return (t.registered === true)
}

function DfToolBox(props) {
  const t = props.t
  const [note, setNote] = useState(t.note || '')
  const [busy, setBusy] = useState('')
  const [purpose, setPurpose] = useState(t.purpose || '')
  const [tags, setTags] = useState(Array.isArray(t.tags) ? t.tags.join(', ') : '')
  const [recipe, setRecipe] = useState((t.recipe && t.recipe.command) || t.command || '')
  const [recipeNote, setRecipeNote] = useState((t.recipe && t.recipe.note) || '')
  const [metaBusy, setMetaBusy] = useState(false)
  /* 路径与这条工具的身份：内置清单项用 id，扫出来的用 key。 */
  const toolId = (t.avail && t.avail.id) ? t.avail.id : t.key
  const initialPath = t.path || (t.avail && (t.avail.path || t.avail.configuredPath)) || ''
  const [toolPath, setToolPath] = useState(initialPath)
  const [pathBusy, setPathBusy] = useState(false)
  const [forgetArmed, setForgetArmed] = useState(false)

  useEffect(function () {
    setPurpose(t.purpose || '')
    setTags(Array.isArray(t.tags) ? t.tags.join(', ') : '')
    setRecipe((t.recipe && t.recipe.command) || t.command || '')
    setRecipeNote((t.recipe && t.recipe.note) || '')
    setNote(t.note || '')
  }, [t.name, t.purpose, t.tags, t.recipe, t.command, t.note])

  useEffect(function () { setToolPath(initialPath) }, [t.name, initialPath])

  function save(next) {
    if (busy) return
    setBusy(next || 'clear')
    dfApi('toolSet', {
      engagement: props.eng, mode: props.mode || 'redteam',
      name: t.name, status: next, note: String(note || '').trim(), by: 'human',
    }).then(function (r) {
      setBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '保存失败', 'err', 4200); return }
      dfBust()
      dfToast('已保存标注', 'ok', 1600)
      if (props.onDone) props.onDone(r)
    })
  }

  function saveMeta() {
    if (metaBusy) return
    setMetaBusy(true)
    dfApi('toolboxMeta', {
      mode: props.mode || 'redteam', name: t.name,
      purpose: purpose,
      tags: tags,
      recipe: recipe,
      note: recipeNote,
    }, { ttl: 0 }).then(function (r) {
      setMetaBusy(false)
      if (!r || r.ok === false) { dfToast((r && r.error) || '保存工具卡片失败', 'err', 4200); return }
      dfBust()
      dfToast('已保存工具卡片', 'ok', 1600)
      if (props.onDone) props.onDone(r)
    }).catch(function (e) {
      setMetaBusy(false)
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  function savePath() {
    if (pathBusy) return
    const value = String(toolPath || '').trim()
    if (!value) { dfToast('填一个可执行文件的绝对路径', 'err', 3200); return }
    setPathBusy(true)
    dfApi('toolboxPath', { mode: props.mode || 'redteam', name: toolId, path: value }, { ttl: 0 })
      .then(function (r) {
        setPathBusy(false)
        if (!r || r.ok === false) { dfToast((r && r.error) || '保存路径失败', 'err', 4200); return }
        dfBust()
        dfToast('路径已保存', 'ok', 1800)
        if (props.onDone) props.onDone(Object.assign({}, r, { hidden: false }))
      }, function (e) {
        setPathBusy(false)
        dfToast(String((e && e.message) || e), 'err', 4200)
      })
  }

  function forget() {
    if (!forgetArmed) {
      setForgetArmed(true)
      window.setTimeout(function () { setForgetArmed(false) }, 5000)
      return
    }
    setForgetArmed(false)
    if (pathBusy) return
    setPathBusy(true)
    dfApi('toolboxForget', { mode: props.mode || 'redteam', name: toolId }, { ttl: 0 })
      .then(function (r) {
        setPathBusy(false)
        if (!r || r.ok === false) { dfToast((r && r.error) || '移除失败', 'err', 4200); return }
        dfBust()
        dfToast('已从工具页移除：' + t.name, 'ok', 2400)
        if (props.onClose) props.onClose()
      }, function (e) {
        setPathBusy(false)
        dfToast(String((e && e.message) || e), 'err', 4200)
      })
  }

  return h('div', null,
    h('section', { className: 'df-detail-sec' },
      h('h4', null, '可执行文件路径'),
      h('div', { className: 'df-hint' }, t.hidden
        ? '这条已移除；填一个有效路径并保存就会恢复。'
        : '保存后写进环境配置；文件必须存在。移除后可在「已移除」里填路径恢复。'),
      h('input', {
        className: 'df-input', value: toolPath, placeholder: '例如 C:\\tools\\nmap.exe',
        onChange: function (e) { setToolPath(e.target.value) },
        style: { width: '100%', marginTop: 6 },
      }),
      h('div', { style: { marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' } },
        h(DfBtn, {
          size: 'sm', kind: 'primary', icon: 'check',
          disabled: pathBusy, onClick: savePath,
        }, pathBusy ? '处理中…' : t.hidden ? '保存并恢复' : '保存路径'),
        t.hidden ? null : h(DfBtn, {
          size: 'sm', kind: 'danger', icon: 'close',
          disabled: pathBusy, onClick: forget,
        }, forgetArmed ? '确认移除' : '移除这条'))),
    h('section', { className: 'df-detail-sec' },
      h('h4', null, '工具卡片'),
      h('div', { className: 'df-hint' }, '用途、tags 和 recipe 会直接进入 AI 的 toolbox 检索。'),
      h('input', {
        className: 'df-input', value: purpose, placeholder: '用途，例如：内网端口扫描',
        onChange: function (e) { setPurpose(e.target.value) },
        style: { width: '100%', marginTop: 6 },
      }),
      h('input', {
        className: 'df-input', value: tags, placeholder: 'tags，用逗号分隔，例如：recon, port, scan',
        onChange: function (e) { setTags(e.target.value) },
        style: { width: '100%', marginTop: 6 },
      }),
      h('textarea', {
        className: 'df-area', rows: 3, value: recipe,
        placeholder: '常用命令，例如：nmap -sV -Pn -p- <target>；留空则清除',
        onChange: function (e) { setRecipe(e.target.value) },
        style: { width: '100%', marginTop: 6 },
      }),
      h('input', {
        className: 'df-input', value: recipeNote, placeholder: '命令备注（可选）',
        onChange: function (e) { setRecipeNote(e.target.value) },
        style: { width: '100%', marginTop: 6 },
      }),
      h('div', { style: { marginTop: 8 } },
        h(DfBtn, {
          size: 'sm', kind: 'primary', icon: 'check',
          disabled: metaBusy, onClick: saveMeta,
        }, metaBusy ? '保存中…' : '保存工具卡片'))),
    h('section', { className: 'df-detail-sec' },
      h('h4', null, '人工标注'),
    h('div', { className: 'df-hint' },
      '仅作 AI 选型参考，不拦截直接调用。'),
    h('textarea', {
      className: 'df-area', rows: 2, value: note,
      placeholder: '备注：为什么可用 / 为什么不建议（例如噪声大、易打崩设备）',
      onChange: function (e) { setNote(e.target.value) },
      style: { width: '100%', marginTop: 6 },
    }),
    h('div', { style: { marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' } },
      h(DfBtn, { size: 'sm', kind: 'primary', icon: 'check', disabled: !!busy, onClick: function () { save('available') } }, '可用'),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'close', disabled: !!busy, onClick: function () { save('deprecated') } }, '不建议'),
      h(DfBtn, { size: 'sm', kind: 'danger', icon: 'close', disabled: !!busy, onClick: function () { save('blocked') } }, '建议停用'),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', disabled: !!busy, onClick: function () { save('') } }, '清除标注'))))
}

/* 工具页的 tab 选择放在模块级：切页或写操作后组件重挂时，不要退回红队。 */
let dfToolsMode = 'redteam'

function DfTools(props) {
  const eng = props.eng
  const [mode, setModeState] = useState(dfToolsMode)
  function setMode(next) {
    dfToolsMode = next === 'crack' ? 'crack' : 'redteam'
    setModeState(dfToolsMode)
  }
  const [filter, setFilter] = useState('all')
  const [q, setQ] = useState('')
  const [showSystem, setShowSystem] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [visible, setVisible] = useState(120)
  const [rootInput, setRootInput] = useState('')
  const [rootBusy, setRootBusy] = useState('')
  const state = dfUseAsync(function () {
    if (mode === 'crack') {
      return dfApi('tools', { mode: 'crack' }).then(function (usage) {
        return { usage: usage || {}, cfg: {} }
      }).catch(function () {
        return { usage: { ok: false, items: [] }, cfg: {} }
      })
    }
    return Promise.all([
      dfApi('tools', { engagement: eng, mode: 'redteam' }).catch(function () { return { ok: false, items: [] } }),
      dfApi('platformConfigGet', {}, { ttl: 60000 }).catch(function () { return {} }),
    ]).then(function (pair) {
      return { usage: pair[0] || {}, cfg: pair[1] || {} }
    })
  }, [eng, props.tick, mode])

  useEffect(function () { setVisible(120) }, [q, filter, showAll, mode])

  const usageItems = (state.data && state.data.usage && state.data.usage.items) || []
  const usage = (state.data && state.data.usage) || {}
  const cfg = (state.data && state.data.cfg) || {}
  const rootsAll = Array.isArray(usage.toolbox_discovered_roots) ? usage.toolbox_discovered_roots : []
  const bothFailed = !state.loading && usage.ok === false && cfg.ok !== true
  /* 工具清单来自实际磁盘扫描 + 手动指定；不再用内置目录去列“应该装但没装”的工具。 */
  const inv = cfg.inventory
  const availItems = inv && Array.isArray(inv.items)
    ? inv.items.concat(Array.isArray(inv.catalog) ? inv.catalog : [])
    : ((cfg.tools && cfg.tools.items) || []).filter(function (a) { return !!a.path })

  /* 工具名归一：环境检查用 id，使用记录用命令名，两边对齐后才能合并。 */
  function toolKey(name) {
    return String(name || '').toLowerCase().replace(/\\/g, '/').split('/').pop().split(/\s+/)[0]
      .replace(/\.(exe|py|ps1|bat|cmd|sh|js|pl|rb)$/i, '')
  }

  const map = new Map()
  for (const a of availItems) {
    const key = toolKey(a.name || a.label || a.id)
    if (!key) continue
    map.set(key, {
      key: key, name: a.name || a.label || a.id, avail: a, uses: 0,
      status: '', note: '', source: 'avail',
      purpose: a.purpose || '', command: a.command || '', install: a.install || '',
      category: a.category || '', isSystem: a.system === true,
    })
  }
  for (const u of usageItems) {
    const key = toolKey(u.name)
    if (!key) continue
    const row = map.get(key) || { key: key, name: u.name, avail: null, uses: 0, status: '', note: '', source: 'usage' }
    row.uses = u.uses || 0
    row.last_seen = u.last_seen
    row.first_seen = u.first_seen
    row.status = u.status || ''
    row.note = u.note || ''
    row.updated_by = u.updated_by
    row.kind = u.kind
    row.usage = u
    map.set(key, row)
  }
  /* 已移除的条目保留恢复入口：默认不显示，只有「已移除」筛选里能看到。 */
  const hiddenItems = []
    .concat(inv && Array.isArray(inv.hidden) ? inv.hidden : [])
    .concat(Array.isArray(usage.hidden) ? usage.hidden : [])
  for (const h of hiddenItems) {
    const key = toolKey(h.key || h.name || h.id)
    if (!key || map.has(key)) continue
    map.set(key, {
      key: key, name: h.name || h.key || key,
      avail: Object.assign({}, h, { source: 'hidden', hidden: true, path: null, exists: false }),
      uses: 0, status: '', note: '', source: 'hidden', hidden: true,
      purpose: h.purpose || '', command: h.command || '', install: h.install || '',
      category: h.category || '', isSystem: false,
    })
  }
  let rows = Array.from(map.values())
  const SYS_KEYS = ['curl', 'wget', 'python', 'python3', 'powershell', 'pwsh', 'cmd', 'bash', 'sh',
    'nc', 'ncat', 'netcat', 'openssl', 'ssh', 'scp', 'socat', 'git', 'node', 'java',
    'go', 'gcc', 'g++', 'tar', '7z', 'zip', 'unzip', 'findstr', 'grep', 'awk', 'sed']
  rows.forEach(function (r) {
    if (r.isSystem === undefined) r.isSystem = SYS_KEYS.indexOf(r.key) >= 0
  })
  const countRows = rows.filter(function (r) { return !r.hidden })
  const hiddenCount = rows.length - countRows.length
  const readyCount = countRows.filter(function (r) { return dfToolReady(r) }).length
  const missingCount = countRows.filter(function (r) {
    return r.missing === true || (r.avail && r.avail.exists === false)
  }).length
  const usedCount = countRows.filter(function (r) { return r.uses > 0 }).length
  const blockedCount = countRows.filter(function (r) { return r.status === 'blocked' }).length
  const systemCount = countRows.filter(function (r) { return r.isSystem }).length
  const catalogCount = countRows.filter(function (r) { return r.avail && r.avail.source === 'catalog' }).length

  useEffect(function () {
    if (hiddenCount === 0 && filter === 'hidden') setFilter('all')
  }, [hiddenCount, filter])

  const query = q.trim().toLowerCase()
  const showSys = showSystem || query.length > 0
  const allCount = countRows.length
  const primaryCount = countRows.filter(function (r) { return dfToolPrimary(r, mode) }).length
  rows = rows.filter(function (r) {
    if (filter === 'hidden') {
      if (!r.hidden) return false
      if (!query) return true
      return (r.name + ' ' + (r.key || '')).toLowerCase().includes(query)
    }
    if (r.hidden) return false
    if (!showSys && r.isSystem) return false
    if (!showAll && !query && !dfToolPrimary(r, mode)) return false
    if (filter === 'missing' && !(r.missing === true || (r.avail && r.avail.exists === false))) return false
    if (filter === 'ready' && !dfToolReady(r)) return false
    if (filter === 'used' && !(r.uses > 0)) return false
    if (filter === 'marked' && !r.status) return false
    if (!query) return true
    return (r.name + ' ' + (r.key || '') + ' ' + (r.purpose || '') + ' ' + (r.note || '')).toLowerCase().includes(query)
  })
  rows.sort(function (a, b) {
    const rank = function (r) {
      if (r.status === 'blocked') return 0
      if (dfToolReady(r)) return 1
      if (r.uses > 0) return 2
      if (r.avail && r.avail.exists === false && r.avail.source !== 'catalog') return 3
      return 4
    }
    return rank(a) - rank(b) || (b.uses - a.uses) || a.name.localeCompare(b.name)
  })
  const totalFiltered = rows.length
  const shownRows = rows.slice(0, visible)
  const filterItems = [['all', '全部'], ['ready', '就绪'], ['missing', '未安装'], ['used', '用过'], ['marked', '有标注']]
  if (hiddenCount > 0) filterItems.push(['hidden', '已移除 ' + dfNum(hiddenCount)])

  function rescan() {
    /* 破解没有平台工具箱配置，重扫就是重新扫描破解 registry 的发现目录。 */
    if (mode === 'crack') {
      dfApi('toolboxSync', { mode: 'crack' }, { ttl: 0 }).then(function (r) {
        if (!r || r.ok === false) { dfToast((r && r.error) || '重扫失败', 'err', 4200); return }
        dfToast('已重新扫描破解工具：' + (r.count || 0) + ' 个'
          + (r.truncated ? '（达到扫描上限，列表已截断）' : ''), r.truncated ? 'warn' : 'ok', 3200)
        state.reload()
      }).catch(function (e) { dfToast(String((e && e.message) || e), 'err', 4200) })
      return
    }
    const dir = String(cfg.toolkitDir || (cfg.config && cfg.config.toolkitDir) || '').trim()
    if (!dir) { dfToast('先选择一个工具箱目录', 'err', 3200); return }
    dfApi('platformAssignToolkit', { dir: dir }).then(function (r) {
      if (!r || r.ok === false) { dfToast((r && r.error) || '重扫失败', 'err', 4200); return }
      dfToast('已重新扫描工具', 'ok', 2000)
      dfBust()
      state.reload()
    }).catch(function (e) { dfToast(String((e && e.message) || e), 'err', 4200) })
  }

  function syncToolbox() {
    dfApi('toolboxSync', { mode: mode }, { ttl: 0 }).then(function (r) {
      if (!r || r.ok === false) { dfToast((r && r.error) || '同步工具箱失败', 'err', 4200); return }
      dfToast('工具箱已同步：' + (r.count || 0) + ' 个工具'
        + (r.truncated ? '（达到扫描上限，列表已截断）' : ''), r.truncated ? 'warn' : 'ok', 3600)
      state.reload()
    }).catch(function (e) { dfToast(String((e && e.message) || e), 'err', 4200) })
  }

  function addToolRoot() {
    const dir = String(rootInput || '').trim()
    if (!dir) { dfToast('先填一个工具目录', 'err', 3200); return }
    if (rootBusy) return
    setRootBusy('add')
    dfApi('toolboxAddRoot', { dir: dir, mode: mode }, { ttl: 0 }).then(function (r) {
      setRootBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '添加目录失败', 'err', 4200); return }
      setRootInput('')
      dfToast('已添加并同步：' + (r.count || 0) + ' 个工具', 'ok', 2400)
      state.reload()
    }).catch(function (e) {
      setRootBusy('')
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  function removeToolRoot(dir, source) {
    if (rootBusy) return
    if (source === 'config') {
      const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm('移除「' + dir + '」后，该目录会从平台配置里删除；\n'
          + '这个目录对应的手动工具路径也会移除（文件本身不动，子目录里的其它根保留）。\n\n继续？')
        : true
      if (!ok) return
    }
    setRootBusy('remove:' + dir)
    dfApi('toolboxRemoveRoot', { dir: dir, mode: mode }, { ttl: 0 }).then(function (r) {
      setRootBusy('')
      if (!r || r.ok === false) { dfToast((r && r.error) || '移除目录失败', 'err', 4200); return }
      const removed = r.config && Array.isArray(r.config.removed_tools) ? r.config.removed_tools.length : 0
      dfToast('已移除并同步：' + (r.count || 0) + ' 个工具'
        + (removed ? '，同时移除 ' + removed + ' 条手动工具路径' : ''), 'ok', 3200)
      state.reload()
    }).catch(function (e) {
      setRootBusy('')
      dfToast(String((e && e.message) || e), 'err', 4200)
    })
  }

  function drawerFor(t) {
    const avail = t.avail || {}
    const ready = dfToolReady(t)
    const notInstalled = avail.source === 'catalog'
    const hidden = t.hidden === true
    return {
      title: t.name,
      sub: (hidden ? '已移除（填有效路径可恢复）' : ready ? '已就绪' : t.missing ? '已从发现目录消失' : notInstalled ? '未安装' : avail.exists === false ? '配置路径不存在' : '未登记可用性')
        + (t.purpose ? ' · ' + t.purpose : '')
        + ' · ' + (t.uses || 0) + ' 次',
      rows: [
        ['用途', t.purpose || ''],
        ['标签', Array.isArray(t.tags) ? t.tags.join(' · ') : ''],
        ['风险', t.risk || ''],
        ['可用性', ready ? '就绪' : t.missing ? '已从发现目录消失（重新同步或移除该目录）' : notInstalled ? '未安装（内置清单）' : (avail.source ? '不可用（' + (avail.note || '配置路径不存在') + '）' : '未在磁盘或使用记录里出现')],
        ['路径', t.path || avail.path || avail.configuredPath],
        ['发现方式', DF_TOOL_SOURCE[avail.source] || DF_TOOL_SOURCE[t.toolbox_source] || DF_TOOL_SOURCE[t.source] || ''],
        ['使用次数', String(t.uses || 0)],
        ['最近使用', dfAgo(t.last_seen || '')],
        ['首次登记', dfTime(t.first_seen)],
        ['当前标注', (DF_TOOL_STATUS[t.status || ''] || DF_TOOL_STATUS[''])[0]],
      ],
      node: h('div', { className: 'df-detail' },
        (t.recipe && t.recipe.command) || t.command
          ? h('section', { className: 'df-detail-sec' },
            h('div', { className: 'df-detail-hd' },
              h('h4', null, t.recipe && t.recipe.command ? '已固化用法' : '常用命令'),
              h(DfCopyBtn, { text: (t.recipe && t.recipe.command) || t.command, label: '复制', toast: '命令已复制' })),
            h('pre', { className: 'df-code' }, (t.recipe && t.recipe.command) || t.command),
            t.recipe && t.recipe.note ? h('div', { className: 'df-note' }, t.recipe.note) : null,
            h('div', { className: 'df-formfoot' },
              h(DfBtn, {
                size: 'sm', kind: 'ghost', icon: 'spark',
                onClick: function () {
                  dfDraftToComposer([
                    '用 ' + t.name + ' 执行：' + ((t.recipe && t.recipe.command) || t.command),
                    '目标：<填目标>',
                    dfEngagementLine(eng),
                    '执行前先确认目标在授权范围内；回显落库/留证。',
                  ].filter(Boolean).join('\n'), '已把命令放进输入框')
                },
              }, '让 AI 执行')))
          : null,
        t.install
          ? h('div', { className: 'df-note' }, '安装：' + t.install)
          : null,
        avail.exists === false && !notInstalled && !t.hidden
          ? h('div', { className: 'df-note df-note--warn' },
            '这条是你在环境里手动指定的路径，但文件不在了。改路径或清空这一项后点「重扫工具」。')
          : null,
        h(DfToolBox, {
          eng: eng, mode: mode, t: t,
          onClose: props.onCloseDrawer,
          onDone: function (next) {
            state.reload()
            props.onInspect && props.onInspect(drawerFor(Object.assign({}, t, next)))
          },
        }),
        t.note ? h('div', { className: 'df-note' }, t.note) : null),
    }
  }

  return h('div', { className: 'df-ops' },
    h('div', { className: 'df-opsbar' },
      h('span', { className: 'df-ops-title' }, '工具'),
      h(DfSeg, {
        value: mode,
        items: [['redteam', '红队'], ['crack', '破解']],
        onChange: function (v) { setMode(v) },
      }),
      h('span', { className: 'df-ops-meta' }, '就绪 ' + dfNum(readyCount)
        + ' · 用过 ' + dfNum(usedCount) + ' · 已登记 ' + dfNum(primaryCount)),
      h('span', { className: 'df-spacer' }),
      h(DfSearch, { value: q, placeholder: '搜索工具 / 用途', onChange: function (v) { setQ(v) }, style: { width: 200 } }),
      h(DfSeg, {
        value: filter,
        items: filterItems,
        onChange: function (v) { setFilter(v) },
      }),
      h(DfBtn, {
        size: 'sm', kind: 'ghost', icon: 'list',
        onClick: function () { setShowAll(function (v) { return !v }) },
      }, showAll ? '只看已登记' : '全部发现 ' + dfNum(allCount)),
      h(DfBtn, {
        size: 'sm', kind: 'ghost', icon: 'terminal',
        onClick: function () { setShowSystem(function (v) { return !v }) },
      }, showSystem ? '隐藏系统命令' : '系统命令 ' + dfNum(systemCount)),
      h(DfBtn, {
        size: 'sm', kind: 'ghost', icon: 'folder', onClick: rescan,
        disabled: mode === 'redteam'
          && !String(cfg.toolkitDir || (cfg.config && cfg.config.toolkitDir) || '').trim(),
      }, '重扫'),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', onClick: syncToolbox }, '同步工具箱'),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', onClick: state.reload }, '刷新')),

    h(DfCard, {
      title: '工具发现目录', icon: 'folder',
      sub: '只扫这些目录，不扫整条 PATH；插件默认目录固定，手动指定/用户目录可移除',
    },
      h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
        h('input', {
          className: 'df-input', value: rootInput,
          placeholder: '例如 C:\\tools\\redteam 或 ~/.dsh/tools',
          onChange: function (e) { setRootInput(e.target.value) },
          onKeyDown: function (e) { if (e.key === 'Enter') addToolRoot() },
          style: { flex: '1 1 320px', minWidth: 220 },
        }),
        h(DfBtn, {
          size: 'sm', kind: 'primary', icon: 'plus',
          disabled: !!rootBusy, onClick: addToolRoot,
        }, rootBusy === 'add' ? '添加中…' : '添加目录')),
      usage.toolbox_truncated
        ? h('div', { className: 'df-note df-note--warn', style: { marginTop: 8 } },
          '上次扫描达到 1200 个可执行文件上限，工具列表可能不完整；收窄发现目录后重新同步。')
        : null,
      rootsAll.length
        ? h('div', { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 } },
          rootsAll.map(function (r) {
            const src = DF_TOOL_SOURCE[r.source] || r.source || ''
            const removable = r.source === 'user' || r.source === 'config'
            return h('div', {
              key: r.path,
              style: {
                display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
                padding: '6px 8px', border: '1px solid var(--df-line, #2a2f3a)', borderRadius: 6,
              },
            },
              h('span', { className: 'df-mono', style: { flex: '1 1 320px', wordBreak: 'break-all' } }, r.path),
              src ? h(DfChip, { kind: 'line' }, src) : null,
              removable
                ? h(DfBtn, {
                  size: 'sm', kind: 'ghost', icon: 'close',
                  title: r.source === 'config' ? '从平台配置移除该目录（含该目录下已登记的工具路径）' : '从发现目录移除',
                  disabled: !!rootBusy, onClick: function () { removeToolRoot(r.path, r.source) },
                }, rootBusy === 'remove:' + r.path ? '移除中…' : '移除')
                : null)
          }))
        : h('div', { className: 'df-hint', style: { marginTop: 8 } },
          '还没有扫描记录。添加目录后会自动同步，也可以先点上方「同步工具箱」。')),

    h(DfCard, {
      title: '工具清单', icon: 'wrench',
      sub: '就绪 ' + dfNum(readyCount) + ' · 未安装 ' + dfNum(catalogCount) + ' · 用过 ' + dfNum(usedCount),
      actions: q || filter !== 'all'
        ? h(DfBtn, {
          size: 'sm', kind: 'ghost', icon: 'close',
          onClick: function () { setQ(''); setFilter('all') },
        }, '清除筛选')
        : null,
    },
      state.error || bothFailed
        ? h(DfOpsError, {
          title: '读取工具清单失败',
          error: state.error || usage.error || cfg.error || '工具接口与环境配置接口都不可用',
          onRetry: state.reload,
        })
        : rows.length
          ? h(react.Fragment, null,
            h('div', { className: 'df-tool-grid' }, shownRows.map(function (t) {
            const meta = DF_TOOL_STATUS[t.status || ''] || DF_TOOL_STATUS['']
            const ready = dfToolReady(t)
            const src = DF_TOOL_SOURCE[(t.avail || {}).source] || DF_TOOL_SOURCE[t.source] || ''
            const notInstalled = (t.avail || {}).source === 'catalog'
            return h('button', {
              key: t.key, type: 'button',
              className: 'df-vrow df-vrow--info',
              onClick: function () { props.onInspect && props.onInspect(drawerFor(t)) },
            },
              h('span', { className: 'df-vrow-rail' }),
              h('span', { className: 'df-vrow-main' },
                h('span', { className: 'df-vrow-hd' },
                  h('span', { className: 'df-vrow-t df-mono' }, t.name),
                  ready
                    ? h(DfChip, { kind: 'ok' }, '就绪')
                    : t.missing
                      ? h(DfChip, { kind: 'err' }, '已消失')
                      : notInstalled
                        ? h(DfChip, { kind: 'line' }, '未安装')
                        : t.avail
                          ? h(DfChip, { kind: 'err' }, '路径失效')
                          : h(DfChip, { kind: 'line' }, '仅使用记录'),
                  t.status ? h(DfChip, { kind: meta[1] }, meta[0]) : null,
                  t.isSystem ? h(DfChip, { kind: 'line' }, '系统命令') : null),
                h('span', { className: 'df-vrow-m' },
                  t.purpose
                    ? h('span', { className: 'df-vrow-url', title: t.purpose }, dfShort(t.purpose, 46))
                    : (src ? h('span', { className: 'df-vrow-ip' }, src) : null),
                  h('span', { className: 'df-vrow-sep' }, '·'),
                  h('span', { className: 'df-vrow-url' }, dfNum(t.uses) + ' 次'
                    + (t.uses ? ' · 最近 ' + dfAgo(t.last_seen || '') : ' · 还没用过')),
                  t.note ? h('span', { className: 'df-vrow-url', title: t.note }, dfShort(t.note, 28)) : null)),
              h('span', { className: 'df-vrow-right' },
                h('span', { className: 'df-vrow-go' }, '›')))
            })),
            totalFiltered > shownRows.length
              ? h('div', { style: { display: 'flex', justifyContent: 'center', marginTop: 12 } },
                h(DfBtn, {
                  size: 'sm', kind: 'ghost', icon: 'list',
                  onClick: function () { setVisible(function (v) { return v + 120 }) },
                }, '显示更多（剩余 ' + dfNum(totalFiltered - shownRows.length) + '）'))
              : null)
          : state.loading
            ? h(DfSkeleton, { lines: 6 })
            : h(DfEmpty, {
              icon: 'wrench', title: q || filter !== 'all' ? '没有匹配的工具' : '还没有登记工具',
              hint: q || filter !== 'all'
                ? '换个条件试试。'
                : '默认只显示模型登记或实际调用过的工具。已发现 ' + dfNum(allCount)
                  + ' 个，点上方「全部发现」查看；模型用 toolbox find 检索、open/run 后会出现在这里。',
            })))
}

/* ---------------------------------------------------------------- 攻击链 */

function DfChain(props) {
  const eng = props.eng
  const state = dfUseAsync(function () {
    return dfApi('chain', { engagement: eng, limit: 500 }).then(function (r) {
      if (r && r.ok === false) throw new Error(r.error || '读取攻击链失败')
      return r || {}
    })
  }, [eng, props.tick])

  const rows = (state.data && state.data.items) || []
  const stages = new Set()
  const assets = new Set()
  const vulns = new Set()
  rows.forEach(function (s) {
    if (s.stage_code) stages.add(s.stage_code)
    if (s.asset_ip) assets.add(s.asset_ip)
    if (s.vuln_id) vulns.add(s.vuln_id)
  })

  function drawerFor(s) {
    return {
      title: s.title,
      sub: '第 ' + s.seq + ' 步 · ' + (DF_STAGE_LABEL[s.stage_code] || s.stage_code || '其他'),
      rows: [
        ['阶段', DF_STAGE_LABEL[s.stage_code] || s.stage_code],
        ['序号', s.seq],
        ['工具', s.tool],
        ['结果', s.result],
        ['资产', s.asset_ip],
        ['漏洞', s.vuln_title],
        ['CVE', s.vuln_cve],
        ['执行者', s.recorded_by || s.agent],
        ['记录时间', dfTime(s.recorded_at, true)],
      ],
      node: s.detail
        ? h('section', { className: 'df-detail-sec' },
          h('h4', null, '详细记录'),
          h('pre', { className: 'df-evi' }, String(s.detail)))
        : null,
    }
  }

  return h('div', { className: 'df-ops' },
    /* 顶栏一行标题 + 一条横向数字带：跟漏洞页首屏同一种节奏，
       切页时不会从「一块大白卡」突然变成「一屏小格子」。 */
    h('div', { className: 'df-opsbar' },
      h('span', { className: 'df-ops-title' }, '攻击链'),
      h('span', { className: 'df-spacer' }),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', onClick: state.reload }, '刷新')),

    h('div', { className: 'df-statsbar' },
      h(DfStat, { label: '步骤', icon: 'route', value: dfNum(rows.length) }),
      h(DfStat, { label: '阶段', icon: 'layers', value: dfNum(stages.size) }),
      h(DfStat, { label: '涉及资产', icon: 'server', value: dfNum(assets.size) }),
      h(DfStat, { label: '关联漏洞', icon: 'bug', value: dfNum(vulns.size) })),

    h(DfCard, { title: '步骤', icon: 'route', sub: '' },
      state.error
        ? h(DfOpsError, { title: '读取攻击链失败', error: state.error, onRetry: state.reload })
        : rows.length
          ? h('div', { className: 'df-tl df-tl--pad' }, rows.map(function (s, i) {
            const stage = DF_STAGE_LABEL[s.stage_code] || s.stage_code || '其他'
            return h('div', {
              key: s.id || i,
              className: 'df-tl-item',
              onClick: function () { props.onInspect && props.onInspect(drawerFor(s)) },
            },
              h('div', { className: 'df-tl-h' },
                h('span', { className: 'df-seq' }, String(s.seq || i + 1)),
                h('span', null, s.title),
                s.vuln_severity ? h(DfSevBadge, { severity: s.vuln_severity }) : null,
                h('span', { className: 'df-tl-t' }, dfAgo(s.recorded_at))),
              h('div', { className: 'df-tl-d' },
                h(DfChip, { kind: 'line' }, stage),
                s.tool ? h('span', { className: 'df-chain-tool' }, s.tool) : null,
                s.asset_ip ? h('span', { className: 'df-mono' }, s.asset_ip) : null),
              s.result ? h('div', { className: 'df-tl-r' }, s.result) : null)
          }))
          : state.loading
            ? h(DfSkeleton, { lines: 8 })
            : h(DfEmpty, { icon: 'route', title: '还没有攻击步骤', hint: '按记录顺序显示。' })))
}

/* ---------------------------------------------------------------- 通道 */

function DfSessions(props) {
  const eng = props.eng
  const [tab, setTab] = useState('webshell')
  const state = dfUseAsync(function () {
    return Promise.all([
      dfApi('sessions', { engagement: eng }),
      dfApi('credentials', { engagement: eng, limit: 1000 }),
      dfApi('access', { engagement: eng, limit: 1000 }),
    ]).then(function (r) {
      const s = r[0] || {}
      if (s.ok === false) throw new Error(s.error || '读取通道失败')
      return {
        shells: s.webshells || [],
        tunnels: s.tunnels || [],
        totals: s.totals || {},
        creds: (r[1] && r[1].items) || [],
        access: (r[2] && r[2].items) || [],
      }
    })
  }, [eng, props.tick])

  const d = state.data || { shells: [], tunnels: [], creds: [], access: [], totals: {} }
  const t = d.totals || {}

  function shellDrawer(w) {
    return {
      mode: 'peek',
      title: w.url,
      sub: (w.shell_type || 'WebShell') + ' · ' + (DF_SHELL_STATUS[w.status] || dfDash(w.status)),
      rows: [
        ['URL', w.url],
        ['类型', w.shell_type],
        ['状态', DF_SHELL_STATUS[w.status] || w.status],
        ['密码', w.pass_key],
        ['权限', w.privilege],
        ['资产', w.asset_ip],
        ['最近检查', dfTime(w.last_check)],
        ['检查备注', w.check_note],
        ['备注', w.note],
      ],
      node: null,
    }
  }

  function tunnelDrawer(x) {
    return {
      mode: 'peek',
      title: x.listen || x.entry || x.reach || '隧道',
      sub: (x.entry_kind_label || x.entry_kind || '未声明入口') + ' · ' + (DF_TUNNEL_STATUS[x.status] || dfDash(x.status)),
      rows: [
        ['本地监听', x.listen],
        ['可达范围', x.reach],
        ['入口', x.entry],
        ['类型', x.kind],
        ['入口类型', x.entry_kind_label || x.entry_kind],
        ['是否越界', x.legit === true ? '是（视为突破）' : (x.legit === false ? '否（仅限本机）' : '待确认')],
        ['状态', DF_TUNNEL_STATUS[x.status] || x.status],
        ['资产', x.asset_ip],
        ['WebShell', x.webshell_url],
        ['命令', x.command],
        ['最近检查', dfTime(x.last_check)],
        ['备注', x.note],
      ],
      node: null,
    }
  }

  function credDrawer(c) {
    return {
      mode: 'peek',
      title: [c.host, c.username].filter(Boolean).join(' · ') || '凭据',
      sub: c.privilege || '',
      rows: [
        ['主机', c.host],
        ['账号', c.username],
        ['权限', c.privilege],
        ['密钥类型', DF_SECRET_TYPE[c.secret_type] || c.secret_type],
        ['密钥', c.secret_value],
        ['密钥引用', c.secret_ref],
        ['来源', c.source],
        ['工具', c.tool],
        ['发现时间', dfTime(c.found_at)],
        ['备注', c.note],
      ],
      node: null,
    }
  }

  function accessDrawer(a) {
    return {
      mode: 'peek',
      title: a.host,
      sub: (a.method || '访问') + ' · ' + dfDash(a.privilege),
      rows: [
        ['主机', a.host],
        ['账号', a.username],
        ['方式', a.method],
        ['权限', a.privilege],
        ['会话引用', a.session_ref],
        ['获得时间', dfTime(a.obtained_at)],
        ['备注', a.note],
      ],
      node: null,
    }
  }

  const tabs = [
    { key: 'webshell', label: 'WebShell', icon: 'terminal', count: d.shells.length },
    { key: 'tunnel', label: '隧道', icon: 'link', count: d.tunnels.length },
    { key: 'credential', label: '凭据', icon: 'key', count: d.creds.length },
    { key: 'access', label: '访问', icon: 'lock', count: d.access.length },
  ]

  return h('div', { className: 'df-ops' },
    /* 首屏节奏跟漏洞页对齐：标题栏 → 一条横向数字带 → 一整块白卡。
       原来一进来是四张 KPI 小格子，从别的页切过来整屏明暗会突跳。 */
    h('div', { className: 'df-opsbar' },
      h('span', { className: 'df-ops-title' }, '通道'),
      h('span', { className: 'df-spacer' }),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', onClick: state.reload }, '刷新')),

    h('div', { className: 'df-statsbar' },
      h(DfStat, {
        label: 'WebShell', icon: 'terminal', value: dfNum(t.webshellsOnline || 0),
        foot: '共 ' + dfNum(t.webshells || 0) + ' · 离线 ' + dfNum(Math.max(0, (t.webshells || 0) - (t.webshellsOnline || 0))),
        accent: (t.webshellsOnline || 0) > 0,
      }),
      h(DfStat, {
        label: '隧道', icon: 'link', value: dfNum(t.tunnelsActive || 0),
        foot: '共 ' + dfNum(t.tunnels || 0) + ' · 越界 ' + dfNum(t.tunnelsLegit || 0) + ' · 自建 ' + dfNum(t.tunnelsSelfOnly || 0),
      }),
      h(DfStat, {
        label: '凭据', icon: 'key', value: dfNum(t.credentials || 0),
        foot: '有密钥 ' + dfNum(d.creds.filter(function (c) { return String(c.secret_value || '').trim() !== '' }).length) + ' 条',
      }),
      h(DfStat, { label: '访问', icon: 'lock', value: dfNum(t.access || 0), foot: '可在目标上交互' })),

    h(DfCard, null,
      h(DfTabs, { items: tabs, value: tab, onChange: function (k) { setTab(k) } }),
      state.error
        ? h(DfOpsError, { title: '读取通道失败', error: state.error, onRetry: state.reload })
        : tab === 'webshell'
          ? (d.shells.length
            ? h('div', { className: 'df-tablewrap' },
              h(DfTable, {
                rows: d.shells, rowKey: function (r) { return r.id },
                onRow: function (r) { props.onInspect && props.onInspect(shellDrawer(r)) },
                columns: [
                  { key: 'url', title: 'URL', ellipsis: true, width: '34%', render: function (r) { return h('span', { className: 'df-mono' }, r.url) } },
                  { key: 'shell_type', title: '类型', width: 92, render: function (r) { return h(DfChip, { kind: 'line' }, dfDash(r.shell_type)) } },
                  { key: 'privilege', title: '权限', width: 92, render: function (r) { return dfDash(r.privilege) } },
                  {
                    key: 'status', title: '状态', width: 80,
                    render: function (r) {
                      return h(DfChip, { kind: r.status === 'online' ? 'ok' : (r.status === 'offline' || r.status === 'dead' ? 'err' : 'line'), dot: true }, DF_SHELL_STATUS[r.status] || dfDash(r.status))
                    },
                  },
                  { key: 'note', title: '备注', width: '16%', ellipsis: true, render: function (r) { return dfDash(r.note) } },
                  { key: 'last_check', title: '最近检查', width: 96, align: 'right', render: function (r) { return dfAgo(r.last_check) } },
                ],
              }))
            : h(DfEmpty, { icon: 'terminal', title: '还没有 WebShell', hint: '登记首个立足点。' }))
          : tab === 'tunnel'
            ? (d.tunnels.length
              ? h('div', { className: 'df-tablewrap' },
                h(DfTable, {
                  rows: d.tunnels, rowKey: function (r) { return r.id },
                  onRow: function (r) { props.onInspect && props.onInspect(tunnelDrawer(r)) },
                  columns: [
                    { key: 'listen', title: '本地监听', width: '20%', render: function (r) { return h('span', { className: 'df-mono' }, dfDash(r.listen)) } },
                    { key: 'reach', title: '可达', width: '18%', render: function (r) { return h('span', { className: 'df-mono' }, dfDash(r.reach || r.entry)) } },
                    { key: 'kind', title: '类型', width: 88, render: function (r) { return h(DfChip, { kind: 'line' }, dfDash(r.kind)) } },
                    {
                      key: 'entry_kind', title: '入口类型', width: 160,
                      render: function (r) { return h(DfChip, { kind: r.legit === true ? 'ok' : (r.legit === false ? 'warn' : 'line') }, r.entry_kind_label || r.entry_kind || '待确认') },
                    },
                    {
                      key: 'status', title: '状态', width: 76,
                      render: function (r) { return h(DfChip, { kind: r.status === 'active' ? 'ok' : 'err', dot: true }, DF_TUNNEL_STATUS[r.status] || dfDash(r.status)) },
                    },
                    { key: 'note', title: '备注', ellipsis: true, render: function (r) { return dfDash(r.note) } },
                  ],
                }))
              : h(DfEmpty, { icon: 'link', title: '还没有隧道', hint: 'suo5 / socks5 / ssh -R 都记在这里。' }))
            : tab === 'credential'
              ? (d.creds.length
                ? h('div', { className: 'df-tablewrap' },
                  h(DfTable, {
                    rows: d.creds, rowKey: function (r) { return r.id },
                    onRow: function (r) { props.onInspect && props.onInspect(credDrawer(r)) },
                    columns: [
                      { key: 'host', title: '主机', width: '26%', render: function (r) { return h('span', { className: 'df-mono' }, dfDash(r.host)) } },
                      { key: 'username', title: '账号', width: '20%' },
                      { key: 'privilege', title: '权限', width: 90, render: function (r) { return h(DfChip, { kind: /admin|system|root/i.test(String(r.privilege || '')) ? 'err' : 'line' }, dfDash(r.privilege)) } },
                      { key: 'source', title: '来源', width: 110, render: function (r) { return dfDash(r.source) } },
                      { key: 'found_at', title: '发现', align: 'right', width: 92, render: function (r) { return dfAgo(r.found_at) } },
                    ],
                  }))
                : h(DfEmpty, { icon: 'key', title: '还没有凭据', hint: '口令、哈希、票据都算凭据。' }))
              : (d.access.length
                ? h('div', { className: 'df-tablewrap' },
                  h(DfTable, {
                    rows: d.access, rowKey: function (r) { return r.id },
                    onRow: function (r) { props.onInspect && props.onInspect(accessDrawer(r)) },
                    columns: [
                      { key: 'host', title: '主机', width: '26%', render: function (r) { return h('span', { className: 'df-mono' }, dfDash(r.host)) } },
                      { key: 'username', title: '账号', width: '18%' },
                      { key: 'method', title: '方式', width: 110, render: function (r) { return dfDash(r.method) } },
                      { key: 'privilege', title: '权限', width: 90, render: function (r) { return h(DfChip, { kind: 'info' }, dfDash(r.privilege)) } },
                      { key: 'obtained_at', title: '获得', align: 'right', width: 92, render: function (r) { return dfAgo(r.obtained_at) } },
                    ],
                  }))
                : h(DfEmpty, { icon: 'lock', title: '还没有可控访问', hint: '登记交互式会话。' }))))
}

/* ---------------------------------------------------------------- 日志 */

function DfLog(props) {
  const eng = props.eng
  const [kind, setKind] = useState('')
  const [cursor, setCursor] = useState('')
  const [acc, setAcc] = useState([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const first = dfUseAsync(function () {
    return dfApi('viewActivity', { engagement: eng, limit: 100 }).then(function (r) {
      if (r && r.ok === false) throw new Error(r.error || '读取日志失败')
      return r || {}
    })
  }, [eng, props.tick])

  useEffect(function () {
    if (!first.data) return
    setAcc(first.data.items || [])
    setCursor(first.data.nextCursor || '')
  }, [first.data])

  function loadMore() {
    if (!cursor || loading) return
    setLoading(true)
    dfApi('viewActivity', { engagement: eng, limit: 100, after: cursor }).then(function (r) {
      setLoading(false)
      if (!r || r.ok === false) { setErr((r && r.error) || '加载失败'); return }
      setAcc(function (cur) { return cur.concat(r.items || []) })
      setCursor(r.nextCursor || '')
    }, function (e) {
      setLoading(false)
      setErr(String((e && e.message) || e))
    })
  }

  const rows = kind ? acc.filter(function (a) { return a.kind === kind }) : acc
  const total = (first.data && first.data.total) || acc.length

  return h('div', { className: 'df-ops' },
    h('div', { className: 'df-opsbar' },
      h('span', { className: 'df-ops-title' }, '作业日志'),
      h('span', { className: 'df-ops-meta' }, '工具调用、写入与检查'),
      h('span', { className: 'df-spacer' }),
      h(DfSeg, {
        value: kind,
        items: [['', '全部'], ['step', '步骤'], ['vuln', '漏洞'], ['webshell', 'WebShell'], ['credential', '凭据'], ['shot', '截图']],
        onChange: function (k) { setKind(k) },
      }),
      h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'refresh', onClick: first.reload }, '刷新')),

    h(DfCard, { title: '记录', icon: 'list', sub: kind
      ? '筛选 ' + dfNum(rows.length) + ' 条 · 已载入 ' + dfNum(acc.length)
      : '总计 ' + dfNum(total) + ' 条 · 已载入 ' + acc.length },
      first.error || err
        ? h(DfOpsError, { title: '读取日志失败', error: first.error || err, onRetry: first.reload })
        : rows.length
          ? h(react.Fragment, null,
            h('div', { className: 'df-tl df-tl--pad' }, rows.map(function (a, i) {
              const meta = DF_ACT[a.kind] || DF_ACT.step
              return h('div', {
                key: (a.kind || '') + ':' + (a.id || i) + ':' + i,
                className: 'df-tl-item',
                onClick: function () { props.onInspect && props.onInspect(dfActivityDrawer(a)) },
              },
                h('div', { className: 'df-tl-h' },
                  h('span', { className: 'df-act-ico' }, dfIcon(meta.icon, 13)),
                  h('span', null, a.title),
                  h('span', { className: 'df-tl-t' }, dfTime(a.at, true))),
                a.tool || a.target
                  ? h('div', { className: 'df-tl-d' },
                    a.tool ? h('span', { className: 'df-chain-tool' }, a.tool) : null,
                    a.target ? h('span', { className: 'df-mono' }, a.target) : null)
                  : null)
            })),
            cursor
              ? h('div', { className: 'df-more' },
                h(DfBtn, { size: 'sm', kind: 'ghost', icon: 'arrowDown', onClick: loadMore, disabled: loading },
                  loading ? '加载中…' : '加载更多'))
              : null)
          : first.loading
            ? h(DfSkeleton, { lines: 8 })
            : h(DfEmpty, { icon: 'list', title: kind ? '该类型还没有记录' : '还没有作业记录' })))
}
