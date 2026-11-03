/**
 * 计划与单元。
 *
 * 主路径只保留一份计划：目标模型 + 单元列表 + 预算。
 * 单元 = 一个入口 × 一个测试类；派活、验证、收口都以它为单位。
 *
 * 状态不落 SQLite：写 `engagements/<id>/plan.json`，和事实库（assets.db）分开。
 * 这样任务计划可以随时重建，不会污染资产/漏洞/证据。
 */
import fs from "node:fs";
import path from "node:path";

export const PLAN_VERSION = 1;
export const DEFAULT_UNIT_CALLS = 20;
export const DEFAULT_UNIT_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_UNITS = 6;
export const MAX_ACTIVE_UNITS = 6;
export const MAX_TOTAL_UNITS = 200;
/** 兼容旧导入；新代码用 MAX_ACTIVE_UNITS。 */
export const MAX_UNITS = MAX_ACTIVE_UNITS;

/** 测试类目录：起始动作、判据、对应技能。 */
export const TEST_CLASS_CATALOG = {
  recon: {
    label: "侦察",
    start: "先被动收集（证书/子域/历史解析/公开接口），再主动确认可达入口；把资产和 surface 落库。",
    success: "新增至少一个可达入口或资产，并落到 asset/surface。",
    falsify: "目标不可达，或所有入口都需要范围外凭据。",
    skills: ["passive-recon", "recon-pipeline"],
  },
  authn: {
    label: "认证",
    start: "枚举登录/注册/找回/邀请/2FA 入口；先正常登录拿基线，再测默认口令、会话固定、JWT 算法/过期、OAuth 回调、Cookie 属性。",
    success: "用错误凭据获得有效会话，或绕过 2FA/重置流程，且能复现。",
    falsify: "所有变体都返回一致的拒绝，且没有状态变化。",
    skills: ["unauth-identity", "browser-automation"],
  },
  authz: {
    label: "越权",
    start: "建两个身份（A/B），抓同一请求，改 id/角色/租户/父对象，做 A→B 的读写差分；同时测强制浏览和接口级权限。",
    success: "A 身份读到或改到 B 的数据/高权限操作，响应里出现 B 的字段或副作用。",
    falsify: "返回 403/404，或返回的数据仍属于 A。",
    skills: ["control-matrix", "object-and-tenant"],
  },
  injection: {
    label: "注入",
    start: "枚举参数/头/Cookie/JSON 字段；先记基线，再用最小 payload 测 SQLi/NoSQL/命令/SSTI/LDAP；用差分而不是报错猜。",
    success: "基线稳定，payload 引发可重复差异（报错、延时、回显、数据变化），换入口仍成立。",
    falsify: "差异不稳定，或被编码/缓存/WAF 页面解释。",
    skills: ["audit-sink-flow", "active-scan"],
  },
  file: {
    label: "文件",
    start: "测上传/下载/导入/导出/解压/包含；看扩展名、内容类型、路径规范化、解析器行为。",
    success: "读到/写入/执行目标范围外的文件，或解析器外带/崩溃可复现。",
    falsify: "路径被规范化、类型被拒绝，或只能写自己的目录。",
    skills: ["exec-surface", "dir-secrets"],
  },
  ssrf: {
    label: "SSRF",
    start: "找 URL 参数、webhook、图片拉取、PDF/截图、代理；用 OAST/DNS 回连确认目标侧发起请求。",
    success: "目标侧真实发起请求（OAST/DNS/内网回显），不是本机代理。",
    falsify: "只有本地回显，或目标不出网且无内网可达证据。",
    skills: ["cloud-native", "audit-surface"],
  },
  logic: {
    label: "业务逻辑",
    start: "画出关键流程（价格/数量/优惠券/退款/审批/邀请/状态机）；测并发、重放、越权审批、负数/边界、顺序绕过。",
    success: "违反业务不变量（0 元支付、超量、重复退款、越权审批），且服务端状态真的变了。",
    falsify: "服务端二次校验一致，或只影响前端显示。",
    skills: ["business-logic", "bounty-triage"],
  },
  client: {
    label: "前端/客户端",
    start: "测 DOM XSS、CSRF、CORS、postMessage、原型链、前端密钥/接口泄露；在真实浏览器里验证执行上下文。",
    success: "脚本在受害者上下文执行，或跨域读到本不该读的数据。",
    falsify: "只有 self-XSS，或浏览器同源策略/HttpOnly 阻断。",
    skills: ["browser-surface", "browser-automation"],
  },
  infra: {
    label: "基础设施",
    start: "端口/服务/默认配置/未授权（Redis/ES/Mongo/Actuator/Swagger）/TLS；先确认版本与暴露面。",
    success: "未授权访问、默认口令或已知漏洞可复现，且能说明影响。",
    falsify: "需要认证且无默认配置，或版本不受影响。",
    skills: ["exposed-services", "nuclei-scan"],
  },
  verify: {
    label: "验证/收口",
    start: "复核已有 candidate 和证据：基线、payload、换入口复现、替代解释；补齐 impact 与 data_nature。",
    success: "候选按验证门复现并写 exploited，或被明确排除。",
    falsify: "证据不足、无法复现，或只是示例/演示数据。",
    skills: ["finding-severity", "control-matrix"],
  },
  reverse: {
    label: "逆向/客户端",
    start: "确认样本类型（JS/APK/PE/ELF/协议），先静态看入口、加密、校验和密钥，再动态跑关键路径；目标是找出可利用的信任边界。",
    success: "找到可复现的密钥/校验绕过/协议缺陷，并说明影响。",
    falsify: "静态和动态都只能看到标准库行为，或关键逻辑在服务端且不可达。",
    skills: ["rev-symbol", "binary-diff"],
  },
};

