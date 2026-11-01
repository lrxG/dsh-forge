/**
 * redteam 预设的人格文本（persona.prefix）。
 *
 * dsh 的预设人格只在挂载时读一次，所以这里改完必须重启 dsh 才生效。
 * 只替换 `prefix: |` 这个块，其余预设行原样保留；写前用插件自己的
 * 组合解析器重新解析一遍，解析不过就不落盘。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteFile } from "./core.js";
import { readCompositionRows } from "./redteam/preset-composition.js";

const PRESET_ID = "redteam";
const MAX_BYTES = 128 * 1024;
const BUNDLED_FILE = fileURLToPath(new URL("../presets/redteam/agent.cordis.yml", import.meta.url));

function presetFile(home) {
  return path.join(path.normalize(String(home || "")), ".agent-presets", PRESET_ID, "agent.cordis.yml");
}

function prefixBlock(text) {
  const lines = String(text || "").split("\n");
  const start = lines.findIndex((line) => /^\s*prefix:\s*[|>][-+]?\s*$/.test(line));
  if (start < 0) return null;
  const indent = (lines[start].match(/^\s*/) || [""])[0].length;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() === "") { end += 1; continue; }
    const lineIndent = (line.match(/^\s*/) || [""])[0].length;
    if (lineIndent <= indent) break;
    end += 1;
  }
  let bodyEnd = end;
  while (bodyEnd > start + 1 && lines[bodyEnd - 1].trim() === "") bodyEnd -= 1;
  const body = lines.slice(start + 1, bodyEnd);
  const bodyIndent = body.length
    ? Math.min(...body.filter((line) => line.trim()).map((line) => (line.match(/^\s*/) || [""])[0].length))
    : indent + 2;
  const value = body.map((line) => line.slice(Math.min(bodyIndent, line.length))).join("\n").replace(/\s+$/, "");
  return { start, end, bodyEnd, bodyIndent, value };
}

function replacePrefixBlock(text, nextValue) {
  const block = prefixBlock(text);
  if (!block) throw new Error("当前预设里没有 persona.prefix 块，先更新预设");
  const lines = String(text).split("\n");
  const pad = " ".repeat(block.bodyIndent);
  const body = String(nextValue).replace(/\r\n/g, "\n").split("\n").map((line) => (line ? pad + line : ""));
  return [
    ...lines.slice(0, block.start + 1),
    ...body,
    ...lines.slice(block.bodyEnd),
  ].join("\n");
}

function readBundledPrefix() {
  try {
    const block = prefixBlock(fs.readFileSync(BUNDLED_FILE, "utf8"));
    return block ? block.value : "";
  } catch {
    return "";
  }
}

/** 读取当前安装的 redteam 预设人格；没安装时回包内模板。 */
export function getPresetPrompt(home) {
  const fp = presetFile(home);
  let raw = "";
  let installed = false;
  try {
    raw = fs.readFileSync(fp, "utf8");
    installed = true;
  } catch { /* 没安装就用包内模板展示 */ }
  if (!raw) {
    try { raw = fs.readFileSync(BUNDLED_FILE, "utf8") } catch { raw = "" }
  }
  const block = prefixBlock(raw);
  return {
    ok: true,
    installed,
    path: fp,
    prefix: block ? block.value : "",
    bundledPrefix: readBundledPrefix(),
    note: "只改 persona.prefix；保存后需要重启 DeepSeek Harness 才生效。",
  };
}

/** 保存人格前缀；写前验一遍完整组合，解析失败原文件不动。 */
export async function savePresetPrefix(home, content) {
  const fp = presetFile(home);
  const text = String(content ?? "").replace(/\r\n/g, "\n").trimEnd();
  if (!text.trim()) throw new Error("人格不能为空");
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new Error("人格太长（上限 128KB）");
  let raw = "";
  try {
    raw = fs.readFileSync(fp, "utf8");
  } catch {
    throw new Error("redteam 预设还没安装，先重启一次 DeepSeek Harness");
  }
  const next = replacePrefixBlock(raw, text);
  /* 解析不过就不写：宁可报错，也不要把预设写坏导致整份预设挂不上。 */
  readCompositionRows(next, path.dirname(fp));
  await atomicWriteFile(fp, next);
  return { ok: true, path: fp, prefix: text };
}

/** 恢复包内默认人格。 */
export async function resetPresetPrefix(home) {
  const bundled = readBundledPrefix();
  if (!bundled) throw new Error("读不到包内默认人格");
  return savePresetPrefix(home, bundled);
}

/** 包内默认人格（给模板/恢复默认用）。 */
export function bundledPresetPrefix(mode) {
  if (mode && mode !== "redteam") return "";
  return readBundledPrefix();
}
