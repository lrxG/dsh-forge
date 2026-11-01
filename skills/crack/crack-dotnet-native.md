---
name: crack-dotnet-native
description: .NET / Unity 与原生二进制（PE/ELF/so）破解路线：定位授权类、IL 补丁、反汇编与字节补丁。
whenToUse: 目标是 .NET/Unity 游戏、原生程序或 so 库时
role: static
enabled: true
---

# .NET / Unity / 原生路线

## 判断与路线

- 程序集看 MZ 头与导入（`mscoree` / CoreCLR）；Unity 的授权逻辑常在主程序集与 `Assembly-CSharp` 里。
- 托管层改 IL（恒真返回、改字段值、换字符串），注意强命名要处理。
- 原生层：字符串引用定位判断分支 → 改跳转字节；so 库同理，JNI 导出是入口。
- 壳与混淆先分类：UPX 可脱，VMProtect/Themida 重壳按卡点处理，IL 混淆用反混淆器。

## 判据

- 判据只有一条：**改了这一处，行为变了**。字符串检索命中只说明字符串存在，不说明有人拿它做判断。
- 反幻觉：Unity 的 Assembly-CSharp 常常只是壳，真正逻辑在热更 dll、il2cpp 全局元数据里；托管层找不到不等于没有。
- 同一逻辑可能有两份（首发版与热更版、主程序集与插件程序集），改完要确认运行的是改过的那份。
- **换路**：il2cpp / 加固壳 / 反混淆失败 → 转动态观测或 dump，别在托管层硬挖。

## 交付

结论与依据；补丁走 patch 角色的交付四件套。
