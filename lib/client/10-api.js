/* 接口层：只做 HTTP 与缓存，不做业务推导。
   · 读请求按 op+参数 缓存（默认 15s），同 key 并发只发一次；
   · 写请求成功后清空缓存，下一次读必然拿新数据；
   · 错误统一成 `{ ok:false, error }`，视图层只判断 ok。 */

const DF_API_PATH = '/redteam/api'
const DF_BRIDGE_HEADER = { 'x-dsh-forge-bridge': '1' }
const DF_CACHE_TTL = 15000

/** key → { at, value } */
const dfCache = new Map()
/** key → Promise（并发去重） */
const dfInflight = new Map()

function dfApiKey(op, args) {
  try { return op + '|' + JSON.stringify(args || {}) } catch (e) { return op + '|' + String(args) }
}

function dfCacheGet(key, ttl) {
  const hit = dfCache.get(key)
  if (!hit) return undefined
  if (Date.now() - hit.at > (ttl === undefined ? DF_CACHE_TTL : ttl)) {
    dfCache.delete(key)
    return undefined
  }
  return hit.value
}

function dfCacheSet(key, value) {
  dfCache.set(key, { at: Date.now(), value: value })
}

/** 清缓存：`dfBust()` 全清；`dfBust('assets')` 只清该前缀。 */
function dfBust(prefix) {
  dfBustGen.bump()
  /* 页面现在是常驻的：写操作之后，藏在后台的那些页不会自己重画。
     清完缓存顺手通知一声，让它们各自去取新数据 —— 否则切回去看到的是旧内容。 */
  dfBustSubs.forEach(function (fn) {
    try { fn() } catch (e) { /* 订阅方自己出错不影响别人 */ }
  })
  if (!prefix) { dfCache.clear(); return }
  const keys = Array.from(dfCache.keys())
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i].indexOf(prefix) === 0) dfCache.delete(keys[i])
  }
}

/* dfBust() 的代数：每次清缓存 +1。取数钩子拿它判断「手里这份数据是不是已经作废了」。 */
let dfBustCount = 0
function dfBustGen() {
  return dfBustCount
}
dfBustGen.bump = function () { dfBustCount += 1 }

/* 订阅 dfBust()：主区靠它让所有常驻页一起刷新。 */
const dfBustSubs = new Set()
function dfBustSubscribe(fn) {
  dfBustSubs.add(fn)
  return function () { dfBustSubs.delete(fn) }
}

/* 权限档位是全局开关，但改它不动任何靶标数据：
   单独一条通知通道，别借用 dfBust() 把整面板缓存全清 —— 那会让所有常驻页
   同时掉进骨架态，切档时闪一屏。 */
const dfPermSubs = new Set()
function dfPermNotify() {
  dfPermSubs.forEach(function (fn) {
    try { fn() } catch (e) { /* 订阅方自己出错不影响别人 */ }
  })
}
function dfPermSubscribe(fn) {
  dfPermSubs.add(fn)
  return function () { dfPermSubs.delete(fn) }
}

/** 写操作前缀：命中后清缓存。 */
/** 写操作：成功后清空读缓存。显式列出，避免把 platformConfigGet 这类读 op 也当成写。 */
const DF_WRITE_OPS = {
  openEngagement: 1, activateEngagement: 1, deleteEngagement: 1, deleteEngagements: 1, import: 1,
  assetTest: 1, assessAsset: 1, addChainStep: 1, addHttpEvidence: 1,
  addAsset: 1, addPort: 1, addService: 1, addFingerprint: 1, addVuln: 1,
  addCredential: 1, addAccess: 1, addTunnel: 1, addWebshell: 1,
  updateVuln: 1, reviewVuln: 1, toolSet: 1, updateWebshell: 1, updateTunnel: 1, updateAsset: 1,
  savePrompt: 1, resetPrompts: 1, addAttackFile: 1,
  pocUse: 1, pocUpdate: 1, pocDelete: 1, savePoc: 1,
  shotAdd: 1, shotDelete: 1,
  toolboxSync: 1, toolboxAddRoot: 1, toolboxRemoveRoot: 1, toolboxSet: 1, toolboxMeta: 1,
  toolboxPath: 1, toolboxForget: 1,
  platformConfigSave: 1, platformAssignToolkit: 1, vpsApply: 1, vpsClear: 1, vpsNative: 1,
  oastSave: 1, oastClear: 1, fofaClear: 1,
  setAgentsMax: 1, updateApply: 1,
  /* 模型工具专用：面板目前不直接调用它，但一旦调用必须绕开 15s 读缓存，
     否则「刷新」会复用上一次探测结果，还会漏掉新的探测写库。 */
  probeSessions: 1,
  /* 报告开关 / 生成都会改变概览的「下一步」和报告页状态，必须让读缓存失效。 */
  reportMark: 1, reportGenerate: 1,
}

