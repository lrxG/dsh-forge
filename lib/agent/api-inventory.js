/**
 * 静态 + 运行时 API 清单合并。
 *
 * 静态来源：bundle/HTML 里提取的 path。
 * 运行时来源：browser network 抓到的 method/url/status。
 * 只做规范化、去重、参数归并，不执行请求。
 */
function normalizePath(raw) {
  let value = String(raw || "").trim();
  if (!value) return "";
  try {
    if (/^https?:\/\//i.test(value)) {
      const u = new URL(value);
      value = u.pathname || "/";
    }
  } catch { /* keep raw */ }
  value = value.split("#")[0].split("?")[0];
  if (!value.startsWith("/")) value = "/" + value;
  value = value.replace(/\/{2,}/g, "/");
  return value.replace(/\/$/, "") || "/";
}

function paramsOf(raw) {
  const out = new Set();
  try {
    const u = new URL(String(raw));
    for (const key of u.searchParams.keys()) out.add(key);
  } catch { /* ignore */ }
  return out;
}

function bodyParams(raw) {
  const out = new Set();
  const text = String(raw || "").trim();
  if (!text) return out;
  try {
    const data = JSON.parse(text);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      for (const key of Object.keys(data)) out.add(key);
    }
  } catch {
    for (const pair of text.split("&")) {
      const key = pair.split("=")[0];
      if (key) out.add(key);
    }
  }
  return out;
}

export function mergeInventory({ runtime = [], static: staticList = [] } = {}) {
  const map = new Map();
  const add = (raw, source) => {
    const item = typeof raw === "string" ? { url: raw } : (raw || {});
    const path = normalizePath(item.path || item.url || item.endpoint);
    if (!path) return;
    const method = String(item.method || "GET").trim().toUpperCase() || "GET";
    const key = method + " " + path;
    let row = map.get(key);
    if (!row) {
      row = { method, path, status: null, sources: new Set(), params: new Set() };
      map.set(key, row);
    }
    row.sources.add(source);
    if (item.status !== undefined && item.status !== null) row.status = item.status;
    for (const keyName of paramsOf(item.url || item.path || "")) row.params.add(keyName);
    for (const keyName of paramsOf(item.endpoint || "")) row.params.add(keyName);
    for (const keyName of bodyParams(item.postData || item.body || "")) row.params.add(keyName);
  };
  for (const item of runtime) add(item, "runtime");
  for (const item of staticList) add(item, "static");
  const items = Array.from(map.values()).map((row) => ({
    method: row.method,
    path: row.path,
    status: row.status,
    sources: Array.from(row.sources).sort(),
    params: Array.from(row.params).sort(),
  }));
  items.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return {
    total: items.length,
    runtime: runtime.length,
    static: staticList.length,
    items,
  };
}
