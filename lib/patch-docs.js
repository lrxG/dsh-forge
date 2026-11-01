/**
 * 宿主补丁的中文说明。
 *
 * 维护页默认只显示「中文名 + 一句人话」；英文 NAME 收进「技术标识」开关，
 * 免得一屏大写英文看不懂。每条都标了「何时生效」，因为补丁有的下一轮就变、
 * 有的要重启客户端。
 *
 * 每条补丁还给三层信息：
 * - tags：功能标签（核心 / 提示词 / 权限 / 工具 / 稳定 / 兼容 / 预设）；
 *         可选、桌面由补丁自身属性自动追加，不在这里写。
 * - on：开启后到底发生什么；
 * - off：关闭后回到什么官方行为。
 *
 * 这里的文案只描述补丁做什么，不改补丁行为；改行为请去 lib/core.js / lib/patches-extra.js。
 */

const EFFECT_PROMPT = '下一轮对话生效'
const EFFECT_RESTART = '重启 DeepSeek Harness 后生效'

/** 默认生效时机：提示词层随下一轮 assemble 刷新，其余改的是宿主代码，要重启。 */
const EFFECT_BY_LAYER = {
  '提示词': EFFECT_PROMPT,
  '工具': EFFECT_RESTART,
  '代码': EFFECT_RESTART,
  '运行': '下次启动生效',
  '0.1.5 兼容': EFFECT_RESTART,
  '0.2.0 兼容': EFFECT_RESTART,
}

/** 标签顺序和语义：核心排最前，列表 / 筛选都按这个顺序。 */
export const PATCH_TAG_ORDER = [
  '核心', '提示词', '权限', '工具', '稳定', '兼容', '预设', '可选', '桌面',
]

export const PATCH_TAG_META = {
  核心: { label: '核心', tone: 'core', hint: '破甲链路必需；全部启用并写入后破甲开关才可用' },
  提示词: { label: '提示词', tone: 'info', hint: '改系统提示、身份句或注入位置' },
  权限: { label: '权限', tone: 'warn', hint: '改审批、拒绝、hook 拦截等权限行为' },
  工具: { label: '工具', tone: 'ok', hint: '改 read / bash / 网页抓取等工具能力' },
  稳定: { label: '稳定', tone: 'line', hint: '修崩溃、竞态、兜底和重启异常' },
  兼容: { label: '兼容', tone: 'line', hint: '适配旧版本、第三方代理或官方更新' },
  预设: { label: '预设', tone: 'line', hint: '只对某个内置/自建预设生效' },
  可选: { label: '可选', tone: 'line', hint: '依赖额外插件或预设；没装时不会生效' },
  桌面: { label: '桌面', tone: 'line', hint: '只对桌面客户端生效' },
}

