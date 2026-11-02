/**
 * 归档批量契约：一行一条，`kind` 决定落到哪个写入口。
 *
 * 这里只做搬运，不做判断；每个 kind 直接调用 store 的**单条**方法，
 * 复用同一套必填/枚举/幂等校验，避免出现"批量能进、单条进不去"的两套口径。
 * 一行的失败只记行号，不影响其余行。
 */

export const BATCH_KINDS = [
  'vuln', 'chain', 'credential', 'webshell', 'tunnel', 'access',
  'http_evidence', 'attack_file', 'shot', 'coverage', 'asset_test', 'edge',
]

const WRITERS = {
  vuln: (store, id, item) => store.addVuln(id, item),
  chain: (store, id, item) => store.addChainStep(id, item),
  credential: (store, id, item) => store.addCredential(id, item),
  webshell: (store, id, item) => store.addWebshell(id, item),
  tunnel: (store, id, item) => store.addTunnel(id, item),
  access: (store, id, item) => store.addAccess(id, item),
  http_evidence: (store, id, item) => store.addHttpEvidence(id, item),
  attack_file: (store, id, item) => store.addAttackFile(id, item),
  shot: (store, id, item) => store.addShot(id, item),
  coverage: (store, id, item) => store.coverageSet(id, item),
  asset_test: (store, id, item) => store.updateAssetTest(id, item),
  edge: (store, id, item) => store.importBundle(id, { edges: [item] }),
}

/**
 * @param store - RedteamStore
 * @param id - 靶标 id
 * @param rows - [{ line, value }]，value 为解析后的对象
 * @param options - { agent }
 * @returns { counts, written, errors }
 */
export function importBatchRows(store, id, rows, options = {}) {
  const counts = Object.fromEntries(BATCH_KINDS.map((k) => [k, 0]))
  const errors = []
  const agent = options.agent ? String(options.agent) : ''
  for (const row of Array.isArray(rows) ? rows : []) {
    const line = row && row.line
    const value = row && row.value
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push({ line, error: '不是对象' })
      continue
    }
    const kind = String(value.kind || '').trim()
    if (kind === '') {
      errors.push({ line, error: '缺少 kind（' + BATCH_KINDS.join('|') + '）' })
      continue
    }
    const writer = WRITERS[kind]
    if (!writer) {
      errors.push({ line, error: '未知 kind：' + kind })
      continue
    }
    const item = { ...value }
    delete item.kind
    delete item.engagement
    if (agent && item.agent === undefined) item.agent = agent
    try {
      writer(store, id, item)
      counts[kind] += 1
    } catch (error) {
      errors.push({ line, error: error && error.message ? error.message : String(error) })
    }
  }
  const written = BATCH_KINDS.reduce((n, k) => n + counts[k], 0)
  return { counts, written, errors }
}
