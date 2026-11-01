/**
 * 面板视图模型（headless）。
 *
 * 这一层只做聚合与推导，不碰 React、不碰 DOM；面板以后换成什么框架，
 * 都只需要调这里的几个函数（或 dispatch 的 view* op）。
 *
 * 约束：
 *  · 只读，不写库；
 *  · 数值全部来自 store 的现有方法或只读 SQL，不在这里算分、不改状态；
 *  · 输出是给界面直接渲染的结构，不返回数据库原始行。
 */

export const TEST_CLASSES = ['authn', 'authz', 'injection', 'file', 'ssrf', 'logic', 'client', 'infra']

/* 这些资产级状态表示“这个资产没有可测的攻击面 / 已放弃 / 被外部条件挡住”。
   它们仍会在矩阵里显示，但不该再要求补满 8 类——否则收口永远过不了。 */
export const EXEMPT_TEST_STATUSES = new Set(['no_surface', 'abandoned', 'blocked'])

export const CLASS_LABELS = {
  authn: '认证',
  authz: '越权',
  injection: '注入',
  file: '文件',
  ssrf: 'SSRF',
  logic: '业务逻辑',
  client: '前端/客户端',
  infra: '基础设施',
}

function safe(fn, fallback) {
  try { return fn() } catch { return fallback }
}

function itemsOf(result) {
  if (Array.isArray(result)) return result
  if (result && Array.isArray(result.items)) return result.items
  return []
}

/** 覆盖矩阵：行=资产，列=八类测试。 */
export function buildMatrix(store, id) {
  const db = store.db(id)
  const assets = safe(() => db.prepare(
    'SELECT id, ip, test_status, test_notes, test_surface, priority FROM asset ORDER BY id',
  ).all(), [])
  const names = safe(() => db.prepare('SELECT asset_id, name FROM asset_name').all(), [])
  const coverage = safe(() => db.prepare(
    'SELECT asset_id, surface, test_class, status, note, updated_at FROM coverage',
  ).all(), [])

  const namesByAsset = new Map()
  for (const n of names) {
    if (!namesByAsset.has(n.asset_id)) namesByAsset.set(n.asset_id, [])
    namesByAsset.get(n.asset_id).push(String(n.name || '').toLowerCase())
  }

  function statusFor(asset, testClass) {
    const hit = coverage.find((c) => {
      if (String(c.test_class) !== testClass) return false
      if (c.asset_id !== null && c.asset_id !== undefined) return Number(c.asset_id) === Number(asset.id)
      const surface = String(c.surface || '').toLowerCase()
      if (surface === '') return false
      if (surface === String(asset.ip || '').toLowerCase()) return true
      return (namesByAsset.get(asset.id) || []).includes(surface)
    })
    if (hit) return String(hit.status || 'tested')
    /* 矩阵只认覆盖账本：漏洞是“有发现”，不是“测过”；测试笔记也不自动算某一类已测。 */
    return 'untested'
  }

  function overallStatus(asset) {
    return String(asset.test_status || 'untested')
  }

  const rows = assets.map((a) => {
    const cells = {}
    for (const c of TEST_CLASSES) cells[c] = statusFor(a, c)
    const done = TEST_CLASSES.filter((c) => cells[c] !== 'untested').length
    const testStatus = overallStatus(a)
    const required = !EXEMPT_TEST_STATUSES.has(testStatus)
    return {
      assetId: a.id, ip: a.ip, testStatus, priority: a.priority || '',
      cells, done, total: TEST_CLASSES.length,
      required,
      missing: TEST_CLASSES.filter((c) => cells[c] === 'untested'),
    }
  })

  const touched = rows.filter((r) => r.done > 0)
  const requiredRows = rows.filter((r) => r.required)
  return {
    classes: TEST_CLASSES.map((code) => ({ code, label: CLASS_LABELS[code] })),
    rows,
    summary: {
      assets: rows.length,
      required_assets: requiredRows.length,
      tested: touched.length,
      untouched: requiredRows.filter((r) => r.done === 0).length,
      exempt: rows.length - requiredRows.length,
      gaps: requiredRows.reduce((n, r) => n + (r.total - r.done), 0),
    },
  }
}

