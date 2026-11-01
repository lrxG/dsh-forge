---
name: thick-client
description: Use for authorized security testing of desktop thick clients including local storage, update channels, IPC, traffic, and client-side trust boundaries.
whenToUse: 目标是桌面厚客户端（Electron/Qt/.NET WinForms/WPF）、要查本地存储/IPC/更新通道信任边界时
---

# Thick Client Security Testing

## ACTION REQUIRED（读完后立刻执行）

1. `NOW`: 确认目标是 **桌面厚客户端**（Win/macOS/Linux GUI 或服务伴生），非纯 Web
2. `NOW`: 测试账号与安装包来源写入 scope
3. `NEXT`: 准备工具（Burp 上游代理、进程监控、逆向工具）
4. `ACT`: 信任边界图 → 本地面 → 网络面 → 更新/供应链

## 适用场景

- C/S 架构客户端、Electron/Qt/.NET WinForms/WPF
- 本地配置/凭证存储、IPC、命名管道
- 客户端强制校验绕过研究（授权）
- 自动更新通道与代码签名验证

## 工作流

### 1. 建边界

```text
□ 进程树、子进程、驱动/服务
□ 监听端口与出站域名
□ 本地敏感路径：%APPDATA%、Keychain、注册表
```

### 2. 本地攻击面

```text
□ 明文配置、硬编码密钥、调试开关
□ DLL 劫持/搜索顺序（Windows）
□ 数据库文件（SQLite）权限与加密
□ IPC：谁可连接？是否鉴权？
```

### 3. 网络面

```text
□ 系统代理 / 应用自定义 TLS
□ 证书钉扎 → 联合 mobile/js 方法学或 Frida
□ API 越权：客户端隐藏的管理接口
```

### 4. 逆向验证

```text
□ .NET / 原生 / Electron → 统一走 `seagull-reverse`（分引擎/分格式）
```

## 工具链

| 工具 | 用途 |
|------|------|
| Process Monitor / API Monitor | 行为 |
| Burp / mitmproxy | 流量 |
| dnSpy / IDA / Ghidra | 逆向 |
| Sysinternals | Windows 面 |
| asar / nexe 检测 | Electron |

## 参考

- `seagull-reverse`：.NET / 原生 / Electron 逆向
- `protocol-reverse`：客户端自定义协议
- `seagull-pentest`：接口越权与重放验证

## 路由上下文

**上游**: 无总控文件；由宿主按 `whenToUse` 直接触发
**下游**: 纯协议 `protocol-reverse`；更新通道与远端面 `seagull-pentest`

## 判据：找到的是不是真信任边界

- 每条数据流都要能回答"客户端能不能改、服务端信不信"；答不出就不是边界，只是实现细节。
- 本地配置、缓存、注册表只是客户端状态，改它不等于服务端接受。
- 客户端校验普遍只是体验层；服务端全量重算的系统里，绕过客户端没有产出。
- **换路**：流量全被证书钉扎挡住 → 先做进程内 hook 或导入证书，别在代理上耗。

## 任务完成自检

- [ ] 是否画出信任边界？
- [ ] 本地+网络面是否都覆盖？
- [ ] 每条边界结论是否都有可复现证据（抓包/进程/文件）？