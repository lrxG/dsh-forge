/**
 * 上下文清单：把「会进入模型上下文的东西」摊开，标清来源、作用域、大小、能不能改。
 *
 * 设计原则：
 *   · 只报告真实存在、真实生效的来源；不把 dsh 代码里的内建段伪装成可编辑文本。
 *   · 面板能改的（操作员注入、规则、角色稿、技能、模板）标 `inline` / `file`；
 *     dsh 代码生成或补丁改写的（人格、工具 schema、计划模式、压缩）标 `none`。
 *   · token 是粗估（中英混排按 2 字符 ≈ 1 token），只用于相对比较和预算感知。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findDshHome, defaultOverrideText } from "./core.js";
import {
  resolveInjectText, readActive, rulePath,
} from "./rules.js";
import { listInstructionFiles } from "./prompt-files.js";
import { loadPlatformConfig, proxyTargets, redteamRoot } from "./redteam/platform-config.js";
import { crackPersonaInfo } from "./crack/index.js";
import { resolveRedteamPersona } from "./redteam/index.js";

const TEMPLATE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_TEMPLATE_BYTES = 256 * 1024;

function readPresetInject(name) {
  try {
    return fs.readFileSync(fileURLToPath(new URL(`../presets/inject/${name}`, import.meta.url)), "utf8").trim();
  } catch {
    return "";
  }
}

const MINIMAL_OPERATOR = readPresetInject("minimal.md")
  || "你是运行在用户本机的本地智能体。按用户当前指令工作；不确定的地方直接说明，不要编造结果。";
const NORMAL_OPERATOR = readPresetInject("redteam.md");

function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 2);
}

function sizeOf(text) {
  const s = String(text || "");
  return { chars: s.length, tokens: estimateTokens(s) };
}

function previewOf(text, max = 600) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function countFiles(dir, out = { files: 0, bytes: 0, names: [] }, depth = 0) {
  if (depth > 4) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) { countFiles(fp, out, depth + 1); continue; }
    if (!e.isFile() || !/\.(md|mdx)$/i.test(e.name)) continue;
    try {
      const st = fs.statSync(fp);
      out.files += 1;
      out.bytes += st.size;
      if (out.names.length < 12) out.names.push(e.name);
    } catch { /* ignore */ }
  }
  return out;
}

function readCrackPersona(home) {
  const info = crackPersonaInfo(home);
  return {
    path: info.path,
    exists: !info.builtin,
    builtin: info.builtin,
    text: info.text,
    source: info.source,
    legacy_ignored: Boolean(info.legacy_ignored),
  };
}

/** 从 preset YAML 里取 persona 的 prefix 块（按缩进找结束）。 */
function readPersonaBlock(home) {
  const fp = path.join(home, ".agent-presets", "redteam", "agent.cordis.yml");
  let raw = "";
  try { raw = fs.readFileSync(fp, "utf8"); } catch { raw = ""; }
  if (!raw) return { path: fp, exists: false, text: "" };
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*prefix:\s*\|/.test(line));
  if (start === -1) return { path: fp, exists: true, text: "" };
  const baseIndent = (lines[start].match(/^\s*/) || [""])[0].length;
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") { body.push(""); continue; }
    const indent = (line.match(/^\s*/) || [""])[0].length;
    if (indent <= baseIndent) break;
    body.push(line.slice(Math.min(indent, baseIndent + 2)));
  }
  const disk = body.join("\n").trim();
  const resolved = resolveRedteamPersona({ plugins: [{ id: "persona", config: { prefix: disk } }] });
  return {
    path: fp,
    exists: true,
    text: resolved.text,
    disk_text: disk,
    source: resolved.source,
    legacy_ignored: Boolean(resolved.legacy),
  };
}

function readToolActionCount() {
  try {
    const fp = path.join(path.dirname(fileURLToPath(import.meta.url)), "redteam", "tools.js");
    const text = fs.readFileSync(fp, "utf8");
    return (text.match(/name:\s*'redteam_[a-z_]+'/g) || []).length;
  } catch { return null }
}

function templateDir(home) { return path.join(home, "dsh-forge", "templates"); }