/** 作业日志：把几类已经带时间戳的写入并成一条时间线。 */
export function buildActivity(store, id, options = {}) {
  const db = store.db(id)
  const limit = Math.min(Math.max(Number(options.limit) || 30, 1), 200)
  const out = []

  const add = (kind, rows, mapper) => {
    for (const row of rows) {
      try {
        const item = mapper(row)
        if (item && item.at) out.push(item)
      } catch { /* 单条异常不影响整条时间线 */ }
    }
  }

  add('step', safe(() => db.prepare(
    'SELECT id, seq, title, detail, stage_code, tool, result, recorded_at FROM attack_step',
  ).all(), []), (r) => ({
    at: r.recorded_at, kind: 'step', id: r.id, title: r.title || ('第 ' + r.seq + ' 步'),
    stage: r.stage_code || '', detail: r.detail || '', tool: r.tool || '', result: r.result || '', who: 'ai',
  }))

  add('vuln', safe(() => db.prepare(
    "SELECT id, title, severity, status, target, found_at FROM vuln WHERE COALESCE(found_at, '') <> ''",
  ).all(), []), (r) => ({
    at: r.found_at, kind: 'vuln', id: r.id, title: r.title || '漏洞', severity: r.severity || '',
    status: r.status || '', target: r.target || '', who: 'ai',
  }))

  add('hypothesis', safe(() => db.prepare(
    "SELECT id, surface, status, vuln_class, COALESCE(closed_at, opened_at) AS at FROM hypothesis WHERE COALESCE(opened_at, '') <> ''",
  ).all(), []), (r) => ({
    at: r.at, kind: 'hypothesis', id: r.id, title: r.surface || '假设',
    status: r.status || '', detail: r.vuln_class || '', who: 'ai',
  }))

  add('webshell', safe(() => db.prepare(
    'SELECT id, url, status, privilege, COALESCE(updated_at, created_at) AS at FROM webshell',
  ).all(), []), (r) => ({
    at: r.at, kind: 'webshell', id: r.id, title: r.url || 'WebShell', status: r.status || '',
    privilege: r.privilege || '', who: 'ai',
  }))

  add('credential', safe(() => db.prepare(
    "SELECT id, host, username, privilege, source, found_at FROM credential WHERE COALESCE(found_at, '') <> ''",
  ).all(), []), (r) => ({
    at: r.found_at, kind: 'credential', id: r.id, title: [r.host, r.username].filter(Boolean).join(' ') || '凭据',
    privilege: r.privilege || '', tool: r.source || '', who: 'ai',
  }))

  add('shot', safe(() => db.prepare(
    'SELECT id, label, COALESCE(captured_at, created_at) AS at FROM shot',
  ).all(), []), (r) => ({
    at: r.at, kind: 'shot', id: r.id, title: r.label || '证据截图', who: 'ai',
  }))

  const sorted = out
    .filter((x) => String(x.at || '') !== '')
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))

  /* 游标必须带 kind+id：同一秒里经常有多条记录，只用 at 会漏掉同秒的其余条目。 */
  const keyOf = (x) => String(x.at) + '|' + String(x.kind) + '|' + String(x.id)
  const after = String(options.after || options.before || '')
  const page = after === '' ? sorted : sorted.filter((x) => keyOf(x) < after)

  return {
    items: page.slice(0, limit),
    nextCursor: page.length > limit ? keyOf(page[limit - 1]) : null,
    total: sorted.length,
  }
}

/** 下一步队列：从覆盖、证据、通道三类缺口里推出来。 */
export function buildNext(store, id, stats) {
  const out = []
  const push = (item) => { if (out.length < 8) out.push(item) }

  const untested = Number(stats && stats.untestedAssets) || 0
  if (untested > 0) {
    push({ kind: 'coverage', text: untested + ' 个资产还没有覆盖记录（8 类一格都没有）', why: '未测', ref: { op: 'coverage' } })
  }

  const vulns = itemsOf(safe(() => store.listVulns(id, { limit: 500, with_http_evidence: false }), { items: [] }))
  const noEvidence = vulns.filter((v) => (v.status === 'confirmed' || v.status === 'exploited')
    && String(v.evidence || '').trim() === '')
  if (noEvidence.length > 0) {
    push({ kind: 'evidence', text: noEvidence.length + ' 条已确认漏洞没有证据原文', why: '报告会缺', ref: { op: 'vuln', id: noEvidence[0].id } })
  }

  const pending = vulns.filter((v) => v.status === 'candidate')
  if (pending.length > 0) {
    push({ kind: 'verify', text: pending.length + ' 条漏洞仍是候选，未验证', why: '待定级', ref: { op: 'vuln', id: pending[0].id } })
  }

  const sessions = safe(() => store.sessionSummary(id), { webshells: [], tunnels: [] })
  const deadShells = (sessions.webshells || []).filter((w) => w.status && w.status !== 'online')
  if (deadShells.length > 0) {
    push({ kind: 'channel', text: deadShells.length + ' 个 WebShell 不在线', why: '可能掉线', ref: { op: 'webshell', id: deadShells[0].id } })
  }

  const selfOnly = (sessions.tunnels || []).filter((t) => t.status === 'active' && (t.entry_kind === 'self-only' || !t.entry_kind))
  if (selfOnly.length > 0) {
    push({ kind: 'channel', text: selfOnly.length + ' 条隧道未构成突破（仅本机或未声明入口）', why: '从成果里移除', ref: { op: 'tunnel', id: selfOnly[0].id } })
  }

  /* 报告：只有项目被标记为「需要交付报告」、且还没生成过时才提醒。
     默认不提醒 —— 报告要花人审、要花 token，多数项目不需要。 */
  const meta = safe(() => store.readReportMeta ? store.readReportMeta(id) : null, null)
  const needReport = meta === null ? false : String(meta.need_report || '') === 'true'
  const hasReport = meta === null ? false : Number(meta.chars || 0) > 0
  if (needReport && !hasReport) {
    push({ kind: 'deliver', text: '本项目需要交付报告，但还没有生成', why: '未生成', ref: { op: 'report' } })
  }

  return out
}

/** 概览：一次拿全首屏需要的东西。 */
export function buildOverview(store, id, options = {}) {
  const stats = safe(() => store.stats(id), {})
  const matrix = buildMatrix(store, id)
  /* 概览的“未测”跟矩阵同一口径：有测试记录/成果的资产不再算未测。 */
  const effectiveStats = { ...stats, untestedAssets: matrix.summary.untouched }
  const activity = buildActivity(store, id, { limit: Number(options.activityLimit) || 8 })
  return {
    engagement: id,
    stats: effectiveStats,
    matrix,
    next: buildNext(store, id, effectiveStats),
    activity: activity.items,
  }
}