const SCENARIO_ORDER = {
  pentest: ["authz", "authn", "injection", "logic", "file", "ssrf", "client", "infra"],
  src: ["authz", "logic", "authn", "injection", "ssrf", "file", "client", "infra"],
  hw: ["authn", "infra", "injection", "authz", "ssrf", "file", "logic", "client"],
  ctf: ["injection", "authz", "authn", "file", "ssrf", "client", "logic", "infra"],
};

const SCENARIO_LABEL = {
  pentest: "正常渗透",
  src: "SRC 赏金",
  hw: "护网行动",
  ctf: "CTF",
};

const SCENARIO_BUDGET_MS = {
  pentest: 60 * 60 * 1000,
  src: 30 * 60 * 1000,
  hw: 90 * 60 * 1000,
  ctf: 45 * 60 * 1000,
};

export function inferScenario(text) {
  const s = String(text || "");
  if (/\bctf\b|flag|夺旗|靶场|题目/i.test(s)) return "ctf";
  if (/\bsrc\b|赏金|bounty|漏洞报告|众测|hackerone|bugcrowd/i.test(s)) return "src";
  if (/护网|hw\b|攻防演习|红蓝对抗|蓝队|防守方/i.test(s)) return "hw";
  return "pentest";
}

export function normalizeScenario(value) {
  const id = String(value || "").trim().toLowerCase();
  return SCENARIO_ORDER[id] ? id : "";
}

export function scenarioLabel(id) {
  return SCENARIO_LABEL[normalizeScenario(id) || "pentest"];
}

export function scenarioBudgetMs(id) {
  return SCENARIO_BUDGET_MS[normalizeScenario(id) || "pentest"];
}

export function classOrder(scenario) {
  return [...(SCENARIO_ORDER[normalizeScenario(scenario) || "pentest"] || SCENARIO_ORDER.pentest)];
}

/** 每类的最小起始动作：一句话，用来防止“只注册登录”。 */
const BASELINE_SHORT = {
  authn: "默认口令/会话固定/JWT/OAuth/找回流程",
  authz: "双账号差分/IDOR/租户隔离/强制浏览",
  injection: "参数/头/Cookie/JSON：先基线再 payload",
  logic: "价格/数量/优惠券/退款/审批/并发/重放",
  file: "上传/下载/路径穿越/包含/XXE/解压",
  ssrf: "URL/webhook/图片拉取/PDF：回连确认",
  client: "DOM XSS/CSRF/CORS/postMessage/前端密钥",
  infra: "端口/未授权面板/Actuator/Swagger/TLS",
};

