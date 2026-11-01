/**
 * 面板密钥统一存储：DPAPI 密文 + 当前用户 ACL。
 *
 * 只存密文，明文只在宿主内存里按需解密；不返回给面板，不写日志。
 * 默认目录：$DSH_HOME/redteam/secrets/<name>.bin（用户数据目录，不在插件本体里）。
 * 想换到别的盘：设 DSH_FORGE_SECRETS_DIR 为绝对路径后重启；已有密钥需重新填一次。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { redteamRoot } from "./platform-config.js";

const DPAPI_ENTROPY = "dsh-forge-vps";
const cache = new Map();

function rootOf(root) {
  return path.normalize(String(root || redteamRoot() || ""));
}

/** 密钥目录：默认跟着红队数据根走；DSH_FORGE_SECRETS_DIR 可整体挪到别的盘。 */
export function secretsDirOf(root) {
  const override = String(process.env.DSH_FORGE_SECRETS_DIR || "").trim();
  if (override) return path.resolve(override);
  return path.join(rootOf(root), "secrets");
}

export function secretPath(root, name) {
  return path.join(secretsDirOf(root), String(name) + ".bin");
}

export function hasSecret(root, name) {
  return fs.existsSync(secretPath(root, name));
}

/** Windows 上把文件 ACL 收到当前用户；chmod 在 NTFS 上基本无效。 */
export function restrictFile(fp) {
  try { fs.chmodSync(fp, 0o600); } catch { /* ignore */ }
  if (process.platform !== "win32") return;
  try {
    const user = os.userInfo().username;
    if (user) execFileSync("icacls", [fp, "/inheritance:r", "/grant:r", user + ":F"], { windowsHide: true, stdio: "ignore" });
  } catch { /* 没有 icacls 或权限不足时保留默认 */ }
}

function runPowerShell(script, env) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      env: Object.assign({}, process.env, env || {}),
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d) => { err += d.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error((err || out || "PowerShell 失败").trim()));
    });
  });
}

const PS_PROTECT = [
  "Add-Type -AssemblyName System.Security",
  "$b=[Text.Encoding]::UTF8.GetBytes($env:DSH_FORGE_SECRET)",
  "$e=[Text.Encoding]::UTF8.GetBytes('" + DPAPI_ENTROPY + "')",
  "$c=[Security.Cryptography.ProtectedData]::Protect($b,$e,'CurrentUser')",
  "[Convert]::ToBase64String($c)",
].join("; ");

const PS_UNPROTECT = [
  "Add-Type -AssemblyName System.Security",
  "$e=[Text.Encoding]::UTF8.GetBytes('" + DPAPI_ENTROPY + "')",
  "$c=[Convert]::FromBase64String($env:DSH_FORGE_SECRET)",
  "$b=[Security.Cryptography.ProtectedData]::Unprotect($c,$e,'CurrentUser')",
  "[Text.Encoding]::UTF8.GetString($b)",
].join("; ");

export async function dpapiProtect(secret) {
  if (process.platform !== "win32") throw new Error("当前系统不支持 DPAPI");
  return runPowerShell(PS_PROTECT, { DSH_FORGE_SECRET: String(secret) });
}

export async function dpapiUnprotect(blob) {
  if (process.platform !== "win32") throw new Error("当前系统不支持 DPAPI");
  return runPowerShell(PS_UNPROTECT, { DSH_FORGE_SECRET: String(blob) });
}

export async function saveSecret(root, name, plaintext) {
  const value = String(plaintext || "");
  if (!value) throw new Error("密钥不能为空");
  const blob = await dpapiProtect(value);
  const fp = secretPath(root, name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, blob, { encoding: "utf8", mode: 0o600 });
  restrictFile(fp);
  cache.set(rootOf(root) + ":" + name, value);
  return fp;
}

export async function loadSecret(root, name) {
  const key = rootOf(root) + ":" + name;
  if (cache.has(key)) return cache.get(key);
  const fp = secretPath(root, name);
  if (!fs.existsSync(fp)) return "";
  const value = await dpapiUnprotect(fs.readFileSync(fp, "utf8").trim());
  cache.set(key, value);
  return value;
}

export function deleteSecret(root, name) {
  cache.delete(rootOf(root) + ":" + name);
  try { fs.unlinkSync(secretPath(root, name)); } catch { /* 没有就算了 */ }
}
