/* 门禁与宿主集成（P4 收尾）。
   · 用户须知：首装一次，勾一次不再弹（localStorage）。
   · 红队面板授权：5 秒倒计时 + 声明滚到底 + 三项勾选；授权落在
     $DSH_HOME/redteam/drill-grant.json，卸载时随之清除。
   · 回退：往 conversation.input.right 注入「回退」，走宿主同一份 /dsh-forge/rewind。
   宿主服务由 apply 注入；拿不到时整体降级，不阻断宿主自身功能。 */

const DF_NOTICE_KEY = 'dsh-forge-user-notice-v1'
const DF_AUTH_KEY = 'dsh-forge-drill-auth'
const DF_DRAFT_KEY = 'dshp-rewind-draft:'
const DF_ARM_KEY = 'dshp-rewind-arm:'
const DF_FILL_DELAYS = [0, 50, 180, 400, 800]
const DF_ARM_TTL_MS = 45 * 1000

const DF_LEGAL_HTML = `
<h3>严正法律免责与合规使用声明</h3>
<p>本声明在进入红队面板前必须全文阅读。本项目是非营利开源项目，遵守国家法律法规及所在平台的规范，仅供学习与研究、技术参考。严禁任何主体把本项目用于商业售卖、付费倒卖或黑灰产牟利。</p>
<p>开发者坚决反对并严禁任何形式的违法犯罪，绝不支持、不鼓励、不协助未授权网络攻击、漏洞利用、数据窃取、非法侵入计算机信息系统，或生成违法违禁内容。任何将本项目用于违法犯罪的行为，均与开发者无关，由行为人依法独立承担全部法律责任。不得以科研、教学、测试、演示或内部学习为由规避下列条款。</p>
<h3>1. 本仓库不含违法内容</h3>
<p>SAFE 发布的代码、文档、补丁与默认提示词不是木马、后门、未授权渗透工具、勒索软件、撞库脚本，也不是针对公网或第三方系统的攻击载荷。项目不提供违法内容，也不教唆、组织、协助实施违法犯罪。</p>
<h3>2. 本机操作不构成对外授权</h3>
<p>应用补丁、写入、回滚、卸载，都在本机文件和本机进程内完成。这些操作不对任何公网主机或未授权系统进行扫描、探测、入侵或攻击发包，也不得把本机当作跳板。</p>
<p>插件若开启检测更新，仅可能访问本插件自己的 GitHub 仓库以核对版本。该访问与对第三方系统的网络攻击无关，不能被解释为对外渗透的授权。</p>
<h3>3. 允许使用的范围</h3>
<p>只允许用在你能证明有权处理的环境：本人有权管理的本机官方 Harness；离线的本地合成靶标；所有者已经出具合法书面授权的网络安全演练靶场；合规实验室里的受控环境。书面授权要能对应具体目标、时间和范围。只填写一个单位名称，或只有口头说法，不构成授权。</p>
<p>未经所有者合法书面授权的目标、公网在线系统、生产业务，以及能源、交通、水利、金融、公共服务、电子政务等关键信息基础设施，都不得作为演练对象。</p>
<h3>4. 必须遵守的法律，按条、款</h3>
<p>《中华人民共和国刑法》第二百八十五条第一款：禁止违反国家规定，侵入国家事务、国防建设、尖端科学技术领域的计算机信息系统。</p>
<p>同条第二款：禁止侵入前款规定以外的计算机信息系统，或者用其他技术手段，获取该系统中存储、处理或者传输的数据，或者对该系统实施非法控制。</p>
<p>同条第三款：禁止提供专门用于侵入、非法控制计算机信息系统的程序、工具；明知他人实施侵入、非法控制而为其提供程序、工具，同样禁止。</p>
<p>第二百八十六条第一款：禁止对计算机信息系统功能进行删除、修改、增加、干扰，造成系统不能正常运行。</p>
<p>同条第二款：禁止对系统中存储、处理或者传输的数据和应用程序进行删除、修改、增加。</p>
<p>同条第三款：禁止故意制作、传播计算机病毒等破坏性程序，影响计算机系统正常运行。</p>
<p>第二百八十七条：禁止利用计算机实施金融诈骗、盗窃、贪污、挪用公款、窃取国家秘密或者其他犯罪。</p>
<p>第二百八十七条之一第一款第（一）项：禁止设立用于实施诈骗、传授犯罪方法、制作或者销售违禁物品、管制物品等违法犯罪活动的网站、通讯群组。</p>
<p>同款第（二）项：禁止发布有关制作或者销售毒品、枪支、淫秽物品等违禁物品、管制物品或者其他违法犯罪的信息。</p>
<p>同款第（三）项：禁止为实施诈骗等违法犯罪活动发布信息。</p>
<p>第二百八十七条之二：禁止明知他人利用信息网络实施犯罪，仍为其提供技术支持，或者提供广告推广、支付结算等帮助。</p>
<p>第二百五十三条之一第一款、第三款：禁止向他人出售或者提供公民个人信息；禁止窃取或者以其他方法非法获取公民个人信息。</p>
<p>《中华人民共和国网络安全法》第十三条第二款：使用网络不得危害网络安全，不得利用网络从事危害国家安全、荣誉和利益，煽动颠覆国家政权、推翻社会主义制度，煽动分裂国家、破坏国家统一，宣扬恐怖主义、极端主义，宣扬民族仇恨、民族歧视，传播暴力、淫秽色情信息，编造、传播虚假信息扰乱经济秩序和社会秩序，以及侵害他人名誉、隐私、知识产权和其他合法权益等活动。</p>
<p>第十四条：禁止利用网络从事危害未成年人身心健康的活动。</p>
<p>第二十九条：禁止非法侵入他人网络、干扰他人网络正常功能、窃取网络数据；禁止提供专门用于侵入网络、干扰网络正常功能及防护措施、窃取网络数据的程序、工具；明知他人从事危害网络安全的活动，禁止为其提供技术支持、广告推广、支付结算等帮助。</p>
<p>第三十三条：公共通信和信息服务、能源、交通、水利、金融、公共服务、电子政务等关键信息基础设施实行重点保护。未获合法授权，不得侵入、干扰或破坏。</p>
<p>第四十六条：禁止窃取或者以其他非法方式获取个人信息，禁止非法出售或者非法向他人提供个人信息。</p>
<p>第四十八条：禁止设立用于实施诈骗，传授犯罪方法，制作或者销售违禁物品、管制物品等违法犯罪活动的网站、通讯群组；禁止利用网络发布涉及上述违法犯罪活动的信息。</p>
<p>第五十条：发送的电子信息、提供的应用软件不得设置恶意程序，不得含有法律、行政法规禁止发布或者传输的信息。</p>
<p>《中华人民共和国数据安全法》第八条：开展数据处理活动，不得危害国家安全、公共利益，不得损害个人、组织的合法权益。</p>
<p>第三十二条第一款：收集数据应当采取合法、正当的方式，不得窃取或者以其他非法方式获取数据。</p>
<p>同条第二款：法律、行政法规对收集、使用数据的目的和范围有规定的，只能在该目的和范围内收集、使用。</p>
<p>第五十一条：窃取或者以其他非法方式获取数据，或者因此损害个人、组织合法权益的，依照有关法律、行政法规处罚。</p>
<p>《中华人民共和国个人信息保护法》第五条：处理个人信息应当合法、正当、必要、诚信，不得通过误导、欺诈、胁迫等方式处理。</p>
<p>第六条第一款、第二款：处理个人信息应当具有明确、合理的目的，并与该目的直接相关，采取对个人权益影响最小的方式；收集限于实现处理目的的最小范围，不得过度收集。</p>
<p>第十条：禁止非法收集、使用、加工、传输他人个人信息，禁止非法买卖、提供或者公开他人个人信息；禁止从事危害国家安全、公共利益的个人信息处理活动。</p>
<p>第十三条：没有取得个人同意，也不属于订立履行合同所必需、履行法定职责、应对突发、公共利益新闻舆论、处理本人已经合法公开的信息，以及法律行政法规规定的其他情形之一的，不得处理个人信息。</p>
<p>第二十八条、第二十九条：生物识别、医疗健康、金融账户、行踪轨迹，以及不满十四周岁未成年人的个人信息，属于敏感个人信息。没有特定目的、充分必要性和严格保护措施，并且没有取得个人单独同意的，不得处理。</p>
<p>此外还须遵守其他现行有效的法律、行政法规、监管规定，以及所使用模型的服务条款与滥用政策。</p>
<h3>5. 据此禁止的方向</h3>
<p>未授权进入。禁止把没有书面授权的单位、域名、地址、公网系统、生产业务或关键信息基础设施登记为靶标，禁止对其扫描、探测、侵入、控制或发包。对应刑法第二百八十五条第一款、第二款，网络安全法第二十九条、第三十三条。</p>
<p>破坏与恶意程序。禁止删除、修改、增加、干扰他人系统功能或其中的数据、应用程序；禁止制作、传播病毒、勒索程序或其他破坏性程序；禁止在信息或软件中设置恶意程序。对应刑法第二百八十六条第一款至第三款，网络安全法第五十条。</p>
<p>工具与帮助。禁止把本项目或本机提供给他人，用于侵入、非法控制或窃取数据；禁止明知对方在实施网络犯罪，仍提供程序、工具、技术支持、广告推广或支付结算。对应刑法第二百八十五条第三款、第二百八十七条之二，网络安全法第二十九条。</p>
<p>数据。禁止窃取、非法收集、超范围使用、泄露、出售或向他人提供业务数据、账号、口令和其他受保护数据。对应数据安全法第八条、第三十二条、第五十一条。</p>
<p>个人信息。禁止非法收集、使用、加工、传输、买卖、提供或公开他人个人信息；禁止过度收集；禁止以误导、欺诈、胁迫方式处理；禁止擅自处理生物识别、医疗健康、金融账户、行踪轨迹和儿童个人信息。对应刑法第二百五十三条之一第一款、第三款，网络安全法第四十六条，个人信息保护法第五条、第六条、第十条、第十三条、第二十八条、第二十九条。</p>
<p>诈骗与违法信息。禁止设立或利用网站、群组实施诈骗、传授犯罪方法、制作或销售违禁物品、管制物品；禁止发布此类信息；禁止利用计算机实施诈骗、盗窃、贪污、挪用公款、窃取国家秘密。对应刑法第二百八十七条、第二百八十七条之一第一款第（一）项至第（三）项，网络安全法第四十八条。</p>
<p>内容。禁止生成或传播危害国家安全、荣誉和利益的内容，禁止煽动颠覆、分裂，禁止恐怖主义、极端主义、民族仇恨，禁止暴力、淫秽色情、赌博，禁止编造虚假信息扰乱经济秩序和社会秩序，禁止侵害名誉、隐私、知识产权，禁止危害未成年人身心健康的内容。对应网络安全法第十三条第二款、第十四条。</p>
<p>结果扩散。演练中形成的记录、资产信息和文件，只留在书面授权写明的目标和期限里，不得交给无权获知的人，也不得改作授权以外的用途。</p>
<h3>6. 责任由使用者承担</h3>
<p>本项目依据 MIT 协议按现状提供。开发者不就完整性、安全性与适用性作保证。使用者对自己的下载、部署、运行、修改、传播，以及全部输入与输出，承担独立、完全的民事、行政及刑事法律责任。作者与贡献者不承担因滥用产生的直接、间接或连带责任。</p>
<p>勾选确认的是操作者本人，不能代替没有阅读本声明的人，也不能把别人的系统说成已经授权。</p>
<h3>7. 违约即终止授权</h3>
<p>一旦用于非法攻击、恶意活动或上述任一禁止方向，使用许可自该行为发生之日起自动终止，且不可撤销。必须立即停止使用，并销毁本项目的代码、脚本与衍生数据，依法承担责任。授权终止后，红队面板不得继续打开或继续使用。</p>
<h3>8. 与 DeepSeek 官方的关系</h3>
<p>本项目是独立的开源项目，与 DeepSeek 官方或其关联主体没有隶属、商业合作、授权或官方背书。文中的「官方」只表示评测对象是使用者本机安装的官方 DeepSeek Harness 软件包，不代表 DeepSeek 官方开发、认可或担保本插件。</p>
<p>文末。倒计时结束、滚到这里并勾选全部三项，才表示你以本人身份认可本声明，并完成本次红队面板授权。</p>
`

