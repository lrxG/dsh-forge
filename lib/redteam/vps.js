/**
 * VPS 接入：测试连通、密码换密钥、密码加密/会话保存、代跑命令。
 *
 * 原则：
 *   · 密码、私钥都只在本进程内存里以可用形式出现；不写 config.json、不进提示词。
 *   · 私钥用 DPAPI 加密落盘；模型拿不到私钥，所有操作由宿主代连。
 *   · 首次连接记主机指纹；指纹变化直接拒绝。
 */
import ssh2 from "../vendor/ssh2.cjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadPlatformConfig, savePlatformConfig, redteamRoot, toolkitDirOf } from "./platform-config.js";
import { saveSecret, loadSecret, hasSecret, deleteSecret, restrictFile } from "./secrets.js";

const { Client } = ssh2;

const KEY_DIR = "keys";
const PUB_NAME = "vps_ed25519.pub";
const NATIVE_DIR = "native";
const NATIVE_NAME = "vps_ed25519";
const CONNECT_TIMEOUT_MS = 9000;
const EXEC_TIMEOUT_MS = 20000;

/** 仅本次会话的密码：进程内存，重启即失效。 */
const sessionSecrets = new Map();

function rootOf(root) {
  return path.normalize(String(root || redteamRoot() || ""));
}

function publicKeyPathOf(root) {
  return path.join(rootOf(root), KEY_DIR, PUB_NAME);
}

function nativeKeyPathOf(root) {
  return path.join(rootOf(root), KEY_DIR, NATIVE_DIR, NATIVE_NAME);
}

function readEnv(cfg) {
  return (cfg && cfg.env) || {};
}

/** 把配置里的 VPS 字段归一成面板/连接要用的形状。 */
export function vpsStatus(root) {
  const cfg = loadPlatformConfig(root);
  const env = readEnv(cfg);
  const host = String(env.REDTEAM_VPS_ADDR || "").trim();
  const user = String(env.REDTEAM_VPS_USER || "").trim();
  const port = Number(env.REDTEAM_VPS_PORT) || 22;
  const fingerprint = String(env.REDTEAM_VPS_FP || "").trim();
  const native = String(env.REDTEAM_VPS_NATIVE || "") === "1" && fs.existsSync(nativeKeyPathOf(root));
  const nativeKeyPath = native ? nativeKeyPathOf(root) : "";
  let auth = String(env.REDTEAM_VPS_AUTH || "").trim();
  if (!auth) auth = hasSecret(root, "vps-key") ? "key" : "";
  let configured = false;
  if (auth === "key") configured = hasSecret(root, "vps-key");
  else if (auth === "password") configured = hasSecret(root, "vps-password");
  else if (auth === "session") configured = sessionSecrets.has(rootOf(root));
  return {
    ok: true,
    host,
    port,
    user,
    auth,
    fingerprint,
    native,
    nativeKeyPath,
    configured,
    remember: auth === "password",
    hasPassword: hasSecret(root, "vps-password") || sessionSecrets.has(rootOf(root)),
  };
}

function saveVps(root, meta) {
  const prev = readEnv(loadPlatformConfig(root));
  const host = String(meta.host || "").trim();
  const user = String(meta.user || "").trim();
  const port = Number(meta.port) || 22;
  const native = meta.native !== undefined ? !!meta.native : String(prev.REDTEAM_VPS_NATIVE || "") === "1";
  const env = {
    REDTEAM_VPS_ADDR: host,
    REDTEAM_VPS_PORT: String(port),
    REDTEAM_VPS_USER: user,
    REDTEAM_VPS_HOST: host ? (user ? user + "@" + host : host) : "",
    REDTEAM_VPS_AUTH: String(meta.auth || ""),
    REDTEAM_VPS_KEY: "",
    REDTEAM_VPS_KEYID: String(meta.keyId || ""),
    REDTEAM_VPS_FP: String(meta.fingerprint || ""),
    REDTEAM_VPS_NATIVE: native ? "1" : "0",
    REDTEAM_VPS_NATIVE_KEY: native && host ? nativeKeyPathOf(root) : "",
  };
  savePlatformConfig({ env }, root);
}

