/**
 * 子智能体任务书。
 *
 * 子会话看不到主会话上下文，所以任务书必须自包含：
 * 目标、范围、已知、判据、交付、禁区。
 */
export const DOMAINS = ["webapi", "intranet", "reverse", "verify"];

export function roleForDomain(domain) {
  const key = String(domain || "").trim().toLowerCase();
  if (key === "webapi") return "webapi";
  if (key === "intranet") return "intranet";
  if (key === "reverse") return "reverse";
  return "verify";
}

export function buildBrief({
  domain,
  role,
  engagement,
  objective,
  scope,
  scenario,
  known,
  criteria,
  deliverable,
  forbidden,
}) {
  const d = String(domain || "webapi").trim();
  const r = String(role || roleForDomain(d)).trim();
  /* 派发门要求独立一行 engagement: <id>；缺了会被 tools/pre-execute 直接拒绝。 */
  const engagementLine = String(engagement || "").trim();
  const lines = [
    ...(engagementLine ? ["engagement: " + engagementLine] : []),
    "目标：" + String(objective || "").trim(),
    "范围：" + String(scope || "").trim(),
  ];
  if (scenario) {
    const s = String(scenario).trim();
    lines.push(s.startsWith("场景") ? s : "场景：" + s);
  }
  lines.push(
    "已知：" + String(known || "无").trim(),
    "判据：" + String(criteria || "").trim(),
    "交付：" + String(deliverable || "结论行 + 证据文件路径 + 未测项").trim(),
    "禁区：" + String(forbidden || "不扩大范围；不写穿目标；不删除目标数据；不执行破坏性动作").trim(),
    "",
    "domain: " + d,
    "redteamRole: " + r,
  );
  return lines.join("\n");
}
