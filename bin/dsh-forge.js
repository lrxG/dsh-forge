#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../lib/core.js";
import * as rules from "../lib/rules.js";
import * as wording from "../lib/wording.js";
import * as stego from "../lib/stego.js";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "data");
const TOOL_MODES = ["--wording", "--stego", "--models"];

const args = process.argv.slice(2);

function printStatus(state) {
  const out = [];
  out.push("dsh-forge 状态 / Status");
  out.push("  宿主 / surface " + (state.surface || "web"));
  out.push("  DSH_HOME      " + state.dsh_home);
  if (state.desktop_install) out.push("  桌面安装       " + state.desktop_install);
  if (state.ai_base) {
    out.push("  插件根 / root  " + state.ai_base);
    for (const [key, fp] of Object.entries(state.files)) {
      out.push(`    ${key.padEnd(22)} ${fp}`);
    }
  } else {
    out.push("  插件根 / root  " + core.missingAiBaseMessage());
  }
  out.push(`  shim 目录      ${state.shim_dir || "未定位 / not found"}`);
  out.push(`  备份 / backup  ${state.has_backup ? "有 / yes" : "无 / no"}`);
  out.push(`  注入文件       ${state.override_path}`);
  out.push(`  注入状态       ${state.override_status}`);
  out.push("");
  out.push(`  补丁 ${state.patches_applied}/${core.ALL_PATCHES.length} 已清洗, ${state.patches_pending} 待清洗`);
  for (const p of core.ALL_PATCHES) {
    const s = state.patch_status[p.id];
    const mark = s === "applied" ? "✓" : s === "pending" ? "✗" : "·";
    out.push(`    ${mark} [#${String(p.id).padEnd(2)}] ${p.name.padEnd(30)} ${p.layer}/${p.layer_en} — ${s}`);
  }
  out.push("");
  out.push(`  shim: dsh.cmd=${state.shim_cmd}  dsh.ps1=${state.shim_ps1}  dsh=${state.shim_bin}`);
  return out.join("\n");
}

function readStdinSafe() {
  try { return fs.readFileSync(0, "utf8"); } catch { return ""; }
}

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** --wording / --stego / --models：纯本地工具，不需要宿主状态。 */
async function runTool(mode) {
  if (mode === "--models") {
    const fp = path.join(DATA_DIR, "model_profiles.json");
    let data;
    try { data = JSON.parse(fs.readFileSync(fp, "utf8")); }
    catch { console.error(`读不到 ${fp}`); process.exit(1); }
    const fams = data.families ?? {};
    const only = args.slice(1).find((a) => a && !a.startsWith("--"));
    if (only && !fams[only]) {
      console.error(`未知家族: ${only}（可用：${Object.keys(fams).join(", ")}）`);
      process.exit(1);
    }
    for (const name of only ? [only] : Object.keys(fams)) {
      console.log(`\n=== ${name} ===`);
      for (const [k, v] of Object.entries(fams[name] ?? {})) {
        if (Array.isArray(v)) console.log(`  ${k}: ${v.join(" / ")}`);
        else if (v && typeof v === "object") console.log(`  ${k}: ${JSON.stringify(v)}`);
        else console.log(`  ${k}: ${v}`);
      }
    }
    return;
  }

  if (mode === "--wording") {
    const engine = new wording.WordingEngine();
    const src = args[1];
    if (!src || src === "--list") { console.log(engine.describe()); return; }
    const text = src === "-" ? readStdinSafe() : fs.readFileSync(src, "utf8");
    const g = argValue("--groups");
    const groups = g ? g.split(",").map((s) => s.trim()).filter(Boolean) : null;
    const r = engine.transform(text, groups);
    process.stdout.write(r.text.endsWith("\n") ? r.text : `${r.text}\n`);
    if (args.includes("--report")) process.stderr.write(`${wording.renderChanges(r.changes)}\n`);
    return;
  }

  if (mode === "--stego") {
    const op = (args[1] || "scan").toLowerCase();
    let idx = 2;
    let channel = "";
    const maybe = (args[idx] || "").toLowerCase();
    if (["vs", "tag", "zw"].includes(maybe)) { channel = maybe; idx += 1; }
    const raw = args[idx];
    const text = !raw || raw === "-" ? readStdinSafe() : raw;

    if (op === "encode") {
      const out = stego.encode(text, channel || "vs");
      process.stderr.write(`encode ${channel || "vs"}: ${text.length} 字符 → ${out.length} 个不可见码位\n`);
      process.stdout.write(`${out}\n`);
      return;
    }
    if (op === "decode") {
      const r = stego.decode(text, channel || undefined);
      process.stderr.write(`channel=${r.channel} base=${r.base ?? "-"} auto=${r.auto}\n`);
      process.stdout.write(`${r.text || ""}\n`);
      return;
    }
    console.log(stego.renderScan(stego.scan(text)));
    return;
  }
}