function connect({ host, port, user, password, privateKey, expectFingerprint, timeoutMs }) {
  const timeout = Math.min(Math.max(Number(timeoutMs) || CONNECT_TIMEOUT_MS, 1000), 30000);
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    let fingerprint = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch { /* ignore */ }
      reject(new Error("连接超时"));
    }, timeout);
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { conn.end(); } catch { /* ignore */ }
      const msg = err && err.message ? String(err.message) : String(err);
      reject(/verification|host denied/i.test(msg)
        ? new Error("主机指纹与已保存的不一致，可能不是同一台 VPS；请重新测试配置")
        : err);
    };
    conn.on("ready", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ conn, fingerprint });
    });
    conn.on("error", fail);
    const options = {
      host,
      port,
      username: user,
      readyTimeout: timeout,
      keepaliveInterval: 10000,
      keepaliveCountMax: 2,
      hostHash: "sha256",
      hostVerifier: (hash) => {
        fingerprint = String(hash || "");
        if (expectFingerprint && expectFingerprint !== fingerprint) return false;
        return true;
      },
    };
    if (privateKey) {
      options.privateKey = privateKey;
    } else {
      options.password = password;
      options.tryKeyboard = false;
    }
    try { conn.connect(options); } catch (e) { fail(e); }
  });
}

function execRemote(conn, command, timeoutMs = EXEC_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch { /* ignore */ }
      reject(new Error("命令执行超时"));
    }, timeoutMs);
    conn.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        settled = true;
        reject(err);
        return;
      }
      let stdout = "";
      let stderr = "";
      stream.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
      stream.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
      stream.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: Number(code) || 0, stdout, stderr });
      });
      stream.on("error", (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      });
    });
  });
}

function close(conn) {
  try { conn.end(); } catch { /* ignore */ }
}

/** 读服务器是否允许公钥登录；不依赖 root。 */
async function detectPubkeyAuth(conn) {
  const cmd = [
    "sshd -T 2>/dev/null | grep -i '^pubkeyauthentication'",
    "grep -RhsE '^[[:space:]]*PubkeyAuthentication[[:space:]]+' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null | tail -1",
  ].join(" || ");
  try {
    const r = await execRemote(conn, cmd, 6000);
    const out = String(r.stdout || "").trim();
    if (/pubkeyauthentication\s+no/i.test(out)) return "no";
    if (/pubkeyauthentication\s+yes/i.test(out)) return "yes";
    return "unknown";
  } catch {
    return "unknown";
  }
}

async function passwordOf(root) {
  const key = rootOf(root);
  if (sessionSecrets.has(key)) return sessionSecrets.get(key);
  const plain = await loadSecret(root, "vps-password");
  if (!plain) throw new Error("密码未保存，请重新输入");
  sessionSecrets.set(key, plain);
  return plain;
}

/* ── 密钥 ──────────────────────────────────────────────────────────────── */

function keyIdOf(publicLine) {
  const m = /dsh-forge:([a-f0-9]{6,})/.exec(String(publicLine || ""));
  return m ? m[1] : "";
}

async function ensureKeyPair(root) {
  const pubPath = publicKeyPathOf(root);
  if (hasSecret(root, "vps-key") && fs.existsSync(pubPath)) {
    const publicLine = fs.readFileSync(pubPath, "utf8").trim();
    return { keyId: keyIdOf(publicLine), publicLine };
  }
  /* ssh2 自带 OpenSSH 格式生成器；私钥立即 DPAPI 加密，明文不落盘。 */
  const pair = ssh2.utils.generateKeyPairSync("ed25519");
  const keyId = crypto.randomBytes(4).toString("hex");
  const publicLine = pair.public + " dsh-forge:" + keyId;
  await saveSecret(root, "vps-key", pair.private);
  fs.mkdirSync(path.dirname(pubPath), { recursive: true });
  fs.writeFileSync(pubPath, publicLine + "\n", { encoding: "utf8", mode: 0o644 });
  return { keyId, publicLine };
}