/* ---------------------------------------------------------------- 宿主服务 */

const dfHostSvc = { ctx: null, sessions: null, workspace: null, conversation: null }
let dfRewindSeenAt = 0
let dfArmedFill = { sessionId: '', text: '', at: 0 }
let dfPendingDraft = { sessionId: '', text: '', at: 0 }

function dfInstallHost(ctx) {
  if (!ctx || typeof ctx !== 'object') return
  dfHostSvc.ctx = ctx
  try { if (ctx.sessions) dfHostSvc.sessions = ctx.sessions } catch (e) { /* 旧宿主可能没有 */ }
  try { if (ctx.uiWorkspace) dfHostSvc.workspace = ctx.uiWorkspace } catch (e) { /* ignore */ }
  try { if (ctx.conversation) dfHostSvc.conversation = ctx.conversation } catch (e) { /* ignore */ }
}

function dfCurrentSessionId() {
  try {
    const sel = dfHostSvc.workspace && dfHostSvc.workspace.selection
      ? dfHostSvc.workspace.selection.getSnapshot && dfHostSvc.workspace.selection.getSnapshot()
      : null
    if (sel && typeof sel.sessionId === 'string' && sel.sessionId) return sel.sessionId
  } catch (e) { /* ignore */ }
  try {
    const snap = dfHostSvc.sessions && dfHostSvc.sessions.list && dfHostSvc.sessions.list.getSnapshot
      ? dfHostSvc.sessions.list.getSnapshot()
      : null
    if (snap && typeof snap.current === 'string' && snap.current) return snap.current
  } catch (e) { /* ignore */ }
  return ''
}

