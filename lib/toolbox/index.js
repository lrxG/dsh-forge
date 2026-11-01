/**
 * toolbox：外部工具 broker。
 *
 * 不把每个二进制注册成函数，也不扫整个 PATH。只扫 registry 里允许的根：
 *   $DSH_HOME/tools + 模式默认目录 + 用户显式 roots + 红队配置目录。
 *
 * 设计目标：
 *   · find 返回少量“可执行卡片”，不是几十个文件名；
 *   · open/describe 先给 recipe，其次给截断的 --help；
 *   · learn/use 记住常用命令和使用频率；
 *   · run 能直接执行的工具自动记使用，复杂管道仍走 shell；
 *   · 同一会话记住查过的工具，减少重复搜索。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path, { extname } from "node:path";
import { loadDefineTool } from "../tool-loader.js";
import {
  toolboxHome,
  loadRegistry,
  syncRegistry,
  rootsOf,
  findRegistry,
  markRegistered,
  recordUse,
  learnRecipe,
  setHelp,
} from "./registry.js";

const defineTool = loadDefineTool()

export const name = "dsh-forge-toolbox"
export const inject = ["tools"]

const SYNC_TTL_MS = 60_000
const HELP_MAX = 4000
const RUN_OUTPUT_MAX = 4000
const KNOWN_TTL_MS = 12 * 60 * 60 * 1000
const KNOWN_CAP = 500
const RUN_TIMEOUT_DEFAULT = 120_000
const RUN_TIMEOUT_MAX = 600_000

function isWindows() {
  return process.platform === "win32"
}

function modeOf(config) {
  return config && config.mode === "crack" ? "crack" : "redteam"
}

function maybeSync(home, mode) {
  const registry = loadRegistry(home, mode)
  const at = Date.parse(registry.last_sync || "")
  if (Number.isFinite(at) && Date.now() - at < SYNC_TTL_MS) return registry
  return syncRegistry(home, mode)
}

function cardOf(tool, known) {
  const card = { name: tool.name, uses: Number(tool.uses) || 0 }
  if (tool.path) card.path = tool.path
  if (tool.purpose) card.purpose = tool.purpose
  if (Array.isArray(tool.tags) && tool.tags.length) card.tags = tool.tags
  if (tool.recipe && tool.recipe.command) {
    card.command = tool.recipe.command
    if (tool.recipe.note) card.note = tool.recipe.note
  }
  if (tool.risk) card.risk = tool.risk
  if (tool.last_seen) card.last_used = tool.last_seen
  if (tool.missing === true) card.missing = true
  if (tool.status === "blocked") card.blocked = true
  if (tool.registered === true) card.registered = true
  if (known) card.known = true
  return card
}

function helpOf(file) {
  const ext = extname(file || "").toLowerCase()
  const attempts = ext === ".ps1"
    ? [["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, "-?"]]]
    : [["--help"], ["-h"], ["/?"]]
  for (const [argOrCmd, extra] of attempts) {
    const args = Array.isArray(extra) ? extra : [argOrCmd]
    let command = Array.isArray(extra) ? argOrCmd : file
    let argv = args
    if (isWindows() && /\.(cmd|bat)$/.test(ext)) {
      command = "powershell"
      argv = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psRunLine(file, args)]
    }
    const result = spawnSync(command, argv, {
      timeout: 3000,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 64 * 1024,
    })
    const text = String(result.stdout || result.stderr || "").trim()
    if (text) return text.slice(0, HELP_MAX)
  }
  return ""
}

/** 简单 shell-like 参数拆分；复杂管道请继续用 shell。数组参数永远优先。 */
function splitArgs(text) {
  const out = []
  let cur = ""
  let quote = ""
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = ""
      else if (ch === "\\" && quote === '"' && text[i + 1] === '"') { cur += '"'; i += 1 }
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = "" }
      continue
    }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

function argvOf(value) {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value.map((x) => String(x))
  if (typeof value === "string") return splitArgs(value)
  throw new Error("args 必须是字符串数组（推荐）或字符串")
}

function clip(text, max = RUN_OUTPUT_MAX) {
  const value = String(text || "")
  return value.length > max ? value.slice(0, max) + "\n…（输出已截断）" : value
}

