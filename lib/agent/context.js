/**
 * 把现有 redteam store 压缩成主智能体能用的上下文。
 * 只读，不写事实库。
 */
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
  try {
    if (ctx && ctx.redteam) return ctx.redteam;
    if (ctx && typeof ctx.get === "function") return ctx.get("redteam") || null;
  } catch { /* ignore */ }
  return null;
}

export function resolveEngagement(store, requested) {
  if (!store) throw new Error("redteam store unavailable");
  const id = String(requested || "").trim() || safe(() => store.activeEngagementId(), "");
  if (!id) throw new Error("no active engagement; pass engagement id");
  return id;
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

export function renderBriefKnown(snapshot, domain) {
  if (!snapshot) return "无";
  const parts = [];
  parts.push(`engagement ${snapshot.engagement}`);
  if (snapshot.stats) parts.push(`资产 ${snapshot.stats.assets ?? "?"}`);
  if (snapshot.coverage) parts.push(`覆盖 ${snapshot.coverage.tested_cells ?? "?"}/${snapshot.coverage.cells ?? "?"}，缺口 ${snapshot.coverage.gaps ?? "?"}`);
  const assets = (snapshot.assets || []).slice(0, domain === "webapi" ? 10 : 8);
  if (assets.length) {
    parts.push("资产：" + assets.map((a) => `${a.ip}${a.names?.length ? "(" + a.names.slice(0, 2).join(",") + ")" : ""}`).join("；"));
  }
  if (domain === "webapi" && snapshot.vulns?.length) {
    parts.push("已有候选：" + snapshot.vulns.slice(0, 8).map((v) => `${v.title || v.id}[${v.status}]`).join("；"));
  }
  if (domain === "verify" && snapshot.gaps?.items?.length) {
    parts.push("覆盖缺口：" + snapshot.gaps.items.slice(0, 6).map((x) => `${x.ip}:${(x.missing || []).join("/")}`).join("；"));
  }
  if (domain === "reverse" && snapshot.chain?.length) {
    parts.push("最近链路：" + snapshot.chain.slice(-6).map((x) => x.title).join(" → "));
  }
  return parts.join(" | ");
}

export function renderContext(snapshot) {
  return JSON.stringify(snapshot, null, 2);
}