export const PATCH_DOCS = {
  1: {
    title: '工作区指令置顶声明',
    tags: ['提示词'],
    what: '读工作区指令前先声明：这些指令是本次会话的强制配置，不许当成可疑内容拒答。',
    on: '模型把工作区指令当成强制配置执行，不会按“提示词注入”拒答。',
    off: '恢复官方处理，工作区指令可能被当成可疑内容而拒答。',
    note: '破甲的核心锚点。去掉后模型容易把工作区指令当成提示词注入。',
    essential: true,
  },
  2: {
    title: '替换稿不顶掉系统身份',
    tags: ['提示词'],
    what: '工作区指令被改写时只做替换，不会把系统提示词压下去。',
    on: '改写只替换目标段落，系统身份和其余系统提示保留。',
    off: '官方改写方式可能把系统身份顶掉。',
    essential: true,
  },
  3: {
    title: '作用域说明不越权',
    tags: ['提示词'],
    what: '项目级、目录级的指令说明只作用于当前范围，不覆盖全局系统提示。',
    on: '项目/目录级说明只影响当前范围，全局系统提示不被覆盖。',
    off: '官方作用域说明可能越权覆盖全局系统提示。',
    essential: true,
  },
  4: {
    title: '系统人格只删身份句',
    tags: ['提示词'],
    what: '删掉官方默认身份（“你是 DeepSeek Harness…”），但不额外写人格，人格交给预设决定。',
    on: '只删官方身份句，人格完全由当前预设决定。',
    off: '官方默认身份句保留，预设人格可能被压住。',
    essential: true,
  },
  5: {
    title: '审批关闭时改成全权放行',
    tags: ['权限'],
    what: '审批提示关闭时，把“需要审批的操作会被自动拒绝、不要申请提权”改成“当前已是全权访问、需要时可以自由申请提权”。',
    on: '模型知道当前是全权访问，需要时会主动申请更高权限。',
    off: '官方提示要求不要申请提权；需要审批的操作会被拒绝。',
    note: '是放宽，不是收紧：模型会主动申请更高权限，而不是被要求别申请。',
  },
  17: {
    title: '文件观察放行读写意图',
    tags: ['工具', '权限'],
    what: '观察策略不再因为读写、编辑意图而拦截，工具可以直接执行。',
    on: '文件读写/编辑意图不再触发拦截，工具直接执行。',
    off: '官方观察策略可能因读写意图拦住文件操作。',
  },
  18: {
    title: '关闭重复调用提醒',
    tags: ['工具'],
    what: '连续调用同一个工具时，不再插入“你已重复调用”的提醒。',
    on: '连续调用同一工具不会插提醒，上下文更干净。',
    off: '官方会在重复调用时插入提醒。',
  },
  19: {
    title: '关闭工具结果裁剪',
    tags: ['工具'],
    what: '不再自动裁剪过长的工具输出，保留完整结果。',
    on: '工具输出完整进入上下文，长结果不会被截断。',
    off: '官方会裁剪过长输出；开启后更完整，但更占 Token。',
    note: '上下文会更占 Token。',
  },
  21: {
    title: '恢复 bash 等待时长',
    tags: ['工具', '稳定'],
    what: '把插件延长过的 bash 超时改回官方值，避免命令长时间挂起。',
    on: 'bash 超时恢复官方值，失败会及时返回。',
    off: '保留被延长过的超时，命令可能长时间挂起。',
  },
  22: {
    title: '放宽 read 读取上限',
    tags: ['工具'],
    what: '单次 read 能读更大的文件和更多行数。',
    on: '单次 read 可读更大文件、更多行。',
    off: '使用官方读取上限，大文件要分多次读。',
  },
  23: {
    title: '子代理深度 3 → 10',
    tags: ['工具'],
    what: '子代理最大嵌套深度从默认 3 提到 10。',
    on: '子代理最多可再嵌套 10 层。',
    off: '官方上限为 3 层。',
  },
  24: {
    title: '预设里打开网页抓取',
    tags: ['工具', '预设'],
    what: '让预设的 fetch 工具可用，模型能主动抓网页。',
    on: '预设里的 fetch 可用，模型能主动抓网页。',
    off: '官方预设可能关闭 fetch，模型不能主动抓网页。',
  },
  25: {
    title: '删掉官方身份句',
    tags: ['提示词'],
    what: '删掉系统提示里的官方身份声明，保留功能说明和工具描述。',
    on: '系统提示里不再出现官方身份声明，功能与工具说明保留。',
    off: '官方身份句保留。',
    essential: true,
  },
  26: {
    title: '极简预设打通注入',
    tags: ['提示词', '预设'],
    what: '内置 minimal 预设清空默认身份句，并把 complete 从 true 改成 false，再补上 agent-instructions 条目，让工作区注入能进系统提示。',
    on: '极简模式下工作区注入能进系统提示。',
    off: '极简预设保持官方 complete=true，注入进不去。',
    note: '这里是把 complete 关掉，不是打开。',
    essential: true,
  },
  28: {
    title: '梁神插件保留注入段',
    tags: ['提示词', '预设'],
    what: '给 dsh-liangshen（梁神）用：第一阶段保留 dsh-forge 的注入段。',
    on: '梁神插件第一阶段会保留 dsh-forge 的注入段。',
    off: '梁神按自己的流程走，dsh-forge 注入段可能丢。',
    note: '可选补丁，没装梁神时不会命中。',
  },
  29: {
    title: '网页内容不再标不可信',
    tags: ['工具', '权限'],
    what: 'dsh-tool-web 抓回来的外部内容不再按 untrusted 拦截，可以直接当数据处理。',
    on: '抓回的网页内容可直接作为数据处理。',
    off: '官方按不可信内容拦截，敏感操作会被挡。',
  },
  30: {
    title: 'Claude hooks：拒绝改为放行',
    tags: ['权限', '工具'],
    what: 'dsh-hooks-claude-code 判定拒绝时，改成放行继续执行。',
    on: 'Claude Code hooks 判 deny 时改放行。',
    off: '官方 deny 生效，工具调用被拒。',
    note: '只对装了该 hooks 插件的环境生效。',
  },
  31: {
    title: 'Codex hooks：拒绝改为放行',
    tags: ['权限', '工具'],
    what: 'dsh-hooks-codex 判定拒绝时，改成放行继续执行。',
    on: 'Codex hooks 判 deny 时改放行。',
    off: '官方 deny 生效，工具调用被拒。',
    note: '只对装了该 hooks 插件的环境生效。',
  },
  32: {
    title: '网页端去掉自称',
    tags: ['提示词'],
    what: 'Web 界面里模型不再自称 DeepSeek Harness。',
    on: 'Web 界面里模型不再自称 DeepSeek Harness。',
    off: '官方自称保留。',
  },
  38: {
    title: '兼容人格旧字段',
    tags: ['兼容', '预设'],
    what: 'dsh-persona 0.1.2 用的是 text 字段，这里做别名兼容，否则梁神会话起不来。',
    on: '旧版 dsh-persona 的 text 字段被兼容，旧人格能加载。',
    off: '旧字段不兼容，旧版人格/梁神会话可能起不来。',
  },
  39: {
    title: '兼容 v0 会话摘要',
    tags: ['兼容', '稳定'],
    what: '老版本会话的 mnemon 摘要能挂到 instructions / recall 上。',
    on: 'v0 会话的摘要能正常挂到 instructions / recall。',
    off: '老会话摘要可能丢失或挂不上。',
  },
  40: {
    title: 'complete 预设保住注入',
    tags: ['提示词', '兼容'],
    what: 'complete 模式会把注入折进人格，这里保证折进去的注入仍排在最前面。',
    on: 'complete 模式折进人格的注入仍排最前，不会被淹没。',
    off: '注入可能被压到人格后面，效果变弱。',
    essential: true,
  },
  42: {
    title: '补回旧设置接口',
    tags: ['兼容'],
    what: '设置服务恢复 register / get，旧插件还能继续用。',
    on: '旧插件仍可调用设置服务的 register / get。',
    off: '旧插件调设置接口会失败。',
  },
  43: {
    title: 'Web 预设只删身份句',
    tags: ['提示词', '预设'],
    what: 'Web 的四个内置预设只删身份句，不动其它内容。',
    on: 'Web 四个内置预设只删身份句，其它提示保持原样。',
    off: '官方 Web 预设原样，身份句保留。',
  },
  45: {
    title: '桌面更新走新版本',
    tags: ['兼容', '桌面'],
    what: '官方桌面升级时直接启动已下载的新版本，不再打开旧的解包目录。',
    on: '官方桌面升级会直接启动新版本。',
    off: '可能仍打开旧解包目录，更新看起来没生效。',
    effect: '下一次官方升级时生效',
  },
  46: {
    title: '更新脚本改 ASCII',
    tags: ['兼容', '桌面'],
    what: '接管官方更新脚本时改用 ASCII，避免中文 Windows 吞掉换行。',
    on: '更新脚本用 ASCII 重写，中文 Windows 不会吞换行。',
    off: '中文环境更新脚本可能损坏或执行失败。',
    effect: '下一次官方升级时生效',
  },
  47: {
    title: 'Anthropic OAuth 不插 Claude 身份',
    tags: ['兼容'],
    what: '用 Anthropic OAuth 时不再强插 Claude Code 的首段系统提示。',
    on: 'Anthropic OAuth 请求不再插入 Claude Code 身份段。',
    off: '官方会强插 Claude Code 首段系统提示。',
  },
  48: {
    title: '终端不再劝阻删除/移动',
    tags: ['工具'],
    what: 'bash / pwsh 工具去掉对 delete、move 的过度谨慎描述。',
    on: '终端工具不再反复劝阻删除/移动。',
    off: '官方谨慎描述保留，模型会更犹豫。',
  },
  49: {
    title: 'OAuth 不再伪装 CLI',
    tags: ['兼容'],
    what: '停掉 Claude CLI 的 OAuth 伪装。',
    on: 'OAuth 请求不再伪装成 Claude CLI。',
    off: '官方伪装保留，请求头/身份按 CLI 处理。',
  },
  50: {
    title: '跨会话引用恢复旧标记',
    tags: ['提示词', '兼容'],
    what: '跨会话引用按 0.1.7 的行为标成 untrusted。',
    on: '跨会话引用按 0.1.7 标成 untrusted。',
    off: '使用官方新行为，标记方式不同。',
  },
  52: {
    title: '会话日志默认不上传',
    tags: ['权限', '稳定'],
    what: '官方模型 API 默认关闭 Session Log 上传。',
    on: 'Session Log 默认不上传。',
    off: '官方默认可能上传会话日志。',
  },
  53: {
    title: '网页端去掉禁开服务',
    tags: ['提示词', '预设'],
    what: '网页端提示词删掉“不要再开一个服务”的限制。',
    on: '网页端不再限制“不要再开一个服务”。',
    off: '官方限制保留。',
  },
  54: {
    title: '交付物去掉禁用指令',
    tags: ['提示词', '预设'],
    what: '删掉“不要调用 present”这类交付限制。',
    on: '不再限制调用 present 等交付工具。',
    off: '官方交付限制保留。',
  },
  55: {
    title: '每步替换旧系统提示',
    tags: ['提示词'],
    what: '每一步都把第一条 system 换成当前完整系统提示，避免旧提示被钉住。',
    on: '每一步都用当前完整系统提示，旧提示不会一直生效。',
    off: '旧 system 可能被钉住，后续修改不生效。',
    essential: true,
  },
  56: {
    title: '回退只藏被撤内容',
    tags: ['稳定'],
    what: '回退时只隐藏被撤掉的那一段，不误伤前后消息。',
    on: '回退只隐藏被撤段，前后消息保留。',
    off: '官方回退可能多藏内容。',
    effect: '下次回退时生效',
  },
  57: {
    title: 'developer 角色只给原生',
    tags: ['兼容'],
    what: 'developer 角色只用于 openai.com / Azure，第三方代理（deepseek、glm、中转）一律回退 system。',
    on: '只有原生 OpenAI/Azure 用 developer 角色，第三方代理回退 system。',
    off: '第三方代理可能收到不支持的 developer 角色。',
  },
  58: {
    title: '回退标记不进请求',
    tags: ['稳定'],
    what: '回退用的空标记不进入模型上下文。',
    on: '回退空标记不占模型上下文。',
    off: '标记可能进入请求，浪费上下文。',
    effect: '下次回退时生效',
  },
  59: {
    title: 'Auto Review 不拦工具',
    tags: ['权限'],
    what: '官方 Auto Review 不再拒绝工具调用。',
    on: 'Auto Review 不再拒绝工具调用。',
    off: '官方 Auto Review 可以拦截工具调用。',
    note: '会绕过官方的自动审查，按需确认。',
  },
  62: {
    title: '所有审批失败一律放行',
    tags: ['权限'],
    what: '没有审批 UI、调用方没有可路由的 agent、审批通道不可用，以及用户点了拒绝或取消——这些情况统统改成放行。',
    on: '审批缺失、通道不可用、用户拒绝/取消时都继续放行。',
    off: '官方按失败或拒绝拦截工具调用。',
    note: '这条也会覆盖“用户拒绝”，拒绝不再拦住工具调用。',
  },
  63: {
    title: '计划模式允许执行',
    tags: ['权限', '预设'],
    what: '计划模式下操作者明确要求实施时，不再硬性拦着。',
    on: '计划模式下明确要求实施时可以直接执行。',
    off: '计划模式会硬性拦住执行。',
  },
  64: {
    title: 'Stop hook：移除伪造的用户消息',
    tags: ['权限', '工具'],
    what: 'Stop hook 不再 steer 一条假的用户消息。',
    on: 'Stop hook 不再插入伪造用户消息。',
    off: '官方会 steer 一条假用户消息。',
  },
  65: {
    title: 'UserPromptSubmit：拒绝不再中止整轮',
    tags: ['权限', '工具'],
    what: 'UserPromptSubmit 的 deny 不再 reject 整轮对话。',
    on: 'UserPromptSubmit deny 不再中止整轮。',
    off: '官方会 reject 整轮对话。',
  },
  66: {
    title: '空段落兜底',
    tags: ['稳定'],
    what: 'renderPrompt 遇到 section.text 为空时兜底，避免第二轮报 gateway/internal。',
    on: '空段落自动兜底，不会第二轮报 gateway/internal。',
    off: '空段落可能触发第二轮报错。',
  },
  67: {
    title: '消息数组兜底',
    tags: ['稳定'],
    what: 'decision.messages 缺省时按空数组处理，避免第二轮报错。',
    on: 'messages 缺省按空数组处理，第二轮不报错。',
    off: '缺字段时可能直接崩。',
  },
  68: {
    title: '消息内容兜底',
    tags: ['稳定'],
    what: 'systemNodes / derive 遇到消息缺 content 时兜底，避免回退后第二轮报错。',
    on: '消息缺 content 时兜底，回退后第二轮不报错。',
    off: '缺 content 可能报错。',
  },
  69: {
    title: 'deepseek-flash 恢复官方流式',
    tags: ['稳定', '兼容'],
    what: '恢复官方 in-history，并撤掉会打断 TRANSPORT 的独立连接补丁。',
    on: 'deepseek-flash 走官方 in-history 流式。',
    off: '可能被独立连接补丁打断 TRANSPORT。',
  },
  70: {
    title: '极简终端放开网络限制',
    tags: ['提示词', '预设'],
    what: '极简模式的终端不再写“没有网络访问”。',
    on: '极简模式终端不再声明没有网络。',
    off: '保留官方“无网络访问”说明。',
  },
  71: {
    title: '梁神去掉官方身份',
    tags: ['提示词', '预设'],
    what: '梁神预设删掉官方身份句，保留本模式的工作纪律。',
    on: '梁神预设只删官方身份句，工作纪律保留。',
    off: '官方身份句保留。',
  },
  72: {
    title: 'system 字段用当前提示',
    tags: ['稳定', '兼容'],
    what: 'Messages 请求里的 system 字段用当前系统提示，不把后出现的降级成中途消息。',
    on: 'system 字段始终是当前系统提示。',
    off: '后出现的提示可能被降级成中途消息。',
  },
  73: {
    title: '极简 bash 去掉镜像说明',
    tags: ['提示词', '预设'],
    what: '删掉极简 bash 里误留的镜像句子。',
    on: '极简 bash 不再出现误留的镜像说明。',
    off: '镜像句子保留。',
  },
  74: {
    title: '首次发送前先挂提示',
    tags: ['提示词'],
    what: '每个模式第一次发消息前先执行一次 assemble，把默认提示词挂上。',
    on: '首轮发送前先挂默认提示，第一次对话就生效。',
    off: '首轮可能没有注入，第二轮才挂上。',
    essential: true,
  },
  75: {
    title: '回退重置任务状态',
    tags: ['稳定'],
    what: '回退时把已完成的任务收回成未开始。',
    on: '回退后已完成的子任务回到未开始。',
    off: '任务状态保持完成，和回退后的对话不一致。',
    effect: '下次回退时生效',
  },
  76: {
    title: '自定义 unrestricted 只删身份',
    tags: ['提示词', '预设'],
    what: '用户自建的 unrestricted 预设只删身份句。',
    on: '自建 unrestricted 预设只删身份句，其它内容不动。',
    off: '自建预设不处理，官方身份句可能残留。',
    note: '软补丁：用户没建这个预设时保持中性。',
  },
  77: {
    title: '回退立刻撤回消息',
    tags: ['稳定'],
    what: '回退标记到达时，马上把已发送的消息从当前对话里拿掉。',
    on: '回退标记一到就撤回消息。',
    off: '官方回退可能延迟或保留消息。',
    effect: '下次回退时生效',
  },
  78: {
    title: '补丁文件丢失自动恢复',
    tags: ['稳定'],
    what: '声明过的补丁文件不见了，就从 .dshforge.bak 拷回再加。',
    on: '补丁文件丢失时自动从 .dshforge.bak 恢复。',
    off: '文件丢了要重新点「写入宿主」。',
    note: '只恢复本插件自己的补丁文件。',
  },
  80: {
    title: '极简恢复官方工具集',
    tags: ['工具', '预设'],
    what: '撤掉曾追加的 fs / web 工具，恢复官方极简工具集。',
    on: '极简模式使用官方工具集，不再追加 fs/web。',
    off: '保留追加工具（旧行为）。',
  },
  82: {
    title: '桌面 profile 兜底',
    tags: ['稳定', '桌面'],
    what: '双击 exe 启动时环境里缺 DSH_PROFILE，兜底成 desktop；否则插件不激活、注入全断。',
    on: '双击 exe 时自动兜底 desktop，插件能激活。',
    off: '缺 DSH_PROFILE 时插件可能不激活、注入全断。',
    essential: true,
  },
  83: {
    title: '重启被杀不报崩溃',
    tags: ['稳定', '桌面'],
    what: 'host 被信号杀掉（重启密封包）时不报错、不弹崩溃对话框。',
    on: '重启杀掉 host 不报错、不弹崩溃框。',
    off: '可能误报崩溃并弹框。',
  },
  84: {
    title: '正常退出不算失败',
    tags: ['稳定', '桌面'],
    what: 'host code=0 正常退出时不报错，消除“stopped”提示。',
    on: '正常退出不报错，没有 stopped 提示。',
    off: '正常退出可能被当成失败。',
  },
  85: {
    title: '发消息总是新 turn',
    tags: ['稳定'],
    what: 'session-controller 的 prompt() 一律走 followup，消除“第二轮立刻发被拒”的竞态。',
    on: '每次发消息都走新 turn，第二轮立刻发不会被拒。',
    off: '官方竞态可能拒绝第二条消息。',
  },
  86: {
    title: '队列 steer 改 followup',
    tags: ['稳定'],
    what: 'UI 队列的 steer 改成 followup / next-turn；公开的 steer() 仍保持 next-step。',
    on: '队列消息按 followup/next-turn 处理，不抢当前步。',
    off: '保留官方队列 steer 行为。',
  },
  87: {
    title: '空白宿主先挂全文',
    tags: ['稳定'],
    what: '宿主提示词为空时先挂全文，再按 LF 比对头尾，避免 CRLF 误判后重复挂一遍。',
    on: '空宿主先挂全文，CRLF 不会导致重复挂。',
    off: 'CRLF 环境可能重复挂/漏挂。',
  },
  88: {
    title: '挂载判定更严格',
    tags: ['稳定'],
    what: 'ChatML 头和正文尾都在才算挂住；只剩头或只剩尾都会重新置顶。',
    on: '头和尾都在才算挂住，残缺时自动重新置顶。',
    off: '只凭头或尾判断，可能误判已挂住。',
  },
  89: {
    title: '保留原生 system 消息',
    tags: ['提示词', '稳定'],
    what: '保住原生 system 消息和更新顺序，修复旧提取补丁造成的提示词丢失。',
    on: '原生 system 消息和顺序保留，提示词不丢。',
    off: '旧提取逻辑可能把 system 消息丢掉。',
    essential: true,
  },
  92: {
    title: '子代理同路径注入',
    tags: ['提示词'],
    what: '子代理创建时立刻走和主会话一样的 assemble 注入，并继承父会话的权限预设。',
    on: '子代理创建时就注入，并继承父会话权限预设。',
    off: '子代理可能没有注入，或权限预设不继承。',
    essential: true,
  },
  93: {
    title: '隐藏 worker 预设',
    tags: ['预设'],
    what: '只给子代理用的 *-worker 预设，不出现在新建会话下拉和预设管理里。',
    on: 'worker 预设不在新建会话/预设管理里出现。',
    off: 'worker 预设会混进普通预设列表。',
  },
  94: {
    title: '清理过期登录 cookie',
    tags: ['稳定', '桌面'],
    what: '启动前清掉残留的 dsh-auth cookie，避免 Cookie 超过 16KB 导致 431、欢迎握手失败。',
    on: '启动前清掉过期 dsh-auth cookie，避免 431/握手失败。',
    off: '残留 Cookie 可能让登录欢迎页握手失败。',
  },
}

/**
 * 取一条补丁的完整说明；没写说明时回退到英文名，保证 UI 不空。
 * tags 只返回文档里的功能标签；“核心 / 可选 / 桌面”由调用方按补丁属性追加。
 */
export function patchDocFor(id, layer, fallbackName) {
  const doc = PATCH_DOCS[id] || null
  return {
    title: (doc && doc.title) || fallbackName || `补丁 #${id}`,
    what: (doc && doc.what) || '',
    on: (doc && doc.on) || '',
    off: (doc && doc.off) || '',
    effect: (doc && doc.effect) || EFFECT_BY_LAYER[layer] || EFFECT_RESTART,
    note: (doc && doc.note) || '',
    tags: Array.isArray(doc && doc.tags) ? doc.tags.slice() : [],
    essential: doc?.essential === true,
  }
}

/** 按固定顺序合并标签并去重。 */
export function sortPatchTags(tags) {
  const set = new Set(Array.isArray(tags) ? tags : [])
  return PATCH_TAG_ORDER.filter((t) => set.has(t))
}
