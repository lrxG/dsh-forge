/**
 * Agent 认知层的对象约束。
 *
 * 只做最小校验，避免为一个内部状态层引入 schema 依赖。
 */
export const TASK_STATUSES = ["pending", "in_progress", "blocked", "done", "dropped"];
export const HYPOTHESIS_STATUSES = ["open", "supported", "refuted", "verified"];
export const ACTION_STATUSES = ["planned", "running", "done", "failed"];

export function text(value) {
  const v = value === undefined || value === null ? "" : String(value);
  return v.trim();
}

export function requireText(value, label) {
  const v = text(value);
  if (!v) throw new Error(label + " is required");
  return v;
}

export function normalizeTask(input = {}) {
  const title = requireText(input.title, "task.title");
  return {
    parentId: input.parentId ? text(input.parentId) : null,
    domain: text(input.domain) || "webapi",
    title,
    status: TASK_STATUSES.includes(input.status) ? input.status : "pending",
    priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 5,
    detail: text(input.detail),
  };
}

export function normalizeHypothesis(input = {}) {
  return {
    taskId: input.taskId ? text(input.taskId) : null,
    statement: requireText(input.statement, "hypothesis.statement"),
    confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : 0.5,
    status: HYPOTHESIS_STATUSES.includes(input.status) ? input.status : "open",
  };
}

export function normalizeAction(input = {}) {
  return {
    taskId: input.taskId ? text(input.taskId) : null,
    owner: text(input.owner) || "main",
    capability: requireText(input.capability, "action.capability"),
    args: input.args && typeof input.args === "object" ? input.args : {},
    expected: text(input.expected),
    falsify: text(input.falsify),
    status: ACTION_STATUSES.includes(input.status) ? input.status : "planned",
    result: text(input.result),
    evidenceRef: text(input.evidenceRef),
  };
}
