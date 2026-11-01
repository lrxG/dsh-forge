/**
 * 技能修复文案（零依赖，纯 ESM）
 *
 * 用途：给控制台「技能库」页签用 —— 每个**不可用**的技能都要能直接告诉用户"怎么修"，
 * 而不是只报"缺什么"。`skill-availability.js` 负责判定（缺环境变量 / 缺工具 / 占位符没填 / 被同名技能盖住），
 * 这里负责把每一类判定翻译成可执行的中文步骤：
 *   · `TOOL_FIXES`   —— 逐工具的装法
 *   · `SKILL_FIXES`  —— 逐技能的额外修复步骤（FOFA_KEY、VPS 地址、浏览器扩展…）
 *   · `toolNameOfPath` / `fixesForIssue` —— 把"某个路径不存在"这类判定转成具体建议
 *
 * 文案约定：中文、一句话说清"这是什么/怎么补"、命令一律用反引号包住、不编造 URL 与版本号、
 * 正文不用 markdown 强调符（面板按纯文本渲染）。`fixesForIssue()` 按判定分支给出的建议是**单行**的
 * （当列表项渲染不会塌）；回退到 `SKILL_FIXES` 时可能带换行 —— 技能文案允许 1–3 行。
 */

/** 工具统一放这里，由用户在「环境适配」填路径或选整包文件夹自动分配。 */
const TK = '`$DSH_HOME/redteam/toolkit/`'

/** 完全不知道缺什么时的兜底建议。 */
const GENERIC_FIX = '在红队面板「环境适配」填工具路径或选整包文件夹自动分配，'
  + '改了 `$DSH_HOME/.env` 后重启 DeepSeek Harness 服务 才生效；仍不行就重新安装 redteam 插件再体检一次。'

/** 工具箱附件实际装了什么。不要写成「缺了就从附件里解出来」。 */
const TOOLKIT_TARBALL = '上游 dsh-redteam-mode 的 release 资产 `dsh-redteam-mode-<版本>-toolkit.tar.gz`（里面只有 README 与若干技能 md，不含二进制或脚本）'

/* ── 逐工具修法 ───────────────────────────────────────────────────────────── */

const FRP_FIX = {
  what: 'frp 内网穿透：`frps` 跑在 VPS 上做服务端，`frpc` 跑在目标上做客户端（同一个 release 包里的两个二进制）',
  install: '从 fatedier/frp 的 GitHub releases 取 Windows 包，把 `frpc.exe` 与 `frps.exe` 放到 ' + TK + 'frp/',
}

const LIGOLO_FIX = {
  what: 'ligolo-ng TUN 隧道（`proxy` 服务端 + `agent` 目标侧），chisel/frp 之外的备选通道',
  install: '从 nicocha30/ligolo-ng 的 GitHub releases 取 Windows 包，`proxy.exe` 与 `agent.exe` 放到 ' + TK + 'ligolo/',
}

