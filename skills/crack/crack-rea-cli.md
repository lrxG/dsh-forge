---
name: crack-rea-cli
description: REA CLI 逆向分析管线：结构化类/方法/引用分析、JNI 与 so 关联、证据 JSON 归档。
whenToUse: 需要结构化可追溯的逆向证据，或要把分析结果存档进案例库时
role: static
enabled: true
---

# REA 管线

## 用法

`rea` 在 PATH 里直接用；不在 PATH 时用 `REA_CMD` 或 `REA_MJS` 指定入口，插件自动发现，找不到就不挂这个 MCP 服务，其它工具不受影响。

子命令（模型不一定知道，留在这里）：`doctor` 环境自检 · `inspect-android-package` APK 结构化分析 · `analyze-javascript-application` JS/Electron 分析 · `open-binary` 原生二进制（需 Ghidra/IDA provider）· `inspect-web-network-capture` 抓包回放。都支持 `--json`。

## 判断

- 它的长处是**结构化引用**，全文检索仍以反编译输出目录为准，两者互补。
- 结论要与反编译直出结果或运行时观测对得上才算数。
- provider 缺失时能力会静默降级：输出看着正常，但少了分析面。

## 判据

- 有效：类/方法/引用关系能与 jadx 或运行时**对上**；对不上是解析口径不同，不是结论冲突。
- 反幻觉：JSON 里的"结论/推断"字段是它的判断，不是证据。
- **换路**：结果与字节码或运行时矛盾时，以字节码/运行时为准，把差异记成"待核"。

## 交付

证据 JSON 归档进案例目录，关键结论转写进报告。
