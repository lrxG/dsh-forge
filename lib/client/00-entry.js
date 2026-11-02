/* 新客户端入口：自己建 React root 挂到 document.body，不再经过宿主 slot。
   这样事件、定位、尺寸都由我们自己的根节点控制，不受 overlay 容器影响。 */

const CLIENT_NAME = 'dsh-forge'
const CLIENT_INJECT = ['slots', 'locale']
const CLIENT_NS = 'settings.dsh-forge'
let translate = (k) => k

/** 宿主服务拿得到就接上：环境门禁要 sessions，回退要 slots + conversation。 */
function dfWireHost(ctx) {
  dfInstallHost(ctx)
  try {
    if (typeof ctx.inject === 'function') {
      const wanted = ['sessions', 'uiWorkspace', 'conversation', 'slots']
      ctx.inject(wanted, function (host) {
        dfInstallHost(host)
        dfInstallRewind(host)
      })
    } else if (ctx.sessions) {
      dfInstallRewind(ctx)
    }
  } catch (e) {
    try { console.warn('[dsh-forge] host services unavailable:', e && e.message) } catch (e2) { /* ignore */ }
  }
}

function apply(ctx) {
  dfInjectStyles()
  try {
    if (ctx.locale && typeof ctx.locale.register === 'function') {
      ctx.locale.register(CLIENT_NS, { zh: {}, en: {} })
      translate = ctx.locale.bind(CLIENT_NS)
    }
  } catch (e) { /* locale 可选 */ }

  dfWireHost(ctx)

  let host = document.getElementById('dsh-forge-client-root')
  if (!host) {
    host = document.createElement('div')
    host.id = 'dsh-forge-client-root'
    host.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none;z-index:2147483000'
    document.body.appendChild(host)
  }
  if (host.__dfMounted) return
  const app = h(DfErrorBoundary, null, h(DfApp, { ctx: ctx }))
  try {
    const rd = require('react-dom')
    if (rd && typeof rd.createRoot === 'function') {
      host.__dfMounted = true
      rd.createRoot(host).render(app)
    } else if (rd && typeof rd.render === 'function') {
      host.__dfMounted = true
      rd.render(app, host)
    } else {
      throw new Error('react-dom unavailable')
    }
  } catch (e) {
    try { console.warn('[dsh-forge] react-dom mount failed, falling back to slot:', e && e.message) } catch { /* ignore */ }
    try {
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay', id: 'dsh-forge-dock', order: 50,
      }, () => app))
    } catch (e2) {
      try { console.warn('[dsh-forge] slot mount failed too:', e2 && e2.message) } catch { /* ignore */ }
    }
  }
}

exports.name = CLIENT_NAME
exports.inject = CLIENT_INJECT
exports.apply = apply