async function keyMaterial(root) {
  const text = await loadSecret(root, "vps-key");
  if (!text) throw new Error("私钥不存在，请重新配置");
  return text;
}

async function writeNativeKey(root) {
  const material = await keyMaterial(root);
  const fp = nativeKeyPathOf(root);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, material, { encoding: "utf8", mode: 0o600 });
  restrictFile(fp);
  return fp;
}

function removeNativeKey(root) {
  try { fs.unlinkSync(nativeKeyPathOf(root)); } catch { /* 没有就算了 */ }
}

/** 原生 ssh 模式：把私钥落成可用文件，供模型直接 ssh/scp/ssh -L。 */
export async function vpsSetNative(root, enabled) {
  const s = vpsStatus(root);
  if (!s.host || !s.user) throw new Error("VPS 未配置");
  if (enabled) {
    if (s.auth !== "key") throw new Error("只有密钥登录才能开启原生 ssh");
    await writeNativeKey(root);
  } else {
    removeNativeKey(root);
  }
  saveVps(root, {
    host: s.host,
    port: s.port,
    user: s.user,
    auth: s.auth,
    fingerprint: s.fingerprint,
    keyId: keyIdOf(fs.existsSync(publicKeyPathOf(root)) ? fs.readFileSync(publicKeyPathOf(root), "utf8") : ""),
    native: enabled,
  });
  return vpsStatus(root);
}

