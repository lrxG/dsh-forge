/**
 * 逆向工具链体检。
 *
 * 只做探测和安装提示，不自动改 PATH、不下载二进制。
 * 目的：crack 模式开测前先知道 jadx / apktool / frida / ghidra 等到底缺什么，
 * 避免模型把“没装工具”误判成“目标不可分析”。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * @typedef {object} ToolSpec
 * @property {string} id
 * @property {string[]} commands
 * @property {string[]} versionArgs
 * @property {string} purpose
 * @property {string} install
 * @property {string} docs
 */

/** @type {ToolSpec[]} */
export const TOOLCHAIN = [
  {
    id: "java",
    commands: ["java", "java.exe"],
    versionArgs: ["-version"],
    purpose: "JDK，jadx / apktool / ghidra 的运行时依赖",
    install: "安装 Temurin JDK 21，并设置 JAVA_HOME",
    docs: "https://adoptium.net/",
  },
  {
    id: "frida",
    commands: ["frida", "frida.exe"],
    versionArgs: ["--version"],
    purpose: "Frida CLI，动态插桩入口",
    install: "pip install frida-tools",
    docs: "https://frida.re/docs/installation/",
  },
  {
    id: "frida-trace",
    commands: ["frida-trace", "frida-trace.exe"],
    versionArgs: ["--version"],
    purpose: "Frida 调用追踪",
    install: "pip install frida-tools",
    docs: "https://frida.re/docs/frida-trace/",
  },
  {
    id: "objection",
    commands: ["objection", "objection.exe"],
    versionArgs: ["version"],
    purpose: "移动端 Frida 常用操作封装",
    install: "pip install objection",
    docs: "https://github.com/sensepost/objection",
  },
  {
    id: "jadx",
    commands: ["jadx", "jadx.bat", "jadx.exe"],
    versionArgs: ["--version"],
    purpose: "APK / DEX 反编译",
    install: "从 skylot/jadx releases 下载后加入 PATH",
    docs: "https://github.com/skylot/jadx",
  },
  {
    id: "apktool",
    commands: ["apktool", "apktool.bat", "apktool.exe"],
    versionArgs: ["--version"],
    purpose: "APK 资源解码 / 重打包",
    install: "从 iBotPeaches/Apktool 下载 wrapper 与 jar 后加入 PATH",
    docs: "https://apktool.org/docs/install",
  },
  {
    id: "zipalign",
    commands: ["zipalign", "zipalign.exe"],
    versionArgs: [],
    purpose: "APK 对齐",
    install: "Android SDK Build-Tools",
    docs: "https://developer.android.com/tools/zipalign",
  },
  {
    id: "apksigner",
    commands: ["apksigner", "apksigner.bat"],
    versionArgs: ["--version"],
    purpose: "APK 签名",
    install: "Android SDK Build-Tools",
    docs: "https://developer.android.com/tools/apksigner",
  },
  {
    id: "jarsigner",
    commands: ["jarsigner", "jarsigner.exe"],
    versionArgs: ["-version"],
    purpose: "JAR / APK 签名（备用）",
    install: "JDK",
    docs: "https://docs.oracle.com/en/java/javase/17/docs/specs/man/jarsigner.html",
  },
  {
    id: "aapt",
    commands: ["aapt", "aapt.exe", "aapt2", "aapt2.exe"],
    versionArgs: ["version"],
    purpose: "APK 清单 / 资源信息",
    install: "Android SDK Build-Tools",
    docs: "https://developer.android.com/tools/aapt2",
  },
  {
    id: "adb",
    commands: ["adb", "adb.exe"],
    versionArgs: ["version"],
    purpose: "Android 设备连接",
    install: "Android SDK Platform-Tools",
    docs: "https://developer.android.com/tools/adb",
  },
  {
    id: "ghidra",
    commands: ["analyzeHeadless", "analyzeHeadless.bat", "analyzeHeadless.exe"],
    versionArgs: [],
    purpose: "Ghidra headless 反编译（12.x 需要 JDK 25）",
    install: "从 NSA/Ghidra releases 下载；Ghidra 12 需 JDK 25，并把 analyzeHeadless 加入 PATH",
    docs: "https://ghidra-sre.org/",
  },
  {
    id: "rizin",
    commands: ["rizin", "rizin.exe"],
    versionArgs: ["-v"],
    purpose: "原生二进制分析 / 反汇编",
    install: "从 rizinorg/rizin releases 下载",
    docs: "https://rizin.re/",
  },
  {
    id: "ida",
    commands: ["idat64.exe", "idat.exe", "ida64.exe", "ida.exe", "idat64", "idat"],
    versionArgs: [],
    optional: true,
    purpose: "IDA headless（商业版，可选）",
    install: "安装 IDA Pro 并把 idat64 加入 PATH",
    docs: "https://hex-rays.com/ida-pro/",
  },
  {
    id: "capa",
    commands: ["capa", "capa.exe"],
    versionArgs: ["--version"],
    purpose: "二进制能力识别",
    install: "pip install flare-capa",
    docs: "https://github.com/mandiant/capa",
  },
  {
    id: "yara",
    commands: ["yara", "yara.exe"],
    versionArgs: ["--version"],
    purpose: "规则扫描",
    install: "从 VirusTotal/yara releases 下载",
    docs: "https://virustotal.github.io/yara/",
  },
  {
    id: "strings",
    commands: ["strings", "strings.exe"],
    versionArgs: [],
    purpose: "字符串提取",
    install: "Sysinternals strings 或 binutils",
    docs: "https://learn.microsoft.com/sysinternals/downloads/strings",
  },
];

