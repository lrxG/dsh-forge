/**
 * 真实 token 用量：按「当前任务树」汇总 provider 回报的计费桶。
 *
 * 口径：
 *   · 根 = 本模式最新一个存活根会话（不带 parentSession 的主会话）。
 *   · 子 = 该根的全部后代子智能体（含已不活跃的持久化子会话）。
 *   · 计费桶来自宿主的 tokenUsage 投影：未缓存输入 / 缓存读 / 缓存写 / 输出。
 *   · fork 子会话带父会话前缀，投影会把前缀一起折进去；这里只折子会话自己的
 *     事件段（从 inheritedEventCount 开始），避免和父会话重复计费。
 *
 * 只读宿主投影与会话日志，不触发模型请求，也不产生额外 token。
 */
import { normalizeModeId } from "./inject-config.js";
import { sessionAgentPreset } from "./identity.js";

const RESULT_TTL_MS = 1500;
const RESULT_CACHE_MAX = 8;

const resultCache = new Map();

function zeroBuckets() {
  return {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

function count(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function addInto(target, source) {
  target.uncachedInputTokens += count(source?.uncachedInputTokens);
  target.outputTokens += count(source?.outputTokens);
  target.cacheReadTokens += count(source?.cacheReadTokens);
  target.cacheWriteTokens += count(source?.cacheWriteTokens);
  return target;
}

function totalOf(buckets) {
  return count(buckets?.uncachedInputTokens)
    + count(buckets?.cacheReadTokens)
    + count(buckets?.cacheWriteTokens)
    + count(buckets?.outputTokens);
}

function promptOf(buckets) {
  return count(buckets?.uncachedInputTokens)
    + count(buckets?.cacheReadTokens)
    + count(buckets?.cacheWriteTokens);
}

function sameBuckets(left, right) {
  return left.uncachedInputTokens === right.uncachedInputTokens
    && left.outputTokens === right.outputTokens
    && left.cacheReadTokens === right.cacheReadTokens
    && left.cacheWriteTokens === right.cacheWriteTokens;
}

/** 一条 durable Assistant 结算里带的 usage；与宿主 token-meter 的取法一致。 */
function usageOfEvent(event) {
  if (!event) return null;
  if (event.type === "assistant/message" && event.data?.usage) return event.data.usage;
  if (event.type !== "assistant/message" && event.type !== "assistant/attempt") return null;
  const stream = event.data?.stream;
  if (!Array.isArray(stream)) return null;
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const record = stream[i];
    if (record?.type === "chunk" && record.chunk?.type === "usage" && record.chunk.usage) {
      return record.chunk.usage;
    }
  }
  return null;
}

/**
 * 只折会话自己的事件段。宿主 tokenUsage 投影对 fork 子会话会从 seq 0 开始
 * 折（含父前缀），所以子会话不能直接用投影值。
 *
 * requests = 已结算的 LLM 请求数（按 turn/step 去重）：同一 turn/step 的重复采样
 * 只算一次；llm/retry-started 之后的同 turn/step 采样算新请求（重试也要计费）。
 * 这个数字只用于「常驻上下文 × 请求次数」的累计估算，不参与计费桶。
 */
function foldOwnUsageDetailed(events, inheritedEventCount) {
  let totals = zeroBuckets();
  let requests = 0;
  let last = null;
  const from = Math.max(0, Number(inheritedEventCount) || 0);
  const list = Array.isArray(events) ? events : [];
  for (let i = from; i < list.length; i += 1) {
    const event = list[i];
    if (!event) continue;
    if (event.type === "llm/retry-started") {
      if (last && last.turn === event.data?.turn && last.step === event.data?.step) last = null;
      continue;
    }
    const sample = usageOfEvent(event);
    if (!sample) continue;
    const input = sample.inputTokens;
    const output = sample.outputTokens;
    if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output)) continue;
    const next = {
      uncachedInputTokens: count(input),
      outputTokens: count(output),
      cacheReadTokens: count(sample.cacheReadTokens),
      cacheWriteTokens: count(sample.cacheWriteTokens),
    };
    const turn = event.data?.turn;
    const step = event.data?.step;
    const previous = last && last.turn === turn && last.step === step ? last.buckets : null;
    if (previous && sameBuckets(previous, next)) continue;
    if (previous) {
      totals.uncachedInputTokens -= previous.uncachedInputTokens;
      totals.outputTokens -= previous.outputTokens;
      totals.cacheReadTokens -= previous.cacheReadTokens;
      totals.cacheWriteTokens -= previous.cacheWriteTokens;
    } else {
      requests += 1;
    }
    addInto(totals, next);
    last = { turn, step, buckets: next };
  }
  return { buckets: totals, requests };
}

function foldOwnUsage(events, inheritedEventCount) {
  return foldOwnUsageDetailed(events, inheritedEventCount).buckets;
}

/* 不缓存折叠结果：会话可以被回退/重写，同一 cursor 不代表同一段事件。
   重复请求由下面的任务树结果缓存（1.5s）挡住。 */
function foldLease(lease) {
  return foldOwnUsageDetailed(lease?.events, lease?.inheritedEventCount);
}

function disposeLease(lease) {
  try { if (lease && typeof lease[Symbol.dispose] === "function") lease[Symbol.dispose](); } catch { /* ignore */ }
}

function modeOfHeader(header) {
  try { return normalizeModeId(sessionAgentPreset({ session: { header } })) || ""; } catch { return ""; }
}

