import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const DEFAULT_CONTINUE_RETRY = Object.freeze({
  autoRetry: true,
  retryMax: 3,
  // [dsh-forge] 二轮立刻发被拒根因之一:idle 后 280ms 自动续跑与用户 submit 竞态。
  // 关自动续跑,只保留 autoRetry(request-error 自动重试)。
  autoContinue: false,
  continueMax: 3,
  continueText: "继续",
  // 未完成就自动续：这是「做到完」的机制层，不靠模型自觉。
  // 两个判据:①会话里有待办(todo/write)；②收尾纯文本在请示「要不要继续」。
  todoContinue: true,
  todoContinueMax: 5,
  askContinue: true,
  askContinueMax: 3,
  askContinueText: "继续，不用问，按未完成项做完再收尾。",
});

const PERMANENT_CODES = new Set([
  "AUTH",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "INVALID",
  "INVALID_REQUEST",
  "QUOTA",
  "ACCOUNT_QUOTA",
  "BILLING",
  "MODEL_NOT_FOUND",
  "CONTEXT_OVERFLOW",
  "CONTEXT_LENGTH",
  "CONTEXT_WINDOW_EXCEEDED",
  "NO_ADAPTER",
  "MISSING_CREDENTIAL",
  "INVALID_CREDENTIAL",
]);

/** Official already retried these; a new "继续" turn cannot clear them. */
const NO_CONTINUE_CODES = new Set([
  ...PERMANENT_CODES,
  "RATE_LIMIT",
  "TRANSPORT",
]);

const ABNORMAL_KINDS = new Set(["error", "aborted", "interrupted", "max-tokens"]);

export function clampCount(value, fallback = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(20, Math.trunc(n)));
}

export function normalizeConfig(raw = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  const retryMax = clampCount(src.retryMax, DEFAULT_CONTINUE_RETRY.retryMax);
  const continueMax = clampCount(src.continueMax, DEFAULT_CONTINUE_RETRY.continueMax);
  const text = typeof src.continueText === "string" ? src.continueText.trim() : "";
  const todoContinueMax = clampCount(src.todoContinueMax, DEFAULT_CONTINUE_RETRY.todoContinueMax);
  const askContinueMax = clampCount(src.askContinueMax, DEFAULT_CONTINUE_RETRY.askContinueMax);
  const askText = typeof src.askContinueText === "string" ? src.askContinueText.trim() : "";
  return {
    autoRetry: src.autoRetry !== false && retryMax > 0,
    retryMax,
    autoContinue: src.autoContinue !== false && continueMax > 0,
    continueMax,
    continueText: text || DEFAULT_CONTINUE_RETRY.continueText,
    todoContinue: src.todoContinue !== false && todoContinueMax > 0,
    todoContinueMax,
    askContinue: src.askContinue !== false && askContinueMax > 0,
    askContinueMax,
    askContinueText: askText || DEFAULT_CONTINUE_RETRY.askContinueText,
  };
}

export function settingsPath(dshHome) {
  return path.join(dshHome, "dsh-forge", "continue-retry.json");
}

