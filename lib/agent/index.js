/**
 * 红队模式的主智能体认知层。
 *
 * 不替代 DSH 的 subagent：主智能体用现有 subagent 工具派单，
 * 这里只负责任务树、上下文、任务书、验证清单和状态记录。
 */
import { loadDefineTool } from "../crack/tool-loader.js";
import { AgentStore } from "./store.js";
import { collectContext, getRedteamStore, recentProgress, renderBriefKnown, renderStateCard, resolveEngagement } from "./context.js";
import { buildBrief, roleForDomain } from "./brief.js";
import { planWave } from "./dispatch.js";
import { verificationPlan } from "./verify.js";
import { selectSkills } from "./router.js";
import { mergeInventory } from "./api-inventory.js";
import { getScenario, scenarioPrompt, tasksForScenario } from "./scenarios.js";
import { normalizeAction, normalizeHypothesis, normalizeTask, requireText } from "./schema.js";

const defineTool = loadDefineTool();

export const name = "dsh-forge-agent";
export const inject = ["tools"];

function text(value) {
  return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }];
}

function fail(error) {
  return JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2);
}

function missionOf(store, args = {}) {
  if (args.mission) {
    const mission = store.getMission(args.mission);
    if (!mission) throw new Error("mission not found: " + args.mission);
    return mission;
  }
  const redteam = getRedteamStore(args.ctx);
  const engagement = resolveEngagement(redteam, args.engagement, { context: args.exec });
  const existing = store.missionForEngagement(engagement);
  if (existing) return existing;
  /* 只有 start 建任务树。其它动作读最近一次（含已关闭），没有就报错，避免读操作偷偷建空树。 */
  const checked = resolveEngagement(redteam, engagement, { validate: true, allowMissingStore: false });
  const found = store.missionForEngagement(checked);
  if (found) return found;
  const latest = store.latestMissionForEngagement(checked);
  if (latest) return latest;
  throw new Error("no mission for engagement " + checked + "; run agent start first");
}

function defaultTasks(store, mission) {
  const tasks = store.listTasks(mission.id);
  if (tasks.length) return tasks;
  for (const def of tasksForScenario(mission.scenario)) store.addTask(mission.id, normalizeTask(def));
  return store.listTasks(mission.id);
}

function taskView(task, home) {
  return {
    ...task,
    role: roleForDomain(task.domain),
    skills: selectSkills({ home, domain: task.domain, query: task.title, limit: 3 }),
  };
}

