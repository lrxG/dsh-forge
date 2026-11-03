/**
 * 漏洞质量门：只有“能证明真实影响”的发现才能写 exploited。
 * 独立成模块，避免测试/调用方为了一个纯函数加载宿主工具依赖。
 */
export function vulnQualityError(args = {}) {
  if (String(args.status || '').toLowerCase() !== 'exploited') return ''
  if (String(args.planned_data_nature || '').toLowerCase() === 'demo') {
    return '计划里这个靶标的数据是 demo（演示/示例）：这类发现只能写 candidate，不能写 exploited；如果是真实数据，先在 plan 里把 target_model.data 改成 real 并写清依据'
  }
  const impact = String(args.impact || '').trim().toLowerCase()
  if (!['medium', 'high'].includes(impact)) {
    return '写 exploited 需要 impact=medium|high（说明真实影响：越权读写他人数据、业务绕过、接管账号/服务器/内网）；只有回显/自身数据/前端显示先写 candidate'
  }
  const nature = String(args.data_nature || '').trim().toLowerCase()
  if (nature !== 'real') {
    return '写 exploited 需要 data_nature=real（真实用户/业务数据）；demo=演示/示例/占位数据、unknown=未确认，都只能写 candidate'
  }
  const gained = String(args.gained || '').trim()
  if (!gained) {
    return '写 exploited 需要在 gained 里写清拿到了什么（他人账号/订单/服务器权限/内网位置）；没有产出只能写 candidate'
  }
  const observed = String(args.data_evidence || '').trim()
  if (observed.length < 12 || !/[@\d]|订单|用户|账号|租户|邮箱|手机|order|user|account|tenant|email|phone/i.test(observed)) {
    return '写 exploited 需要 data_evidence：写一条具体观测（例如「用 A 的会话读到 B 的订单 20261103-123」），不能只写 real'
  }
  return ''
}