export function baselineAgenda(scenario) {
  return classOrder(scenario).filter((cls) => BASELINE_SHORT[cls]).map((cls) => ({
    class: cls,
    label: TEST_CLASS_CATALOG[cls]?.label || cls,
    first: BASELINE_SHORT[cls],
  }));
}

export function classInfo(testClass) {
  return TEST_CLASS_CATALOG[String(testClass || "").trim().toLowerCase()] || null;
}

export function planPath(store, engagementId) {
  if (!store || typeof store.dirOf !== "function") throw new Error("redteam store unavailable");
  return path.join(store.dirOf(engagementId), "plan.json");
}

export function readPlan(store, engagementId) {
  try {
    const raw = JSON.parse(fs.readFileSync(planPath(store, engagementId), "utf8"));
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.units)) return null;
    return raw;
  } catch {
    return null;
  }
}

export function writePlan(store, engagementId, plan) {
  const file = planPath(store, engagementId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = { ...plan, version: PLAN_VERSION, engagement: String(engagementId), updated_at: new Date().toISOString() };
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(n, max));
}

export function normalizeTargetModel(input, snapshot = {}, objective = "") {
  const raw = input && typeof input === "object" ? input : {};
  const assets = Array.isArray(snapshot.assets) ? snapshot.assets : [];
  const names = assets.slice(0, 5).map((a) => a.names?.[0] || a.ip).filter(Boolean);
  return {
    system: String(raw.system || raw.what || objective || "").trim().slice(0, 300),
    roles: String(raw.roles || "").trim().slice(0, 300),
    objects: String(raw.objects || "").trim().slice(0, 300),
    flows: String(raw.flows || "").trim().slice(0, 500),
    data: ["real", "demo", "unknown"].includes(String(raw.data || "").toLowerCase())
      ? String(raw.data).toLowerCase()
      : "unknown",
    data_basis: String(raw.data_basis || raw.basis || "").trim().slice(0, 300),
    assets: names,
  };
}

function surfaceOfAsset(asset) {
  if (!asset) return "";
  const name = Array.isArray(asset.names) ? asset.names.find(Boolean) : "";
  return String(name || asset.ip || "").trim();
}

function unitId(index) {
  return "u-" + String(index + 1).padStart(3, "0");
}

/** 单元去重键：有 asset_id 用 id，没有就用 surface，最后用匿名序号。 */
export function unitKey(unit) {
  const cls = String(unit?.test_class || "");
  if (unit?.asset_id !== null && unit?.asset_id !== undefined) return `asset:${unit.asset_id}:${cls}`;
  if (unit?.surface) return `surface:${unit.surface}:${cls}`;
  return `anon:${unit?.id || ""}:${cls}`;
}

export function makeUnit({ assetId = null, surface = "", testClass = "recon", priority = 5, budget = {} } = {}) {
  const cls = String(testClass || "recon").toLowerCase();
  const info = classInfo(cls) || classInfo("recon");
  const callBudget = clamp(budget.calls, 4, 120, DEFAULT_UNIT_CALLS);
  const msBudget = clamp(budget.ms, 60_000, 60 * 60 * 1000, DEFAULT_UNIT_MS);
  return {
    id: "",
    asset_id: assetId ?? null,
    surface: String(surface || "").trim(),
    test_class: cls,
    role: cls === "recon" ? "recon" : cls === "verify" ? "verify" : cls === "reverse" ? "reverse" : (cls === "injection" || cls === "infra") ? "vuln-scan" : "assess",
    priority: clamp(priority, 1, 9, 5),
    hypothesis: "",
    success: info.success,
    falsify: info.falsify,
    start: info.start,
    skills: info.skills,
    budget: { calls: callBudget, ms: msBudget },
    status: "pending",
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    verdict: "",
    notes: "",
  };
}

