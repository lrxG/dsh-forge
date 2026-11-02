/**
 * 验证清单。
 *
 * 只给判据，不替模型执行；由验证子智能体或主智能体用现有工具跑。
 */
export function verificationPlan({ finding, evidence } = {}) {
  const f = finding && typeof finding === "object" ? finding : {};
  return {
    finding: f.title || f.id || "candidate",
    checks: [
      { id: "baseline", question: "没有 payload 时，基线请求/行为是否一致？" },
      { id: "payload", question: "带 payload 时，差异是否稳定出现？" },
      { id: "replay", question: "换一次请求或换一个入口，是否还能复现？" },
      { id: "alternative", question: "有没有更简单的解释（缓存、CDN、权限误判、前端假象）？" },
      { id: "evidence", question: "原始请求/响应/截图/哈希是否已落库？" },
      { id: "scope", question: "验证是否仍在授权范围内？" },
    ],
    evidence: evidence || null,
    verdict_rule: "至少 baseline + payload + replay + evidence 四项成立，才从 candidate 升为 verified。",
  };
}
