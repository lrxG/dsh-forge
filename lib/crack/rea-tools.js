/**
 * 破解模式的 REA 单入口：rea({action, args})。
 *
 * 只有一个工具进上下文：描述里放动作名索引，参数结构用
 * action:"help", args:{name:"..."} 现取。完整 schema 不随请求下发。
 *
 * 按会话隔离：同一会话复用同一个 REA 子进程，不同会话各自一个，
 * 避免多个 worker 同时打开不同样本时互相换掉工作现场。
 */
import { getReaClient, closeReaClient, retainRea, releaseRea } from "./rea-client.js";
import { REA_ACTIONS, REA_EXCLUDED, REA_GROUPS } from "./rea-index.js";
import { resolveReaEnvironment } from "./index.js";
import { loadDefineTool } from "./tool-loader.js";

const defineTool = loadDefineTool();

export const name = "dsh-forge-crack-rea-tools";
export const inject = ["tools"];

const excluded = new Set(REA_EXCLUDED);

function indexText(kept) {
  const byGroup = new Map(REA_GROUPS.map((g) => [g.g, []]));
  for (const a of REA_ACTIONS) {
    if (!kept.has(a.n)) continue;
    if (!byGroup.has(a.g)) byGroup.set(a.g, []);
    byGroup.get(a.g).push(a.n);
  }
  const parts = [];
  for (const g of REA_GROUPS) {
    const names = byGroup.get(g.g) || [];
    if (!names.length) continue;
    parts.push(g.label + "：" + names.join("、"));
  }
  return parts.join("｜");
}

function normalizeAction(raw) {
  return String(raw || "").trim().replace(/^mcp__rea__/, "");
}

/** 最近似的动作名，给写错时一个回包纠正的机会。 */
function nearest(name, kept) {
  const target = name.toLowerCase();
  const scored = [];
  for (const n of kept.keys()) {
    let s = 0;
    const m = n.toLowerCase();
    for (let i = 0; i < Math.min(m.length, target.length); i += 1) if (m[i] === target[i]) s += 1;
    if (m.includes(target) || target.includes(m)) s += 5;
    scored.push([s, n]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, 5).map((x) => x[1]);
}

function text(value) {
  /* 宿主按 content 数组调用 .some；这里必须返回数组，不能返回单个 block。 */
  return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }];
}

function sessionKeyOf(exec) {
  try {
    const id = exec?.agent?.session?.id ?? exec?.session?.id;
    if (id !== undefined && id !== null) return String(id);
  } catch { /* ignore */ }
  return "default";
}

export function apply(ctx, config = {}) {
  const allowed = new Set(
    (Array.isArray(config.actions) ? config.actions : [])
      .map((name) => normalizeAction(name))
      .filter(Boolean),
  );
  const kept = new Map(
    REA_ACTIONS
      .filter((a) => allowed.size === 0 || allowed.has(a.n))
      .map((a) => [a.n, a.g]),
  );
  const index = indexText(kept);
  const compactIndex = config.compactIndex === true;
  const descriptionIndex = compactIndex
    ? `索引已收起（共 ${kept.size} 个动作）：用 rea({action:"help"}) 取完整动作名；常用 open_binary、binary_overview、list_strings、search_strings、read_bytes、procedure_info、procedure_pseudo_code、search_procedures、xrefs、inspect_android_package、analyze_javascript_application。`
    : index;

  retainRea();

  ctx.tools.register(defineTool({
    name: "rea",
    description:
      "REA 逆向动作入口（唯一工具）：rea({action, args})。"
      + '参数结构用 action:"help", args:{name:"动作名"} 现取；不带 name 时返回当前角色可用动作。索引：'
      + descriptionIndex,
    parameters: {
      action: { type: "string", required: true, description: "动作名；help 查参数结构" },
      args: { type: "object", additionalProperties: true, description: "该动作的参数对象" },
    },
    output: { schema: { type: "string" }, render: (_a, v) => text(v) },
    async execute(args, exec) {
      const action = normalizeAction(args && args.action);
      const key = sessionKeyOf(exec);
      const client = () => getReaClient(key, resolveReaEnvironment());

      if (action === "help") {
        const want = normalizeAction(args && args.args && args.args.name);
        if (!want) return index;
        if (excluded.has(want)) return `${want} 未开放（属研究账本/场景录制类，已从破解入口移除）`;
        if (!kept.has(want)) {
          const hint = nearest(want, kept).join("、");
          return `${want} 不在当前角色开放范围。近似：${hint || "无"}；可用动作见 action:"help"`;
        }
        try {
          const schemas = await client().listTools();
          const hit = Array.isArray(schemas) ? schemas.find((t) => t && t.name === want) : null;
          if (!hit) return `${want}：拿不到参数结构，直接调用会返回参数错误，按错误提示补参数。`;
          return JSON.stringify({ name: want, description: hit.description, inputSchema: hit.inputSchema }, null, 2);
        } catch (e) {
          return `${want}：${e && e.message ? e.message : String(e)}`;
        }
      }

      if (excluded.has(action)) return `${action} 未开放（已从破解入口移除）`;
      if (!kept.has(action)) {
        const known = REA_ACTIONS.some((item) => item.n === action);
        if (known) return `${action} 不在当前角色开放范围；可用动作见 action:"help"`;
        return `没有这个动作：${action || "(空)"}。近似：${nearest(action, kept).join("、")}；全部动作见 action:"help"`
      }

      const inner = Object.assign({}, (args && args.args && typeof args.args === "object" && !Array.isArray(args.args)) ? args.args : {});
      for (const [k, v] of Object.entries(args || {})) {
        if (k !== "action" && k !== "args") inner[k] = v;
      }

      const env = resolveReaEnvironment();
      if (!env) return "没有找到 rea 命令：设置 REA_MJS / REA_CMD，或把 rea 放进 PATH";
      const result = await client().call(action, inner);
      const content = (result && Array.isArray(result.content)) ? result.content : [];
      const body = content.map((c) => (c && c.type === "text" ? c.text : JSON.stringify(c))).join("\n");
      if (result && result.isError) return `[rea] ${action} 报错：\n${body}`;
      return body || JSON.stringify(result);
    },
  }));

  ctx.effect(() => {
    let disposer = null;
    try {
      disposer = ctx.on("subagent/end", (info) => {
        /* 注册表里的 id 可能是 runId，不一定是 session id；能拿到的键都试一遍。 */
        const ids = [info?.id, info?.session?.id, info?.child?.session?.id]
          .filter((id) => id !== undefined && id !== null)
          .map(String);
        for (const id of new Set(ids)) closeReaClient(id);
      });
    } catch { /* ignore */ }
    return () => {
      try { if (typeof disposer === "function") disposer(); } catch { /* ignore */ }
      releaseRea();
      /* 不主动 closeReaClient('default')：主会话可能还在用；插件整体卸载时 releaseRea 会关全部。 */
    };
  });
}