function run(cmd, args, timeout = 4000, shell = false) {
  try {
    return spawnSync(cmd, args, {
      encoding: "utf8",
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      shell: shell === true,
    });
  } catch {
    return null;
  }
}

function firstLine(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";
}

/** 在 PATH 中查找可执行文件，返回绝对路径或 null。 */
export function which(command) {
  if (process.platform === "win32") {
    const result = run("where.exe", [command]);
    if (result && result.status === 0) {
      const line = firstLine(result.stdout);
      if (line) return line;
    }
    return null;
  }
  const result = run("sh", ["-lc", `command -v ${JSON.stringify(command)}`]);
  if (result && result.status === 0) {
    const line = firstLine(result.stdout);
    if (line) return line;
  }
  return null;
}

function managedDirs() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return [
    join(home, "crack", "tools"),
    join(home, "tools"),
    join(home, "redteam", "toolkit"),
  ];
}

function commandNames(command) {
  if (process.platform !== "win32" || /\.(exe|cmd|bat)$/i.test(command)) return [command];
  return [command, command + ".exe", command + ".cmd", command + ".bat"];
}

function findUnder(root, command, depth = 3) {
  if (!root || !existsSync(root)) return null;
  const names = new Set(commandNames(command).map((name) => name.toLowerCase()));
  const stack = [{ dir: root, level: 0 }];
  while (stack.length) {
    const { dir, level } = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && names.has(entry.name.toLowerCase())) return join(dir, entry.name);
      if (entry.isDirectory() && level < depth && !["node_modules", ".git", "__pycache__"].includes(entry.name)) {
        stack.push({ dir: join(dir, entry.name), level: level + 1 });
      }
    }
  }
  return null;
}

/** 先查 dsh-forge 托管目录，再查 PATH。 */
export function locate(command) {
  for (const dir of managedDirs()) {
    const found = findUnder(dir, command);
    if (found) return { path: found, source: "managed" };
  }
  const path = which(command);
  return path ? { path, source: "PATH" } : { path: null, source: null };
}

function versionOf(bin, args) {
  if (!args.length) return "";
  const useShell = /\.(cmd|bat)$/i.test(bin);
  const result = run(bin, args, 6000, useShell);
  if (!result) return "";
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  return firstLine(text).slice(0, 240);
}

/**
 * 探测一组工具。
 * @param {string[]=} ids 只探测这些 id；省略则全部
 */
export function toolchainStatus(ids) {
  const wanted = Array.isArray(ids) && ids.length
    ? new Set(ids.map((id) => String(id).trim().toLowerCase()).filter(Boolean))
    : null;
  const tools = [];
  for (const spec of TOOLCHAIN) {
    if (wanted && !wanted.has(spec.id)) continue;
    let path = null;
    let source = null;
    for (const command of spec.commands) {
      const found = locate(command);
      if (found.path) {
        path = found.path;
        source = found.source;
        break;
      }
    }
    tools.push({
      id: spec.id,
      ok: Boolean(path),
      path: path || null,
      source: source || null,
      optional: spec.optional === true,
      version: path ? versionOf(path, spec.versionArgs) : "",
      purpose: spec.purpose,
      install: path ? "" : spec.install,
      docs: spec.docs,
    });
  }
  const missing = tools.filter((tool) => !tool.ok).map((tool) => tool.id);
  const missingRequired = tools.filter((tool) => !tool.ok && !tool.optional).map((tool) => tool.id);
  const missingOptional = tools.filter((tool) => !tool.ok && tool.optional).map((tool) => tool.id);
  return {
    ok: missingRequired.length === 0,
    platform: process.platform,
    summary: {
      total: tools.length,
      found: tools.length - missing.length,
      missing: missing.length,
      missing_ids: missing,
      missing_required_ids: missingRequired,
      missing_optional_ids: missingOptional,
    },
    tools,
  };
}

/** 为缺失工具生成安装清单；不执行。 */
export function toolchainPlan(ids) {
  const status = toolchainStatus(ids);
  const plan = status.tools
    .filter((tool) => !tool.ok && !tool.optional)
    .map((tool) => ({ id: tool.id, install: tool.install, docs: tool.docs }));
  return {
    ok: plan.length === 0,
    missing: plan.map((item) => item.id),
    optional_missing: status.tools.filter((tool) => !tool.ok && tool.optional).map((tool) => tool.id),
    plan,
    note: "只给必需工具的安装建议，不自动下载或修改 PATH；optional 工具（如 IDA）不计入。",
  };
}
