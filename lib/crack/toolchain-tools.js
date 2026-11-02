/**
 * 逆向执行层工具（crack 模式）：
 *   crack_toolchain       工具链体检 / 安装清单
 *   crack_frida_recipe    Frida 配方列表 / 读取 / 落盘
 *   crack_binary_patch    对副本做字节/NOP 补丁，PE 自动重算 checksum
 */
import { loadDefineTool } from "./tool-loader.js";
import { toolchainStatus, toolchainPlan } from "./toolchain.js";
import { listRecipes, getRecipe, saveRecipe } from "./recipes.js";
import { applyBinaryPatches } from "./binary-patch.js";

const defineTool = loadDefineTool();

export const name = "dsh-forge-crack-reverse-tools";
export const inject = ["tools"];

function text(value) {
  return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }];
}

function fail(error) {
  return JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2);
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: "crack_toolchain",
    description:
      "逆向工具链体检。action=status 列出 jadx/apktool/frida/ghidra/rizin/adb/objection/capa/yara 等是否存在、版本和路径；action=plan 只给缺失工具的安装建议。开测前先跑一次，缺工具要写进结论，不要假装能分析。",
    parameters: {
      action: { type: "string", required: true, description: "status | plan" },
      ids: { type: "array", items: { type: "string" }, description: "只检查这些工具 id；省略检查全部" },
    },
    output: { schema: { type: "string" }, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const action = String(args?.action || "status").trim().toLowerCase();
        if (action === "plan") return JSON.stringify(toolchainPlan(args?.ids), null, 2);
        if (action !== "status") return JSON.stringify({ ok: false, error: "unknown action: " + action }, null, 2);
        return JSON.stringify(toolchainStatus(args?.ids), null, 2);
      } catch (error) {
        return fail(error);
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: "crack_frida_recipe",
    description:
      "Frida 配方。action=list 列出 Android SSL pinning / root 检测绕过 / crypto trace / iOS NSURLSession 追踪；action=get 取脚本全文；action=save 写到 $DSH_HOME/crack/recipes/<id>.js。只提供脚本，不自动 attach。",
    parameters: {
      action: { type: "string", required: true, description: "list | get | save" },
      id: { type: "string", description: "配方 id；get/save 需要" },
      platform: { type: "string", description: "list 时过滤 android / ios" },
    },
    output: { schema: { type: "string" }, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const action = String(args?.action || "list").trim().toLowerCase();
        if (action === "list") return JSON.stringify({ ok: true, recipes: listRecipes(args?.platform) }, null, 2);
        const id = String(args?.id || "").trim();
        if (!id) return JSON.stringify({ ok: false, error: "id is required" }, null, 2);
        if (action === "get") {
          const recipe = getRecipe(id);
          if (!recipe) return JSON.stringify({ ok: false, error: "unknown recipe: " + id }, null, 2);
          return JSON.stringify({ ok: true, ...recipe }, null, 2);
        }
        if (action === "save") {
          return JSON.stringify({ ok: true, ...saveRecipe(id) }, null, 2);
        }
        return JSON.stringify({ ok: false, error: "unknown action: " + action }, null, 2);
      } catch (error) {
        return fail(error);
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: "crack_binary_patch",
    description:
      "对二进制副本打字节补丁。input 原文件，output 必须是新文件；patches 每项支持 offset/rva/va + bytes 或 nop，可带 expect 原字节断言。PE 默认重算 checksum，失败整体中止。dry_run 只验证不落盘。",
    parameters: {
      input: { type: "string", required: true, description: "原文件路径" },
      output: { type: "string", required: true, description: "输出文件路径，必须与 input 不同" },
      patches: {
        type: "array",
        required: true,
        description: "补丁数组；每项 {offset|rva|va, bytes|nop, expect?, note?}",
        items: { type: "object", additionalProperties: true },
      },
      dry_run: { type: "boolean", description: "只验证，不写文件" },
      overwrite: { type: "boolean", description: "output 存在时是否覆盖" },
      update_checksum: { type: "boolean", description: "PE 是否重算 checksum，默认 true" },
    },
    output: { schema: { type: "string" }, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        return JSON.stringify(applyBinaryPatches({
          input: args?.input,
          output: args?.output,
          patches: args?.patches,
          dryRun: args?.dry_run === true,
          overwrite: args?.overwrite === true,
          updateChecksum: args?.update_checksum !== false,
        }), null, 2);
      } catch (error) {
        return fail(error);
      }
    },
  }));
}