function dfSessionKnown(sessionId) {
  if (!sessionId) return false
  try {
    const snap = dfHostSvc.sessions && dfHostSvc.sessions.list && dfHostSvc.sessions.list.getSnapshot
      ? dfHostSvc.sessions.list.getSnapshot()
      : null
    if (!snap) return false
    if (snap.byId && Object.prototype.hasOwnProperty.call(snap.byId, sessionId)) return true
    if (Array.isArray(snap.ids) && snap.ids.indexOf(sessionId) >= 0) return true
  } catch (e) { /* ignore */ }
  return false
}

function dfSessionSnapshot(sessionId) {
  if (!sessionId) return null
  try {
    const snap = dfHostSvc.sessions && dfHostSvc.sessions.list && dfHostSvc.sessions.list.getSnapshot
      ? dfHostSvc.sessions.list.getSnapshot()
      : null
    if (snap && snap.byId && snap.byId[sessionId]) return snap.byId[sessionId]
  } catch (e) { /* ignore */ }
  try {
    const actx = dfHostSvc.sessions && typeof dfHostSvc.sessions.scope === 'function'
      ? dfHostSvc.sessions.scope(sessionId) : undefined
    const face = actx && dfHostSvc.sessions && typeof dfHostSvc.sessions.sessionOf === 'function'
      ? dfHostSvc.sessions.sessionOf(actx) : undefined
    if (face && typeof face.getSnapshot === 'function') return face.getSnapshot()
    if (face) return face
  } catch (e) { /* ignore */ }
  return null
}