/** PowerShell 单引号引用：路径里有空格 / & / 括号时也能直接跑 .cmd / .bat。 */
function quotePs(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

function psRunLine(file, args) {
  return "& " + quotePs(file)
    + (args.length ? " " + args.map(quotePs).join(" ") : "")
    + "; exit $LASTEXITCODE"
}

/** 异步执行，避免长命令把 dsh 主进程事件循环卡住。 */
function runTool(tool, inner) {
  if (!tool.path) throw new Error("工具没有可执行路径：" + tool.name)
  let st
  try { st = fs.statSync(tool.path); } catch { st = null; }
  if (!st || !st.isFile()) throw new Error("工具文件不存在：" + tool.path)
  const args = argvOf(inner.args !== undefined ? inner.args : inner.argv)
  const cwd = inner.cwd ? path.resolve(String(inner.cwd)) : process.cwd()
  try {
    const cst = fs.statSync(cwd)
    if (!cst.isDirectory()) throw new Error("cwd 不是目录：" + cwd)
  } catch (error) {
    if (error && String(error.message || "").includes("cwd 不是目录")) throw error
    throw new Error("cwd 不存在：" + cwd)
  }
  const asked = Number(inner.timeoutMs) || RUN_TIMEOUT_DEFAULT
  const timeout = Math.max(1000, Math.min(asked, RUN_TIMEOUT_MAX))
  const ext = extname(tool.path).toLowerCase()
  let command = tool.path
  let argv = args
  if (ext === ".ps1") {
    command = "powershell"
    argv = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tool.path, ...args]
  } else if (isWindows() && /\.(cmd|bat)$/.test(ext)) {
    /* 不用 shell:true：Node 只把参数拼成字符串，路径一有空格就断。 */
    command = "powershell"
    argv = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psRunLine(tool.path, args)]
  }
  const started = Date.now()
  return new Promise((resolve) => {
    let done = false
    let timedOut = false
    let stdout = ""
    let stderr = ""
    let timer = null
    let child
    const finish = (code, signal, error) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      const ok = !error && !timedOut && code === 0
      const payload = {
        ok,
        name: tool.name,
        path: tool.path,
        exit_code: code,
        timed_out: timedOut,
        duration_ms: Date.now() - started,
      }
      if (stdout) payload.stdout = clip(stdout)
      if (stderr) payload.stderr = clip(stderr)
      if (signal) payload.signal = signal
      if (error && !timedOut) payload.error = String(error.message || error)
      resolve(payload)
    }
    try {
      child = spawn(command, argv, {
        cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (error) {
      finish(null, null, error)
      return
    }
    timer = setTimeout(() => {
      timedOut = true
      try { child.kill("SIGKILL") } catch { /* ignore */ }
      /* 极少数 Windows 子进程不响应 kill，给一个兜底，避免调用永远挂着。 */
      setTimeout(() => finish(null, null, null), 1500)
    }, timeout)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      if (stdout.length < RUN_OUTPUT_MAX) stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      if (stderr.length < RUN_OUTPUT_MAX) stderr += chunk
    })
    child.on("error", (error) => finish(null, null, error))
    child.on("close", (code, signal) => finish(code, signal))
  })
}