/**
 * 从覆盖缺口生成单元。
 * 没有资产时先给一个 recon 单元；有资产但没缺口时，按场景优先级给前几个资产铺类。
 */
export function buildUnits({ assets = [], gaps = null, scenario = "pentest", target = "", max = DEFAULT_MAX_UNITS, exclude = null } = {}) {
  const cap = clamp(max, 1, MAX_UNITS, DEFAULT_MAX_UNITS);
  const order = classOrder(scenario);
  const units = [];
  const seen = new Set();
  const blocked = exclude instanceof Set ? exclude : new Set(exclude || []);
  const push = (unit, fallbackKey = "") => {
    if (!unit || units.length >= cap) return;
    const key = unit.asset_id !== null && unit.asset_id !== undefined
      ? `asset:${unit.asset_id}:${unit.test_class}`
      : unit.surface
        ? `surface:${unit.surface}:${unit.test_class}`
        : `${fallbackKey || "anon:" + units.length}:${unit.test_class}`;
    if (seen.has(key) || blocked.has(key)) return;
    seen.add(key);
    units.push(unit);
  };

  const items = Array.isArray(gaps?.items) ? gaps.items : [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const missing = Array.isArray(item.missing) ? item.missing : [];
    const ranked = [...missing].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const fallback = item.asset_id !== null && item.asset_id !== undefined
      ? `asset:${item.asset_id}`
      : item.ip || item.surface || `anon:${i}`;
    for (const cls of ranked) {
      if (!classInfo(cls)) continue;
      push(makeUnit({
        assetId: item.asset_id,
        surface: item.ip || item.surface || "",
        testClass: cls,
        priority: order.indexOf(cls) + 1,
      }), fallback);
      if (units.length >= cap) break;
    }
    if (units.length >= cap) break;
  }

  /* 有缺口但都被 exclude 跳过时，不要再走兜底把所有类重新铺一遍。 */
  if (!units.length && items.length === 0) {
    const list = Array.isArray(assets) ? assets : [];
    if (!list.length) {
      push(makeUnit({ surface: target || "target", testClass: "recon", priority: 1 }));
    } else if (gaps && Number(gaps.total_missing_cells ?? -1) === 0) {
      /* 覆盖已经齐了：不再重扫，给一个验证/收口单元复核候选。 */
      const top = list[0];
      push(makeUnit({ assetId: top.id, surface: surfaceOfAsset(top), testClass: "verify", priority: 1 }));
    } else {
      /* 新目标没有覆盖数据：先按 8 类基线铺前 6 个，别只挑 authn。 */
      const top = list.slice(0, 2);
      for (let ai = 0; ai < top.length; ai += 1) {
        const asset = top[ai];
        const surface = surfaceOfAsset(asset);
        for (const cls of order) {
          push(makeUnit({
            assetId: asset.id,
            surface,
            testClass: cls,
            priority: order.indexOf(cls) + 1,
          }), asset.id !== null && asset.id !== undefined ? `asset:${asset.id}` : surface ? `surface:${surface}` : `anon:${ai}`);
          if (units.length >= cap) break;
        }
        if (units.length >= cap) break;
      }
    }
  }

  return units.map((unit, index) => ({ ...unit, id: unitId(index) }));
}

export function normalizeUnits(list, assets = []) {
  const byId = new Map((assets || []).map((a) => [Number(a.id), a]));
  return (Array.isArray(list) ? list : []).map((item, index) => {
    const asset = item.asset_id !== undefined && item.asset_id !== null ? byId.get(Number(item.asset_id)) : null;
    const base = makeUnit({
      assetId: item.asset_id ?? null,
      surface: item.surface || surfaceOfAsset(asset),
      testClass: item.test_class || item.testClass || item.domain || "recon",
      priority: item.priority,
      budget: item.budget || {},
    });
    return {
      ...base,
      ...item,
      id: item.id || unitId(index),
      budget: { ...base.budget, ...(item.budget || {}) },
      skills: Array.isArray(item.skills) && item.skills.length ? item.skills : base.skills,
      status: item.status || "pending",
    };
  });
}

