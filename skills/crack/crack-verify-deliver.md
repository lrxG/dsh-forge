---
name: crack-verify-deliver
description: 破解验证与交付：干净复现三步、冒烟测试、可回滚的交付说明。
whenToUse: 补丁或 keygen 已产出，要验证有效性并整理交付时
role: verify
enabled: true
---

# 验证与交付

## 三步复现

干净样本失败 → 打补丁后成功 → 回滚后又失败。

## 冒烟测试

启动、核心功能可用（不只"解锁了"，还要"没坏"）；keygen 多组输入都通过；回滚能回到未破解状态。

## 判据

- 三个条件缺一不可；只做中间一步证明不了补丁是唯一变量。
- 能启动不算成功；缓存、登录态、旧安装残留会冒充成功，验证前清干净。
- keygen 只有一组通过时是特例，不是通用算法。
- **换路**：结果时好时坏 → 先查是否还有第二校验点或服务端参与，别靠多试凑成功。

## 交付

可运行补丁 + 应用与回滚步骤 + 前后证据 + 原件 `.bak`。

落库到 `crack_case`：`deliverables`（产物路径）、`apply_cmd`、`rollback_cmd`、`verified`（前后证据）；标 `status=done` 前先跑 `crack_case {action:'closeout', args:{id}}`，gaps 为空才算交付。