function dfWaitMs(ms) {
  return new Promise(function (resolve) { window.setTimeout(resolve, ms) })
}

/* ---------------------------------------------------------------- 须知 / 授权 */

function dfReadNoticeAck() {
  try { return window.localStorage.getItem(DF_NOTICE_KEY) === '1' } catch (e) { return false }
}

function dfWriteNoticeAck() {
  try { window.localStorage.setItem(DF_NOTICE_KEY, '1') } catch (e) { /* ignore */ }
}

const dfAuthState = { ready: false, granted: false, posting: 0, subs: new Set() }

function dfAuthReadLocal() {
  try { return window.localStorage.getItem(DF_AUTH_KEY) === '1' } catch (e) { return false }
}

function dfAuthGranted() {
  return dfAuthState.ready ? dfAuthState.granted : dfAuthReadLocal()
}

function dfAuthSet(ok) {
  dfAuthState.ready = true
  dfAuthState.granted = !!ok
  try {
    if (ok) window.localStorage.setItem(DF_AUTH_KEY, '1')
    else window.localStorage.removeItem(DF_AUTH_KEY)
  } catch (e) { /* ignore */ }
  dfAuthState.subs.forEach(function (fn) { try { fn(dfAuthState.granted) } catch (e) { /* ignore */ } })
}

/** 授权：本地先记住，再尽力同步到当前安装目录。 */
function dfAuthGrant() {
  dfAuthSet(true)
  dfAuthState.posting += 1
  return dfHttp('/dsh-forge/drill-grant', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }, { ttl: 0 }).then(function (r) {
    dfAuthState.posting = Math.max(0, dfAuthState.posting - 1)
    return r
  }, function (e) {
    dfAuthState.posting = Math.max(0, dfAuthState.posting - 1)
    return { ok: false, error: String((e && e.message) || e) }
  })
}

/** 与安装目录里的授权对齐：文件没了（例如卸载后重装）就重新确认。 */
function dfAuthSync() {
  return dfHttp('/dsh-forge/drill-grant', {}, { ttl: 0 }).then(function (r) {
    if (!r || r.ok === false) return r
    if (dfAuthState.posting > 0) return r
    dfAuthSet(!!r.granted)
    return r
  }, function () { return null })
}

/* ---------------------------------------------------------------- 规则：红队模式 */

function dfRedteamPreset(value) {
  const text = String(value || '').trim()
  if (!text) return false
  if (text === 'redteam') return true
  if (/^red[\s_-]*team$/i.test(text)) return true
  const label = text.replace(/不是红队/g, '').replace(/非红队/g, '')
  return /红队/.test(label)
}

function dfReadPreset(sess) {
  if (!sess || typeof sess !== 'object') return ''
  try { if (sess.projectionValues && typeof sess.projectionValues.agentPreset === 'string') return sess.projectionValues.agentPreset } catch (e) { /* ignore */ }
  try { if (typeof sess.agentPreset === 'string') return sess.agentPreset } catch (e) { /* ignore */ }
  try { if (sess.header && typeof sess.header.agentPreset === 'string') return sess.header.agentPreset } catch (e) { /* ignore */ }
  return ''
}

function dfIsRedteamActive() {
  const sid = dfCurrentSessionId()
  if (sid) {
    const sess = dfSessionSnapshot(sid)
    if (dfRedteamPreset(dfReadPreset(sess))) return true
  }
  /* 宿主没暴露会话字段时退回语义化标记；只认明确的「红队模式」文本。 */
  try {
    if (document.querySelector("[data-agent-preset='redteam'],[data-preset-id='redteam'],[data-mode='redteam']")) return true
    const nodes = document.querySelectorAll(
      "[class*='seat' i][class*='label' i],[class*='preset' i][class*='label' i],[title*='红队']"
    )
    for (let i = 0; i < nodes.length; i += 1) {
      const text = String(nodes[i].textContent || '').replace(/\s+/g, ' ').trim()
      if (/红队模式/.test(text)) return true
    }
  } catch (e) { /* ignore */ }
  return false
}

/* ---------------------------------------------------------------- 输入框回退 */

function dfConversationFace() {
  if (dfHostSvc.conversation) return dfHostSvc.conversation
  const ctx = dfHostSvc.ctx
  if (ctx && typeof ctx.get === 'function') {
    try { return ctx.get('conversation') } catch (e) { /* ignore */ }
  }
  return undefined
}

function dfConversationInput(sessionId) {
  try {
    const input = dfConversationFace() && dfConversationFace().input
    if (!input || !sessionId) return null
    if (typeof input.shell === 'function') {
      try { return input.shell(sessionId) } catch (e) { /* 会话还没挂上 */ }
    }
    const sessions = dfHostSvc.sessions
    const actx = sessions && typeof sessions.scope === 'function' ? sessions.scope(sessionId) : undefined
    if (typeof input.for === 'function' && actx) return input.for(actx)
    return null
  } catch (e) {
    return null
  }
}

