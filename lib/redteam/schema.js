import { DatabaseSync } from 'node:sqlite'
import { parseTargetPort } from './target-net.js'

/** 迁移里要用的端口解析跟入库校验共用同一份实现（lib/redteam/target-net.js）。 */

/**
 * 事实库 schema 与增量迁移（零依赖）。
 *
 * 从 core.js 抽出来的模块：**DDL 与迁移是"数据形状"的唯一定义处**，
 * 与"怎么用这些数据"（RedteamStore 的方法）分开之后，
 * 看 schema 不用翻过 500 行计分逻辑，改表结构也不会误碰业务代码。
 *
 * 两处迁移遵循同一条纪律：**先查 PRAGMA 再 ADD COLUMN**，可重复执行、老库不用重建。
 * 读不到表结构一律按"没有这一列"处理（返回 false），交给 ensure 去尝试 ALTER；
 * 反过来当成"列已存在"会让迁移被静默跳过，故障点从"迁移失败"漂到远端 SQL 执行处。
 */

/* ------------------------------------------------------------------ FTS5 能力检测 */

/**
 * 本机 `node:sqlite` 是否带 FTS5。
 *
 * **必须检测**：FTS5 是编译期选项，不同 Node 构建并不一致 ——
 * Node 22.14 的 `node:sqlite` 没有（`no such module: fts5`），22.23 有。
 * 因此不能假定它存在：CI 与本地 Node 版本不一致时，整个 DDL 都建不起来。
 * 语义：只有 FTS5 缺席时才降级成 LIKE 检索 —— 装了 FTS5 的机器行为完全不变。
 *
 * `REDTEAM_NO_FTS5=1` 可强制走降级路径：CI 的 Node 一旦换了带 FTS5 的版本，
 * 降级分支就再没人执行了，得留一个能主动触发它的开关（见 test/fts-fallback.test.mjs）。
 */
export const HAS_FTS5 = (() => {
  if (process.env.REDTEAM_NO_FTS5 === '1') return false
  try {
    const probe = new DatabaseSync(':memory:')
    try {
      probe.exec('CREATE VIRTUAL TABLE __fts5_probe USING fts5(x)')
      return true
    } finally {
      probe.close()
    }
  } catch {
    return false
  }
})()

/* ------------------------------------------------------------------ FTS 虚拟表 DDL */

/**
 * 两张全文检索虚拟表。**单独导出**，因为它们依赖 FTS5：
 * FTS5 缺席的构建上建表会抛 `no such module: fts5`，把整份 DDL 一起带崩。
 * 调用方按 `HAS_FTS5` 决定是否拼进 DDL（见 core.js 的 db() / kb()）。
 */
export const ASSET_FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS asset_fts USING fts5(
  asset_id UNINDEXED, ip, names, banners, titles, fingerprints
);
`

export const POC_FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS poc_fts USING fts5(
  poc_id UNINDEXED, title, cve, component, versions, tags, description, content
);
`

/* ------------------------------------------------------------------ 靶标库 schema */

export const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS scan_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_session_id TEXT, tool TEXT, argv TEXT,
  started_at TEXT, finished_at TEXT, status TEXT DEFAULT 'running'
);

CREATE TABLE IF NOT EXISTS segment (
  cidr TEXT PRIMARY KEY, ip_start TEXT, ip_end TEXT,
  org TEXT, asn TEXT, country TEXT, city TEXT,
  source TEXT, first_seen TEXT, last_seen TEXT
);

CREATE TABLE IF NOT EXISTS asset (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  segment_cidr TEXT NOT NULL, ip TEXT NOT NULL, ip_int INTEGER,
  state TEXT DEFAULT 'unknown', primary_name TEXT, confidence REAL,
  first_seen TEXT, last_seen TEXT, discovered_at TEXT,
  test_status TEXT DEFAULT 'untested', test_notes TEXT, test_surface TEXT,
  test_updated_at TEXT, test_updated_by TEXT, blocked_count INTEGER DEFAULT 0,
  priority TEXT, potential TEXT, assess_reason TEXT, assessed_at TEXT, assessed_by TEXT,
  UNIQUE(segment_cidr, ip)
);

CREATE TABLE IF NOT EXISTS asset_name (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT,
  provenance TEXT, tool TEXT, first_seen TEXT, last_seen TEXT,
  UNIQUE(asset_id, name, kind)
);

CREATE TABLE IF NOT EXISTS port (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL, proto TEXT DEFAULT 'tcp', port INTEGER NOT NULL,
  state TEXT DEFAULT 'open', provenance TEXT, tool TEXT, banner TEXT,
  url TEXT, title TEXT,
  first_seen TEXT, last_seen TEXT,
  UNIQUE(asset_id, proto, port)
);

