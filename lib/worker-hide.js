/**
 * 运行时隐藏执行角色预设（*-worker）。
 *
 * 背景：spawn 只认预设 id，worker 预设必须注册；但 PresetDefinition 没有 hidden
 * 字段，新建会话下拉会把它们列出来。文件补丁（#93/#95）打不到实际运行的前端副本
 * （桌面版从 app.asar 加载），所以在 registry 服务上过滤对外的 roster；
 * worker 仍按 id 解析，子会话派发不受影响。
 *
 * 真机实测（2026-11-04，190 次 boot 日志）：boot 时 agentPresets 服务几乎总是
 * 尚未就绪，一次性尝试必然落空。这里改成轮询重试，装上为止；context 销毁即停。
 *
 * 网关侧匹配：客户端只经 `agentPresets/list`（remoteExportList）取选择花名册，
 * 网关每次调用动态 `Reflect.get(receiver, impl)`，实例自有属性优先于原型方法，
 * 所以包一层实例属性即可生效。
 */

/** 尝试一次安装；装上（含已在）返回 true。 */
export function tryHideWorkerPresets(ctx) {
  try {
    const reg = typeof ctx.get === "function" ? ctx.get("agentPresets") : null;
    if (reg && typeof reg.remoteExportList === "function" && !reg.__dshForgeWorkerHidden) {
      const original = reg.remoteExportList.bind(reg);
      reg.remoteExportList = async function () {
        const out = await original();
        if (!out || !Array.isArray(out.presets)) return out;
        return Object.assign({}, out, {
          presets: out.presets.filter((row) => !/-worker$/i.test(String((row && row.id) || ""))),
        });
      };
      reg.__dshForgeWorkerHidden = true;
      return true;
    }
    if (reg && reg.__dshForgeWorkerHidden) return true; // 已装过（插件重载场景）
  } catch { /* 拿不到服务就算了，交给重试 */ }
  return false;
}

/**
 * 安装；服务未就绪时按固定间隔重试，最多 maxTries 次。
 * @param {object} opts
 * @param {number} [opts.intervalMs=2000] 重试间隔。
 * @param {number} [opts.maxTries=30] 重试上限（默认约 60s）。
 * @param {(tag: string, kv?: object) => void} [opts.log] 日志回调（传 forgeLog）。
 * @returns {boolean} 是否当场装上（false = 已转入重试或放弃）。
 */
export function hideWorkerPresets(ctx, opts = {}) {
  const { intervalMs = 2000, maxTries = 30, log = () => {} } = opts;
  if (tryHideWorkerPresets(ctx)) {
    log("presets.worker-hidden", { mode: "runtime" });
    return true;
  }
  let tries = 0;
  let timer = null;
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  timer = setInterval(() => {
    if (tryHideWorkerPresets(ctx)) {
      stop();
      log("presets.worker-hidden", { mode: "runtime-retry", tries: tries + 1 });
      return;
    }
    tries += 1;
    if (tries >= maxTries) {
      stop();
      log("presets.worker-hidden", { mode: "giveup", tries });
    }
  }, intervalMs);
  try {
    ctx.effect(() => stop);
  } catch {
    stop(); // context 已死：不再重试
  }
  return false;
}
