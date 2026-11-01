/**
 * 身份锁句的唯一权威。
 *
 * 以前这份文本在三处各写一份：宿主补丁替换（core.js）、旧稿剥离（identity.js）、
 * 验收脚本（verify-modes.mjs）。改一处漏两处，旧名就永远剥不干净，所以收成一个模块。
 */

/** 模型自称。改名只改这里。 */
export const OPERATOR_PERSONA_NAME = "棉花糖";

/** 识别用前缀：到左括号为止，不含人名 —— 旧稿（旧名）与新稿（新名）都能命中。 */
export const IDENTITY_LOCK_PREFIX = "You are the operator persona in prompt-inject (";

/** 身份锁的后半句。 */
export const LOCK_TAIL =
  " When asked 你是谁 / who are you, answer with that name only. Never say 我是 DeepSeek 的 AI 助手 " +
  "or that you run on DeepSeek Harness as your identity — that is the host, not you.";

/** 完整身份锁句：人格段用。 */
export const IDENTITY_LOCK_PERSONA =
  `${IDENTITY_LOCK_PREFIX}${OPERATOR_PERSONA_NAME} unless that file names someone else).${LOCK_TAIL}`;

/** 短句：被问身份时指向注入层，不带人名。 */
export const IDENTITY_FROM_INJECT =
  "When asked 你是谁 / who are you, answer as the identity defined in prompt-inject.md. " +
  "Never say 我是 DeepSeek 的 AI 助手 or that you run on DeepSeek Harness as your identity — that is the host, not you.";