export const TOOL_FIXES = {
  /* ── 需要单独下载到 toolkit/ 的二进制 ── */
  fscan: {
    what: '内网综合扫描（存活/端口/服务识别/28 类弱口令/未授权/高危漏洞，v2.2.1）',
    install: '从 shadow1ng/fscan 的 GitHub releases 取 Windows 版，放进 ' + TK + 'fscan/（`fscan.exe`）',
  },
  suo5: {
    what: 'suo5：通过 WebShell/HTTP 建立 SOCKS5 隧道的内网突破核心工具（v2.2.0，静态 Go 无依赖）',
    install: '从 zema1/suo5 的 GitHub releases 取 Windows 版，放到 ' + TK + 'suo5/（`suo5.exe`）',
  },
  chisel: {
    what: 'chisel HTTP 隧道（服务端与客户端是同一个二进制，v1.12.0）',
    install: '从 jpillora/chisel 的 GitHub releases 取 Windows 版，放到 ' + TK + 'chisel/（`chisel.exe`）',
  },
  frp: FRP_FIX,
  frpc: FRP_FIX,
  frps: FRP_FIX,
  subfinder: {
    what: '被动子域枚举（ProjectDiscovery，v2.16.0，多源聚合）',
    install: '从 projectdiscovery/subfinder 的 GitHub releases 取 Windows 包，`subfinder.exe` 放到 ' + TK + 'subfinder/',
  },
  dnsx: {
    what: '批量 DNS 解析/爆破/泛解析过滤（ProjectDiscovery，v1.3.1）',
    install: '从 projectdiscovery/dnsx 的 GitHub releases 取 Windows 包，`dnsx.exe` 放到 ' + TK + 'dnsx/',
  },
  naabu: {
    what: '高速端口扫描（ProjectDiscovery，v2.6.1）',
    install: '从 projectdiscovery/naabu 的 GitHub releases 取 Windows 包，`naabu.exe` 放到 ' + TK + 'naabu/',
  },
  httpx: {
    what: 'HTTP 存活/标题/状态码/技术栈探测（ProjectDiscovery 版，v1.12.0）',
    install: '从 projectdiscovery/httpx 的 GitHub releases 取 Windows 包，`httpx.exe` 放到 ' + TK + 'httpx/',
  },
  ksubdomain: {
    what: '无状态子域爆破（knownsec ksubdomain v0.7，比 dnsx 爆破快）',
    install: '从 knownsec/ksubdomain 的 GitHub releases 取 Windows 包，`ksubdomain.exe` 放到 ' + TK + 'ksubdomain/',
  },
  ligolo: LIGOLO_FIX,
  'ligolo-proxy': LIGOLO_FIX,
  'ligolo-agent': LIGOLO_FIX,
  gowitness: {
    what: '批量网页截图留证（sensepost/gowitness）',
    install: '从 sensepost/gowitness 的 GitHub releases 取 Windows 版，放到 ' + TK + 'gowitness/（`gowitness.exe`）—— '
      + '注意下载必须完整（截断的二进制文件在，跑起来却零输出）',
  },
  oneforall: {
    what: 'OneForAll 子域收集全家桶（v0.4.5，源码 + 虚拟环境，慢但全）',
    install: '把源码解到 ' + TK + 'oneforall/OneForAll-0.4.5/ 并建好虚拟环境装依赖；'
      + '装不上不影响主线 —— 用 `subfinder` + `ksubdomain` 替代即可',
  },
  vps: {
    what: 'VPS 登录方式（`REDTEAM_VPS_HOST` / `REDTEAM_VPS_KEY`）与中转脚本：反弹 Shell、载荷投递、隧道出口的落地端',
    install: '在「环境适配」填 VPS 地址与私钥路径；私钥放 ' + TK + 'vps/id_rsa（连通性用 '
      + '`ssh -i <私钥> -o BatchMode=yes <user>@<ip> "echo ok"` 验）；'
      + '中转脚本按技能 `vps-reverse-shell` 的子命令自己写（至少要有 `serve <port>` 和 `exec`）',
  },
  'nuclei-templates': {
    what: 'nuclei 模板库（13,000+ 模板，`nuclei -t` 与 `redteam_poc_search` 都靠它）',
    install: '跑 `nuclei -update-templates`（频率不超过每周一次），装到 `~/.local/nuclei-templates`；'
      + '模板数少于 1000 说明没下全，重跑一次并 `nuclei -tl` 确认模板库没坏',
  },

  /* ── 技能里引用、工具箱附件里也没有 ── */
  dirsearch: {
    what: '目录/文件爆破（Python，v0.5.0，字典全、报告友好）',
    install: '从 maurosoria/dirsearch 的 GitHub releases 取源码包，放到 ' + TK + 'dirsearch/；'
      + '临时可用 `feroxbuster` / `ffuf` / `gobuster` 顶上',
  },
  behinder: {
    what: '冰蝎 v4.1 客户端 + 加密马模板（`toolkit/Behinder/server/*.jsp|php|aspx`，WebShell 交付主力）',
    install: TOOLKIT_TARBALL + '。到冰蝎发布页自行取客户端，放到 ' + TK + 'Behinder/；'
      + '只需要马模板时保持 `toolkit/Behinder/server/` 七个模板在位即可；客户端需要 Java',
  },
  godzilla: {
    what: '哥斯拉 v4.0.1 客户端（`godzilla.jar`，GUI 生成 JSP/PHP/ASPX 全加密 payload）',
    install: TOOLKIT_TARBALL + '。到哥斯拉发布页自行取 `godzilla.jar`，放到 ' + TK + 'Godzilla/；启动需要 Java 与图形会话',
  },
  antsword: {
    what: '中国蚁剑 AntSword（Loader + 源码目录，首次启动要选源码目录）',
    install: TOOLKIT_TARBALL + '。到 AntSword 官方仓库取 Windows 版 Loader 与源码目录，放到 ' + TK + 'AntSword/',
  },
  netexec: {
    what: 'netexec（nxc）内网横向/协议枚举工具（`toolkit/netexec/`）',
    install: '工具箱放在 ' + TK + 'netexec/；缺失就按官方文档 `pipx install netexec`',
  },

  /* ── 技能里出现、但工具箱不管的本机脚本/二进制 ── */
  'pd-httpx': {
    what: 'ProjectDiscovery httpx 的包装入口 —— 避免与 Python httpx 库的 CLI 撞名',
    install: '先按 `httpx` 条目装好，再把它加入 PATH 或改名调用；'
      + '不要指望本机存在这个包装脚本，直接用 `httpx.exe` 的绝对路径也可以',
  },

  chromium: {
    what: 'Chromium 内核浏览器（headless 抓渲染后 DOM / 截图 / 生成 PDF 的零依赖方案）',
    install: '装 Chrome 或 Chromium 的 Windows 版；用法：`chrome --headless=new --dump-dom <url>`，截图加 `--screenshot=shot.png`',
  },
  'playwright-cli': {
    what: 'Playwright CLI（需要点击/等待/多标签页时的浏览器自动化）',
    install: '`npx --yes @playwright/cli@latest`；浏览器缺了跑 `npx playwright install chromium`；'
      + '调用时务必加 `--browser chromium`（默认走 chrome 通道会报 `Chromium distribution \'chrome\' is not found`）',
  },

  /* ── 系统工具（缺了用 winget / scoop / choco 或官方安装包补） ── */
  nmap: {
    what: '端口/服务/脚本扫描（主动扫描主力）',
    install: '从 nmap.org 取 Windows 安装包装上，或用 `winget install Insecure.Nmap`',
  },
  masscan: {
    what: '超高速度端口扫描（大网段铺面，噪声大）',
    install: '从 robertdavidgraham/masscan 的 GitHub releases 取 Windows 版；务必先限定 `--rate` 与扫描网段',
  },
  nuclei: {
    what: '模板化漏洞扫描（Nday/1day 检测主力）',
    install: '从 projectdiscovery/nuclei 的 GitHub releases 取 Windows 版，装完把模板库也补上：`nuclei -update-templates`',
  },
  sqlmap: {
    what: 'SQL 注入检测与利用',
    install: '从 sqlmapproject/sqlmap 取源码包，用本机 Python 跑 `python sqlmap.py`',
  },
  ffuf: {
    what: 'Web fuzz / 目录爆破（最快最灵活，支持多字典、vhost、参数 fuzz）',
    install: '从 ffuf/ffuf 的 GitHub releases 取 Windows 版，或用 `go install github.com/ffuf/ffuf/v2@latest`',
  },
  feroxbuster: {
    what: '递归目录爆破（Rust，自动跟随目录层级，目录爆破首选）',
    install: '从 epi052/feroxbuster 的 GitHub releases 取 Windows 版，或用 `winget install epi052.feroxbuster`',
  },
  gobuster: {
    what: '轻量目录/DNS/vhost 爆破（dir/dns/vhost 三模式）',
    install: '从 OJ/gobuster 的 GitHub releases 取 Windows 版，或用 `go install github.com/OJ/gobuster/v3@latest`',
  },
  hydra: {
    what: '在线弱口令爆破（50+ 协议：SSH/FTP/RDP/SMB/MySQL/MSSQL/Web 表单）',
    install: 'Windows 没有官方构建：用 `nxc` 的对应协议模块替代，或在 WSL 里跑 hydra',
  },
  john: {
    what: 'John the Ripper 离线哈希破解（CPU 路线，适合小字典/规则）',
    install: '从 openwall/john 的 GitHub releases 取 Windows 版（`john-*-jumbo`），自带 `run/` 目录可开箱用',
  },
  hashcat: {
    what: 'hashcat 离线哈希/口令破解（GPU 优先）',
    install: '从 hashcat/hashcat 的 GitHub releases 取 Windows 版；先 `hashcat --identify hashes.txt` 确认模式号（如 NTLM `-m 1000`、Kerberoast `-m 13100`）',
  },
  wpscan: {
    what: 'WordPress 漏洞与用户枚举扫描',
    install: 'Windows 下用 Ruby 装：`gem install wpscan`；需要漏洞库时按提示 `wpscan --update`',
  },
  nikto: {
    what: 'Web 服务器配置与已知问题扫描',
    install: 'Windows 没有官方构建：用 `nuclei` 的通用模板替代，或在 WSL 里跑 nikto',
  },
  whatweb: {
    what: 'Web 指纹识别（CMS/框架/中间件/版本）',
    install: 'Windows 下用 Ruby 装：`gem install whatweb`',
  },
  amass: {
    what: '子域枚举与资产测绘（OWASP Amass）',
    install: '从 owasp-amass/amass 的 GitHub releases 取 Windows 版；被动模式 `amass enum -passive -d <domain>`',
  },
  theharvester: {
    what: '公开源邮箱/子域/主机收集（theHarvester）',
    install: '从 lar)(amies/theHarvester 取源码包，用本机 Python 跑',
  },
  msfconsole: {
    what: 'Metasploit 框架（`exploit/multi/handler` 接收反弹 Shell、`web_delivery` 投递载荷）',
    install: '从 rapid7/metasploit-framework 取 Windows 安装包（`metasploit-framework-*.exe`）；首次用先 `msfdb init`',
  },
  searchsploit: {
    what: '本地 Exploit-DB 检索（按组件/版本找公开 POC）',
    install: '从 offsec/exploitdb 的 GitHub releases 取 Windows 版；更新库用 `searchsploit -u`',
  },
  proxychains4: {
    what: '把单条命令的 TCP 流量代理进内网（配合 socks5 隧道使用）',
    install: 'Windows 用 `proxifier` 或直接在工具里加 `-proxy socks5://127.0.0.1:<port>`，不要改系统全局代理',
  },
  socat: {
    what: '全 TTY 反弹 Shell 监听 / 端口转发',
    install: '从 3ndG4me/socat 的 GitHub releases 取 Windows 版，或用 `winget install socat`',
  },
  nc: {
    what: 'netcat：反弹 Shell 监听与连通性测试（`nc -lvnp <port>`）',
    install: '从 nmap.org 取 Windows 版自带 `ncat.exe`，它就是 netcat 的替代',
  },
  tmux: {
    what: '会话保持：监听与隧道要一直跑着，否则终端一关就丢',
    install: 'Windows 没有 tmux：用 psmux 或单纯把监听进程放后台（PowerShell 的 `Start-Job`）',
  },
  impacket: {
    what: 'Impacket 协议套件（PtH/PsExec/WMI/DCOM/Kerberos/凭据转储）',
    install: '`pipx install impacket`，命令是 `impacket-wmiexec` / `impacket-psexec` / `impacket-secretsdump` / `impacket-GetNPUsers`',
  },
  enum4linux: {
    what: 'SMB/域环境信息枚举（用户、共享、组、密码策略）',
    install: 'Windows 没有原生构建：用 `nxc smb --users --shares --groups --pass-pol` 替代',
  },
  'redis-cli': {
    what: 'Redis 客户端（未授权 Redis 的只读探测与写马）',
    install: '从 redis-windows/redis-windows 的 GitHub releases 取 `redis-cli.exe`',
  },
  mysql: {
    what: 'MySQL/MariaDB 客户端（未授权/弱口令 MySQL 连库取数）',
    install: '装 MySQL 或 MariaDB 的 Windows 客户端，`mysql.exe` 进 PATH 即可',
  },
}