function listTemplates(home) {
  seedTemplates(home, "");
  const dir = templateDir(home);
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    const id = e.name.slice(0, -3);
    if (!TEMPLATE_ID_RE.test(id)) continue;
    let content = "";
    try { content = fs.readFileSync(path.join(dir, e.name), "utf8"); } catch { continue; }
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, id + ".json"), "utf8")) || {}; } catch { meta = {}; }
    out.push({
      id,
      name: typeof meta.name === "string" && meta.name.trim() ? meta.name : id,
      builtin: meta.builtin === true,
      ...sizeOf(content),
      updated_at: meta.updated_at || null,
    });
  }
  const builtinOrder = { minimal: 0, redteam: 1 };
  return out.sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
    const oa = builtinOrder[a.id] ?? 9;
    const ob = builtinOrder[b.id] ?? 9;
    if (oa !== ob) return oa - ob;
    return a.name.localeCompare(b.name);
  });
}

function seedTemplates(home, operatorText) {
  const dir = templateDir(home);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { return; }
  const metaPath = (id) => path.join(dir, id + ".json");
  const contentPath = (id) => path.join(dir, id + ".md");
  const readMeta = (id) => {
    try { return JSON.parse(fs.readFileSync(metaPath(id), "utf8")) || {}; } catch { return {}; }
  };
  const write = (id, name, content, builtin) => {
    try {
      fs.writeFileSync(contentPath(id), content, "utf8");
      fs.writeFileSync(metaPath(id), JSON.stringify({ name, builtin, updated_at: new Date().toISOString() }, null, 2), "utf8");
    } catch { /* 单个模板失败不影响其它 */ }
  };
  const rename = (id, name) => {
    const meta = readMeta(id);
    if (!meta || meta.name === name) return;
    try {
      fs.writeFileSync(metaPath(id), JSON.stringify({ ...meta, name }, null, 2), "utf8");
    } catch { /* ignore */ }
  };

  /* 最简破甲：旧版本那个 44 字的中性稿会被替换；用户自己写长的内容保持不动。 */
  let minimal = "";
  try { minimal = fs.readFileSync(contentPath("minimal"), "utf8"); } catch { minimal = ""; }
  if (!minimal.trim() || minimal.length < 200) {
    write("minimal", "最简版", MINIMAL_OPERATOR, true);
  } else {
    rename("minimal", "最简版");
  }

  /* 正常（完整）：沿用原来的 redteam.md 作为 id，避免迁移；缺了才从包内补。 */
  let normal = "";
  try { normal = fs.readFileSync(contentPath("redteam"), "utf8"); } catch { normal = ""; }
  if (!normal.trim()) {
    const fallback = NORMAL_OPERATOR || String(operatorText || "").trim();
    if (fallback) write("redteam", "全量版", fallback, true);
  } else {
    rename("redteam", "全量版");
  }
}

/** 读取一个模板内容；不存在返回 null。 */
function readTemplate(home, id) {
  if (!TEMPLATE_ID_RE.test(String(id || ""))) return null;
  try { return fs.readFileSync(path.join(templateDir(home), id + ".md"), "utf8"); } catch { return null; }
}

/** 保存模板（覆盖同名；内置模板不可覆盖）。 */
function saveTemplate(home, id, name, content) {
  const key = String(id || "").trim();
  if (!TEMPLATE_ID_RE.test(key)) throw new Error("模板 id 只允许字母、数字、点、下划线、连字符");
  const text = String(content || "");
  if (!text.trim()) throw new Error("模板内容不能为空");
  if (Buffer.byteLength(text, "utf8") > MAX_TEMPLATE_BYTES) throw new Error("模板太大（上限 256KB）");
  const dir = templateDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const metaPath = path.join(dir, key + ".json");
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(metaPath, "utf8")) || {}; } catch { prev = {}; }
  if (prev.builtin === true) throw new Error("内置模板不能覆盖，换一个 id");
  fs.writeFileSync(path.join(dir, key + ".md"), text, "utf8");
  fs.writeFileSync(metaPath, JSON.stringify({
    name: String(name || key).trim().slice(0, 64) || key,
    builtin: false,
    updated_at: new Date().toISOString(),
  }, null, 2), "utf8");
  return { id: key, name: String(name || key).trim().slice(0, 64) || key, ...sizeOf(text) };
}

