/**
 * 红队主流程工具。
 *
 * 只保留 5 个动作：
 *   plan  — 目标模型 + 单元（入口 × 测试类）+ 预算
 *   unit  — 取自包含任务书，交给 subagent
 *   judge — 单元结束/预算到期做质量判定
 *   status/close
 *
 * 旧动作 start/next/brief/context 作为别名指向新动作，避免老会话突然断掉；
 * record/reflect/verify/inventory 已并入 redteam 事实库与 judge，不再保留。
 */
import { loadDefineTool } from "../crack/tool-loader.js";
import { collectContext, getRedteamStore, resolveEngagement } from "./context.js";
import { selectSkills } from "./router.js";
import {
  buildUnits, baselineAgenda, classOrder, createPlan, inferScenario, judgeUnit, MAX_ACTIVE_UNITS,
  mergeUnits, normalizeScenario, normalizeTargetModel, normalizeUnits, planStatus, readPlan,
  renderPlanCard, scenarioBudgetMs, scenarioLabel, unitBrief, unitKey, writePlan,
} from "./plan.js";

const defineTool = loadDefineTool();

export const name = "dsh-forge-agent";
export const inject = ["tools"];

const ALIASES = {
  start: "plan",
  next: "status",
  brief: "unit",
  context: "status",
};

const REMOVED = {
  record: "记录已并入 redteam 事实库：攻击步骤用 chain_add，漏洞用 vuln_add/update，假设用 hypothesis_*。",
  reflect: "换路直接体现在下一个单元：用 agent plan 重排，或 agent judge 写 notes。",
  verify: "候选验证在 vuln_update 里做：evidence + impact + data_nature；验证清单用 redteam closeout 的 gaps 复核。",
  inventory: "静态/运行时 API 清单已并入 redteam_ingest 与 asset/surface 记录。",
};

function text(value) {
  return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }];
}

function fail(error) {
  return JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2);
}

/** 测试类 → 现有 skill 路由域。 */
function domainForClass(testClass) {
  const cls = String(testClass || "").toLowerCase();
  if (cls === "infra") return "intranet";
  if (cls === "reverse") return "reverse";
  if (cls === "verify") return "verify";
  return "webapi";
}