/* ── 逐技能修法 ───────────────────────────────────────────────────────────── */

export const SKILL_FIXES = {
  'active-scan': '装扫描器：`nmap` + `masscan`（见对应条目）；`toolkit/naabu/naabu.exe` 缺就单独下。'
    + '开扫前先限定扫描网段与端口。',

  'asset-correlation': '纯落库/关联技能，不依赖外部工具也不读环境变量；不可用一般是技能文件缺失或插件版本旧 —— '
    + '重新安装 redteam 插件后重启 DeepSeek Harness 服务，再确认 `redteam_asset_link` 工具可用。',

  'browser-automation': '装 Chrome 或 Chromium 的 Windows 版；playwright 路线再 `npx playwright install chromium`。'
    + '调用时务必加 `--browser chromium`（默认走 chrome 通道会报 `Chromium distribution \'chrome\' is not found`）。',

  'chisel-tunnel': '从 jpillora/chisel 取 Windows 版 `chisel.exe`，放到 ' + TK + 'chisel/。\n'
    + '隧道两端要用 VPS：确认 `$DSH_HOME/.env` 里有 `REDTEAM_VPS_HOST` / `REDTEAM_VPS_USER` / `REDTEAM_VPS_KEY`；'
    + '改完 `.env` 必须重启 DeepSeek Harness 服务，安全组记得放行隧道端口。',

  'cn-proxy-pool': '只依赖 `curl` 与 Python（Windows 自带 `curl.exe`）；不可用多为技能文件缺失 —— 重新安装插件后重启 DeepSeek Harness 服务。'
    + '代理只在单条命令上用 `-proxy` / `-x` / `--proxy` 指定，不要动系统代理。',

  'credential-attack': '装 `hydra` 的替代品 `nxc`，再装 `hashcat` 与 `john`（见对应条目）；字典自备。'
    + '本机无 GPU 时 `hashcat` 很慢，优先小字典 + 规则（`-r rules/best64.rule`）。',

  'dir-bruteforce': '装 `feroxbuster` + `ffuf` + `gobuster`（见对应条目）；`toolkit/dirsearch/dirsearch` 要单独取 —— '
    + '从 maurosoria/dirsearch 的 GitHub releases 取源码放到 ' + TK + 'dirsearch/ 并用本机 Python 跑。',

  'fofa-recon': '配 `FOFA_KEY`：<https://fofa.info> 登录 → 个人中心 → API Key。\n'
    + '写进 `$DSH_HOME/.env`（`FOFA_KEY=你的key`）或临时 `set FOFA_KEY=...`，然后重启 DeepSeek Harness 服务 才在本进程生效；'
    + '自测 `curl -s "https://fofa.info/api/v1/info/my?key=%FOFA_KEY%"` 要返回 `"error":false`。',

  'frp-tunnel': '取 Windows 包里的 `frps.exe`、`frpc.exe`，放到 ' + TK + 'frp/。\n'
    + 'VPS 侧要 `REDTEAM_VPS_HOST` / `REDTEAM_VPS_KEY`（`$DSH_HOME/.env`），'
    + '改完重启 DeepSeek Harness 服务，并在云安全组放行 frps 监听端口。',

  'fscan-intranet': '取 fscan 的 Windows 版 `fscan.exe`，放到 ' + TK + 'fscan/。\n'
    + '技能正文里的 `<你的VPS_IP>` 是占位符：在 `$DSH_HOME/.env` 写 `REDTEAM_VPS_HOST=<真实IP>` 后重启 DeepSeek Harness 服务，'
    + '或直接编辑 `$DSH_HOME/skills/fscan-intranet.md` 把占位符换成真实地址（载荷服务：VPS 上跑中转脚本的 `serve 9100`）。',

  'lateral-movement': '`pipx install impacket` + `pipx install netexec`；离线破解装 `hashcat`。'
    + '内网目标的所有命令都要走隧道：给工具加 `-proxy socks5://127.0.0.1:<port>`，不要改系统代理。',

  'nuclei-scan': '装 `nuclei`（见对应条目）；模板库 `~/.local/nuclei-templates` 缺了就 `nuclei -update-templates`。'
    + '更新后先 `nuclei -tl` 确认模板库没坏，模板数少于 1000 说明没下全。',

  'passive-recon': '只依赖 `curl` 与 Python（Windows 自带）；本技能不需要任何 API key。'
    + '不可用一般是技能文件缺失或插件版本旧 —— 重新安装插件后重启 DeepSeek Harness 服务。',

  'recon-pipeline': '一次补齐工具箱：subfinder / dnsx / naabu / httpx / ksubdomain 的 Windows 版都放进 ' + TK + '。\n'
    + '`httpx` 与 Python httpx 库的 CLI 同名，调用时用绝对路径；'
    + 'OneForAll 装不上不影响主线，用 subfinder + ksubdomain 替代。',

  'redteam-setup': '本插件不替用户装工具：在红队面板「环境适配」填工具路径或选整包文件夹自动分配。\n'
    + '配完 `FOFA_KEY` 与 VPS 后重启 DeepSeek Harness 服务，再跑一次 `redteam_preflight` 复核。',

  'shell-handler': '本机监听工具：`ncat`（nmap 自带）、`socat`（见对应条目）；MSF 路线再装 metasploit。\n'
    + 'VPS 变量从 `$DSH_HOME/.env` 读；缺 `REDTEAM_VPS_HOST` 就到「环境适配」补，'
    + '改完 `.env` 必须重启 DeepSeek Harness 服务；监听进程要一直跑着，别让终端关掉把它带走。',

  'suo5-tunnel': '取 suo5 的 Windows 版 `suo5.exe`，放到 ' + TK + 'suo5/。\n'
    + '隧道出口/中转依赖 VPS：`$DSH_HOME/.env` 里配 `REDTEAM_VPS_HOST` / `REDTEAM_VPS_KEY` 后重启 DeepSeek Harness 服务；'
    + '隧道入口的 WebShell 必须是冰蝎马/哥斯拉马（见技能 `webshell-toolkit`），否则用户无法复用。',

  'exposed-services': '装客户端：`redis-cli`、`mysql.exe`、`impacket`（MSSQL 用 `impacket-mssqlclient`）。\n'
    + '内网目标要隧道：先用技能 `suo5-tunnel` 建好 socks5，再给客户端加 `-proxy`；'
    + '`REDTEAM_VPS_HOST` 没配时依赖 VPS 的步骤会被判不可用。',

  'vps-reverse-shell': '填 VPS：在红队面板「环境适配」写 `REDTEAM_VPS_HOST`（`用户@主机`）与 `REDTEAM_VPS_KEY`（私钥路径）。\n'
    + '也可以手动写 `$DSH_HOME/.env` 后重启 DeepSeek Harness 服务，或直接编辑 `$DSH_HOME/skills/vps-reverse-shell.md`，把 `<你的VPS_IP>` / `<VPS 主机名>` 换成真实地址。\n'
    + '连通性用 `ssh -i <私钥> -o BatchMode=yes <user>@<ip> "echo ok"` 验；安全组放行 22 与 9000-9999。',

  'web-fingerprint': '装 PD 版 `httpx.exe`（见 `httpx` 条目），调用时用绝对路径；'
    + '`nuclei` 缺就单独下，技术识别模板库用 `nuclei -update-templates` 补。',

  'webshell-toolkit': '`toolkit/Behinder`、`toolkit/Godzilla`、`toolkit/AntSword` 不在' + TOOLKIT_TARBALL + '：'
    + '到各自的发布页自行取 Windows 版，放到对应目录。\n'
    + 'GUI 需要 Java；无 GUI 时按模板手工换密钥生成冰蝎马（模板在 `toolkit/Behinder/server/`）。',
}

