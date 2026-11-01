---
name: protocol-reverse
description: Use for authorized reverse engineering of custom binary protocols, Protobuf/gRPC, WebSocket frames, and PCAP-driven protocol recovery.
whenToUse: 要逆自定义二进制协议、Protobuf/gRPC、WebSocket 帧或从 PCAP 还原字段与状态机时
---

# Protocol Reverse Engineering

## ACTION REQUIRED（读完后立刻执行）

1. `NOW`: 确认任务是否为**协议/流量/序列化格式**逆向（纯 Web 参数签名不属本 skill）
2. `ACT`: 进入工作流 Phase 1，产出帧布局或消息字典草稿

## 适用场景

- 自定义 TCP/UDP 二进制协议
- Protobuf / gRPC / FlatBuffers / MessagePack
- WebSocket / MQTT / 私有 RPC
- PCAP / PCAPNG 还原字段与状态机
- 客户端-服务端校验、序列号、加密帧头

## 不走本 skill

| 情况 | 去哪 |
|------|------|
| 仅 HTTP 参数签名 / JS 加密 | `seagull-reverse`（客户端算法） |
| 仅 TLS 证书问题 | `seagull-pentest` 或浏览器代理 |
| 固件内协议栈深挖 + 仿真 | `seagull-reverse`（固件面） |

## 工作流

### Phase 1 — 采集与分诊

```text
□ 拿到样本：PCAP / 代理导出 / 客户端日志 / 二进制
□ 标记方向：C→S / S→C；是否有握手、心跳、重连
□ 固定头？魔数？长度字段？TLV？定长？
□ 是否压缩（zlib/gzip/lz4）或加密（AES/ChaCha 帧内）
□ tshark -r cap.pcap -T fields -e frame.number -e ip.src -e tcp.payload
```

### Phase 2 — 帧布局还原

```text
□ 对齐多个同类消息，找不变字节 / 自增序列号
□ 长度字段：大端/小端、含头/不含头
□ 校验：CRC16/32、checksum、HMAC 位置
□ 画出状态机：Connect → Auth → Ready → Request/Response → Close
□ 工具：Wireshark 自定义 dissector 草稿 / ImHex / 010 Editor 模板 / Kaitai Struct
```

### Phase 3 — 序列化与加密

```text
□ Protobuf：.proto 恢复（blackboxprotobuf / pbtk / protoc --decode_raw）
□ gRPC：HTTP/2 headers + protobuf body
□ 加密：找密钥派生（客户端 so/dll/JS）→ 联合 `seagull-reverse` / `rev-symbol`
□ 重放：仅在本次 scope 内；先无害字段再敏感操作
```

### Phase 4 — 产物

```text
MUST 产出：
- 消息类型表（name / opcode / fields）
- 至少 1 条可复现的解码命令或脚本
- Evidence：原始 hex 摘录 + 解码结果（脱敏）
```

## 工具链

| 工具 | 必需 | 用途 | 自举 |
|------|------|------|------|
| tshark / Wireshark | 强烈建议 | PCAP 解析 | 手动 / winget |
| Python3 | 是 | 解码脚本 | 系统 |
| blackboxprotobuf | 可选 | 未知 protobuf | pip |
| ImHex / 010 | 可选 | 结构模板 | 手动 |
| IDA / r2 / Ghidra | 按需 | 客户端序列化函数 | 见对应 skill |

## 参考

- `seagull-reverse`：客户端算法与二进制逆向下沉到这里
- `rev-symbol` / `rev-struct`：先恢复符号与结构，再回来解字段
- `seagull-pentest`：解码后的重放与接口越权验证

## 路由上下文

**上游**: 无总控文件；由宿主按 `whenToUse` 直接触发
**下游**: 需客户端算法 → `seagull-reverse` / `rev-symbol`；需利用重放 → `seagull-pentest`
**同级**: `thick-client`（客户端一侧）、`seagull-pentest`（重放验证）

## 判据：帧布局算不算还原

- 至少**两条同类消息**对齐后字段位置能重复预测，布局才算成立；单条样本上的规律常是巧合。
- 长度字段含头/不含头判错会让后面全部错位，用两条长度不同的消息交叉验证。
- 高熵不等于加密，也可能是压缩；先看帧头与熵的分布再判断。
- **换路**：TLS/证书钉扎挡在通道层时先解决通道，不要对着密文猜结构。

## 任务完成自检

- [ ] 是否还原了消息布局或状态机（而非只贴 hex）？
- [ ] 是否有可复现解码命令？
- [ ] 是否遵守 scope / 脱敏？
- [ ] 是否把消息类型表与原始报文留下来（不只写"已分析"）？