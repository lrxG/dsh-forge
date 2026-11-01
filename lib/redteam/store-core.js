/**
 * RedTeam 资产库核心（无 Cordis 依赖）
 *
 * 这里只做三件事：靶标工作区（目录 + 元数据）、SQLite 事实库（schema/写入/查询）、
 * 提示词与技能库的文件读写。Cordis 插件壳在 ./index.js，命令行壳在 ../bin/cli.mjs；
 * 两者共用本模块，保证「界面看到的」「智能体查到的」「命令行验的」是同一份实现。
 */
import { DatabaseSync } from 'node:sqlite'
import { connect as tcpConnect } from 'node:net'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import {
  mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync, statSync,
  copyFileSync,
} from 'node:fs'
import { join, basename, isAbsolute, dirname, resolve } from 'node:path'

/* ── 拆分出去的模块（对外 API 不变：下面把它们原样再导出一次）──────────────
   动机是"一个文件 5600 行、改表结构要翻过 500 行计分逻辑"：
   · ip-utils.js    IP / 网段 / slug / 时间戳等纯函数；
   · schema.js      两张表的 DDL 与两处增量迁移；
   · validate.js    写库前的校验与规范化（路径穿越、非法枚举）。 */
import {
  ipToInt, cidrOf, isIpv6, expandIpv6, scopeOfIp, slugify, slugTarget, slugPoc,
  defaultPocFilename, nowIso,
} from './ip-utils.js'
import { parseHttpPackets } from '../http-evidence-core.js'
import {
  DDL, KNOWLEDGE_DDL, ASSET_FTS_DDL, POC_FTS_DDL, HAS_FTS5,
  POC_CATEGORIES, pocCategoryName, guessPocCategory, guessTemplateCategory,
  migrate, migrateKnowledge,
} from './schema.js'
import {
  WEBSHELL_TYPES, WEBSHELL_STATUSES, normalizeShellType, normalizeShellStatus, assertPathWithin,
} from './validate.js'
/* 范围解析：和面板表单同一份实现（lib/scope-core.js），避免「界面能填、库里也存」的两套标准 */
import { dfScopeNormalize } from '../scope-core.js'
import { TUNNEL_ENTRY_KINDS, tunnelIsLegit, parseTargetPort, normalizePort } from './target-net.js'
import { buildOverview, buildMatrix, buildActivity, TEST_CLASSES } from './view-model.js'
import {
  platformSummary, savePlatformConfig, assignToolkitFolder, loadPlatformConfig, nucleiTemplatesDirOf,
  removePlatformToolRoot,
} from './platform-config.js'
import {
  toolboxHome, loadRegistry, syncRegistry, setToolStatus as setToolboxStatus, addRoot as addToolboxRoot,
  removeRoot as removeToolboxRoot, setToolMeta as setToolboxMeta, rootsOf as toolboxRootsOf,
  setToolPath as setRegistryToolPath, forgetTool as forgetRegistryTool,
} from '../toolbox/registry.js'

/* 再导出：core.js 的对外导出面与拆分前完全一致（调用方零改动） */
export {
  ipToInt, cidrOf, isIpv6, expandIpv6, scopeOfIp, slugify, slugTarget, slugPoc,
  defaultPocFilename, nowIso,
  DDL, KNOWLEDGE_DDL, ASSET_FTS_DDL, POC_FTS_DDL, HAS_FTS5,
  POC_CATEGORIES, pocCategoryName, guessPocCategory,
  migrate, migrateKnowledge,
  WEBSHELL_TYPES, WEBSHELL_STATUSES, normalizeShellType, normalizeShellStatus, assertPathWithin,
}

/* ------------------------------------------------------------------ 角色与枚举 */
/**
 * 作战角色（六个）。角色 code 同时用于：
 *   · 角色提示词文件 `engagements/<靶标>/agents/<code>.md`
 *   · 攻击步骤/漏洞/凭据上的 `agent` 列（报告要写清"这条是谁做的"）
 *   · 主会话派活时的角色选择
 * `plan` 是主会话（指挥）自己，不派出去，只用于提示词面板里查看/微调人设。
 */
const ROLE_TITLES = {
  plan: '主会话（指挥）',
  recon: '信息收集',
  assess: '资产梳理',
  'vuln-scan': '漏洞发现',
  exploit: '漏洞利用',
  internal: '内网渗透',
}

/** 漏洞严重级（按展示优先级排列）。 */
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']

/** 漏洞处置状态。 */
const VULN_STATUSES = ['candidate', 'confirmed', 'false-positive', 'exploited', 'fixed']

