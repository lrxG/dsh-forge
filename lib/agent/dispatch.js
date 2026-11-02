/**
 * 派单/并行判断。
 *
 * 规则：
 * - 同一 domain 串行，避免同目标互相踩；
 * - 不同 domain 且无依赖可并行；
 * - 同时最多 maxWorkers 个；
 * - 父任务未完成时，子任务先不派。
 */
export function planWave(tasks, options = {}) {
  const maxWorkers = Math.max(1, Math.min(Number(options.maxWorkers) || 3, 5));
  const list = Array.isArray(tasks) ? tasks : [];
  const done = new Set(list.filter((task) => task.status === "done").map((task) => task.id));
  const ready = [];
  const deferred = [];
  for (const task of list) {
    if (task.status !== "pending" && task.status !== "in_progress") continue;
    if (task.parent_id && !done.has(task.parent_id)) continue;
    if ((task.domain || "webapi") === "verify" && options.hasCandidates !== true) {
      deferred.push(task);
      continue;
    }
    ready.push(task);
  }
  ready.sort((a, b) => (Number(a.priority) || 5) - (Number(b.priority) || 5));

  const parallel = [];
  const serial = [];
  const seenDomains = new Set();
  for (const task of ready) {
    const domain = task.domain || "webapi";
    if (seenDomains.has(domain)) {
      serial.push(task);
      continue;
    }
    if (parallel.length < maxWorkers) {
      parallel.push(task);
      seenDomains.add(domain);
    } else {
      serial.push(task);
    }
  }
  return {
    parallel,
    serial,
    deferred,
    reason: deferred.length
      ? "验证任务等候选出现后再派；其余按域并行/串行。"
      : parallel.length > 1
        ? "不同域可并行；同域和超额的排后串行。"
        : "当前只适合一条线推进。",
  };
}