export function createPlan({ engagementId, objective = "", scenario = "pentest", targetModel = {}, units = [] } = {}) {
  const now = new Date().toISOString();
  return {
    version: PLAN_VERSION,
    engagement: String(engagementId),
    objective: String(objective || ""),
    scenario: normalizeScenario(scenario) || "pentest",
    target_model: normalizeTargetModel(targetModel),
    units,
    created_at: now,
    updated_at: now,
    closed_at: null,
  };
}

export function mergeUnits(existing, incoming, cap = MAX_ACTIVE_UNITS) {
  const out = Array.isArray(existing) ? existing.slice() : [];
  const keyOf = unitKey;
  const seen = new Set(out.map(keyOf));
  const usedIds = new Set(out.map((u) => u.id));
  let seq = out.length;
  let active = out.filter((u) => u.status === "pending" || u.status === "in_progress").length;
  for (const unit of incoming || []) {
    /* 上限只约束活跃单元：done/dropped 不占额，否则 8 个跑完就永远加不进新批次。 */
    if (active >= cap) break;
    const key = keyOf(unit);
    if (seen.has(key)) continue;
    seen.add(key);
    let id = unit.id;
    if (!id || usedIds.has(id)) {
      do { id = unitId(seq); seq += 1; } while (usedIds.has(id));
    }
    usedIds.add(id);
    out.push({ ...unit, id });
    active += 1;
  }
  /* 历史只保留总量上限，超过时先丢最老的已结束单元。 */
  if (out.length > MAX_TOTAL_UNITS) {
    const finished = out.filter((u) => u.status === "done" || u.status === "dropped");
    const drop = new Set(finished.slice(0, out.length - MAX_TOTAL_UNITS).map((u) => u.id));
    return out.filter((u) => !drop.has(u.id)).map((unit, index) => ({ ...unit, id: unit.id || unitId(index) }));
  }
  return out.map((unit, index) => ({ ...unit, id: unit.id || unitId(index) }));
}

export function unitBrief(plan, unit, engagementId) {
  const model = plan?.target_model || {};
  const cls = unit.test_class;
  const skills = Array.isArray(unit.skills) && unit.skills.length
    ? unit.skills
    : (classInfo(cls)?.skills || []);
  return [
    `engagement: ${engagementId}`,
    `redteamRole: ${unit.role || "assess"}`,
    `unit: ${unit.surface || "-"} × ${cls}`,
    `test_class: ${cls}`,
    `system: ${model.system || "-"}`,
    `data: ${model.data || "unknown"}`,
    `hypothesis: ${unit.hypothesis || "先确认这个入口是否存在该类问题"}`,
    `success: ${unit.success || "-"}`,
    `falsify: ${unit.falsify || "-"}`,
    `start: ${unit.start || "-"}`,
    `skills: ${skills.join(", ") || "-"}`,
    `budget: ${unit.budget?.calls || DEFAULT_UNIT_CALLS} calls / ${Math.round((unit.budget?.ms || DEFAULT_UNIT_MS) / 60000)} min`,
    "return: verdict(done|blocked) + vuln_id/evidence_id + 未测项（≤5 行）",
  ].join("\n");
}

export function planStatus(plan) {
  const units = Array.isArray(plan?.units) ? plan.units : [];
  const by = (status) => units.filter((u) => u.status === status).length;
  return {
    engagement: plan?.engagement || "",
    scenario: plan?.scenario || "pentest",
    scenario_label: scenarioLabel(plan?.scenario),
    objective: plan?.objective || "",
    data: plan?.target_model?.data || "unknown",
    units: {
      total: units.length,
      active: by("pending") + by("in_progress"),
      pending: by("pending"),
      in_progress: by("in_progress"),
      done: by("done"),
      dropped: by("dropped"),
      budget_exhausted: units.filter((u) => u.budget_exhausted).length,
    },
    next: (() => {
      const unit = units.find((u) => u.status === "in_progress") || units.find((u) => u.status === "pending");
      return unit ? { id: unit.id, surface: unit.surface, test_class: unit.test_class, status: unit.status } : null;
    })(),
    closed_at: plan?.closed_at || null,
  };
}