CREATE TABLE IF NOT EXISTS service (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  port_id INTEGER NOT NULL, name TEXT, product TEXT, version TEXT, cpe TEXT,
  provenance TEXT, tool TEXT, first_seen TEXT, last_seen TEXT
);

CREATE TABLE IF NOT EXISTS fingerprint (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL, port_id INTEGER,
  category TEXT, vendor TEXT, product TEXT, version TEXT,
  evidence TEXT, confidence REAL, provenance TEXT, tool TEXT,
  first_seen TEXT, last_seen TEXT
);

CREATE TABLE IF NOT EXISTS observation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_kind TEXT NOT NULL, entity_id INTEGER NOT NULL,
  attr TEXT, value TEXT, provenance TEXT, tool TEXT,
  scan_run_id INTEGER, collected_at TEXT, raw_ref TEXT
);

CREATE TABLE IF NOT EXISTS edge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  src_kind TEXT NOT NULL, src_id TEXT NOT NULL,
  dst_kind TEXT NOT NULL, dst_id TEXT NOT NULL,
  relation TEXT NOT NULL, confidence REAL, scan_run_id INTEGER,
  first_seen TEXT, last_seen TEXT,
  UNIQUE(src_kind, src_id, dst_kind, dst_id, relation)
);

CREATE TABLE IF NOT EXISTS tag (
  entity_kind TEXT NOT NULL, entity_id INTEGER NOT NULL, tag TEXT NOT NULL,
  note TEXT, created_by TEXT, created_at TEXT,
  PRIMARY KEY (entity_kind, entity_id, tag)
);

CREATE TABLE IF NOT EXISTS vuln (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER, port_id INTEGER, cve TEXT, title TEXT, severity TEXT,
  source TEXT, confidence REAL, status TEXT, evidence TEXT, target TEXT,
  found_by_agent TEXT, found_at TEXT, gained TEXT, agent TEXT
);


/* 攻击假设：一条待验证的测试方向。开的时候写清"测什么、为什么值得测、什么结果算证伪"，
   关的时候只有三种结局；confirmed 才转成漏洞，refuted / blocked 是排除记录。 */
CREATE TABLE IF NOT EXISTS hypothesis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER,
  surface TEXT NOT NULL,
  why TEXT NOT NULL,
  vuln_class TEXT,
  cause TEXT,
  conditions TEXT,
  test_plan TEXT,
  falsify TEXT NOT NULL,
  status TEXT DEFAULT 'open',
  basis TEXT,
  evidence TEXT,
  vuln_id INTEGER,
  opened_by TEXT, opened_at TEXT,
  closed_by TEXT, closed_at TEXT,
  agent TEXT
);
CREATE INDEX IF NOT EXISTS ix_hypothesis_status ON hypothesis(status);
CREATE INDEX IF NOT EXISTS ix_hypothesis_asset ON hypothesis(asset_id);

/* 作战阶段：全链路攻击路径图的五个阶段（内容可编辑） */
CREATE TABLE IF NOT EXISTS stage (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subtitle TEXT,
  color TEXT,
  goal TEXT,
  sections TEXT,
  tools TEXT,
  transition TEXT,
  sort_order INTEGER DEFAULT 0,
  updated_at TEXT
);


/* 凭据：secret_value 存明文口令/密钥（面板直接显示，便于随时复用），secret_ref 指向 runs/ 下的证据文件。
   注意：本库只在本机，禁止把库文件或导出内容提交到任何仓库。 */
CREATE TABLE IF NOT EXISTS credential (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER, host TEXT, username TEXT, secret_type TEXT,
  secret_value TEXT, secret_ref TEXT,
  privilege TEXT, source TEXT, tool TEXT, note TEXT,
  found_by_agent TEXT, found_at TEXT, agent TEXT,
  UNIQUE(host, username, secret_type)
);

/* 访问会话：拿到入口后的一次可控访问记录（横向移动的起点） */
CREATE TABLE IF NOT EXISTS access_session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER, host TEXT, username TEXT, method TEXT, privilege TEXT,
  session_ref TEXT, note TEXT, found_by_agent TEXT, obtained_at TEXT
);

/* WebShell：已经上线的可控入口。智能体随时可以复用，避免"打到最后忘了还有 webshell" */
CREATE TABLE IF NOT EXISTS webshell (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER, url TEXT NOT NULL, shell_type TEXT, pass_key TEXT,
  secret_ref TEXT, privilege TEXT,
  status TEXT DEFAULT 'unknown', last_check TEXT, check_note TEXT, latency_ms INTEGER,
  note TEXT, found_by_agent TEXT, created_at TEXT, updated_at TEXT, agent TEXT,
  UNIQUE(url, pass_key)
);