function dfHostSvcSetDraft(sessionId, text) {
  if (!sessionId) return false
  try {
    const input = dfConversationInput(sessionId)
    if (input && typeof input.setDraft === 'function') {
      input.setDraft(text || '')
      return true
    }
  } catch (e) { /* ignore */ }
  return false
}

/** 把一段文字放进当前会话输入框（不自动发送，用户确认后自己发）。 */
function dfDraftToComposer(text, okLabel) {
  const sid = dfCurrentSessionId()
  if (!sid) {
    dfToast('先在 DeepSeek Harness 里打开一个会话，再把内容放进输入框', 'err', 3600)
    return false
  }
  if (!dfHostSvcSetDraft(sid, text)) {
    dfToast('当前会话输入框不可用，请手动复制', 'err', 3600)
    return false
  }
  dfToast((okLabel || '已放入输入框') + '，确认后发送', 'ok', 3200)
  return true
}

function dfFillComposer(inputActions, text) {
  if (inputActions && typeof inputActions.setDraft === 'function') {
    try { inputActions.setDraft(text || '') } catch (e) { /* ignore */ }
  }
}

function dfLiveDraft(sessionId, inputActions) {
  try {
    const fromActions = inputActions && inputActions.state && inputActions.state.getSnapshot
      ? inputActions.state.getSnapshot() : null
    if (fromActions && typeof fromActions.draft === 'string') return fromActions.draft
  } catch (e) { /* ignore */ }
  try {
    const input = dfConversationInput(sessionId)
    const snap = input && input.state && input.state.getSnapshot ? input.state.getSnapshot() : null
    if (snap && typeof snap.draft === 'string') return snap.draft
  } catch (e) { /* ignore */ }
  return ''
}

function dfIsPluginDraft(text) {
  const value = String(text || '').trim()
  if (!value) return false
  return /^\[MNEMON\]/i.test(value)
    || /MNEMON RUNTIME MEMORY SNAPSHOT/i.test(value)
    || /^MNEMON VIEW TOOLS/im.test(value)
}

function dfWriteDraft(sessionId, text) {
  if (!sessionId) return
  const value = dfIsPluginDraft(text) ? '' : (text || '')
  dfPendingDraft = { sessionId: sessionId, text: value, at: Date.now() }
  try { window.sessionStorage.setItem(DF_DRAFT_KEY + sessionId, value) } catch (e) { /* ignore */ }
}

function dfPeekDraft(sessionId) {
  if (!sessionId) return ''
  if (dfPendingDraft.sessionId === sessionId && dfPendingDraft.text) return dfPendingDraft.text
  try { return window.sessionStorage.getItem(DF_DRAFT_KEY + sessionId) || '' } catch (e) { return '' }
}

function dfClearStoredDraft(sessionId) {
  if (!sessionId) return
  if (dfPendingDraft.sessionId === sessionId) dfPendingDraft = { sessionId: '', text: '', at: 0 }
  try { window.sessionStorage.removeItem(DF_DRAFT_KEY + sessionId) } catch (e) { /* ignore */ }
  try { window.sessionStorage.removeItem(DF_ARM_KEY + sessionId) } catch (e) { /* ignore */ }
}

function dfArmFill(sessionId, text) {
  if (!sessionId || !text || dfIsPluginDraft(text)) return
  const at = Date.now()
  dfArmedFill = { sessionId: sessionId, text: text, at: at }
  dfWriteDraft(sessionId, text)
  try { window.sessionStorage.setItem(DF_ARM_KEY + sessionId, String(at)) } catch (e) { /* ignore */ }
}

function dfTakeArmedFill(sessionId) {
  if (!sessionId) return ''
  let text = ''
  let at = 0
  if (dfArmedFill.sessionId === sessionId && dfArmedFill.text) {
    text = dfArmedFill.text
    at = dfArmedFill.at
  } else {
    text = dfPeekDraft(sessionId)
    try { at = Number(window.sessionStorage.getItem(DF_ARM_KEY + sessionId) || 0) } catch (e) { at = 0 }
  }
  if (!text || !at || Date.now() - at > DF_ARM_TTL_MS) {
    if (text && (!at || Date.now() - at > DF_ARM_TTL_MS)) dfClearStoredDraft(sessionId)
    return ''
  }
  dfClearStoredDraft(sessionId)
  dfArmedFill = { sessionId: '', text: '', at: 0 }
  return text
}

function dfScheduleFill(sessionId, text, inputActions) {
  if (!sessionId || !text || dfIsPluginDraft(text)) return function () {}
  let stopped = false
  let filled = false
  const timers = []
  const tryFill = function () {
    if (stopped) return
    const current = dfLiveDraft(sessionId, inputActions)
    if (filled && current !== text) { stopped = true; return }
    if (current && current !== text) { stopped = true; return }
    dfFillComposer(inputActions, text)
    dfHostSvcSetDraft(sessionId, text)
    filled = true
  }
  DF_FILL_DELAYS.forEach(function (ms) { timers.push(window.setTimeout(tryFill, ms)) })
  return function () {
    stopped = true
    timers.forEach(function (id) { try { window.clearTimeout(id) } catch (e) { /* ignore */ } })
  }
}