async function main() {
  const mode = args.find((a) => ["--apply", "--revert", "--uninstall", "--status", "--edit", "--help", ...TOOL_MODES].includes(a));

  if (TOOL_MODES.includes(mode)) return runTool(mode);

  if (mode === "--help" || args.includes("-h")) {
    console.log(`dsh-forge 用法:
  dsh-forge --status          显示状态
  dsh-forge --apply           应用全部清洗（提示词+代码+shim+override）
  dsh-forge --revert          回滚还原
  dsh-forge --uninstall       卸载插件（已应用则先还原）
  dsh-forge --edit            编辑注入文件 prompt-inject.md

  本地工具（不碰宿主）:
  dsh-forge --wording --list           术语组统计
  dsh-forge --wording <文件|-> [--groups a,b] [--report]
                                       措辞转换（拒绝是词级锚定）
  dsh-forge --stego scan <文本|->      扫描 VS / Tag / 零宽隐写
  dsh-forge --stego encode [vs|tag|zw] <文本|->
  dsh-forge --stego decode [vs|tag|zw] <文本|->
  dsh-forge --models [家族]            多模型画像（有效手法 / 死路 / 松紧度）

  dsh-forge --help             帮助`);
    return;
  }

  const state = await core.gatherState();
  console.log(printStatus(state));
  console.log("");

  if (mode === "--apply") {
    if (!state.ai_base) {
      console.log("[ERROR] " + core.missingAiBaseMessage());
      console.log("  fix: 把 DSH_BASE 指到含 dsh-agent-instructions/lib 的 @deepseek-ai 目录");
      process.exit(1);
    }
    const inject = rules.resolveInjectText(state.dsh_home);
    if (!inject.text) {
      console.log("[ERROR] 提示词和规则集都是空的，必须先添加提示词");
      process.exit(1);
    }
    const { hosts, report } = await core.applyPatchesAllHosts(core.ALL_PATCHES, {
      preserveClientBundles: false,
      forApply: true,
    });
    for (const h of hosts) console.log(`  宿主 / host → ${h.aiBase}`);
    for (const r of report) {
      const m = r.status === "applied" ? "✓ 已清洗" : r.status === "already" ? "- 已是最新" : r.status === "missing_file" ? "⚠ 文件缺失" : `✗ ${r.status}`;
      console.log(`  ${m} patch #${String(r.patch_id).padEnd(2)} ${r.name}`);
    }
    const flashHost = hosts[0]?.aiBase || state.ai_base;
    const flash = core.silenceCmdFlash(flashHost);
    console.log(`  cmd-flash=${flash.entry} phase-1=${flash.phase1} ok=${flash.ok}`);
    if (hosts.length > 1) {
      console.log(`  多宿主 / multi-host: ${hosts.length} 份 @deepseek-ai 已清洗`);
    }
    console.log(inject.source === "rule"
      ? "  - 使用当前规则集，不改写提示词文件"
      : "  - 使用已有提示词文件");
    if (state.shim_dir) {
      const r = await core.patchShim(state.shim_dir);
      for (const [fname, st] of Object.entries(r)) {
        if (st === "patched") console.log(`  ✓ shim ${fname} 注入 / injected`);
        else if (st === "already_patched") console.log(`  - shim ${fname} 已注入 / already injected`);
        else if (st === "missing") console.log(`  - shim ${fname} 不存在 / missing`);
        else console.log(`  ⚠ shim ${fname}: ${st}`);
      }
    } else {
      console.log("  ⚠ 未定位 shim 目录，跳过注入");
    }
    console.log("");
    console.log("全部完成 / All done。重启 dsh 生效 / Restart dsh to take effect.");
  } else if (mode === "--revert") {
    if (state.ai_base || core.enumeratePatchAiBases().length) {
      const { reverted, errors } = await core.revertAllHosts();
      for (const p of reverted) console.log(`  ✓ 已还原 / Reverted ${p}`);
      for (const [p, e] of errors) console.log(`  ⚠ 还原失败 ${p}: ${e}`);
      if (reverted.length === 0) console.log("  - 没有补丁备份可还原 / no patch backup");
    }
    if (state.shim_dir) {
      const r = await core.revertShim(state.shim_dir);
      for (const [fname, st] of Object.entries(r)) {
        if (st === "reverted" || st === "stripped_inject") console.log(`  ✓ shim ${fname}: ${st}`);
        else console.log(`  - shim ${fname}: ${st}`);
      }
    }
    console.log("");
    console.log("回滚完成 / Revert done。重启 dsh 后恢复 / restart to restore.");
    console.log("注: prompt-inject.md 保留（用户文件）/ prompt-inject.md kept (user file)");
  } else if (mode === "--uninstall") {
    const { uninstallForge } = await import("../lib/uninstall.js");
    const result = await uninstallForge();
    if (result.applied) console.log("  已检测到补丁，已还原回原版。");
    else console.log("  未检测到已应用补丁，仍会清除插件文件。");
    if (result.override?.removed) console.log(`  已删除 ${result.override.path}`);
    if (result.stripped?.length) console.log(`  已从 profile 移除: ${result.stripped.join(", ")}`);
    for (const e of result.errors || []) console.log(`  ⚠ ${e}`);
    if (!result.ok) {
      console.log("  卸载中止：还原失败，插件文件未删除。");
      process.exit(1);
    }
    console.log("");
    console.log("卸载完成。请重启 dsh。");
  } else if (mode === "--edit") {
    const r = core.editOverride(state.dsh_home);
    if (!r.ok && r.needCreate) {
      await core.installOverride(state.dsh_home, true);
      console.log(`  ✓ 已创建默认注入文件：${state.override_path}`);
      core.editOverride(state.dsh_home);
    } else {
      console.log(`  → 已打开 ${r.editor} 编辑注入文件：${r.path}`);
    }
    console.log("  编辑完成后重启 dsh 生效。");
  } else {
    console.log("默认不清洗，使用 --apply 应用清洗。");
  }
}

main().catch((e) => {
  console.error("[dsh-forge] error:", e);
  process.exit(1);
});
