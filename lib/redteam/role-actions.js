/**
 * 角色禁写清单（红队执行角色）。
 *
 * 用「减法」而不是白名单：只列这个角色明确不该碰的动作，其余一律放行。
 * 原因：每个角色的稿子里都要求写 chain_add / asset_test / shot_add，
 * 用白名单会把角色自己的流程挡死（口径冲突）。
 *
 * 认不出角色（主会话、老会话）时不做任何限制。
 */
/* 注意：越界拦截当前**未接入**执行链路（tools.js 的 collect 不再包装）。
   判定函数保留，需要时再接，避免再次因为理论风险影响正常流程。 */
export const ROLE_DENY = {
  /* 侦察只做资产与入口，不碰凭据/通道/后渗透 */
  recon: [
    'access_add',
    'webshell_add', 'webshell_update',
    'tunnel_add', 'tunnel_update',
    'vps_exec', 'vps_put', 'vps_get',
  ],
  /* 扫描只出候选，不改漏洞状态，也不碰凭据/通道 */
  'vuln-scan': [
    'vuln_update',
    'access_add',
    'webshell_add', 'webshell_update',
    'tunnel_add', 'tunnel_update',
    'vps_exec', 'vps_put', 'vps_get',
  ],
  /* 评估可以更新漏洞、写证据，但不建通道、不拿会话 */
  assess: [
    'access_add',
    'webshell_add', 'webshell_update',
    'tunnel_add', 'tunnel_update',
    'vps_exec', 'vps_put', 'vps_get',
  ],
  /* 利用/内网需要写凭据、通道、会话，不设限 */
  exploit: [],
  internal: [],
  webapi: [
    'credential_add',
    'access_add',
    'webshell_add', 'webshell_update',
    'tunnel_add', 'tunnel_update',
    'vps_exec', 'vps_put', 'vps_get',
  ],
  intranet: [],
  reverse: [
    'credential_add',
    'access_add',
    'webshell_add', 'webshell_update',
    'tunnel_add', 'tunnel_update',
    'vps_exec', 'vps_put', 'vps_get',
  ],
  verify: [
    'credential_add',
    'access_add',
    'webshell_add', 'webshell_update',
    'tunnel_add', 'tunnel_update',
    'vps_exec', 'vps_put', 'vps_get',
    'vuln_update',
  ],
}

/**
 * 这个角色能不能执行这个动作。
 * @param role - 角色码；空字符串表示主会话或无角色。
 * @param op - redteam 动作名（不带 redteam_ 前缀）。
 * @returns 被禁止时返回 true。
 */
export function deniedForRole(role, op) {
  const key = String(role || '').trim().toLowerCase()
  const name = String(op || '').trim()
  if (!key || !name) return false
  const deny = ROLE_DENY[key]
  if (!Array.isArray(deny) || deny.length === 0) return false
  return deny.includes(name)
}

/** 给模型看的拒绝文案：说清是谁越界、该谁做。 */
export function roleDeniedMessage(role, op) {
  return `动作 ${op} 不属于 ${role} 角色的职责，已被拒绝。`
    + '不要换名重试：把缺口写进回包，交给主会话安排对应角色处理。'
}

/**
 * 子会话回包是否缺少「落库 id / 证据路径」。
 * 只做标注，不阻断：缺了就把回包标成可疑，让主会话复核或让子会话补。
 */
export function replyMissingHandoff(text) {
  const body = String(text || '')
  if (body.trim().length < 40) return false
  /* 已经说明卡住/没做完的，不需要再提醒。 */
  if (/(未完成|无法|缺参数|缺凭据|缺工具|blocked|卡点|需要授权|失败)/i.test(body)) return false
  const hasId = /\b(?:asset|vuln|credential|shot|access|webshell|tunnel|hyp|chain)_?[a-z]*\s*[:#：]?\s*\d+/i.test(body)
    || /落库\s*[:：]?\s*\S{0,12}\d/.test(body)
  const hasEvidence = /\b[\w-]+\.(png|jpg|jpeg|txt|json|har|log)\b/i.test(body)
    || /\b(shots?|runs?|evidence|http_evidence)\//i.test(body)
  return !(hasId || hasEvidence)
}

/**
 * 派活任务书必填的三行。
 * 角色稿靠 `redteamRole:` 注入，靶标绑定靠 `engagement:`，覆盖矩阵靠 `test_class:`。
 * 少一行就静默降级成通用执行者，所以派发前直接拦。
 */
export const REQUIRED_BRIEF_LINES = [
  { key: 'engagement', label: 'engagement: <靶标 id>', re: /^\s*engagement\s*[:：]/im },
  {
    key: 'redteamRole',
    label: 'redteamRole: recon|assess|vuln-scan|exploit|internal|webapi|intranet|reverse|verify',
    re: /^\s*redteamRole\s*[:：]\s*(recon|assess|vuln-scan|exploit|internal|webapi|intranet|reverse|verify)\s*$/im,
  },
]

/** 建议写、缺了只提示不拒绝的行：批量录入/整理类任务没有 test_class 也正常。 */
export const RECOMMENDED_BRIEF_LINES = [
  {
    key: 'test_class',
    label: 'test_class: <authn|authz|injection|file|ssrf|logic|client|infra>',
    re: /^\s*test_class\s*[:：]/im,
  },
]

/**
 * 返回任务书缺的必填行；空数组表示可以派。
 * @param text - 子会话任务书正文（subagent 工具的 prompt）。
 */
export function missingBriefFields(text) {
  const body = String(text || '')
  return REQUIRED_BRIEF_LINES.filter((item) => !item.re.test(body)).map((item) => item.label)
}

/** 返回任务书缺的建议行（当前只有 test_class）。 */
export function missingBriefHints(text) {
  const body = String(text || '')
  return RECOMMENDED_BRIEF_LINES.filter((item) => !item.re.test(body)).map((item) => item.label)
}