/* 内网隧道：suo5 / socks5 / ssh -R / frp 等。记录入口、监听地址与可达网段 */
CREATE TABLE IF NOT EXISTS tunnel (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER, webshell_id INTEGER, kind TEXT, listen TEXT,
  entry TEXT, reach TEXT,
  entry_kind TEXT,
  status TEXT DEFAULT 'unknown', last_check TEXT, check_note TEXT, latency_ms INTEGER,
  pid TEXT, command TEXT, note TEXT, found_by_agent TEXT, created_at TEXT, updated_at TEXT, agent TEXT
);

/* HTTP 证据：原始请求/响应，可直接粘贴进 Burp Suite / Yakit 复现 */
CREATE TABLE IF NOT EXISTS http_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vuln_id INTEGER, asset_id INTEGER, label TEXT,
  method TEXT, url TEXT, status INTEGER,
  request TEXT, response TEXT, note TEXT,
  captured_by TEXT, captured_at TEXT
);

/* 攻击文件：针对某个目标实际生效的脚本/POC/EXP（只收录验证有效的） */
CREATE TABLE IF NOT EXISTS attack_file (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT NOT NULL, target_kind TEXT, name TEXT NOT NULL, kind TEXT,
  path TEXT NOT NULL, description TEXT, evidence TEXT,
  asset_id INTEGER, vuln_id INTEGER, created_by TEXT, created_at TEXT,
  UNIQUE(target, name)
);

/* 攻击链步骤：人工/智能体记录的链路节点，用于攻击链页面与报告。
   tool/agent/result 三列是"这一步怎么做的"的凭证：报告要写清账号密码怎么来的、
   隧道怎么搭的，靠的就是步骤上的工具与命令原文。 */
CREATE TABLE IF NOT EXISTS attack_step (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seq INTEGER, stage TEXT, title TEXT, detail TEXT,
  asset_id INTEGER, vuln_id INTEGER, access_id INTEGER, point_id INTEGER,
  evidence_ref TEXT, tool TEXT, agent TEXT, result TEXT,
  recorded_by TEXT, recorded_at TEXT
);

/* 工具登记：名称、用途与人工标注。
   使用次数不写死——从 attack_step.tool 与 scan_run.tool 实时聚合；
   本表只存人工标注（status/note）与智能体显式登记过的条目。
   status：'' 未标注 | available 可用 | deprecated 不建议 | blocked 建议停用。 */
CREATE TABLE IF NOT EXISTS tool_registry (
  name TEXT PRIMARY KEY,
  kind TEXT DEFAULT 'executable',
  status TEXT DEFAULT '',
  note TEXT,
  uses INTEGER DEFAULT 0,
  first_seen TEXT,
  last_seen TEXT,
  updated_by TEXT,
  updated_at TEXT
);

/* 证据截图：得分成果的"看得见"的那一份材料。
   落盘位置：<靶标目录>/shots/，库里只存文件名与元数据 —— 图片不进 SQLite。
   kind：screenshot 现场截图；card 由记录生成的证据摘录卡，报告里要分开标注。 */
CREATE TABLE IF NOT EXISTS shot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  point_id INTEGER, hit_id INTEGER, asset_id INTEGER, vuln_id INTEGER,
  target TEXT, label TEXT, note TEXT,
  file TEXT NOT NULL,
  kind TEXT DEFAULT 'screenshot',
  mime TEXT, bytes INTEGER, width INTEGER, height INTEGER, sha256 TEXT,
  source_ref TEXT, captured_at TEXT, found_by_agent TEXT, agent TEXT, created_at TEXT,
  UNIQUE(file)
);


/* 覆盖账本：某个面（host/URL）上某一类测试做过没有。
   八类：authn 认证 / authz 越权 / injection 注入 / file 文件与路径 / ssrf 服务端请求 /
 logic 业务逻辑 / client 前端与客户端 / infra 基础设施。
   只记「测过 / 干净 / 跳过」，不替代漏洞与步骤本身。 */
CREATE TABLE IF NOT EXISTS coverage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  surface TEXT NOT NULL,
  asset_id INTEGER,
  test_class TEXT NOT NULL,
  status TEXT DEFAULT 'untested',
  note TEXT,
  updated_by TEXT,
  updated_at TEXT,
  UNIQUE(surface, test_class)
);