async function dfDropQueue(sessionId) {
  const sessions = dfHostSvc.sessions
  if (!sessions || !sessionId) return
  const drop = async function () {
    try {
      const actx = typeof sessions.scope === 'function' ? sessions.scope(sessionId) : undefined
      const face = typeof sessions.sessionOf === 'function' ? sessions.sessionOf(actx) : undefined
      const snap = face && typeof face.getSnapshot === 'function' ? face.getSnapshot() : face
      const queue = (snap && snap.queue) || []
      for (let i = 0; i < queue.length; i += 1) {
        const id = queue[i] && (queue[i].id || queue[i].itemId)
        if (!id) continue
        try { await face.updateQueue(id, { kind: 'remove' }) } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
  }
  await drop()
  window.setTimeout(function () { drop() }, 80)
}

async function dfOpenSession(sessionId) {
  if (!sessionId) return
  const sessions = dfHostSvc.sessions
  const workspace = dfHostSvc.workspace
  let lastError = null
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (sessions && typeof sessions.refresh === 'function' && !dfSessionKnown(sessionId)) {
      try { await sessions.refresh() } catch (e) { lastError = e }
    }
    const known = dfSessionKnown(sessionId)
    if (known || (sessions && typeof sessions.open === 'function')) {
      try {
        if (workspace && typeof workspace.openSession === 'function') workspace.openSession(sessionId)
        else if (sessions && typeof sessions.open === 'function') sessions.open(sessionId)
        else throw new Error('无法打开回退后的会话')
        const selected = workspace && workspace.selection && workspace.selection.getSnapshot
          ? (workspace.selection.getSnapshot() || {}).sessionId : ''
        if (!workspace || selected === sessionId) {
          await dfDropQueue(sessionId)
          window.setTimeout(function () { dfDropQueue(sessionId) }, 250)
          return
        }
      } catch (e) {
        lastError = e
      }
    }
    await dfWaitMs(120)
  }
  throw new Error((lastError && lastError.message) || '回退后的会话没有打开')
}

/* ---------------------------------------------------------------- 须知 / 授权 UI */

function DfWelcomeNotice(props) {
  const [open, setOpen] = useState(function () { return !dfReadNoticeAck() })
  const [checked, setChecked] = useState(false)
  if (!open) return null
  return h('div', { className: 'df-mask df-portal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '用户须知' },
    h('div', { className: 'df-modal' },
      h('div', { className: 'df-modal-hd' },
        h('span', { className: 'df-mark' }, dfIcon('shield', 15)),
        h('div', { className: 'df-mh-t' },
          h('h2', null, '用户须知'),
          h('p', null, '首次安装请阅读以下说明；确认后不再弹出。'))),
      h('div', { className: 'df-modal-bd' },
        h('div', { className: 'df-warnbox' },
          '本插件本体永久免费，付费仅为人工知识服务（部署指导、讲解、答疑）。任何把插件本体包装成付费商品出售的行为均不被授权。'),
        h('p', null, '本插件是 DeepSeek Harness 的本机网络安全红队插件：在受控本机环境中调整提示词与补丁、做授权范围内的红队面板操作。'),
        h('h3', null, '禁止事项'),
        h('p', null, '禁止将本项目用于未授权的网络攻击、入侵、窃取数据、破坏系统或任何违法犯罪。'),
        h('p', null, '禁止商业售卖、付费倒卖、黑灰产牟利，以及未经授权对本仓库的再分发。'),
        h('p', null, '使用者须自行遵守所在地法律法规与平台规范；违法后果由行为人自行承担，与作者无关。'),
        h('p', null, '破解模式仅用于自有或授权样本；禁止对他人软件破解后传播盗版、倒卖或用于牟利。')),
      h('div', { className: 'df-modal-ft' },
        h('label', { className: 'df-check' + (checked ? ' is-on' : '') },
          h('input', {
            type: 'checkbox', checked: checked,
            onChange: function (e) { setChecked(!!(e && e.target && e.target.checked)) },
          }),
          h('span', null, '我已阅读并理解上述用户须知，同意合法合规使用。')),
        h('span', { className: 'df-spacer' }),
        h(DfBtn, {
          kind: 'primary', icon: 'check', disabled: !checked,
          onClick: function () {
            if (!checked) return
            dfWriteNoticeAck()
            setOpen(false)
            if (props.onAck) props.onAck()
          },
        }, '我已知晓并继续'))))
}

function DfAuthGate(props) {
  const [left, setLeft] = useState(5)
  const [readEnd, setReadEnd] = useState(false)
  const [checks, setChecks] = useState({ read: false, scope: false, ban: false })
  const [busy, setBusy] = useState(false)
  const legalRef = useRef(null)

  useEffect(function () {
    const id = window.setInterval(function () {
      setLeft(function (n) {
        if (n <= 1) { window.clearInterval(id); return 0 }
        return n - 1
      })
    }, 1000)
    return function () { window.clearInterval(id) }
  }, [])

  useEffect(function () {
    const el = legalRef.current
    if (el && el.scrollHeight <= el.clientHeight + 4) setReadEnd(true)
  }, [])

  /* Esc 等同「暂不进入」：授权窗不该只能点按钮才退得出去。 */
  useEffect(function () {
    const onKey = function (e) {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      if (props.onCancel) props.onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return function () { window.removeEventListener('keydown', onKey, true) }
  }, [props.onCancel])

  const locked = left > 0 || !readEnd
  const ready = !locked && checks.read && checks.scope && checks.ban
  const hint = left > 0
    ? '请阅读声明。' + left + ' 秒后才能勾选。'
    : (readEnd ? '倒计时已结束。请勾选全部三项。' : '倒计时已结束。请把声明滚到文末，再勾选。')

  function onScroll() {
    const el = legalRef.current
    if (!el) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 8) setReadEnd(true)
  }

  function toggle(key) {
    if (locked) return
    setChecks(function (prev) {
      const next = Object.assign({}, prev)
      next[key] = !next[key]
      return next
    })
  }

  function confirm() {
    if (!ready || busy) return
    setBusy(true)
    dfAuthGrant().then(function () {
      setBusy(false)
      if (props.onGranted) props.onGranted()
    }, function () {
      setBusy(false)
      if (props.onGranted) props.onGranted()
    })
  }

  const items = [
    ['read', '我已读完《安全与禁止违法声明》，并认可其中的全部条款。'],
    ['scope', '我确认只用在本机已授权环境、离线靶标或合规演练中。'],
    ['ban', '我确认禁止任何违法用途。未完成本授权，不得使用红队面板。'],
  ]

  return h('div', { className: 'df-mask df-portal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '红队面板授权确认' },
    h('div', { className: 'df-modal df-modal--wide' },
      h('div', { className: 'df-modal-hd' },
        h('span', { className: 'df-mark is-warn' }, dfIcon('shield', 15)),
        h('div', { className: 'df-mh-t' },
          h('h2', null, '红队面板授权确认'),
          h('p', null, '第一次进入红队面板，或打开全面浏览，都要先完成本窗。'))),
      h('div', { className: 'df-modal-bd' },
        h('div', { className: 'df-warnbox' },
          '安全警告：红队面板只用于你有权管理的本机、离线靶标，或已书面授权的演练环境。未经授权的渗透、攻击、窃取和破坏一律禁止。'),
        h('div', {
          className: 'df-legal', ref: legalRef, onScroll: onScroll,
          dangerouslySetInnerHTML: { __html: DF_LEGAL_HTML },
        }),
        h('div', { className: 'df-modal-hint' }, hint),
        items.map(function (row) {
          return h('label', {
            key: row[0],
            className: dfCx('df-check', locked && 'is-locked', checks[row[0]] && !locked && 'is-on'),
          },
            h('input', {
              type: 'checkbox', checked: !!checks[row[0]], disabled: locked,
              onChange: function () { toggle(row[0]) },
            }),
            h('span', null, row[1]))
        })),
      h('div', { className: 'df-modal-ft' },
        h(DfBtn, { kind: 'ghost', onClick: function () { if (props.onCancel) props.onCancel() } }, '暂不进入'),
        h('span', { className: 'df-spacer' }),
        h(DfBtn, { kind: 'primary', icon: 'check', disabled: !ready || busy, onClick: confirm },
          busy ? '授权中…' : (ready ? '确认授权并进入红队面板' : '确认授权')))))
}

/* ---------------------------------------------------------------- 回退按钮 */

function DfRewindMenu(props) {
  const node = h('div', {
    className: 'df-rewind-menu df-portal',
    role: 'menu',
    ref: props.menuRef,
    style: props.pos
      ? { left: props.pos.left + 'px', top: props.pos.top + 'px' }
      : { left: '8px', bottom: '48px', transform: 'none' },
  },
    h('button', {
      type: 'button', className: 'df-rewind-item',
      onMouseDown: function (e) { e.preventDefault(); e.stopPropagation() },
      onClick: function (e) { e.preventDefault(); e.stopPropagation(); props.onPick('once') },
    },
      h('b', null, '回退一次'),
      h('span', null, '把这一轮发出去的那句放回输入框，并清掉这一轮')),
    h('button', {
      type: 'button', className: 'df-rewind-item',
      onMouseDown: function (e) { e.preventDefault(); e.stopPropagation() },
      onClick: function (e) { e.preventDefault(); e.stopPropagation(); props.onPick('round') },
    },
      h('b', null, '回退上一轮'),
      h('span', null, '把这一轮发出去的那句放回输入框；子代理也只撤这一轮')))

  try {
    const rd = require('react-dom')
    if (rd && typeof rd.createPortal === 'function' && typeof document !== 'undefined') {
      return rd.createPortal(node, document.body)
    }
  } catch (e) { /* 没有 portal 就挂在按钮旁 */ }
  return node
}

function DfRewindButton(props) {
  const sessionId = props.sessionId || dfCurrentSessionId()
  const inputActions = props.inputActions
  const wrapRef = useRef(null)
  const menuRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [menu, setMenu] = useState(false)
  const [menuPos, setMenuPos] = useState(null)

  useEffect(function () {
    if (!sessionId) return undefined
    const armed = dfTakeArmedFill(sessionId)
    if (!armed) return undefined
    return dfScheduleFill(sessionId, armed, inputActions)
  }, [sessionId, inputActions])

  useEffect(function () {
    if (!menu) return undefined
    const onDoc = function (e) {
      if (wrapRef.current && wrapRef.current.contains(e.target)) return
      if (menuRef.current && menuRef.current.contains(e.target)) return
      setMenu(false)
    }
    document.addEventListener('mousedown', onDoc)
    return function () { document.removeEventListener('mousedown', onDoc) }
  }, [menu])

  function run(mode) {
    if (!sessionId || busy) return
    setBusy(true)
    setMenu(false)
    setNotice('')
    dfHttp('/dsh-forge/rewind', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId, mode: mode }),
    }, { ttl: 0 }).then(function (data) {
      if (!data || !data.ok || !data.sessionId || data.cleared === false) {
        throw new Error((data && data.error) || '没有清掉之前发送的内容')
      }
      if (data.at) dfRewindSeenAt = data.at
      const text = dfIsPluginDraft(data.text) ? '' : (data.text || '')
      dfArmFill(data.sessionId, text)
      return dfOpenSession(data.sessionId).then(function () {
        dfScheduleFill(data.sessionId, text)
        setBusy(false)
      })
    }).catch(function (e) {
      setBusy(false)
      const text = '回退失败：' + String((e && e.message) || e)
      setNotice(text)
      dfToast(text, 'err', 5200)
    })
  }

  function toggleMenu(e) {
    if (e) { e.preventDefault(); e.stopPropagation() }
    if (!sessionId || busy) return
    if (menu) { setMenu(false); return }
    const rect = wrapRef.current && wrapRef.current.getBoundingClientRect
      ? wrapRef.current.getBoundingClientRect() : null
    if (rect) {
      setMenuPos({ left: Math.max(8, rect.right - 250), top: Math.max(8, rect.top - 8) })
    } else {
      setMenuPos(null)
    }
    setNotice('')
    setMenu(true)
  }

  const label = busy ? '回退中…' : (notice ? dfShort(notice, 14) : '回退')
  return h('div', { className: 'df-rewind-wrap', ref: wrapRef },
    h('button', {
      type: 'button',
      className: 'df-rewind',
      title: notice || '回退上一句',
      'aria-label': '回退',
      'aria-expanded': menu ? 'true' : 'false',
      disabled: busy || !sessionId,
      onMouseDown: function (e) { e.preventDefault() },
      onClick: toggleMenu,
    },
      h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true },
        h('path', {
          fill: 'currentColor',
          d: 'M7.2 3.2 3.4 7l3.8 3.8V8.6c2.8 0 4.7.7 5.9 2.3-.2-2.8-1.9-5.2-5.9-5.6V3.2z',
        })),
      label),
    menu ? h(DfRewindMenu, {
      pos: menuPos,
      menuRef: menuRef,
      onPick: run,
    }) : null)
}