/** 工具名归一：`curl -X POST …` → curl，`/usr/bin/nmap` → nmap，`sqlmap.py` → sqlmap。 */
function canonicalToolName(raw) {
  const text = String(raw == null ? '' : raw).trim()
  if (!text) return ''
  let token = text.split(/[\s|;&]+/)[0].replace(/^["']|["']$/g, '')
  const base = token.split(/[\\/]/).pop() || token
  return base.replace(/\.(exe|py|ps1|bat|cmd|sh|js|pl|rb)$/i, '') || base
}

/**
 * 只能由人给的判定。AI 负责「发现」与「复现」：candidate / exploited；
 * confirmed / false-positive / fixed 是复核结论，智能体工具写入会被拒绝。
 */
const HUMAN_VULN_VERDICTS = ['confirmed', 'false-positive', 'fixed']

/** AI 写了人类判定时返回拒绝理由；可以写则返回空串。 */
function humanVerdictBlock(status) {
  const s = String(status == null ? '' : status).trim()
  if (!HUMAN_VULN_VERDICTS.includes(s)) return ''
  return `${s} 是人工复核结论，智能体不要写：发现写 candidate、复现成功写 exploited，等人在面板确认或判误报`
}

/** 待人工复核：发现/复现过但还没给人下结论。 */
const PENDING_REVIEW_STATUSES = ['candidate', 'exploited']

/** 隧道状态。新增与更新必须同一套校验，否则非法值会静默入库。 */
const TUNNEL_STATUSES = ['active', 'down', 'closed', 'unknown']

export { ROLE_TITLES, SEVERITIES, VULN_STATUSES, HUMAN_VULN_VERDICTS, PENDING_REVIEW_STATUSES, humanVerdictBlock }

/* ------------------------------------------------------------------ schema */


/* ------------------------------------------------------------------ 知识库（POC/EXP，全局共享） */


/**
 * 知识库归类（与攻击面口径对齐）：智能体回填时必须选一个，
 * 面板按它分组，用户才能"一类一类看"而不是几百条平铺。
 */
/* ------------------------------------------------------------------ 知识库常量 */

/** POC 类型：poc=验证性利用、exp=可执行利用、template=nuclei 等模板、script=辅助脚本、payload=载荷。 */
const POC_KINDS = ['poc', 'exp', 'script', 'template', 'payload', 'lesson']
/** 来源：web=互联网扒的、self=智能体手搓、manual=人写的、nuclei-template=模板库。 */
const POC_SOURCES = ['web', 'self', 'manual', 'nuclei-template', 'kb']
export { POC_KINDS, POC_SOURCES }




/* ------------------------------------------------------------------ 迁移 */

/** 允许的马类型（与技能 webshell-toolkit 交付要求一致：冰蝎 / 哥斯拉是"用户能连上"的加密马）。 */

/**
 * 目标归并：同一条漏洞的 target 可能带路径/参数（http://h:8080/a/b、10.0.0.5:6379），
 * 聚合视图要按「站点/服务」而不是按完整 URL 分组，否则 300 条漏洞会聚成 300 组。
 */
export function targetKey(target, fallbackIp) {
  const t = String(target || '').trim()
  if (t !== '') {
    const url = /^([a-z][a-z0-9+.-]*:\/\/[^/?#\s]+)/i.exec(t)
    if (url !== null) return url[1]
    const head = /^([^\s/?#]+)/.exec(t)
    if (head !== null) return head[1]
    return t
  }
  return fallbackIp || '(未指定目标)'
}

/** 安全解析 JSON 列（坏数据回退默认值）。 */
const parseJson = (value, fallback) => {
  try {
    const parsed = JSON.parse(value)
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch { return fallback }
}

/** 把「通过这个漏洞拿到了什么」规范化成一行短标签：数组或分隔串 → 「A、B」。 */
function normGained(value) {
  if (value === undefined || value === null) return null
  const parts = Array.isArray(value) ? value : String(value).split(/[,;，；]/)
  const out = parts.map((x) => String(x).trim()).filter(Boolean)
  return out.length > 0 ? out.join('、') : null
}

/**
 * 从 target 取主机名（不带端口）：`https://a.test:8443/x` → `a.test`。
 * 端口、路径、查询串都不算资产标识，面板的「资产」一行只用主机名。
 */
function hostOfTarget(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`
  try {
    const u = new URL(withScheme)
    return String(u.hostname || '').replace(/^\[|\]$/g, '')
  } catch { return '' }
}

/**
 * 只有明确的 HTTP(S) 目标才要求 HTTP 报文。
 * 数据库、SSH、弱口令这类漏洞没有请求/响应可交，硬要 http_evidence 等于永远补不上。
 * Web 漏洞请把 target 写成完整 URL（https://host/path），别只写裸主机名。
 */
function isHttpTarget(value) {
  return /^https?:\/\//i.test(String(value || '').trim())
}

/**
 * 这条漏洞「能造成什么影响」：交付物里这是必填项，不能空着。
 * 智能体写过 gained 就用它（agent 最清楚拿到了什么），否则按标题关键词兜一句。
 * 报告与面板共用同一句，避免两边口径不一致。
 */
function vulnImpactOf(v) {
  const s = String((v && v.gained) || '').trim()
  if (s) return s
  const title = String((v && v.title) || '') + ' ' + String((v && v.evidence) || '')
  if (/命令执行|rce|代码执行|后门|反序列化/i.test(title)) return '可在目标主机执行任意命令，攻击者可直接控制该主机，并以它为跳板横向移动。'
  if (/sql\s*注入|注入/i.test(title)) return '可读取或篡改数据库数据，严重时可进一步获取主机权限。'
  if (/上传/i.test(title)) return '可上传恶意文件并在服务端执行，进而控制 Web 主机。'
  if (/越权|未授权|认证绕过|绕过|idor/i.test(title)) return '可越权访问他人数据或管理功能，造成数据泄露与越权操作。'
  if (/泄露|暴露|敏感/i.test(title)) return '可获取敏感配置、凭据或业务数据，为后续攻击提供条件。'
  if (/xss|跨站/i.test(title)) return '可在受害者浏览器执行脚本，窃取会话或诱导操作。'
  if (/弱口令|默认口令|暴力/i.test(title)) return '可凭猜解/默认账号登录，直接获得对应系统的访问权限。'
  return (v && v.severity) === 'medium'
    ? '可扩大攻击面，配合其他漏洞可提升整体危害。'
    : '该资产可被进一步利用，作为进入内网的跳板。'
}

/**
 * 内外网判定（SQL 片段，作用于 asset.ip）：
 * RFC1918 私网 + 回环 + 链路本地 + CGNAT 视为内网，其余为外网。
 */
const SCOPE_SQL = `CASE
  WHEN ip LIKE '10.%' OR ip LIKE '192.168.%' OR ip LIKE '127.%' OR ip LIKE '169.254.%'
    OR (ip LIKE '172.%' AND CAST(substr(ip, 5, instr(substr(ip, 5), '.') - 1) AS INTEGER) BETWEEN 16 AND 31)
    OR (ip LIKE '100.%' AND CAST(substr(ip, 5, instr(substr(ip, 5), '.') - 1) AS INTEGER) BETWEEN 64 AND 127)
  THEN 'internal' ELSE 'external' END`


/* ------------------------------------------------------------------ 元数据 */

function readMeta(path) {
  if (!existsSync(path)) return undefined
  const out = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line)
    if (!m) continue
    const v = m[2].trim()
    if (v.startsWith('[') && v.endsWith(']')) {
      out[m[1]] = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    } else {
      out[m[1]] = v.replace(/^["']|["']$/g, '')
    }
  }
  return out
}

function writeMeta(path, meta) {
  const lines = []
  for (const [k, v] of Object.entries(meta)) {
    if (Array.isArray(v)) lines.push(`${k}: [${v.join(', ')}]`)
    else if (v !== undefined && v !== null) lines.push(`${k}: ${v}`)
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf8')
}


/* ------------------------------------------------------------------ 默认内容 */

/* ------------------------------------------------------------------ 攻击链（五阶段） */

/**
 * 攻击链的五个阶段：按「攻击面位置」串起来 —— 互联网侧收集 → 互联网侧拿权限 →
 * 打穿边界 → 内网拿权限 → 拿靶标。
 *
 * sections = 该阶段的打法要点（数据仍保留给提示词与面板编辑用；攻击链页面已不再展示，
 * 避免执行细节淹没"打到哪了、拿了多少分"）；tools = 常用工具。
 */
export const DEFAULT_STAGES = [
  {
    code: 'recon', name: '信息收集', subtitle: 'RECON · 互联网侧', color: '#06b6d4', scored: 0,
    goal: '在互联网侧展开信息收集，确定值得打的资产面',
    sections: [
      { label: '资产测绘', items: ['子域名 / C 段 / 端口指纹', 'FOFA、被动 DNS、证书透明、主动扫描'] },
      { label: '攻击面确认', items: ['Web 标题与指纹、暴露的服务与管理端口', '归属、WAF / CDN 识别'] },
      { label: '攻击面排序', items: ['按易打性与预期成果排序', '确定先打哪几台'] },
    ],
    tools: 'ARL / 灯塔、fscan、OneForAll、ENScan、Goby、Nmap、Burp、Nuclei',
    transition: '确认互联网攻击面，转入利用',
  },
  {
    code: 'internet', name: '互联网资产权限', subtitle: 'INTERNET-SIDE PRIVILEGE', color: '#ef4444', scored: 1,
    goal: '在互联网侧资产上拿到账号、权限等成果',
    sections: [
      { label: '拿账号', items: ['弱口令 / 越权 / 未授权 / 逻辑漏洞', '后台管理员、普通账号'] },
      { label: '拿权限', items: ['Nday / 1day RCE、文件上传、反序列化', 'WebShell、命令执行、服务器权限'] },
      { label: '拿数据', items: ['数据库、配置泄露、批量敏感信息'] },
    ],
    tools: 'sqlmap、Nuclei、冰蝎 / 哥斯拉 / 蚁剑、fscan、Burp、自定义 POC',
    transition: '用已控主机打通出网通道',
  },
  {
    code: 'boundary', name: '边界突破', subtitle: 'BOUNDARY BREACH · TUNNEL', color: '#f59e0b', scored: 1,
    goal: '成功搭建隧道，把控制能力延伸进内网',
    sections: [
      { label: '隧道', items: ['suo5 / frp / Stowaway / Neo-reGeorg / Venom', 'socks5 落地、多级级联'] },
      { label: '出网通道', items: ['域名前置、CDN 隐藏、云函数转发', 'DNS / ICMP / 443 隐蔽信道'] },
    ],
    tools: 'suo5、frp、Stowaway、Neo-reGeorg、GOST、proxychains、chisel',
    transition: '隧道就绪，转入内网',
  },
  {
    code: 'internal', name: '内网资产权限', subtitle: 'INTERNAL-SIDE PRIVILEGE', color: '#8b5cf6', scored: 1,
    goal: '通过隧道在内网资产上拿分',
    sections: [
      { label: '内网测绘', items: ['存活 / 端口 / 服务 / 共享目录', '数据库、中间件、备份系统'] },
      { label: '横向与提权', items: ['凭据复用、Pass-the-Hash、票据', 'PsExec / WMIExec / SSH / RDP'] },
      { label: '数据', items: ['批量导出敏感信息，落 runs/ 并记引用'] },
    ],
    tools: 'fscan（走隧道）、Impacket、Mimikatz / LaZagne、BloodHound、suo5',
    transition: '定位内网核心靶标',
  },
  {
    code: 'target', name: '靶标权限', subtitle: 'TARGET SYSTEM', color: '#10b981', scored: 1,
    goal: '获取内网重要资产（靶标）的权限',
    sections: [
      { label: '靶标定位', items: ['按演练规则确认靶标系统 / 服务器范围', '明确成果判定口径'] },
      { label: '拿靶标', items: ['root / SYSTEM / 管理员 / 云 AK', '业务数据读写与配置变更能力'] },
      { label: '成果固化', items: ['证据链归档（配置 / 数据 / 主机信息 / 截图）', '攻击时间线回顾'] },
    ],
    tools: '凭据复用、内网横向工具、证据链归档与报告',
    transition: '',
  },
]


/** 攻击链 stage 入参 → 阶段 code 的别名映射。 */
export const STAGE_ALIASES = {
  recon: 'recon', vuln: 'internet', exploit: 'internet',
  access: 'internal', pivot: 'boundary', data: 'internal', other: 'recon',
}

/**
 * 攻击链步骤允许的作战阶段 code —— 只有这 5 个会被攻击链页面分桶。
 * 写入其它值（尤其外部工具常见的 external / foothold / tunnel / privilege）会被忽略
 * 并退回按 stage 兜底，步骤就不落在任何阶段，所以服务端显式校验并回告警。
 */
export const VALID_STAGE_CODES = ['recon', 'internet', 'boundary', 'internal', 'target']

/* ------------------------------------------------------------------ 提示词版本 */

/**
 * 提示词指纹（sha1 前 12 位）：判断靶标里存的是不是当前内置默认。
 * 是默认就跟着版本走；用户自己改过的永不覆盖。
 * 指纹记在 `agents/.defaults.json`，不再维护历史默认表。
 */

/** 提示词内容指纹。 */
function promptHash(text) {
  return createHash('sha1').update(String(text === undefined || text === null ? '' : text).trim()).digest('hex').slice(0, 12)
}

// __REDTEAM_PROMPTS_BLOCK__
// __REDTEAM_PROMPTS_BLOCK__
// __REDTEAM_PROMPTS_BLOCK__
// __REDTEAM_PROMPTS_BLOCK__
// __REDTEAM_PROMPTS_BLOCK__
// __REDTEAM_PROMPTS_BLOCK__
// __REDTEAM_PROMPTS_BLOCK__
/* ------------------------------------------------------------------ 角色公共段落

   由 packages/redteam-store/tools/gen-prompts.mjs 生成，**不要直接改这一段**：
   改 prompts.src.js（公共段落）与 prompts.roles.md（角色正文）后重新生成。
   现在 core.js 是唯一运行时产物，运行时不读那两个源文件。 */

const COMMON_ENV = `本模式会真实发包、上传文件、建立隧道。首次开工时用一句话提醒用户在专用演练机上操作，之后不再重复。
`

const COMMON_BIND = `直接按用户给的目标开工；用户补充了范围就照补充的执行。
`

const COMMON_SCORE_RULES = `## 记分
- code 与 evidence 都是必填，缺一个服务端直接报错，这一步等于没发生。evidence 只写结果：目标资产 + 拿到什么。
- 记分前先用 \`redteam_score_list\` 读实际 code、档位与上限，不要凭记忆写。
- 多档条目用 \`points\` 指定本次档位；同一系统按最高权限只记一次，后来提权再补一条高档会自动顶掉低档。
- 数据量写实际条数；只写「拖库成功」站不住。
- 规则累计到上限会返回 warning，把它当停止信号。
- \`redteam_chain_add\` 带 \`point_code\` + \`stage_code\` + \`evidence\` 可一次完成记分与关联。
`

const COMMON_DB_LOOKUP = `## 动手前先查库
查三样：该资产的状态与已封次数、已记录的漏洞、现成的 WebShell / 隧道 / 凭据。
已确认的不重测，测过的资产不重扫，被封多次的跳过。测完立刻 \`redteam_asset_test\` 回写状态。
`

const COMMON_EVIDENCE = `## 落库
每条发现都落库；每个关键动作写一条 \`redteam_chain_add\`：\`tool\` 写实际命令原文、\`detail\` 写为什么这么做、\`result\` 写回显摘要、\`stage_code\` 取 recon / internet / boundary / internal / target 之一。
凭据写清来源与明文；入口（WebShell、隧道）登记后必须实测可用才算数。
报告只认可复现的成果：目标 → 拿到什么 → 怎么拿到的 → 原始请求。
Web/UI 漏洞复现后必须截图（\`browser\` 的 screenshot 或 \`redteam_capture\`），附 \`vuln_id\`；没截图不算交付。需要留证时用 \`redteam_shot_add\`，现场截图才写 \`kind=screenshot\`。
`

const COMMON_HANDOFF = `## 回报
分点给结论、落库 id、数字、卡点与下一步。不确定的不要写成成果。
`

/* ------------------------------------------------------------------ 角色提示词

   五个执行角色 + 主会话。角色稿只写判断与边界，命令由模型按现场拼。
   角色的 code 同时是提示词文件名（agents/<code>.md）与库里的 agent 列取值。 */

export const DEFAULT_PROMPTS = {
  plan: `# 主会话
按用户给的输入决定怎么开工：只给单位名就按侦察→梳理→漏洞发现→利用→内网往下推；给单个资产就直接打；给了明确指令就只做那件。
判断和裁决留在这里，执行按扇出度分：能切成互不依赖、每块要跑不少命令的活，一次消息里同时开子会话铺出去；有依赖、要用本会话状态、或判据必须看原貌才能定的活，自己串着做。
派活的单子自包含：目标范围、命中判据、交付格式、禁区，四条齐了再派；回包只当候选，打穿与否复现一次再算。
回报只给用户还不知道的增量，没有新东西就安静继续。

${COMMON_BIND}`,

  recon: `# 信息收集
目标是把资产面收完整并全部落库，不下漏洞结论、不做利用。
DNS 的 A / AAAA / CNAME 要列全，不能只取第一条解析结果；每条都要进资产库。
动手前想清三件事：还有哪条线索没跟、哪个网段还没摸到、哪个数据源还没用。
外网靠公开源与枚举，内网靠隧道加测绘工具；内网必须先确认隧道真能到目标，没有隧道就如实回报。
收口标准是「没有新线索」，不是「够用」；看到疑似漏洞点记进资产状态，交给后面的角色。
每轮结束核对数字，把缺口列出来。

${COMMON_BIND}

${COMMON_DB_LOOKUP}

${COMMON_EVIDENCE}

${COMMON_HANDOFF}`,

  assess: `# 资产梳理
把收集到的资产逐条判断易打性并给出优先级，不新增扫描、不做利用。
判断依据：暴露面（登录入口、管理端、非标端口）、技术栈新旧、是否测试或预发环境、是否已被测过、防护强度。
输出是每个资产该不该打、先打谁，让后面的人不用重新判断。

${COMMON_BIND}

${COMMON_DB_LOOKUP}

${COMMON_EVIDENCE}

${COMMON_HANDOFF}`,

  'vuln-scan': `# 漏洞发现
在已确认的资产上找能利用的问题，命中必须能复现才算数。
先看版本与暴露面，再决定批量过模板还是手工验证；模板只匹配到版本号不算命中。
与成果无关的信息泄露记一行排除结论即可。
一条高危确认后就停止对它的全量扫描，把结论交出去。

${COMMON_BIND}

${COMMON_DB_LOOKUP}

${COMMON_EVIDENCE}

${COMMON_HANDOFF}`,

  exploit: `# 漏洞利用
把已确认的问题变成实际权限：账号、数据、入口、隧道。
先用现成凭据与默认口令，其次才打漏洞；拿到的入口要能被用户复用。
每一步都要能复现，破坏性操作先评估影响面并留下恢复方式。

${COMMON_BIND}

${COMMON_DB_LOOKUP}

${COMMON_EVIDENCE}

${COMMON_HANDOFF}`,

  internal: `# 内网渗透
从已控主机往里走，目标是核心系统与更多可复用凭据。
先确认隧道真能到目标；横向的瓶颈是凭据，不是可达性。
拿到核心系统就收尾，继续刷主机只增加暴露。

${COMMON_BIND}

${COMMON_DB_LOOKUP}

${COMMON_EVIDENCE}

${COMMON_HANDOFF}`,
}

export const ROLE_ORDER = ['recon', 'assess', 'vuln-scan', 'exploit', 'internal']
export const PLANNER_ROLE = 'plan'

/* ------------------------------------------------------------------ 统一操作分发 */

/**
 * 统一操作分发：CLI、HTTP 桥接、（后续）智能体工具共用同一套 op 词汇，
 * 保证界面看到的、命令行验的、智能体写的是同一条路径。
 * @param store - RedteamStore 实例。
 * @param req - `{ op, engagement, ... }`。
 * @returns 可 JSON 序列化的结果（失败时 `{ ok: false, error }`）。
 */
export function dispatch(store, req = {}) {
  const op = typeof req.op === 'string' ? req.op.trim() : ''
  try {
    if (!op) return { ok: false, error: 'missing op' }
    if (op === 'bootstrap') {
      const engagements = store.listEngagements()
      const usable = engagements.filter((e) => !e.broken)
      /* 优先沿用「当前靶标」指针，其次才是最近创建且可用的靶标；缺库残骸只用于删除。 */
      const active = typeof store.activeEngagementId === 'function' ? store.activeEngagementId() : undefined
      const requested = req.engagement && usable.some((e) => e.id === req.engagement) ? req.engagement : null
      return {
        ok: true, root: store.root, engagements,
        current: requested || active || (usable[0] && usable[0].id) || null,
      }
    }
    if (op === 'openEngagement') {
      return { ok: true, engagement: store.openEngagement(req.name, req.scope) }
    }
    if (op === 'activateEngagement') {
      const activated = store.setActiveEngagement(req.engagement)
      return { ok: activated, current: store.activeEngagementId() }
    }
    /* 删除靶标：两步确认。先 engagementStats 看要删什么，再 deleteEngagement 带 id 确认；
       有成果时还要 force，避免手滑把整份战果连库删掉。 */
    if (op === 'engagementStats') {
      const id = String(req.engagement || '').trim()
      if (!id) return { ok: false, error: 'missing engagement' }
      const counts = store.engagementCounts(id)
      if (!counts) return { ok: false, error: '靶标不存在：' + id }
      return { ok: true, engagement: id, counts }
    }
    if (op === 'deleteEngagement') {
      const id = String(req.engagement || '').trim()
      if (!id) return { ok: false, error: 'missing engagement' }
      if (String(req.confirm || '').trim() !== id) {
        return { ok: false, error: '需要确认：confirm 必须是靶标 id 原值', needsConfirm: true, engagement: id }
      }
      const counts = store.engagementCounts(id)
      if (!counts) return { ok: false, error: '靶标不存在：' + id }
      if (counts.total > 0 && req.force !== true) {
        return { ok: false, error: '该靶标已有成果，需要 force:true 才能删除', needsForce: true, engagement: id, counts }
      }
      return Object.assign({ engagement: id, counts }, store.deleteEngagement(id))
    }
    if (op === 'deleteEngagements') {
      const ids = Array.from(new Set((Array.isArray(req.engagements) ? req.engagements : [])
        .map((x) => String(x || '').trim()).filter(Boolean)))
      if (!ids.length) return { ok: false, error: 'missing engagements' }
      if (ids.length > 100) return { ok: false, error: '一次最多删除 100 个靶标' }
      if (req.confirm !== true) {
        return { ok: false, error: '需要确认：confirm 必须为 true', needsConfirm: true, engagements: ids }
      }
      const rows = ids.map((id) => ({ id, counts: store.engagementCounts(id) }))
      const missing = rows.filter((r) => !r.counts).map((r) => r.id)
      if (missing.length) {
        return { ok: false, error: '部分靶标不存在：' + missing.join('、'), missing, engagements: ids }
      }
      const total = rows.reduce((n, r) => n + (r.counts.total || 0), 0)
      if (total > 0 && req.force !== true) {
        return {
          ok: false, error: '选中的靶标已有成果，需要 force:true 才能删除',
          needsForce: true, engagements: ids,
          counts: Object.fromEntries(rows.map((r) => [r.id, r.counts])),
        }
      }
      return store.deleteEngagements(ids)
    }
    /* 知识库是全局的（跨靶标共享），所以这几个 op 不需要 engagement */
    if (op === 'pocSearch') {
      const items = store.searchPocs(req)
      /* "现成的"有两层：本机沉淀的 POC/EXP + 本机 nuclei 模板库。一次返回，省一轮往返。
         归类筛选与翻页对两层同时生效，面板的胶囊计数才和列表一致。 */
      const q = req.q || req.query || req.cve || req.component || ''
      const templates = store.searchTemplates(
        q,
        Math.min(Number(req.templateLimit) || 20, 100),
        Number(req.templateOffset) || 0,
        req.category || '',
      )
      return { ok: true, items, stats: store.pocStats(), templates, dbPath: store.knowledgePath(), root: store.root }
    }
    if (op === 'pocList') return { ok: true, items: store.searchPocs(req), stats: store.pocStats(), dbPath: store.knowledgePath(), root: store.root }
    if (op === 'templateSearch') return Object.assign({ ok: true }, store.searchTemplates(
      req.q, Math.min(Number(req.limit) || 40, 200), Number(req.offset) || 0, req.category || '',
    ))
    if (op === 'templateStats') return { ok: true, stats: store.templateStats() }
    if (op === 'pocGet') return Object.assign({ ok: true }, store.getPoc(req.id !== undefined ? req.id : req.code))
    if (op === 'pocSave') return Object.assign({ ok: true }, store.savePoc(req.poc || req))
    if (op === 'pocUpdate') return { ok: true, poc: store.updatePoc(req.id !== undefined ? req.id : req.code, req.patch || req) }
    if (op === 'pocDelete') return Object.assign({ ok: true }, store.deletePoc(req.id !== undefined ? req.id : req.code))
    if (op === 'pocUse') return Object.assign({ ok: true }, store.markPocUsed(req.id !== undefined ? req.id : req.code, req.used_on))
    if (op === 'pocStats') return { ok: true, stats: store.pocStats() }
    /* 环境适配：全局，不依赖靶标；面板 / CLI / 工具共用 */
    if (op === 'platformConfigGet') return platformSummary(store.root)
    if (op === 'platformConfigSave') {
      savePlatformConfig(req.config || {}, store.root)
      return platformSummary(store.root)
    }
    if (op === 'platformAssignToolkit') return assignToolkitFolder(req.dir, store.root)
    /* 工具登记表是全局的：没有靶标也必须能同步、加/删目录、标注、编辑卡片。 */
    const toolMode = req.mode === 'crack' ? 'crack' : 'redteam'
    if (op === 'toolboxSync') return Object.assign({ ok: true }, store.toolboxSync(toolMode))
    if (op === 'toolboxAddRoot') return Object.assign({ ok: true }, store.toolboxAddRoot(req.dir, toolMode))
    if (op === 'toolboxRemoveRoot') return Object.assign({ ok: true }, store.toolboxRemoveRoot(req.dir, toolMode))
    if (op === 'toolboxSet') return Object.assign({ ok: true }, store.toolboxSet(req.name, req, toolMode))
    if (op === 'toolboxMeta') return Object.assign({ ok: true }, store.toolboxMeta(req.name, req, toolMode))
    if (op === 'toolboxPath') return Object.assign({ ok: true }, store.toolboxSetPath(req.name, req.path, toolMode))
    if (op === 'toolboxForget') return Object.assign({ ok: true }, store.toolboxForget(req.name, toolMode))
    if (op === 'tools' && toolMode === 'crack') return Object.assign({ ok: true }, store.toolboxList('crack'))
    /* 没选靶标时：提示词回内置默认；只读查询回空结果。不要抛英文 engagement required。 */
    let id = typeof req.engagement === 'string' ? req.engagement.trim() : ''
    if (!id && typeof store.activeEngagementId === 'function') id = store.activeEngagementId() || ''
    if (!id) {
      if (op === 'prompts') {
        return {
          ok: true,
          builtin: true,
          roles: Object.entries(ROLE_TITLES).map(([role, title]) => ({
            role, title,
            planner: role === PLANNER_ROLE,
            dispatcher: role !== PLANNER_ROLE,
            content: DEFAULT_PROMPTS[role] || '',
            updated_at: null,
          })),
        }
      }
      if (op === 'tools') return Object.assign({ ok: true }, store.toolboxList(toolMode))
      if (op === 'toolSet') return Object.assign({ ok: true }, store.toolboxSet(req.name, req, toolMode))
      const writing = /^(add|save|update|delete|import|assess|open)/.test(op)
      if (writing) return { ok: false, error: '请先在顶部选择或创建一个靶标' }
      return { ok: true, items: [], total: 0, stats: null, segments: [], stages: [], roles: [] }
    }

    if (op === 'snapshot') return Object.assign({ ok: true }, store.snapshot(id))
    /* 面板视图模型：聚合只读，面板只调这些，不自己拼 SQL */
    if (op === 'viewOverview') return Object.assign({ ok: true }, buildOverview(store, id, req))
    if (op === 'viewMatrix') return Object.assign({ ok: true }, buildMatrix(store, id))
    if (op === 'viewActivity') return Object.assign({ ok: true }, buildActivity(store, id, req))
    if (op === 'assets') return Object.assign({ ok: true }, store.listAssets(id, req))
    if (op === 'asset') return { ok: true, asset: store.getAsset(id, req.id) }
    if (op === 'graph') return Object.assign({ ok: true }, store.graph(id, req))
    if (op === 'attackGraph') return Object.assign({ ok: true }, store.attackGraph(id, req))
    if (op === 'stats') return { ok: true, stats: store.stats(id) }
    /* 工具清单：使用次数来自攻击步骤/扫描记录，人工标注存 tool_registry */
    if (op === 'tools') return Object.assign({ ok: true }, store.toolList(id))
    if (op === 'toolSet') return Object.assign({ ok: true }, store.toolSet(id, req.name, req, toolMode))
    if (op === 'vulns') return Object.assign({ ok: true, stats: store.vulnStats(id) }, store.listVulns(id, req))
    if (op === 'addVuln') return Object.assign({ ok: true }, store.addVuln(id, req.vuln || req))
    if (op === 'updateVuln') return Object.assign({ ok: true }, store.updateVuln(id, req.id, req.patch || req))
    /* 人工复核：确认 / 误报 / 已修复 / 打回候选，带理由。智能体工具不走这里。 */
    if (op === 'reviewVuln') {
      const result = store.reviewVuln(id, req.id, req)
      /* 业务失败（漏洞不存在/判定非法）也必须是 ok:false，面板只认这个字段。 */
      return result && result.updated === false
        ? Object.assign({ ok: false }, result)
        : Object.assign({ ok: true }, result)
    }
    if (op === 'vulnStats') return { ok: true, stats: store.vulnStats(id) }
    if (op === 'credentials') return { ok: true, items: store.listCredentials(id, req) }
    if (op === 'addCredential') return Object.assign({ ok: true }, store.addCredential(id, req.credential || req))
    if (op === 'access') return { ok: true, items: store.listAccess(id, req) }
    if (op === 'addAccess') return Object.assign({ ok: true }, store.addAccess(id, req.access || req))
    if (op === 'sessions') return Object.assign({ ok: true }, store.sessionSummary(id))
    if (op === 'webshells') return { ok: true, items: store.listWebshells(id, req) }
    if (op === 'addWebshell') return Object.assign({ ok: true }, store.addWebshell(id, req.webshell || req))
    if (op === 'updateWebshell') return Object.assign({ ok: true }, store.updateWebshell(id, req.id, req.patch || req))
    if (op === 'tunnels') return { ok: true, items: store.listTunnels(id, req) }
    if (op === 'shots') return Object.assign({ ok: true }, store.listShots(id, req))
    if (op === 'shotAdd') return Object.assign({ ok: true }, store.addShot(id, req.shot || req))
    if (op === 'shotDelete') return Object.assign({ ok: true }, store.deleteShot(id, req.id !== undefined ? req.id : req.shot_id))
    if (op === 'shotData') return Object.assign({ ok: true }, store.readShot(id, req.id !== undefined ? req.id : req.shot_id))
    if (op === 'addTunnel') return Object.assign({ ok: true }, store.addTunnel(id, req.tunnel || req))
    if (op === 'updateTunnel') return Object.assign({ ok: true }, store.updateTunnel(id, req.id, req.patch || req))
    if (op === 'domains') return { ok: true, items: store.domainIndex(id, req) }
    if (op === 'web') return Object.assign({ ok: true }, store.listWeb(id, req))
    if (op === 'httpEvidence') return { ok: true, items: store.listHttpEvidence(id, req) }
    if (op === 'addHttpEvidence') return Object.assign({ ok: true }, store.addHttpEvidence(id, req.evidence || req))
    if (op === 'chain') return { ok: true, items: store.listChain(id) }
    if (op === 'addChainStep') return Object.assign({ ok: true }, store.addChainStep(id, req.step || req))
    if (op === 'report') return Object.assign({ ok: true }, store.report(id, req))
    if (op === 'reportState') return Object.assign({ ok: true }, store.reportState(id))
    if (op === 'reportGenerate') {
      const result = store.reportGenerate(id, req)
      return result.ok === false ? result : Object.assign({ ok: true }, result)
    }
    if (op === 'reportRead') return Object.assign({ ok: true }, store.reportRead(id))
    if (op === 'reportMark') return Object.assign({ ok: true }, store.reportMark(id, req))
    if (op === 'deliverables') return Object.assign({ ok: true }, store.deliverables(id))
    if (op === 'assetTest') {
      /* 面板把 test 当备注字符串传（资产级 flat 参数）；只有真对象才当作子对象。 */
      const payload = req.test && typeof req.test === 'object' && !Array.isArray(req.test) ? req.test : req
      return Object.assign({ ok: true }, store.updateAssetTest(id, payload))
    }
    if (op === 'assessAsset') return Object.assign({ ok: true }, store.assessAsset(id, req.assess || req))
    if (op === 'activeTests') return Object.assign({ ok: true }, store.activeTests(id, req))
    if (op === 'testStats') return { ok: true, stats: store.testStats(id) }
    /* 控制台页签的未读指针（每个页签的条数 + 最近更新时间）：面板据此点红点 */
    if (op === 'consoleDigest') return Object.assign({ ok: true }, store.consoleDigest(id))
    if (op === 'stages') return { ok: true, items: store.listStages(id) }
    if (op === 'reportTargets') return Object.assign({ ok: true }, store.reportTargets(id, req))
    /* 资产发现时间线：资产测绘页的「发现时间」视图 + 报告附录共用 */
    if (op === 'discoveryTimeline') return Object.assign({ ok: true }, store.discoveryTimeline(id, req))
    if (op === 'attackFiles') return { ok: true, items: store.attackFileTree(id) }
    if (op === 'addAttackFile') return Object.assign({ ok: true }, store.addAttackFile(id, req.file || req))
    if (op === 'readAttackFile') return Object.assign({ ok: true }, store.readAttackFile(id, req.id))
    if (op === 'import') return Object.assign({ ok: true }, store.importBundle(id, req))
    if (op === 'prompts') return { ok: true, roles: store.listPrompts(id) }
    if (op === 'savePrompt') return Object.assign({ ok: true }, store.savePrompt(id, req.role, req.content))
    if (op === 'resetPrompts') return Object.assign({ ok: true }, store.resetPrompts(id, req.role))
    throw new Error(`unknown op: ${op}`)
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) }
  }
}

/**
 * 异步分发：只多一条 `probeSessions`（需要真实发起网络连接），其余转发给同步 dispatch。
 * 智能体的沙箱里连不出去，所以在 host 侧做连通性实测。
 */
export async function dispatchAsync(store, req = {}) {
  if (req.op === 'probeSessions') {
    try {
      const id = (typeof req.engagement === 'string' && req.engagement.trim())
        || (typeof store.activeEngagementId === 'function' ? store.activeEngagementId() : '')
      if (!id) return { ok: true, items: [], note: '还没有靶标' }
      const result = await store.probeSessions(id, req)
      return Object.assign({ ok: true }, result)
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) }
    }
  }
  return dispatch(store, req)
}

/* ------------------------------------------------------------------ 服务 */

/**
 * 从图片字节里读出尺寸（PNG / JPEG / WebP），读不出返回 `{ width: null, height: null }`。
 *
 * 只为了在面板与报告里标"这张图多大"以及防止把 0 字节文件当截图收进来 ——
 * 不值得为它引一个图像库（本包刻意保持零外部依赖）。
 *
 * @param buf - 图片字节。
 */
function pngSize(buf) {
  try {
    if (buf.length > 24 && buf.slice(1, 4).toString('latin1') === 'PNG') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }
    if (buf.length > 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
      let i = 2
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xFF) { i += 1; continue }
        const marker = buf[i + 1]
        const len = buf.readUInt16BE(i + 2)
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
        }
        i += 2 + len
      }
    }
    if (buf.length > 30 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') {
      const fmt = buf.slice(12, 16).toString('latin1')
      if (fmt === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
      if (fmt === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3FFF, height: buf.readUInt16LE(28) & 0x3FFF }
    }
  } catch { /* 尺寸读不出不影响入库 */ }
  return { width: null, height: null }
}

/** 模板按归类计数：面板胶囊与工具 by_category 共用一份分布，口径只有这里一处。 */
function templateCounts(items) {
  const counts = new Map(POC_CATEGORIES.map((c) => [c.code, 0]))
  for (const [path, name, , tags] of items) {
    const code = guessTemplateCategory(path, name, tags)
    counts.set(code, (counts.get(code) || 0) + 1)
  }
  return POC_CATEGORIES.map((c) => ({ code: c.code, name: c.name, n: counts.get(c.code) || 0 }))
}

export class RedteamStore {
  /** @param root 数据根目录（默认 $DSH_HOME/redteam） */
  constructor(root) {
    this.root = root
    this.engagementsDir = join(root, 'engagements')
    this.handles = new Map()
    mkdirSync(this.engagementsDir, { recursive: true })
  }

  /* ---------- 当前靶标 ---------- */
  currentPath() { return join(this.root, 'current') }

  /** 当前生效的靶标 id：显式指针优先，否则最近创建的靶标。 */
  activeEngagementId() {
    try {
      const raw = readFileSync(this.currentPath(), 'utf8').trim()
      if (raw && existsSync(this.dbPathOf(raw))) return raw
    } catch { /* 无指针时回退 */ }
    /* 缺库的残留目录仍列出来供删除，但不能当“当前靶标”，否则每个页面都会打开失败。 */
    const usable = this.listEngagements().find((e) => !e.broken)
    return usable ? usable.id : undefined
  }

  /** 切换当前靶标（界面切换或智能体绑定时调用）。 */
  setActiveEngagement(id) {
    if (!id || !existsSync(this.dbPathOf(id))) return false
    mkdirSync(this.root, { recursive: true })
    writeFileSync(this.currentPath(), String(id), 'utf8')
    return true
  }

  /** 靶标 id 只允许目录名原本允许的字符，挡住 ../ 之类的路径穿越。 */
  safeEngagementId(id) {
    const key = String(id || '').trim()
    if (!key || key === '.' || key === '..') return ''
    if (/[\\/:*?"<>|]/.test(key)) return ''
    return key
  }

  /** 靶标成果计数：删除前给界面看清楚要删的是什么，避免盲删。 */
  engagementCounts(id) {
    const key = this.safeEngagementId(id)
    if (!key) return null
    const dir = this.dirOf(key)
    if (!existsSync(dir)) return null
    /* 目录在、库不在也是“存在的靶标”：例如中断创建或旧版本留下的残骸。
       这种条目必须能删，否则会一直占着下拉里的位置。 */
    let db = null
    if (existsSync(this.dbPathOf(key))) {
      try { db = this.db(key) } catch { db = null }
    }
    const count = (table) => {
      if (!db) return 0
      try { return Number(db.prepare(`select count(*) c from ${table}`).get().c) || 0 } catch { return 0 }
    }
    const counts = {
      assets: count('asset'),
      vulns: count('vuln'),
      credentials: count('credential'),
      access: count('access_session'),
      evidence: count('http_evidence') + count('shot'),
      broken: !db || !existsSync(this.metaPathOf(key)),
    }
    counts.total = counts.assets + counts.vulns + counts.credentials + counts.access
    return counts
  }

  /**
   * 删除靶标：先关掉该靶标的库句柄再删目录（Windows 上句柄不关会删不掉），
   * 指针指向它时一并清掉，下次 activeEngagementId() 自动回退到剩余靶标。
   */
  deleteEngagement(id) {
    const key = this.safeEngagementId(id)
    if (!key) return { ok: false, error: '非法靶标 id：' + String(id || '') }
    const dir = this.dirOf(key)
    /* 判存在看目录，不看 assets.db：缺库的残骸也必须能删。
       但既无元数据也无库的普通目录不算靶标，不能借删除接口清掉。 */
    if (!existsSync(dir)) return { ok: false, error: '靶标不存在：' + key }
    if (!existsSync(this.metaPathOf(key)) && !existsSync(this.dbPathOf(key))) {
      return { ok: false, error: '不是靶标目录：' + key }
    }
    const handle = this.handles.get(key)
    if (handle) {
      try { handle.close() } catch { /* 关不掉也继续删，删目录才是目的 */ }
      this.handles.delete(key)
    }
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      return { ok: false, error: '删除失败：' + String(error && error.message ? error.message : error), engagement: key }
    }
    try {
      if (readFileSync(this.currentPath(), 'utf8').trim() === key) rmSync(this.currentPath(), { force: true })
    } catch { /* 没有指针就不用清 */ }
    return { ok: true, deleted: key, remaining: this.listEngagements().map((e) => e.id) }
  }

  /** 批量删除：逐个删，返回成功/失败明细；调用方先做成果统计与 force 判断。 */
  deleteEngagements(ids = []) {
    const seen = new Set()
    const deleted = []
    const failed = []
    for (const raw of Array.isArray(ids) ? ids : []) {
      const id = String(raw || '').trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      const result = this.deleteEngagement(id)
      if (result.ok) deleted.push(id)
      else failed.push({ id, error: result.error })
    }
    return {
      ok: failed.length === 0 && deleted.length > 0,
      deleted,
      failed,
      remaining: this.listEngagements().map((e) => e.id),
    }
  }

  /* ---------- 路径 ---------- */
  dirOf(id) {
    /* 一处收口：所有拼路径的地方都经过这里，非法 id 直接拒绝，
       不再依赖调用方先做 safeEngagementId。 */
    const key = this.safeEngagementId(id)
    if (!key) throw new Error('非法靶标 id：' + String(id || ''))
    return join(this.engagementsDir, key)
  }
  metaPathOf(id) { return join(this.dirOf(id), 'engagement.yaml') }
  dbPathOf(id) { return join(this.dirOf(id), 'assets.db') }
  promptsDirOf(id) { return join(this.dirOf(id), 'agents') }

  /* ---------- 数据库句柄（按靶标缓存，dispose 时统一关闭） ---------- */
  /**
   * 打开（或按需创建）某个靶标的数据库句柄。
   * @param id - 靶标 id。
   * @param options - `{ create: true }` 时允许新建库文件（openEngagement 用）。
   */
  db(id, options = {}) {
    let handle = this.handles.get(id)
    if (handle) return handle
    if (!existsSync(this.dbPathOf(id))) {
      if (options.create !== true) throw new Error(`engagement not found: ${id}`)
      mkdirSync(this.dirOf(id), { recursive: true })
    }
    handle = new DatabaseSync(this.dbPathOf(id))
    /* FTS5 缺席的 Node 构建（如 22.14）上不能带上 fts5 建表语句：
       一句 `USING fts5` 抛错会把整份 DDL 一起带崩，连普通表都建不出来。
       降级后 asset 检索走 LIKE（见 listAssets 的 f.q 分支）。 */
    handle.exec(HAS_FTS5 ? DDL + ASSET_FTS_DDL : DDL)
    migrate(handle)
    this.handles.set(id, handle)
    return handle
  }

  close() {
    for (const handle of this.handles.values()) {
      try { handle.close() } catch { /* 关闭失败不阻断卸载 */ }
    }
    this.handles.clear()
    if (this.kbHandle) {
      try { this.kbHandle.close() } catch { /* 忽略 */ }
      this.kbHandle = null
    }
  }

  /* ---------- 靶标生命周期 ---------- */
  listEngagements() {
    mkdirSync(this.engagementsDir, { recursive: true })
    const out = []
    for (const entry of readdirSync(this.engagementsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const metaPath = this.metaPathOf(entry.name)
      const dbPath = this.dbPathOf(entry.name)
      const hasMeta = existsSync(metaPath)
      const hasDb = existsSync(dbPath)
      /* 既没有元数据也没有库的目录不是靶标（可能是早先版本/中断操作留下的空目录），
         不能列进下拉占位置。 */
      if (!hasMeta && !hasDb) continue
      const meta = readMeta(metaPath) || {}
      let stats = null
      try {
        if (hasDb) stats = this.stats(entry.name)
      } catch { /* 库损坏时仍列出靶标 */ }
      out.push({
        id: entry.name, name: meta.target_name || entry.name,
        scope: meta.scope_cidrs || [], status: meta.status || 'active',
        created_at: meta.created_at || null, stats,
        broken: !hasDb || !hasMeta,
        missing: [!hasMeta ? 'engagement.yaml' : '', !hasDb ? 'assets.db' : ''].filter(Boolean),
      })
    }
    return out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  }

  /**
   * 打开/创建一个靶标工作区。
   * @param name - 靶标单位名称（slugify 后作为目录名与靶标 id）。
   * @param scope - 范围列表（可空）。
   * @param options - `{ bindCurrent?: boolean }`：是否同时把全局「当前靶标」指针指过来。
   *   默认 true（界面/命令行语义）；**智能体工具传 false** —— 多会话并行时，
   *   让某个会话 open 一个靶标就改掉全局指针，是"报告被写串"的直接原因。
   */
  openEngagement(name, scope, options = {}) {
    const targetName = String(name || '').trim()
    const id = slugify(targetName)
    /* 范围先校验再落盘：错一项就整条拒绝，避免「范围是错的、后面全白干」。
       空范围沿用已有值（重复 open 同一个靶标时不会把范围清空）。 */
    const parsed = dfScopeNormalize(scope)
    if (parsed.errors.length) {
      const first = parsed.errors[0]
      throw new Error('范围格式不对：' + (first.raw ? first.raw + ' → ' : '') + first.message)
    }
    const existing = readMeta(this.metaPathOf(id))
    /* "A B" / "a-b" / "A/B" 会 slugify 成同一个 id；名字不同时不能悄悄覆盖，
       否则两个单位的资产/漏洞会混进同一个库。 */
    if (existing && String(existing.target_name || '').trim() !== targetName) {
      const error = new Error(
        '靶标名冲突：' + targetName + ' 与已有靶标「' + (existing.target_name || id)
        + '」会落到同一个 id（' + id + '）。换一个名称，或先删除/改名已有靶标。',
      )
      error.code = 'engagement_name_conflict'
      error.existing = { id, name: existing.target_name || id }
      throw error
    }
    mkdirSync(this.dirOf(id), { recursive: true })
    for (const sub of ['agents', 'runs', 'reports']) mkdirSync(join(this.dirOf(id), sub), { recursive: true })
    const scopeCidrs = parsed.entries.length
      ? parsed.entries
      : ((existing && existing.scope_cidrs) || [])
    writeMeta(this.metaPathOf(id), {
      target_name: targetName,
      scope_cidrs: scopeCidrs,
      status: 'active',
      created_at: (existing && existing.created_at) || nowIso(),
      updated_at: nowIso(),
    })
    this.db(id, { create: true }) // 建库 + 建表
    for (const p of this.listPrompts(id)) {
      if (!p.content) this.savePrompt(id, p.role, DEFAULT_PROMPTS[p.role] || '')
    }
    if (options.bindCurrent !== false) this.setActiveEngagement(id)
    return { id, name, scope: scopeCidrs }
  }

  /**
   * 资产发现时间线：按"哪一天发现了多少、最近发现了哪些"聚合。
   * 资产测绘页用它回答"这条是什么时候发现的"，报告附录用它做收口时间线。
   * @param id - 靶标 id。
   * @param f - `{ limit?: number }` 最近资产条数（默认 50）。
   */
  discoveryTimeline(id, f = {}) {
    const db = this.db(id)
    const limit = Math.min(Number(f.limit) || 50, 500)
    const days = db.prepare(`SELECT substr(COALESCE(discovered_at, first_seen, ''), 1, 10) AS day,
        COUNT(*) AS assets,
        SUM(CASE WHEN COALESCE(scope, (${SCOPE_SQL})) = 'internal' THEN 1 ELSE 0 END) AS internal,
        SUM(CASE WHEN COALESCE(scope, (${SCOPE_SQL})) = 'external' THEN 1 ELSE 0 END) AS external
      FROM asset GROUP BY day ORDER BY day DESC`).all()
    const recent = db.prepare(`SELECT id, ip, segment_cidr, state, primary_name, discovered_at, first_seen, last_seen,
        COALESCE(scope, (${SCOPE_SQL})) AS scope, priority,
        (SELECT COUNT(*) FROM port p WHERE p.asset_id = asset.id AND p.state = 'open') AS open_ports
      FROM asset ORDER BY COALESCE(discovered_at, first_seen, '') DESC, id DESC LIMIT ?`).all(limit)
    const span = db.prepare(`SELECT MIN(COALESCE(discovered_at, first_seen)) AS first,
        MAX(COALESCE(discovered_at, first_seen)) AS last, COUNT(*) AS total FROM asset`).get() || {}
    return {
      days: days.map((d) => Object.assign({}, d, { day: d.day || '(未知时间)' })),
      recent,
      span: { first: span.first || null, last: span.last || null, total: span.total || 0 },
    }
  }

  /* ---------- 工具登记：使用次数从既有记录聚合，人工只标注 ---------- */

  /** 登记一次工具使用（不覆盖人工标注）。 */
  toolObserve(id, name, kind = 'executable', by = null) {
    const n = canonicalToolName(name)
    if (!n) return null
    const db = this.db(id)
    const at = nowIso()
    db.prepare(`INSERT INTO tool_registry(name, kind, uses, first_seen, last_seen, updated_by, updated_at)
      VALUES(?,?,1,?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET
        uses = tool_registry.uses + 1,
        last_seen = excluded.last_seen,
        kind = COALESCE(NULLIF(tool_registry.kind, ''), excluded.kind)`).run(n, kind, at, at, by, at)
    return { name: n, kind }
  }

  /**
   * 工具清单：`uses` 从 attack_step.tool 与 scan_run.tool 实时聚合，
   * 不依赖任何写死的名单；`status/note` 是人工标注。
   */
  toolList(id) {
    const db = this.db(id)
    const usage = db.prepare(`SELECT name, SUM(n) AS uses, MAX(ts) AS last_seen FROM (
        SELECT tool AS name, COUNT(*) AS n, MAX(recorded_at) AS ts
          FROM attack_step WHERE COALESCE(tool, '') <> '' GROUP BY tool
        UNION ALL
        SELECT tool AS name, COUNT(*) AS n, MAX(started_at) AS ts
          FROM scan_run WHERE COALESCE(tool, '') <> '' GROUP BY tool
      ) GROUP BY name ORDER BY uses DESC, name`).all()
    const meta = db.prepare(`SELECT name, kind, status, note, uses, first_seen, last_seen, updated_by, updated_at
      FROM tool_registry ORDER BY updated_at DESC`).all()
    const map = new Map()
    const touch = (name) => {
      const key = canonicalToolName(name)
      if (!key) return null
      let row = map.get(key)
      if (!row) {
        row = { name: key, kind: 'executable', uses: 0, last_seen: null, first_seen: null, status: '', note: '', updated_by: null, source: 'observed', registered: false }
        map.set(key, row)
      }
      return row
    }
    for (const u of usage) {
      const row = touch(u.name)
      if (!row) continue
      row.uses += Number(u.uses) || 0
      if (u.last_seen && (!row.last_seen || u.last_seen > row.last_seen)) row.last_seen = u.last_seen
    }
    for (const m of meta) {
      const row = touch(m.name)
      if (!row) continue
      row.kind = m.kind || row.kind
      if (m.last_seen && (!row.last_seen || m.last_seen > row.last_seen)) row.last_seen = m.last_seen
      if (!row.first_seen) row.first_seen = m.first_seen || null
      /* ORDER BY updated_at DESC → 同一规范名只取最新的一条标注 */
      if (!row.annotated) {
        row.status = m.status || ''
        row.note = m.note || ''
        row.updated_by = m.updated_by || null
        row.annotated = true
      }
    }
    /* 面板和 toolbox 共用 registry：用户/模型发现的工具都要出现在工具页。 */
    let toolboxRoots = []
    let toolboxDiscovered = []
    let toolboxTruncated = false
    try {
      const home = dirname(this.root)
      let registry = loadRegistry(home, 'redteam')
      /* 第一次打开工具页：没有 registry 就先扫一遍，避免空白页要用户多点一次。
         只在真实 DSH_HOME 下自动扫，临时 store 不触发（保持测试隔离）。 */
      if (!registry.last_sync && home.toLowerCase() === toolboxHome().toLowerCase()) {
        registry = syncRegistry(home, 'redteam')
      }
      toolboxRoots = Array.isArray(registry.roots) ? registry.roots : []
      toolboxTruncated = registry.last_sync_truncated === true
      try { toolboxDiscovered = toolboxRootsOf(home, 'redteam', registry) } catch { toolboxDiscovered = [] }
      for (const tool of Object.values(registry.tools || {})) {
        const row = touch(tool.name)
        if (!row) continue
        row.path = tool.path || row.path || ''
        row.toolbox_source = tool.source || ''
        row.missing = tool.missing === true
        row.registered = row.registered === true || tool.registered === true
        row.recipe = tool.recipe || row.recipe || null
        row.purpose = tool.purpose || row.purpose || ''
        row.tags = Array.isArray(tool.tags) ? tool.tags : (row.tags || [])
        row.risk = tool.risk || row.risk || ''
        row.uses = Math.max(Number(row.uses) || 0, Number(tool.uses) || 0)
        if (tool.last_seen && (!row.last_seen || tool.last_seen > row.last_seen)) row.last_seen = tool.last_seen
        if (!row.first_seen) row.first_seen = tool.first_seen || null
        if (!row.annotated_global && (tool.status || tool.note)) {
          row.status = tool.status || row.status || ''
          row.note = tool.note || row.note || ''
          row.annotated_global = true
        }
      }
    } catch { /* registry 读不到不影响原有工具页 */ }
    const items = [...map.values()]
      .map((row) => {
        delete row.annotated
        delete row.annotated_global
        if (row.path || row.recipe) row.source = 'toolbox'
        else row.source = row.uses > 0 ? 'observed' : 'registered'
        return row
      })
      .sort((a, b) => (b.uses - a.uses) || String(a.name).localeCompare(String(b.name)))
    return {
      items,
      total: items.length,
      toolbox_roots: toolboxRoots,
      toolbox_discovered_roots: toolboxDiscovered,
      toolbox_truncated: toolboxTruncated,
    }
  }

  /** 全局工具页数据：只读指定模式的 registry，不碰任何 engagement 库。 */
  toolboxList(mode = 'redteam') {
    const home = dirname(this.root)
    let registry = loadRegistry(home, mode)
    if (!registry.last_sync && home.toLowerCase() === toolboxHome().toLowerCase()) {
      registry = syncRegistry(home, mode)
    }
    const items = Object.values(registry.tools || {}).map((tool) => {
      const uses = Number(tool.uses) || 0
      return {
        name: tool.name,
        kind: 'executable',
        uses,
        last_seen: tool.last_seen || null,
        first_seen: tool.first_seen || null,
        status: tool.status || '',
        note: tool.note || '',
        path: tool.path || '',
        toolbox_source: tool.source || '',
        missing: tool.missing === true,
        registered: tool.registered === true,
        recipe: tool.recipe || null,
        purpose: tool.purpose || '',
        tags: Array.isArray(tool.tags) ? tool.tags : [],
        risk: tool.risk || '',
        source: tool.path || tool.recipe ? 'toolbox' : (uses > 0 ? 'observed' : 'registered'),
      }
    }).sort((a, b) => (b.uses - a.uses) || String(a.name).localeCompare(String(b.name)))
    let discovered = []
    try { discovered = toolboxRootsOf(home, mode, registry) } catch { discovered = [] }
    return {
      items,
      total: items.length,
      /* 已移除的条目仍要给面板一个恢复入口；路径由用户重新指定。 */
      hidden: (Array.isArray(registry.hidden) ? registry.hidden : []).map((name) => ({
        key: name, id: name, name, label: name, hidden: true, source: 'hidden', path: '', exists: false,
      })),
      toolbox_roots: Array.isArray(registry.roots) ? registry.roots : [],
      toolbox_discovered_roots: discovered,
      toolbox_truncated: registry.last_sync_truncated === true,
    }
  }

  /** 面板同步工具箱：只扫白名单 roots，不扫 PATH。 */
  toolboxSync(mode = 'redteam') {
    return syncRegistry(dirname(this.root), mode)
  }

  /** 面板添加工具根目录（会重新同步）。 */
  toolboxAddRoot(dir, mode = 'redteam') {
    return addToolboxRoot(dirname(this.root), mode, dir)
  }

  /**
   * 面板移除工具发现根：
   *   · 用户添加的根 → 从 registry 删除；
   *   · 平台配置里的“手动指定”根 → 清 toolkitDir / binDirs / tools 中对应项；
   *   · 插件默认根不可移除。
   */
  toolboxRemoveRoot(dir, mode = 'redteam') {
    const home = dirname(this.root)
    const target = String(dir || '').trim().toLowerCase()
    const found = toolboxRootsOf(home, mode).find((r) => String(r.path || '').toLowerCase() === target)
    if (!found) return { ok: false, error: '目录不在发现列表里：' + String(dir || '') }
    if (found.source === 'default') return { ok: false, error: '插件默认目录不可移除' }
    /* 同一条路径可能同时来自 registry 和平台配置；两边都清，避免移除后又从另一边冒出来。 */
    let config = null
    if (mode === 'redteam') {
      config = removePlatformToolRoot(this.root, dir)
      if (config.ok !== true && found.source === 'config') {
        return { ok: false, error: config.error || '移除配置目录失败' }
      }
    }
    const result = removeToolboxRoot(home, mode, dir)
    return { ...result, config: config && config.ok ? config : null }
  }

  /** 同步工具箱工具的人工状态。 */
  toolboxSet(name, patch = {}, mode = 'redteam') {
    return setToolboxStatus(dirname(this.root), mode, name, patch.status, patch.note)
  }

  /** 面板编辑工具卡片（用途 / tags / recipe / risk）。 */
  toolboxMeta(name, patch = {}, mode = 'redteam') {
    return setToolboxMeta(dirname(this.root), mode, name, patch)
  }

  /** 面板改单条工具路径：写进配置的 tools，并把这一条从「已消失」里恢复。 */
  toolboxSetPath(name, file, mode = 'redteam') {
    const key = String(name || '').trim().toLowerCase()
    if (!key) throw new Error('工具名为空')
    const text = String(file || '').trim()
    if (!text) throw new Error('路径不能为空')
    const abs = isAbsolute(text) ? text : resolve(text)
    let isFile = false
    try { isFile = statSync(abs).isFile() } catch { isFile = false }
    if (!isFile) throw new Error('文件不存在：' + abs)
    setRegistryToolPath(dirname(this.root), mode, key, abs)
    if (mode === 'redteam') {
      const cfg = loadPlatformConfig(this.root)
      const hidden = (cfg.hiddenTools || []).filter((x) => String(x).toLowerCase() !== key)
      savePlatformConfig({ tools: { [key]: abs }, hiddenTools: hidden }, this.root)
    }
    return { name: key, path: abs }
  }

  /** 面板「移除这条」：删登记条目与配置里的死路径，并记进 hiddenTools，扫描与内置清单都不再列它。 */
  toolboxForget(name, mode = 'redteam') {
    const key = String(name || '').trim().toLowerCase()
    if (!key) throw new Error('工具名为空')
    const removed = forgetRegistryTool(dirname(this.root), mode, key)
    if (mode === 'redteam') {
      const cfg = loadPlatformConfig(this.root)
      const hidden = (cfg.hiddenTools || []).slice()
      if (!hidden.some((x) => String(x).toLowerCase() === key)) hidden.push(key)
      /* 空字符串会被 savePlatformConfig 当成「删掉这一项」。 */
      savePlatformConfig({ tools: { [key]: '' }, hiddenTools: hidden }, this.root)
    }
    return { name: key, removed }
  }

  /** 人工标注工具：可用 / 不建议 / 建议停用 / 清除。只影响模型选型参考，不拦截 shell。 */
  toolSet(id, name, patch = {}, mode = 'redteam') {
    const n = canonicalToolName(name)
    if (!n) throw new Error('tool name required')
    const db = this.db(id)
    const status = ['', 'available', 'deprecated', 'blocked'].includes(patch.status) ? patch.status : undefined
    const note = patch.note === undefined ? undefined : (patch.note === null ? null : String(patch.note).trim())
    const by = String(patch.by || 'human').trim() || 'human'
    const at = nowIso()
    db.prepare(`INSERT INTO tool_registry(name, kind, status, note, uses, first_seen, last_seen, updated_by, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET
        status = COALESCE(?, tool_registry.status),
        note = COALESCE(?, tool_registry.note),
        updated_by = ?,
        updated_at = ?`).run(
      n, patch.kind || 'executable', status || '', note ?? null, 0, at, null, by, at,
      status === undefined ? null : status, note === undefined ? null : note, by, at,
    )
    /* 全局 registry 是 toolbox 的唯一状态源；面板标注必须同步过去。 */
    try { this.toolboxSet(n, { status: patch.status, note: patch.note }, mode) } catch { /* DB 已保存，registry 失败不阻塞面板 */ }
    return this.toolList(id).items.find((r) => r.name === n) || { name: n }
  }

  /* ---------- 统计 / 查询 ---------- */
  stats(id) {
    const db = this.db(id)
    const one = (sql) => Object.values(db.prepare(sql).get() || {})[0] ?? 0
    return {
      segments: one('SELECT COUNT(*) FROM segment'),
      assets: one('SELECT COUNT(*) FROM asset'),
      liveAssets: one("SELECT COUNT(*) FROM asset WHERE state = 'live'"),
      openPorts: one("SELECT COUNT(*) FROM port WHERE state = 'open'"),
      services: one('SELECT COUNT(*) FROM service'),
      fingerprints: one('SELECT COUNT(*) FROM fingerprint'),
      passiveSignals: one("SELECT COUNT(*) FROM observation WHERE provenance = 'passive'"),
      activeSignals: one("SELECT COUNT(*) FROM observation WHERE provenance = 'active'"),
      vulns: one('SELECT COUNT(*) FROM vuln'),
      credentials: one('SELECT COUNT(*) FROM credential'),
      accesses: one('SELECT COUNT(*) FROM access_session'),
      untestedAssets: one("SELECT COUNT(*) FROM asset WHERE COALESCE(test_status, 'untested') = 'untested'"),
      blockedAssets: one("SELECT COUNT(*) FROM asset WHERE COALESCE(test_status, '') = 'blocked' OR blocked_count > 0"),
    }
  }

  /**
   * 与概览矩阵同一口径的“未测资产”：八类测试都没有记录，且状态不是 blocked/abandoned/no_surface。
   * 报告门、closeout、brief 都走这里，避免面板显示已测、报告却提示未测。
   */
  untestedAssetIds(id) {
    /* 只看覆盖账本：asset_test 的 status 不能让零覆盖的资产“消失”。
       no_surface / abandoned / blocked 是明确的资产级结论，不再要求补满八类。 */
    return buildMatrix(this, id).rows
      .filter((row) => row.required && row.done === 0)
      .map((row) => row.assetId)
  }

  /** 覆盖矩阵汇总：给 brief / closeout 看“总共多少格、测了多少、还剩多少”。 */
  matrixSummary(id) {
    const matrix = buildMatrix(this, id)
    const required = matrix.rows.filter((row) => row.required)
    const cells = required.reduce((n, row) => n + row.total, 0)
    const done = required.reduce((n, row) => n + row.done, 0)
    /* 零覆盖资产由 untested 缺口单独报；这里只报“已经开始、但没做完”的格子，避免重复计数。 */
    const partial = required.filter((row) => row.done > 0 && row.done < row.total)
    return {
      assets: matrix.summary.assets,
      required_assets: matrix.summary.required_assets,
      tested_assets: matrix.summary.tested,
      exempt_assets: matrix.summary.exempt,
      cells,
      tested_cells: done,
      gaps: cells - done,
      partial_gaps: partial.reduce((n, row) => n + (row.total - row.done), 0),
      partial_assets: partial.length,
      classes: matrix.classes.map((c) => c.code),
    }
  }

  /**
   * 矩阵缺口明细：不只给四个数字，直接说“哪个资产缺哪几类”。
   * 这是模型能照做的最小单位；没有它，模型只能盲补或直接 force。
   */
  matrixGaps(id, options = {}) {
    const matrix = buildMatrix(this, id)
    const cap = Math.max(1, Math.min(Number(options.limit) || 20, 100))
    const labels = Object.fromEntries(matrix.classes.map((c) => [c.code, c.label]))
    const required = matrix.rows.filter((row) => row.required && row.missing.length > 0)
    const exempt = matrix.rows.filter((row) => !row.required)
    const item = (row) => ({
      asset_id: row.assetId,
      ip: row.ip,
      priority: row.priority || undefined,
      test_status: row.testStatus,
      done: row.done,
      total: row.total,
      missing: row.missing,
      missing_labels: row.missing.map((c) => labels[c] || c),
    })
    return {
      summary: matrix.summary,
      assets_with_gaps: required.length,
      items: required.slice(0, cap).map(item),
      exempt: exempt.slice(0, cap).map(item),
      total_missing_cells: required.reduce((n, row) => n + row.missing.length, 0),
      hint: required.length
        ? '补测后按格 coverage set；确认某类不适用时用 coverage op=skip_rest（asset_ids + note）一次标完，不要逐格留空。'
        : '没有待补的矩阵缺口。',
    }
  }

  /* ---------- 覆盖账本：面 × 测试类 × 结论 ---------- */
  coverageSet(id, req = {}) {
    const db = this.db(id)
    const surface = String(req.surface || '').trim()
    const testClass = String(req.test_class || req.testClass || '').trim()
    if (!surface) throw new Error('surface 必填')
    if (!testClass) throw new Error('test_class 必填')
    const requested = ['untested', 'tested', 'clean', 'skipped'].includes(req.status) ? req.status : null
    const existing = db.prepare('SELECT status, note FROM coverage WHERE surface = ? AND test_class = ?')
      .get(surface, testClass)
    /* 不传 status 时：已有记录保持原结论；新记录默认 untested，不能默认“测过了”。 */
    const status = requested || existing?.status || 'untested'
    const note = String(req.note ?? '').trim()
    if (status === 'skipped' && note === '' && String(existing?.note || '').trim() === '') {
      throw new Error('skipped 必须写原因：不适用 / 风险过高 / 无权限 / 需外部条件，空格不能当跳过')
    }
    db.prepare(`INSERT INTO coverage (surface, asset_id, test_class, status, note, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(surface, test_class) DO UPDATE SET
        status = excluded.status,
        note = COALESCE(NULLIF(excluded.note, ''), coverage.note),
        asset_id = COALESCE(excluded.asset_id, coverage.asset_id),
        updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(surface, req.asset_id ?? null, testClass, status, note || null, req.by ?? null, nowIso())
    return this.coverageList(id, { surface })
  }

  coverageList(id, filter = {}) {
    const db = this.db(id)
    const clauses = []
    const params = []
    if (filter.surface) { clauses.push('surface = ?'); params.push(String(filter.surface)) }
    if (filter.test_class) { clauses.push('test_class = ?'); params.push(String(filter.test_class)) }
    const items = db.prepare(`SELECT * FROM coverage${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''} ORDER BY surface, test_class`).all(...params)
    const byClass = {}
    const byStatus = {}
    for (const row of items) {
      byClass[row.test_class] = (byClass[row.test_class] || 0) + 1
      byStatus[row.status] = (byStatus[row.status] || 0) + 1
    }
    return { total: items.length, by_class: byClass, by_status: byStatus, items }
  }

  coverageGaps(id) {
    const db = this.db(id)
    const row = db.prepare(`SELECT COUNT(*) AS n FROM asset a
      WHERE (EXISTS (SELECT 1 FROM vuln v WHERE v.asset_id = a.id)
          OR EXISTS (SELECT 1 FROM attack_step s WHERE s.asset_id = a.id))
        AND NOT EXISTS (SELECT 1 FROM coverage c WHERE c.asset_id = a.id)`).get()
    const items = db.prepare(`SELECT a.id, a.ip, a.primary_name FROM asset a
      WHERE (EXISTS (SELECT 1 FROM vuln v WHERE v.asset_id = a.id)
          OR EXISTS (SELECT 1 FROM attack_step s WHERE s.asset_id = a.id))
        AND NOT EXISTS (SELECT 1 FROM coverage c WHERE c.asset_id = a.id)
      ORDER BY a.id LIMIT 20`).all()
    return { missing: Number(row && row.n) || 0, items }
  }

  /**
   * 批量把“不适用 / 本轮不测”的类标成 skipped。
   *
   * 覆盖矩阵是资产 × 八类，真实规模下不可能逐格写；没有这个动作，收口门就只剩 force。
   * 只填空白（untested / 没有记录），已 tested / clean 的格子不动；note 必填，原因会逐行落库。
   */
  coverageSkipRest(id, req = {}) {
    const db = this.db(id)
    const note = String(req.note || '').trim()
    if (!note) throw new Error('skip_rest 必须写原因：不适用 / 风险过高 / 无权限 / 需外部条件')
    const wanted = Array.isArray(req.test_classes) && req.test_classes.length
      ? req.test_classes.map((c) => String(c || '').trim()).filter((c) => TEST_CLASSES.includes(c))
      : TEST_CLASSES.slice()
    if (!wanted.length) throw new Error('test_classes 没有有效值')
    const hasIds = Array.isArray(req.asset_ids) && req.asset_ids.length > 0
    if (!hasIds && req.all !== true) throw new Error('skip_rest 要指定 asset_ids，或显式传 all:true')

    let assets = db.prepare('SELECT id, ip, primary_name, test_status FROM asset ORDER BY id').all()
    if (hasIds) {
      const ids = new Set(req.asset_ids.map((x) => Number(x)).filter((x) => Number.isFinite(x)))
      assets = assets.filter((a) => ids.has(Number(a.id)))
    }
    /* 已经明确“无面 / 放弃 / 受阻”的资产不需要再补矩阵；避免把边界结论洗成 skipped。 */
    assets = assets.filter((a) => !['no_surface', 'abandoned', 'blocked'].includes(String(a.test_status || 'untested')))

    const stamp = nowIso()
    const by = req.by ?? null
    let inserted = 0
    let updated = 0
    let kept = 0
    for (const a of assets) {
      const names = db.prepare('SELECT name FROM asset_name WHERE asset_id = ?').all(a.id)
        .map((n) => String(n.name || '').trim().toLowerCase()).filter(Boolean)
      const surfaces = Array.from(new Set([a.primary_name, a.ip, ...names]
        .map((s) => String(s || '').trim().toLowerCase()).filter(Boolean)))
      const rows = surfaces.length
        ? db.prepare(`SELECT id, surface, test_class, status FROM coverage
            WHERE asset_id = ? OR LOWER(TRIM(surface)) IN (${surfaces.map(() => '?').join(',')})`)
          .all(Number(a.id), ...surfaces)
        : db.prepare('SELECT id, surface, test_class, status FROM coverage WHERE asset_id = ?').all(Number(a.id))
      const byClass = new Map()
      let surface = String(a.primary_name || a.ip || '').trim()
      for (const row of rows) {
        if (!surface && row.surface) surface = String(row.surface)
        if (!byClass.has(row.test_class)) byClass.set(row.test_class, row)
      }
      for (const cls of wanted) {
        const hit = byClass.get(cls)
        if (hit) {
          if (hit.status === 'untested' || hit.status === 'skipped') {
            db.prepare('UPDATE coverage SET status = ?, note = ?, updated_by = ?, updated_at = ? WHERE id = ?')
              .run('skipped', note, by, stamp, hit.id)
            updated += 1
          } else {
            kept += 1
          }
          continue
        }
        db.prepare(`INSERT INTO coverage (surface, asset_id, test_class, status, note, updated_by, updated_at)
          VALUES (?, ?, ?, 'skipped', ?, ?, ?)`).run(surface || String(a.ip || a.id), a.id, cls, note, by, stamp)
        inserted += 1
      }
    }
    return {
      ok: true, assets: assets.length, classes: wanted,
      inserted, updated, kept, note,
      hint: '只填空格，不动 tested/clean；原因已写在每个 skipped 格。',
    }
  }

  /* ---------- 攻击假设（测试方向） ---------- */

  /**
   * 开一条假设：一条待验证的测试方向。
   * 必填三样——测什么（surface）、为什么值得测（why）、什么结果算证伪（falsify）；
   * 缺了证伪判据就只剩"试过"，事后无法区分"打不动"和"没打"。
   */
  addHypothesis(id, h = {}) {
    const db = this.db(id)
    const surface = String(h.surface || h.target || '').trim()
    const why = String(h.why || '').trim()
    const falsify = String(h.falsify || '').trim()
    if (!surface) throw new Error('假设要写对象：surface（页面 / 接口 / 参数）')
    if (!why) throw new Error('假设要写为什么值得测（指纹、业务、返回差异）')
    if (!falsify) throw new Error('假设要写什么结果算证伪，否则事后分不清"打不动"和"没打"')
    const result = db.prepare(`INSERT INTO hypothesis(asset_id, surface, why, vuln_class, cause, conditions, test_plan, falsify, status, opened_by, opened_at, agent)
      VALUES(?,?,?,?,?,?,?,?,'open',?,?,?)`).run(
      h.asset_id ?? null, surface, why,
      h.vuln_class ?? null, h.cause ?? null, h.conditions ?? null, h.test_plan ?? null, falsify,
      h.opened_by ?? h.agent ?? null, nowIso(), h.agent ?? null,
    )
    const hid = Number(result.lastInsertRowid)
    if (h.asset_id !== undefined && h.asset_id !== null) {
      try { this.#observe(db, 'asset', Number(h.asset_id), 'hypothesis', surface, 'active', h.opened_by ?? h.agent ?? null, null) } catch { /* 活动流失败不影响假设 */ }
    }
    return { ok: true, id: hid, status: 'open' }
  }

  /**
   * 关一条假设。结局只有三种：
   *   confirmed —— 成立，挂 vuln_id（或给 evidence）
   *   refuted   —— 不成立，必须写依据（回显 / 版本 / 权限位 / 差分结果）
   *   blocked   —— 打不了，必须写外部原因（WAF / 无凭据 / 目标下线）
   */
  closeHypothesis(id, hid, patch = {}) {
    const db = this.db(id)
    const cur = db.prepare('SELECT * FROM hypothesis WHERE id = ?').get(Number(hid))
    if (cur === undefined) throw new Error('假设不存在：' + hid)
    const status = String(patch.status || '').trim()
    if (!['confirmed', 'refuted', 'blocked'].includes(status)) throw new Error('结局只能是 confirmed / refuted / blocked')
    const basis = String(patch.basis || patch.note || '').trim()
    if (status === 'refuted' && !basis) throw new Error('refuted 必须写依据：回显、版本、权限位或差分结果')
    if (status === 'blocked' && !basis) throw new Error('blocked 必须写外部原因：WAF、无凭据或目标下线')
    const vulnId = patch.vuln_id === undefined || patch.vuln_id === null ? null : Number(patch.vuln_id)
    const evidence = String(patch.evidence || '').trim()
    if (status === 'confirmed' && vulnId === null && evidence === '') throw new Error('confirmed 要挂 vuln_id（先 vuln_add）或写 evidence')
    if (status === 'confirmed' && vulnId !== null) {
      const vuln = db.prepare('SELECT id, status, asset_id, target FROM vuln WHERE id = ?').get(vulnId)
      if (vuln === undefined) throw new Error('confirmed 要挂的漏洞不存在：' + vulnId)
      if (vuln.status === 'false-positive' || vuln.status === 'fixed') {
        throw new Error('不能把假设 confirmed 挂到 ' + vuln.status + ' 的漏洞上')
      }
      if (cur.asset_id !== null && cur.asset_id !== undefined
        && vuln.asset_id !== null && vuln.asset_id !== undefined
        && Number(cur.asset_id) !== Number(vuln.asset_id)) {
        throw new Error('假设与漏洞不在同一资产：hypothesis asset_id=' + cur.asset_id + '，vuln asset_id=' + vuln.asset_id)
      }
      /* surface 可能是「GET /api/x」这种没有 host 的写法；只有像 host/URL 时才比对 host。 */
      const surfaceText = String(cur.surface || '').trim()
      const looksLikeHost = !/\s/.test(surfaceText)
        && (/^[a-z][a-z0-9+.-]*:\/\//i.test(surfaceText) || /^[a-z0-9.[\]:-]+(\/|$)/i.test(surfaceText))
      const hypothesisHost = looksLikeHost
        ? String(hostOfTarget(surfaceText) || '').toLowerCase()
        : ''
      const vulnHost = String(hostOfTarget(vuln.target) || '').toLowerCase()
      if (hypothesisHost && vulnHost && hypothesisHost !== vulnHost) {
        throw new Error('假设与漏洞不同源：' + hypothesisHost + ' ≠ ' + vulnHost)
      }
    }
    db.prepare(`UPDATE hypothesis SET status = ?, basis = ?, evidence = COALESCE(?, evidence), vuln_id = COALESCE(?, vuln_id), closed_by = ?, closed_at = ? WHERE id = ?`)
      .run(status, basis || null, evidence || null, vulnId, patch.closed_by ?? null, nowIso(), Number(hid))
    /* refuted / blocked 也是成果：转成 negative lesson，brief 里下一轮直接带出来。 */
    if (status === 'refuted' || status === 'blocked') {
      try {
        const row = db.prepare('SELECT * FROM hypothesis WHERE id = ?').get(Number(hid))
        const label = status === 'refuted' ? '证伪' : '受阻'
        this.lessonSave({
          title: label + '：' + row.surface + (row.vuln_class ? ' / ' + row.vuln_class : ''),
          category: 'negative',
          component: this.#productOfAsset(db, row.asset_id),
          content: label + '：' + basis + '；原假设：' + row.why + '；下次先看：' + (row.falsify || '无'),
          evidence: basis,
          asset_target: row.surface,
          by: patch.closed_by ?? null,
        }, { engagement: id })
      } catch { /* 经验写库失败不影响假设关闭 */ }
    }
    return { ok: true, id: Number(hid), status }
  }

  listHypotheses(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.status) { where.push('h.status = ?'); args.push(String(f.status)) }
    if (f.asset_id !== undefined && f.asset_id !== null && String(f.asset_id) !== '') { where.push('h.asset_id = ?'); args.push(Number(f.asset_id)) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 100, 500)
    const items = db.prepare(`SELECT h.*, a.ip AS asset_ip FROM hypothesis h
      LEFT JOIN asset a ON a.id = h.asset_id
      ${clause}
      ORDER BY CASE h.status WHEN 'open' THEN 0 ELSE 1 END, h.id DESC
      LIMIT ?`).all(...args, limit)
    return { ok: true, items, total: items.length, stats: this.hypothesisStats(id) }
  }

  /** 假设的账：提了几条、成立几条、证伪几条、成立率多少（只算已判定）。 */
  hypothesisStats(id) {
    const db = this.db(id)
    const rows = db.prepare('SELECT status, COUNT(*) AS n FROM hypothesis GROUP BY status').all()
    const by = {}
    for (const row of rows) by[String(row.status)] = Number(row.n) || 0
    const confirmed = by.confirmed || 0
    const refuted = by.refuted || 0
    const decided = confirmed + refuted
    return {
      total: Object.values(by).reduce((n, x) => n + x, 0),
      open: by.open || 0,
      confirmed,
      refuted,
      blocked: by.blocked || 0,
      hit_rate: decided > 0 ? Number((confirmed / decided).toFixed(2)) : null,
    }
  }

  /**
   * 控制台「未读」摘要：每个页签给一个「条数 + 最近一条时间」的轻量指针。
   *
   * 面板拿它跟本地记住的上次查看状态比：有新条数、或最新时间晚于上次查看，就在页签上点一个红点；
   * 用户点开该页签后把当前值记为已读，红点消失。**只读、只数数**，不做任何重活。
   */
  consoleDigest(id) {
    const db = this.db(id)
    const count = (sql) => {
      try { return Number(db.prepare(sql).get()?.n ?? 0) || 0 } catch { return 0 }
    }
    const at = (sql) => {
      try { return db.prepare(sql).get()?.t ?? null } catch { return null }
    }
    const maxOf = (a, b) => (a === null ? b : (b === null ? a : (a > b ? a : b)))
    /* 知识库是跨靶标共享的另一个库：拿不到就当作 0，不影响其它页签 */
    let kb = { count: 0, at: null }
    try {
      const k = this.kb()
      kb = {
        count: Number(k.prepare('SELECT COUNT(*) AS n FROM poc').get()?.n ?? 0),
        at: k.prepare('SELECT MAX(COALESCE(updated_at, created_at)) AS t FROM poc').get()?.t ?? null,
      }
    } catch { /* 知识库还没建：视为无更新 */ }
    const steps = 'SELECT COUNT(*) AS n FROM attack_step'
    const stepsAt = 'SELECT MAX(recorded_at) AS t FROM attack_step'
    const sections = {
      assets: {
        count: count('SELECT COUNT(*) AS n FROM asset'),
        at: at('SELECT MAX(COALESCE(discovered_at, first_seen, last_seen)) AS t FROM asset'),
      },
      testing: {
        count: count("SELECT COUNT(*) AS n FROM asset WHERE COALESCE(test_status, 'untested') <> 'untested'"),
        at: at('SELECT MAX(test_updated_at) AS t FROM asset'),
      },
      /* 「智能体」页签看的是"谁在执行"：用攻击步骤的最新动作当指针 */
      agents: { count: count(steps), at: at(stepsAt) },
      sessions: {
        count: count('SELECT COUNT(*) AS n FROM webshell') + count('SELECT COUNT(*) AS n FROM tunnel'),
        at: maxOf(
          at('SELECT MAX(COALESCE(updated_at, created_at)) AS t FROM webshell'),
          at('SELECT MAX(COALESCE(updated_at, created_at)) AS t FROM tunnel'),
        ),
      },
      findings: {
        count: count('SELECT COUNT(*) AS n FROM vuln'),
        at: at('SELECT MAX(found_at) AS t FROM vuln'),
      },
      chain: { count: count(steps), at: at(stepsAt) },
      /* 「成果」与「报告」看的是可交付漏洞：同一批数据，两个页签各自有红点 */
      score: { count: count('SELECT COUNT(*) AS n FROM vuln'), at: at('SELECT MAX(found_at) AS t FROM vuln') },
      report: { count: count('SELECT COUNT(*) AS n FROM vuln'), at: at('SELECT MAX(found_at) AS t FROM vuln') },
      attackfiles: {
        count: count('SELECT COUNT(*) AS n FROM attack_file'),
        at: at('SELECT MAX(created_at) AS t FROM attack_file'),
      },
      knowledge: kb,
      /* 提示词与技能库是随包分发的静态内容：没有"新条目"一说，永不点红点 */
      prompts: { count: 0, at: null },
      skills: { count: 0, at: null },
    }
    return { engagement: id, at: nowIso(), sections }
  }

  snapshot(id) {
    const meta = readMeta(this.metaPathOf(id)) || {}
    return {
      engagement: {
        id, name: meta.target_name || id, scope: meta.scope_cidrs || [],
        status: meta.status || 'active', created_at: meta.created_at || null,
      },
      stats: this.stats(id),
      tests: this.testStats(id),
      segments: this.listSegments(id),
    }
  }

  listSegments(id) {
    const rows = this.db(id).prepare(`
      SELECT s.cidr, s.org, s.asn, s.country, s.city, s.source,
        (SELECT COUNT(*) FROM asset a WHERE a.segment_cidr = s.cidr) AS assets,
        (SELECT COUNT(*) FROM asset a WHERE a.segment_cidr = s.cidr AND a.state = 'live') AS live,
        (SELECT COUNT(*) FROM port p JOIN asset a ON a.id = p.asset_id WHERE a.segment_cidr = s.cidr AND p.state = 'open') AS open_ports,
        (SELECT COUNT(*) FROM port p JOIN asset a ON a.id = p.asset_id WHERE a.segment_cidr = s.cidr AND p.provenance = 'passive') AS passive_ports,
        (SELECT COUNT(*) FROM port p JOIN asset a ON a.id = p.asset_id WHERE a.segment_cidr = s.cidr AND p.provenance = 'active') AS active_ports
      FROM segment s ORDER BY assets DESC, s.cidr`).all()
    /* C 段也分内外网：按网段起始地址归属判定 */
    return rows.map((r) => Object.assign({}, r, { scope: scopeOfIp(String(r.cidr || '').split('/')[0]) }))
  }

  /**
   * 把一组资产的 ports / fingerprints / names **一次查完**，按 asset_id 分组返回。
   *
   * 为什么需要：assetRow 原本对每个资产各跑 3 条查询，而资产列表默认 limit=400 ——
   * 一次列表请求就是 1200 条 SQL，而面板每次改筛选条件都会重查。
   * 这里改成 3 条 `IN (...)` 查询，成本与**资产数无关**。
   *
   * @param db - 靶标库句柄。
   * @param ids - 资产 id 数组（空数组直接返回空 Map）。
   * @returns `{ ports, fingerprints, names }`：三张 `Map<assetId, rows[]>`
   */
  assetChildren(db, ids = []) {
    const ports = new Map()
    const fingerprints = new Map()
    const names = new Map()
    const coverage = new Map()
    const list = Array.from(new Set(ids.filter((x) => x !== null && x !== undefined))).map(Number)
    if (list.length === 0) return { ports, fingerprints, names, coverage }
    const ph = list.map(() => '?').join(',')
    for (const row of db.prepare(`SELECT p.asset_id, p.port, p.proto, p.state, p.provenance, p.banner, p.url, p.title,
        s.name AS service, s.product, s.version
      FROM port p LEFT JOIN service s ON s.port_id = p.id
      WHERE p.asset_id IN (${ph}) ORDER BY p.asset_id, p.port`).all(...list)) {
      const key = Number(row.asset_id)
      if (!ports.has(key)) ports.set(key, [])
      ports.get(key).push(row)
    }
    for (const row of db.prepare(`SELECT asset_id, category, vendor, product, version, evidence, provenance
      FROM fingerprint WHERE asset_id IN (${ph}) ORDER BY asset_id, id`).all(...list)) {
      const key = Number(row.asset_id)
      if (!fingerprints.has(key)) fingerprints.set(key, [])
      fingerprints.get(key).push(row)
    }
    for (const row of db.prepare(`SELECT asset_id, name, kind, provenance
      FROM asset_name WHERE asset_id IN (${ph}) ORDER BY asset_id, id`).all(...list)) {
      const key = Number(row.asset_id)
      if (!names.has(key)) names.set(key, [])
      names.get(key).push(row)
    }
    /* 资产行的“覆盖”列与矩阵同口径：先按 asset_id，老数据没有 asset_id 时按 surface=ip/域名匹配。 */
    const bases = db.prepare(`SELECT id, ip, primary_name FROM asset WHERE id IN (${ph})`).all(...list)
    const surfaceToAsset = new Map()
    for (const b of bases) {
      const key = Number(b.id)
      if (!coverage.has(key)) coverage.set(key, new Set())
      for (const s of [b.ip, b.primary_name, ...(names.get(key) || []).map((n) => n.name)]) {
        const text = String(s || '').trim().toLowerCase()
        if (text) surfaceToAsset.set(text, key)
      }
    }
    for (const row of db.prepare('SELECT asset_id, surface, test_class, status FROM coverage').all()) {
      const cls = String(row.test_class || '').trim()
      if (!TEST_CLASSES.includes(cls) || row.status === 'untested') continue
      let key = row.asset_id === null || row.asset_id === undefined ? null : Number(row.asset_id)
      if (key === null) key = surfaceToAsset.get(String(row.surface || '').trim().toLowerCase()) ?? null
      if (key === null || !coverage.has(key)) continue
      coverage.get(key).add(cls)
    }
    return { ports, fingerprints, names, coverage }
  }

  /**
   * 单个资产 → 行结构。
   * @param db - 靶标库句柄。
   * @param a - asset 表的行。
   * @param children - 可选：assetChildren() 的预取结果。**传了就零额外查询**；
   *                   不传则退回单资产查询（详情页只用一次，N+1 无影响）。
   */
  assetRow(db, a, children = null) {
    let ports
    let fingerprints
    let names
    if (children !== null) {
      const key = Number(a.id)
      ports = children.ports.get(key) || []
      fingerprints = children.fingerprints.get(key) || []
      names = children.names.get(key) || []
    } else {
      ports = db.prepare(`SELECT p.port, p.proto, p.state, p.provenance, p.banner, p.url, p.title,
          s.name AS service, s.product, s.version
        FROM port p LEFT JOIN service s ON s.port_id = p.id
        WHERE p.asset_id = ? ORDER BY p.port`).all(a.id)
      fingerprints = db.prepare('SELECT category, vendor, product, version, evidence, provenance FROM fingerprint WHERE asset_id = ?').all(a.id)
      names = db.prepare('SELECT name, kind, provenance FROM asset_name WHERE asset_id = ?').all(a.id)
    }
    let covered = children !== null
      ? (children.coverage && children.coverage.get(Number(a.id))) || new Set()
      : null
    if (covered === null) {
      const surfaces = [a.ip, a.primary_name, ...(names || []).map((n) => n.name)]
        .map((s) => String(s || '').trim().toLowerCase()).filter(Boolean)
      const marks = new Set()
      if (surfaces.length) {
        const ph = surfaces.map(() => '?').join(',')
        for (const row of db.prepare(`SELECT test_class, status FROM coverage
          WHERE asset_id = ? OR LOWER(TRIM(surface)) IN (${ph})`).all(Number(a.id), ...surfaces)) {
          const cls = String(row.test_class || '').trim()
          if (TEST_CLASSES.includes(cls) && row.status !== 'untested') marks.add(cls)
        }
      }
      covered = marks
    }
    const coverageDone = TEST_CLASSES.filter((c) => covered.has(c))
    return {
      id: a.id, ip: a.ip, segment_cidr: a.segment_cidr, state: a.state,
      primary_name: a.primary_name, first_seen: a.first_seen, last_seen: a.last_seen,
      discovered_at: a.discovered_at || a.first_seen || null,
      test_status: a.test_status || 'untested', test_notes: a.test_notes || '',
      test_surface: a.test_surface || '', test_updated_at: a.test_updated_at || null,
      test_updated_by: a.test_updated_by || null, blocked_count: a.blocked_count || 0,
      coverage_done: coverageDone.length,
      coverage_total: TEST_CLASSES.length,
      coverage_state: coverageDone.length === 0 ? 'untested' : (coverageDone.length >= TEST_CLASSES.length ? 'covered' : 'partial'),
      coverage_missing: TEST_CLASSES.filter((c) => !covered.has(c)),
      priority: a.priority || null, potential: a.potential || '', assess_reason: a.assess_reason || '',
      assessed_at: a.assessed_at || null, assessed_by: a.assessed_by || null,
      scope: a.scope || scopeOfIp(a.ip),
      open_ports: ports.filter((p) => p.state === 'open').length,
      ports, fingerprints, names,
      passive: ports.filter((p) => p.provenance === 'passive').length,
      active: ports.filter((p) => p.provenance === 'active').length,
    }
  }


  listAssets(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.cidr) { where.push('a.segment_cidr = ?'); args.push(f.cidr) }
    if (f.state) { where.push('a.state = ?'); args.push(f.state) }
    if (f.ip) { where.push('a.ip = ?'); args.push(f.ip) }
    if (f.port) { where.push('EXISTS (SELECT 1 FROM port p WHERE p.asset_id = a.id AND p.port = ?)'); args.push(Number(f.port)) }
    if (f.service) {
      where.push('EXISTS (SELECT 1 FROM port p JOIN service s ON s.port_id = p.id WHERE p.asset_id = a.id AND (s.name LIKE ? OR s.product LIKE ?))')
      args.push(`%${f.service}%`, `%${f.service}%`)
    }
    if (f.fingerprint) {
      where.push('EXISTS (SELECT 1 FROM fingerprint fp WHERE fp.asset_id = a.id AND (fp.product LIKE ? OR fp.vendor LIKE ? OR fp.category LIKE ?))')
      args.push(`%${f.fingerprint}%`, `%${f.fingerprint}%`, `%${f.fingerprint}%`)
    }
    if (f.provenance) {
      where.push('EXISTS (SELECT 1 FROM port p WHERE p.asset_id = a.id AND p.provenance = ?)')
      args.push(f.provenance)
    }
    if (f.priority) {
      where.push('a.priority = ?')
      args.push(f.priority)
    }
    if (f.test_status) {
      /* 支持多值：test_status=abandoned,blocked */
      const list = String(f.test_status).split(',').map((x) => x.trim()).filter(Boolean)
      if (list.length > 1) {
        where.push(`COALESCE(a.test_status, 'untested') IN (${list.map(() => '?').join(',')})`)
        args.push(...list)
      } else {
        where.push("COALESCE(a.test_status, 'untested') = ?")
        args.push(f.test_status)
      }
    }
    /* 内外网维度：internal | external（老数据在迁移时已回填） */
    if (f.scope) {
      where.push(`COALESCE(a.scope, (${SCOPE_SQL})) = ?`)
      args.push(f.scope)
    }
    if (f.q) {
      const terms = String(f.q).split(/\s+/).filter(Boolean)
      if (terms.length) {
        if (HAS_FTS5) {
          /* 主域名（asset.primary_name）**没有**进 asset_fts 索引（FTS 表里只有
             ip / names / banners / titles / fingerprints），只靠 MATCH 会搜不到主域名 ——
             例如按 "portal.example.test" 查是 0 条。这里并入 LIKE 兜住它，
             顺带覆盖 LIKE 能匹配而 FTS 词元切分匹配不到的情形。 */
          where.push('(a.id IN (SELECT CAST(asset_id AS INTEGER) FROM asset_fts WHERE asset_fts MATCH ?)'
            + ' OR a.primary_name LIKE ?)')
          args.push(terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' AND '), '%' + String(f.q) + '%')
        } else {
          /* 无 FTS5 的 Node 构建：退化成子串匹配。
             语义比 FTS 弱（不做前缀/词干切分、LIKE 只对 ASCII 大小写不敏感），
             但**检索不报错、内容找得到**，比"整个面板打不开"好得多。
             检索面与 #reindex 喂给 asset_fts 的一致：
             资产 IP / 主域名 + asset_name + port.banner/title/url + service + fingerprint。 */
          const sub = [
            'EXISTS(SELECT 1 FROM asset_name n WHERE n.asset_id = a.id AND n.name LIKE ?)',
            'EXISTS(SELECT 1 FROM port p WHERE p.asset_id = a.id AND (p.banner LIKE ? OR p.title LIKE ? OR p.url LIKE ?))',
            'EXISTS(SELECT 1 FROM service s JOIN port p2 ON p2.id = s.port_id WHERE p2.asset_id = a.id'
              + ' AND (s.name LIKE ? OR s.product LIKE ? OR s.version LIKE ?))',
            'EXISTS(SELECT 1 FROM fingerprint f WHERE f.asset_id = a.id'
              + ' AND (f.vendor LIKE ? OR f.product LIKE ? OR f.version LIKE ? OR f.category LIKE ?))',
          ]
          const binds = (t) => ['%' + t + '%', '%' + t + '%', '%' + t + '%', '%' + t + '%',
            '%' + t + '%', '%' + t + '%', '%' + t + '%',
            '%' + t + '%', '%' + t + '%', '%' + t + '%', '%' + t + '%']
          for (const t of terms) {
            where.push('(a.ip LIKE ? OR a.primary_name LIKE ? OR ' + sub.join(' OR ') + ')')
            args.push('%' + t + '%', '%' + t + '%', ...binds(t))
          }
        }
      }
    }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const total = db.prepare(`SELECT COUNT(*) AS n FROM asset a ${clause}`).get(...args).n
    const limit = Math.min(Number(f.limit) || 200, 2000)
    const offset = Number(f.offset) || 0
    const openPorts = "COALESCE((SELECT COUNT(*) FROM port p WHERE p.asset_id = a.id AND p.state = 'open'), 0)"
    /* 排序：默认「最该打的排前面」——易打性高 → 未测 → 端口多；sort=ip / sort=ports 可切换 */
    const sort = f.sort || 'priority'
    let orderBy = 'a.ip_int'
    if (sort === 'ports') orderBy = `${openPorts} DESC, a.ip_int`
    /* 按发现时间倒序：新收集到的资产排前面（"刚发现了什么"最直观） */
    else if (sort === 'discovered') orderBy = `COALESCE(a.discovered_at, a.first_seen, '') DESC, a.id DESC`
    else if (sort === 'todo') {
      /* 待测优先：把这轮还能打的先顶上来，已测/放弃的沉底 */
      orderBy = `CASE COALESCE(a.test_status, 'untested')
          WHEN 'untested' THEN 0 WHEN 'testing' THEN 1 WHEN 'tested' THEN 2
          WHEN 'blocked' THEN 3 WHEN 'abandoned' THEN 4 WHEN 'no_surface' THEN 5 ELSE 6 END,
        CASE COALESCE(a.priority, '') WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
        ${openPorts} DESC, a.ip_int`
    } else if (sort === 'priority') {
      orderBy = `CASE COALESCE(a.priority, '') WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
        CASE COALESCE(a.test_status, 'untested')
          WHEN 'untested' THEN 0 WHEN 'testing' THEN 1 WHEN 'tested' THEN 2
          WHEN 'blocked' THEN 3 WHEN 'abandoned' THEN 4 WHEN 'no_surface' THEN 5 ELSE 6 END,
        ${openPorts} DESC, a.ip_int`
    }
    const rows = db.prepare(`SELECT a.*, ${openPorts} AS open_port_count FROM asset a ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .all(...args, limit, offset)
    /* 一次预取、逐行组装：把 3N 条查询压成 3 条（默认 N 最多 400） */
    const children = this.assetChildren(db, rows.map((r) => r.id))
    return { total, sort, items: rows.map((r) => this.assetRow(db, r, children)) }
  }

  getAsset(id, assetId) {
    const db = this.db(id)
    const a = db.prepare('SELECT * FROM asset WHERE id = ?').get(Number(assetId))
    if (!a) return undefined
    const detail = this.assetRow(db, a)
    detail.observations = db.prepare(`SELECT attr, value, provenance, tool, collected_at FROM observation
      WHERE entity_kind = 'asset' AND entity_id = ? ORDER BY collected_at DESC LIMIT 200`).all(a.id)
    detail.edges = db.prepare(`SELECT src_kind, src_id, dst_kind, dst_id, relation, confidence FROM edge
      WHERE (src_kind = 'asset' AND src_id = ?) OR (dst_kind = 'asset' AND dst_id = ?)`).all(String(a.id), String(a.id))
    return detail
  }

  /** 图谱投影：C 段 → 资产 → 开放端口（+ 域名解析关系）。 */
  graph(id, f = {}) {
    const db = this.db(id)
    const nodes = []
    const edges = []
    const seen = new Set()
    const push = (node) => { if (!seen.has(node.id)) { seen.add(node.id); nodes.push(node) } }
    const segs = f.cidr
      ? db.prepare('SELECT * FROM segment WHERE cidr = ?').all(f.cidr)
      : db.prepare('SELECT * FROM segment').all()
    for (const s of segs) {
      push({ id: `seg:${s.cidr}`, kind: 'segment', label: s.cidr, meta: { org: s.org, asn: s.asn } })
      for (const a of db.prepare('SELECT * FROM asset WHERE segment_cidr = ? ORDER BY ip_int').all(s.cidr)) {
        const nid = `asset:${a.id}`
        const ports = db.prepare("SELECT COUNT(*) AS n FROM port WHERE asset_id = ? AND state = 'open'").get(a.id).n
        push({ id: nid, kind: 'asset', label: a.ip, meta: { state: a.state, name: a.primary_name, ports, segment: a.segment_cidr } })
        edges.push({ source: `seg:${s.cidr}`, target: nid, relation: 'contains' })
        for (const p of db.prepare('SELECT id, port, proto, provenance FROM port WHERE asset_id = ? AND state = ?').all(a.id, 'open')) {
          const pid = `port:${p.id}`
          push({ id: pid, kind: 'port', label: `${p.port}/${p.proto}`, meta: { provenance: p.provenance, asset: a.ip } })
          edges.push({ source: nid, target: pid, relation: 'exposes' })
        }
        if (a.primary_name) {
          const did = `name:${a.primary_name}`
          push({ id: did, kind: 'domain', label: a.primary_name, meta: {} })
          edges.push({ source: did, target: nid, relation: 'resolves' })
        }
      }
    }
    return { nodes, edges }
  }

  /* ---------- 作战阶段 ---------- */

  /** 作战阶段：首次读取时补种默认五阶段（缺哪个补哪个，老靶标自动获得）。 */
  seedStages(id) {
    const db = this.db(id)
    /* 自愈式补种：缺哪个补哪个（老库被上一版迁移误删的阶段会自动补回来） */
    const have = new Set(db.prepare('SELECT code FROM stage').all().map((r) => r.code))
    if (DEFAULT_STAGES.every((st) => have.has(st.code))) return { seeded: 0 }
    let order = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS n FROM stage').get().n + 1
    const stmt = db.prepare(`INSERT INTO stage(code, name, subtitle, color, goal, sections, tools, transition, sort_order, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
    let seeded = 0
    for (const st of DEFAULT_STAGES) {
      if (have.has(st.code)) continue
      stmt.run(st.code, st.name, st.subtitle, st.color, st.goal, JSON.stringify(st.sections),
        st.tools, st.transition, order++, nowIso())
      seeded += 1
    }
    return { seeded: seeded }
  }

  listStages(id) {
    const db = this.db(id)
    this.seedStages(id)
    return db.prepare('SELECT * FROM stage ORDER BY sort_order, code').all().map((r, i) => ({
      code: r.code, name: r.name, subtitle: r.subtitle || '', color: r.color || '#64748b',
      goal: r.goal || '', sections: parseJson(r.sections, []), tools: r.tools || '',
      transition: r.transition || '',
      /* 链路里的真实位置（第几阶段）：界面画 ①②③ 与报告排序都用它，不要另行编号 */
      ordinal: i + 1,
      updated_at: r.updated_at || null,
    }))
  }


  /** 资产易打性评估：预期能拿到哪些成果、优先级多高。 */
  assessAsset(id, a = {}) {
    const db = this.db(id)
    let row
    if (a.asset_id !== undefined && a.asset_id !== null) row = db.prepare('SELECT * FROM asset WHERE id = ?').get(Number(a.asset_id))
    else if (a.ip) row = db.prepare('SELECT * FROM asset WHERE ip = ?').get(String(a.ip))
    if (row === undefined) throw new Error('asset not found（请传 asset_id 或 ip）')
    const priority = ['high', 'medium', 'low'].includes(a.priority) ? a.priority : (row.priority || 'medium')
    const stamp = nowIso()
    db.prepare('UPDATE asset SET priority = ?, potential = ?, assess_reason = ?, assessed_at = ?, assessed_by = ? WHERE id = ?')
      .run(priority, a.potential ?? (row.potential || ''), a.reason ?? (row.assess_reason || ''), stamp, a.assessed_by ?? null, row.id)
    this.#observe(db, 'asset', row.id, 'assess', priority + ' ' + (a.potential || ''), 'active', a.assessed_by ?? null, null)
    return { asset_id: row.id, ip: row.ip, priority, potential: a.potential ?? (row.potential || ''), assessed_at: stamp }
  }

  /* ---------- 资产测试状态（做了哪些测试 / 还剩什么攻击面） ---------- */

  /**
   * 记录对某个资产的测试情况。
   * @param id - 靶标 id。
   * @param t - `{ asset_id?, ip?, status?, test?, surface?, blocked?, updated_by? }`
   *   · test 会**追加**到测试记录（带时间戳）；
   *   · surface 覆盖「剩余可测攻击面」；
   *   · blocked=true 时封禁计数 +1。
   */
  updateAssetTest(id, t = {}) {
    const db = this.db(id)
    let row
    if (t.asset_id !== undefined && t.asset_id !== null) {
      row = db.prepare('SELECT * FROM asset WHERE id = ?').get(Number(t.asset_id))
    } else if (t.ip) {
      row = db.prepare('SELECT * FROM asset WHERE ip = ?').get(String(t.ip))
    }
    if (row === undefined) throw new Error('asset not found（请传 asset_id 或 ip）')
    const stamp = nowIso()
    /* 提示词历史上把这条记录叫 notes，模型也常照抄这个参数名；两种写法都收，
       统一落到 test_notes（追加式），避免"记了一行结论"其实什么都没写进去。 */
    const testText = [t.test, t.notes]
      .filter((x) => typeof x === 'string' && x.trim() !== '')
      .map((x) => x.trim())
      .join('；')
    /* 只写 test 不改状态：测试记录不等于“已测”。
       “已测”必须显式传 status，并且类级结论还要有覆盖账本；否则一条笔记就能把未测洗成 0。 */
    const status = ['untested', 'testing', 'tested', 'blocked', 'abandoned', 'no_surface'].includes(t.status)
      ? t.status
      : (row.test_status || 'untested')
    /* blocked / abandoned / no_surface 会让资产从矩阵门里豁免，必须留下原因，不能一句状态就消失。 */
    if (['blocked', 'abandoned', 'no_surface'].includes(status)
      && testText === '' && String(row.test_notes || '').trim() === '') {
      throw new Error('blocked / abandoned / no_surface 必须写原因（写进 test）：为什么打不了、为什么放弃、为什么无攻击面')
    }
    let notes = row.test_notes || ''
    if (testText !== '') {
      notes = (notes === '' ? '' : notes.replace(/\n+$/, '') + '\n') + '[' + stamp + '] ' + testText
    }
    const surface = typeof t.surface === 'string' ? t.surface : (row.test_surface || '')
    const blockedCount = (row.blocked_count || 0) + (t.blocked === true ? 1 : 0)
    db.prepare(`UPDATE asset SET test_status = ?, test_notes = ?, test_surface = ?,
        test_updated_at = ?, test_updated_by = ?, blocked_count = ? WHERE id = ?`).run(
      status, notes, surface, stamp, t.updated_by ?? null, blockedCount, row.id,
    )
    if (testText !== '') {
      this.#observe(db, 'asset', row.id, 'test', testText, 'active', t.updated_by ?? null, null)
    }
    if (t.blocked === true) {
      this.#observe(db, 'asset', row.id, 'blocked', '第 ' + blockedCount + ' 次被封禁', 'active', t.updated_by ?? null, null)
    }
    return {
      asset_id: row.id, ip: row.ip, status, blocked_count: blockedCount,
      test_notes: notes, tests: notes, surface, updated_at: stamp,
      hint: blockedCount >= 3
        ? '已累计被封 ' + blockedCount + ' 次（>3 次口径）：请在这次调用里把 status 置 abandoned 并写清剩余攻击面，然后换目标。'
        : undefined,
    }
  }

  /** 测试状态统计（供概览与筛选）。 */
  testStats(id) {
    const db = this.db(id)
    const rows = db.prepare("SELECT COALESCE(test_status, 'untested') AS s, COUNT(*) AS n FROM asset GROUP BY s").all()
    const out = { untested: 0, testing: 0, tested: 0, blocked: 0, abandoned: 0, no_surface: 0 }
    for (const r of rows) out[r.s] = r.n
    return out
  }

  /* ---------- 漏洞 / 凭据 / 访问会话 ---------- */

  /** 记录一条漏洞；带 cve 时按 (asset_id, cve, target) 幂等更新。 */
  addVuln(id, v = {}) {
    const db = this.db(id)
    const severity = SEVERITIES.includes(v.severity) ? v.severity : 'info'
    const status = VULN_STATUSES.includes(v.status) ? v.status : 'candidate'
    /* 批量导入与单条写入共用这一处校验：漏洞必须能挂到资产或具体 target 上，
       否则报告、面板、覆盖账本都关联不到它。 */
    if (!v.asset_id && !String(v.target || '').trim()) {
      throw new Error('漏洞要挂到资产或 target 上（candidate 也一样），否则报告与面板关联不到')
    }
    if (status === 'exploited' && !String(v.evidence || '').trim()) {
      throw new Error('exploited 漏洞必须有 evidence；空证据只允许 candidate')
    }
    const existing = v.cve
      ? db.prepare("SELECT id, status, target, asset_id FROM vuln WHERE asset_id IS ? AND cve = ? AND COALESCE(target, '') = ?")
        .get(v.asset_id ?? null, v.cve, v.target ?? '')
      : db.prepare("SELECT id, status, target, asset_id FROM vuln WHERE asset_id IS ? AND COALESCE(cve, '') = '' AND title = ? AND COALESCE(target, '') = ?")
        .get(v.asset_id ?? null, v.title ?? '', v.target ?? '')
    if (status === 'exploited') {
      const target = String(v.target ?? existing?.target ?? '').trim()
      const assetId = v.asset_id ?? existing?.asset_id
      if (!target && (assetId === undefined || assetId === null)) {
        throw new Error('exploited 漏洞必须有 target 或 asset_id；否则报告/面板关联不到资产')
      }
    }
    if (existing !== undefined) {
      /* 人工判定优先：重复入库 / 重扫回填不能把 confirmed / false-positive / fixed 降回候选。 */
      const incoming = VULN_STATUSES.includes(v.status) ? v.status : null
      const locked = HUMAN_VULN_VERDICTS.includes(existing.status)
      const nextStatus = locked ? existing.status : incoming
      db.prepare(`UPDATE vuln SET
          title = COALESCE(?, title), severity = ?, status = COALESCE(?, status),
          evidence = COALESCE(?, evidence), confidence = COALESCE(?, confidence),
          source = COALESCE(?, source), target = COALESCE(?, target),
          found_by_agent = COALESCE(?, found_by_agent), gained = COALESCE(?, gained),
          agent = COALESCE(?, agent)
        WHERE id = ?`).run(
        v.title ?? null, severity, nextStatus, v.evidence ?? null, v.confidence ?? null,
        v.source ?? null, v.target ?? null, v.found_by_agent ?? null, normGained(v.gained),
        v.agent ?? null, existing.id,
      )
      return {
        id: existing.id,
        updated: true,
        status: nextStatus || existing.status,
        status_locked: Boolean(locked && incoming && incoming !== existing.status),
      }
    }
    const result = db.prepare(`INSERT INTO vuln(asset_id, port_id, cve, title, severity, source, confidence, status, evidence, target, gained, found_by_agent, found_at, agent)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      v.asset_id ?? null, v.port_id ?? null, v.cve ?? null, v.title ?? null, severity,
      v.source ?? null, v.confidence ?? null, status, v.evidence ?? null, v.target ?? null,
      normGained(v.gained), v.found_by_agent ?? null, nowIso(), v.agent ?? null,
    )
    const vulnId = Number(result.lastInsertRowid)
    if (v.asset_id !== undefined && v.asset_id !== null) {
      this.#observe(db, 'asset', v.asset_id, 'vuln', [v.cve, v.title].filter(Boolean).join(' '), 'active', v.source ?? null, null)
    }
    return { id: vulnId, updated: false }
  }

  listVulns(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.severity) { where.push('v.severity = ?'); args.push(f.severity) }
    /* status=pending 是「待人工复核」的合成状态，不是库里的值 */
    if (f.status === 'pending' || f.pending === true) {
      where.push('v.status IN (' + PENDING_REVIEW_STATUSES.map(() => '?').join(',') + ')')
      args.push(...PENDING_REVIEW_STATUSES)
    } else if (f.status) { where.push('v.status = ?'); args.push(f.status) }
    if (f.cve) { where.push('v.cve LIKE ?'); args.push(`%${f.cve}%`) }
    if (f.asset_id !== undefined && f.asset_id !== null) { where.push('v.asset_id = ?'); args.push(Number(f.asset_id)) }
    if (f.cidr) { where.push('a.segment_cidr = ?'); args.push(f.cidr) }
    if (f.q) {
      where.push('(v.title LIKE ? OR v.cve LIKE ? OR v.target LIKE ? OR v.evidence LIKE ?)')
      const like = `%${f.q}%`
      args.push(like, like, like, like)
    }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 1000)
    const includeHttpEvidence = f.with_http_evidence !== false
    const total = db.prepare(`SELECT COUNT(*) AS n FROM vuln v LEFT JOIN asset a ON a.id = v.asset_id ${clause}`).get(...args).n
    const items = db.prepare(`SELECT v.*, a.ip AS asset_ip, a.segment_cidr
      FROM vuln v LEFT JOIN asset a ON a.id = v.asset_id ${clause}
      ORDER BY CASE v.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
               v.id DESC LIMIT ?`).all(...args, limit)
    /* 详情里要直接展示原始请求/响应，这里一并带上（请求体可能很大，做长度保护）。
       列表/报告/给模型的检索不需要正文：传 with_http_evidence:false 只回条数，
       否则一次 100 条 × 两条 60KB 的报文会把模型上下文直接打爆。 */
    const eviStmt = db.prepare(`SELECT id, label, method, url, status, request, response, note, captured_by, captured_at
      FROM http_evidence WHERE vuln_id = ? ORDER BY id`)
    const clipped = (t) => (t === null || t === undefined ? null : (String(t).length > 60000 ? String(t).slice(0, 60000) + '\n…（截断）' : String(t)))
    for (const item of items) {
      const rows = eviStmt.all(item.id)
      item.http_evidence_count = rows.length
      /* 关正文时仍保留 method/url/status 这些轻量元数据：收口校验同源、
         模型判断"有没有证据"都要用，但不该把 60KB 的包体带出去。 */
      item.http_evidence = rows.map((e) => Object.assign({}, e, {
        request: includeHttpEvidence ? clipped(e.request) : null,
        response: includeHttpEvidence ? clipped(e.response) : null,
      }))
    }
    /* 导入的漏洞常只写了 target、没有 asset_id：按 target 主机名回填资产。
       只在返回值里补，不改库 —— 面板与报告的「资产」一行不再永远是「—」。 */
    if (items.some((v) => !v.asset_ip || v.asset_id === null || v.asset_id === undefined)) {
      const assets = db.prepare('SELECT id, ip, primary_name, segment_cidr FROM asset').all()
      const byId = new Map(assets.map((a) => [a.id, a]))
      const index = new Map()
      const put = (key, a) => {
        const k = String(key || '').trim().toLowerCase()
        if (k && a && !index.has(k)) index.set(k, a)
      }
      for (const a of assets) { put(a.ip, a); put(a.primary_name, a) }
      try {
        for (const n of db.prepare('SELECT asset_id, name FROM asset_name').all()) put(n.name, byId.get(n.asset_id))
      } catch { /* asset_name 表在极老库里可能不存在 */ }
      for (const v of items) {
        const host = hostOfTarget(v.target)
        const hit = v.asset_id !== null && v.asset_id !== undefined
          ? byId.get(v.asset_id)
          : (host ? index.get(host.toLowerCase()) : null)
        if (!v.asset_ip) {
          if (hit) v.asset_ip = hit.ip || hit.primary_name || host
          else if (host) { v.asset_ip = host; v.asset_ip_inferred = true }
        }
        if ((v.asset_id === null || v.asset_id === undefined) && hit) v.asset_id = hit.id
        if (!v.segment_cidr && hit && hit.segment_cidr) v.segment_cidr = hit.segment_cidr
      }
    }
    /* 产出为空时带一句兜底影响：面板「产出」与报告用同一口径。 */
    for (const v of items) {
      if (!String(v.gained || '').trim()) v.impact = vulnImpactOf(v)
    }
    return { total, items }
  }

  updateVuln(id, vulnId, patch = {}) {
    const db = this.db(id)
    const current = db.prepare('SELECT * FROM vuln WHERE id = ?').get(Number(vulnId))
    if (current === undefined) return { updated: false }
    const incoming = VULN_STATUSES.includes(patch.status) ? patch.status : null
    const locked = HUMAN_VULN_VERDICTS.includes(current.status)
    const nextStatus = locked ? current.status : (incoming || current.status)
    /* 只在“改成 exploited”时收口；已经是 exploited 的旧数据仍可补标题/证据，不被卡死。 */
    if (incoming === 'exploited' && current.status !== 'exploited') {
      if (!String(patch.evidence ?? current.evidence ?? '').trim()) {
        return { updated: false, error: '改成 exploited 必须有 evidence；没证据先保持 candidate' }
      }
      const target = String(patch.target ?? current.target ?? '').trim()
      const assetId = patch.asset_id ?? current.asset_id
      if (!target && (assetId === undefined || assetId === null)) {
        return { updated: false, error: '改成 exploited 必须给 target 或 asset_id，否则报告/面板关联不到资产' }
      }
    }
    db.prepare(`UPDATE vuln SET status = ?, severity = ?, evidence = COALESCE(?, evidence), confidence = COALESCE(?, confidence),
        gained = COALESCE(?, gained), title = COALESCE(?, title), target = COALESCE(?, target), asset_id = COALESCE(?, asset_id)
      WHERE id = ?`).run(
      nextStatus,
      SEVERITIES.includes(patch.severity) ? patch.severity : current.severity,
      patch.evidence ?? null, patch.confidence ?? null, normGained(patch.gained), patch.title ?? null,
      patch.target ?? null, patch.asset_id ?? null, Number(vulnId),
    )
    return {
      updated: true,
      id: Number(vulnId),
      status: nextStatus,
      status_locked: Boolean(locked && incoming && incoming !== current.status),
    }
  }

  /**
   * 人工复核一条漏洞：确认 / 判误报 / 已修复 / 打回候选。
   * 只有面板和命令行走这里；智能体工具被 humanVerdictBlock 拦住。
   * @param patch - `{ verdict | status, note, by }`。
   */
  reviewVuln(id, vulnId, patch = {}) {
    const db = this.db(id)
    const current = db.prepare('SELECT * FROM vuln WHERE id = ?').get(Number(vulnId))
    if (current === undefined) return { updated: false, error: '漏洞不存在：' + vulnId }
    const verdict = String(patch.verdict || patch.status || '').trim()
    if (!VULN_STATUSES.includes(verdict)) {
      return { updated: false, error: '未知判定：' + (verdict || '（空）') }
    }
    const note = patch.note === undefined || patch.note === null ? null : String(patch.note).trim()
    if (verdict === 'false-positive' && !note) return { updated: false, error: '判误报要写一句理由' }
    const by = String(patch.by || 'human').trim() || 'human'
    const at = nowIso()
    db.prepare('UPDATE vuln SET status = ?, review_note = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?')
      .run(verdict, note, at, by, Number(vulnId))
    /* 审计：observation 是面板/报告共用的活动流，人改也要留痕 */
    try { this.#observe(db, 'vuln', Number(vulnId), 'review', verdict + (note ? '：' + note : ''), 'active', 'panel', null) } catch { /* 活动流不可用不影响判定 */ }
    /* 误报也要变成经验：下一轮 brief 会把它带出来，避免同一个方向重复打。 */
    if (verdict === 'false-positive') {
      try {
        this.lessonSave({
          title: '误报：' + (current.title || ('漏洞#' + Number(vulnId))) + (current.target ? ' @ ' + current.target : ''),
          category: 'negative',
          component: this.#productOfAsset(db, current.asset_id),
          content: '判定误报：' + note + '；原发现：' + String(current.evidence || '无证据摘要').slice(0, 240)
            + '；下次先验证：是否公开数据 / 是否需要登录 / 前置条件是否成立',
          evidence: note,
          asset_target: current.target || null,
          by,
        }, { engagement: id })
      } catch { /* 经验写库失败不影响人工判定 */ }
    }
    return { updated: true, id: Number(vulnId), status: verdict, review_note: note, reviewed_at: at, reviewed_by: by }
  }

  /**
   * 证据实体校验：报告/收口共用。
   *   · confirmed/exploited 必须有 evidence 摘要
   *   · target 是 http(s) 的 exploited 还必须有 http_evidence 行，且 URL host 与 target/资产同源
   */
  evidenceGaps(id) {
    const items = this.listVulns(id, { limit: 5000, with_http_evidence: false }).items || []
    const confirmed = items.filter((v) => v.status === 'confirmed' || v.status === 'exploited')
    const noEvidence = confirmed.filter((v) => !String(v.evidence || '').trim())
    const exploited = items.filter((v) => v.status === 'exploited')
    const noHttp = exploited.filter((v) => isHttpTarget(v.target)
      && (!Array.isArray(v.http_evidence) || v.http_evidence.length === 0))
    const mismatched = exploited.filter((v) => {
      const rows = Array.isArray(v.http_evidence) ? v.http_evidence : []
      if (!rows.length) return false
      const targetHost = String(hostOfTarget(v.target) || hostOfTarget(v.asset_ip) || '').toLowerCase()
      if (!targetHost) return false
      return !rows.some((row) => {
        const requestHost = String(row.request || '').match(/^Host:\s*([^\r\n]+)/im)?.[1] || ''
        const evidenceHost = String(hostOfTarget(row.url) || hostOfTarget(requestHost) || '').toLowerCase()
        return evidenceHost !== '' && evidenceHost === targetHost
      })
    })
    return { confirmed, exploited, noEvidence, noHttp, mismatched }
  }

  /**
   * 交付前统一收口检查：报告门、closeout、report_draft、bench 共用这一份口径。
   * 返回结构化 gaps；gaps 为空才 ready。pendingReview 单独返回（人要复核，AI 不能补）。
   */
  releaseGaps(id) {
    const stats = this.stats(id)
    const matrix = this.matrixSummary(id)
    const untested = this.untestedAssetIds(id).length
    const evidence = this.evidenceGaps(id)
    let vulns = []
    try { vulns = this.listVulns(id, { limit: 5000, with_http_evidence: false }).items || [] } catch { vulns = [] }
    const confirmed = evidence.confirmed
    const pendingReview = vulns.filter((v) => PENDING_REVIEW_STATUSES.includes(v.status))
    let steps = []
    try { steps = this.listChain(id) || [] } catch { steps = [] }
    let summary = { tunnels: [], webshells: [] }
    try { summary = this.sessionSummary(id) || summary } catch { /* 无入口 */ }
    let hyp = { open: 0, confirmed: 0, refuted: 0, blocked: 0, hit_rate: null }
    try { hyp = this.hypothesisStats(id) } catch { /* 老库无假设表 */ }
    /* 失败归因：把 blocked/refuted 也带出来，收口/下一轮能看到"这堵墙已经撞过"，
       不再只活在任务书里。 */
    let blockedHyp = []
    let refutedHyp = []
    try { blockedHyp = this.listHypotheses(id, { status: 'blocked', limit: 20 }).items || [] } catch { blockedHyp = [] }
    try { refutedHyp = this.listHypotheses(id, { status: 'refuted', limit: 20 }).items || [] } catch { refutedHyp = [] }

    const gaps = []
    const add = (code, count, message) => { if (count > 0) gaps.push({ code, count, message }) }
    add('untested', untested, untested + ' 个资产没有覆盖记录（8 类一格都没有）：先用 redteam_coverage 按面 × 测试类记账')
    add('matrix', matrix.partial_gaps, matrix.partial_gaps + ' 个测试格只做了一部分（涉及 ' + matrix.partial_assets + ' 个资产）：补成 tested/clean/skipped；不适用类用 coverage op=skip_rest 批量标 skipped（写原因）')
    add('noEvidence', evidence.noEvidence.length, evidence.noEvidence.length + ' 条已确认/已利用的漏洞没有 evidence：' + evidence.noEvidence.slice(0, 5).map((v) => v.title || v.id).join('、'))
    add('noHttp', evidence.noHttp.length, evidence.noHttp.length + ' 条 HTTP 目标的 exploited 没有 http_evidence 原始报文：先用 http_evidence_add 关联 vuln_id')
    add('evidenceMismatch', evidence.mismatched.length, evidence.mismatched.length + ' 条 exploited 的 HTTP 报文与漏洞 target/资产不同源：核对 URL host 后重挂证据')
    const noTool = steps.filter((s) => !String(s.tool || '').trim())
    const noResult = steps.filter((s) => !String(s.result || '').trim())
    add('chainTool', noTool.length, noTool.length + ' 条攻击步骤没写命令原文（报告无法复现）：' + noTool.slice(0, 5).map((s) => s.title || s.id).join('、'))
    add('chainResult', noResult.length, noResult.length + ' 条攻击步骤没写结果：' + noResult.slice(0, 5).map((s) => s.title || s.id).join('、'))
    const badTunnels = (summary.tunnels || []).filter((t) => t.status === 'active'
      && (!t.entry_kind || t.entry_kind === 'self-only' || t.legit === 0 || t.legit === false))
    add('tunnel', badTunnels.length, badTunnels.length + ' 条隧道未构成突破（未声明入口或仅本机）：补全入口，或从成果里移除')
    const offlineShells = (summary.webshells || []).filter((w) => w.status && w.status !== 'online')
    add('webshell', offlineShells.length, offlineShells.length + ' 个 WebShell 不在线：重测连通性，或标成失效再交付')
    add('hypothesis', hyp.open, hyp.open + ' 条假设还开着：给结论——confirmed（挂 vuln_id）、refuted（写依据）或 blocked（写原因）')

    return {
      stats, matrix, untested, evidence, vulns, confirmed, pendingReview, steps, summary, hyp,
      blockedHyp, refutedHyp, gaps, ready: gaps.length === 0,
      matrixGaps: this.matrixGaps(id, { limit: 20 }),
    }
  }

  vulnStats(id) {
    const db = this.db(id)
    const bySeverity = {}
    for (const row of db.prepare('SELECT severity, COUNT(*) AS n FROM vuln GROUP BY severity').all()) bySeverity[row.severity] = row.n
    const byStatus = {}
    for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM vuln GROUP BY status').all()) byStatus[row.status] = row.n
    /* 待人工复核：AI 已发现/已复现，但还没有人的结论 */
    const pendingReview = PENDING_REVIEW_STATUSES.reduce((n, s) => n + (byStatus[s] || 0), 0)
    /* 已经写明"拿到了什么权限"的漏洞数：结论行用 */
    const withGained = db.prepare("SELECT COUNT(*) AS n FROM vuln WHERE COALESCE(gained,'') <> ''").get().n
    const withEvidence = db.prepare("SELECT COUNT(*) AS n FROM vuln WHERE COALESCE(evidence,'') <> '' OR id IN (SELECT vuln_id FROM http_evidence WHERE vuln_id IS NOT NULL)").get().n
    /* 按目标聚合所需的组数（漏洞页默认视图）：先按「站点/服务」归并再数 */
    const rawTargets = db.prepare(`SELECT target, (SELECT ip FROM asset WHERE id = vuln.asset_id) AS ip FROM vuln`).all()
    const targetGroups = new Set(rawTargets.map((r) => targetKey(r.target, r.ip))).size
    return {
      total: Object.values(bySeverity).reduce((a, b) => a + b, 0),
      bySeverity, byStatus, withGained, withEvidence, targetGroups, pendingReview,
    }
  }

  /** 凭据：明文写 secret_value（面板直接显示），同时保留 secret_ref 指向证据文件。 */
  addCredential(id, c = {}) {
    const db = this.db(id)
    if (!c.host) throw new Error('credential.host required')
    /* 明文凭据：secret_value 为准，兼容 secret / password / value 等别名 */
    const value = c.secret_value ?? c.secret ?? c.password ?? c.value ?? null
    db.prepare(`INSERT INTO credential(asset_id, host, username, secret_type, secret_value, secret_ref, privilege, source, tool, note, found_by_agent, found_at, agent)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(host, username, secret_type) DO UPDATE SET
        secret_value = COALESCE(excluded.secret_value, credential.secret_value),
        secret_ref = COALESCE(excluded.secret_ref, credential.secret_ref),
        privilege = COALESCE(excluded.privilege, credential.privilege),
        note = COALESCE(excluded.note, credential.note),
        agent = COALESCE(excluded.agent, credential.agent),
        found_at = excluded.found_at`).run(
      c.asset_id ?? null, c.host, c.username ?? '', c.secret_type ?? 'password',
      value === null || value === undefined ? null : String(value),
      c.secret_ref ?? null, c.privilege ?? null, c.source ?? null, c.tool ?? null,
      c.note ?? null, c.found_by_agent ?? null, nowIso(), c.agent ?? null,
    )
    const row = db.prepare('SELECT id FROM credential WHERE host = ? AND username = ? AND secret_type = ?')
      .get(c.host, c.username ?? '', c.secret_type ?? 'password')
    return { id: row.id }
  }

  listCredentials(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.host) { where.push('host = ?'); args.push(f.host) }
    if (f.username) { where.push('username = ?'); args.push(f.username) }
    if (f.withValue === true) where.push("COALESCE(secret_value,'') <> ''")
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 1000)
    return db.prepare(`SELECT * FROM credential ${clause} ORDER BY id DESC LIMIT ?`).all(...args, limit)
  }

  /** 访问会话：一次可控访问（横向移动的起点）。 */
  addAccess(id, a = {}) {
    const db = this.db(id)
    if (!a.host) throw new Error('access.host required')
    const result = db.prepare(`INSERT INTO access_session(asset_id, host, username, method, privilege, session_ref, note, found_by_agent, obtained_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(
      a.asset_id ?? null, a.host, a.username ?? null, a.method ?? null, a.privilege ?? null,
      a.session_ref ?? null, a.note ?? null, a.found_by_agent ?? null, nowIso(),
    )
    if (a.asset_id !== undefined && a.asset_id !== null) {
      this.#observe(db, 'asset', a.asset_id, 'access', [a.method, a.username, a.privilege].filter(Boolean).join(' '), 'active', 'exploit', null)
    }
    return { id: Number(result.lastInsertRowid) }
  }

  listAccess(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.host) { where.push('host = ?'); args.push(f.host) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 1000)
    return db.prepare(`SELECT * FROM access_session ${clause} ORDER BY id DESC LIMIT ?`).all(...args, limit)
  }

  /* ---------- WebShell 与隧道：打的过程中随时可复用的资产 ---------- */

  /**
   * 登记一个已上线的 WebShell。同一 url+pass_key 视为同一条，重复登记即刷新。
   * @param w - `{ url, shell_type, pass_key, secret_ref, privilege, status, note, asset_id, found_by_agent }`
   */
  addWebshell(id, w = {}) {
    const db = this.db(id)
    if (!w.url) throw new Error('webshell.url required')
    const ts = nowIso()
    const existing = db.prepare('SELECT id FROM webshell WHERE url = ? AND COALESCE(pass_key, \'\') = COALESCE(?, \'\')')
      .get(w.url, w.pass_key ?? null)
    if (existing !== undefined) {
      db.prepare(`UPDATE webshell SET shell_type = COALESCE(?, shell_type), secret_ref = COALESCE(?, secret_ref),
        privilege = COALESCE(?, privilege), status = COALESCE(?, status), note = COALESCE(?, note),
        asset_id = COALESCE(?, asset_id), agent = COALESCE(?, agent), updated_at = ? WHERE id = ?`)
        .run(normalizeShellType(w.shell_type), w.secret_ref ?? null, w.privilege ?? null, normalizeShellStatus(w.status),
          w.note ?? null, w.asset_id ?? null, w.agent ?? null, ts, existing.id)
      return { id: Number(existing.id), updated: true }
    }
    const result = db.prepare(`INSERT INTO webshell(asset_id, url, shell_type, pass_key, secret_ref, privilege,
      status, note, found_by_agent, created_at, updated_at, agent) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(w.asset_id ?? null, w.url, normalizeShellType(w.shell_type), w.pass_key ?? null, w.secret_ref ?? null,
        w.privilege ?? null, normalizeShellStatus(w.status), w.note ?? null, w.found_by_agent ?? null, ts, ts, w.agent ?? null)
    if (w.asset_id !== undefined && w.asset_id !== null) {
      this.#observe(db, 'asset', w.asset_id, 'webshell', w.url, 'active', 'exploit', null)
    }
    return { id: Number(result.lastInsertRowid), updated: false }
  }

  listWebshells(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.status) { where.push('status = ?'); args.push(f.status) }
    if (f.asset_id) { where.push('asset_id = ?'); args.push(f.asset_id) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 1000)
    return db.prepare(`SELECT w.*, a.ip AS asset_ip FROM webshell w
      LEFT JOIN asset a ON a.id = w.asset_id ${clause} ORDER BY w.id DESC LIMIT ?`).all(...args, limit)
  }

  updateWebshell(id, wsId, patch = {}) {
    const db = this.db(id)
    const fields = ['status', 'check_note', 'latency_ms', 'last_check', 'privilege', 'note', 'secret_ref', 'shell_type']
    const sets = []
    const args = []
    /* update 路径与新增路径用同一套规范化：以前这里能写任意字符串，
       面板的"非冰蝎马用户连不上"红标会因此静默失效。 */
    for (const key of fields) {
      if (patch[key] === undefined) continue
      let value = patch[key]
      if (key === 'shell_type') value = normalizeShellType(value)
      if (key === 'status') value = normalizeShellStatus(value)
      sets.push(`${key} = ?`); args.push(value)
    }
    if (sets.length === 0) throw new Error('nothing to update')
    sets.push('updated_at = ?'); args.push(nowIso())
    const result = db.prepare(`UPDATE webshell SET ${sets.join(', ')} WHERE id = ?`).run(...args, wsId)
    if (result.changes === 0) throw new Error('webshell not found')
    return { updated: true }
  }

  /**
   * 登记一条内网隧道（suo5 / socks5 / ssh -R / frp …）。
   *
   * **判定规则**：只有跨越了靶标边界（通道一端在目标侧）的才算突破凭证：
   *   · target-outbound 目标主动连出（反弹 shell 落到我的服务器 / 目标上跑 frp 客户端）
   *   · target-http     经目标 WebShell/HTTP 通道（suo5 / Neo-ReGeorg）
   *   · target-agent    经目标已控进程/会话转发（SSH -R 由目标发起）
   *   · self-only       只在自己 VPS/自建服务器上开的代理或服务端 —— **不算突破**
   * 只在自己服务器上开个 socks5 不算打进内网，必须说清"目标侧的那一端是什么"。
   */
  addTunnel(id, t = {}) {
    const db = this.db(id)
    const ts = nowIso()
    /* entry_kind 是**边界突破的凭证字段**：写错必须报错，不能静默归零。
       认不出的值写成 NULL 会让 legit=null，界面显示"待确认" —— 与"没填"无法区分，
       而模型只是多打了一个空格（`target-http `）就踩到，事后完全查不出原因。 */
    const rawEntryKind = t.entry_kind === undefined || t.entry_kind === null ? '' : String(t.entry_kind).trim()
    if (rawEntryKind !== '' && TUNNEL_ENTRY_KINDS[rawEntryKind] === undefined) {
      throw new Error('entry_kind 非法：' + JSON.stringify(t.entry_kind) + '。合法值只有 '
        + Object.keys(TUNNEL_ENTRY_KINDS).join(' / ') + '（' + Object.values(TUNNEL_ENTRY_KINDS).join(' / ') + '）。'
        + '留空会被当作"待确认"、不计入边界突破。')
    }
    const rawStatus = t.status === undefined || t.status === null || t.status === '' ? 'active' : String(t.status).trim()
    if (!TUNNEL_STATUSES.includes(rawStatus)) {
      throw new Error('tunnel status 非法：' + JSON.stringify(t.status) + '。合法值只有 ' + TUNNEL_STATUSES.join(' / ') + '。')
    }
    const result = db.prepare(`INSERT INTO tunnel(asset_id, webshell_id, kind, listen, entry, reach, entry_kind,
      status, pid, command, note, found_by_agent, created_at, updated_at, agent) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(t.asset_id ?? null, t.webshell_id ?? null, t.kind ?? 'socks5', t.listen ?? null, t.entry ?? null,
        t.reach ?? null, rawEntryKind === '' ? null : rawEntryKind, rawStatus, t.pid ?? null, t.command ?? null, t.note ?? null,
        t.found_by_agent ?? null, ts, ts, t.agent ?? null)
    if (t.asset_id !== undefined && t.asset_id !== null) {
      this.#observe(db, 'asset', t.asset_id, 'tunnel', `${t.kind || 'socks5'} ${t.listen || ''}`.trim(), 'active', 'exploit', null)
    }
    const entryKind = rawEntryKind === '' ? null : rawEntryKind
    const legit = tunnelIsLegit(entryKind)
    return {
      id: Number(result.lastInsertRowid),
      entry_kind: entryKind,
      legit,
      warning: legit === false
        ? '已登记，但 entry_kind=self-only（只在自己 VPS/自建服务器上开的通道）—— **这不算隧道、不算边界突破/内网突破**。必须是目标侧发起的通道：目标反弹 shell 到我的服务器、目标上跑 frp 客户端、或经目标 WebShell 建的 suo5/HTTP 隧道。'
        : (legit === null
            ? '建议补 entry_kind 说明"目标侧的那一端是什么"（target-outbound / target-http / target-agent）；不声明时界面按"待确认"显示，也不计入突破凭证。'
            : undefined),
    }
  }

  listTunnels(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.status) { where.push('t.status = ?'); args.push(f.status) }
    if (f.asset_id) { where.push('t.asset_id = ?'); args.push(f.asset_id) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 1000)
    return db.prepare(`SELECT t.*, a.ip AS asset_ip, w.url AS webshell_url FROM tunnel t
      LEFT JOIN asset a ON a.id = t.asset_id
      LEFT JOIN webshell w ON w.id = t.webshell_id ${clause} ORDER BY t.id DESC LIMIT ?`).all(...args, limit)
      .map((t) => Object.assign({}, t, { legit: tunnelIsLegit(t.entry_kind), entry_kind_label: TUNNEL_ENTRY_KINDS[t.entry_kind] || null }))
  }

  updateTunnel(id, tId, patch = {}) {
    const db = this.db(id)
    const fields = ['status', 'check_note', 'latency_ms', 'last_check', 'listen', 'reach', 'entry', 'entry_kind', 'pid', 'command', 'note']
    const sets = []
    const args = []
    /* update 路径此前**完全不校验** entry_kind / status：新增时被规范化成 NULL，
       更新时却能直接写任意字符串进库，把 legit 判定彻底绕过。这里与新增路径对齐。 */
    for (const key of fields) {
      if (patch[key] === undefined) continue
      let value = patch[key]
      if (key === 'entry_kind') {
        const raw = value === null ? '' : String(value).trim()
        if (raw !== '' && TUNNEL_ENTRY_KINDS[raw] === undefined) {
          throw new Error('entry_kind 非法：' + JSON.stringify(value) + '。合法值只有 '
            + Object.keys(TUNNEL_ENTRY_KINDS).join(' / ') + '。')
        }
        value = raw === '' ? null : raw
      }
      if (key === 'status') {
        const raw = String(value).trim()
        if (!TUNNEL_STATUSES.includes(raw)) {
          throw new Error('tunnel status 非法：' + JSON.stringify(value) + '。合法值只有 ' + TUNNEL_STATUSES.join(' / ') + '。')
        }
        value = raw
      }
      sets.push(`${key} = ?`); args.push(value)
    }
    if (sets.length === 0) throw new Error('nothing to update')
    sets.push('updated_at = ?'); args.push(nowIso())
    const result = db.prepare(`UPDATE tunnel SET ${sets.join(', ')} WHERE id = ?`).run(...args, tId)
    if (result.changes === 0) throw new Error('tunnel not found')
    return { updated: true }
  }

  /**
   * 当前测试面板：正在测的资产 + 最近动过的资产（带各自已确认漏洞数/端口数/入口数）。
   * 攻击链页面的「当前正在测」区块用它，客户端每隔几秒轮询一次实现实时更新。
   */
  activeTests(id, f = {}) {
    const db = this.db(id)
    const limit = Math.min(Number(f.limit) || 8, 50)
    const select = `SELECT a.id, a.ip, a.segment_cidr, COALESCE(a.scope, (${SCOPE_SQL})) AS scope, a.state,
        COALESCE(a.test_status, 'untested') AS test_status, a.test_notes, a.test_surface,
        a.test_updated_at, a.test_updated_by, COALESCE(a.blocked_count, 0) AS blocked_count,
        a.priority, a.potential,
        (SELECT COUNT(*) FROM port p WHERE p.asset_id = a.id AND p.state = 'open') AS open_ports,
        (SELECT COUNT(*) FROM vuln v WHERE v.asset_id = a.id AND v.status IN ('confirmed','exploited')) AS vulns,
        (SELECT COUNT(*) FROM webshell w WHERE w.asset_id = a.id) AS webshells,
        (SELECT COUNT(*) FROM tunnel t WHERE t.asset_id = a.id) AS tunnels`
    const testing = db.prepare(`${select} FROM asset a
      WHERE COALESCE(a.test_status, 'untested') = 'testing'
      ORDER BY a.test_updated_at DESC, a.id DESC LIMIT ?`).all(limit)
    /* 最近动过：排除正在测的，避免两个区块重复 */
    const recent = db.prepare(`${select} FROM asset a
      WHERE a.test_updated_at IS NOT NULL AND COALESCE(a.test_status, 'untested') <> 'testing'
      ORDER BY a.test_updated_at DESC LIMIT ?`).all(limit)
    /* 待测队列：还没动的，按易打性 + 端口数排出先打哪几台 */
    const queue = db.prepare(`${select} FROM asset a
      WHERE COALESCE(a.test_status, 'untested') = 'untested'
      ORDER BY CASE COALESCE(a.priority, '') WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
        (SELECT COUNT(*) FROM port p WHERE p.asset_id = a.id AND p.state = 'open') DESC, a.ip_int
      LIMIT ?`).all(limit)
    const untested = db.prepare(`SELECT COUNT(*) AS n FROM asset a
      WHERE COALESCE(a.test_status, 'untested') = 'untested'`).get().n
    return { testing, recent, queue, stats: this.testStats(id), untested, at: nowIso() }
  }







  /** 会话总览：给界面和提示词用的一屏摘要（含在线/离线统计）。 */
  sessionSummary(id) {
    const db = this.db(id)
    const shells = db.prepare(`SELECT w.*, a.ip AS asset_ip FROM webshell w
      LEFT JOIN asset a ON a.id = w.asset_id ORDER BY w.id DESC`).all()
    const tunnels = db.prepare(`SELECT t.*, a.ip AS asset_ip, w.url AS webshell_url FROM tunnel t
      LEFT JOIN asset a ON a.id = t.asset_id LEFT JOIN webshell w ON w.id = t.webshell_id ORDER BY t.id DESC`).all()
      .map((t) => Object.assign({}, t, { legit: tunnelIsLegit(t.entry_kind), entry_kind_label: TUNNEL_ENTRY_KINDS[t.entry_kind] || null }))
    const creds = db.prepare('SELECT COUNT(*) AS n FROM credential').get()
    const access = db.prepare('SELECT COUNT(*) AS n FROM access_session').get()
    return {
      webshells: shells, tunnels,
      totals: {
        webshells: shells.length,
        webshellsOnline: shells.filter((s) => s.status === 'online').length,
        tunnels: tunnels.length,
        tunnelsActive: tunnels.filter((s) => s.status === 'active').length,
        /* 只有跨越靶标边界的通道才算突破凭证（自己 VPS/自建服务器上开的不算） */
        tunnelsLegit: tunnels.filter((s) => s.legit === true).length,
        tunnelsSelfOnly: tunnels.filter((s) => s.legit === false).length,
        credentials: creds ? creds.n : 0,
        access: access ? access.n : 0,
      },
    }
  }

  /**
   * 实测连通性（host 平面专有：智能体跑在沙箱里，只有这里能直接发起连接）。
   * WebShell 发一次不带参数的 GET；隧道做一次 TCP 连接。
   * 结果回写 status / last_check / latency_ms / check_note。
   */
  async probeSessions(id, options = {}) {
    const timeout = Math.min(Math.max(Number(options.timeoutMs) || 6000, 1000), 20000)
    const out = { webshells: [], tunnels: [], checkedAt: nowIso() }

    for (const s of this.listWebshells(id, { limit: 500 })) {
      const started = Date.now()
      let status = 'offline'
      let note = ''
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeout)
        const res = await fetch(s.url, { method: 'GET', redirect: 'manual', signal: controller.signal })
        clearTimeout(timer)
        status = res.status < 500 ? 'online' : 'offline'
        note = `HTTP ${res.status}`
      } catch (error) {
        note = error && error.name === 'AbortError' ? `超时 >${timeout}ms` : String((error && error.message) || error).slice(0, 160)
      }
      const latency = Date.now() - started
      try {
        this.updateWebshell(id, s.id, { status, last_check: nowIso(), latency_ms: latency, check_note: note })
      } catch { /* ignore */ }
      out.webshells.push({ id: s.id, url: s.url, status, note, latency_ms: latency })
    }

    for (const t of this.listTunnels(id, { limit: 500 })) {
      const target = String(t.listen || '').replace(/^socks5:\/\//, '').replace(/^https?:\/\//, '')
      const started = Date.now()
      let status = 'down'
      let note = ''
      if (target === '') {
        note = '缺少 listen 地址，无法探测'
      } else {
        const idx = target.lastIndexOf(':')
        const host = idx > 0 ? target.slice(0, idx) : '127.0.0.1'
        const port = Number(idx > 0 ? target.slice(idx + 1) : target)
        if (!Number.isFinite(port) || port <= 0) {
          note = `无法解析端口：${t.listen}`
        } else {
          note = await new Promise((resolve) => {
            let done = false
            const socket = tcpConnect({ host, port })
            const finish = (ok, text) => {
              if (done) return
              done = true
              try { socket.destroy() } catch { /* ignore */ }
              resolve(ok ? '' : text)
            }
            socket.setTimeout(timeout)
            socket.on('connect', () => { status = 'active'; finish(true, '') })
            socket.on('timeout', () => { finish(false, `超时 >${timeout}ms`) })
            socket.on('error', (error) => { finish(false, String((error && error.code) || (error && error.message) || error).slice(0, 120)) })
          })
        }
      }
      const latency = Date.now() - started
      try {
        this.updateTunnel(id, t.id, { status, last_check: nowIso(), latency_ms: latency, check_note: note })
      } catch { /* ignore */ }
      out.tunnels.push({ id: t.id, kind: t.kind, listen: t.listen, status, note, latency_ms: latency })
    }
    return out
  }

  /**
   * 攻击图谱：在资产拓扑上叠加漏洞与已控制资产。
   * 节点 kind：segment / asset（meta.vulns 按严重级计数、meta.owned） / vuln（已确认）。
   * 边 relation：contains / exposes / resolves / has_vuln。
   */
  attackGraph(id, f = {}) {
    const base = this.graph(id, f)
    const db = this.db(id)
    const nodes = base.nodes.slice()
    const edges = base.edges.slice()
    const byId = new Map(nodes.map((n) => [n.id, n]))

    const vulnRows = db.prepare(`SELECT asset_id, severity, COUNT(*) AS n FROM vuln
      WHERE asset_id IS NOT NULL GROUP BY asset_id, severity`).all()
    for (const row of vulnRows) {
      const node = byId.get(`asset:${row.asset_id}`)
      if (node === undefined) continue
      node.meta = node.meta || {}
      node.meta.vulns = node.meta.vulns || {}
      node.meta.vulns[row.severity] = row.n
    }
    const owned = db.prepare('SELECT DISTINCT asset_id FROM access_session WHERE asset_id IS NOT NULL').all()
    for (const row of owned) {
      const node = byId.get(`asset:${row.asset_id}`)
      if (node !== undefined) { node.meta = node.meta || {}; node.meta.owned = true }
    }
    const confirmed = db.prepare(`SELECT v.id, v.asset_id, v.cve, v.title, v.severity, v.status
      FROM vuln v WHERE v.status IN ('confirmed','exploited') AND v.asset_id IS NOT NULL
      ORDER BY CASE v.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END LIMIT 200`).all()
    for (const v of confirmed) {
      const nodeId = `vuln:${v.id}`
      nodes.push({ id: nodeId, kind: 'vuln', label: v.cve || (v.title || '').slice(0, 18), meta: { severity: v.severity, status: v.status, title: v.title } })
      edges.push({ source: `asset:${v.asset_id}`, target: nodeId, relation: 'has_vuln' })
    }
    return { nodes, edges, summary: this.vulnStats(id) }
  }

  /* ---------- 域名维度 / Web 资产 ---------- */

  /**
   * 按域名聚合资产：域名 → 该域名下的资产清单（无域名的资产归入「(未关联域名)」）。
   * @param f - `{ cidr? }` 只看某个 C 段（与左侧 C 段选择保持一致，避免维度串台）。
   */
  domainIndex(id, f = {}) {
    const db = this.db(id)
    const assets = (f.cidr
      ? db.prepare('SELECT id, ip, segment_cidr, state, primary_name FROM asset WHERE segment_cidr = ? ORDER BY ip_int').all(f.cidr)
      : db.prepare('SELECT id, ip, segment_cidr, state, primary_name FROM asset ORDER BY ip_int').all())
    const names = db.prepare('SELECT asset_id, name, kind, provenance FROM asset_name').all()
    const byAsset = new Map()
    for (const n of names) {
      if (!byAsset.has(n.asset_id)) byAsset.set(n.asset_id, [])
      byAsset.get(n.asset_id).push(n)
    }
    const groups = new Map()
    for (const a of assets) {
      const domains = new Set()
      if (a.primary_name) domains.add(a.primary_name)
      for (const n of byAsset.get(a.id) || []) domains.add(n.name)
      if (domains.size === 0) domains.add('(未关联域名)')
      for (const domain of domains) {
        if (!groups.has(domain)) groups.set(domain, [])
        groups.get(domain).push({ id: a.id, ip: a.ip, segment: a.segment_cidr, state: a.state, names: (byAsset.get(a.id) || []).map((n) => n.name) })
      }
    }
    return Array.from(groups.entries())
      .map(([domain, list]) => ({ domain, count: list.length, assets: list }))
      .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
  }

  /** Web 资产清单：有 URL/标题或常见 Web 端口的资产。 */
  listWeb(id, f = {}) {
    const db = this.db(id)
    const rows = db.prepare(`SELECT p.id AS port_id, p.port, p.proto, p.url, p.title, p.banner, p.provenance, p.tool,
        a.id AS asset_id, a.ip, a.segment_cidr, a.primary_name, a.state,
        s.name AS service, s.product, s.version
      FROM port p JOIN asset a ON a.id = p.asset_id
      LEFT JOIN service s ON s.port_id = p.id
      WHERE p.state = 'open' AND (
        p.url IS NOT NULL OR p.title IS NOT NULL
        OR s.name IN ('http', 'https', 'http-proxy', 'ssl/http')
        OR p.port IN (80, 81, 443, 8000, 8001, 8080, 8081, 8082, 8443, 8888, 9090, 7001, 9000, 9443)
      )
      ORDER BY a.ip_int, p.port`).all()
    const filtered = f.cidr ? rows.filter((r) => r.segment_cidr === f.cidr) : rows
    const limited = f.limit ? filtered.slice(0, Number(f.limit)) : filtered
    return { total: filtered.length, items: limited }
  }

  /* ---------- HTTP 证据（Burp / Yakit 可复现） ---------- */

  addHttpEvidence(id, e = {}) {
    const db = this.db(id)
    const result = db.prepare(`INSERT INTO http_evidence(vuln_id, asset_id, label, method, url, status, request, response, note, captured_by, captured_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      e.vuln_id ?? null, e.asset_id ?? null, e.label ?? null, e.method ?? 'GET', e.url ?? null,
      e.status ?? null, e.request ?? null, e.response ?? null, e.note ?? null,
      e.captured_by ?? null, nowIso(),
    )
    return { id: Number(result.lastInsertRowid) }
  }

  listHttpEvidence(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.vuln_id !== undefined && f.vuln_id !== null) { where.push('vuln_id = ?'); args.push(Number(f.vuln_id)) }
    if (f.asset_id !== undefined && f.asset_id !== null) { where.push('asset_id = ?'); args.push(Number(f.asset_id)) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 100, 500)
    return db.prepare(`SELECT * FROM http_evidence ${clause} ORDER BY id DESC LIMIT ?`).all(...args, limit)
  }

  /**
   * 一条漏洞的复现报文（报告专用）。
   *
   * 优先用显式录入的 http_evidence；没有时从证据原文里认出请求/响应并整理成
   * 原始报文 —— 导入的报告常常只留下人写的复现记录，报告里照样要有能粘进
   * Burp / Yakit 的包，而不是一句「见附件」。
   */
  #packetsOf(id, v) {
    const stored = this.listHttpEvidence(id, { vuln_id: v.id })
    if (stored.length > 0) return stored
    return parseHttpPackets(v.evidence || '', { base: v.target || '' }).map((p) => ({
      id: null,
      vuln_id: v.id,
      label: p.label || (p.method + ' ' + (p.path || '')).trim(),
      method: p.method,
      url: p.url || p.path || '',
      status: p.status,
      request: p.request,
      response: p.response,
      note: '由证据原文整理',
      captured_by: 'evidence-parse',
      captured_at: v.found_at || null,
    }))
  }

  /* ---------- 攻击链 ---------- */

  /**
   * 写一步攻击链。报告里的「这一步怎么来的」全靠它：tool 是命令原文、result 是回显。
   */
  addChainStep(id, s = {}) {
    const db = this.db(id)
    const next = (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM attack_step').get() || { n: 1 }).n
    const seq = s.seq ?? next
    const legacyStage = s.stage ?? 'other'
    /* 只有这 5 个阶段 code 会被攻击链页面分桶；其它值（含已废弃的 external/foothold/tunnel/privilege）
       写了等于步骤不落在任何阶段，所以退回按 stage 入参兜底，并显式告警。 */
    let stageWarning = null
    let stageCode
    if (typeof s.stage_code === 'string' && s.stage_code.trim() !== '') {
      const wanted = s.stage_code.trim()
      if (VALID_STAGE_CODES.includes(wanted)) {
        stageCode = wanted
      } else {
        stageCode = STAGE_ALIASES[legacyStage] ?? 'recon'
        stageWarning = '无效的 stage_code="' + wanted + '"（已忽略）：只接受 ' + VALID_STAGE_CODES.join('/')
          + '；本步按 stage 兜底落到 ' + stageCode + '。'
      }
    } else {
      stageCode = STAGE_ALIASES[legacyStage] ?? 'recon'
    }
    const result = db.prepare(`INSERT INTO attack_step(seq, stage, stage_code, title, detail, asset_id, vuln_id, access_id, evidence_ref, tool, agent, result, recorded_by, recorded_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      seq, legacyStage, stageCode, s.title ?? '', s.detail ?? null,
      s.asset_id ?? null, s.vuln_id ?? null, s.access_id ?? null, s.evidence_ref ?? null,
      s.tool ?? null, s.agent ?? null, s.result ?? null,
      s.recorded_by ?? null, nowIso(),
    )
    const stepId = Number(result.lastInsertRowid)
    /* 工具使用自动登记：写步骤就算用过，不需要模型额外调工具 */
    if (s.tool && String(s.tool).trim() !== '') {
      try { this.toolObserve(id, String(s.tool).trim(), 'executable', s.recorded_by ?? s.agent ?? null) } catch { /* 登记失败不影响步骤 */ }
    }
    return { id: stepId, seq: seq, stage_code: stageCode, stage_hint: stageWarning }
  }

  listChain(id) {
    return this.db(id).prepare(`SELECT s.*, a.ip AS asset_ip, v.title AS vuln_title, v.severity AS vuln_severity, v.cve AS vuln_cve
      FROM attack_step s
      LEFT JOIN asset a ON a.id = s.asset_id
      LEFT JOIN vuln v ON v.id = s.vuln_id
      ORDER BY s.seq, s.id`).all()
  }

  /* ---------- 攻击文件（只收录实际生效的脚本/POC/EXP） ---------- */

  /* ------------------------------------------------------------------ 证据截图 */
  /** 截图落盘目录：`<靶标目录>/shots`。与 attack-files 平级，方便整包拷贝交付。 */
  shotsDirOf(id) { return join(this.dirOf(id), 'shots') }

  /**
   * 登记一张证据截图（把图片拷进靶标目录，库里只存文件名与元数据）。
   *
   * 为什么必须显式区分 kind：
   *   · `screenshot` —— 现场截图，可以直接当验收材料；
   *   · `card`       —— 由当日记录生成的"证据摘录卡"，**不是现场截图**。
   *   两者混在一起，验收人会把生成的卡当成现场证据 —— 这是最不能出的事，
   *   所以库里存 kind、面板与报告都按它标不同颜色与文案。
   *
   * @param id - 靶标 id。
   * @param shot - `{ path | data_base64, label, note, kind, point_code, hit_id, asset_id, target, source_ref, captured_at, agent }`
   */
  addShot(id, shot = {}) {
    const db = this.db(id)
    const dir = this.shotsDirOf(id)
    mkdirSync(dir, { recursive: true })
    const kind = shot.kind === 'card' ? 'card' : 'screenshot'
    /* 文件名：显式给就用给的（去路径分隔符），否则按 时间-漏洞-序号 生成 */
    const ext = (() => {
      const src = String(shot.path || '')
      const m = /\.([A-Za-z0-9]{2,5})$/.exec(src)
      return m === null ? 'png' : m[1].toLowerCase()
    })()
    const stamp = String(shot.captured_at || new Date().toISOString()).replace(/[-:T]/g, '').slice(0, 14)
    const slug = String(shot.point_code || 'shot').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'shot'
    let file = String(shot.file || '').trim().replace(/[/\\]/g, '-')
    if (file === '') {
      let n = 1
      do { file = stamp + '-' + slug + '-' + String(n).padStart(2, '0') + '.' + ext; n += 1 }
      while (existsSync(join(dir, file)))
    }
    const dest = assertPathWithin(join(dir, file), [dir])
    let buf = null
    if (typeof shot.data_base64 === 'string' && shot.data_base64.trim() !== '') {
      buf = Buffer.from(shot.data_base64.replace(/^data:[^,]+,/, ''), 'base64')
    } else if (typeof shot.path === 'string' && shot.path.trim() !== '') {
      const src = isAbsolute(shot.path) ? shot.path : join(this.dirOf(id), shot.path)
      if (!existsSync(src)) throw new Error('shot source not found: ' + shot.path)
      buf = readFileSync(src)
    } else {
      throw new Error('shot path or data_base64 required')
    }
    if (buf.length === 0) throw new Error('shot file is empty')
    writeFileSync(dest, buf)
    const mime = /^\x89PNG/.test(buf.slice(0, 4).toString('latin1')) ? 'image/png'
      : (buf.slice(0, 2).toString('latin1') === '\xff\xd8' ? 'image/jpeg'
        : (buf.slice(0, 4).toString('latin1') === 'RIFF' ? 'image/webp' : 'application/octet-stream'))
    const dim = pngSize(buf)
    const now = nowIso()
    const cur = db.prepare(`INSERT INTO shot (asset_id, vuln_id, target, label, note,
        file, kind, mime, bytes, width, height, sha256, source_ref, captured_at, found_by_agent, agent, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      shot.asset_id === undefined || shot.asset_id === null ? null : Number(shot.asset_id),
      shot.vuln_id === undefined || shot.vuln_id === null ? null : Number(shot.vuln_id),
      String(shot.target || '').trim() || null,
      String(shot.label || '').trim() || null,
      String(shot.note || '').trim() || null,
      file, kind, mime, buf.length, dim.width, dim.height,
      createHash('sha256').update(buf).digest('hex'),
      String(shot.source_ref || shot.path || '').trim() || null,
      String(shot.captured_at || now).trim(),
      String(shot.agent || '').trim() || null,
      String(shot.agent || '').trim() || null,
      now,
    )
    return { ok: true, id: Number(cur.lastInsertRowid), file: file, kind: kind, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') }
  }

  /** 证据截图列表（可按资产 / 漏洞过滤）。 */
  listShots(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    for (const [col, key] of [['asset_id', 'asset_id'], ['vuln_id', 'vuln_id']]) {
      if (f[key] !== undefined && f[key] !== null && String(f[key]) !== '') {
        where.push('s.' + col + ' = ?')
        args.push(Number(f[key]))
      }
    }
    const sql = `SELECT s.*
      FROM shot s
      ${where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY s.captured_at, s.id LIMIT ?`
    const items = db.prepare(sql).all(...args, Math.min(Number(f.limit) || 500, 2000))
    return { ok: true, items: items.map((x) => Object.assign({}, x, { url: this.shotUrlOf(id, x) })), total: items.length }
  }

  /** 截图的可访问引用：面板/报告里贴的就是它（相对靶标目录）。 */
  shotUrlOf(id, shot) { return 'shots/' + shot.file }

  /** 删除一张截图（连同磁盘文件）。 */
  deleteShot(id, shotId) {
    const db = this.db(id)
    const row = db.prepare('SELECT * FROM shot WHERE id = ?').get(Number(shotId))
    if (row === undefined) throw new Error('shot not found: ' + shotId)
    try {
      const p = assertPathWithin(join(this.shotsDirOf(id), row.file), [this.shotsDirOf(id)])
      if (existsSync(p)) rmSync(p, { force: true })
    } catch { /* 文件不在就当已删 */ }
    db.prepare('DELETE FROM shot WHERE id = ?').run(Number(shotId))
    return { ok: true, id: Number(shotId) }
  }

  /**
   * 读一张截图的字节（面板用 `<img src="data:...">` 显示）。
   * 走 base64 而不是新开静态路由：这条 HTTP 桥已经做了同源校验，
   * 再开一个能按文件名读任意路径的静态入口，等于绕开校验读靶标目录。
   */
  readShot(id, shotId) {
    const db = this.db(id)
    const row = db.prepare('SELECT * FROM shot WHERE id = ?').get(Number(shotId))
    if (row === undefined) throw new Error('shot not found: ' + shotId)
    const p = assertPathWithin(join(this.shotsDirOf(id), row.file), [this.shotsDirOf(id)])
    if (!existsSync(p)) throw new Error('shot file missing on disk: ' + row.file)
    const buf = readFileSync(p)
    return { ok: true, id: Number(row.id), mime: row.mime || 'image/png', bytes: buf.length, base64: buf.toString('base64') }
  }

  /** 攻击文件根目录：<靶标>/attack-files/<目标>/… */
  attackFilesDirOf(id) { return join(this.dirOf(id), 'attack-files') }

  /**
   * 保存一个攻击文件到「目标文件夹」并登记。evidence 必填——只收录实际生效的东西。
   * @param id - 靶标 id。
   * @param f - `{ target, name, kind, content|path, description, evidence, asset_id?, vuln_id?, created_by? }`
   */
  addAttackFile(id, f = {}) {
    const db = this.db(id)
    const target = String(f.target || '').trim()
    if (target === '') throw new Error('attack file target required（IP / URL / C 段）')
    const name = String(f.name || '').trim().replace(/[/\\]/g, '-')
    if (name === '') throw new Error('attack file name required')
    const evidence = String(f.evidence || '').trim()
    if (evidence === '') throw new Error('attack file evidence required：只收录实际生效的脚本/POC/EXP，请写明验证效果')
    const slug = slugTarget(target)
    const dir = join(this.attackFilesDirOf(id), slug)
    mkdirSync(dir, { recursive: true })
    /* target 为 `..`/`.` 时 slugTarget 会原样返回，join 之后就跑出 attack-files/ 了。
       写路径也过一遍根目录校验，保证文件一定落在本靶标目录内。 */
    const filePath = assertPathWithin(join(dir, name), [this.attackFilesDirOf(id)])
    if (typeof f.content === 'string' && f.content.length > 0) {
      writeFileSync(filePath, f.content, 'utf8')
    } else if (typeof f.path === 'string' && f.path.length > 0) {
      const src = isAbsolute(f.path) ? f.path : join(this.dirOf(id), f.path)
      if (!existsSync(src)) throw new Error('source path not found: ' + f.path)
      copyFileSync(src, filePath)
    } else {
      throw new Error('attack file content or path required')
    }
    const kind = ['poc', 'exp', 'script', 'wordlist', 'other'].includes(f.kind) ? f.kind : 'script'
    db.prepare(`INSERT INTO attack_file(target, target_kind, name, kind, path, description, evidence, asset_id, vuln_id, created_by, created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(target, name) DO UPDATE SET
        kind = excluded.kind, path = excluded.path, description = excluded.description,
        evidence = excluded.evidence, created_at = excluded.created_at`).run(
      target, f.target_kind ?? null, name, kind, filePath,
      f.description ?? null, evidence, f.asset_id ?? null, f.vuln_id ?? null,
      f.created_by ?? null, nowIso(),
    )
    return { target, name, kind, path: filePath }
  }

  listAttackFiles(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.target) { where.push('target = ?'); args.push(f.target) }
    if (f.kind) { where.push('kind = ?'); args.push(f.kind) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    return db.prepare(`SELECT * FROM attack_file ${clause} ORDER BY target, name`).all(...args)
  }

  /** 攻击文件按目标分组（每个 IP / URL / C 段一个文件夹）。 */
  attackFileTree(id) {
    const groups = new Map()
    for (const row of this.listAttackFiles(id, {})) {
      if (!groups.has(row.target)) groups.set(row.target, { target: row.target, folder: slugTarget(row.target), count: 0, files: [] })
      const g = groups.get(row.target)
      g.files.push(row)
      g.count++
    }
    return Array.from(groups.values()).sort((a, b) => b.count - a.count || a.target.localeCompare(b.target))
  }

  readAttackFile(id, fileId) {
    const row = this.db(id).prepare('SELECT * FROM attack_file WHERE id = ?').get(Number(fileId))
    if (row === undefined) return undefined
    let content = ''
    try {
      /* path 来自库列（智能体写过）：必须限定在本靶标目录内，否则面板会变成任意文件读取器 */
      const safe = assertPathWithin(row.path, [this.dirOf(id)])
      content = readFileSync(safe, 'utf8')
    } catch (error) {
      content = '（拒绝或读取失败：' + (error && error.message ? error.message : String(error)) + '）'
    }
    return { ...row, content }
  }

  /* ---------- 知识库：通用 POC / EXP（全局共享，跨靶标复用） ---------- */

  knowledgePath() { return join(this.root, 'knowledge.db') }

  /** 找本机 nuclei 模板目录（装了模板才有；找不到返回 undefined）。 */
  nucleiTemplatesDir() {
    /* 环境适配里手填/自动分配的路径优先（Windows 尤其依赖这一条） */
    try {
      const configured = nucleiTemplatesDirOf(loadPlatformConfig(this.root), this.root)
      if (configured) return configured
    } catch { /* 忽略配置读失败，继续默认探测 */ }
    const candidates = [
      join(this.root, 'toolkit', 'nuclei-templates'),
      join(homedir(), '.local', 'nuclei-templates'),
      join(homedir(), 'nuclei-templates'),
      '/usr/share/nuclei-templates',
      '/opt/nuclei-templates',
    ]
    return candidates.find((p) => existsSync(p))
  }

  #nucleiIndexPath() { return join(this.pocsDirOf(), '.nuclei-index.json') }

  /**
   * 模板索引（按需构建 + 落盘缓存）：13k 个 yaml 逐个解析太慢，所以只抽
   * path / name / severity / tags 这几个检索字段，构建一次后一直复用。
   */
  #nucleiIndex(force) {
    const dir = this.nucleiTemplatesDir()
    if (dir === undefined) return { dir: null, items: [] }
    const cachePath = this.#nucleiIndexPath()
    if (force !== true && existsSync(cachePath)) {
      try {
        const cached = JSON.parse(readFileSync(cachePath, 'utf8'))
        /* 目录没变、且缓存不超过 7 天就直接用 */
        const fresh = cached && cached.dir === dir && Array.isArray(cached.items)
          && (Date.now() - Number(cached.built_at || 0) < 7 * 24 * 3600 * 1000)
        if (fresh) return { dir, items: cached.items, cached: true }
      } catch { /* 缓存坏了就重建 */ }
    }
    const items = []
    const walk = (base, rel) => {
      let entries = []
      try { entries = readdirSync(join(base, rel), { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const next = rel === '' ? e.name : rel + '/' + e.name
        if (e.isDirectory()) { walk(base, next); continue }
        if (!/\.ya?ml$/i.test(e.name)) continue
        let head = ''
        try { head = readFileSync(join(base, next), 'utf8').slice(0, 2000) } catch { continue }
        const pick = (re) => { const m = re.exec(head); return m === null ? '' : String(m[1]).trim().replace(/^["']|["']$/g, '') }
        items.push([
          next,
          pick(/^\s*name:\s*(.+)$/m),
          pick(/^\s*severity:\s*(.+)$/m),
          pick(/^\s*tags:\s*(.+)$/m),
        ])
      }
    }
    walk(dir, '')
    try {
      mkdirSync(this.pocsDirOf(), { recursive: true })
      writeFileSync(cachePath, JSON.stringify({ built_at: Date.now(), dir, items }), 'utf8')
    } catch { /* 缓存写不进去不影响检索 */ }
    return { dir, items, cached: false }
  }

  /** 模板库概览（界面与智能体"先查现成的"都能用）：总数 + CVE 数 + 按归类分布。 */
  templateStats() {
    const { dir, items } = this.#nucleiIndex()
    const cve = items.filter((x) => /cve-\d{4}-\d+/i.test(x[0])).length
    return { dir: dir || null, total: items.length, cve, byCategory: templateCounts(items) }
  }

  /**
   * 在本机 nuclei 模板库里检索：CVE 编号按文件名就能命中，组件/关键字再匹配 name 与 tags；
   * category 可按归类过滤（面板点胶囊即走这条），offset 供翻页。
   * 这是"知识库里没有、但本机其实已有现成 POC"的那一层，先查它能省掉一轮互联网检索。
   */
  searchTemplates(q, limit = 40, offset = 0, category = '') {
    const { dir, items } = this.#nucleiIndex()
    if (dir === null) return { dir: null, total: 0, matched: 0, offset: 0, items: [], byCategory: [] }
    const byCategory = templateCounts(items)
    const raw = String(q || '').trim().toLowerCase()
    const want = String(category || '').trim()
    if (raw === '' && want === '') {
      return { dir, total: items.length, matched: items.length, offset: 0, items: [], byCategory }
    }
    const start = Math.max(0, Number(offset) || 0)
    const size = Math.max(1, Math.min(Number(limit) || 40, 200))
    const out = []
    let matched = 0
    for (const [path, name, severity, tags] of items) {
      const code = want === '' ? '' : guessTemplateCategory(path, name, tags)
      if (want !== '' && code !== want) continue
      if (raw !== '' && !(path + ' ' + name + ' ' + tags).toLowerCase().includes(raw)) continue
      matched += 1
      if (matched > start && out.length < size) {
        out.push({ path, name, severity, tags, category: code || guessTemplateCategory(path, name, tags) })
      }
    }
    return { dir, total: items.length, matched, offset: start, items: out, byCategory }
  }


  pocsDirOf() { return join(this.root, 'pocs') }

  /** 打开（必要时创建）全局知识库。与靶标库分开，跨靶标共享。 */
  kb() {
    if (this.kbHandle) return this.kbHandle
    mkdirSync(this.root, { recursive: true })
    mkdirSync(this.pocsDirOf(), { recursive: true })
    const handle = new DatabaseSync(this.knowledgePath())
    /* 同上：没有 FTS5 就不建 poc_fts，POC 检索退化成 LIKE（见 searchPocs） */
    handle.exec(HAS_FTS5 ? KNOWLEDGE_DDL + POC_FTS_DDL : KNOWLEDGE_DDL)
    migrateKnowledge(handle)
    this.kbHandle = handle
    return handle
  }

  #reindexPoc(db, pocId) {
    if (!HAS_FTS5) return   /* 无 FTS5 时不建索引表；POC 检索走 LIKE（见 searchPocs 的兜底） */
    db.prepare('DELETE FROM poc_fts WHERE poc_id = ?').run(String(pocId))
    const p = db.prepare('SELECT * FROM poc WHERE id = ?').get(pocId)
    if (!p) return
    db.prepare('INSERT INTO poc_fts(poc_id, title, cve, component, versions, tags, description, content) VALUES(?,?,?,?,?,?,?,?)')
      .run(String(p.id), p.title, p.cve || '', p.component || '', p.versions || '', p.tags || '', p.description || '', p.content || '')
  }

  /**
   * 落库一份通用 POC/EXP。同名（code）会合并刷新，便于"同一漏洞的新版本 POC"覆盖旧版。
   * @param p - `{ title, kind, cve, component, versions, severity, language, source, source_url,
   *               description, usage, content|path, verified, verified_note, tags, created_by }`
   */
  savePoc(p = {}) {
    const db = this.kb()
    const title = String(p.title || '').trim()
    if (title === '') throw new Error('poc.title required（写清是什么漏洞/组件的 POC）')
    const kind = POC_KINDS.includes(p.kind) ? p.kind : (String(p.kind || '').toLowerCase() === 'exp' ? 'exp' : 'poc')
    const source = POC_SOURCES.includes(p.source) ? p.source : 'self'
    /* code 会被当成目录名：必须净化。`code='../../escaped-poc'` 曾能把正文写到数据根目录之外
       （deletePoc 早有 startsWith 防护，写路径却漏了）。这里统一走 slugPoc 的净化规则。 */
    const rawCode = String(p.code || '').trim()
    const code = rawCode === '' ? slugPoc(title, p.cve) : rawCode.replace(/[^\w.\u4e00-\u9fa5-]+/g, '-').replace(/^[.-]+/, '')
    if (code === '') throw new Error('poc.code invalid（净化后为空，请用字母/数字/中文/短横线）')
    const dir = assertPathWithin(join(this.pocsDirOf(), code), [this.pocsDirOf()])
    mkdirSync(dir, { recursive: true })

    /* 正文：优先用传入 content，其次从 path 读；两者都没有则只登记元数据 */
    let content = typeof p.content === 'string' ? p.content : ''
    if (content === '' && typeof p.path === 'string' && p.path.length > 0) {
      const src = isAbsolute(p.path) ? p.path : join(this.pocsDirOf(), p.path)
      if (!existsSync(src)) throw new Error('poc content or existing path required: ' + p.path)
      content = readFileSync(src, 'utf8')
    }
    let filePath = null
    if (content !== '') {
      /* filename 也不能带路径分隔符，否则能从 code 目录里再跳出去 */
      const filename = String(p.filename || '').trim().replace(/[/\\]/g, '-') || defaultPocFilename(title, kind, p.language)
      filePath = assertPathWithin(join(dir, filename), [this.pocsDirOf()])
      writeFileSync(filePath, content, 'utf8')
    }
    const existing = db.prepare('SELECT * FROM poc WHERE code = ?').get(code)
    const verified = p.verified === undefined || p.verified === null
      ? (existing ? existing.verified : 0)
      : (p.verified ? 1 : 0)
    const now = nowIso()
    /* 归类：允许自定义值，但内置 code 之外一律归 other，避免面板出现一堆拼写变体 */
    const rawCategory = String(p.category || (existing ? existing.category : '') || '').trim()
    const category = rawCategory === ''
      ? 'other'
      : (POC_CATEGORIES.some((c) => c.code === rawCategory) ? rawCategory : 'other')
    db.prepare(`INSERT INTO poc(code, title, kind, category, cve, component, versions, severity, language, source, source_url,
        description, usage, content, path, verified, verified_note, hit_count, used_on, tags,
        engagement_id, engagement_name, asset_target, found_by_agent, created_by, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET
        title = excluded.title, kind = excluded.kind, category = excluded.category,
        cve = COALESCE(excluded.cve, poc.cve),
        component = COALESCE(excluded.component, poc.component), versions = COALESCE(excluded.versions, poc.versions),
        severity = COALESCE(excluded.severity, poc.severity), language = COALESCE(excluded.language, poc.language),
        source = excluded.source, source_url = COALESCE(excluded.source_url, poc.source_url),
        description = COALESCE(excluded.description, poc.description), usage = COALESCE(excluded.usage, poc.usage),
        content = CASE WHEN excluded.content <> '' THEN excluded.content ELSE poc.content END,
        path = COALESCE(excluded.path, poc.path),
        verified = excluded.verified, verified_note = COALESCE(excluded.verified_note, poc.verified_note),
        engagement_id = COALESCE(excluded.engagement_id, poc.engagement_id),
        engagement_name = COALESCE(excluded.engagement_name, poc.engagement_name),
        asset_target = COALESCE(excluded.asset_target, poc.asset_target),
        found_by_agent = COALESCE(excluded.found_by_agent, poc.found_by_agent),
        tags = COALESCE(excluded.tags, poc.tags), updated_at = excluded.updated_at`).run(
      code, title, kind, category, p.cve ?? null, p.component ?? null, p.versions ?? null, p.severity ?? null,
      p.language ?? null, source, p.source_url ?? null, p.description ?? null, p.usage ?? null,
      content, filePath, verified, p.verified_note ?? null,
      existing ? existing.hit_count : 0, existing ? existing.used_on : null, p.tags ?? null,
      p.engagement_id ?? null, p.engagement_name ?? null, p.asset_target ?? null, p.found_by_agent ?? null,
      p.created_by ?? null, existing ? existing.created_at : now, now,
    )
    const row = db.prepare('SELECT * FROM poc WHERE code = ?').get(code)
    this.#reindexPoc(db, row.id)
    return { poc: row, created: existing === undefined, path: filePath }
  }

  /**
   * 检索知识库：Nday/1day 动手前的第一步。
   * @param f - `{ q, cve, component, kind, language, source, verified, tag, limit }`
   */
  searchPocs(f = {}) {
    const db = this.kb()
    const where = []
    const args = []
    const q = String(f.q || f.query || '').trim()
    if (q !== '') {
      /* 全文优先（标题/编号/组件/版本/标签/描述/正文），命中不到再退化成 LIKE 子串匹配 */
      const match = q.split(/\s+/).filter(Boolean).map((t) => '"' + t.replace(/"/g, '') + '"').join(' AND ')
      let ids = []
      try {
        ids = db.prepare('SELECT poc_id FROM poc_fts WHERE poc_fts MATCH ? LIMIT 200').all(match).map((r) => Number(r.poc_id))
      } catch { ids = [] }
      if (ids.length === 0) {
        const like = '%' + q + '%'
        ids = db.prepare(`SELECT id FROM poc WHERE title LIKE ? OR cve LIKE ? OR component LIKE ?
          OR versions LIKE ? OR tags LIKE ? OR description LIKE ? OR content LIKE ? LIMIT 200`)
          .all(like, like, like, like, like, like, like).map((r) => r.id)
      }
      if (ids.length === 0) return []
      where.push(`id IN (${ids.map(() => '?').join(',')})`)
      args.push(...ids)
    }
    if (f.cve) { where.push('cve LIKE ?'); args.push('%' + String(f.cve) + '%') }
    if (f.component) { where.push('component LIKE ?'); args.push('%' + String(f.component) + '%') }
    if (f.kind) { where.push('kind = ?'); args.push(String(f.kind)) }
    /* 归类筛选：支持一次给多个（category=rce,tunnel） */
    if (f.category) {
      const list = String(f.category).split(',').map((x) => x.trim()).filter(Boolean)
      if (list.length > 1) { where.push(`COALESCE(NULLIF(category, ''), 'other') IN (${list.map(() => '?').join(',')})`); args.push(...list) }
      else if (list.length === 1) { where.push("COALESCE(NULLIF(category, ''), 'other') = ?"); args.push(list[0]) }
    }
    /* 来源溯源筛选：这条知识是在哪个靶标 / 哪台资产上发现并验证的 */
    if (f.engagement) {
      where.push('(engagement_id = ? OR engagement_name LIKE ?)')
      args.push(String(f.engagement), '%' + String(f.engagement) + '%')
    }
    if (f.asset_target) { where.push('asset_target LIKE ?'); args.push('%' + String(f.asset_target) + '%') }
    if (f.language) { where.push('language = ?'); args.push(String(f.language)) }
    if (f.source) { where.push('source = ?'); args.push(String(f.source)) }
    if (f.tag) { where.push('tags LIKE ?'); args.push('%' + String(f.tag) + '%') }
    if (f.verified === true || f.verified === 1) where.push('verified = 1')
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 1000)
    return db.prepare(`SELECT id, code, title, kind, category, cve, component, versions, severity, language, source, source_url,
        description, usage, path, verified, verified_note, hit_count, used_on, tags,
        engagement_id, engagement_name, asset_target, found_by_agent, created_by, created_at, updated_at,
        LENGTH(COALESCE(content, '')) AS content_bytes,
        CASE WHEN COALESCE(content, '') = '' THEN 0 ELSE 1 END AS has_content
      FROM poc ${clause} ORDER BY verified DESC, hit_count DESC, updated_at DESC, id DESC LIMIT ?`).all(...args, limit)
  }

  /** 取一条 POC 的完整内容（智能体要直接拿去用，所以连正文一起给）。 */
  getPoc(key) {
    const db = this.kb()
    const raw = String(key === undefined || key === null ? '' : key).trim()
    if (raw === '') return undefined
    const numeric = Number(raw)
    const row = Number.isFinite(numeric) && String(numeric) === raw
      ? db.prepare('SELECT * FROM poc WHERE id = ?').get(numeric)
      : db.prepare('SELECT * FROM poc WHERE code = ?').get(raw)
    if (row === undefined) return undefined
    let content = row.content || ''
    if (content === '' && row.path) {
      try {
        /* 同 readAttackFile：path 是库列，读之前限定在 pocs/ 内 */
        content = readFileSync(assertPathWithin(row.path, [this.pocsDirOf()]), 'utf8')
      } catch { content = '' }
    }
    return { ...row, content }
  }

  /** 标一条 POC 被用过（后续按复用次数排序，用得多的排前面）。 */
  markPocUsed(key, usedOn) {
    const db = this.kb()
    const row = this.getPoc(key)
    if (row === undefined) return { ok: false, error: 'poc not found: ' + key }
    db.prepare('UPDATE poc SET hit_count = COALESCE(hit_count, 0) + 1, used_on = ?, updated_at = ? WHERE id = ?')
      .run(usedOn ?? null, nowIso(), row.id)
    return { ok: true, id: row.id, code: row.code, hit_count: (row.hit_count || 0) + 1 }
  }

  /* ---------- lessons：跨靶标经验（复用 poc 表，kind='lesson'） ----------
     一条经验 = 「什么现象 → 什么判断」。键是技术栈（component/versions），不是靶标；
     component 留空表示通用经验。写入走 savePoc，读走 lessonList，不新增表。 */
  lessonSave(item = {}, ctx = {}) {
    const title = String(item.title || '').trim()
    if (title === '') throw new Error('lesson.title required（写清"什么现象 → 什么判断"）')
    const component = String(item.component || '').trim()
    const content = String(item.content || '').trim()
    if (content === '') throw new Error('lesson.content required（写清现象与判断，给下次同类栈直接照用）')
    const clean = (s) => String(s || '').replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    const dup = this.searchPocs({ q: title, kind: 'lesson', limit: 1 })
    const code = dup.length > 0 ? dup[0].code : 'lesson-' + (clean(component) || 'generic') + '-' + clean(title)
    return this.savePoc({
      code, title, kind: 'lesson',
      category: item.category || 'other',
      component: component || null,
      versions: item.versions || null,
      content,
      tags: item.tags || null,
      source: 'engagement',
      verified: 1,
      verified_note: item.evidence || null,
      engagement_id: ctx.engagement || item.engagement_id || null,
      engagement_name: ctx.engagement_name || item.engagement_name || null,
      asset_target: item.asset_target || null,
      found_by_agent: item.by || item.found_by_agent || null,
      created_by: item.by || item.created_by || null,
    })
  }

  /* 当前靶标已识别到的技术栈（service + fingerprint 的 product），用于匹配经验。 */
  lessonProducts(id) {
    let db
    try { db = this.db(id) } catch { return [] }
    const out = new Set()
    for (const sql of [
      "SELECT DISTINCT product FROM service WHERE COALESCE(product, '') <> '' LIMIT 200",
      "SELECT DISTINCT product FROM fingerprint WHERE COALESCE(product, '') <> '' LIMIT 200",
    ]) {
      try { for (const r of db.prepare(sql).all()) out.add(String(r.product).trim()) } catch { /* 表缺失时跳过 */ }
    }
    return [...out]
  }

  /* 取命中当前技术栈的经验：component 为空视为通用，最多 limit 条（默认 5，上限 10）。
     命中即累加 hit_count，便于后续按复用到得排序。 */
  lessonList(id, filter = {}) {
    const limit = Math.min(Math.max(Number(filter.limit) || 5, 1), 10)
    const products = (filter.products || this.lessonProducts(id))
      .map((p) => String(p || '').trim().toLowerCase()).filter(Boolean)
    const wantedCategories = new Set(
      (Array.isArray(filter.categories) ? filter.categories : (filter.category ? [filter.category] : []))
        .map((c) => String(c || '').trim()).filter(Boolean),
    )
    const excludedCategories = new Set(
      (Array.isArray(filter.exclude_categories) ? filter.exclude_categories : [])
        .map((c) => String(c || '').trim()).filter(Boolean),
    )
    let rows = []
    try {
      rows = this.kb().prepare(`SELECT id, code, title, category, component, versions, content, hit_count
        FROM poc WHERE kind = 'lesson' ORDER BY COALESCE(hit_count, 0) DESC, updated_at DESC LIMIT 200`).all()
    } catch { return [] }
    if (wantedCategories.size > 0) rows = rows.filter((r) => wantedCategories.has(String(r.category || '')))
    if (excludedCategories.size > 0) rows = rows.filter((r) => !excludedCategories.has(String(r.category || '')))
    const matched = rows.filter((r) => {
      const c = String(r.component || '').trim().toLowerCase()
      if (c === '') return true
      return products.some((p) => c.includes(p) || p.includes(c))
    })
    const picked = matched.slice(0, limit)
    if (picked.length > 0) {
      try {
        this.kb().prepare(`UPDATE poc SET hit_count = COALESCE(hit_count, 0) + 1, used_on = ?, updated_at = ?
          WHERE id IN (${picked.map(() => '?').join(',')})`).run(nowIso(), nowIso(), ...picked.map((r) => r.id))
      } catch { /* 计数失败不影响注入 */ }
    }
    return picked.map((r) => ({
      code: r.code, title: r.title, category: r.category,
      component: r.component || '', versions: r.versions || '',
      content: String(r.content || '').replace(/\s+/g, ' ').slice(0, 200),
    }))
  }

  /** 补验证结论：只有验证过的 POC 才算"可直接用"，界面上会标出来。 */
  updatePoc(key, patch = {}) {
    const db = this.kb()
    const row = this.getPoc(key)
    if (row === undefined) throw new Error('poc not found: ' + key)
    const next = {
      title: patch.title ?? row.title,
      kind: patch.kind ?? row.kind,
      category: patch.category ?? row.category,
      cve: patch.cve ?? row.cve,
      component: patch.component ?? row.component,
      versions: patch.versions ?? row.versions,
      severity: patch.severity ?? row.severity,
      language: patch.language ?? row.language,
      source: patch.source ?? row.source,
      source_url: patch.source_url ?? row.source_url,
      description: patch.description ?? row.description,
      usage: patch.usage ?? row.usage,
      verified: patch.verified === undefined || patch.verified === null ? row.verified : (patch.verified ? 1 : 0),
      verified_note: patch.verified_note ?? row.verified_note,
      tags: patch.tags ?? row.tags,
      engagement_id: patch.engagement_id ?? row.engagement_id,
      engagement_name: patch.engagement_name ?? row.engagement_name,
      asset_target: patch.asset_target ?? row.asset_target,
      found_by_agent: patch.found_by_agent ?? row.found_by_agent,
      content: typeof patch.content === 'string' && patch.content !== '' ? patch.content : row.content,
      path: row.path,
    }
    if (next.content !== row.content) {
      const filename = 'poc.txt'
      const dir = join(this.pocsDirOf(), row.code)
      mkdirSync(dir, { recursive: true })
      next.path = join(dir, row.path ? basename(row.path) : filename)
      writeFileSync(next.path, next.content || '', 'utf8')
    }
    db.prepare(`UPDATE poc SET title = ?, kind = ?, category = ?, cve = ?, component = ?, versions = ?, severity = ?, language = ?,
      source = ?, source_url = ?, description = ?, usage = ?, verified = ?, verified_note = ?, tags = ?,
      engagement_id = ?, engagement_name = ?, asset_target = ?, found_by_agent = ?, content = ?, path = ?, updated_at = ?
      WHERE id = ?`).run(
      next.title, next.kind, next.category, next.cve, next.component, next.versions, next.severity, next.language,
      next.source, next.source_url, next.description, next.usage, next.verified, next.verified_note,
      next.tags, next.engagement_id, next.engagement_name, next.asset_target, next.found_by_agent,
      next.content, next.path, nowIso(), row.id,
    )
    this.#reindexPoc(db, row.id)
    return this.getPoc(row.id)
  }

  deletePoc(key) {
    const db = this.kb()
    const row = this.getPoc(key)
    if (row === undefined) return { ok: false, error: 'poc not found: ' + key }
    db.prepare('DELETE FROM poc WHERE id = ?').run(row.id)
    if (HAS_FTS5) db.prepare('DELETE FROM poc_fts WHERE poc_id = ?').run(String(row.id))
    /* 连落盘目录一起删（只在 pocs/ 内按 code 精确删除；删不掉不影响数据一致性） */
    let removedFiles = 0
    try {
      const dir = join(this.pocsDirOf(), row.code)
      if (existsSync(dir) && dir.startsWith(this.pocsDirOf())) {
        removedFiles = readdirSync(dir).length
        rmSync(dir, { recursive: true, force: true })
      }
    } catch { /* 忽略 */ }
    return { ok: true, id: row.id, code: row.code, deleted: true, removed_files: removedFiles }
  }

  /** 知识库概览：界面顶部标签与智能体"先查库"时的一屏摘要。 */
  pocStats() {
    const db = this.kb()
    const one = (sql, ...args) => Object.values(db.prepare(sql).get(...args) || {})[0] ?? 0
    const byKind = db.prepare('SELECT COALESCE(kind, ?) AS kind, COUNT(*) AS n FROM poc GROUP BY kind ORDER BY n DESC').all('poc')
    const bySource = db.prepare('SELECT COALESCE(source, ?) AS source, COUNT(*) AS n FROM poc GROUP BY source ORDER BY n DESC').all('self')
    const topComponents = db.prepare(`SELECT component, COUNT(*) AS n FROM poc WHERE component IS NOT NULL AND component <> ''
      GROUP BY component ORDER BY n DESC, component LIMIT 12`).all()
    /* 归类：面板按它分组，智能体也知道"哪类武器已经攒了多少"。
       顺序按内置归类表走（不是按数量），这样面板分组稳定、不跳来跳去。 */
    const catRows = db.prepare("SELECT COALESCE(NULLIF(category, ''), 'other') AS category, COUNT(*) AS n, SUM(verified) AS verified FROM poc GROUP BY category").all()
    const catMap = new Map(catRows.map((r) => [r.category, r]))
    const byCategory = POC_CATEGORIES.map((c) => {
      const row = catMap.get(c.code)
      return { code: c.code, name: c.name, hint: c.hint, n: row ? row.n : 0, verified: row ? (row.verified || 0) : 0 }
    })
    /* 内置表之外的归类（用户自定义）也列出来，别让它们凭空消失 */
    for (const [code, row] of catMap) {
      if (POC_CATEGORIES.some((c) => c.code === code)) continue
      byCategory.push({ code, name: pocCategoryName(code), hint: '', n: row.n, verified: row.verified || 0 })
    }
    /* 来源靶标：每条知识是在哪个靶标上发现/验证的（每靶标计数 + 最近建立时间） */
    const byEngagement = db.prepare(`SELECT COALESCE(NULLIF(engagement_name, ''), NULLIF(engagement_id, ''), '(未标注来源靶标)') AS engagement,
        COUNT(*) AS n, MAX(created_at) AS latest FROM poc GROUP BY engagement ORDER BY n DESC, latest DESC LIMIT 30`).all()
    /* 发现资产：Top 资产（同一条经验往往落在一批资产上） */
    const topAssets = db.prepare(`SELECT asset_target, COUNT(*) AS n FROM poc WHERE COALESCE(asset_target, '') <> ''
      GROUP BY asset_target ORDER BY n DESC, asset_target LIMIT 15`).all()
    return {
      total: one('SELECT COUNT(*) FROM poc'),
      verified: one('SELECT COUNT(*) FROM poc WHERE verified = 1'),
      withContent: one("SELECT COUNT(*) FROM poc WHERE COALESCE(content, '') <> ''"),
      reused: one('SELECT COALESCE(SUM(hit_count), 0) FROM poc'),
      /* 没标归类的条目数：面板会提示"还有 N 条未归类" */
      uncategorized: one("SELECT COUNT(*) FROM poc WHERE COALESCE(NULLIF(category, ''), 'other') = 'other'"),
      earliest: one('SELECT MIN(created_at) FROM poc'),
      latest: one('SELECT MAX(created_at) FROM poc'),
      byKind, bySource, byCategory, byEngagement, topAssets, topComponents,
      categories: POC_CATEGORIES,
      dbPath: this.knowledgePath(),
    }
  }

  /**
   * 按目标分组的成果报告：每个 IP / URL / C 段一份，供界面展开收起。
   * 收录口径与 report() 一致（已验证/已利用且中危以上）。
   */
  reportTargets(id, options = {}) {
    const meta = readMeta(this.metaPathOf(id)) || {}
    const includeAll = options.all === true
    const allVulns = this.listVulns(id, { limit: 2000, with_http_evidence: false }).items
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
    const isResult = (v) => v.status === 'confirmed' || v.status === 'exploited'
    const isReal = (v) => v.severity === 'critical' || v.severity === 'high' || v.severity === 'medium'
    const vulns = (includeAll ? allVulns : allVulns.filter((v) => isResult(v) && isReal(v)))
      .slice().sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9))
    const chain = this.listChain(id)
    const creds = this.listCredentials(id, {})
    const access = this.listAccess(id, {})
    const files = this.listAttackFiles(id, {})

    const targets = new Map()
    const ensure = (key) => {
      if (!targets.has(key)) {
        targets.set(key, { key, label: key, kind: /^\d{1,3}(\.\d{1,3}){3}$/.test(key) ? 'ip' : 'host', segment: '', vulns: [], chain: [], access: [], creds: [], files: [] })
      }
      return targets.get(key)
    }
    const assetIpOf = (assetId) => {
      if (assetId === null || assetId === undefined) return undefined
      const asset = this.getAsset(id, assetId)
      return asset === undefined ? undefined : asset.ip
    }
    for (const v of vulns) {
      const key = v.asset_ip || (v.target ? slugTarget(v.target) : '未归属目标')
      const g = ensure(key)
      g.vulns.push(v)
      if (g.segment === '' && v.segment_cidr) g.segment = v.segment_cidr
    }
    for (const a of access) {
      const key = assetIpOf(a.asset_id) || slugTarget(a.host)
      const g = ensure(key)
      g.access.push(a)
      if (g.segment === '') { const asset = a.asset_id === null || a.asset_id === undefined ? undefined : this.getAsset(id, a.asset_id); if (asset && asset.segment_cidr) g.segment = asset.segment_cidr }
    }
    for (const c of creds) ensure(assetIpOf(c.asset_id) || slugTarget(c.host)).creds.push(c)
    for (const f of files) ensure(assetIpOf(f.asset_id) || slugTarget(f.target)).files.push(f)
    for (const st of chain) if (st.asset_ip) ensure(st.asset_ip).chain.push(st)

    const renderVuln = (v) => {
      const out = []
      out.push(`#### [${(v.severity || 'info').toUpperCase()}] ${v.cve ? v.cve + ' — ' : ''}${v.title || ''}`, '')
      out.push(`- 目标：${v.target || '—'}`)
      out.push(`- 状态：${v.status === 'exploited' ? '已成功利用' : '已验证'} · 置信度：${v.confidence === null || v.confidence === undefined ? '—' : v.confidence} · 发现方式：${v.source || '—'}`)
      out.push(`- 危害与证据：${v.evidence || '—'}`)
      const evidence = this.#packetsOf(id, v)
      if (evidence.length) {
        out.push('', '**复现请求（可直接粘贴进 Burp Suite / Yakit）**：', '')
        for (const e of evidence) {
          out.push(`*${e.label || e.method + ' ' + (e.url || '')}*`, '')
          if (e.request) out.push('```http', e.request.replace(/\r/g, '').trim(), '```', '')
          if (e.response) out.push('响应摘要：', '```http', String(e.response).replace(/\r/g, '').trim().slice(0, 2000), '```', '')
        }
      }
      out.push('')
      return out
    }

    const groups = new Map()
    const list = []
    for (const g of targets.values()) {
      const lines = []
      lines.push(`## ${g.label}${g.segment ? '（' + g.segment + '）' : ''}`, '')
      const bySeverity = { critical: 0, high: 0, medium: 0 }
      for (const v of g.vulns) bySeverity[v.severity] = (bySeverity[v.severity] || 0) + 1
      lines.push(`- 成果：漏洞 ${g.vulns.length} 个（严重 ${bySeverity.critical} · 高危 ${bySeverity.high} · 中危 ${bySeverity.medium}）· 已控 ${g.access.length} · 凭据 ${g.creds.length} · 攻击文件 ${g.files.length}`, '')
      if (g.vulns.length) { lines.push('### 成果漏洞', ''); for (const v of g.vulns) lines.push(...renderVuln(v)) }
      if (g.access.length) {
        lines.push('### 已获得权限', '')
        for (const a of g.access) lines.push(`- ${a.host} · ${a.username || '—'} · ${a.method || '—'} · ${a.privilege || '—'} · ${a.session_ref || ''}`)
        lines.push('')
      }
      if (g.creds.length) {
        lines.push('### 凭据', '')
        for (const c of g.creds) lines.push(`- ${c.host} · ${c.username || '—'} · ${c.secret_type || '—'} · ${c.privilege || '—'} · ${c.secret_ref || ''}`)
        lines.push('')
      }
      if (g.files.length) {
        lines.push('### 攻击文件', '')
        for (const f of g.files) lines.push(`- \`${f.name}\`（${f.kind}）：${f.description || '—'}｜效果：${f.evidence}｜路径：${f.path}`)
        lines.push('')
      }
      if (g.chain.length) {
        lines.push('### 攻击链', '')
        for (const st of g.chain) lines.push(`${st.seq}. [${st.stage}] ${st.title}${st.detail ? ' — ' + st.detail : ''}`)
        lines.push('')
      }
      const entry = {
        key: g.key, label: g.label, kind: g.kind, segment: g.segment || '未归属',
        stats: { vulns: g.vulns.length, bySeverity, accesses: g.access.length, credentials: g.creds.length, files: g.files.length, chainSteps: g.chain.length },
        markdown: lines.join('\n'),
      }
      list.push(entry)
      const cidr = entry.segment
      if (!groups.has(cidr)) groups.set(cidr, { cidr, targets: [] })
      groups.get(cidr).targets.push(entry)
    }
    const grouped = Array.from(groups.values())
      .map((g) => ({ cidr: g.cidr, targets: g.targets.slice().sort((a, b) => b.stats.vulns - a.stats.vulns || a.label.localeCompare(b.label)) }))
      .sort((a, b) => a.cidr.localeCompare(b.cidr))
    return {
      generated_at: nowIso(),
      engagement: { id, name: meta.target_name || id, scope: meta.scope_cidrs || [] },
      groups: grouped,
      targets: list,
      totals: {
        targets: list.length,
        vulns: vulns.length,
        accesses: access.length,
        credentials: creds.length,
        files: files.length,
        filteredOut: allVulns.length - vulns.length,
      },
    }
  }

  /* ---------- 报告 ---------- */

  /**
   * ISO 时间戳 → 报告里给人看的本地时间（2026-10-28 16:36）。
   * 报告是交付物，直接塞 `2026-10-28T08:36:05.456Z` 会显得很敷衍。
   * @param iso - ISO 字符串。
   * @returns {string}
   */
  #stampOf(iso) {
    const t = String(iso || '')
    const dt = new Date(t)
    if (Number.isNaN(dt.getTime())) return t || '—'
    const p = (n) => String(n).padStart(2, '0')
    return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate())
      + ' ' + p(dt.getHours()) + ':' + p(dt.getMinutes())
  }

  /**
   * 这条漏洞「能造成什么影响」：交付物里这是必填项，不能空着。
   * 智能体写过 gained 就用它（agent 最清楚拿到了什么），否则按标题关键词兜一句。
   * @param v - vuln 行。
   * @returns {string}
   */
  #impactOf(v) {
    return vulnImpactOf(v)
  }

  /**
   * 单个漏洞的修复建议：按类型给具体动作，不要写「请修复该漏洞」这种废话。
   * 有 CVE 时优先给版本升级口径，因为那是最先该做的事。
   * @param v - vuln 行。
   * @returns {string}
   */
  #adviceOf(v) {
    const t = String(v.title || '') + ' ' + String(v.evidence || '')
    const parts = []
    if (v.cve) parts.push(`升级到已修复 ${v.cve} 的版本；无法立即升级时按厂商公告做临时缓解（关闭受影响功能/加访问控制）`)
    if (/命令执行|rce|代码执行|反序列化/i.test(t)) parts.push('限制应用的命令执行与出网权限，对相关参数做白名单校验，补 WAF 规则')
    if (/sql\s*注入|注入/i.test(t)) parts.push('改用参数化查询，数据库账号按最小权限授予，关闭详细错误回显')
    if (/上传/i.test(t)) parts.push('上传目录禁止执行脚本，校验文件类型与内容，Web 进程以最小权限运行')
    if (/越权|未授权|认证绕过|绕过/i.test(t)) parts.push('对每个接口在服务端做身份与对象级权限校验，不要依赖前端隐藏')
    if (/泄露|暴露|敏感/i.test(t)) parts.push('移除响应与配置中的敏感字段，相关密钥立即轮换并纳入密钥管理')
    if (/xss|跨站/i.test(t)) parts.push('对输出做上下文相关编码，配置 CSP，Cookie 加 HttpOnly')
    if (/弱口令|默认口令|暴力/i.test(t)) parts.push('改为强口令并启用多因子，管理面不对公网暴露，加登录失败锁定')
    if (parts.length === 0) parts.push('按该漏洞类型完成修复，并在同环境回归验证；修复前先收敛该接口的对外暴露面')
    return parts.join('；') + '。'
  }

  /**
   * 交付自检清单：报告会收录哪些漏洞，以及每条的「料」齐不齐。
   *
   * 收录口径和 report() 完全一致（confirmed/exploited 且 中危以上），
   * 这样页面上看到的条数就等于报告里的条数，不会出现「这里 5 条、报告 3 条」。
   *
   * 每条给出：有没有复现请求（仅 HTTP 目标要求）、有没有证据截图、有没有写影响，
   * 交付前缺哪样补哪样 —— 这就是 SRC 报告能不能过的关键。
   *
   * @param id - 靶标 id。
   * @returns `{ items, stats, at }`
   */
  deliverables(id) {
    const all = this.listVulns(id, { limit: 2000, with_http_evidence: false }).items
    const isResult = (v) => v.status === 'confirmed' || v.status === 'exploited'
    const isReal = (v) => v.severity === 'critical' || v.severity === 'high' || v.severity === 'medium'
    const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
    const picked = all.filter((v) => isResult(v) && isReal(v))
      .sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9))

    const items = picked.map((v) => {
      let http = 0
      let shots = 0
      try { http = this.#packetsOf(id, v).length } catch { http = 0 }
      try { shots = this.listShots(id, { vuln_id: v.id }).items.length } catch { shots = 0 }
      const evidence = String(v.evidence || '').trim() !== ''
      const impact = String(v.gained || '').trim() !== '' || evidence
      const httpRequired = isHttpTarget(v.target)
      return {
        id: v.id, title: v.title || '', severity: v.severity || 'info',
        cve: v.cve || '', asset_ip: v.asset_ip || '', target: v.target || '',
        status: v.status || '', found_at: v.found_at || null,
        evidence: evidence, impact: impact, http: http, shots: shots,
        http_required: httpRequired,
        ready: evidence && shots > 0 && (!httpRequired || http > 0),
      }
    })

    const bySeverity = { critical: 0, high: 0, medium: 0 }
    let ready = 0
    let noHttp = 0
    let noShots = 0
    let noEvidence = 0
    for (const it of items) {
      bySeverity[it.severity] = (bySeverity[it.severity] || 0) + 1
      if (it.ready) ready += 1
      if (it.http_required && it.http === 0) noHttp += 1
      if (it.shots === 0) noShots += 1
      if (!it.evidence) noEvidence += 1
    }

    return {
      items,
      stats: {
        total: items.length,
        ready,
        bySeverity,
        noHttp,
        noShots,
        noEvidence,
        filteredOut: all.length - items.length,
      },
      at: nowIso(),
    }
  }

  /**
   * 报告文件路径：`<靶标目录>/reports/report.md`。
   * 存文件而不是存数据库，是为了让 AI（或人）能直接读写它 ——
   * 「让 AI 润色」就是读这个文件、改完覆盖回去。
   * @param id - 靶标 id。
   * @returns {string}
   */
  reportPathOf(id) { return join(this.dirOf(id), 'reports', 'report.md') }

  /**
   * 只读报告的轻量状态（概览的「下一步」用它，不需要算 deliverables）。
   * @param id - 靶标 id。
   * @returns `{ need_report, report_at, chars }`
   */
  readReportMeta(id) {
    const meta = readMeta(this.metaPathOf(id)) || {}
    const p = this.reportPathOf(id)
    let chars = 0
    try { if (existsSync(p)) chars = String(readFileSync(p, 'utf8')).length } catch { chars = 0 }
    return { need_report: meta.need_report || '', report_at: meta.report_at || '', chars }
  }

  /**
   * 报告状态：只回答「生成了没有、要不要」，不做任何生成。
   *
   * 报告要花钱（AI 润色吃 token）、多数项目也不需要，所以默认是「没有报告」。
   * 面板据此显示聚合视图，而不是一进来就渲染一份文档。
   *
   * @param id - 靶标 id。
   * @returns `{ need_report, has_report, report_at, chars, total, ready }`
   */
  reportState(id) {
    const meta = readMeta(this.metaPathOf(id)) || {}
    const p = this.reportPathOf(id)
    let chars = 0
    /* 字符数按「人看到的字数」算，不是文件字节数：中文一个字 3 字节，按字节会虚三倍。 */
    try { if (existsSync(p)) chars = String(readFileSync(p, 'utf8')).length } catch { chars = 0 }
    const d = this.deliverables(id)
    const pendingReview = this.vulnStats(id).pendingReview || 0
    return {
      need_report: String(meta.need_report || '') === 'true',
      has_report: chars > 0,
      report_at: meta.report_at || '',
      report_title: meta.report_title || '',
      report_draft: String(meta.report_draft || '') === 'true',
      pending_review: pendingReview,
      path: p,
      chars,
      total: d.stats.total,
      ready: d.stats.ready,
      no_http: d.stats.noHttp,
      no_shots: d.stats.noShots,
      at: nowIso(),
    }
  }

  /**
   * 生成报告并落盘。**只在用户明确点「生成报告」时调用**。
   *
   * 这里生成的是结构化草稿（漏洞 / 复现请求 / 影响 / 修复建议），不经过模型，
   * 所以不消耗 token；想要文采再让 AI 读这个文件改写。
   *
   * @param id - 靶标 id。
   * @param options - `{ title }` 覆盖标题。
   * @returns `{ markdown, at, title, stats }`
   */
  reportGenerate(id, options = {}) {
    const title = String(options.title || '渗透测试报告')
    const pending = this.vulnStats(id).pendingReview || 0
    if (pending > 0 && options.draft !== true) {
      return {
        ok: false,
        needsReview: true,
        pendingReview: pending,
        error: `还有 ${pending} 条漏洞待人工复核；确认或判误报后再出正式报告，或带 draft:true 只出草稿`,
      }
    }
    /* 报告前先关门：没测的资产、没覆盖的发现、exploited 没证据，都不算可交付。
       仍允许显式 force/draft，避免把人卡死在最后一步。 */
    if (options.force !== true && options.draft !== true) {
      const release = this.releaseGaps(id)
      if (release.gaps.length > 0) {
        const countOf = (code) => release.gaps.find((g) => g.code === code)?.count || 0
        return {
          ok: false,
          needsCloseout: true,
          untestedAssets: release.untested,
          matrixGaps: countOf('matrix'),
          noEvidence: release.evidence.noEvidence.map((v) => ({ id: v.id, title: v.title })),
          noHttp: release.evidence.noHttp.map((v) => ({ id: v.id, title: v.title })),
          evidenceMismatch: release.evidence.mismatched.map((v) => ({ id: v.id, title: v.title })),
          openHypotheses: countOf('hypothesis'),
          chainGaps: countOf('chainTool') + countOf('chainResult'),
          tunnelGaps: countOf('tunnel'),
          webshellGaps: countOf('webshell'),
          gaps: release.gaps,
          error: '收口未清零：' + release.gaps.map((g) => g.message).join('；') + '；先跑 closeout 补齐，或显式 force:true',
        }
      }
    }
    const r = this.report(id, { title })
    const p = this.reportPathOf(id)
    mkdirSync(dirname(p), { recursive: true })
    const banner = pending > 0
      ? `> **草稿**：还有 ${pending} 条漏洞待人工复核。确认 / 判误报后重新生成，才算正式报告。\n\n`
      : ''
    writeFileSync(p, banner + r.markdown, 'utf8')
    const meta = readMeta(this.metaPathOf(id)) || {}
    const at = nowIso()
    meta.report_at = at
    meta.report_title = title
    meta.report_draft = pending > 0 ? 'true' : 'false'
    writeMeta(this.metaPathOf(id), meta)
    return { markdown: banner + r.markdown, at, title, stats: r.stats, draft: pending > 0, pendingReview: pending }
  }

  /**
   * 读当前报告文件（可能被 AI 改写覆盖过）。
   * @param id - 靶标 id。
   * @returns `{ markdown, at, title }`
   */
  reportRead(id) {
    const p = this.reportPathOf(id)
    const meta = readMeta(this.metaPathOf(id)) || {}
    let markdown = ''
    try { if (existsSync(p)) markdown = readFileSync(p, 'utf8') } catch { markdown = '' }
    return { markdown, at: meta.report_at || '', title: meta.report_title || '渗透测试报告', path: p }
  }

  /**
   * 写项目级报告开关（「这个项目要不要交付报告」）。
   * 只动元数据，不生成任何东西。
   *
   * @param id - 靶标 id。
   * @param patch - `{ needReport?: boolean }`
   * @returns 同 reportState。
   */
  reportMark(id, patch = {}) {
    const meta = readMeta(this.metaPathOf(id)) || {}
    if (patch.needReport !== undefined) meta.need_report = patch.needReport ? 'true' : 'false'
    writeMeta(this.metaPathOf(id), meta)
    return this.reportState(id)
  }

  /**
   * 生成 Markdown 交付报告。
   *
   * 只交付「成果漏洞」：状态为 confirmed / exploited，且严重级为 critical / high / medium。
   * 待验证（candidate）、误报（false-positive）、低危与信息级（low/info）都不进报告——
   * 它们是过程噪声（水洞）。信息收集的资产清单也不进报告（在资产测绘页面看）。
   * 报告保留：漏洞详情（含可粘贴进 Burp/Yakit 的原始请求、影响、修复建议、证据截图）、
   * 攻击链（内网突破成果）、已获得权限与凭据、整体修复建议。
   *
   * 注意：**不含任何分值**。分值/计分口径属于护网行动，由 scoreReport 负责；
   * 正常渗透测试交付的是 SRC 口径的报告（漏洞 + 复现 + 影响 + 修复）。
   *
   * @param id - 靶标 id。
   * @param options - `{ all: true }` 输出全部漏洞（自查用）；`{ title }` 覆盖报告标题。
   */
  report(id, options = {}) {
    const meta = readMeta(this.metaPathOf(id)) || {}
    const includeAll = options.all === true
    const chain = this.listChain(id)
    const creds = this.listCredentials(id, {})
    const access = this.listAccess(id, {})
    const allVulns = this.listVulns(id, { limit: 2000, with_http_evidence: false }).items
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
    const isResult = (v) => v.status === 'confirmed' || v.status === 'exploited'
    const isReal = (v) => v.severity === 'critical' || v.severity === 'high' || v.severity === 'medium'
    const vulns = (includeAll ? allVulns : allVulns.filter((v) => isResult(v) && isReal(v)))
      .slice()
      .sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9))
    const filteredOut = allVulns.length - vulns.length

    const lines = []
    const push = (...xs) => lines.push(...xs)
    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
    for (const v of vulns) bySeverity[v.severity] = (bySeverity[v.severity] || 0) + 1
    const exploited = vulns.filter((v) => v.status === 'exploited').length

    push(`# ${options.title || '渗透测试报告'} — ${meta.target_name || id}`, '')
    push(`- 生成时间：${this.#stampOf(nowIso())}`)
    push(`- 测试范围：${(meta.scope_cidrs || []).join(', ') || '（未记录）'}`)
    push(`- 漏洞概览：可交付漏洞 ${vulns.length} 个（严重 ${bySeverity.critical} · 高危 ${bySeverity.high} · 中危 ${bySeverity.medium}）· 已成功利用 ${exploited} 个 · 已控制资产 ${access.length} 台 · 已获取凭据 ${creds.length} 条`)
    push('')

    push('## 一、漏洞详情', '')
    if (!vulns.length) {
      push('本次测试暂无可交付的漏洞（只收录已验证/已利用且中危及以上的漏洞）。', '')
    } else {
      for (const v of vulns) {
        push(`### [${(v.severity || 'info').toUpperCase()}] ${v.cve ? v.cve + ' — ' : ''}${v.title || ''}`, '')
        push(`- 目标：${v.target || '—'}`)
        push(`- 资产：${v.asset_ip || '—'}（${v.segment_cidr || '—'}）`)
        push(`- 状态：${v.status === 'exploited' ? '已成功利用' : '已验证'} · 置信度：${v.confidence === null || v.confidence === undefined ? '—' : v.confidence} · 发现方式：${v.source || '—'}`)
        push(`- 危害与证据：${v.evidence || '—'}`)
        /* 影响：优先用智能体写的 gained（"拿到什么"），没有就按等级/类型兜一句，
           不能空着 —— 交付物里"这个洞能造成什么影响"是必填项。 */
        const impact = String(v.gained || '').trim() || this.#impactOf(v)
        push(`- 影响：${impact}`)
        push(`- 修复建议：${this.#adviceOf(v)}`)
        /* 截图只引用路径：Markdown 里嵌 base64 会让报告没法读、也没法进版本库。 */
        const shots = this.listShots(id, { vuln_id: v.id })
        if (shots.items.length) {
          push(`- 证据截图：${shots.items.map((s) => `\`${s.url}\``).join('、')}`)
        }
        const evidence = this.#packetsOf(id, v)
        if (evidence.length) {
          push('', '**复现请求（可直接粘贴进 Burp Suite / Yakit）**：', '')
          for (const e of evidence) {
            push(`*${e.label || e.method + ' ' + (e.url || '')}*`, '')
            if (e.request) push('```http', e.request.replace(/\r/g, '').trim(), '```', '')
            if (e.response) push('响应摘要：', '```http', String(e.response).replace(/\r/g, '').trim().slice(0, 2000), '```', '')
          }
        }
        push('')
      }
    }

    push('## 二、攻击路径', '')
    if (chain.length) {
      for (const s of chain) {
        push(`${s.seq}. **[${s.stage}] ${s.title}**`)
        if (s.asset_ip) push(`   - 资产：${s.asset_ip}`)
        if (s.vuln_title || s.vuln_cve) push(`   - 漏洞：${s.vuln_cve ? s.vuln_cve + ' ' : ''}${s.vuln_title || ''}`)
        if (s.detail) push(`   - 说明：${s.detail}`)
        if (s.evidence_ref) push(`   - 证据：${s.evidence_ref}`)
      }
    } else push('（未记录攻击步骤）')
    push('')

    push('## 三、已获得权限与凭据', '')
    if (access.length) {
      push('| 主机 | 账号 | 方式 | 权限 | 证据 |', '| --- | --- | --- | --- | --- |')
      for (const a of access) push(`| ${a.host} | ${a.username || '—'} | ${a.method || '—'} | ${a.privilege || '—'} | ${a.session_ref || '—'} |`)
    } else push('（未获得可用访问）')
    push('')
    if (creds.length) {
      push('| 主机 | 账号 | 类型 | 权限 | 引用 |', '| --- | --- | --- | --- | --- |')
      for (const c of creds) push(`| ${c.host} | ${c.username || '—'} | ${c.secret_type || '—'} | ${c.privilege || '—'} | ${c.secret_ref || '—'} |`)
    } else push('（未获取凭据）')
    push('')

    push('## 四、整体修复建议', '')
    const advice = []
    if (vulns.some((v) => v.cve)) advice.push('1. 按上方 CVE 编号优先修补受影响组件，建立组件版本基线并纳入补丁管理。')
    if (access.some((a) => a.method === 'webshell' || a.method === 'rce' || a.method === 'upload')) advice.push('2. 收紧文件上传与命令执行面：上传目录禁止执行、白名单校验、最小权限运行 Web 进程。')
    if (access.some((a) => a.method === 'vnc' || a.method === 'rdp' || a.method === 'ssh')) advice.push('3. 收敛远程管理暴露面（VNC/RDP/SSH 不暴露公网），强制强口令与多因子认证。')
    if (creds.some((c) => c.secret_type === 'connection-string')) advice.push('4. 禁止通过接口/配置泄露数据库连接串，密钥统一纳入密钥管理并对接口做鉴权。')
    advice.push(`${advice.length + 1}. 对本次涉及的接口做统一鉴权与越权校验，建立接口资产台账与自动化回归测试。`)
    push(...advice, '')

    if (filteredOut > 0 && !includeAll) {
      push(`> 本报告只收录已验证/已利用且中危以上的成果漏洞；另有 ${filteredOut} 条待验证、误报或低危/信息级记录未纳入（可在「漏洞战果」页面查看）。`)
      push('')
    }

    return {
      markdown: lines.join('\n'),
      generated_at: nowIso(),
      stats: {
        results: vulns.length,
        bySeverity,
        exploited,
        filteredOut,
        accesses: access.length,
        credentials: creds.length,
        chainSteps: chain.length,
      },
    }
  }

  /* ---------- 写入原语 ---------- */
  #upsertSegment(db, seg) {
    db.prepare(`INSERT INTO segment(cidr, ip_start, ip_end, org, asn, country, city, source, first_seen, last_seen)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(cidr) DO UPDATE SET
        org = COALESCE(excluded.org, segment.org),
        asn = COALESCE(excluded.asn, segment.asn),
        country = COALESCE(excluded.country, segment.country),
        city = COALESCE(excluded.city, segment.city),
        last_seen = excluded.last_seen`).run(
      seg.cidr, seg.ip_start ?? null, seg.ip_end ?? null, seg.org ?? null, seg.asn ?? null,
      seg.country ?? null, seg.city ?? null, seg.source ?? null, seg.first_seen ?? nowIso(), nowIso(),
    )
  }

  #upsertAsset(db, a) {
    const cidr = a.segment_cidr || cidrOf(a.ip)
    this.#upsertSegment(db, { cidr, source: a.provenance, first_seen: a.first_seen })
    const t = nowIso()
    /* discovered_at = 本库第一次看到这条资产的时刻；重复采集只刷新 last_seen，
       不动 discovered_at（否则"发现时间"会变成"最后一次采集时间"，等于没记）。 */
    db.prepare(`INSERT INTO asset(segment_cidr, ip, ip_int, state, primary_name, confidence, first_seen, last_seen, discovered_at, scope)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(segment_cidr, ip) DO UPDATE SET
        state = COALESCE(excluded.state, asset.state),
        primary_name = COALESCE(excluded.primary_name, asset.primary_name),
        scope = COALESCE(NULLIF(asset.scope, ''), excluded.scope),
        discovered_at = COALESCE(NULLIF(asset.discovered_at, ''), excluded.discovered_at),
        last_seen = excluded.last_seen`).run(
      cidr, a.ip, ipToInt(a.ip), a.state ?? 'unknown', a.primary_name ?? null, a.confidence ?? null,
      a.first_seen ?? t, t, a.discovered_at ?? t, a.scope || scopeOfIp(a.ip),
    )
    return db.prepare('SELECT id FROM asset WHERE segment_cidr = ? AND ip = ?').get(cidr, a.ip).id
  }

  /* 负经验的 component 用资产识别到的产品名，brief 才能按技术栈匹配；识别不到就留空（通用经验）。 */
  #productOfAsset(db, assetId) {
    if (assetId === undefined || assetId === null) return ''
    const id = Number(assetId)
    if (!Number.isFinite(id)) return ''
    for (const sql of [
      "SELECT product FROM fingerprint WHERE asset_id = ? AND COALESCE(product, '') <> '' LIMIT 1",
      "SELECT product FROM service WHERE asset_id = ? AND COALESCE(product, '') <> '' LIMIT 1",
    ]) {
      try {
        const row = db.prepare(sql).get(id)
        if (row && row.product) return String(row.product).trim()
      } catch { /* 表缺失时继续 */ }
    }
    return ''
  }

  #observe(db, entityKind, entityId, attr, value, provenance, tool, rawRef) {
    /* 名称类不进观察流：资产名已经有 asset_name 这张表，再记一遍只会把时间线刷成 DNS 流水 */
    if (attr === 'name' || attr === 'primary_name') return
    const text = value === null || value === undefined ? null : String(value)
    /* 同一实体同一属性同一值只留第一条：重复采集不再产生新行 */
    const seen = db.prepare(`SELECT 1 AS x FROM observation
      WHERE entity_kind = ? AND entity_id = ? AND COALESCE(attr, '') = ? AND COALESCE(value, '') = ?
      LIMIT 1`).get(entityKind, entityId, attr ?? '', text ?? '')
    if (seen !== undefined) return
    db.prepare(`INSERT INTO observation(entity_kind, entity_id, attr, value, provenance, tool, collected_at, raw_ref)
      VALUES(?,?,?,?,?,?,?,?)`).run(
      entityKind, entityId, attr ?? null, text,
      provenance ?? 'unknown', tool ?? null, nowIso(), rawRef ?? null,
    )
  }

  #edge(db, srcKind, srcId, dstKind, dstId, relation, confidence) {
    db.prepare(`INSERT INTO edge(src_kind, src_id, dst_kind, dst_id, relation, confidence, first_seen, last_seen)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(src_kind, src_id, dst_kind, dst_id, relation) DO UPDATE SET last_seen = excluded.last_seen`).run(
      srcKind, String(srcId), dstKind, String(dstId), relation, confidence ?? null, nowIso(), nowIso(),
    )
  }

  /** 重建单个资产的全文索引行（列表、图谱、后续智能体共用一份索引）。 */
  #reindex(db, assetId) {
    const a = db.prepare('SELECT * FROM asset WHERE id = ?').get(assetId)
    if (!a) return
    /* 没有 FTS5 时不建索引表，这里直接跳过 —— 检索走 listAssets 的 LIKE 分支，
       所以上面那几段取值也不用白跑。 */
    if (!HAS_FTS5) return
    const names = db.prepare('SELECT name FROM asset_name WHERE asset_id = ?').all(assetId).map((r) => r.name).join(' ')
    const banners = db.prepare('SELECT banner FROM port WHERE asset_id = ? AND banner IS NOT NULL').all(assetId).map((r) => r.banner).join(' ')
    const titles = db.prepare('SELECT title FROM port WHERE asset_id = ? AND title IS NOT NULL').all(assetId).map((r) => r.title).join(' ')
      + ' ' + db.prepare('SELECT url FROM port WHERE asset_id = ? AND url IS NOT NULL').all(assetId).map((r) => r.url).join(' ')
      + ' ' + db.prepare(`SELECT s.product, s.name, s.version FROM service s JOIN port p ON p.id = s.port_id WHERE p.asset_id = ?`)
        .all(assetId).map((r) => [r.name, r.product, r.version].filter(Boolean).join(' ')).join(' ')
    const fps = db.prepare('SELECT vendor, product, version, category FROM fingerprint WHERE asset_id = ?')
      .all(assetId).map((r) => [r.category, r.vendor, r.product, r.version].filter(Boolean).join(' ')).join(' ')
    db.prepare('DELETE FROM asset_fts WHERE asset_id = ?').run(String(assetId))
    db.prepare('INSERT INTO asset_fts(asset_id, ip, names, banners, titles, fingerprints) VALUES(?,?,?,?,?,?)')
      .run(String(assetId), a.ip, names, banners, titles, fps)
  }

  /**
   * 采集结果入库（信息收集智能体与外部工具的统一 ingest 格式）。
   * bundle = { scan:{tool,argv,agent_session_id}, segments:[], assets:[], edges:[] }
   * asset  = { ip, state, primary_name, provenance, tool, names:[{name,kind}],
   *            ports:[{port,proto,service,product,version,banner,provenance,tool,
   *                    fingerprints:[{category,vendor,product,version,evidence}]}] }
   */
  importBundle(id, bundle = {}) {
    const db = this.db(id)
    const counts = { segments: 0, assets: 0, ports: 0, services: 0, fingerprints: 0, names: 0, edges: 0 }
    let runId = null
    if (bundle.scan) {
      const r = db.prepare(`INSERT INTO scan_run(agent_session_id, tool, argv, started_at, status)
        VALUES(?,?,?,?,'completed')`).run(
        bundle.scan.agent_session_id ?? null, bundle.scan.tool ?? null,
        bundle.scan.argv ? JSON.stringify(bundle.scan.argv) : null, nowIso(),
      )
      runId = Number(r.lastInsertRowid)
      if (bundle.scan.tool) {
        try { this.toolObserve(id, String(bundle.scan.tool).trim(), 'scanner') } catch { /* 登记失败不影响导入 */ }
      }
    }
    db.exec('BEGIN')
    try {
      for (const seg of bundle.segments || []) { this.#upsertSegment(db, seg); counts.segments++ }
      for (const a of bundle.assets || []) {
        const provenance = a.provenance || 'active'
        const tool = a.tool || (bundle.scan && bundle.scan.tool) || null
        const assetId = this.#upsertAsset(db, Object.assign({}, a, { provenance }))
        counts.assets++
        for (const n of a.names || []) {
          db.prepare(`INSERT INTO asset_name(asset_id, name, kind, provenance, tool, first_seen, last_seen)
            VALUES(?,?,?,?,?,?,?) ON CONFLICT(asset_id, name, kind) DO UPDATE SET last_seen = excluded.last_seen`)
            .run(assetId, n.name, n.kind ?? 'domain', n.provenance ?? provenance, tool, nowIso(), nowIso())
          counts.names++
          this.#observe(db, 'asset', assetId, 'name', n.name, n.provenance ?? provenance, tool, runId)
          this.#edge(db, 'domain', n.name, 'asset', assetId, 'resolves')
        }
        if (a.primary_name) this.#observe(db, 'asset', assetId, 'primary_name', a.primary_name, provenance, tool, runId)
        for (const p of a.ports || []) {
          const pProv = p.provenance || provenance
          db.prepare(`INSERT INTO port(asset_id, proto, port, state, provenance, tool, banner, url, title, first_seen, last_seen)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(asset_id, proto, port) DO UPDATE SET
              state = excluded.state,
              banner = COALESCE(excluded.banner, port.banner),
              url = COALESCE(excluded.url, port.url),
              title = COALESCE(excluded.title, port.title),
              last_seen = excluded.last_seen`)
            .run(assetId, p.proto ?? 'tcp', Number(p.port), p.state ?? 'open', pProv, p.tool ?? tool,
              p.banner ?? null, p.url ?? null, p.title ?? null, nowIso(), nowIso())
          const portId = db.prepare('SELECT id FROM port WHERE asset_id = ? AND proto = ? AND port = ?')
            .get(assetId, p.proto ?? 'tcp', Number(p.port)).id
          counts.ports++
          this.#observe(db, 'port', portId, 'open', `${p.port}/${p.proto ?? 'tcp'}`, pProv, p.tool ?? tool, runId)
          if (p.service || p.product || p.version) {
            /* 重复导入同一份 bundle 时，service 没有唯一约束，旧实现会每导一次就多一套；
               面板的「服务」统计与抽屉会跟着膨胀。按端口 + 三元组做幂等更新。 */
            const serviceName = p.service ?? null
            const serviceProduct = p.product ?? null
            const serviceVersion = p.version ?? null
            const existingService = db.prepare(
              "SELECT id FROM service WHERE port_id = ? AND COALESCE(name,'') = ? AND COALESCE(product,'') = ? AND COALESCE(version,'') = ?",
            ).get(portId, serviceName ?? '', serviceProduct ?? '', serviceVersion ?? '')
            if (existingService !== undefined) {
              db.prepare('UPDATE service SET cpe = COALESCE(?, cpe), tool = COALESCE(?, tool), last_seen = ? WHERE id = ?')
                .run(p.cpe ?? null, p.tool ?? tool, nowIso(), existingService.id)
            } else {
              db.prepare(`INSERT INTO service(port_id, name, product, version, cpe, provenance, tool, first_seen, last_seen)
                VALUES(?,?,?,?,?,?,?,?,?)`).run(
                portId, serviceName, serviceProduct, serviceVersion, p.cpe ?? null,
                pProv, p.tool ?? tool, nowIso(), nowIso(),
              )
            }
            counts.services++
            this.#observe(db, 'port', portId, 'service', [p.service, p.product, p.version].filter(Boolean).join(' '), pProv, p.tool ?? tool, runId)
          }
          for (const fp of p.fingerprints || []) {
            /* 同一端口重复导入同一指纹：保留首个 first_seen，只刷新 last_seen 与证据。 */
            const existingFp = db.prepare(
              "SELECT id FROM fingerprint WHERE asset_id = ? AND port_id = ? AND COALESCE(category,'') = ?"
              + " AND COALESCE(vendor,'') = ? AND COALESCE(product,'') = ? AND COALESCE(version,'') = ?",
            ).get(assetId, portId, fp.category ?? '', fp.vendor ?? '', fp.product ?? '', fp.version ?? '')
            if (existingFp !== undefined) {
              db.prepare('UPDATE fingerprint SET evidence = COALESCE(?, evidence), confidence = COALESCE(?, confidence), last_seen = ? WHERE id = ?')
                .run(fp.evidence ?? null, fp.confidence ?? null, nowIso(), existingFp.id)
            } else {
              db.prepare(`INSERT INTO fingerprint(asset_id, port_id, category, vendor, product, version, evidence, confidence, provenance, tool, first_seen, last_seen)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
                assetId, portId, fp.category ?? null, fp.vendor ?? null, fp.product ?? null, fp.version ?? null,
                fp.evidence ?? null, fp.confidence ?? null, fp.provenance ?? pProv, fp.tool ?? tool, nowIso(), nowIso(),
              )
            }
            counts.fingerprints++
            this.#observe(db, 'asset', assetId, 'fingerprint',
              [fp.category, fp.vendor, fp.product, fp.version].filter(Boolean).join(' '),
              fp.provenance ?? pProv, fp.tool ?? tool, runId)
          }
        }
        this.#reindex(db, assetId)
      }
      for (const e of bundle.edges || []) {
        this.#edge(db, e.src_kind, e.src_id, e.dst_kind, e.dst_id, e.relation, e.confidence)
        counts.edges++
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return { scan_run_id: runId, counts, stats: this.stats(id) }
  }

  /* ---------- 提示词 ---------- */

  /** 默认提示词指纹清单（记录本靶标上次被写入默认时的内容指纹）。 */
  promptManifestPathOf(id) { return join(this.promptsDirOf(id), '.defaults.json') }

  readPromptManifest(id) {
    try {
      const raw = readFileSync(this.promptManifestPathOf(id), 'utf8')
      const data = JSON.parse(raw)
      return data !== null && typeof data === 'object' ? data : {}
    } catch { return {} }
  }

  writePromptManifest(id, manifest) {
    try {
      mkdirSync(this.promptsDirOf(id), { recursive: true })
      writeFileSync(this.promptManifestPathOf(id), JSON.stringify(manifest, null, 2), 'utf8')
    } catch { /* 写不进去不影响使用 */ }
  }

  /**
   * 把仍是内置默认的角色提示词换成当前版本；用户自己改过的原样保留。
   *
   * 判断依据：内容指纹等于本靶标上次写入默认时的指纹（manifest）。
   * 不匹配 = 用户自己写的，不覆盖。
   *
   * @param id - 靶标 id。
   * @param options - `{ force?: boolean }`：force 时连"用户自写"也覆盖（脚本批量升级用）。
   * @returns `{ changed, kept, created }` —— kept 是判定为"用户自写、已保留"的角色。
   */
  refreshDefaultPrompts(id, options = {}) {
    const manifest = this.readPromptManifest(id)
    let changed = 0
    let created = 0
    const kept = []
    for (const role of Object.keys(ROLE_TITLES)) {
      const next = DEFAULT_PROMPTS[role] || ''
      const p = join(this.promptsDirOf(id), `${role}.md`)
      /* 新增角色（如 v0.9.0 的资产梳理 assess / 主会话 plan）：老靶标没有这个文件，
         直接按当前默认建一份，不用用户手动补 */
      if (!existsSync(p)) {
        if (next !== '') {
          mkdirSync(this.promptsDirOf(id), { recursive: true })
          writeFileSync(p, next, 'utf8')
          manifest[role] = promptHash(next)
          created += 1
        }
        continue
      }
      const cur = readFileSync(p, 'utf8')
      const h = promptHash(cur)
      const hNext = promptHash(next)
      if (h === hNext) { manifest[role] = hNext; continue }
      const wasDefault = options.force === true || manifest[role] === h
      if (!wasDefault) { kept.push(role); continue }
      /* 覆盖前留一份 .bak，万一判错还能找回 */
      try { copyFileSync(p, `${p}.bak-${Date.now()}`) } catch { /* 忽略 */ }
      writeFileSync(p, next, 'utf8')
      manifest[role] = hNext
      changed += 1
    }
    this.writePromptManifest(id, manifest)
    return { changed, kept, created }
  }

  listPrompts(id) {
    const dir = this.promptsDirOf(id)
    mkdirSync(dir, { recursive: true })
    this.refreshDefaultPrompts(id)
    return Object.entries(ROLE_TITLES).map(([role, title]) => {
      const p = join(dir, `${role}.md`)
      const exists = existsSync(p)
      return {
        role, title,
        /* 主会话（plan）不派出去，只作人设参考 —— 面板上标注一下，别让人以为要派它 */
        planner: role === PLANNER_ROLE,
        dispatcher: role !== PLANNER_ROLE,
        content: exists ? readFileSync(p, 'utf8') : '',
        updated_at: exists ? statSync(p).mtime.toISOString() : null,
      }
    })
  }

  /** 把角色提示词恢复成内置默认（用户在界面上改坏了 / 老靶标要用新版提示词时用）。 */
  resetPrompts(id, role) {
    if (role !== undefined && role !== null) {
      this.savePrompt(id, role, DEFAULT_PROMPTS[role] || '')
      return { reset: [role] }
    }
    const done = []
    for (const r of Object.keys(ROLE_TITLES)) { this.savePrompt(id, r, DEFAULT_PROMPTS[r] || ''); done.push(r) }
    return { reset: done }
  }

  savePrompt(id, role, content) {
    if (!ROLE_TITLES[role]) throw new Error(`unknown role: ${role}`)
    mkdirSync(this.promptsDirOf(id), { recursive: true })
    const text = String(content ?? '')
    /* 角色稿是子智能体的工作说明，不能存空：要恢复默认用 resetPrompts。 */
    if (!text.trim()) throw new Error('角色稿不能为空；要恢复默认请点「恢复默认」')
    writeFileSync(join(this.promptsDirOf(id), `${role}.md`), text, 'utf8')
    /* 记下这是不是"当前内置默认"：是则将来能随新版自动升级，否则视为用户自写、永不覆盖 */
    const manifest = this.readPromptManifest(id)
    if (promptHash(text) === promptHash(DEFAULT_PROMPTS[role] || '')) manifest[role] = promptHash(text)
    else delete manifest[role]
    this.writePromptManifest(id, manifest)
    return { role, bytes: Buffer.byteLength(text) }
  }

}