function installPublicKey(conn, publicLine) {
  const line = String(publicLine).replace(/'/g, "'\\''");
  const cmd = [
    "set -e",
    "mkdir -p ~/.ssh",
    "chmod 700 ~/.ssh",
    "touch ~/.ssh/authorized_keys",
    "chmod 600 ~/.ssh/authorized_keys",
    "{ grep -qxF '" + line + "' ~/.ssh/authorized_keys || printf '\\n%s\\n' '" + line + "' >> ~/.ssh/authorized_keys; }",
    "grep -qxF '" + line + "' ~/.ssh/authorized_keys",
    "command -v restorecon >/dev/null 2>&1 && restorecon -R ~/.ssh || true",
  ].join(" && ");
  return execRemote(conn, cmd);
}

function diagnoseKeyAuth(conn, keyId) {
  const id = String(keyId || "").replace(/'/g, "'\\''");
  const cmd = [
    "echo home=$(cd ~ && pwd)",
    "ls -ld ~ ~/.ssh 2>&1",
    "ls -l ~/.ssh/authorized_keys 2>&1",
    "echo lines=$(wc -l < ~/.ssh/authorized_keys 2>/dev/null || echo 0)",
    "echo matches=$(grep -c 'dsh-forge:" + id + "' ~/.ssh/authorized_keys 2>/dev/null || echo 0)",
    "grep -E '^(PubkeyAuthentication|AuthorizedKeysFile|StrictModes)' /etc/ssh/sshd_config 2>/dev/null || true",
  ].join("; ");
  return execRemote(conn, cmd, 8000);
}

function removePublicKey(conn, publicLine) {
  const line = String(publicLine).replace(/'/g, "'\\''");
  const cmd = [
    "test -f ~/.ssh/authorized_keys",
    "tmp=$(mktemp)",
    "grep -vxF '" + line + "' ~/.ssh/authorized_keys > \"$tmp\" || true",
    "cat \"$tmp\" > ~/.ssh/authorized_keys",
    "rm -f \"$tmp\"",
    "chmod 600 ~/.ssh/authorized_keys",
  ].join(" && ");
  return execRemote(conn, cmd);
}

/* ── 对外操作 ──────────────────────────────────────────────────────────── */

function normalizeTarget(input) {
  const host = String(input && input.host || "").trim();
  const user = String(input && input.user || "").trim();
  const port = Number(input && input.port) || 22;
  if (!host) throw new Error("填 VPS 主机");
  if (!user) throw new Error("填登录用户");
  if (!(port >= 1 && port <= 65535)) throw new Error("端口不合法");
  return { host, port, user };
}

/** 只测试密码连通，不保存任何东西。 */
export async function vpsTest(root, input) {
  const target = normalizeTarget(input);
  let password = String(input && input.password || "");
  if (!password && input && input.useStored) {
    try { password = await passwordOf(root); } catch { password = ""; }
  }
  if (!password) throw new Error("填登录密码");
  const started = Date.now();
  const { conn, fingerprint } = await connect(Object.assign({}, target, { password }));
  try {
    const r = await execRemote(conn, "printf dsh-forge-ok", 8000);
    if (!r.stdout.includes("dsh-forge-ok")) throw new Error("登录成功但命令执行异常");
    const pubkeyAuth = await detectPubkeyAuth(conn);
    return { ok: true, latencyMs: Date.now() - started, target, fingerprint, pubkeyAuth };
  } finally {
    close(conn);
  }
}

/**
 * 测试并落配置。
 * mode: key（密码换密钥）| password（记住密码，DPAPI）| session（仅本次）
 */
export async function vpsApply(root, input) {
  const target = normalizeTarget(input);
  let password = String(input && input.password || "");
  if (!password && input && input.useStored) {
    try { password = await passwordOf(root); } catch { password = ""; }
  }
  if (!password) throw new Error("填登录密码");
  const mode = String(input && input.mode || "");
  if (mode !== "key" && mode !== "password" && mode !== "session") throw new Error("未知登录方式");

  const conn = await connect(Object.assign({}, target, { password }));
  let key = null;
  let fingerprint = "";
  try {
    fingerprint = conn.fingerprint;
    const probe = await execRemote(conn.conn, "printf dsh-forge-ok", 8000);
    if (!probe.stdout.includes("dsh-forge-ok")) throw new Error("登录成功但命令执行异常");
    const pubkeyAuth = await detectPubkeyAuth(conn.conn);

    if (mode === "key") {
      if (pubkeyAuth === "no") {
        throw new Error("服务器禁用了公钥登录（PubkeyAuthentication no）；请先在 VPS 上开启，或改用账号密码。");
      }
      key = await ensureKeyPair(root);
      const installed = await installPublicKey(conn.conn, key.publicLine);
      if (installed.code !== 0) throw new Error("写入公钥失败：" + (installed.stderr || "权限不足"));
    }
  } finally {
    close(conn.conn);
  }

  if (mode === "key") {
    /* 用密钥复测，失败就不算配置成功。 */
    let keyConn;
    try {
      const kc = await connect(Object.assign({}, target, {
        privateKey: await keyMaterial(root),
        expectFingerprint: fingerprint,
      }));
      keyConn = kc.conn;
      const r = await execRemote(keyConn, "printf dsh-forge-key-ok", 8000);
      if (!r.stdout.includes("dsh-forge-key-ok")) throw new Error("密钥登录验证失败");
    } catch (e) {
      let diag = "";
      try {
        const back = await connect(Object.assign({}, target, { password, expectFingerprint: fingerprint }));
        try {
          const d = await diagnoseKeyAuth(back.conn, key.keyId);
          diag = String(d.stdout || "").trim();
        } finally {
          close(back.conn);
        }
      } catch { /* 诊断失败不覆盖原错误 */ }
      throw new Error("公钥已写入，但密钥登录失败：" + (e && e.message ? e.message : String(e))
        + (diag ? "\n诊断：\n" + diag : "")
        + "\n检查：sshd 是否允许 PubkeyAuthentication；AuthorizedKeysFile 是否指向 ~/.ssh/authorized_keys；SELinux 是否阻止新文件。");
    } finally {
      if (keyConn) close(keyConn);
    }
    sessionSecrets.delete(rootOf(root));
    deleteSecret(root, "vps-password");
    const prevNative = readEnv(loadPlatformConfig(root)).REDTEAM_VPS_NATIVE === "1";
    saveVps(root, Object.assign({}, target, {
      auth: "key", keyId: key.keyId, fingerprint, native: prevNative,
    }));
    if (prevNative) await writeNativeKey(root);
    return Object.assign({ ok: true, auth: "key", keyId: key.keyId, fingerprint, native: prevNative }, target);
  }

  const keyRoot = rootOf(root);
  if (mode === "password") {
    await saveSecret(root, "vps-password", password);
    sessionSecrets.set(keyRoot, password);
    saveVps(root, Object.assign({}, target, { auth: "password", fingerprint, native: false }));
    removeNativeKey(root);
    return Object.assign({ ok: true, auth: "password", remember: true, fingerprint }, target);
  }

  sessionSecrets.set(keyRoot, password);
  deleteSecret(root, "vps-password");
  saveVps(root, Object.assign({}, target, { auth: "session", fingerprint, native: false }));
  removeNativeKey(root);
  return Object.assign({ ok: true, auth: "session", remember: false, fingerprint }, target);
}

export async function vpsClear(root) {
  const status = vpsStatus(root);
  const pubPath = publicKeyPathOf(root);
  const pubLine = fs.existsSync(pubPath) ? fs.readFileSync(pubPath, "utf8").trim() : "";
  let material = "";
  let password = "";
  try {
    if (status.auth === "key") material = await keyMaterial(root);
    else if (status.auth === "password" || status.auth === "session") password = await passwordOf(root);
  } catch { /* 取不到也继续删本地 */ }

  /* 本地先删：不依赖网络，点清除就一定清掉。 */
  sessionSecrets.delete(rootOf(root));
  deleteSecret(root, "vps-password");
  deleteSecret(root, "vps-key");
  try { fs.unlinkSync(pubPath); } catch { /* 没有就算了 */ }
  removeNativeKey(root);
  saveVps(root, { host: "", port: 22, user: "", auth: "", native: false });

  /* 再尽力撤销远端公钥；失败只提示，不影响本地已清空。 */
  let revoked = false;
  let warning = "";
  if (pubLine && status.host && status.user) {
    let conn;
    try {
      const target = { host: status.host, port: status.port, user: status.user };
      const opts = material
        ? { privateKey: material, expectFingerprint: status.fingerprint, timeoutMs: 4000 }
        : { password, expectFingerprint: status.fingerprint, timeoutMs: 4000 };
      conn = (await connect(Object.assign({}, target, opts))).conn;
      const r = await removePublicKey(conn, pubLine);
      revoked = r.code === 0;
      if (!revoked) warning = "本地已清除；远端公钥移除失败，请手动清理 authorized_keys";
    } catch (e) {
      warning = "本地已清除；未能连接 VPS 移除公钥：" + (e && e.message ? e.message : String(e));
    } finally {
      if (conn) close(conn);
    }
  }
  return { ok: true, revoked, warning };
}

/** 代跑一条命令。密钥/密码模式都走这里，密码不会返回给调用方。 */
export async function vpsExec(root, command, options = {}) {
  const status = vpsStatus(root);
  if (!status.host || !status.user) throw new Error("VPS 未配置");
  const cmd = String(command || "").trim();
  if (!cmd) throw new Error("命令为空");
  const target = { host: status.host, port: status.port, user: status.user };
  let conn;
  if (status.auth === "key") {
    conn = (await connect(Object.assign({}, target, {
      privateKey: await keyMaterial(root),
      expectFingerprint: status.fingerprint,
    }))).conn;
  } else if (status.auth === "password" || status.auth === "session") {
    const password = await passwordOf(root);
    conn = (await connect(Object.assign({}, target, { password, expectFingerprint: status.fingerprint }))).conn;
  } else {
    throw new Error("VPS 未配置登录方式");
  }
  try {
    const timeout = Math.min(Math.max(Number(options.timeoutMs) || EXEC_TIMEOUT_MS, 1000), 120000);
    return Object.assign({ ok: true }, await execRemote(conn, cmd, timeout));
  } finally {
    close(conn);
  }
}

/* ── 文件传输（限制目录 + 校验 + 原子改名） ─────────────────────────── */

const REMOTE_DIR = "dsh-forge/files";
const LOCAL_DOWNLOAD_DIR = "downloads";
const MAX_TRANSFER_BYTES = 200 * 1024 * 1024;

function safeName(name) {
  const raw = String(name || "").trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(raw) || raw === "." || raw === "..") {
    throw new Error("文件名只允许字母、数字、点、下划线、连字符（1–128）");
  }
  return raw;
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function openSftp(conn) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  });
}