CREATE INDEX IF NOT EXISTS ix_coverage_surface ON coverage(surface);
CREATE INDEX IF NOT EXISTS ix_coverage_asset ON coverage(asset_id);
CREATE INDEX IF NOT EXISTS ix_asset_ip_int ON asset(ip_int);
CREATE INDEX IF NOT EXISTS ix_port_asset ON port(asset_id);
CREATE INDEX IF NOT EXISTS ix_port_port ON port(port);
CREATE INDEX IF NOT EXISTS ix_service_port ON service(port_id);
CREATE INDEX IF NOT EXISTS ix_service_name ON service(name, product, version);
CREATE INDEX IF NOT EXISTS ix_fp_asset ON fingerprint(asset_id);
CREATE INDEX IF NOT EXISTS ix_fp_product ON fingerprint(product, version);
CREATE INDEX IF NOT EXISTS ix_edge_src ON edge(src_kind, src_id);
CREATE INDEX IF NOT EXISTS ix_edge_dst ON edge(dst_kind, dst_id);
CREATE INDEX IF NOT EXISTS ix_obs_entity ON observation(entity_kind, entity_id);
CREATE INDEX IF NOT EXISTS ix_vuln_asset ON vuln(asset_id);
CREATE INDEX IF NOT EXISTS ix_vuln_sev ON vuln(severity, status);
CREATE INDEX IF NOT EXISTS ix_vuln_cve ON vuln(cve);
CREATE INDEX IF NOT EXISTS ix_cred_host ON credential(host);
CREATE INDEX IF NOT EXISTS ix_access_host ON access_session(host);
CREATE INDEX IF NOT EXISTS ix_webshell_status ON webshell(status);
CREATE INDEX IF NOT EXISTS ix_tunnel_status ON tunnel(status);
CREATE INDEX IF NOT EXISTS ix_shot_point ON shot(point_id);
CREATE INDEX IF NOT EXISTS ix_shot_hit ON shot(hit_id);
CREATE INDEX IF NOT EXISTS ix_shot_asset ON shot(asset_id);
CREATE INDEX IF NOT EXISTS ix_http_vuln ON http_evidence(vuln_id);
CREATE INDEX IF NOT EXISTS ix_http_asset ON http_evidence(asset_id);
CREATE INDEX IF NOT EXISTS ix_step_seq ON attack_step(seq, id);
CREATE INDEX IF NOT EXISTS ix_attack_target ON attack_file(target);
/* 报告的"这一步关联了哪些攻击步骤"按 asset_id / vuln_id / step_id 反查 */
/* 攻击步骤按资产/漏洞反查（报告溯源与 #hitTrace 的兜底归因都走这里） */
CREATE INDEX IF NOT EXISTS ix_step_asset ON attack_step(asset_id);
CREATE INDEX IF NOT EXISTS ix_step_vuln ON attack_step(vuln_id);
CREATE INDEX IF NOT EXISTS ix_step_recorded ON attack_step(recorded_at);
/* 资产按 C 段 + 状态筛（资产测绘左侧点某个 C 段就是这条） */
CREATE INDEX IF NOT EXISTS ix_asset_segment_state ON asset(segment_cidr, state);
CREATE INDEX IF NOT EXISTS ix_http_url ON http_evidence(url);
/* 隧道/马按资产与状态查（会话页与攻击链都要） */
CREATE INDEX IF NOT EXISTS ix_tunnel_asset ON tunnel(asset_id);
CREATE INDEX IF NOT EXISTS ix_webshell_asset ON webshell(asset_id);
CREATE INDEX IF NOT EXISTS ix_credential_asset ON credential(asset_id);
CREATE INDEX IF NOT EXISTS ix_access_asset ON access_session(asset_id);

CREATE VIEW IF NOT EXISTS v_asset_summary AS
SELECT a.id, a.ip, a.segment_cidr, a.state, a.primary_name, a.first_seen, a.last_seen,
  (SELECT COUNT(*) FROM port p WHERE p.asset_id = a.id AND p.state = 'open') AS open_ports,
  (SELECT COUNT(*) FROM observation o WHERE o.entity_kind = 'asset' AND o.entity_id = a.id AND o.provenance = 'passive') AS passive_signals,
  (SELECT COUNT(*) FROM observation o WHERE o.entity_kind = 'asset' AND o.entity_id = a.id AND o.provenance = 'active') AS active_signals
FROM asset a;

CREATE VIEW IF NOT EXISTS v_asset_service AS
SELECT p.asset_id, p.port, p.proto, p.provenance AS port_provenance,
       s.name AS service, s.product, s.version, s.provenance AS service_provenance