function deleteTemplate(home, id) {
  const key = String(id || "").trim();
  if (!TEMPLATE_ID_RE.test(key)) throw new Error("模板 id 不合法");
  const metaPath = path.join(templateDir(home), key + ".json");
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) || {}; } catch { meta = {}; }
  if (meta.builtin === true) throw new Error("内置模板不能删除");
  let removed = false;
  for (const fp of [path.join(templateDir(home), key + ".md"), metaPath]) {
    try { fs.unlinkSync(fp); removed = true; } catch { /* ignore */ }
  }
  return { removed };
}

/**
 * 构建上下文清单。
 * @param {string} [homeArg] DSH_HOME；省略则自动探测。
 */
export async function buildContextInventory(homeArg, modeArg = "") {
  const home = path.normalize(String(homeArg || findDshHome() || ""));
  const mode = String(modeArg || "").trim().toLowerCase();
  const isCrack = mode === "crack";
  const rows = [];
  const push = (row) => {
    const text = String(row.text || "");
    rows.push({ ...row, ...sizeOf(text), preview: previewOf(text), text: undefined });
  };

  /* 1. 操作员注入（真正可编辑、立即生效） */
  const inject = resolveInjectText(home);
  const operatorText = inject.text || defaultOverrideText() || "";
  const operatorSource = inject.source === "prompt" ? "prompt-inject.md" : inject.source === "default" ? "内置默认" : inject.source === "none" ? "空" : inject.source;
  push({
    id: "operator", label: "破甲注入（授权 / 输出纪律）", group: "注入",
    scope: "全局 · 所有会话", source: operatorSource,
    path: path.join(home, "prompt-inject.md"),
    editable: "inline", effective: true, text: operatorText,
    note: "每次组装 system prompt 时悬挂注入；面板改完下一轮生效。DeepSeek Harness 的内建身份句由破甲补丁处理，不在这里。",
  });

  /* 2. 网络出口：面板里配的代理会写进注入提示，这里如实反映。 */
  let egressText = "";
  try {
    const cfg = loadPlatformConfig(redteamRoot());
    const proxy = String((cfg && cfg.egress && cfg.egress.proxy) || "").trim();
    if (proxy) {
      const no = String((cfg && cfg.egress && cfg.egress.noProxy) || "").trim();
      const target = proxyTargets(proxy);
      egressText = target
        ? "网络出口：" + target.host + ":" + target.port
          + "（" + (target.pinned ? "只写了 " + (target.pinned === "socks5" ? "socks" : "http") : "http 与 socks5 同一端口，按任务选") + "）"
          + (target.auth === "user-pass" ? "；带认证" : "")
          + (no ? "；以下目标直连：" + no : "")
        : "网络出口：" + proxy + (no ? "；以下目标直连：" + no : "");
    }
  } catch { /* 配置读不到就按直连 */ }
  push({
    id: "egress", label: "网络出口", group: "全局配置",
    scope: "全局 · 所有会话", source: "环境 → 网络出口",
    editable: "none", effective: !!egressText, text: egressText,
    note: egressText
      ? "已写进系统提示：http:// 与 socks5h:// 两个地址都给出来，模型按工具与目标端口选；目标不是 80/443 时走 socks。改去「环境 → 网络出口」。"
      : "未配置代理，默认直连。改去「环境 → 网络出口」。",
  });

  /* 3. 指令文件：dsh 原生 AGENTS.md / CLAUDE.md 链（用户级 → 共享级 → 项目根 → 当前目录） */
  const activeRule = await readActive(home).catch(() => null);
  let instructionFiles = [];
  try { instructionFiles = listInstructionFiles(home).files.filter((f) => f.exists); } catch { /* 读不到就只跳过这一层 */ }
  for (const f of instructionFiles) {
    let text = "";
    try { text = fs.readFileSync(f.path, "utf8"); } catch { text = ""; }
    const fromRule = activeRule && path.resolve(f.path) === path.resolve(rulePath(home, activeRule));
    const where = f.scope === "user-global" ? "用户级"
      : f.scope === "agents-global" ? "共享级"
        : f.scope === "root" ? "项目根"
          : f.scope === "cwd" ? "当前目录" : "上级目录";
    push({
      id: "instructions:" + f.path, label: "工作区指令 · " + where + " " + f.name, group: "指令",
      scope: f.scopeLabel + " · DeepSeek Harness 工作区指令",
      source: fromRule ? "规则片段 " + activeRule : f.path,
      path: f.path, editable: "file", effective: true, text,
      note: "由 DeepSeek Harness 按 用户级 → 共享级 → 项目根 → 当前目录 顺序读取，总预算 64KB；在「工作区指令」页编辑。",
    });
  }

  /* 4. 主智能体人格：红队读预设 prefix，破解读覆盖文件 */
  if (isCrack) {
    const crack = readCrackPersona(home);
    push({
      id: "persona",
      label: crack.builtin
        ? (crack.legacy_ignored ? "破解主智能体人格（内置默认 · 已忽略旧版覆盖）" : "破解主智能体人格（内置默认）")
        : "破解主智能体人格（覆盖文件）",
      group: "预设",
      scope: "破解会话 · 指挥",
      source: crack.builtin ? "插件内置默认 · lib/crack/index.js" : (crack.source || "crack/persona.md"),
      path: crack.path, editable: crack.builtin ? "none" : "file", effective: true, text: crack.text,
      note: (crack.legacy_ignored
        ? "检测到旧版默认人格（并行开子会话、没有案件账本），已忽略；保存一次覆盖稿即可写入当前版本。"
        : crack.builtin
          ? "没有覆盖文件，运行中生效的是插件内置默认。写一份 $DSH_HOME/crack/persona.md 即可覆盖，重启后生效。"
          : "这是运行中真正生效的那份；内置默认在插件代码里，只在覆盖文件缺失时使用。改完要托盘重启。")
        + (crack.source === "user-local" ? " 当前使用 persona.local.md（优先级高于 persona.md）。" : ""),
    });
  } else {
    const persona = readPersonaBlock(home);
    if (persona.exists) {
      push({
        id: "persona",
        label: persona.legacy_ignored
          ? "红队主智能体人格（随包默认 · 已忽略旧版预设）"
          : "红队主智能体人格（Agent 预设）",
        group: "预设",
        scope: "红队会话 · 指挥",
        source: persona.source === "bundled"
          ? "随包默认 · presets/redteam"
          : persona.source?.startsWith("user:")
            ? persona.source.slice(5)
            : "agent-presets/redteam",
        path: persona.source?.startsWith("user:") ? persona.source.slice(5) : persona.path,
        editable: "file", effective: true, text: persona.text,
        note: (persona.legacy_ignored
          ? "机器上的预设人格是旧版默认（会并行开子会话、没有覆盖矩阵），运行时已用随包默认替换；要自定义请写 $DSH_HOME/redteam/persona.md（优先级最高），或保存一次预设人格。"
          : "面板只改 persona.prefix，写前会重新解析整份预设，解析不过不落盘；保存后需重启 DeepSeek Harness。角色稿在「智能体」页按靶标改。"),
      });
    }
  }

  /* 5. 技能：按需加载，常驻只有目录索引 */
  for (const [id, dir, label] of [
    ["skills-user", path.join(home, "skills"), "技能库（用户）"],
    isCrack
      ? ["skills-crack", path.join(home, "crack", "skills"), "技能库（破解）"]
      : ["skills-redteam", path.join(home, "redteam", "skills"), "技能库（随包）"],
  ]) {
    const stat = countFiles(dir);
    if (!stat.files) continue;
    push({
      id, label, group: "知识", scope: "skill 工具调用时",
      source: `${stat.files} 个文件 · ${(stat.bytes / 1024).toFixed(1)} KB`,
      path: dir, editable: "file", effective: false,
      text: "",
      note: "技能正文只在调用 skill 时进入上下文；常驻的是名称与一句话描述（约 " + stat.files + " 条目录项）。改文件即时生效。示例：" + stat.names.slice(0, 5).join("、"),
    });
  }

  /* 6. 工具：代码生成，面板只读 */
  if (isCrack) {
    push({
      id: "tools", label: "工具目录（破解主会话：终端 / 文件 / 后台任务）", group: "工具",
      scope: "破解会话 · 每次请求", source: "宿主内建；REA 单入口挂在执行角色子会话",
      editable: "none", effective: true, text: "",
      note: "破解主会话不带 REA；执行角色子会话挂一个 rea({action,args}) 入口，只有动作名索引（195 个，约 4.1k 字符）进上下文，参数用 action:\"help\" 现取。",
    });
  } else {
    const actionCount = readToolActionCount();
    push({
      id: "tools", label: "工具目录（红队动作 + 终端 / 文件 / 后台任务）", group: "工具",
      scope: "全局 · 每次请求", source: actionCount ? `红队动作入口 · ${actionCount} 个动作` : "红队动作入口",
      editable: "none", effective: true, text: "",
      note: "工具名与参数定义由 DeepSeek Harness 注册、插件代码生成；面板不提供编辑（改了不生效）。要减开销只能改代码或减少动作。",
    });
  }

  /* 7. DeepSeek Harness 内建段：只读，说明为什么不能改 */
  push({
    id: "dsh-persona", label: "DeepSeek Harness 顶层身份", group: "DeepSeek Harness 内置",
    scope: "全局 · 所有会话", source: "由 DeepSeek Harness 代码生成",
    editable: "none", effective: true, text: "",
    note: "破甲补丁会剥离/改写锁定句（应用状态见“维护 → 补丁”）。面板里编辑这段文本不会生效，要改只能改宿主补丁。",
  });
  push({
    id: "dsh-agent-instructions", label: "DeepSeek Harness 工作区指令", group: "DeepSeek Harness 内置",
    scope: "全局 · 工作区指令", source: "由 DeepSeek Harness 读取 AGENTS.md / CLAUDE.md",
    editable: "none", effective: true, text: "",
    note: "内容来自 DeepSeek Harness 原生 AGENTS.md / CLAUDE.md 链；在「工作区指令」页改，不要在这里改宿主代码。",
  });
  push({
    id: "dsh-plan-compact", label: "DeepSeek Harness 计划模式 / 压缩 / 裁剪", group: "DeepSeek Harness 内置",
    scope: "按状态 · 会话", source: "由 DeepSeek Harness 代码生成",
    editable: "none", effective: false, text: "",
    note: "由 DeepSeek Harness 的计划模式、上下文压缩与工具结果裁剪决定；插件只配置阈值，不替换正文。",
  });

  const known = rows.reduce((acc, r) => {
    if (r.chars) { acc.chars += r.chars; acc.tokens += r.tokens; acc.count += 1; }
    return acc;
  }, { chars: 0, tokens: 0, count: 0 });

  seedTemplates(home, operatorText);
  let actual = null;
  /* 先读该模式自己的快照；没有再退回最近一份（并校验模式对得上）。 */
  if (mode) {
    try {
      actual = JSON.parse(fs.readFileSync(path.join(home, "dsh-forge", `context-last-${mode}.json`), "utf8"));
    } catch { actual = null; }
  }
  if (!actual) {
    try {
      const latest = JSON.parse(fs.readFileSync(path.join(home, "dsh-forge", "context-last.json"), "utf8"));
      /* 有 mode 时才认：旧文件没有 mode 字段，不能拿它冒充任一模的模式快照。 */
      if (mode ? String(latest.mode || "").toLowerCase() === mode : Boolean(latest.mode)) actual = latest;
    } catch { actual = null; }
  }
  return {
    ok: true,
    home,
    mode: mode || "redteam",
    operator: {
      source: operatorSource,
      path: path.join(home, "prompt-inject.md"),
      customized: inject.source === "prompt",
      ...sizeOf(operatorText),
      preview: previewOf(operatorText),
      content: operatorText,
    },
    layers: rows,
    templates: listTemplates(home),
    actual: actual && Array.isArray(actual.sections) ? actual : null,
    total: known,
    note: "Token 为粗估（2 字符 ≈ 1 Token），只用于相对比较；DeepSeek Harness 内建段的大小在代码里，面板拿不到。",
  };
}

/** 应用模板到操作员注入层。 */
export async function applyTemplate(homeArg, id, saveOverride) {
  const home = path.normalize(String(homeArg || findDshHome() || ""));
  const content = readTemplate(home, id);
  if (content === null) throw new Error("模板不存在：" + id);
  const saved = await saveOverride(home, content);
  return { applied: id, saved };
}

export { listTemplates, readTemplate, saveTemplate, deleteTemplate, templateDir, MINIMAL_OPERATOR };
