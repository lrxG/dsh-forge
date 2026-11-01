/**
 * 破解案件账本工具：crack_case({action, args})。
 *
 * 主线开案件、写目标/验收；worker 开工读案件、结束追加结论。
 * 任务书因此只需要 case id + 本次增量，不用每次把背景重抄一遍。
 */
import { loadDefineTool } from "./tool-loader.js";
import { openCase, getCase, noteCase, updateCase, listCases, caseDirOf, caseCloseout } from "./case-store.js";

const defineTool = loadDefineTool();

export const name = "dsh-forge-crack-case-tools";
export const inject = ["tools"];

function text(value) {
  /* 宿主按 content 数组调用 .some；这里必须返回数组，不能返回单个 block。 */
  return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }];
}

function home() {
  return process.env.DSH_HOME || undefined;
}

function requireId(args) {
  const id = String(args && args.id || "").trim();
  if (!id) throw new Error("缺少 id：先 crack_case list 或让主线给 case id");
  return id;
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: "crack_case",
    description: "破解案件账本（唯一入口）：crack_case({action, args})。open 建/复用案件，get 读案件与 dossier 尾部，note 追加结论/排除方向，update 改状态/目标/验收/交付物，closeout 检查交付门（目标、验收、产物、验证、回滚），list 列案件，path 返回目录。任务书给 case id 时先 get；标 done 前先 closeout。",
    parameters: {
      action: { type: "string", required: true, description: "open | get | note | update | closeout | list | path" },
      args: { type: "object", additionalProperties: true, description: "该动作的参数对象；get/note/update/path 需要 id" },
    },
    output: { schema: { type: "string" }, render: (_args, value) => text(value) },
    async execute(args) {
      const action = String(args && args.action || "").trim().toLowerCase();
      const inner = (args && args.args && typeof args.args === "object" && !Array.isArray(args.args)) ? args.args : {};
      try {
        if (action === "open") {
          return JSON.stringify(openCase(home(), {
            sample: inner.sample,
            goal: inner.goal,
            acceptance: inner.acceptance,
            deliverables: inner.deliverables,
            apply_cmd: inner.apply_cmd,
            rollback_cmd: inner.rollback_cmd,
            verified: inner.verified,
          }), null, 2);
        }
        if (action === "get") {
          return JSON.stringify(getCase(home(), requireId(inner), { tail: inner.tail }), null, 2);
        }
        if (action === "note") {
          return JSON.stringify(noteCase(home(), requireId(inner), inner.text, inner.kind || "note"), null, 2);
        }
        if (action === "update") {
          const id = requireId(inner)
          if (String(inner.status || "") === "done" && inner.force !== true) {
            const check = caseCloseout(home(), id)
            if (!check.ok) {
              return JSON.stringify({
                ok: false,
                error: "交付门没过：先补齐 gaps，或显式 force:true",
                gaps: check.gaps,
                next: "crack_case {action:'closeout', args:{id}} 可随时复查",
              }, null, 2)
            }
          }
          return JSON.stringify(updateCase(home(), id, {
            goal: inner.goal,
            acceptance: inner.acceptance,
            status: inner.status,
            deliverables: inner.deliverables,
            apply_cmd: inner.apply_cmd,
            rollback_cmd: inner.rollback_cmd,
            verified: inner.verified,
          }), null, 2);
        }
        if (action === "closeout") {
          return JSON.stringify(caseCloseout(home(), requireId(inner)), null, 2);
        }
        if (action === "list") {
          return JSON.stringify({ cases: listCases(home(), inner.limit) }, null, 2);
        }
        if (action === "path") {
          return JSON.stringify({ id: requireId(inner), dir: caseDirOf(home(), inner.id) }, null, 2);
        }
        return JSON.stringify({
          ok: false,
          error: "未知动作：" + (action || "(空)"),
          actions: ["open", "get", "note", "update", "closeout", "list", "path"],
        }, null, 2);
      } catch (error) {
        return JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }, null, 2);
      }
    },
  }));
}
