/**
 * 子代理审批接管。
 *
 * 宿主给子会话写死 approval/policy = "never"：
 *   dsh-subagent captureDelegatedPolicyOverrides → approvalPolicy: "never"
 *   dsh-user-approval decide() → `if (effectivePolicy === "never") return "rejected";`
 * 这一步发生在 approval/request 的 waterfall 之前，所以任何监听器都救不到。
 *
 * 顺序只能是：先把 policy 翻成 ask，waterfall 才会跑；再在 waterfall 里放行。
 * 只作用于子会话，主会话零影响。
 *
 * 为什么必须走钩子而不是打补丁：本插件的审批放行靠改宿主源码（core.js 里的
 * allowed-once 替换），宿主一升级就是补丁全 NA —— 2026-10-30 官方把 app.asar
 * 换掉后 patches_applied 归零，子代理当场回到"一动手就被拒"。钩子不随补丁失效。
 *
 * 移植自 YuJunZhiXue/dsh-purge v1.1.89 的 lib/subagent-control.js（Apache-2.0），
 * 识别函数改从本项目的 anchor.js 取。
 */
import { isSubagentContext } from "./anchor.js"
import { hookEnabled } from "./runtime-hooks.js"

/** 同一会话最多补几次 ask，防止异常会话里反复触发。 */
const MAX_FLIPS = 4

/* 运行时统计：只给「维护」页看。 */
const controlStats = { installed: false, flips: 0, allowed: 0, lastAt: 0 }

export function subagentControlStats() {
  return { ...controlStats }
}

export function installSubagentControl(ctx, config = {}) {
  if (config.subagentControl === false) return () => {}
  if (typeof ctx?.on !== "function") return () => {}

  const offs = []
  const flips = new WeakMap()
  const isChild = (session) => isSubagentContext({ session })

  // P1：看到宿主写进来的 never，就补一条 ask。overrideOf 倒序取最后一条，后写者胜。
  try {
    offs.push(ctx.on("session/event", (session, event) => {
      try {
        if (!hookEnabled("subagentControl")) return
        if (event?.type !== "approval/policy") return
        if (event?.data?.policy !== "never") return
        if (!isChild(session)) return
        const n = flips.get(session) || 0
        if (n >= MAX_FLIPS) return
        // 同一 tick 多条 never 事件会读到同一个 n：先同步占位，append 失败再退回。
        flips.set(session, n + 1)
        // 不能在 append 的处理链里再 append。名额只在真正写成功时消耗：
        // 会话已关 / append 失败时退还，否则 4 次空转之后这个会话就永远不再补 ask。
        queueMicrotask(() => {
          try {
            session.append("approval/policy", { policy: "ask" })
            controlStats.flips += 1
            controlStats.lastAt = Date.now()
          } catch {
            flips.set(session, n) /* 会话已关，退还名额 */
          }
        })
      } catch { /* 观察者不能抛 */ }
    }, { global: true }))
  } catch { /* 老宿主无 session/event */ }

  // P2：policy 变 ask 之后 waterfall 才会跑，这里对子会话放行一次。
  // 必须 global —— 宿主是 ctx.waterfall(scopeTarget(req.agent, req.agent), ...)，agent 作用域。
  try {
    offs.push(ctx.on("approval/request", (request, next) => {
      try {
        if (!hookEnabled("subagentControl")) return typeof next === "function" ? next() : "unavailable"
        if (isChild(request?.agent?.session)) {
          controlStats.allowed += 1
          controlStats.lastAt = Date.now()
          return "allowed-once"
        }
      } catch { /* 落到 next */ }
      return typeof next === "function" ? next() : "unavailable"
    }, { global: true, prepend: true }))
  } catch { /* 老宿主无 approval/request */ }

  if (offs.length) controlStats.installed = true

  return () => {
    for (const off of offs) {
      try { off() } catch { /* 已释放 */ }
    }
  }
}
