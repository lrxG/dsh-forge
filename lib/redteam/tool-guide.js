/**
 * 常用安全工具的「人话说明」：用途、常用命令、装在哪。
 *
 * 只用于面板展示，不参与工具检测。缺了条目就用默认文案，不会报错。
 * 目的：工具页即使没扫到任何工具，也能告诉用户「这个工具是干嘛的、怎么装」。
 */

export const TOOL_GUIDES = {
  nmap: {
    category: 'scan',
    purpose: '端口与服务识别，确认资产暴露面',
    command: 'nmap -sV -Pn -p- --min-rate 2000 <target>',
    install: 'winget install Insecure.Nmap 或官网下载安装包',
  },
  nuclei: {
    category: 'scan',
    purpose: '模板化漏洞扫描，覆盖常见 CVE 与暴露面',
    command: 'nuclei -u <url> -severity critical,high -stats',
    install: 'go install github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest',
  },
  httpx: {
    category: 'recon',
    purpose: '批量探活、抓标题/状态码/技术指纹',
    command: 'httpx -l hosts.txt -title -tech-detect -status-code -o alive.txt',
    install: 'go install github.com/projectdiscovery/httpx/cmd/httpx@latest',
  },
  dnsx: {
    category: 'recon',
    purpose: '域名解析与泛解析筛查',
    command: 'dnsx -l domains.txt -a -resp',
    install: 'go install github.com/projectdiscovery/dnsx/cmd/dnsx@latest',
  },
  subfinder: {
    category: 'recon',
    purpose: '被动子域名收集',
    command: 'subfinder -d example.com -all -silent',
    install: 'go install github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest',
  },
  ffuf: {
    category: 'web',
    purpose: '目录 / 参数 / 子域名字典爆破',
    command: 'ffuf -u https://target/FUZZ -w dict.txt -mc 200,301,403',
    install: 'go install github.com/ffuf/ffuf/v2@latest',
  },
  fscan: {
    category: 'scan',
    purpose: '内网综合扫描：主机存活、端口、常见服务弱口令',
    command: 'fscan.exe -h 10.0.0.0/24 -p 22,80,443,445,3389',
    install: '下载 fscan.exe 放进工具箱目录',
  },
  chisel: {
    category: 'tunnel',
    purpose: 'HTTP 隧道，做端口转发与内网代理',
    command: 'chisel client http://vps:8080 R:socks',
    install: 'go install github.com/jpillora/chisel@latest',
  },
  suo5: {
    category: 'tunnel',
    purpose: 'HTTP 隧道（suo5 客户端），常配合 WebShell 做内网代理',
    command: 'suo5.exe -t http://target/shell.jsp -l 1080',
    install: '下载 suo5.exe 放进工具箱目录',
  },
  frpc: {
    category: 'tunnel',
    purpose: 'FRP 客户端，把内网端口映射到公网 VPS',
    command: 'frpc.exe -c frpc.ini',
    install: '下载 frp 发行包，取 frpc.exe',
  },
  frps: {
    category: 'tunnel',
    purpose: 'FRP 服务端，接收 frpc 的反向连接',
    command: 'frps.exe -c frps.ini',
    install: '下载 frp 发行包，取 frps.exe',
  },
  impacket: {
    category: 'exploit',
    purpose: 'Windows 域内利用工具集（secretsdump / psexec / wmiexec）',
    command: 'impacket-secretsdump domain/user:pass@10.0.0.10',
    install: 'pip install impacket',
  },
}

/** 系统自带命令：识别出来但默认折叠，不算「安全工具」。 */
export const SYSTEM_COMMANDS = [
  'curl', 'wget', 'python', 'python3', 'powershell', 'pwsh', 'cmd', 'bash', 'sh',
  'nc', 'ncat', 'netcat', 'openssl', 'ssh', 'scp', 'socat', 'git', 'node', 'java',
  'go', 'gcc', 'g++', 'tar', '7z', 'zip', 'unzip', 'findstr', 'grep', 'awk', 'sed',
]

export function toolGuide(id, label) {
  const g = TOOL_GUIDES[id]
  if (g) return g
  return {
    category: '',
    purpose: '',
    command: '',
    install: '',
  }
}

export function isSystemCommand(name) {
  const key = String(name || '').toLowerCase().replace(/\.(exe|cmd|bat)$/i, '')
  return SYSTEM_COMMANDS.includes(key)
}
