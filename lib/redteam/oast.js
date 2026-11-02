/**
 * CEYE 记录查询：保存域名与 token，按需查询 DNS/HTTP 记录。
 *
 * 安全：
 *   · token 用 DPAPI 加密落盘，不写 config.json、不进提示词/日志。
 *   · 面板只显示「已配置」，不回显 token。
 *   · 模型通过 redteam_oast_poll 拿记录，拿不到 token。
 */
import { loadPlatformConfig, savePlatformConfig } from "./platform-config.js";
import { saveSecret, loadSecret, hasSecret, deleteSecret } from "./secrets.js";

const API_HOSTS = ["https://api.ceye.io/v1/records", "http://api.ceye.io/v1/records"];
const QUERY_TIMEOUT_MS = 9000;

function readEnv(cfg) {
  return (cfg && cfg.env) || {};
}

function normalizeDomain(value) {
  const raw = String(value || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^\*\./, "");
  if (!raw) return "";
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(raw) || !raw.includes(".")) {
    throw new Error("域名格式不对，例如 abc123.ceye.io");
  }
  return raw;
}

function normalizeToken(value) {
  const token = String(value || "").trim();
  if (!token) return "";
  if (!/^[A-Za-z0-9._-]{4,128}$/.test(token)) throw new Error("token 格式不对");
  return token;
}

async function tokenOf(root) {
  const token = await loadSecret(root, "ceye");
  if (!token) throw new Error("CEYE token 未配置");
  return token;
}

export function oastStatus(root) {
  const cfg = loadPlatformConfig(root);
  const env = readEnv(cfg);
  const domain = String(env.CEYE_DOMAIN || "").trim();
  const configured = !!domain && hasSecret(root, "ceye");
  return { ok: true, domain, configured };
}

async function queryRecords(token, type, filter) {
  const kind = type === "request" ? "request" : "dns";
  const q = String(filter || "").slice(0, 20);
  let lastError = null;
  for (const base of API_HOSTS) {
    const url = new URL(base);
    url.searchParams.set("token", token);
    url.searchParams.set("type", kind);
    if (q) url.searchParams.set("filter", q);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), QUERY_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ac.signal });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { throw new Error("CEYE 返回的不是 JSON"); }
      const code = Number(json && json.meta && json.meta.code);
      if (Number.isFinite(code) && code !== 200) {
        throw new Error((json.meta && json.meta.message) || ("CEYE 返回 " + code));
      }
      if (!res.ok) throw new Error("CEYE HTTP " + res.status);
      const data = Array.isArray(json.data) ? json.data : [];
      return { records: data, via: base.startsWith("https") ? "https" : "http" };
    } catch (e) {
      lastError = e;
      if (base.startsWith("https")) continue;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("CEYE 查询失败：" + (lastError && lastError.message ? lastError.message : "网络不可达"));
}

function publicRecords(records, limit) {
  const max = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return records.slice(0, max).map((r) => ({
    id: r.id,
    name: r.name,
    remote_addr: r.remote_addr,
    created_at: r.created_at,
    data: typeof r.data === "string" ? r.data : "",
  }));
}

/** 测试并保存；test=false 时只保存不请求。 */
export async function oastSave(root, input = {}) {
  const domain = normalizeDomain(input.domain);
  if (!domain) throw new Error("填 CEYE 域名");
  const token = normalizeToken(input.token) || (hasSecret(root, "ceye") ? await tokenOf(root) : "");
  if (!token) throw new Error("填 CEYE token");

  if (input.test !== false) {
    await queryRecords(token, "dns", domain.slice(0, 20));
  }
  await saveSecret(root, "ceye", token);
  savePlatformConfig({ env: { CEYE_DOMAIN: domain } }, root);
  return { ok: true, domain, configured: true };
}

export function oastClear(root) {
  deleteSecret(root, "ceye");
  savePlatformConfig({ env: { CEYE_DOMAIN: "" } }, root);
  return { ok: true };
}

/** 查询记录；token 不返回。 */
export async function oastPoll(root, input = {}) {
  const status = oastStatus(root);
  if (!status.configured) throw new Error("CEYE 未配置");
  const token = await tokenOf(root);
  const type = input.type === "request" ? "request" : "dns";
  const filter = String(input.filter || status.domain).slice(0, 20);
  const { records, via } = await queryRecords(token, type, filter);
  return { ok: true, type, filter, via, records: publicRecords(records, input.limit) };
}

export function oastSummary(root) {
  const s = oastStatus(root);
  return { configured: s.configured, domain: s.domain };
}