export function apply(ctx, config = {}) {
  const mode = modeOf(config)
  const home = toolboxHome()
  const knownBySession = new Map()

  function sessionKeyOf(exec) {
    const session = exec && exec.agent && exec.agent.session
    if (!session) return ""
    let cur = session
    let id = String(session.id || "")
    let guard = 0
    while (cur && guard < 64) {
      const header = cur.header
      const parentId = header && header.parentSession !== undefined && header.parentSession !== null
        ? String(header.parentSession)
        : ""
      if (!parentId) break
      let parent
      try { parent = cur.store && typeof cur.store.get === "function" ? cur.store.get(parentId) : undefined; } catch { parent = undefined; }
      if (!parent) { id = parentId; break }
      cur = parent
      id = String(parent.id || id)
      guard += 1
    }
    return id
  }

  function knownRow(key) {
    if (!key) return null
    const row = knownBySession.get(key)
    if (!row) return null
    if (Date.now() - row.at > KNOWN_TTL_MS) {
      knownBySession.delete(key)
      return null
    }
    return row
  }

  function knownNames(exec) {
    const row = knownRow(sessionKeyOf(exec))
    return row ? Array.from(row.names) : []
  }

  function noteKnown(exec, name) {
    const key = sessionKeyOf(exec)
    if (!key || !name) return
    let row = knownRow(key)
    if (!row) {
      row = { names: new Set(), at: Date.now() }
      knownBySession.set(key, row)
      if (knownBySession.size > KNOWN_CAP) {
        const first = knownBySession.keys().next().value
        if (first !== undefined) knownBySession.delete(first)
      }
    }
    row.at = Date.now()
    row.names.add(String(name).toLowerCase())
  }

  function findTool(name) {
    const key = String(name || "").trim().toLowerCase()
    if (!key) return null
    const registry = loadRegistry(home, mode)
    return registry.tools[key] || null
  }

  function openTool(exec, name) {
    const key = String(name || "").trim().toLowerCase()
    const tool = findTool(key)
    if (!tool) {
      return { ok: false, error: "没找到工具：" + String(name || "") + "；先 toolbox find 或 sync" }
    }
    markRegistered(home, mode, key)
    noteKnown(exec, key)
    const card = cardOf(tool, false)
    if (tool.recipe && tool.recipe.command) {
      return { ok: true, ...card, recipe: tool.recipe, hint: "已有常用命令；直接用，不用再跑 --help" }
    }
    let help = tool.help && tool.help.text ? String(tool.help.text) : ""
    if (help.length > HELP_MAX) help = help.slice(0, HELP_MAX)
    if (!help && tool.path) {
      help = helpOf(tool.path)
      if (help) setHelp(home, mode, key, help)
    }
    if (help) {
      return { ok: true, ...card, help, hint: "help 已截断到 4k；用完后把最短命令 toolbox learn 进来" }
    }
    return {
      ok: true,
      ...card,
      help: "",
      hint: tool.path
        ? "没有拿到 --help 输出；可以直接执行 --help / -h，或查看官方文档。"
        : "这个工具还没有可执行路径；先 sync，或把文件放到 $DSH_HOME/tools。",
    }
  }

  ctx.tools.register(defineTool({
    name: "toolbox",
    description: "外部工具 broker：toolbox({action,args})。只扫配置里允许的目录，不扫整条 PATH。find 找工具卡片，open 取用法或 help，run 直接执行并自动记使用，learn/use 记常用命令。不认识的工具先 find，别假设它存在；管道仍用 shell。",
    parameters: {
      action: { type: "string", required: true, description: "find | open | list | search | describe | run | learn | use | known | sync | status" },
      args: {
        type: "object",
        additionalProperties: true,
        description: "find:{query?,limit?}；open/describe:{name}；run:{name,args?,cwd?,timeoutMs?}；learn:{name,command|recipe,note?,tags?,purpose?,risk?}；use:{name,command?,note?}",
      },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const action = String(args && args.action || "").trim().toLowerCase()
      const inner = (args && args.args && typeof args.args === "object") ? args.args : {}
      try {
        if (action === "sync" || action === "refresh") {
          const registry = syncRegistry(home, mode)
          return JSON.stringify({
            ok: true,
            count: registry.count,
            scanned: registry.scanned,
            truncated: registry.truncated === true,
            last_sync: registry.last_sync,
            roots: rootsOf(home, mode, registry).map((r) => r.path),
          }, null, 2)
        }
        if (action === "status") {
          const registry = maybeSync(home, mode)
          return JSON.stringify({
            ok: true,
            mode,
            count: Object.keys(registry.tools || {}).length,
            last_sync: registry.last_sync,
            truncated: registry.last_sync_truncated === true,
            roots: rootsOf(home, mode, registry).map((r) => r.path),
            known: knownNames(exec).slice(0, 20),
          }, null, 2)
        }
        if (action === "find" || action === "list" || action === "search") {
          maybeSync(home, mode)
          const known = knownNames(exec)
          const limit = inner.limit !== undefined
            ? inner.limit
            : (action === "find" ? 8 : 40)
          const rows = findRegistry(home, mode, inner.query, limit, known, action === "find" ? 30 : 200)
          for (const row of rows) noteKnown(exec, row.name)
          return JSON.stringify({
            ok: true,
            action,
            query: inner.query || "",
            count: rows.length,
            known: known.slice(0, 8),
            items: rows.map((tool) => cardOf(tool, known.includes(String(tool.name).toLowerCase()))),
            hint: action === "find"
              ? "这些是工具卡片，不是原生函数；先用 open 看 recipe/help，再 run 或 shell。"
              : "find 更省 token 且按用途排序；这里保留完整清单检索。",
          }, null, 2)
        }
        if (action === "open" || action === "describe") {
          maybeSync(home, mode)
          return JSON.stringify(openTool(exec, inner.name), null, 2)
        }
        if (action === "learn") {
          const command = inner.command !== undefined ? inner.command : inner.recipe
          const tool = learnRecipe(home, mode, inner.name, command, inner.note, {
            tags: inner.tags,
            purpose: inner.purpose,
            risk: inner.risk,
          })
          noteKnown(exec, tool.name)
          return JSON.stringify({ ok: true, name: tool.name, recipe: tool.recipe, tags: tool.tags || [], purpose: tool.purpose || "" }, null, 2)
        }
        if (action === "use") {
          const tool = recordUse(home, mode, inner.name, { command: inner.command, note: inner.note })
          if (tool) noteKnown(exec, tool.name)
          return JSON.stringify({ ok: Boolean(tool), name: tool && tool.name, uses: tool && tool.uses }, null, 2)
        }
        if (action === "run") {
          maybeSync(home, mode)
          const tool = findTool(inner.name)
          if (!tool) return JSON.stringify({ ok: false, error: "没找到工具：" + String(inner.name || "") + "；先 toolbox find 或 sync" }, null, 2)
          markRegistered(home, mode, tool.name)
          noteKnown(exec, tool.name)
          if (tool.status === "blocked") {
            return JSON.stringify({ ok: false, error: "该工具被人工标记为建议停用；请换工具或先解除标注", name: tool.name }, null, 2)
          }
          const result = await runTool(tool, inner)
          if (result.ok) {
            const used = recordUse(home, mode, tool.name)
            result.uses = used && used.uses
          }
          return JSON.stringify(result, null, 2)
        }
        if (action === "known") {
          return JSON.stringify({ ok: true, known: knownNames(exec).slice(0, 50) }, null, 2)
        }
        return JSON.stringify({
          ok: false,
          error: "未知动作：" + (action || "(空)"),
          actions: ["find", "open", "list", "search", "describe", "run", "learn", "use", "known", "sync", "status"],
        }, null, 2)
      } catch (error) {
        return JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }, null, 2)
      }
    },
  }))
}