FROM port p LEFT JOIN service s ON s.port_id = p.id;
`

/* ------------------------------------------------------------------ 知识库 schema */

export const KNOWLEDGE_DDL = `
CREATE TABLE IF NOT EXISTS poc (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,                -- 稳定标识（slug），智能体可直接引用
  title TEXT NOT NULL,
  kind TEXT,                         -- poc | exp | script | template | payload
  category TEXT,                     -- 归类：rce / deserialization / file-upload / sqli / unauthorized / auth-bypass / weak-password / ssrf / xxe / path-traversal / file-read / info-leak / privesc / tunnel / other
  cve TEXT,                          -- CVE / CNVD / 厂商编号
  component TEXT,                    -- 组件/产品（Weblogic、Shiro、泛微 OA…）
  versions TEXT,                     -- 影响版本
  severity TEXT,
  language TEXT,                     -- python | go | java | bash | http | nuclei | js | php
  source TEXT,                       -- web | self | manual | nuclei-template | kb
  source_url TEXT,
  description TEXT,
  usage TEXT,                        -- 用法/命令行示例
  content TEXT,                      -- 正文（脚本 / POC / 原始请求）
  path TEXT,                         -- 落盘位置（pocs/<code>/<file>），便于智能体直接 cat
  verified INTEGER DEFAULT 0,        -- 是否实测验证过
  verified_note TEXT,                -- 验证证据（哪台目标、什么回显）
  hit_count INTEGER DEFAULT 0,       -- 被复用次数
  used_on TEXT,                      -- 最近一次使用在哪个靶标/目标
  -- 来源溯源：这条知识是在哪个靶标、哪台资产上发现/验证出来的（建立时间看 created_at）
  engagement_id TEXT,
  engagement_name TEXT,
  asset_target TEXT,
  found_by_agent TEXT,
  tags TEXT,
  created_by TEXT, created_at TEXT, updated_at TEXT,
  UNIQUE(code)
);
CREATE INDEX IF NOT EXISTS ix_poc_cve ON poc(cve);
CREATE INDEX IF NOT EXISTS ix_poc_component ON poc(component);
CREATE INDEX IF NOT EXISTS ix_poc_kind ON poc(kind, verified);
/* 注意：归类 / 来源靶标两个索引**不能写在这里** —— 老 knowledge.db 的 poc 表还没有
   这两列，CREATE INDEX 会在 exec(DDL) 阶段直接抛
   "no such column: category"，连补列的迁移都跑不到。它们在 migrateKnowledge() 补完列之后再建。 */
