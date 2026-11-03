/**
 * 重启前看系统提示词文件：标记写上了，或者当前原文里已经没有那两处旧拦截。
 *
 * macOS 只打核心补丁集（不含 #25 identity），所以用 requireIdentity:false 放宽：
 * 只要 #40 的注入 marker 在就算干净。默认仍要求 identity marker，Windows 行为不变。
 */
export function hostPromptKeepsInject(text, options = {}) {
  const body = String(text || "");
  const injectMarked = body.includes("[dsh-forge] complete prompt keeps waterfall inject")
    || body.includes("[dsh-forge] complete prompt keeps inject");
  if (options.requireIdentity === false) return injectMarked;
  const identityMarked = body.includes("[dsh-forge] identity stripped");
  if (identityMarked && injectMarked) return true;
  // 空文件或不是这份模块，不能当成已经洗过。
  if (!body.includes("system-prompt/assemble")) return false;
  const identityLeft = body.includes("You are an AI agent powered by DeepSeek Harness.");
  const dropsInject = body.includes("transformed.sections : [completeSection]");
  return !identityLeft && !dropsInject;
}