function dfIsWriteOp(op) {
  return !!DF_WRITE_OPS[String(op || '')]
}

function dfJson(res) {
  return res.text().then(function (text) {
    let data = null
    try { data = text ? JSON.parse(text) : null } catch (e) {
      /* 不要把整段 HTML / 堆栈丢到界面上：给状态码就够定位，细节留给宿主日志。 */
      return { ok: false, error: '接口响应异常（HTTP ' + res.status + '）' }
    }
    if (!res.ok) {
      return Object.assign({}, data || {}, {
        ok: false,
        error: (data && (data.error || data.message)) || (res.status + ' ' + res.statusText),
      })
    }
    return data
  }, function () {
    return { ok: false, error: res.status + ' ' + res.statusText }
  })
}

/**
 * 原始 HTTP。
 * @param {string} path - 同源路径。
 * @param {object} [init] - fetch 参数。
 * @param {{ttl?:number, force?:boolean}} [opts] - 缓存策略；GET 默认 15s，POST 不缓存。
 */
function dfHttp(path, init, opts) {
  const options = init || {}
  const config = opts || {}
  const method = String(options.method || 'GET').toUpperCase()
  const cacheable = method === 'GET' && config.ttl !== 0
  const cacheKey = method + ' ' + path
  /* 并发去重按「方法 + 路径 + body」：同一个 POST 路径可能带不同参数（技能详情、规则详情）。 */
  const key = cacheKey + (options.body ? '#' + String(options.body) : '')
  if (cacheable && !config.force) {
    const hit = dfCacheGet(cacheKey, config.ttl)
    if (hit !== undefined) return Promise.resolve(hit)
  }
  if (dfInflight.has(key)) return dfInflight.get(key)

  const p = fetch(path, Object.assign({ cache: 'no-store', credentials: 'same-origin' }, options))
    .then(dfJson)
    .then(function (value) {
      if (cacheable) dfCacheSet(cacheKey, value)
      return value
    }, function (e) {
      return { ok: false, error: '请求失败：' + String((e && e.message) || e) }
    })
    .then(function (value) {
      dfInflight.delete(key)
      return value
    })
  dfInflight.set(key, p)
  return p
}

/** 宿主接口调用：统一成 { ok, ... }，视图只判断 ok。 */
function dfHost(path, init) {
  return dfHttp(path, init, { ttl: 0 }).then(function (r) {
    return r || { ok: false, error: '宿主接口没有返回内容' }
  })
}

function dfHostPost(path, body) {
  return dfHost(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
}

/**
 * 面板 op。
 * @param {string} op - store-core 的 op。
 * @param {object} [args] - 参数（可含 engagement）。
 * @param {{ttl?:number, force?:boolean}} [opts] - 缓存策略。
 */
function dfApi(op, args, opts) {
  const config = opts || {}
  const key = dfApiKey(op, args)
  if (!config.force) {
    const hit = dfCacheGet(key, config.ttl)
    if (hit !== undefined) return Promise.resolve(hit)
  }
  if (dfInflight.has(key)) return dfInflight.get(key)

  const body = JSON.stringify(Object.assign({ op: op }, args || {}))
  const p = fetch(DF_API_PATH, {
    method: 'POST',
    cache: 'no-store',
    credentials: 'same-origin',
    headers: Object.assign({ 'content-type': 'application/json' }, DF_BRIDGE_HEADER),
    body: body,
  })
    .then(dfJson)
    .then(function (value) {
      if (value && value.ok !== false) {
        /* 权限档位只影响「下次越界怎么判」，不影响已读到的数据：
           走独立通知，不全局清缓存。 */
        if (op === 'permissionSet') dfPermNotify()
        else if (dfIsWriteOp(op)) dfBust()
        else dfCacheSet(key, value)
      }
      return value
    }, function (e) {
      return { ok: false, error: '请求失败：' + String((e && e.message) || e) }
    })
    .then(function (value) {
      dfInflight.delete(key)
      return value
    })
  dfInflight.set(key, p)
  return p
}

/** 失败时抛出，交给 dfUseAsync 显示错误。 */
function dfExpect(result) {
  if (result && result.ok === false) throw new Error(result.error || '接口返回失败')
  return result
}

/* ---------------------------------------------------------------- 便捷封装 */

/** 当前靶标 id（缓存 60s；切靶标时由外壳主动 dfBust）。 */
function dfBootstrap(force) {
  return dfApi('bootstrap', {}, { ttl: 60000, force: !!force })
}

/** 统一带上靶标 id 的读请求。 */
function dfEngApi(op, engagement, args, opts) {
  return dfApi(op, Object.assign({ engagement: engagement }, args || {}), opts)
}