`

/* ------------------------------------------------------------------ 知识库归类 */



/**
 * 知识库归类（与得分点/攻击面口径对齐）：智能体回填时必须选一个，
 * 面板按它分组，用户才能"一类一类看"而不是几百条平铺。
 */
const POC_CATEGORIES = [
  { code: 'rce', name: '远程命令执行', hint: '框架/中间件/组件 RCE、表达式注入、模板注入' },
  { code: 'deserialization', name: '反序列化', hint: 'Java/PHP/.NET 反序列化链、fastjson/jackson 等' },
  { code: 'file-upload', name: '文件上传 getshell', hint: '上传绕过、解析漏洞、二次渲染、竞争' },
  { code: 'sqli', name: 'SQL 注入', hint: '注入点验证、拖库、写文件、提权' },
  { code: 'unauthorized', name: '未授权访问', hint: '未鉴权接口/服务（Redis、Docker、Actuator、Swagger 调用）' },
  { code: 'auth-bypass', name: '认证绕过 / 越权', hint: '登录绕过、JWT 缺陷、越权读写、逻辑缺陷' },
  { code: 'weak-password', name: '弱口令 / 口令爆破', hint: '管理端弱口令、数据库弱口令、默认口令' },
  { code: 'ssrf', name: 'SSRF', hint: '服务端请求伪造、云元数据、内网探测跳板' },
  { code: 'xxe', name: 'XXE', hint: 'XML 外部实体读取与 SSRF' },
  { code: 'path-traversal', name: '目录穿越 / 任意文件读取', hint: '路径穿越、任意文件读、源码/配置读取' },
  { code: 'info-leak', name: '信息泄露', hint: '配置/凭据/源码/备份泄露（能升级为得分的那些）' },
  { code: 'privesc', name: '提权 / 横向', hint: '本地提权、凭据复用、Pass-the-Hash、横向工具' },
  { code: 'tunnel', name: '隧道 / 代理', hint: 'suo5、frp、chisel、Neo-ReGeorg、内网代理' },
  { code: 'tradecraft', name: '攻击思路 / 战术', hint: '事件复盘、打法组合、未公开利用条件、收益判断等可复用经验' },
  { code: 'negative', name: '排除 / 误报', hint: '证伪过、误报过、打不通的方向；下次先看，避免重走' },
  { code: 'other', name: '其它', hint: '不属于上面任何一类（写清用途）' },
]
export { POC_CATEGORIES }

/** 归类 code → 中文名（未知值原样返回，允许用户自定义）。 */
export function pocCategoryName(code) {
  const hit = POC_CATEGORIES.find((c) => c.code === String(code || ''))
  return hit ? hit.name : (code ? String(code) : '未归类')
}

/**
 * 老条目的归类推测（迁移时给 category 为空的条目打标）。
 * 依据是 code/title/component 里的关键词 —— 命中就归那一类，都不中才落 `other`。
 * 顺序即优先级：越具体的越靠前（例如"任意文件上传"要压过泛化的"上传"）。
 * 新写入的条目由 `redteam_poc_add` 的 `category` 参数决定，不走这里。
 */
export function guessPocCategory(text) {
  const t = String(text || '').toLowerCase()
  const has = (...words) => words.some((w) => t.includes(w))
  if (has('反序列化', 'deserial', 'shiro', 'fastjson', 'weblogic', 'log4j', 'jackson')) return 'deserialization'
  if (has('文件上传', 'file-upload', 'fileupload', 'upload', 'getshell', 'webshell', '写马')) return 'file-upload'
  if (has('sql 注入', 'sqli', 'sql注入', '注入拖库', 'union select')) return 'sqli'
  if (has('弱口令', '爆破', 'brute', '默认口令', '默认凭据', 'hydra')) return 'weak-password'
  if (has('隧道', 'socks', 'suo5', 'frp', 'chisel', 'regeorg', '代理')) return 'tunnel'
  if (has('未授权', 'unauth', '免认证', '免鉴权', '未鉴权', '无鉴权')) return 'unauthorized'
  if (has('越权', '认证绕过', '鉴权绕过', 'jwt', '逻辑漏洞', '验证码绕过', 'auth-bypass')) return 'auth-bypass'
  if (has('rce', '命令执行', '代码执行', '表达式注入', '模板注入', 'ssti', '命令注入', '远程执行')) return 'rce'
  if (has('ssrf', '服务端请求伪造')) return 'ssrf'
  if (has('xxe', '外部实体')) return 'xxe'
  if (has('任意文件读', '文件读取', '目录穿越', '路径穿越', 'path traversal', 'lfi', '任意文件下载')) return 'path-traversal'
  if (has('提权', '横向', 'pass-the-hash', 'mimikatz', 'impacket', '凭据复用')) return 'privesc'
  if (has('信息泄露', '配置泄露', '敏感信息', '源码泄露', '泄露', 'leak')) return 'info-leak'
  if (has('tradecraft', '攻击思路', '战术', '打法', '复盘', '利用条件', '收益判断')) return 'tradecraft'
  return 'other'
}

/**
 * nuclei 模板归类：tags 精确命中优先（模板的 tags 是逗号分隔的小写词表），
 * 名称与目录只做兜底。归到与 POC_CATEGORIES 同一套 code，面板的归类胶囊和
 * redteam_poc_search 的 local_templates.by_category 才是真实分布而不是全 0。
 * 顺序即优先级：越具体的越靠前（反序列化先于泛化的 rce）。
 */
const TEMPLATE_TAG_CATEGORIES = [
  ['deserialization', ['deserialization', 'deserialize', 'fastjson', 'jackson', 'xstream', 'hessian', 'ysoserial', 'shiro']],
  ['file-upload', ['upload', 'file-upload', 'unrestricted-upload']],
  ['sqli', ['sqli', 'sql-injection']],
  ['xxe', ['xxe']],
  ['ssrf', ['ssrf']],
  ['path-traversal', ['lfi', 'traversal', 'path-traversal', 'file-read', 'arbitrary-file-read', 'directory-traversal']],
  ['weak-password', ['default-login', 'default-credentials', 'weak-password', 'weak-credentials', 'brute-force', 'credential-stuffing']],
  ['auth-bypass', ['auth-bypass', 'authentication-bypass', 'jwt', 'oauth', '2fa-bypass']],
  ['unauthorized', ['unauth', 'unauthorized', 'no-auth']],
  ['privesc', ['privesc', 'privilege-escalation', 'lpe']],
  ['tunnel', ['tunnel', 'socks', 'frp', 'chisel', 'regeorg']],
  ['rce', ['rce', 'command-injection', 'code-injection', 'template-injection', 'ssti', 'ognl', 'expression-injection', 'log4j', 'shellshock', 'jndi']],
]

export function guessTemplateCategory(path, name, tags) {
  const tagSet = new Set(String(tags || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean))
  for (const [code, words] of TEMPLATE_TAG_CATEGORIES) {
    for (const w of words) if (tagSet.has(w)) return code
  }
  /* 无 tags 的少数模板：路径 + 名称兜底 */
  const text = (String(path || '') + ' ' + String(name || '')).toLowerCase()
  if (/deserial|fastjson|jackson|shiro/.test(text)) return 'deserialization'
  if (/file-upload|upload|getshell/.test(text)) return 'file-upload'
  if (/sql-injection|sqli|sql injection/.test(text)) return 'sqli'
  if (/\bxxe\b|xml external/.test(text)) return 'xxe'
  if (/\bssrf\b/.test(text)) return 'ssrf'
  if (/path-traversal|directory-traversal|\blfi\b|local file inclusion|arbitrary file read/.test(text)) return 'path-traversal'
  if (/default-login|default credential|weak password/.test(text)) return 'weak-password'
  if (/auth-bypass|authentication bypass|\bjwt\b/.test(text)) return 'auth-bypass'
  if (/unauth|unauthorized/.test(text)) return 'unauthorized'
  if (/privilege escalation|\bprivesc\b/.test(text)) return 'privesc'
  if (/\brce\b|remote code execution|command injection|code injection/.test(text)) return 'rce'
  if (/(^|\/)exposures?\//.test(text) || /exposure|disclosure|misconfig/.test(text)) return 'info-leak'
  return 'other'
}

/* ------------------------------------------------------------------ 靶标库迁移 */

/**
 * 轻量迁移：给既有库补列。先查 PRAGMA 再 ADD COLUMN，重复执行安全。
 * 只在新增列时执行，因此老靶标库不需要重建。
 */
export function migrate(db) {
  const has = (table, column) => {
    try {
      return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)
    } catch {
      /* 读不到表结构必须返回 false（= "没有这一列"），让 ensure 去尝试 ALTER。
         返回 true 会让迁移被静默跳过，代码随后按新列写 SQL，故障表现为远端 SQL 报错
         而不是迁移失败。 */
      return false
    }
  }
  const ensure = (table, column, ddl) => {
    if (has(table, column)) return false
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`) } catch { /* 并发迁移时忽略 */ }
    return true
  }
  ensure('vuln', 'target', 'TEXT')
  ensure('vuln', 'found_by_agent', 'TEXT')
  ensure('vuln', 'found_at', 'TEXT')
  ensure('port', 'url', 'TEXT')
  ensure('port', 'title', 'TEXT')
  ensure('asset', 'test_status', "TEXT DEFAULT 'untested'")
  ensure('asset', 'test_notes', 'TEXT')
  ensure('asset', 'test_surface', 'TEXT')
  ensure('asset', 'test_updated_at', 'TEXT')
  ensure('asset', 'test_updated_by', 'TEXT')
  ensure('asset', 'blocked_count', 'INTEGER DEFAULT 0')
  ensure('asset', 'priority', 'TEXT')
  ensure('asset', 'potential', 'TEXT')
  ensure('asset', 'assess_reason', 'TEXT')
  ensure('asset', 'assessed_at', 'TEXT')
  ensure('asset', 'assessed_by', 'TEXT')
  /* 发现时间：本条资产**第一次进入本库**的时刻（不随重复采集刷新，便于"这条什么时候发现的"）。
     与 first_seen（数据源/工具给出的首次出现时间）不是一回事，两个都留。 */
  ensure('asset', 'discovered_at', 'TEXT')
  /* 产出这条记录的智能体角色（recon/assess/vuln-scan/exploit/internal），
     报告要写清"谁发现的、怎么拿到的" */
  ensure('vuln', 'agent', 'TEXT')
  ensure('credential', 'agent', 'TEXT')
  ensure('webshell', 'agent', 'TEXT')
  ensure('tunnel', 'agent', 'TEXT')
  /* 攻击步骤：用了什么工具/命令、由谁记录。报告里"隧道怎么搭的、马怎么上的"靠这三列说清 */
  ensure('attack_step', 'tool', 'TEXT')
  ensure('attack_step', 'agent', 'TEXT')
  ensure('attack_step', 'result', 'TEXT')
  /* 内外网维度：internal（内网/私网地址）| external（互联网可达）。手工指定优先于自动推导 */
  ensure('asset', 'scope', 'TEXT')
  /* 通过这个漏洞拿到了什么：账号权限 / 服务器权限 / 内网隧道 / 得分点等 */
  ensure('vuln', 'gained', 'TEXT')
  /* 人工复核：AI 只写 candidate / exploited（发现与复现）；confirmed / false-positive / fixed
     是人的判定，带理由与时间。报告和 AI 都读这一份，避免「AI 自己确认、自己交付」。 */
  ensure('vuln', 'review_note', 'TEXT')
  ensure('vuln', 'reviewed_at', 'TEXT')
  ensure('vuln', 'reviewed_by', 'TEXT')
  /* 凭据明文：面板要直接显示口令，不再只存引用（库在本机，禁止导出/提交） */
  ensure('credential', 'secret_value', 'TEXT')
  /* 攻击链已推倒重来：老的五阶段行整体作废，attck 列移除 */
  try {
    /* 注意：'target' 在新老两版里同名，必须按名称区分，否则第二次打开会把新版阶段删掉 */
    db.prepare("DELETE FROM stage WHERE code IN ('external','foothold','tunnel','privilege')").run()
    db.prepare("DELETE FROM stage WHERE code = 'target' AND name = '靶标系统权限'").run()
    db.prepare("DELETE FROM stage WHERE code NOT IN ('recon','internet','boundary','internal','target')").run()
  } catch { /* 表还不存在，忽略 */ }
  if (has('stage', 'attck')) {
    try { db.exec('ALTER TABLE stage DROP COLUMN attck') } catch { /* 老 SQLite 不支持则保留 */ }
  }
  /* 攻击步骤上的阶段：老值是上一版的阶段 code，清掉以便按 legacy stage 重新映射。
     注意：'target' 在新版里仍是合法阶段（⑤ 靶标权限），不能一起清——否则每次打开
     靶标都会把「显式指定 ⑤」的步骤打回自动推导。 */
  try {
    db.prepare("UPDATE attack_step SET stage_code = NULL WHERE stage_code IN ('external','foothold','tunnel','privilege')").run()
  } catch { /* 忽略 */ }
  /* 蓝队视角已从作战阶段中移除：老库把这一列删掉（失败则忽略，不影响使用） */
  if (has('stage', 'blue_team')) {
    try { db.exec('ALTER TABLE stage DROP COLUMN blue_team') } catch { /* 老 SQLite 不支持则保留 */ }
  }
  ensure('attack_step', 'stage_code', 'TEXT')
  /* 隧道入口归属：判断这条通道有没有真的跨越靶标边界（self-only 不算突破） */
  /* 老库回填：按 IP 归属自动区分内外网 */
  try {
    db.exec(`UPDATE asset SET scope = (${SCOPE_SQL}) WHERE scope IS NULL OR scope = ''`)
  } catch { /* 首次建库时表为空，忽略 */ }
  /* 老库回填发现时间：没有 discovered_at 的用 first_seen 顶上（总比空白好） */
  try {
    db.exec("UPDATE asset SET discovered_at = COALESCE(first_seen, last_seen) WHERE discovered_at IS NULL OR discovered_at = ''")
  } catch { /* 忽略 */ }
  /* 覆盖分类改名：旧类名合并到当前类名，重复项保留已有结论。 */
  try {
    db.exec("UPDATE OR IGNORE coverage SET test_class = 'authn' WHERE test_class = 'identity'")
    db.exec("UPDATE OR IGNORE coverage SET test_class = 'authz' WHERE test_class IN ('object', 'control', 'signature')")
    db.exec("UPDATE OR IGNORE coverage SET test_class = 'injection' WHERE test_class = 'exec'")
    db.exec("DELETE FROM coverage WHERE test_class IN ('identity', 'object', 'control', 'signature', 'exec')")
  } catch { /* 表还不存在，忽略 */ }
}

