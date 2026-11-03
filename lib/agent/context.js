/**
 * 把现有 redteam store 压缩成主智能体能用的上下文。
 * 只读，不写事实库。
 */
import { boundEngagementForContext } from "../redteam/session-bindings.js";

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

function itemsOf(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.items)) return value.items;
  if (value && Array.isArray(value.rows)) return value.rows;
  return [];
}

export function getRedteamStore(ctx) {
  /* 先看当前作用域，再沿 root 找一遍。
     切换预设（standard → redteam）后，工具实例的 ctx 可能挂在旧作用域上，
     此时 root 上的 ctx.redteam 仍然可用；不回退就会误报 store unavailable。 */
  const look = (scope) => {
    if (!scope) return null;
    try { if (scope.redteam) return scope.redteam } catch { /* 未就绪 */ }
    try {
      if (typeof scope.get === "function") return scope.get("redteam") || null
    } catch { /* 未就绪 */ }
    return null;
  };
  const direct = look(ctx);
  if (direct) return direct;
  try {
    const root = ctx && ctx.root;
    if (root && root !== ctx) return look(root);
  } catch { /* ignore */ }
  return null;
}

export function resolveEngagement(store, requested, options = {}) {
  const wanted = String(requested || "").trim();
  /* 没拿到 store 时，读已有 mission 仍可按显式 engagement 继续；
     但 start 新建 mission 必须要求 store，避免把任务树写到不存在的靶标上。 */
  if (!store) {
    if (wanted && options.allowMissingStore !== false) return wanted;
    throw new Error("redteam store unavailable");
  }
  /* 显式 engagement > 当前会话绑定 > 全局 current。
     只认全局 current 会让多会话/面板切靶标时把任务树写到别人的靶标上。 */
  let resolved = wanted;
  if (!resolved && options.context) {
    resolved = safe(() => boundEngagementForContext(options.context), "");
  }
  const id = resolved || safe(() => store.activeEngagementId(), "");
  if (!id) throw new Error("no active engagement; pass engagement id");
  if (!options.validate) return id;
  const rows = safe(() => (typeof store.listEngagements === "function" ? store.listEngagements() : null), null);
  if (!Array.isArray(rows)) return id; /* 老 store / 测试桩没有 listEngagements：保持原行为 */
  const key = id.toLowerCase();
  const hit = rows.find((row) => (
    String(row?.id || "").toLowerCase() === key
    || String(row?.name || "").toLowerCase() === key
  ));
  if (hit) return String(hit.id);
  const candidates = rows.slice(0, 8)
    .map((row) => String(row?.id || "") + (row?.name && String(row.name) !== String(row.id) ? ` (${row.name})` : ""))
    .filter(Boolean)
    .join("; ");
  throw new Error("engagement not found: " + id + (candidates ? "; candidates: " + candidates : "")
    + "; call redteam_engagement_open first");
}

export function collectContext(store, engagementId, options = {}) {
  const limitAssets = Math.max(1, Math.min(Number(options.limitAssets) || 25, 100));
  const limitVulns = Math.max(1, Math.min(Number(options.limitVulns) || 20, 100));
  const limitGaps = Math.max(1, Math.min(Number(options.limitGaps) || 12, 50));

  const stats = safe(() => store.stats(engagementId), null);
  const matrix = safe(() => store.matrixSummary(engagementId), null);
  const gaps = safe(() => store.matrixGaps(engagementId, { limit: limitGaps }), null);
  const assets = itemsOf(safe(() => store.listAssets(engagementId, { limit: limitAssets }), []));
  const vulns = itemsOf(safe(() => store.listVulns(engagementId, { limit: limitVulns }), []));
  const hypotheses = itemsOf(safe(() => store.listHypotheses(engagementId, { limit: 20 }), []));
  const chain = itemsOf(safe(() => store.listChain(engagementId), []));

  return {
    engagement: engagementId,
    stats,
    coverage: matrix,
    gaps: gaps ? {
      assets_with_gaps: gaps.assets_with_gaps,
      total_missing_cells: gaps.total_missing_cells,
      items: (gaps.items || []).map((item) => ({
        asset_id: item.asset_id,
        ip: item.ip,
        missing: item.missing,
        missing_labels: item.missing_labels,
        test_status: item.test_status,
      })),
      hint: gaps.hint,
    } : null,
    assets: assets.map((asset) => ({
      id: asset.id,
      ip: asset.ip,
      scope: asset.scope,
      priority: asset.priority,
      test_status: asset.test_status,
      open_ports: asset.open_ports,
      ports: (asset.ports || []).slice(0, 12).map((port) => ({
        port: port.port,
        state: port.state,
        service: port.service || port.fingerprint?.service || "",
        product: port.product || port.fingerprint?.product || "",
      })),
      names: (asset.names || []).slice(0, 8),
    })),
    vulns: vulns.map((vuln) => ({
      id: vuln.id,
      title: vuln.title,
      severity: vuln.severity,
      status: vuln.status,
      target: vuln.target,
      asset_id: vuln.asset_id,
      cve: vuln.cve,
    })),
    hypotheses: hypotheses.map((h) => ({
      id: h.id,
      statement: h.statement,
      confidence: h.confidence,
      status: h.status,
      task_id: h.task_id,
    })),
    chain: chain.slice(-30).map((step) => ({
      title: step.title,
      stage: step.stage,
      tool: step.tool,
      result: step.result,
    })),
  };
}