/** 出错时退回一个纯文字按钮，绝不让插槽把宿主输入框带崩。 */
class DfRewindSafe extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error) {
    try { console.error('[dsh-forge] rewind slot:', error) } catch (e) { /* ignore */ }
  }
  render() {
    if (this.state.failed) {
      return h('button', {
        type: 'button', className: 'df-rewind', title: '回退',
        onMouseDown: function (e) { e.preventDefault() },
        onClick: function () { dfToast('回退按钮不可用：宿主接口变化', 'err', 3600) },
      }, '回退')
    }
    return h(DfRewindButton, this.props)
  }
}

let dfRewindInstalled = false

/** 注入口:回退按钮。slot / effect 都拿不到时静默跳过。 */
function dfInstallRewind(host) {
  if (dfRewindInstalled || !host) return
  const slots = host.slots || (dfHostSvc.ctx && dfHostSvc.ctx.slots)
  if (!slots || typeof slots.inject !== 'function') return
  dfRewindInstalled = true
  try {
    slots.inject('conversation.input.right', function () {
      return slots.register({
        name: 'conversation.input.right',
        id: 'dsh-forge-rewind',
        order: 20,
        inject: function (sessionId) { return { sessionId: sessionId } },
      }, DfRewindSafe)
    })
  } catch (e) {
    dfRewindInstalled = false
    try { console.warn('[dsh-forge] rewind slot skipped:', e && e.message) } catch (e2) { /* ignore */ }
    return
  }
  /* 别处触发的回退（CLI / 旧面板）也要把输入框填上。 */
  try {
    const start = function () {
      return window.setInterval(function () {
        dfHttp('/dsh-forge/rewind', {}, { ttl: 0 }).then(function (data) {
          if (!data || !data.sessionId || !data.at || data.at <= dfRewindSeenAt) return
          dfRewindSeenAt = data.at
          const current = dfCurrentSessionId()
          if (current && current !== data.parentId) return
          const text = dfIsPluginDraft(data.text) ? '' : (data.text || '')
          dfArmFill(data.sessionId, text)
          dfOpenSession(data.sessionId).then(function () {
            dfScheduleFill(data.sessionId, text)
          }, function () { /* ignore */ })
        }, function () { /* ignore */ })
      }, 1500)
    }
    if (typeof host.effect === 'function') host.effect(start, 'dsh-forge: rewind watch')
    else start()
  } catch (e) { /* watch 是锦上添花，失败不影响按钮 */ }
}