/* ── 内部工具 ─────────────────────────────────────────────────────────────── */

/** 常见扩展名（`fscan.exe`、`godzilla.jar` …）。 */
const EXT_RE = /\.(exe|zip|tar\.gz|tgz|gz|bz2|xz|jar|sh|py|bin|txt|md|json)$/i
/** 平台后缀（`_windows_x64`、`_darwin_arm64` …）。 */
const PLATFORM_RE = /[-_](windows|win32|win64|win|linux|darwin|macos|osx|freebsd)[-_][a-z0-9_.]+$/
/** 架构后缀（裸的 `_amd64` / `-arm64`）。 */
const ARCH_RE = /[-_](amd64|x86_64|x64|arm64|aarch64|arm|386|i386|i686|mips[a-z0-9]*)$/

/**
 * 把二进制/目录名字清成工具名：剥扩展名、剥平台与架构后缀、转小写。
 * 清完不含 ASCII 字母（例如 `清单.md`、纯符号）就返回 null —— 那就不是工具名。
 */
function cleanToolName(raw) {
  let out = String(raw == null ? '' : raw).trim()
  if (out === '') return null
  out = out.replace(EXT_RE, '')
  let prev = ''
  while (out !== '' && out !== prev) {
    prev = out
    out = out.replace(PLATFORM_RE, '').replace(ARCH_RE, '')
  }
  out = out.toLowerCase()
  return /[a-z]/.test(out) ? out : null
}