/** 本模式最新存活根会话；没有就返回 null（不从历史归档里翻旧任务）。 */
function latestLiveRoot(ctx, mode) {
  let sessions = [];
  try {
    const store = ctx.get?.("sessions");
    sessions = typeof store?.list === "function" ? store.list() : [];
  } catch { sessions = []; }
  let best = null;
  for (const session of sessions) {
    const header = session?.header;
    if (!header || header.parentSession) continue;
    let m = "";
    try { m = normalizeModeId(sessionAgentPreset({ session })) || modeOfHeader(header); } catch { m = modeOfHeader(header); }
    if (m !== mode) continue;
    const created = Number(header.createdAt) || 0;
    if (!best || created > best.createdAt) best = { session, id: session.id, createdAt: created, header };
  }
  return best;
}

async function readRoot(ctx, root) {
  const query = ctx.get?.("sessionQuery");
  if (!query || typeof query.observeSession !== "function") {
    throw new Error("宿主没有 sessionQuery 服务，读不到持久化用量");
  }
  const lease = await query.observeSession(root.id, { projectionMode: "all" });
  try {
    const inherited = Number(lease?.inheritedEventCount) || 0;
    const projected = lease?.projections?.values?.tokenUsage;
    /* 请求次数只能从事件里数，投影不带；桶仍优先用宿主投影。 */
    const folded = foldLease(lease);
    let buckets;
    if (inherited === 0 && projected) {
      buckets = {
        uncachedInputTokens: count(projected.uncachedInputTokens),
        outputTokens: count(projected.outputTokens),
        cacheReadTokens: count(projected.cacheReadTokens),
        cacheWriteTokens: count(projected.cacheWriteTokens),
      };
    } else {
      buckets = folded.buckets;
    }
    return {
      buckets,
      requests: folded.requests,
      pressure: lease?.projections?.values?.contextPressure || null,
    };
  } finally {
    disposeLease(lease);
  }
}

async function readChild(ctx, id) {
  const query = ctx.get?.("sessionQuery");
  if (!query || typeof query.observeSession !== "function") return null;
  const lease = await query.observeSession(id, { projectionMode: "none" });
  try {
    return foldLease(lease);
  } finally {
    disposeLease(lease);
  }
}

async function listChildren(ctx, rootId) {
  try {
    const subagents = ctx.get?.("subagents");
    if (subagents && typeof subagents.listDescendants === "function") {
      const rows = await subagents.listDescendants(rootId);
      return Array.isArray(rows) ? rows.filter((row) => row && row.kind === "child") : [];
    }
  } catch { /* 列不出来就只统计根会话 */ }
  return [];
}

/**
 * 汇总本模式的当前任务树。
 * @param ctx - 宿主插件上下文。
 * @param mode - 已归一的模式 id（redteam / crack）。
 * @returns 真实用量、根会话、子智能体数量与最近一次请求压力。
 */
export async function readTaskTreeUsage(ctx, mode) {
  const key = String(mode || "");
  const hit = resultCache.get(key);
  if (hit && Date.now() - hit.at < RESULT_TTL_MS) return hit.value;

  const empty = () => ({
    ok: true,
    available: false,
    reason: "no-root",
    scope: "task-tree",
    mode: key,
    at: new Date().toISOString(),
    root: null,
    buckets: zeroBuckets(),
    rootBuckets: zeroBuckets(),
    subagentBuckets: zeroBuckets(),
    totalTokens: 0,
    promptTokens: 0,
    sessions: { total: 0, subagents: 0 },
    requests: { root: 0, subagents: 0, total: 0 },
    pressure: null,
    skipped: 0,
    note: "当前模式没有存活的任务根会话；开一条会话后这里才会出真实用量。",
  });

  const root = latestLiveRoot(ctx, key);
  if (!root) {
    const value = empty();
    resultCache.set(key, { at: Date.now(), value });
    return value;
  }

  let rootRead;
  try {
    rootRead = await readRoot(ctx, root);
  } catch (error) {
    const value = {
      ...empty(),
      available: false,
      reason: "error",
      root: { id: root.id, live: true },
      sessions: { total: 1, subagents: 0 },
      note: String(error && error.message ? error.message : error),
    };
    resultCache.set(key, { at: Date.now(), value });
    return value;
  }

  const subagentBuckets = zeroBuckets();
  let subagents = 0;
  let skipped = 0;
  let subagentRequests = 0;
  for (const row of await listChildren(ctx, root.id)) {
    try {
      const own = await readChild(ctx, row.id);
      if (!own) { skipped += 1; continue; }
      addInto(subagentBuckets, own.buckets);
      subagentRequests += own.requests;
      subagents += 1;
    } catch { skipped += 1; }
  }

  const buckets = zeroBuckets();
  addInto(buckets, rootRead.buckets);
  addInto(buckets, subagentBuckets);

  const value = {
    ok: true,
    available: true,
    scope: "task-tree",
    mode: key,
    at: new Date().toISOString(),
    root: { id: root.id, live: true },
    buckets,
    rootBuckets: rootRead.buckets,
    subagentBuckets,
    totalTokens: totalOf(buckets),
    promptTokens: promptOf(buckets),
    sessions: { total: 1 + subagents, subagents },
    requests: {
      root: rootRead.requests || 0,
      subagents: subagentRequests,
      total: (rootRead.requests || 0) + subagentRequests,
    },
    pressure: rootRead.pressure,
    skipped,
    note: "真实用量来自 provider 回报；与按字符估算的提示词构成分开计算，不互相换算。",
  };
  resultCache.set(key, { at: Date.now(), value });
  while (resultCache.size > RESULT_CACHE_MAX) {
    const first = resultCache.keys().next().value;
    if (first === undefined) break;
    resultCache.delete(first);
  }
  return value;
}

export {
  foldOwnUsage as __foldOwnUsageForTest,
  foldOwnUsageDetailed as __foldOwnUsageDetailedForTest,
};