function sftpRealpath(sftp, p) {
  return new Promise((resolve, reject) => {
    sftp.realpath(p, (err, abs) => (err ? reject(err) : resolve(abs)));
  });
}

function sftpStat(sftp, p) {
  return new Promise((resolve, reject) => {
    sftp.stat(p, (err, st) => (err ? reject(err) : resolve(st)));
  });
}

function sftpFastPut(sftp, local, remote) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(local, remote, (err) => (err ? reject(err) : resolve()));
  });
}

function sftpFastGet(sftp, remote, local) {
  return new Promise((resolve, reject) => {
    sftp.fastGet(remote, local, (err) => (err ? reject(err) : resolve()));
  });
}

function localSha256(fp) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(fp);
    stream.on("data", (d) => hash.update(d));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function parseSha(output) {
  const m = /([a-f0-9]{64})/i.exec(String(output || ""));
  return m ? m[1].toLowerCase() : "";
}

async function remoteSha256(conn, remote) {
  const q = shellQuote(remote);
  const r = await execRemote(conn, "sha256sum " + q + " 2>/dev/null || shasum -a 256 " + q + " 2>/dev/null", 15000);
  return parseSha(r.stdout);
}

function dshHomeOf(root) {
  return path.dirname(rootOf(root));
}

function allowedLocalRoots(root, cwd) {
  const home = dshHomeOf(root);
  let toolkit = "";
  try { toolkit = toolkitDirOf(loadPlatformConfig(root), root); } catch { toolkit = ""; }
  return [cwd, toolkit, path.join(home, "redteam"), path.join(home, "dsh-forge")]
    .filter(Boolean)
    .map((p) => path.resolve(String(p)));
}

