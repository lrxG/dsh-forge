---
name: crack-reverse-toolchain
description: 逆向/破解开测前工具链体检：jadx/apktool/frida/ghidra/rizin/adb 是否可用；缺工具记 blocked。
whenToUse: crack 会话开始、准备反编译/动态调试/脱壳/打补丁之前
role: triage
enabled: true
---

# 工具链与执行层

## 先体检

1. 调 `crack_toolchain({action:"status"})`，看 `summary.missing_ids`。
2. 缺工具时调 `crack_toolchain({action:"plan"})`，把安装建议写进 dossier；不要跳过缺失项，也不要声称已经分析。
3. 只有 `status.tools[].ok === true` 的工具才能写进“已执行”。

## Frida 配方

- `crack_frida_recipe({action:"list"})` 列出 Android SSL pinning、root 检测绕过、crypto trace、iOS NSURLSession 追踪。
- `crack_frida_recipe({action:"get", id:"..."})` 取脚本；`save` 落到 `$DSH_HOME/crack/recipes/<id>.js`。
- 只提供脚本，不自动 attach；执行前确认设备、包名、frida-server 版本。
- 配方无效时记录“已尝试 + 失败信号”，不要把它当成漏洞结论。

## 二进制补丁

- `crack_binary_patch` 永远写新文件，`output` 不能等于 `input`。
- 每个补丁尽量带 `expect` 原字节；不匹配会整体中止，不产生半成品。
- `patches` 用 `{offset, bytes}`、`{va, bytes}` 或 `{offset, nop}`；PE 默认重算 checksum。
- 交付时写：输入哈希、输出哈希、补丁偏移/长度、原字节断言、回滚副本。

## 流水线

按 crack 角色走，不要在角色之间跳步：

1. **triage**：`crack_toolchain({action:"status"})` → 文件类型/壳/入口/授权线索 → 选择 static 或 dynamic 路线。
2. **static**：jadx / apktool / aapt 看清单与资源；ghidra / rizin 看原生（Ghidra 12 需 JDK 25）；capa / yara / strings 做能力与字符串筛查。
3. **dynamic**：`crack_frida_recipe` 取 SSL pinning / root / crypto / NSURLSession 配方；objection、adb 只做设备侧操作。
4. **patch**：`crack_binary_patch` 写副本；APK 重打包后用 zipalign + apksigner 重签。
5. **verify**：补丁前失败 → 应用补丁 → 补丁后成功；记录哈希、回滚副本和失败信号。

每一步的结论、命令、原始输出路径写进 `crack_case`；缺工具写 `blocked`，不要跨步编结论。

## 收口

缺工具（blocked）、配方失败（refuted）、补丁未验证（candidate）要分开写。不要用“应该可以”代替实际执行证据。
