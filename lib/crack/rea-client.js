/**
 * REA stdio 客户端：按「会话」隔离的 `rea mcp` 子进程池。
 *
 * 之前是一个进程级单例：主线和多个 worker 共用同一个 REA 工作现场。
 * REA 一次只能开一个现场，两个 worker 同时 `open_binary` 会互相把对方的
 * 样本/函数/偏移换掉。这里改成按会话 id 取客户端：
 *   · 同一会话复用同一个子进程（上下文稳定、省启动开销）；
 *   · 不同会话各自一个进程（互不踩现场）；
 *   · 超过上限时优先回收空闲进程；没有空闲就明确报 busy，不静默串。
 *
 * 协议没变：一行一条 JSON-RPC，先 initialize 再 tools/call；
 * 子进程崩溃/退出时拒绝所有在飞请求，下次调用重新拉起。
 */
import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 600000;
const MAX_CLIENTS = 8;

function isCmdScript(command) {
  return /\.(cmd|bat)$/i.test(String(command || ""));
}

class ReaClient {
  constructor(env) {
    this.env = env;
    this.child = null;
    this.nextId = 1;
    this.buffer = "";
    this.stderrTail = [];
    this.ready = null;
    this.pending = new Map();
    this.toolsCache = null;
    this.closed = false;
  }

  get busy() {
    return this.pending.size > 0;
  }

  reset(reason) {
    const err = reason instanceof Error ? reason : new Error(String(reason || "rea mcp 已关闭"));
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
    const proc = this.child;
    this.child = null;
    this.ready = null;
    this.buffer = "";
    if (proc) {
      try { proc.stdin.destroy(); } catch { /* ignore */ }
      try { proc.kill(); } catch { /* ignore */ }
    }
  }

  handleLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id === undefined || msg.id === null) return;
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else entry.resolve(msg.result);
  }

  attach(proc) {
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let at;
      while ((at = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, at).trim();
        this.buffer = this.buffer.slice(at + 1);
        if (line) this.handleLine(line);
      }
    });
    proc.stderr.on("data", (chunk) => {
      this.stderrTail.push(String(chunk).trim());
      if (this.stderrTail.length > 8) this.stderrTail.shift();
    });
    /* 管道断开时 write() 不抛，是异步 emit error；不接住就是未捕获事件，会带走整个宿主。 */
    proc.stdin.on("error", (e) => this.reset(e));
    proc.on("exit", (code, signal) => {
      const tail = this.stderrTail.join(" | ").slice(0, 300);
      this.reset(new Error(`rea mcp 退出（code=${code} signal=${signal}）${tail ? "：" + tail : ""}`));
    });
    proc.on("error", (e) => this.reset(new Error(`rea mcp 无法启动：${e && e.message ? e.message : e}`)));
  }

  request(payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rea 调用超时（${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.child) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("rea mcp 已关闭，再调一次会重新拉起"));
        return;
      }
      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, ...payload }) + "\n");
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`rea 写入失败：${e && e.message ? e.message : e}`));
      }
    });
  }

  notify(payload) {
    try { this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\n"); } catch { /* 下次调用会重建 */ }
  }

  async ensureReady() {
    if (this.child && this.ready) return this.ready;
    this.closed = false;
    const proc = spawn(this.env.command, this.env.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: isCmdScript(this.env.command),
    });
    this.child = proc;
    this.stderrTail = [];
    this.attach(proc);
    this.ready = this.request({
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "dsh-forge", version: "1" } },
    }, 60000).then(() => {
      this.notify({ method: "notifications/initialized" });
    }).catch((e) => {
      this.reset(e);
      throw e;
    });
    return this.ready;
  }

  async call(name, args, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await this.ensureReady();
    return this.request({ method: "tools/call", params: { name, arguments: args || {} } }, timeoutMs);
  }

  async listTools() {
    if (this.toolsCache) return this.toolsCache;
    await this.ensureReady();
    const result = await this.request({ method: "tools/list", params: {} }, 60000);
    this.toolsCache = (result && Array.isArray(result.tools)) ? result.tools : [];
    return this.toolsCache;
  }

  close(reason = "closed") {
    this.closed = true;
    this.toolsCache = null;
    this.reset(reason);
  }
}

const clients = new Map();
let mounted = 0;

function envKey(env) {
  if (!env) return "";
  return String(env.command || "") + "|" + (Array.isArray(env.args) ? env.args.join(" ") : "");
}

function evictIdle() {
  let victim = null;
  let oldest = Number.POSITIVE_INFINITY;
  for (const [key, entry] of clients) {
    if (entry.client.busy) continue;
    if (entry.lastUsed < oldest) {
      oldest = entry.lastUsed;
      victim = key;
    }
  }
  if (victim === null) {
    throw new Error(`REA 并发已满（最多 ${MAX_CLIENTS} 个会话）：等一个分析结束或减少并行 worker`);
  }
  const entry = clients.get(victim);
  try { entry.client.close("evicted"); } catch { /* ignore */ }
  clients.delete(victim);
}

/**
 * 取/建某个会话的 REA 客户端。
 * @param {string} key 会话 id（没有会话上下文时用 "default"）
 * @param {{command:string,args:string[]}} env
 */
export function getReaClient(key, env) {
  if (!env) throw new Error("没有找到 rea 命令：设置 REA_MJS / REA_CMD，或把 rea 放进 PATH");
  const id = String(key || "default");
  const wanted = envKey(env);
  let entry = clients.get(id);
  if (entry && entry.envKey !== wanted) {
    try { entry.client.close("env-changed"); } catch { /* ignore */ }
    clients.delete(id);
    entry = undefined;
  }
  if (!entry) {
    if (clients.size >= MAX_CLIENTS) evictIdle();
    entry = { client: new ReaClient(env), envKey: wanted, lastUsed: Date.now() };
    clients.set(id, entry);
  } else {
    entry.lastUsed = Date.now();
  }
  return entry.client;
}

/** 子会话结束时回收它自己的 REA 进程。 */
export function closeReaClient(key) {
  const id = String(key || "");
  if (!id) return false;
  const entry = clients.get(id);
  if (!entry) return false;
  try { entry.client.close("session-end"); } catch { /* ignore */ }
  clients.delete(id);
  return true;
}

export function closeAllRea() {
  for (const [, entry] of clients) {
    try { entry.client.close("plugin-dispose"); } catch { /* ignore */ }
  }
  clients.clear();
}

/** 插件实例计数：主会话和 worker 各自挂一次，最后一个卸载时才关全部进程。 */
export function retainRea() {
  mounted += 1;
}

export function releaseRea() {
  mounted = Math.max(0, mounted - 1);
  if (mounted === 0) closeAllRea();
}

/** 测试/诊断用。 */
export function reaPoolSize() {
  return clients.size;
}