function assertLocalAllowed(fp, roots) {
  let real;
  try { real = fs.realpathSync(fp); } catch { throw new Error("本地文件不存在"); }
  const norm = process.platform === "win32" ? real.toLowerCase() : real;
  const ok = roots.some((root) => {
    let rr;
    try { rr = fs.realpathSync(root); } catch { rr = path.resolve(root); }
    const base = process.platform === "win32" ? rr.toLowerCase() : rr;
    return norm === base || norm.startsWith(base + path.sep);
  });
  if (!ok) throw new Error("本地路径不在允许范围（工作区 / 工具箱 / $DSH_HOME）");
  return real;
}

async function vpsConnection(root) {
  const status = vpsStatus(root);
  if (!status.host || !status.user) throw new Error("VPS 未配置");
  const target = { host: status.host, port: status.port, user: status.user };
  if (status.auth === "key") {
    const r = await connect(Object.assign({}, target, {
      privateKey: await keyMaterial(root),
      expectFingerprint: status.fingerprint,
    }));
    return r.conn;
  }
  if (status.auth === "password" || status.auth === "session") {
    const password = await passwordOf(root);
    const r = await connect(Object.assign({}, target, { password, expectFingerprint: status.fingerprint }));
    return r.conn;
  }
  throw new Error("VPS 未配置登录方式");
}

/**
 * 上传到远端固定目录 ~/dsh-forge/files/。localPath 必须在允许的本地根内。
 */