/* ------------------------------------------------------------------ 知识库迁移 */

/**
 * 知识库轻量迁移：给既有 knowledge.db 补列（归类 / 来源溯源）。
 * 与靶标库迁移同样先查 PRAGMA 再 ADD COLUMN，重复执行安全、老库不用重建。
 */
export function migrateKnowledge(db) {
  const has = (column) => {
    try {
      return db.prepare('PRAGMA table_info(poc)').all().some((row) => row.name === column)
    } catch { return true }
  }
  const ensure = (column, ddl) => {
    if (has(column)) return
    try { db.exec(`ALTER TABLE poc ADD COLUMN ${column} ${ddl}`) } catch { /* 并发迁移时忽略 */ }
  }
  ensure('category', 'TEXT')
  ensure('engagement_id', 'TEXT')
  ensure('engagement_name', 'TEXT')
  ensure('asset_target', 'TEXT')
  ensure('found_by_agent', 'TEXT')
  try { db.exec('CREATE INDEX IF NOT EXISTS ix_poc_category ON poc(category)') } catch { /* 忽略 */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS ix_poc_engagement ON poc(engagement_id)') } catch { /* 忽略 */ }
  /* 老条目没有归类：按 code/标题/组件的关键词推一个（推测逻辑只有一份，见 guessPocCategory） */
  try {
    const rows = db.prepare("SELECT id, code, title, component FROM poc WHERE COALESCE(category, '') = ''").all()
    const upd = db.prepare('UPDATE poc SET category = ? WHERE id = ?')
    for (const row of rows) {
      upd.run(guessPocCategory([row.code, row.title, row.component].filter(Boolean).join(' ')), row.id)
    }
  } catch { /* 忽略 */ }
}