export function loadSettings(dshHome) {
  const fp = settingsPath(dshHome);
  try {
    if (!fs.existsSync(fp)) return {};
    const parsed = JSON.parse(fs.readFileSync(fp, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function mergeConfig(pluginCfg, saved) {
  return normalizeConfig({ ...DEFAULT_CONTINUE_RETRY, ...pluginCfg, ...saved });
}

export function lastTurnEnd(events) {
  const list = Array.isArray(events) ? events : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const event = list[i];
    if (event?.type === "turn/end") return event;
  }
  return null;
}

export function isUserAbort(reason) {
  if (!reason || reason.kind !== "aborted") return false;
  const cause = reason.reason;
  if (cause === "user" || cause === "cancel") return true;
  if (cause && typeof cause === "object") {
    return cause.kind === "user" || cause.kind === "cancel";
  }
  return false;
}

export function isAbnormalReason(reason) {
  return Boolean(reason && ABNORMAL_KINDS.has(reason.kind));
}

export function failureCodeOf(reason) {
  const raw = reason?.error?.code ?? reason?.failure?.code ?? reason?.code;
  return String(raw || "").toUpperCase();
}

export function shouldAutoContinue(reason) {
  if (!isAbnormalReason(reason) || isUserAbort(reason)) return false;
  const code = failureCodeOf(reason);
  return !code || !NO_CONTINUE_CODES.has(code);
}

export function isPermanentFailure(code) {
  return PERMANENT_CODES.has(String(code || "").toUpperCase());
}

export function shouldAutoRetry(failure, signal) {
  if (signal?.aborted) return false;
  return !isPermanentFailure(failure?.code);
}

export function makeContinueMessage(text) {
  const body = String(text || DEFAULT_CONTINUE_RETRY.continueText).trim() || DEFAULT_CONTINUE_RETRY.continueText;
  return {
    id: `dsh-forge-continue-${randomUUID()}`,
    role: "user",
    content: [{ type: "text", text: body }],
    source: {
      kind: "dsh-forge",
      form: "notice",
      summary: "continue",
    },
  };
}

// cordis 没有 session/removed 事件可挂,长开进程 session 一直累积。
// 用 Map 插入顺序做 FIFO 兜底:超过 CAP 就丢最早的一批。
const TRACKER_SESSION_CAP = 200;
const TRACKER_SESSION_EVICT = 50;

export function createTracker() {
  const bySession = new Map();

  function slot(sessionId) {
    const id = String(sessionId || "");
    if (!id) return null;
    let cur = bySession.get(id);
    if (!cur) {
      if (bySession.size >= TRACKER_SESSION_CAP) {
        let i = 0;
        for (const k of bySession.keys()) {
          if (i >= TRACKER_SESSION_EVICT) break;
          bySession.delete(k);
          i += 1;
        }
      }
      cur = { retry: 0, continue: 0, lastContinueSeq: 0, lastRetryKey: "", todoFp: "", todoStall: 0 };
      bySession.set(id, cur);
    }
    return cur;
  }

  return {
    /** 记录 todo 指纹，连续两次没变化就认为卡住（返回 true 表示已经卡住）。 */
    noteTodoFp(sessionId, fp) {
      const cur = slot(sessionId);
      if (!cur) return false;
      if (fp && cur.todoFp === fp) {
        cur.todoStall = (cur.todoStall || 0) + 1;
        return cur.todoStall >= 2;
      }
      cur.todoFp = fp || "";
      cur.todoStall = 0;
      return false;
    },
    resetTodoStall(sessionId) {
      const cur = bySession.get(String(sessionId || ""));
      if (!cur) return;
      cur.todoFp = "";
      cur.todoStall = 0;
    },
    /** 同一个后台任务只拉回一次。 */
    takeJob(sessionId, jobId) {
      const cur = slot(sessionId);
      if (!cur || !jobId) return false;
      if (!cur.jobs) cur.jobs = new Set();
      if (cur.jobs.has(jobId)) return false;
      if (cur.jobs.size >= 200) cur.jobs.clear();
      cur.jobs.add(jobId);
      return true;
    },
    takeRetry(sessionId, key, max) {
      const cur = slot(sessionId);
      if (!cur || max <= 0) return false;
      if (key && cur.lastRetryKey === key) return false;
      if (cur.retry >= max) return false;
      cur.retry += 1;
      cur.lastRetryKey = key || "";
      return true;
    },
    takeContinue(sessionId, seq, max, maxFailStreak = 3) {
      const cur = slot(sessionId);
      if (!cur || max <= 0) return false;
      if (seq && cur.lastContinueSeq === seq) return false;
      if (cur.continue >= max) return false;
      if ((cur.failStreak || 0) >= maxFailStreak) return false;
      cur.continue += 1;
      cur.lastContinueSeq = seq || 0;
      return true;
    },
    refundContinue(sessionId, seq) {
      const cur = slot(sessionId);
      if (!cur || cur.continue <= 0) return;
      cur.continue -= 1;
      // 关键:不清 lastContinueSeq —— 同一 seq 的失败不再重复消耗 continue 预算
      // 关键:记录连续失败次数,达到 maxFailStreak 永久停手(Issue #85)
      cur.failStreak = (cur.failStreak || 0) + 1;
      if (seq) {
        cur.failedSeqs = cur.failedSeqs || new Set();
        // cap:长会话 failedSeqs 永不清(resetIfCompleted 只在 completed/blocked 时清),
        // 失败 seq 累积几千几万 → Set 内存涨。cap 256,超了删最老的(Set 保持 insertion order)。
        if (cur.failedSeqs.size >= 256) {
          const oldest = cur.failedSeqs.values().next().value;
          if (oldest !== undefined) cur.failedSeqs.delete(oldest);
        }
        cur.failedSeqs.add(seq);
      }
    },
    reset(sessionId) {
      const id = String(sessionId || "");
      if (id) bySession.delete(id);
    },
    resetIfCompleted(sessionId, reason, reallyDone = true) {
      if (!reallyDone) return;
      if (reason?.kind === "completed" || reason?.kind === "blocked") {
        const cur = bySession.get(String(sessionId || ""));
        if (cur) { cur.failStreak = 0; cur.failedSeqs = undefined; }
        this.reset(sessionId);
      }
    },
  };
}

export function sessionEventsOf(agent) {
  const session = agent?.session;
  if (!session) return [];
  try {
    if (typeof session.snapshotEvents === "function") return session.snapshotEvents() || [];
  } catch { /* ignore */ }
  try {
    if (Array.isArray(session.events)) return session.events;
  } catch { /* ignore */ }
  return [];
}

export function inspectTurn(events) {
  const end = lastTurnEnd(events);
  const reason = end?.data?.reason || null;
  return {
    seq: end?.seq || 0,
    turn: end?.data?.turn || 0,
    reason,
    abnormal: isAbnormalReason(reason),
    userAbort: isUserAbort(reason),
    auto: shouldAutoContinue(reason),
  };
}

/**
 * 会话里最新的待办清单（`todo/write` 是整表覆盖，取最后一条）。
 * 这是「做没做完」的确定性判据，比猜收尾文本可靠。
 */
export function latestTodos(events) {
  const list = Array.isArray(events) ? events : [];
  let todos = [];
  for (const event of list) {
    if (event?.type !== "todo/write") continue;
    const next = event.data?.todos;
    if (Array.isArray(next)) todos = next;
  }
  return todos;
}

/** 还没完成的条目（pending / in_progress）。 */
export function pendingTodos(todos) {
  return (Array.isArray(todos) ? todos : [])
    .filter((item) => item && item.status !== "completed" && String(item.content || "").trim() !== "");
}

/** 最后一条助手消息的纯文本。 */
export function lastAssistantText(events) {
  const list = Array.isArray(events) ? events : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const event = list[i];
    if (event?.type !== "assistant/message") continue;
    const blocks = event.data?.message?.content;
    if (!Array.isArray(blocks)) return "";
    return blocks.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
  }
  return "";
}

/** 收尾在请示「要不要继续」——这是提前收尾里最常见的一种。 */
const ASK_PATTERN = /(要我(现在|接着|继续|先)|要不要我|是否继续|需要我(继续|接着)|接下来(可以|要|做)|你批准|等你(确认|说|重开|重启)|继续吗|接着(铺|做|测)吗)/;
/** 需要用户本人拍板的，不自动续（花钱、动范围、不可逆）。 */
const HOLD_PATTERN = /(改原件|覆盖原文件|动生产|生产环境|删除|清空|rm -rf|格式化|重装系统|付费|充值|买|授权范围|越权范围)/;

export function isStalledAsk(text) {
  const body = String(text || "");
  if (!body || body.length > 1200) return false;
  if (HOLD_PATTERN.test(body)) return false;
  return ASK_PATTERN.test(body.slice(-400));
}

/** 按待办生成续跑指令，把未完成项直接写进消息。 */
export function todoContinueText(pending, completedCount = 0) {
  const items = (Array.isArray(pending) ? pending : []).slice(0, 8).map((item) => {
    const state = item.status === "in_progress" ? "进行中" : "未开始";
    return `- ${String(item.content || "").trim()}（${state}）`;
  });
  return [
    "继续，不要问我，也不用汇报进度。",
    completedCount > 0 ? `已完成 ${completedCount} 项，还没做完的：` : "待办里还没完成：",
    ...items,
    "按上面的清单逐项做完，做完一项就更新 todo；全部完成再收尾。",
  ].filter(Boolean).join("\n");
}

/** 清单指纹：判断上一轮到底有没有推进。 */
export function todoFingerprint(pending) {
  return (Array.isArray(pending) ? pending : [])
    .map((item) => `${item.status}:${String(item.content || "").trim()}`)
    .join("\n");
}

/** 子会话（执行角色）是「做完就回包」的，不能给它续跑。 */
export function isWorkerSession(agent) {
  try {
    const header = agent?.session?.header;
    if (header && Number(header.delegationDepth) > 0) return true;
    if (/-worker$/i.test(String(header?.agentPreset || ""))) return true;
  } catch { /* 读不到就当主会话 */ }
  return false;
}

/** 还没结束的后台任务：有它在跑时不要自动续，否则只会空转。 */
export function runningJobs(events) {
  const list = Array.isArray(events) ? events : [];
  const open = new Set();
  for (const event of list) {
    const id = event?.data?.jobId;
    if (!id) continue;
    if (event.type === "job/registered") open.add(id);
    else if (event.type === "job/settled" || event.type === "job/failed" || event.type === "job/cancelled") open.delete(id);
  }
  return [...open];
}

/** 上一轮结束后才结束的后台任务（用来把结果拉回来继续，等价 OpenCode 的 auto-resume）。 */
export function jobsSettledAfterLastReply(events) {
  const list = Array.isArray(events) ? events : [];
  let lastSeq = 0;
  for (const event of list) if (event?.type === "assistant/message") lastSeq = event.seq ?? lastSeq;
  return list.filter((event) => event?.type === "job/settled" && (event.seq ?? 0) > lastSeq
    && String(event.data?.jobId || "") !== "");
}

/** 后台任务结束后拉回来的提示：带任务名，让它去读结果接着干。 */
export function jobResumeText(event) {
  const label = String(event?.data?.label || event?.data?.jobId || "").trim().slice(0, 120);
  return [
    `后台任务已结束：${label}`,
    "用 job_output 读结果，接着把没做完的做完；不要问我，也不要只汇报。",
  ].join("\n");
}

export function hasFreshHumanTurn(events) {
  const list = Array.isArray(events) ? events : [];
  const end = lastTurnEnd(list);
  const after = end ? list.filter((event) => (event?.seq || 0) > end.seq) : list;
  return after.some((event) => {
    if (event?.type !== "user/message") return false;
    const kind = event.data?.source?.kind;
    return kind !== "plugin" && kind !== "dsh-forge";
  });
}

export function inboxBusy(agent) {
  try {
    const inbox = agent?.inbox;
    if (!inbox) return false;
    if (typeof inbox.hasPending === "function" && inbox.hasPending()) return true;
    if (typeof inbox.size === "number" && inbox.size > 0) return true;
    if (typeof inbox.length === "number" && inbox.length > 0) return true;
  } catch { /* ignore */ }
  return false;
}

export function sendContinue(agent, text) {
  if (!agent || typeof agent.followup !== "function") {
    return { ok: false, error: "当前会话没有可续跑的 agent" };
  }
  try {
    agent.followup(makeContinueMessage(text));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

export function installContinueRetry(ctx, options = {}) {
  const getConfig = typeof options.getConfig === "function" ? options.getConfig : () => normalizeConfig(options.config);
  const tracker = options.tracker || createTracker();
  const timers = new Set();

  function sessionIdOf(agent) {
    return agent?.id || agent?.session?.id || "";
  }

  function schedule(fn, ms) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
    return timer;
  }

  function listen(event, handler) {
    if (typeof ctx?.on !== "function") return null;
    try {
      return ctx.on(event, handler, { global: true });
    } catch {
      try {
        return ctx.on(event, handler);
      } catch {
        return null;
      }
    }
  }

  function maybeAutoContinue(agent) {
    const cfg = getConfig();
    const id = sessionIdOf(agent);
    if (!id) return;
    /* 执行角色只做任务书那一块，做完就回包；给它续跑会卡住派活的主会话。 */
    if (isWorkerSession(agent)) return;
    if (agent.status === "running" || inboxBusy(agent)) return;
    const events = sessionEventsOf(agent);
    if (hasFreshHumanTurn(events)) return;

    /* 后台任务刚结束：把它拉回来读结果继续（OpenCode 的 auto-resume）。 */
    const settled = jobsSettledAfterLastReply(events);
    const fresh = settled.find((event) => tracker.takeJob(id, event.data?.jobId));
    if (fresh) {
      const sent = sendContinue(agent, jobResumeText(fresh));
      if (!sent.ok) console.warn(`[dsh-forge] job resume send failed (session=${id}):`, sent.error);
      return;
    }
    /* 还有后台任务在跑：现在续只会空转，等它 settled 再说。 */
    if (runningJobs(events).length > 0) return;

    const info = inspectTurn(events);

    /* 三条触发，优先级从硬到软：
       ① 异常中断（error/aborted/max-tokens）→ 原有 autoContinue；
       ② 收尾正常但 todo 还有未完成项 → 确定性续跑；
       ③ 收尾在问「要不要继续」→ 兜底续跑。 */
    const pending = pendingTodos(latestTodos(events));
    const completedCount = latestTodos(events).length - pending.length;
    const abnormal = Boolean(cfg.autoContinue && info.auto);
    const stalled = info.reason?.kind === "completed" && cfg.todoContinue && pending.length > 0;
    const asked = !abnormal && !stalled && info.reason?.kind === "completed"
      && cfg.askContinue && isStalledAsk(lastAssistantText(events));
    if (!abnormal && !stalled && !asked) return;

    /* 连续两轮清单原样不动 = 没推进，别再空转烧 token。 */
    if (stalled && tracker.noteTodoFp(id, todoFingerprint(pending))) {
      console.warn(`[dsh-forge] todo 两轮无变化，停止自动续跑 (session=${id})`);
      return;
    }

    const max = stalled ? cfg.todoContinueMax : asked ? cfg.askContinueMax : cfg.continueMax;
    if (!tracker.takeContinue(id, info.seq, max)) return;
    const text = stalled ? todoContinueText(pending, completedCount)
      : asked ? cfg.askContinueText
        : cfg.continueText;
    const sent = sendContinue(agent, text);
    if (!sent.ok) {
      tracker.refundContinue(id, info.seq);
      console.warn(`[dsh-forge] auto-continue send failed (session=${id}, seq=${info.seq}):`, sent.error);
    }
  }

  const offError = listen("agent/request-error", async (payload, next) => {
    const downstream = typeof next === "function" ? await next() : undefined;
    if (downstream?.kind === "retry") return downstream;
    const cfg = getConfig();
    if (!cfg.autoRetry) return downstream;
    if (!shouldAutoRetry(payload?.failure, payload?.signal)) return downstream;
    const id = sessionIdOf(payload?.agent);
    const key = `${payload?.turn || 0}:${payload?.step || 0}:${payload?.failure?.code || ""}`;
    if (!tracker.takeRetry(id, key, cfg.retryMax)) return downstream;
    // [方案2] 标记 retry pending,让下次 system-prompt/assemble 强制塞 inject
    // (消费一次后由 shouldInjectAssembly 清掉)。user 发消息自然塞,不需要;
    // retry 不是 user 触发,messages 结构没变,必须靠这个 flag 让 assemble 吃到。
    globalThis.__dshForgeRetryPending = true;
    return { kind: "retry" };
  });

  const offStatus = listen("agent/status", (payload) => {
    const agent = payload?.agent;
    if (!agent) return;
    const id = sessionIdOf(agent);
    const events = sessionEventsOf(agent);
    if (payload.status === "running" && hasFreshHumanTurn(events)) tracker.reset(id);
    if (payload.status !== "idle") return;
    /* 只有「真做完」才清计数：todo 还有未完成项时不清，否则每轮都被重置 = 死循环。 */
    const pendingNow = pendingTodos(latestTodos(events));
    tracker.resetIfCompleted(id, inspectTurn(events).reason, pendingNow.length === 0);
    schedule(() => maybeAutoContinue(agent), 280);
  });

  return {
    dispose() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      try { offError?.(); } catch { /* ignore */ }
      try { offStatus?.(); } catch { /* ignore */ }
    },
  };
}