export async function vpsPut(root, localPath, remoteName, options = {}) {
  const name = safeName(remoteName || path.basename(String(localPath || "")));
  const roots = allowedLocalRoots(root, options.cwd);
  const local = assertLocalAllowed(String(localPath || ""), roots);
  const st = fs.statSync(local);
  if (!st.isFile()) throw new Error("只能上传文件");
  if (st.size > MAX_TRANSFER_BYTES) throw new Error("文件超过 200MB 上限");

  const conn = await vpsConnection(root);
  try {
    const sftp = await openSftp(conn);
    const home = await sftpRealpath(sftp, ".");
    const dir = home.replace(/\/+$/, "") + "/" + REMOTE_DIR;
    await execRemote(conn, "mkdir -p " + shellQuote(dir) + " && chmod 700 " + shellQuote(dir));
    const remote = dir + "/" + name;
    if (!options.overwrite) {
      let exists = false;
      try { await sftpStat(sftp, remote); exists = true; } catch { exists = false; }
      if (exists) throw new Error("远端已存在同名文件；确需覆盖请传 overwrite");
    }
    const tmp = remote + ".part-" + process.pid + "-" + Date.now();
    await sftpFastPut(sftp, local, tmp);
    const localHash = await localSha256(local);
    const remoteHash = await remoteSha256(conn, tmp);
    if (remoteHash && remoteHash !== localHash) {
      await execRemote(conn, "rm -f " + shellQuote(tmp));
      throw new Error("上传后校验失败，已删除临时文件");
    }
    await execRemote(conn, "mv -f " + shellQuote(tmp) + " " + shellQuote(remote));
    return {
      ok: true,
      name,
      bytes: st.size,
      sha256: localHash,
      remote: "~/" + REMOTE_DIR + "/" + name,
      verified: !!remoteHash,
    };
  } finally {
    close(conn);
  }
}

/**
 * 从远端固定目录下载到 $DSH_HOME/redteam/downloads/。
 */
export async function vpsGet(root, remoteName, options = {}) {
  const name = safeName(remoteName);
  const conn = await vpsConnection(root);
  try {
    const sftp = await openSftp(conn);
    const home = await sftpRealpath(sftp, ".");
    const remote = home.replace(/\/+$/, "") + "/" + REMOTE_DIR + "/" + name;
    const st = await sftpStat(sftp, remote);
    if (!st.isFile()) throw new Error("远端目标不是文件");
    if (st.size > MAX_TRANSFER_BYTES) throw new Error("文件超过 200MB 上限");

    const outDir = path.join(rootOf(root), LOCAL_DOWNLOAD_DIR);
    fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, name);
    if (!options.overwrite && fs.existsSync(out)) throw new Error("本地已存在同名文件；确需覆盖请传 overwrite");
    const tmp = out + ".part-" + process.pid + "-" + Date.now();

    const remoteHash = await remoteSha256(conn, remote);
    await sftpFastGet(sftp, remote, tmp);
    const localHash = await localSha256(tmp);
    if (remoteHash && remoteHash !== localHash) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw new Error("下载后校验失败，已删除临时文件");
    }
    try { fs.unlinkSync(out); } catch { /* 没有就算了 */ }
    fs.renameSync(tmp, out);
    return {
      ok: true,
      name,
      bytes: st.size,
      sha256: localHash,
      path: out,
      verified: !!remoteHash,
    };
  } finally {
    close(conn);
  }
}

/** 给 preflight 用的纯状态，不含任何密钥材料。 */
export function vpsSummary(root) {
  const s = vpsStatus(root);
  return {
    configured: s.configured,
    auth: s.auth,
    host: s.host,
    port: s.port,
    user: s.user,
    native: s.native,
    nativeKeyPath: s.nativeKeyPath,
    key: s.auth === "key" ? "encrypted" : "missing",
    password: s.auth === "password" ? "encrypted" : s.auth === "session" ? "session" : "missing",
  };
}