/** 从一条「路径不存在」的判定里认出工具名；认不出返回 null。 */
export function toolNameOfPath(p) {
  if (typeof p !== 'string') return null
  const s = p.trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[，。；、：,;:)\]}>）】]+$/, '')
    .replace(/\\/g, '/')
  if (s === '') return null
  let candidate = null
  const at = s.lastIndexOf('toolkit/')
  if (at !== -1) {
    candidate = s.slice(at + 'toolkit/'.length).split('/').filter((seg) => seg !== '')[0] || null
  } else if (/\/bin\//.test(s) || /(^|\/)\.local\//.test(s)) {
    const segs = s.split('/').filter((seg) => seg !== '')
    candidate = segs.length > 0 ? segs[segs.length - 1] : null
  } else if (!s.includes('/')) {
    candidate = s
  }
  return candidate === null ? null : cleanToolName(candidate)
}

/** 别名的规范化：`impacket-wmiexec` 这类命令归到 `impacket` 这一条修法上。 */
function canonicalTool(name) {
  const n = String(name || '')
  if (n.startsWith('impacket-')) return 'impacket'
  if (n.startsWith('enum4linux-')) return 'enum4linux'
  return n
}

/** 环境变量怎么拿（拿不准的就不编，直接让用户填值）。 */
const ENV_HINTS = {
  FOFA_KEY: '在 <https://fofa.info> 登录 → 个人中心 → API Key 取；自测 `curl -s "https://fofa.info/api/v1/info/my?key=$FOFA_KEY"` 返回 `"error":false` 即有效',
  REDTEAM_VPS_HOST: '填 VPS 登录地址 `用户@主机`（例如 `ubuntu@203.0.113.10`）',
  REDTEAM_VPS_USER: '填 VPS 登录用户（默认 `ubuntu`）',
  REDTEAM_VPS_KEY: '填 VPS 私钥路径（默认 `$DSH_HOME/redteam/toolkit/vps/id_rsa`，权限必须 `chmod 600`）',
}

