---
name: crack-js-electron
description: JS / Electron / 小程序逆向：asar 解包重打包、授权逻辑定位、sourcemap 还原、wxapkg 解包、混淆处理。
whenToUse: 目标是 Electron、小程序（wxapkg）、Node 打包应用或纯前端校验时
role: static
enabled: true
---

# JS / Electron / 小程序

## 路线

- Electron：解 asar → 在产物里检索授权逻辑 → 改 → 重新打包。
- 纯前端校验的常见形态：登录/会员态存在 localStorage 或配置文件；授权函数返回布尔；卡密接口返回结果。
- 小程序：解 wxapkg 得到 app.json + pages + 逻辑 js，按同样思路定位。
- 混淆 JS：先从入口（app.json / main.js）顺引用链找授权模块，必要时上反混淆。

## 判据

- 改的必须是**运行时真正加载的那份代码**（asar/打包产物里的），不是源码目录副本；两者常常不是同一版本。
- 反幻觉：改 localStorage、配置文件、缓存只改变当前设备状态，不是破解；sourcemap 还原的代码可能与实际运行的压缩代码不同版本。
- 判断函数恒真后功能仍受限，说明还有第二处校验（主进程、原生模块、服务端）。
- **换路**：校验在服务端时本地改判断只能骗界面，转去抓包，或如实标注"仅前端绕过"。

## 交付

结论与证据；补丁走 patch 角色的交付四件套。
