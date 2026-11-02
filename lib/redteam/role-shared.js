/**
 * 红队角色稿的共享尾部。
 *
 * 五个角色（recon/assess/vuln-scan/exploit/internal）末尾原本各带一整段一模一样的
 * 「直接开工 / 动手前先查库 / 落库 / 回报」（约 555 字）。复制五份的后果是：
 * 改一处要改五处，漂移了也没人发现。
 *
 * 这里只保留一份：从 DEFAULT_PROMPTS.recon 切出来当规范文本（它本来就带这段），
 * 注入时把角色文件里的旧尾部换成这一份。想改收口要求，改 recon 的这段即可。
 */
import { DEFAULT_PROMPTS } from './store-core.js'

const MARKER = '直接按用户给的目标开工'

/** 规范尾部（只读）。 */
export const SHARED_ROLE_TAIL = (() => {
  const text = String(DEFAULT_PROMPTS.recon || '')
  const at = text.indexOf(MARKER)
  return at >= 0 ? text.slice(at).trim() : ''
})()

/**
 * 角色稿 = 独有部分 + 规范尾部。
 * 旧文件里自带的尾部会被裁掉再补，保证五份收口永远一致；
 * 没有尾部的自定义角色稿原样保留独有部分。
 */
export function composeRoleText(text) {
  const raw = String(text || '').trim()
  if (!raw || !SHARED_ROLE_TAIL) return raw
  const at = raw.indexOf(MARKER)
  const intro = (at >= 0 ? raw.slice(0, at) : raw).trim()
  if (!intro) return SHARED_ROLE_TAIL
  return `${intro}\n\n${SHARED_ROLE_TAIL}`
}

/**
 * 靶标目录里角色稿缺失时用的默认稿。
 * 文件被删/没生成过时，子会话不能静默变成"没有角色的通用执行者"。
 */
export function defaultRoleText(role) {
  const key = String(role || '').trim()
  if (!key || key === 'plan') return ''
  return composeRoleText(DEFAULT_PROMPTS[key] || '')
}