export function judgeUnit(plan, unitIdValue, args = {}) {
  const unit = (plan?.units || []).find((u) => u.id === String(unitIdValue));
  if (!unit) throw new Error("unit not found: " + unitIdValue);
  const now = Date.now();
  const started = unit.started_at ? Date.parse(unit.started_at) : null;
  const elapsed = started && Number.isFinite(started) ? Math.max(0, now - started) : 0;
  const budgetMs = Number(unit.budget?.ms) || DEFAULT_UNIT_MS;
  const overBudget = elapsed > budgetMs;
  const verdict = String(args.verdict || "").trim().toLowerCase();
  const facts = Number(args.new_facts ?? args.newFacts ?? 0) || 0;
  const notes = String(args.notes || args.note || "").trim();

  let decision = "continue";
  let reason = "";
  if (verdict === "done") {
    unit.status = "done";
    decision = facts > 0 ? "continue" : "switch";
    reason = facts > 0 ? "单元完成，进入下一单元" : "单元完成但没有新事实；下一单元换资产或换测试类";
  } else if (verdict === "blocked") {
    unit.status = "dropped";
    decision = "switch";
    reason = "受阻：记录原因后换单元，不原样重派";
  } else if (verdict === "drop") {
    unit.status = "dropped";
    decision = "switch";
    reason = "主动放弃：预算/收益不划算";
  } else if (overBudget) {
    unit.status = "pending";
    unit.started_at = null;
    unit.budget_exhausted = true;
    decision = "switch";
    reason = "预算用尽：先换单元；确实要续，用 unit reopen:true 并写清理由";
  } else {
    decision = "deepen";
    reason = "继续同一单元，直到判据成立或预算用尽";
  }

  if (verdict === "done" || verdict === "blocked" || verdict === "drop") {
    unit.finished_at = new Date(now).toISOString();
    unit.budget_exhausted = false;
  }
  unit.verdict = verdict || unit.verdict || "";
  unit.notes = notes || unit.notes || "";
  unit.new_facts = facts;
  if (args.vuln_ids) unit.vuln_ids = Array.isArray(args.vuln_ids) ? args.vuln_ids : [args.vuln_ids];
  if (args.evidence_ids) unit.evidence_ids = Array.isArray(args.evidence_ids) ? args.evidence_ids : [args.evidence_ids];

  /* 连续两个已结束单元 0 新事实：不再原地磨，直接建议换资产/换测试类。 */
  const finished = (plan.units || [])
    .filter((row) => row.finished_at)
    .sort((a, b) => String(a.finished_at).localeCompare(String(b.finished_at)));
  let zeroStreak = 0;
  for (let i = finished.length - 1; i >= 0; i -= 1) {
    if (Number(finished[i].new_facts || 0) === 0) zeroStreak += 1;
    else break;
  }
  if (zeroStreak >= 2 && decision === "continue") {
    decision = "switch";
    reason = "连续 " + zeroStreak + " 个单元 0 新事实：换资产或换测试类";
  }

  return {
    unit,
    verdict: verdict || "pending",
    decision,
    reason,
    elapsed_ms: elapsed,
    over_budget: overBudget,
    new_facts: facts,
    facts_per_minute: elapsed > 0 ? Number((facts / (elapsed / 60000)).toFixed(2)) : null,
    zero_fact_streak: zeroStreak,
    weak: facts === 0 && elapsed > 5 * 60 * 1000,
  };
}

export function renderPlanCard(plan) {
  const status = planStatus(plan);
  const unit = status.next;
  return [
    `plan: ${status.engagement} | scenario: ${status.scenario} | data: ${status.data}`,
    `units: ${status.units.total} (pending ${status.units.pending}, in_progress ${status.units.in_progress}, done ${status.units.done}, dropped ${status.units.dropped})`,
    `objective: ${String(status.objective || "-").slice(0, 120)}`,
    unit ? `next: ${unit.id} ${unit.surface || "-"} × ${unit.test_class} | ${unit.hypothesis || "no hypothesis"}` : "next: -",
  ].join("\n");
}
