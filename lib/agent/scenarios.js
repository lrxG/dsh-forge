/**
 * 场景权重。
 *
 * 核心渗透能力共用；场景只改变目标选择、优先级、停止条件和产出。
 */
export const SCENARIOS = {
  pentest: {
    id: "pentest",
    label: "正常渗透",
    goal: "发现并验证漏洞，覆盖优先；不扩大战果。",
    focus: ["资产 × 测试类覆盖", "候选验证", "可复现证据"],
    priority_domains: ["webapi", "intranet", "reverse", "verify"],
    stop_rules: ["覆盖矩阵完成", "已验证的 finding 足够", "没有新的信息"],
    metrics: ["coverage", "verified_findings", "false_positive_rate"],
    deliverable: "可复现 finding + 影响 + 修复建议",
    commander: "按资产 × 测试类铺覆盖；每个 finding 必须复现；不做持久化、不扩大战果。",
  },
  src: {
    id: "src",
    label: "SRC 赏金",
    goal: "选对目标，拿可提交、可收钱的结果。",
    focus: ["program/scope/奖金/SLA/竞争度", "高性价比 Web/API", "可提交性与重复风险"],
    priority_domains: ["webapi", "reverse", "verify"],
    stop_rules: ["目标不值得继续", "重复风险高", "边际收益低", "没有新的高价值信号"],
    metrics: ["accepted_reports", "bounty_per_hour", "duplicate_rate", "severity"],
    deliverable: "可提交的 PoC + 影响 + 复现步骤",
    commander: "先做 program/scope/奖金/竞争度筛选；优先高价值 Web/API；发现要能提交，不追求打穿。",
  },
  hw: {
    id: "hw",
    label: "护网行动",
    goal: "拿入口、扩战果、保控制；目标达成优先。",
    focus: ["入口与初始访问", "权限/横向/核心目标", "持久化与通道", "检测风险"],
    priority_domains: ["webapi", "intranet", "reverse", "verify"],
    stop_rules: ["目标达成", "暴露风险超过收益", "通道/权限不可持续"],
    metrics: ["objective_completion", "access_depth", "dwell_time", "detection_events"],
    deliverable: "攻击路径 + 权限/访问证据 + 时间线",
    commander: "低噪声推进；入口→权限→横向→核心目标；每一步评估检测风险；持久化和通道服务于战果。",
  },
  ctf: {
    id: "ctf",
    label: "CTF",
    goal: "以最短路径拿到 flag。",
    focus: ["判题型与入口", "最短利用链", "flag 格式与来源验证"],
    priority_domains: ["webapi", "reverse", "verify"],
    stop_rules: ["flag 已拿到", "同一思路连续失败", "时间预算耗尽"],
    metrics: ["time_to_flag", "attempts", "category", "hint_used"],
    deliverable: "flag + exploit + 关键输出",
    commander: "先判题型和入口，再找最短利用链；不为覆盖而扫，不为隐蔽而降速；flag 必须验证。",
  },
};

export const SCENARIO_IDS = Object.keys(SCENARIOS);

export function getScenario(id) {
  const key = String(id || "").trim().toLowerCase();
  return SCENARIOS[key] || SCENARIOS.pentest;
}

export function tasksForScenario(id) {
  const scenario = getScenario(id);
  if (scenario.id === "ctf") {
    return [
      { domain: "webapi", title: "判题型与入口", priority: 1, detail: "识别 category、入口、已知提示；找最短路径，不做全量扫描。" },
      { domain: "reverse", title: "分析与利用", priority: 2, detail: "按题型选择脚本/逆向/协议分析；目标只有一个：拿到 flag。" },
      { domain: "verify", title: "flag 验证", priority: 3, detail: "提交前验证 flag 格式与来源；保留 exploit 和输出。" },
    ];
  }
  if (scenario.id === "src") {
    return [
      { domain: "webapi", title: "program 与高价值面", priority: 1, detail: "scope、奖金、SLA、竞争度、账号要求；优先 API/越权/业务逻辑/认证。" },
      { domain: "reverse", title: "前端/客户端线索", priority: 2, detail: "只在 JS/客户端藏接口、加密或校验时投入。" },
      { domain: "verify", title: "提交前复核", priority: 3, detail: "确认 scope、重复风险、可复现证据和影响；不能提交就不算结果。" },
    ];
  }
  if (scenario.id === "hw") {
    return [
      { domain: "webapi", title: "入口与初始访问", priority: 1, detail: "优先低噪声入口；确认可用权限，不急着全量扫描。" },
      { domain: "intranet", title: "权限与横向", priority: 2, detail: "凭据、服务、横向、核心目标；每一步看检测风险。" },
      { domain: "reverse", title: "客户端与规避面", priority: 3, detail: "仅在需要时分析客户端/二进制/协议；服务战果。" },
      { domain: "verify", title: "战果与通道复核", priority: 4, detail: "确认访问可持续、证据可回溯；不可持续就换路。" },
    ];
  }
  return [
    { domain: "webapi", title: "Web/API 面盘点与验证", priority: 1, detail: "接口、认证、越权、注入、业务逻辑；先出候选再验证。" },
    { domain: "intranet", title: "内网可达面与凭据", priority: 2, detail: "只从已确认入口延伸；服务、凭据、横向、隧道。" },
    { domain: "reverse", title: "客户端/二进制面", priority: 3, detail: "JS/APK/原生；找隐藏接口、加密、签名、校验。" },
    { domain: "verify", title: "验证与收口", priority: 4, detail: "只验证候选，不扩大攻击面；证据不全不升级。" },
  ];
}

export function scenarioPrompt(id) {
  const scenario = getScenario(id);
  return `场景：${scenario.label}。目标：${scenario.goal} 侧重：${scenario.focus.join("、")}。优先级：${scenario.priority_domains.join("/")}。产出：${scenario.deliverable}。${scenario.commander}`;
}