function asArray(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.trim() !== '')
  if (typeof v === 'string' && v.trim() !== '') return [v]
  return []
}

/**
 * 由 `skill-availability.js` 的判定生成一条中文修复建议。
 *
 * @param issue - `{ kind, skill, paths?, env?, placeholder? }`，
 *   `kind` ∈ `'file-missing' | 'content-missing' | 'env-missing' | 'path-missing' | 'placeholder' | 'shadowed'`。
 * @returns 一条中文建议（不含换行；命令都在反引号里）。拿不准时回退到 `SKILL_FIXES[skill]`，再回退到通用建议。
 */
export function fixesForIssue(issue) {
  const it = issue && typeof issue === 'object' ? issue : {}
  const kind = typeof it.kind === 'string' ? it.kind : ''
  const skill = typeof it.skill === 'string' ? it.skill : ''
  const skillName = skill === '' ? '<技能名>' : skill
  const skillHint = skill !== '' && Object.prototype.hasOwnProperty.call(SKILL_FIXES, skill) ? SKILL_FIXES[skill] : ''
  const parts = []

  if (kind === 'path-missing') {
    const tools = []
    const seen = new Set()
    for (const p of asArray(it.paths)) {
      const name = toolNameOfPath(p)
      if (name === null) continue
      const canon = canonicalTool(name)
      if (seen.has(canon)) continue
      seen.add(canon)
      tools.push({ name, canon, path: p })
    }
    if (tools.length > 0) {
      const items = tools.map(({ name, canon, path }) => {
        const fix = Object.prototype.hasOwnProperty.call(TOOL_FIXES, canon) ? TOOL_FIXES[canon] : null
        if (fix === null) {
          return '`' + name + '`（' + path + '）：本机没有这个工具，到「环境适配」填路径或选整包文件夹自动分配，'
            + '仍缺就从该工具官方发布页取对应平台二进制放到这个路径'
        }
        return '`' + name + '`（' + path + '）：' + fix.what + '。修法：' + fix.install
      })
      parts.push('缺 ' + tools.length + ' 个工具，逐条修：' + items.join('；'))
      parts.push('拿不准就统一在「环境适配」里选整包文件夹自动分配，再重新体检。')
    }
  } else if (kind === 'env-missing') {
    const names = asArray(it.env)
    if (names.length > 0) {
      const items = names.map((n) => {
        const hint = Object.prototype.hasOwnProperty.call(ENV_HINTS, n) ? ENV_HINTS[n] : '值由你自己提供'
        return '`' + n + '`（' + hint + '）'
      })
      parts.push('缺环境变量：' + items.join('；') + '。')
      parts.push('持久化：在红队面板「环境适配」里填，或写进 `$DSH_HOME/.env`（一行一个 `NAME=值`），'
        + '改完必须重启 DeepSeek Harness 服务 当前进程才读得到。')
    }
  } else if (kind === 'placeholder') {
    const ph = typeof it.placeholder === 'string' && it.placeholder.trim() !== '' ? it.placeholder.trim() : '外部基础设施地址'
    parts.push('技能正文里 `' + ph + '` 还是占位符（说明本环境还没配 VPS）。')
    parts.push('填法：在红队面板「环境适配」填 `REDTEAM_VPS_HOST`（`用户@主机`）与 `REDTEAM_VPS_KEY`（私钥路径），'
      + '或手动写 `$DSH_HOME/.env` 后重启 DeepSeek Harness 服务，也可直接编辑技能正文把这个占位符换成真实地址。')
  } else if (kind === 'shadowed') {
    parts.push('技能被同名版本盖住了：`' + skillName + '` 在别的技能根里还有一份配置更全的同名技能，'
      + '但按当前技能根顺序加载的是排在前面那份不完整的。')
    parts.push('修法：把已配置的那个技能根排到顺序最前面，重启 DeepSeek Harness 服务 后重新体检；不需要另一份就删掉或改名。')
  } else if (kind === 'file-stale') {
    parts.push('技能记录的路径在本机不存在（正文仍能加载，不影响调用）：那是上一次在其他机器上解析出的绝对路径。')
    parts.push('修法：重启一次 DeepSeek Harness 服务（启动会把随包技能同步到 `$DSH_HOME/redteam/skills`）；'
      + '若 `DSH_HOME` 与宿主实际使用的不一致，把它指到宿主真正用的那个再重启。')
  } else if (kind === 'file-missing') {
    parts.push('技能文件不存在：重新安装 redteam 插件覆盖技能文件，然后重启 DeepSeek Harness 服务 再体检一次。')
    parts.push('若是自己放的技能，确认文件在技能根下且文件名与技能名一致（`<技能名>.md`）。')
  } else if (kind === 'content-missing') {
    parts.push('技能正文读不到（只有元数据，判不了可用性）：重新安装 redteam 插件覆盖技能文件；'
      + '若是远端技能源，确认源可达后重新拉取，再重启 DeepSeek Harness 服务。')
    parts.push('临时确认能不能用，直接让智能体用 `skill` 工具加载一次 `' + skillName + '`。')
  }

  if (parts.length === 0) parts.push(skillHint !== '' ? skillHint : GENERIC_FIX)
  return parts.join(' ')
}
