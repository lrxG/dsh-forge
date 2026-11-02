---
name: bounty-triage
description: SRC/漏洞赏金的目标准入与收口：先判断能不能交、值不值得打，再用前置条件和证据决定停还是换
whenToUse: 准备开新目标、同时有多个 program、或一个目标已经打了很久没有可提交成果时
role: plan
enabled: true
---

# 赏金目标：先准入，再验证

赏金的目标不是“测得多”，是**交得出去**。没有提交资格的目标，测出洞也只是练习。

## 开工前的准入表

十到十五分钟填完，填不完就换：

| 项 | 判断 |
|---|---|
| `canSubmit` | 账号有没有提交权限；草稿权限不等于能提交 |
| 2FA / 实名 | program 是否要求；卡住就换，不要先打再看 |
| confidentiality | private / conf=3 的 program 不要按公开目标投入 |
| 出网与 WAF | 目标是否 Akamai / Imperva / geo-block；curl 403 不等于打不动，先确认浏览器能不能到 |
| 赏金与竞争 | 档位、scope、是否已有很多公开报告；只选 1–2 个 |
| 时间盒 | 默认 90 分钟；到期没形成可复现结论就换 |

**一次只锁定一个目标。** 不要同时铺十几个 program；铺面不是进度。

## 前置条件优先

发现“像漏洞”之后，先问：**攻击者拿到前置条件了吗？**

| 类型 | 先证什么 | 证不到怎么办 |
|---|---|---|
| IDOR / 越权 | 对象 ID 是否能被攻击者获得（页面、接口、日志、枚举） | 只写 candidate，不写 exploited |
| 认证绕过 | 登录态、令牌、回调地址是否可控 | 先证登录/令牌链路，再谈绕过 |
| SSRF | 是否有 OOB 回连或元数据响应 | 只写 candidate |
| SQLi / XSS | 对照 payload 的响应差异、反射上下文 | 参数空转就停，不要堆 payload |
| 上传 / 文件 | 文件是否真的落地、能否访问/执行 | 只证明“能传”不算 RCE |

**只证明“拿自己的凭证能跨会话”不算漏洞**：要证明别人拿不到你的对象 ID 也能利用，或者 ID 本身可被获得。

## 证据顺序

```text
vuln_add（先写 candidate，带 target 或 asset_id）
  → http_evidence_add（带 vuln_id 关联原始请求/响应）
  → shot_add（页面效果截图）
  → vuln_update（改成 exploited，带 evidence）
  → asset_test（碰过的资产）
  → coverage（按测试类记账）
  → closeout（gaps 清零）
  → report
```

没有证据的漏洞只写 `candidate`；`exploited` 必须有目标 + 可复现证据。

## 什么时候换目标

- 同一目标 2 次 WAF/封禁；
- 同一假设 2 次失败，且没有新信息；
- 90 分钟没有形成可复现链路；
- 目标需要账号/实名/KYC，且当前拿不到；
- 只在做重复侦察，没有新的测试面。

换目标前写一行：**已排除什么、还缺什么、下个目标为什么更值得**。

## 子会话任务书

第一行固定：

```text
engagement: <靶标 id>
redteamRole: recon|assess|vuln-scan|exploit|internal
```

任务书只给一个目标、一个判据、一个交付格式；子会话开工先 `session_bind` 自己的靶标，不继承上一个目标。

## 收口

出报告前跑 `closeout`：

- 未测资产为 0；
- 有发现/步骤的资产都有 coverage；
- `exploited` 都有 target/asset + evidence；
- 达不到就写缺口，不生成正式报告。