export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME || undefined;

  ctx.tools.register(defineTool({
    name: "agent",
    description:
      "红队主流程：plan 建目标模型 + 单元（一个入口 × 一个测试类），unit 取自包含任务书交给 subagent，judge 在单元结束/预算到期做质量判定（继续/换路/放弃），status 看计划，close 收口。先 redteam_engagement_open 建/绑靶标；场景从用户话术推断（pentest|src|hw|ctf），也可显式传。子智能体仍用现有 subagent 工具派发。",
    parameters: {
      action: { type: "string", required: true, description: "plan | unit | judge | status | close" },
      args: { type: "object", additionalProperties: true, description: "参数。plan:{engagement?,objective?,scenario?,target_model?,units?,max_units?}；unit:{unit_id}；judge:{unit_id,verdict,new_facts?,notes?}" },
    },
    output: { schema: { type: "string" }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const raw = String(args?.action || "").trim().toLowerCase();
      const action = ALIASES[raw] || raw;
      const inner = Object.assign({}, (args?.args && typeof args.args === "object" && !Array.isArray(args.args)) ? args.args : {});
      try {
        if (REMOVED[action]) {
          return JSON.stringify({ ok: false, error: REMOVED[action], action, next: "plan | unit | judge | status | close" }, null, 2);
        }
        const redteam = getRedteamStore(ctx);
        if (!redteam) {
          try { ctx.logger?.warn?.("dsh-forge-agent: redteam store unavailable, falling back to requested engagement"); } catch { /* ignore */ }
        }
        inner.ctx = ctx;
        inner.exec = exec;

        if (action === "plan") {
          const engagement = resolveEngagement(redteam, inner.engagement, { validate: true, allowMissingStore: false, context: exec });
          const snapshot = collectContext(redteam, engagement);
          const existing = readPlan(redteam, engagement);
          const objective = String(inner.objective || existing?.objective || "").trim();
          const scenario = normalizeScenario(inner.scenario) || existing?.scenario || inferScenario(objective);
          const targetModel = normalizeTargetModel(inner.target_model || existing?.target_model, snapshot, objective);
          /* 上一轮已收口：默认按当前缺口重建，不复用上一轮的 done 单元。 */
          const rebuilt = Boolean(existing?.closed_at) && !(Array.isArray(inner.units) && inner.units.length);
          let units;
          if (Array.isArray(inner.units) && inner.units.length) {
            units = normalizeUnits(inner.units, snapshot.assets);
          } else {
            /* 每次 plan 都从当前矩阵缺口生成候选；跳过已有单元，mergeUnits 只补到活跃上限。 */
            const existingKeys = rebuilt ? new Set() : new Set((existing?.units || []).map(unitKey));
            units = buildUnits({
              assets: snapshot.assets,
              gaps: snapshot.gaps,
              scenario,
              target: inner.target || engagement,
              max: inner.max_units,
              exclude: existingKeys,
            });
          }
          const base = existing || createPlan({ engagementId: engagement, objective, scenario, targetModel, units: [] });
          const plan = writePlan(redteam, engagement, {
            ...base,
            objective,
            scenario,
            target_model: targetModel,
            units: rebuilt ? units : mergeUnits(base.units, units),
            closed_at: null,
          });
          const active = plan.units.filter((u) => u.status === "pending" || u.status === "in_progress");
          const spawn = active.slice(0, MAX_ACTIVE_UNITS).map((u) => ({
            unit_id: u.id,
            tool: "subagent",
            role: u.role,
            test_class: u.test_class,
            prompt: unitBrief(plan, u, engagement),
          }));
          return JSON.stringify({
            ok: true,
            mission: {
              engagement_id: engagement,
              objective,
              scenario,
              scenario_label: scenarioLabel(scenario),
              budget_ms: scenarioBudgetMs(scenario),
              target_model: plan.target_model,
            },
            batch: {
              active_cap: MAX_ACTIVE_UNITS,
              active: active.length,
              total: plan.units.length,
              remaining_gaps: Number(snapshot.gaps?.total_missing_cells || 0),
            },
            spawn,
            baseline: baselineAgenda(scenario),
            state_card: renderPlanCard(plan),
            ...(inner.verbose === true ? { plan } : { plan: { engagement, objective, scenario, target_model: plan.target_model, status: planStatus(plan) } }),
            next: spawn.length
              ? "把 spawn[i].prompt 原文交给 subagent（优先同一消息派 2–3 个），主会话继续验证/串链；跑完一批再 plan 下一批。"
              : "当前批次已满或已完成；先 judge/收口，再 plan 下一批。",
          }, null, 2);
        }

        if (action === "unit") {
          const engagement = resolveEngagement(redteam, inner.engagement, { validate: true, allowMissingStore: false, context: exec });
          const plan = readPlan(redteam, engagement);
          if (!plan) throw new Error("no plan for engagement " + engagement + "; run agent({action:\"plan\"}) first");
          const wanted = String(inner.unit_id || inner.task_id || "").trim();
          if (!wanted) throw new Error("unit_id required");
          const unit = plan.units.find((row) => row.id === wanted);
          if (!unit) throw new Error("unit not found: " + wanted);
          const reopen = inner.reopen === true;
          if ((unit.status === "done" || unit.status === "dropped") && !reopen) {
            return JSON.stringify({ ok: false, error: "unit already " + unit.status + ": " + unit.id + "；要重测请显式传 reopen:true", unit_id: unit.id, status: unit.status }, null, 2);
          }
          if (unit.budget_exhausted && !reopen) {
            return JSON.stringify({ ok: false, error: "unit budget exhausted: " + unit.id + "；续测请显式传 reopen:true 并写清理由", unit_id: unit.id, status: unit.status }, null, 2);
          }
          if (reopen) {
            unit.status = "pending";
            unit.started_at = null;
            unit.finished_at = null;
            unit.verdict = "";
            unit.budget_exhausted = false;
          }
          if (!unit.started_at) unit.started_at = new Date().toISOString();
          if (unit.status === "pending") unit.status = "in_progress";
          const saved = writePlan(redteam, engagement, plan);
          const fresh = saved.units.find((row) => row.id === wanted) || unit;
          const overdue = saved.units.filter((row) => row.status === "in_progress" && row.started_at
            && Date.now() - Date.parse(row.started_at) > (Number(row.budget?.ms) || 600000));
          return JSON.stringify({
            ok: true,
            unit_id: fresh.id,
            role: fresh.role,
            test_class: fresh.test_class,
            surface: fresh.surface,
            brief: unitBrief(saved, fresh, engagement),
            skills: selectSkills({ home, domain: domainForClass(fresh.test_class), query: fresh.hypothesis || fresh.surface, limit: 3 }),
            budget: fresh.budget,
            ...(overdue.length ? {
              warning: "有单元已超预算：" + overdue.map((row) => row.id).join(", ") + "；先用 agent judge 给结论，再开新单元。",
            } : {}),
            next: "把 brief 原文交给 subagent；回包只收 verdict/落库 id/证据路径/未测项。",
          }, null, 2);
        }

        if (action === "judge") {
          const engagement = resolveEngagement(redteam, inner.engagement, { validate: true, allowMissingStore: false, context: exec });
          const plan = readPlan(redteam, engagement);
          if (!plan) throw new Error("no plan for engagement " + engagement + "; run agent({action:\"plan\"}) first");
          const wanted = String(inner.unit_id || inner.task_id || "").trim();
          if (!wanted) throw new Error("unit_id required");
          const judged = judgeUnit(plan, wanted, inner);
          const saved = writePlan(redteam, engagement, plan);
          return JSON.stringify({
            ok: true,
            ...judged,
            plan: planStatus(saved),
            state_card: renderPlanCard(saved),
          }, null, 2);
        }

        if (action === "status") {
          const engagement = resolveEngagement(redteam, inner.engagement, { context: exec });
          const plan = readPlan(redteam, engagement);
          if (!plan) {
            return JSON.stringify({ ok: false, error: "no plan for engagement " + engagement + "; run agent({action:\"plan\"}) first" }, null, 2);
          }
          return JSON.stringify({
            ok: true,
            plan: planStatus(plan),
            state_card: renderPlanCard(plan),
            ...(inner.verbose === true ? { units: plan.units } : {}),
          }, null, 2);
        }

        if (action === "close") {
          const engagement = resolveEngagement(redteam, inner.engagement, { context: exec });
          const plan = readPlan(redteam, engagement);
          if (!plan) {
            return JSON.stringify({ ok: false, error: "no plan for engagement " + engagement + "; run agent({action:\"plan\"}) first" }, null, 2);
          }
          const open = plan.units.filter((u) => u.status !== "done" && u.status !== "dropped");
          if (open.length && inner.force !== true) {
            return JSON.stringify({
              ok: false,
              error: "还有未收口单元",
              open_units: open.map((u) => ({ id: u.id, surface: u.surface, test_class: u.test_class, status: u.status })),
              plan: planStatus(plan),
            }, null, 2);
          }
          /* 单元跑完不等于覆盖完：矩阵还有缺口时不允许静默收口。 */
          let matrixGaps = 0;
          let gapItems = [];
          try {
            const matrix = redteam.matrixSummary(engagement);
            matrixGaps = Number(matrix?.gaps || 0);
            if (matrixGaps > 0) {
              const detail = redteam.matrixGaps(engagement, { limit: 8 });
              gapItems = (detail?.items || []).slice(0, 8).map((g) => ({ ip: g.ip, missing: g.missing }));
            }
          } catch { /* 老库没有矩阵方法时保持兼容 */ }
          if (matrixGaps > 0 && inner.force !== true) {
            return JSON.stringify({
              ok: false,
              error: "覆盖还有 " + matrixGaps + " 个缺口；先 plan 下一批单元，或显式 force 收口",
              matrix_gaps: matrixGaps,
              gap_items: gapItems,
              plan: planStatus(plan),
              next: "agent({action:\"plan\"}) 生成下一批；确实要收口时传 force:true，并在汇报里说明缺口。",
            }, null, 2);
          }
          const saved = writePlan(redteam, engagement, { ...plan, closed_at: new Date().toISOString() });
          return JSON.stringify({
            ok: true,
            plan: planStatus(saved),
            state_card: renderPlanCard(saved),
            ...(matrixGaps > 0 ? { warning: "强制收口：仍有 " + matrixGaps + " 个覆盖缺口未补" } : {}),
          }, null, 2);
        }

        return JSON.stringify({ ok: false, error: "unknown action: " + raw, actions: ["plan", "unit", "judge", "status", "close"] }, null, 2);
      } catch (error) {
        return fail(error);
      }
    },
  }));
}
