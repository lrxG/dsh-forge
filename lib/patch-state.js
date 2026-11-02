/**
 * 宿主补丁的轻量状态：给顶栏和“是否已启用”用，不重复扫描宿主。
 * 详细状态仍以 /dsh-forge/status 的 patch_status 为准。
 *
 * 两套口径：
 * - complete：全部启用补丁都写入成功（维护页、重试用）；
 * - core_complete：PATCH_DOCS.essential 的核心补丁都启用且写入成功（破甲开关用）。
 * 非核心失败只单独提示，不挡破甲开关；用户主动停用非核心补丁也不算失败。
 */
import fs from "node:fs";
import path from "node:path";
import { atomicWriteSync } from "./core.js";
import { PATCH_DOCS } from "./patch-docs.js";

const DONE_STATUSES = new Set(["applied", "already"]);
/* 核心补丁只认“已写入 / 已是最新 / 当前平台不适用”。
   skipped、missing_file、pattern_not_found 虽然对普通补丁是软状态，
   但对核心来说等于没生效，必须挡住破甲开关。 */
const CORE_DONE_STATUSES = new Set(["applied", "already", "na"]);

const patchIsCore = (id) => PATCH_DOCS[Number(id)]?.essential === true;
const patchRowId = (row) => Number(row?.patch_id ?? row?.id);

/** 所有核心补丁 id（不受启停影响，用来判断有没有被用户停用）。 */
export function corePatchIds() {
  return Object.keys(PATCH_DOCS).map(Number).filter(patchIsCore);
}

/**
 * 从 apply 报告推导状态；纯函数，便于测试。
 * @param {object} input
 * @param {Array} input.report - apply 报告行（含 patch_id/status）。
 * @param {object} input.summary - summarizeApplyReport 结果（failed/soft）。
 * @param {Array} input.patches - 本次启用的补丁。
 * @param {boolean} input.complete - 全部启用补丁是否完成（含宿主/刷新校验）。
 * @param {boolean} [input.hostWritten=true]
 * @param {boolean} [input.flashOk=true]
 * @param {boolean} [input.hookDenyFailed=false]
 */
export function derivePatchState(input = {}) {
  const report = Array.isArray(input.report) ? input.report : [];
  const patches = Array.isArray(input.patches) ? input.patches : [];
  const summary = input.summary || {};
  const allCoreIds = corePatchIds();
  const enabledCoreIds = new Set(patches.filter((p) => patchIsCore(p.id)).map((p) => p.id));
  const coreDisabled = allCoreIds.filter((id) => !enabledCoreIds.has(id)).length;
  const coreRows = report.filter((row) => patchIsCore(patchRowId(row)));
  const coreDone = coreRows.filter((row) => CORE_DONE_STATUSES.has(row.status));
  const corePending = coreRows.filter((row) => row.status === "pending").length
    + Math.max(0, enabledCoreIds.size - coreRows.length);
  const coreFailed = coreRows.filter((row) => !CORE_DONE_STATUSES.has(row.status)
    && row.status !== "pending").length;
  const hostWritten = input.hostWritten !== false;
  const flashOk = input.flashOk !== false;
  const hookDenyFailed = input.hookDenyFailed === true;
  const coreComplete = allCoreIds.length > 0
    && coreDisabled === 0
    && coreRows.length >= enabledCoreIds.size
    && coreDone.length === coreRows.length
    && hostWritten && flashOk && !hookDenyFailed;

  const failedRows = Array.isArray(summary.failed) ? summary.failed : [];
  const failedIds = new Set(failedRows.map(patchRowId));
  const otherFailed = failedRows.filter((row) => !patchIsCore(patchRowId(row))).length;
  const otherPending = report.filter((row) => row.status === "pending" && !patchIsCore(patchRowId(row))).length;

  let reason = "";
  if (!coreComplete) {
    if (coreDisabled > 0) reason = "core-disabled";
    else if (coreFailed > 0) reason = "core-failed";
    else if (corePending > 0) reason = "core-pending";
    else if (!hostWritten || !flashOk || hookDenyFailed) reason = "host-incomplete";
  }

  return {
    complete: input.complete === true,
    core_complete: coreComplete,
    core_total: allCoreIds.length,
    core_failed: coreFailed,
    core_pending: corePending,
    other_failed: otherFailed,
    other_pending: otherPending,
    applied: report.filter((row) => DONE_STATUSES.has(row.status)).length,
    pending: report.filter((row) => row.status === "pending").length,
    failed: failedIds.size,
    total: report.length,
    at: new Date().toISOString(),
    reason: input.complete === true && reason === "" ? "" : reason,
  };
}

export function patchStatePath(home) {
  return path.join(String(home || ""), "dsh-forge", "patch-state.json");
}

export function readPatchState(home) {
  if (!home) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(patchStatePath(home), "utf8"));
    return {
      complete: raw.complete === true,
      core_complete: raw.core_complete === true,
      core_total: Number(raw.core_total) || 0,
      core_failed: Number(raw.core_failed) || 0,
      core_pending: Number(raw.core_pending) || 0,
      other_failed: Number(raw.other_failed) || 0,
      other_pending: Number(raw.other_pending) || 0,
      applied: Number(raw.applied) || 0,
      pending: Number(raw.pending) || 0,
      failed: Number(raw.failed) || 0,
      total: Number(raw.total) || 0,
      at: typeof raw.at === "string" ? raw.at : "",
      reason: typeof raw.reason === "string" ? raw.reason : "",
    };
  } catch {
    return null;
  }
}

export function writePatchState(home, state) {
  if (!home) return null;
  const payload = {
    complete: state?.complete === true,
    core_complete: state?.core_complete === true,
    core_total: Number(state?.core_total) || 0,
    core_failed: Number(state?.core_failed) || 0,
    core_pending: Number(state?.core_pending) || 0,
    other_failed: Number(state?.other_failed) || 0,
    other_pending: Number(state?.other_pending) || 0,
    applied: Number(state?.applied) || 0,
    pending: Number(state?.pending) || 0,
    failed: Number(state?.failed) || 0,
    total: Number(state?.total) || 0,
    at: typeof state?.at === "string" && state.at ? state.at : new Date().toISOString(),
    reason: typeof state?.reason === "string" ? state.reason : "",
  };
  const fp = patchStatePath(home);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  atomicWriteSync(fp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}
