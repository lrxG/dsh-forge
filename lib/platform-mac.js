/**
 * macOS 专属实现。只在 darwin 上被动态 import，Windows 进程永远不会加载本文件。
 *
 * 两件事：
 *   1) 密钥：主密钥存 Keychain，密钥文件用 AES-256-GCM 加密，保持原有的
 *      $DSH_HOME/redteam/secrets/*.bin 文件形态（hasSecret/deleteSecret 不用改）。
 *   2) 重签：改过 .app 内文件后，用 ad-hoc 签名恢复可启动状态。
 *
 * 注意：创建主密钥时密码会短暂出现在 argv（/usr/bin/security 的限制）；只发生一次，
 * 之后读取走 stdout。密钥文件本身始终是密文。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const execFileAsync = promisify(execFile);
const SECURITY = "/usr/bin/security";
const CODESIGN = "/usr/bin/codesign";
const KEYCHAIN_SERVICE = "dsh-forge";
const KEYCHAIN_ACCOUNT = "secrets-master-key";

async function run(bin, args, timeout = 30000) {
  const { stdout, stderr } = await execFileAsync(bin, args, { timeout });
  return { stdout: String(stdout || ""), stderr: String(stderr || "") };
}

export async function keychainReadMasterKey() {
  try {
    const { stdout } = await run(SECURITY, [
      "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w",
    ], 15000);
    return String(stdout || "").trim();
  } catch {
    return "";
  }
}

export async function keychainEnsureMasterKey() {
  const existing = await keychainReadMasterKey();
  if (existing) return existing;
  const key = randomBytes(32).toString("base64");
  await run(SECURITY, [
    "add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", key,
  ], 15000);
  return key;
}

export async function keychainEncrypt(plaintext) {
  const keyB64 = await keychainEnsureMasterKey();
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) {
    throw new Error("Keychain 主密钥格式不正确；删除 dsh-forge/secrets-master-key 条目后重填密钥");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), body.toString("base64")].join(":");
}

export async function keychainDecrypt(blob) {
  const parts = String(blob || "").trim().split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("密钥文件不是 macOS v1 格式，无法解密");
  }
  const keyB64 = await keychainReadMasterKey();
  if (!keyB64) {
    throw new Error("Keychain 里找不到 dsh-forge 主密钥，请重新填写密钥");
  }
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error("Keychain 主密钥格式不正确");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1], "base64"));
  decipher.setAuthTag(Buffer.from(parts[2], "base64"));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64")), decipher.final()]).toString("utf8");
}

/** ad-hoc 重签 .app。失败只返回结果，不抛，调用方决定是否提示。 */
export async function resignMacBundle(bundle) {
  if (!bundle) return { ok: false, error: "no .app bundle found" };
  try {
    await run(CODESIGN, ["--force", "--deep", "--sign", "-", bundle], 120000);
    return { ok: true, bundle };
  } catch (error) {
    const detail = error?.stderr || error?.stdout || error?.message || error;
    return { ok: false, bundle, error: String(detail).trim() };
  }
}