export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME || undefined;
  const store = new AgentStore(home);
  try { ctx.effect(() => () => store.close()); } catch { /* test stubs */ }

  ctx.tools.register(defineTool({
    name: "agent",
    description:
      "红队主智能体的认知层。先 redteam_engagement_open 建/绑靶标，再 start 建任务树（scenario: pentest=正常渗透|src=SRC赏金|hw=护网行动|ctf=拿flag，默认 pentest）；context 取世界模型；next 取下一波可派任务；brief 生成子智能体任务书；record 记录动作/结果；verify 做最小 PoC 校验（verified 必须有 poc_path/command + evidence_ref）；inventory 合并静态/运行时 API 清单；reflect 记录换路；status/close 收口。子智能体仍用现有 subagent 工具派发。",
    parameters: {
      action: { type: "string", required: true, description: "start | context | next | brief | record | verify | inventory | reflect | status | close" },
      args: { type: "object", additionalProperties: true, description: "动作参数。start:{engagement?,objective?,scenario?}" },
    },
    output: { schema: { type: "string" }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const action = String(args?.action || "").trim().toLowerCase();
      const inner = Object.assign({}, (args?.args && typeof args.args === "object" && !Array.isArray(args.args)) ? args.args : {});
      try {
        const redteam = getRedteamStore(ctx);
        if (!redteam) {
          /* 旧作用域 / 预设切换后可能看不到根服务；读已有 mission 时仍可按显式 engagement 继续。 */
          try { ctx.logger?.warn?.("dsh-forge-agent: redteam store unavailable, falling back to requested engagement"); } catch { /* ignore */ }
        }
        inner.ctx = ctx;
        inner.exec = exec;
        if (action === "start") {
          /* 新建任务树必须确认靶标存在；只修 store 兜底而不校验，会把 mission 写到不存在的 id 上。 */
          const engagement = resolveEngagement(redteam, inner.engagement, { validate: true, allowMissingStore: false, context: exec });
          const requested = inner.scenario ? getScenario(inner.scenario) : null;
          let mission = store.missionForEngagement(engagement);
          let scenarioChanged = false;
          if (!mission) {
            mission = store.createMission({
              engagementId: engagement,
              objective: inner.objective || "",
              scenario: requested ? requested.id : "pentest",
            });
          } else if (requested && mission.scenario !== requested.id) {
            scenarioChanged = store.listTasks(mission.id).length > 0;
            mission = store.updateMission(mission.id, { scenario: requested.id });
          }
          const tasks = defaultTasks(store, mission);
          const scenario = getScenario(mission.scenario);
          const snapshot = collectContext(redteam, engagement);
          return JSON.stringify({
            ok: true,
            mission,
            scenario,
            tasks: tasks.map((task) => taskView(task, home)),
            context: snapshot,
            state_card: renderStateCard({ mission, snapshot, tasks, actions: store.listActions(mission.id), scenario }),
            ...(scenarioChanged ? { warning: "场景已切换，但已有任务树保持不变；要按新场景重建任务树，先 close 再 start。" } : {}),
          }, null, 2);
        }
        if (action === "context") {
          const mission = missionOf(store, inner);
          const snapshot = collectContext(redteam, mission.engagement_id);
          const tasks = store.listTasks(mission.id);
          return JSON.stringify({
            ok: true,
            mission,
            context: snapshot,
            tasks: tasks.map((task) => taskView(task, home)),
            state_card: renderStateCard({
              mission,
              snapshot,
              tasks,
              actions: store.listActions(mission.id),
              scenario: getScenario(mission.scenario),
            }),
          }, null, 2);
        }
        if (action === "next") {
          const mission = missionOf(store, inner);
          const tasks = store.listTasks(mission.id);
          const snapshot = collectContext(redteam, mission.engagement_id);
          const hasCandidates = Boolean(inner.has_candidates)
            || (snapshot.vulns || []).some((vuln) => ["candidate", "pending", "confirmed"].includes(vuln.status));
          const wave = planWave(tasks, { maxWorkers: inner.max_workers, hasCandidates });
          const scenario = getScenario(mission.scenario);
          const progress = recentProgress(store.listActions(mission.id));
          const note = "用 brief 生成任务书后，交给现有 subagent；同域串行，异域可并行；verify 等候选出现再派。场景停止条件：" + scenario.stop_rules.join("；");
          return JSON.stringify({
            ok: true,
            mission,
            scenario: { id: scenario.id, label: scenario.label, goal: scenario.goal, stop_rules: scenario.stop_rules },
            has_candidates: hasCandidates,
            progress,
            wave: {
              ...wave,
              parallel: wave.parallel.map((task) => taskView(task, home)),
              serial: wave.serial.map((task) => taskView(task, home)),
              deferred: (wave.deferred || []).map((task) => taskView(task, home)),
            },
            note: progress.stalled ? note + " " + progress.hint : note,
          }, null, 2);
        }
        if (action === "brief") {
          const mission = missionOf(store, inner);
          const taskId = requireText(inner.task_id, "task_id");
          const task = store.getTask(taskId);
          if (!task || task.mission_id !== mission.id) throw new Error("task not found in mission");
          const snapshot = collectContext(redteam, mission.engagement_id);
          const known = inner.known || [task.detail, renderBriefKnown(snapshot, task.domain)].filter(Boolean).join("；");
          const brief = buildBrief({
            domain: task.domain,
            role: roleForDomain(task.domain),
            engagement: mission.engagement_id,
            objective: inner.objective || task.title,
            scope: inner.scope || ("engagement " + mission.engagement_id),
            scenario: scenarioPrompt(mission.scenario),
            known,
            criteria: inner.criteria || "结论必须附可复现证据；发现不等于验证。",
            deliverable: inner.deliverable || "结论行 + 证据文件路径 + 未测项",
            forbidden: inner.forbidden,
          });
          store.updateTask(task.id, { status: "in_progress" });
          return JSON.stringify({
            ok: true,
            task_id: task.id,
            role: roleForDomain(task.domain),
            scenario: getScenario(mission.scenario).id,
            brief,
            skills: selectSkills({ home, domain: task.domain, query: task.title, limit: 3 }),
          }, null, 2);
        }
        if (action === "record") {
          const mission = missionOf(store, inner);
          const taskId = inner.task_id ? String(inner.task_id) : null;
          const actionRow = store.addAction(mission.id, normalizeAction({
            taskId,
            owner: inner.owner || "main",
            capability: inner.capability,
            args: inner.action_args || inner.args_data,
            expected: inner.expected,
            falsify: inner.falsify,
            status: "done",
            result: inner.result,
            evidenceRef: inner.evidence_ref || inner.evidence,
          }));
          if (taskId) store.updateTask(taskId, { status: inner.task_status || (inner.result ? "done" : "in_progress") });
          let hypothesis = null;
          if (inner.hypothesis) {
            hypothesis = store.addHypothesis(mission.id, normalizeHypothesis({
              taskId,
              statement: inner.hypothesis,
              confidence: inner.confidence,
              status: inner.hypothesis_status,
            }));
          }
          const warnings = [];
          const evidenceRef = inner.evidence_ref || inner.evidence || "";
          if (/http|browser|curl|request/i.test(String(inner.capability || "")) && !evidenceRef) {
            warnings.push("该动作没有 evidence_ref；请用 redteam_http_evidence_add 或等价工具落证据后再升级结论。");
          }
          const progress = recentProgress(store.listActions(mission.id));
          if (progress.stalled) warnings.push(progress.hint);
          return JSON.stringify({ ok: true, action: actionRow, hypothesis, warnings, progress, summary: store.summary(mission.id) }, null, 2);
        }
        if (action === "verify") {
          const mission = missionOf(store, inner);
          const verdict = String(inner.verdict || "").trim().toLowerCase();
          const poc = String(inner.poc_path || inner.poc_command || "").trim();
          const evidenceRef = String(inner.evidence_ref || inner.evidence || "").trim();
          if (verdict === "verified" && (!poc || !evidenceRef)) {
            return JSON.stringify({
              ok: false,
              error: "verified requires poc_path/poc_command and evidence_ref",
              plan: verificationPlan({ finding: inner.finding, evidence: inner.evidence }),
            }, null, 2);
          }
          let actionRow = null;
          if (verdict) {
            actionRow = store.addAction(mission.id, normalizeAction({
              taskId: inner.task_id,
              owner: "verify",
              capability: "poc_verify",
              args: { poc_path: inner.poc_path || "", poc_command: inner.poc_command || "", verdict },
              expected: "复现结论与原始证据一致",
              falsify: "基线/复现/证据任一不成立",
              status: "done",
              result: verdict,
              evidenceRef,
            }));
            if (inner.task_id) store.updateTask(inner.task_id, { status: "done" });
          }
          return JSON.stringify({
            ok: true,
            mission_id: mission.id,
            plan: verificationPlan({ finding: inner.finding, evidence: inner.evidence }),
            verdict: verdict || "pending",
            action: actionRow,
          }, null, 2);
        }
        if (action === "inventory") {
          return JSON.stringify({ ok: true, ...mergeInventory({
            runtime: Array.isArray(inner.runtime) ? inner.runtime : [],
            static: Array.isArray(inner.static) ? inner.static : [],
          }) }, null, 2);
        }
        if (action === "reflect") {
          const mission = missionOf(store, inner);
          const reflection = store.addReflection(mission.id, inner.trigger || "manual", requireText(inner.note || inner.content, "note"));
          return JSON.stringify({ ok: true, reflection, summary: store.summary(mission.id) }, null, 2);
        }
        if (action === "status") {
          const mission = missionOf(store, inner);
          return JSON.stringify({ ok: true, summary: store.summary(mission.id), tasks: store.listTasks(mission.id) }, null, 2);
        }
        if (action === "close") {
          const mission = missionOf(store, inner);
          const summary = store.summary(mission.id);
          const scenario = getScenario(mission.scenario);
          const open = store.listTasks(mission.id).filter((task) => task.status !== "done" && task.status !== "dropped");
          if (open.length && inner.force !== true) {
            return JSON.stringify({ ok: false, error: "还有未收口任务", open_tasks: open, scenario, summary }, null, 2);
          }
          store.updateMission(mission.id, { status: "closed" });
          return JSON.stringify({
            ok: true,
            mission: store.getMission(mission.id),
            scenario: { id: scenario.id, label: scenario.label, goal: scenario.goal, metrics: scenario.metrics, deliverable: scenario.deliverable, stop_rules: scenario.stop_rules },
            summary,
          }, null, 2);
        }
        return JSON.stringify({ ok: false, error: "unknown action: " + action }, null, 2);
      } catch (error) {
        return fail(error);
      }
    },
  }));
}
