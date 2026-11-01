/* 设计令牌与全部 CSS。
   令牌优先吃宿主 --dsw-alias-*，宿主没有时用兜底值；明暗由 data-ds-dark-theme 切换。
   结构色走官方 alias，语义色由 state-* 与 label-primary 混合得到（自动跟随明暗）。 */

function dfInjectStyles() {
  if (document.getElementById('dsh-forge-client-styles')) return
  const el = document.createElement('style')
  el.id = 'dsh-forge-client-styles'
  el.textContent = `
  /* ---------------------------------------------------------------- 令牌
     视图只消费 --df-*，不直接写色值。括号里是预览壳（没有宿主 token）时的兜底。 */
  .dfx-dock,.dfx-launch,.df-portal,.df-rewind-wrap{
    /* 底色与分隔：iOS 分组列表配色（灰底白卡），不再跟随宿主灰蓝色板。 */
    --df-bg:#f2f2f7;
    --df-surface:#ffffff;
    /* 凹陷面（分段控件 / 键帽 / 引用块）：半透明灰，叠在任何底色上都成立。 */
    --df-surface-2:rgba(118,118,128,.12);
    /* 胶囊控件底色（顶栏靶标按钮）：浅色下要略深于 surface-2，白底上才看得出「一块」。 */
    --df-fill:rgba(118,118,128,.18);
    --df-fill-hover:rgba(118,118,128,.26);
    --df-line:rgba(60,60,67,.18);
    --df-line-soft:rgba(60,60,67,.08);
    /* 文字：sub 是信息性文字（≥4.5:1），faint 只给图标与装饰。 */
    --df-ink:#1c1c1e;
    --df-sub:#6e6e73;
    --df-faint:#8e8e93;
    --df-ink-inv:#ffffff;
    /* 强调色 = iOS systemBlue。结构强调用它，语义色各管各的。 */
    --df-accent:#007aff;
    --df-accent-hover:#0069d9;
    --df-accent-soft:rgba(0,122,255,.12);
    --df-sel:rgba(0,122,255,.14);
    --df-hover:rgba(120,120,128,.08);
    --df-hover-2:rgba(120,120,128,.14);
    /* 语义色：正文色压暗保证对比度；solid 留给要抢眼的色块（徽章 / 圆点）。 */
    --df-ok:#1f8f42;
    --df-warn:#a55a00;
    --df-err:#c4271c;
    --df-info:#0057c2;
    --df-ok-solid:#34c759;
    --df-warn-solid:#ff9500;
    --df-err-solid:#d93025;
    --df-info-solid:#007aff;
    --df-ok-soft:rgba(52,199,89,.14);
    --df-warn-soft:rgba(255,149,0,.14);
    --df-err-soft:rgba(255,59,48,.12);
    --df-info-soft:rgba(0,122,255,.12);
    /* 严重度徽章：critical/high 实心，medium/low 淡底 —— 一眼分得出轻重。 */
    --df-sev-critical-bg:#d93025;
    --df-sev-critical-fg:#ffffff;
    --df-sev-high-bg:#f59e0b;
    --df-sev-high-fg:#231400;
    --df-sev-medium-bg:rgba(245,158,11,.18);
    --df-sev-medium-fg:#8a5100;
    --df-sev-low-bg:rgba(120,120,128,.14);
    --df-sev-low-fg:#6e6e73;
    /* 浮层 */
    --df-mask:rgba(0,0,0,.32);
    --df-shadow-1:0 1px 2px rgba(0,0,0,.04),0 6px 20px rgba(0,0,0,.05);
    --df-shadow-2:0 30px 80px rgba(0,0,0,.22),0 4px 14px rgba(0,0,0,.08);
    /* 字体与尺寸 */
    /* 字号刻度：全站只用这一组，别在规则里现写 px。
       num   26  大数字（首屏状态带 / 严重度）
       page  17  页面标题
       card  15  卡片标题
       row   14  列表主标题、表格「身份列」
       body  14  正文、表格单元格（与 row 同值，语义不同：row 表示「这是主信息」）
       meta  13   副行、时间戳、工具名、说明
       micro 12.5 结构性微标签：顶栏、菜单、快捷键、导航分组名、矩阵列头副行 */
    --df-t-num:26px;
    --df-t-page:17px;
    --df-t-card:15px;
    --df-t-row:14px;
    --df-t-body:14px;
    --df-t-meta:13px;
    --df-t-micro:12.5px;
    --df-font:var(--dsw-font-family,-apple-system,"SF Pro Text","PingFang SC","Microsoft YaHei",system-ui,sans-serif);
    --df-mono:var(--ds-font-family-code,ui-monospace,"SF Mono","Cascadia Code",Consolas,monospace);
    --df-r-xs:8px;
    --df-r-sm:10px;
    --df-r:14px;
    --df-r-lg:20px;
    --df-row:46px;
    --df-fs:14px;
  }
  body[data-ds-dark-theme] .dfx-dock,body[data-ds-dark-theme] .dfx-launch,
  body[data-ds-dark-theme] .df-portal,body[data-ds-dark-theme] .df-rewind-wrap{
    --df-bg:#1c1c1e;
    --df-surface:#2c2c2e;
    --df-surface-2:rgba(118,118,128,.24);
    /* 胶囊控件底色（顶栏靶标按钮）：比 surface-2 更实一档，暗色下才看得出是「一块」。 */
    --df-fill:#3a3a3c;
    --df-fill-hover:#48484a;
    --df-line:rgba(84,84,88,.65);
    --df-line-soft:rgba(84,84,88,.4);
    --df-ink:#f2f2f7;
    --df-sub:#aeaeb2;
    --df-faint:#8e8e93;
    --df-ink-inv:#ffffff;
    --df-accent:#0a84ff;
    --df-accent-hover:#409cff;
    --df-accent-soft:rgba(10,132,255,.22);
    --df-sel:rgba(10,132,255,.26);
    --df-hover:rgba(255,255,255,.07);
    --df-hover-2:rgba(255,255,255,.12);
    --df-ok:#30d158;
    --df-warn:#ff9f0a;
    --df-err:#ff453a;
    --df-info:#64d2ff;
    --df-ok-solid:#30d158;
    --df-warn-solid:#ff9f0a;
    --df-err-solid:#d93025;
    --df-info-solid:#0a84ff;
    --df-ok-soft:rgba(48,209,88,.18);
    --df-warn-soft:rgba(255,159,10,.18);
    --df-err-soft:rgba(255,69,58,.18);
    --df-info-soft:rgba(100,210,255,.16);
    --df-sev-critical-bg:#d93025;
    --df-sev-critical-fg:#ffffff;
    --df-sev-high-bg:#ff9f0a;
    --df-sev-high-fg:#1c1c1e;
    --df-sev-medium-bg:rgba(255,159,10,.2);
    --df-sev-medium-fg:#ffc46b;
    --df-sev-low-bg:rgba(120,120,128,.28);
    --df-sev-low-fg:#c7c7cc;
    --df-mask:rgba(0,0,0,.55);
  }

  /* ---------------------------------------------------------------- 基础 */
  .dfx-dock,.dfx-dock *,.df-portal,.df-portal *,.df-rewind-wrap,.df-rewind-wrap *{box-sizing:border-box}
  .dfx-dock,.df-portal,.df-rewind-wrap{color:var(--df-ink);font:var(--df-fs)/1.5 var(--df-font);
    -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
  .dfx-dock ::selection,.df-portal ::selection{background:var(--df-accent-soft)}
  .dfx-dock button,.dfx-dock input,.dfx-dock select,.dfx-dock textarea,
  .df-portal button,.df-portal input,.df-portal select,.df-portal textarea,
  .df-rewind-wrap button,.df-rewind-wrap input,.df-rewind-wrap select,.df-rewind-wrap textarea{font-family:inherit}
  .dfx-dock button:focus-visible,.dfx-dock input:focus-visible,.dfx-dock select:focus-visible,
  .dfx-dock textarea:focus-visible,.dfx-dock [tabindex]:focus-visible,
  .df-portal button:focus-visible,.df-portal input:focus-visible,.df-portal [tabindex]:focus-visible{outline:2px solid var(--df-accent);outline-offset:1px}
  .dfx-dock a,.df-portal a{color:var(--dsw-alias-link,var(--df-accent));text-decoration:none}
  .dfx-dock ::-webkit-scrollbar,.df-portal ::-webkit-scrollbar{width:10px;height:10px}
  /* 滚动条：平时很淡，鼠标进面板才显形 —— 像系统 overlay 滚动条，
     而不是网页那种常驻的一条灰杠。 */
  .dfx-dock ::-webkit-scrollbar-thumb,.df-portal ::-webkit-scrollbar-thumb{
    background:color-mix(in srgb,var(--df-ink) 10%,transparent);border-radius:999px;
    border:3px solid transparent;background-clip:content-box;transition:background .15s}
  .dfx-dock:hover ::-webkit-scrollbar-thumb,.df-portal:hover ::-webkit-scrollbar-thumb{
    background:color-mix(in srgb,var(--df-ink) 18%,transparent);
    border:3px solid transparent;background-clip:content-box}
  .dfx-dock ::-webkit-scrollbar-thumb:hover,.df-portal ::-webkit-scrollbar-thumb:hover{
    background:color-mix(in srgb,var(--df-ink) 30%,transparent);
    border:3px solid transparent;background-clip:content-box}
  .dfx-dock ::-webkit-scrollbar-track,.df-portal ::-webkit-scrollbar-track{background:transparent}

  /* ---------------------------------------------------------------- 启动器 */
  .dfx-launch{position:absolute;right:18px;bottom:18px;z-index:2147483000;display:inline-flex;align-items:center;gap:7px;
    height:32px;padding:0 12px 0 10px;border:1px solid var(--df-line);border-radius:999px;background:var(--df-surface);
    color:var(--df-sub);font-size:14px;font-weight:600;line-height:1;cursor:pointer;
    box-shadow:var(--df-shadow-1);pointer-events:auto;-webkit-app-region:no-drag;
    transition:color .16s,background .16s,border-color .16s,transform .16s}
  .dfx-launch:hover{color:var(--df-ink);border-color:color-mix(in srgb,var(--df-accent) 45%,var(--df-line));transform:translateY(-1px)}
  .dfx-launch:active{transform:translateY(0)}
  .dfx-launch .df-dot{width:6px;height:6px;border-radius:50%;background:var(--df-ok);box-shadow:0 0 0 3px var(--df-ok-soft)}

  /* ---------------------------------------------------------------- 外壳 */
  /* 面板出现时给 140ms 的轻微放大 + 淡入：本地应用不会「啪」地贴一屏，
     而是从触发它的地方长出来。位移只有 2px，够被眼睛读到，又不会显得在表演。 */
  .dfx-dock{position:absolute;z-index:2147483001;display:flex;flex-direction:column;background:var(--df-bg);
    border:1px solid var(--df-line-soft);border-radius:var(--df-r-lg);overflow:hidden;box-shadow:var(--df-shadow-2);
    pointer-events:auto;min-width:640px;min-height:420px;
    animation:dfx-rise .14s cubic-bezier(.2,.7,.3,1) both}
  @keyframes dfx-rise{from{opacity:0;transform:translateY(2px) scale(.995)}to{opacity:1;transform:none}}
  .dfx-inner{display:flex;flex-direction:column;min-width:0;min-height:0;width:100%;height:100%;position:relative}
  .dfx-head{display:flex;align-items:center;gap:10px;height:48px;padding:0 10px 0 16px;flex:none;
    background:var(--df-surface);border-bottom:1px solid var(--df-line-soft);-webkit-app-region:no-drag;
    cursor:default;user-select:none}
  .dfx-mark{width:24px;height:24px;border-radius:7px;display:flex;align-items:center;justify-content:center;flex:none;
    background:var(--df-accent);color:var(--df-ink-inv)}
  .dfx-brand{font-weight:700;font-size:15px;letter-spacing:.02em;white-space:nowrap}
  /* 产品副名：中文字距拉开一点、颜色压淡，跟主名形成主次，而不是两个同权重的大字。 */
  .dfx-sub{font-size:12px;color:var(--df-faint);white-space:nowrap;letter-spacing:.05em;
    padding-left:8px;border-left:1px solid var(--df-line)}
  /* 作者署名：只做识别，不做视觉重心 —— 比副名更小更淡。字号 12 是面板的字号下限
     （全页审计要求除矩阵列头副行外不得低于 12），所以不靠字号再压，只靠颜色。 */
  .dfx-by{font-size:12px;color:var(--df-faint);white-space:nowrap;opacity:.8;
    font-variant-numeric:tabular-nums;letter-spacing:.01em;transition:opacity .15s}
  .dfx-head:hover .dfx-by{opacity:1}
  .dfx-spacer{margin-left:auto}

  /* 顶栏按可用宽度逐级收窄（JS 实测 scrollWidth 后写 data-hd）：
     先去掉副标题与说明文字，再去掉品牌字、缩小靶标名，最后收起缩放组与模式。
     窗控和权限档位永远保留：这两样在窄窗里也不能消失。 */
  .dfx-head[data-hd]{gap:6px}
  .dfx-head[data-hd="1"] .dfx-sub,
  .dfx-head[data-hd="1"] .dfx-by,
  .dfx-head[data-hd="1"] .df-topbtn-t,
  .dfx-head[data-hd="1"] .df-topbtn kbd,
  .dfx-head[data-hd="1"] .df-target-meta{display:none}
  .dfx-head[data-hd="1"] .df-target-name{max-width:140px}
  .dfx-head[data-hd="2"] .dfx-brand{display:none}
  .dfx-head[data-hd="2"] .df-target-name{max-width:96px}
  .dfx-head[data-hd="3"] .df-zoom{display:none}
  .dfx-head[data-hd="3"] .df-target{max-width:150px}
  .dfx-head[data-hd="3"] .df-target-name{max-width:78px}
  .dfx-head[data-hd="3"] .df-inject-label{display:none}
  .dfx-docktabs{display:flex;gap:2px;background:var(--df-surface-2);padding:2px;border-radius:var(--df-r-sm);-webkit-app-region:no-drag}
  .dfx-docktabs button{font-size:14px;font-weight:500;height:26px;padding:0 12px;border:0;background:transparent;
    border-radius:7px;color:var(--df-sub);cursor:pointer;transition:background .15s,color .15s}
  .dfx-docktabs button:hover{color:var(--df-ink)}
  .dfx-docktabs button.on{background:var(--df-surface);color:var(--df-ink);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08),0 2px 6px rgba(0,0,0,.04)}
  .dfx-tag{font-size:12px;font-weight:600;color:var(--df-sub);white-space:nowrap;
    display:inline-flex;align-items:center;height:24px;padding:0 10px;
    border:1px solid var(--df-line);border-radius:999px;background:transparent}
  /* 顶栏破甲状态：名字固定“破甲注入”，圆点红=未启动，绿=已启动。 */
  .df-inject-chip{height:26px;gap:6px;color:var(--df-sub);cursor:pointer;font:inherit;font-size:12px;font-weight:600}
  .df-inject-chip:hover{background:var(--df-fill);color:var(--df-ink)}
  .df-inject-chip .df-inject-dot{width:7px;height:7px;border-radius:50%;flex:none}
  .df-inject-wrap{position:relative;display:flex;align-items:center}
  .df-inject-menu{left:auto;right:0;width:300px}
  .df-inject-menu-bd{padding:8px;display:flex;flex-direction:column;gap:6px}
  .df-inject-menu-ft{display:flex;align-items:center;justify-content:flex-end;gap:6px;padding:8px;
    border-top:1px solid var(--df-line-soft)}
  .df-agent-modes{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 10px;
    border:1px solid var(--df-line);border-radius:10px;background:var(--df-surface)}
  .df-agent-modes .df-ops-meta{margin-right:4px}
  .df-agent-mode{height:28px;padding:0 12px;border:1px solid var(--df-line);border-radius:999px;
    background:transparent;color:var(--df-sub);font:inherit;font-size:12.5px;cursor:pointer;
    transition:background .15s,color .15s,border-color .15s}
  .df-agent-mode:hover{background:var(--df-hover);color:var(--df-ink)}
  .df-agent-mode.is-on{background:var(--df-accent-soft);border-color:color-mix(in srgb,var(--df-accent) 45%,var(--df-line));
    color:var(--df-accent);font-weight:650}
  /* 破甲注入页的状态区：大按钮开关，不用小滑块。 */
  .df-inject-hero{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 14px;margin-bottom:10px;
    border:1px solid var(--df-line);border-radius:12px;background:var(--df-surface-2)}
  .df-inject-hero.is-on{border-color:color-mix(in srgb,var(--df-ok-solid) 32%,var(--df-line));
    background:color-mix(in srgb,var(--df-ok-solid) 6%,var(--df-surface))}
  .df-ih-main{flex:1 1 220px;min-width:0;display:flex;flex-direction:column;gap:2px}
  .df-ih-main b{font-size:14px;color:var(--df-ink)}
  .df-ih-main span{font-size:12.5px;color:var(--df-sub);line-height:1.5}
  /* 破甲注入未生效时的顶部提示条：比顶栏小按钮更显眼，说明「为什么现在不算正常破甲」。 */
  .df-inject-banner{position:relative;z-index:3;display:flex;align-items:center;gap:12px;padding:12px 14px;
    flex-wrap:wrap;
    border:1px solid color-mix(in srgb,var(--df-warn-solid) 38%,var(--df-line));border-radius:12px;
    background:color-mix(in srgb,var(--df-warn-solid) 8%,var(--df-surface));
    box-shadow:0 1px 2px rgba(0,0,0,.04)}
  .df-inject-banner.is-soft{border-color:var(--df-line);background:var(--df-surface)}
  .df-inject-banner.is-soft .df-ib-ico{background:var(--df-fill);color:var(--df-sub)}
  .df-ib-ico{flex:none;width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;
    background:var(--df-warn-soft);color:var(--df-warn)}
  .df-ib-main{min-width:0;flex:1 1 240px;display:flex;flex-direction:column;gap:2px}
  .df-ib-main b{font-size:14px;color:var(--df-ink)}
  .df-ib-main span{font-size:12.5px;color:var(--df-sub);line-height:1.5}
  .df-ib-act{display:flex;gap:6px;align-items:center;flex:none}
  .df-scope-line{display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap}
  .df-scope-main{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
  .df-scope-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  /* 补丁方案条：推荐 / 仅核心 / 全部，右侧是“只看已停用”。 */
  .df-presetbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:10px 12px 0;
    border-top:1px solid var(--df-line-soft);margin-top:2px}
  .df-presetbar .df-ops-meta{margin-right:2px}
  .df-presetbar .df-agent-mode{height:26px;padding:0 11px;font-size:12.5px}
  .df-scheme-chip{display:inline-flex;align-items:center;height:26px;border:1px solid var(--df-line);
    border-radius:999px;background:transparent;overflow:hidden}
  .df-scheme-chip.is-on{border-color:color-mix(in srgb,var(--df-accent) 45%,var(--df-line));
    background:var(--df-accent-soft)}
  .df-scheme-name{border:0;background:transparent;height:24px;padding:0 8px 0 11px;
    font:inherit;font-size:12.5px;color:var(--df-sub);cursor:pointer;white-space:nowrap}
  .df-scheme-name:hover{color:var(--df-ink)}
  .df-scheme-chip.is-on .df-scheme-name{color:var(--df-accent);font-weight:650}
  .df-scheme-x{border:0;border-left:1px solid var(--df-line-soft);background:transparent;
    height:24px;width:23px;color:var(--df-faint);font-size:13px;line-height:1;cursor:pointer;padding:0}
  .df-scheme-x:hover{background:var(--df-err-soft);color:var(--df-err)}
  .df-scheme-save{display:inline-flex;align-items:center;gap:5px}
  /* 补丁标签筛选条：核心用强调色，选中后实心。 */
  .df-tagbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:10px 12px 0}
  .df-tagbar .df-agent-mode{height:26px;padding:0 11px;font-size:12.5px}
  /* 核心默认保持中性，只加粗；只有点中筛选时才用强调色。
     否则它和“全部”同时像选中，两个橙块叠在一起会发浑。 */
  .df-tag-chip.is-core{border-color:var(--df-line);background:transparent;
    color:var(--df-sub);font-weight:700}
  .df-tag-chip.is-core.is-on{background:var(--df-accent-soft);
    border-color:color-mix(in srgb,var(--df-accent) 45%,var(--df-line));color:var(--df-accent)}
  /* 生效范围的模式名是给人看的，不能套 9.5px 的小 chip：单独放大到正文尺寸。 */
  .df-scope-chips .df-chip{height:26px;padding:0 11px;border-radius:8px;font-size:12.5px;font-weight:620;letter-spacing:0}
  .df-scope-chips .df-chip svg{width:12px;height:12px}
  .dfx-x{border:0;background:transparent;color:var(--df-sub);font-size:17px;cursor:pointer;width:28px;height:28px;
    display:inline-flex;align-items:center;justify-content:center;border-radius:var(--df-r-sm);-webkit-app-region:no-drag;
    transition:background .15s,color .15s}
  .dfx-x:hover{background:var(--df-hover);color:var(--df-ink)}

  /* 导航（左侧常驻栏）
     位置按「工作频率」排：作业在最上（每一轮都在用），交付其次，资源与配置垫底。
     频率表写死在 DF_NAV 里，**不按最近点击自动重排** —— 键盘不会因为你刚敲了 A 就换键位，
     空间记忆一旦建立就不该被打乱。 */
  .dfx-nav{display:flex;flex-direction:column;width:176px;flex:none;padding:6px 8px;
    background:var(--df-bg);border-right:1px solid var(--df-line-soft);overflow:hidden}
  .dfx-navlist{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:2px}
  .dfx-navlist::-webkit-scrollbar{width:8px}
  .dfx-ngrp{font-size:12px;font-weight:600;letter-spacing:.05em;color:var(--df-sub);
    padding:12px 10px 5px;white-space:nowrap;user-select:none;-webkit-user-select:none;pointer-events:none}
  .dfx-ngrp-block:first-child .dfx-ngrp{padding-top:4px}
  .dfx-navbtn{position:relative;display:flex;flex:none;align-items:center;gap:9px;width:100%;height:32px;
    padding:0 9px;border:0;border-radius:9px;background:transparent;color:var(--df-sub);
    font-size:var(--df-t-meta);font-weight:500;line-height:1;cursor:pointer;text-align:left;white-space:nowrap;
    transition:background .14s,color .14s,box-shadow .14s}
  .dfx-navbtn>svg{opacity:.8}
  .dfx-navbtn .df-navtxt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
  .dfx-navbtn:hover{background:var(--df-hover);color:var(--df-ink)}
  /* 选中 = 实底胶囊 + 极轻阴影（浮在浅灰侧栏上），不加左侧色条、不整行反白。 */
  .dfx-navbtn.on{background:var(--df-surface);color:var(--df-ink);font-weight:600;
    box-shadow:0 1px 2px rgba(0,0,0,.06),0 0 0 1px rgba(60,60,67,.08)}
  .dfx-navbtn.on>svg{color:var(--df-accent);opacity:1}
  .dfx-navbtn .df-navdot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--df-err)}
  .dfx-navfoot{display:flex;align-items:center;gap:2px;flex:none;margin-top:6px;padding-top:6px;
    border-top:1px solid var(--df-line-soft)}
  .dfx-navfold{display:flex;align-items:center;gap:9px;flex:1;min-width:0;height:30px;padding:0 9px;border:0;
    border-radius:9px;background:transparent;color:var(--df-faint);font-size:var(--df-t-meta);cursor:pointer;
    white-space:nowrap;transition:background .14s,color .14s}
  .dfx-navfold--icon{flex:none;width:30px;justify-content:center;padding:0}
  .dfx-nav.is-mini .dfx-navfold--icon{display:none}
  .dfx-navfold:hover{background:var(--df-hover);color:var(--df-sub)}
  .dfx-navfold-ico{display:flex;flex:none;transition:transform .16s ease}
  .dfx-navfold-ico.is-mini{transform:rotate(180deg)}
  /* 收起：56px 纯图标栏，分组改用细线分隔 —— 宽度变了，但每一项的上下顺序不变。 */
  .dfx-nav.is-mini{width:56px;padding:6px}
  .dfx-nav.is-mini .dfx-ngrp{display:none}
  .dfx-nav.is-mini .dfx-ngrp-block:not(:first-child){margin-top:8px;padding-top:8px;
    border-top:1px solid var(--df-line-soft)}
  .dfx-nav.is-mini .dfx-navbtn{justify-content:center;padding:0}
  .dfx-nav.is-mini .dfx-navbtn .df-navtxt{display:none}
  .dfx-nav.is-mini .dfx-navbtn .df-navdot{position:absolute;top:6px;right:7px;width:5px;height:5px}
  .dfx-nav.is-mini .dfx-navfold{justify-content:center;padding:0;flex:none;width:30px}
  /* 沉浸模式：侧栏变成贴左边缘的浮层。收起时完全让出宽度，
     鼠标进入 12px 热区才滑出 —— 它不参与布局，主区宽度不会跟着鼠标抖。 */
  .dfx-navzone{display:none}
  .dfx-dock[data-nav="hidden"] .dfx-navzone{display:block;position:absolute;left:0;top:0;bottom:0;width:12px;z-index:6}
  .dfx-dock[data-nav="hidden"] .dfx-navzone::after{content:"";position:absolute;left:3px;top:50%;margin-top:-18px;
    width:3px;height:36px;border-radius:2px;background:var(--df-line);opacity:.32;transition:opacity .15s}
  .dfx-dock[data-nav="hidden"] .dfx-navzone:hover::after{opacity:.9}
  .dfx-dock[data-nav="hidden"] .dfx-nav{position:absolute;left:0;top:0;bottom:0;z-index:7;width:176px;
    border-right:1px solid var(--df-line);box-shadow:10px 0 28px rgba(0,0,0,.14);
    transform:translateX(-100%);opacity:0;pointer-events:none;
    transition:transform .16s cubic-bezier(.2,.7,.3,1),opacity .12s ease}
  .dfx-dock[data-nav="hidden"] .dfx-navzone:hover ~ .dfx-nav,
  .dfx-dock[data-nav="hidden"] .dfx-nav:hover,
  .dfx-dock[data-nav="hidden"] .dfx-nav:focus-within{transform:none;opacity:1;pointer-events:auto}

  .dfx-body{flex:1;display:flex;min-height:0;width:100%;background:var(--df-bg);position:relative}
  .dfx-main{flex:1;min-width:0;overflow:auto;padding:18px;display:flex;flex-direction:column;gap:14px;
    container-type:inline-size;position:relative}
  .dfx-main>*{max-width:1480px;width:100%;margin-left:auto;margin-right:auto}
  /* 常驻页：只显示当前这一个，其余的留在 DOM 里但不可见。
     display:none 而不是 visibility —— 藏起来的页不参与布局和绘制，切换更省。 */
  .dfx-pane{display:none;flex-direction:column;gap:14px;width:100%;max-width:1480px;margin:0 auto}
  .dfx-pane[data-on="1"]{display:flex}
  /* 内容层压在残影之下：残影是「盖在上面的上一页」，揭开才看得到内容。 */
  .dfx-pane .df-viewbox,.dfx-main>.df-viewbox{position:relative;z-index:1}
  /* 上一帧残影：整块盖在主区上（含内边距），带不透明底 + 裁切，
     所以它不是「垫在下面透出来」，而是真的把新页挡住 —— 新页可以直接在它背后
     慢慢画完，画好了再一次性揭开。这样中间永远不会露出空白或骨架。 */
  .dfx-frame{position:absolute;inset:0;padding:18px;overflow:hidden;pointer-events:none;user-select:none;
    background:var(--df-bg);display:flex;flex-direction:column;gap:14px;
    opacity:0;visibility:hidden;z-index:2}
  .dfx-frame>*{max-width:1480px;width:100%;margin-left:auto;margin-right:auto}
  .dfx-frame[data-on="1"]{opacity:1;visibility:visible}
  /* 抽屉从右侧滑进来（不是瞬间撑开），关掉时由 React 直接卸载，不做退场动画 ——
     退场动画会让「点了没反应」的错觉变长。 */
  .dfx-side{width:380px;flex:none;border-left:1px solid var(--df-line-soft);background:var(--df-surface);
    padding:16px;overflow:auto;display:flex;flex-direction:column;gap:12px;
    animation:dfx-slide .16s cubic-bezier(.2,.7,.3,1) both}
  @keyframes dfx-slide{from{opacity:.4;transform:translateX(10px)}to{opacity:1;transform:none}}
  /* ------------------------------------------------ 整页详情（iOS push 式下钻）
     点列表进来 → 一层新页面，左上角返回；内容占满，不再和列表抢宽度。
     数据接口沿用抽屉的 { title, sub, rows, node }，调用方加 mode:'page' 即可。 */
  .dfx-dock>.dfx-page{max-width:none;width:100%;margin:0}
  .dfx-page{position:absolute;inset:0;z-index:40;display:flex;flex-direction:column;
    background:var(--df-surface);animation:dfPageIn .24s cubic-bezier(.32,.72,0,1) both}
  .dfx-page-hd{flex:0 0 auto;display:flex;align-items:center;gap:10px;height:48px;
    padding:0 12px 0 6px;border-bottom:1px solid var(--df-line-soft);background:var(--df-surface);
    box-shadow:0 1px 0 var(--df-line-soft)}
  .dfx-page-back{display:inline-flex;align-items:center;gap:4px;height:32px;padding:0 10px 0 6px;
    border:0;border-radius:8px;background:transparent;color:var(--df-accent);
    font-size:12.5px;font-weight:650;cursor:pointer}
  .dfx-page-back:hover{background:var(--df-hover)}
  .dfx-page-tt{display:flex;flex-direction:column;gap:1px;min-width:0}
  .dfx-page-tt b{font-size:14px;font-weight:650;line-height:1.3;max-width:46ch;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .dfx-page-tt small{font-size:10.5px;color:var(--df-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .dfx-page-bd{flex:1;overflow:auto;padding:14px 16px 32px}
  /* 整页里的长文本编辑器：占满可用高度、用等宽字体；不要在窄抽屉里改大段文字。 */
  /* 只有「文档类」编辑器放大：人格 / 角色稿 / 破甲注入 / 规则片段。
     漏洞复核、短表单这类普通 df-area 保持默认高度，不要跟着一起铺满。 */
  .dfx-page-bd textarea.df-area--doc,
  .dfx-page-bd textarea.df-area--code{min-height:56vh;font-size:13px;line-height:1.7;resize:vertical}
  /* 宽屏下详情内容不铺满整行，长文更好读；字段两列并排。 */
  .dfx-page-bd>.df-kv,
  .dfx-page-bd>.df-detail{max-width:1100px;margin-left:auto;margin-right:auto}
  .dfx-page .df-kv{grid-template-columns:76px minmax(0,1fr) 76px minmax(0,1fr);gap:8px 18px;
    padding:14px 16px;border:1px solid var(--df-line);border-radius:12px;background:var(--df-surface-2)}
  @media (max-width: 760px){
    .dfx-page .df-kv{grid-template-columns:76px minmax(0,1fr)}
  }
  @keyframes dfPageIn{from{opacity:.35;transform:translateX(22px)}to{opacity:1;transform:none}}
  @media (prefers-reduced-motion: reduce){.dfx-page{animation:none}}
  /* ------------------------------------------------ 快速预览卡（peek）
     扫一眼的详情：贴在行旁边，只给 6 个字段 + 复制 + 「查看完整」，
     不需要为一条凭证/通道开整页。 */
  .df-peek{position:fixed;z-index:60;display:flex;flex-direction:column;width:360px;max-height:60vh;
    background:var(--df-surface);border:1px solid var(--df-line);border-radius:12px;
    box-shadow:var(--df-shadow-2);overflow:hidden;
    animation:dfPeekIn .16s cubic-bezier(.2,.7,.3,1) both}
  .df-peek-hd{display:flex;align-items:flex-start;gap:8px;padding:10px 8px 8px 12px;
    border-bottom:1px solid var(--df-line-soft)}
  .df-peek-tt{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
  .df-peek-tt b{font-size:12.5px;font-weight:650;line-height:1.35;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .df-peek-tt small{font-size:10.5px;color:var(--df-faint);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .df-peek-x{border:0;background:transparent;color:var(--df-faint);cursor:pointer;
    padding:3px;border-radius:6px;display:flex}
  .df-peek-x:hover{background:var(--df-hover);color:var(--df-ink)}
  .df-peek-bd{overflow:auto;padding:10px 12px}
  .df-peek .df-kv{grid-template-columns:76px minmax(0,1fr);font-size:12px;gap:6px 10px}
  .df-peek .df-kv dt{font-size:11.5px;line-height:1.5}
  .df-peek-ft{display:flex;align-items:center;gap:8px;padding:8px 10px;
    border-top:1px solid var(--df-line-soft)}
  .df-peek-more{font-size:10px;color:var(--df-faint)}
  @keyframes dfPeekIn{from{opacity:.3;transform:translateY(4px) scale(.985)}to{opacity:1;transform:none}}
  @media (prefers-reduced-motion: reduce){.df-peek{animation:none}}
  /* 工具页双列：卡片短，单列右边会空一大块。auto-fit 在窄窗自动回单列。 */
  .df-tool-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:8px;padding:10px}
  .df-tool-grid .df-vrow{width:100%}
  .dfx-rz{position:absolute;z-index:8;touch-action:none}
  .dfx-rz-r{right:0;top:14px;bottom:14px;width:8px;cursor:ew-resize}
  .dfx-rz-b{left:14px;right:14px;bottom:0;height:8px;cursor:ns-resize}
  .dfx-resize{right:0;bottom:0;width:20px;height:20px;cursor:nwse-resize}
  .dfx-resize:after{content:"";position:absolute;right:5px;bottom:5px;width:9px;height:9px;
    border-right:1.5px solid var(--df-faint);border-bottom:1.5px solid var(--df-faint);opacity:.5}
  .dfx-dock:hover .dfx-resize:after{opacity:1}

  /* ---------------------------------------------------------------- 顶栏控件 */
  .df-topbtn{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 8px;border:1px solid transparent;
    border-radius:var(--df-r-sm);background:transparent;color:var(--df-sub);font-size:13px;font-weight:500;line-height:1;
    cursor:pointer;transition:background .15s,color .15s,border-color .15s}
  .df-topbtn:hover{background:var(--df-hover);color:var(--df-ink);border-color:var(--df-line)}
  .df-topbtn kbd,.df-cmd-esc{font-family:var(--df-mono);font-size:12px;font-weight:600;line-height:1;color:var(--df-sub);
    background:var(--df-surface-2);border:1px solid var(--df-line);border-radius:var(--df-r-xs);padding:2px 4px;letter-spacing:0}
  .df-iconbtn{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border:0;
    border-radius:var(--df-r-sm);background:transparent;color:var(--df-sub);font-size:14px;cursor:pointer;flex:none;
    transition:background .15s,color .15s}
  .df-iconbtn:hover{background:var(--df-hover);color:var(--df-ink)}
  .df-iconbtn[disabled]{opacity:.5;cursor:not-allowed}

  /* 顶栏权限档位：常驻一颗，颜色即语义（只读=绿 / 工作区可写=蓝 / 完全访问=橙）。
     造型刻意做成「状态读数」而不是按钮：浅底 + 同色细边 + 前缀「权限」，
     一眼知道这是当前授权限度，点开才会切换。定宽保证换档时整簇不位移。 */
  .dfx-perm{position:relative;display:flex;flex:none}
  .dfx-perm-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:5px;height:24px;width:144px;
    padding:0 6px;border:1px solid transparent;border-radius:8px;
    font-size:12px;font-weight:600;line-height:1;cursor:pointer;white-space:nowrap;
    background:var(--df-surface-2);color:var(--df-sub);
    transition:background .18s ease,color .18s ease,border-color .18s ease,box-shadow .18s ease}
  /* 换档时只有文字轻轻上浮一下：不做整块缩放，避免看起来像闪了一下。 */
  .dfx-perm-name{display:inline-block;font-weight:650;animation:df-perm-swap .18s cubic-bezier(.2,.7,.3,1) both}
  .dfx-perm-prefix{font-weight:500;opacity:.62}
  @keyframes df-perm-swap{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:none}}
  .dfx-perm-btn[data-tone="ok"]{background:var(--df-ok-soft);border-color:rgba(52,199,89,.28);color:var(--df-ok)}
  .dfx-perm-btn[data-tone="info"]{background:var(--df-info-soft);border-color:rgba(0,122,255,.26);color:var(--df-info)}
  .dfx-perm-btn[data-tone="warn"]{background:var(--df-warn-soft);border-color:rgba(255,149,0,.3);color:var(--df-warn)}
  .dfx-perm-btn:hover{filter:brightness(1.04)}
  .dfx-perm-btn:hover>svg:last-child{opacity:.8}
  .dfx-perm-btn.is-open{box-shadow:0 0 0 2px var(--df-accent-soft)}
  .dfx-perm-btn>svg:last-child{opacity:.45}
  /* 「越界时询问」开着时，chip 右上角一个小点：不改变宽度，也不多一行字。 */
  .dfx-perm-flag{position:absolute;top:3px;right:4px;width:5px;height:5px;border-radius:50%;
    background:var(--df-accent);box-shadow:0 0 0 2px var(--df-ok-soft)}
  .dfx-perm-ask{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;
    height:30px;margin-top:2px;padding:0 8px;border:0;border-radius:var(--df-r-sm);
    background:transparent;color:var(--df-sub);font-size:12px;cursor:pointer;text-align:left}
  .dfx-perm-ask:hover{background:var(--df-hover)}
  .dfx-perm-ask[disabled]{opacity:.45;cursor:default}
  .dfx-perm-ask[disabled]:hover{background:transparent}
  .dfx-perm-sw{position:relative;flex:none;width:28px;height:16px;border-radius:999px;
    background:var(--df-surface-2);transition:background .15s}
  .dfx-perm-sw:after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;
    background:var(--df-surface);box-shadow:0 1px 2px rgba(0,0,0,.22);transition:transform .15s}
  .dfx-perm-ask.on{color:var(--df-ink)}
  .dfx-perm-ask.on .dfx-perm-sw{background:var(--df-accent)}
  .dfx-perm-ask.on .dfx-perm-sw:after{transform:translateX(12px)}
  .dfx-perm .dfx-perm-menu{left:auto;right:0;width:280px;top:calc(100% + 6px)}
  .dfx-perm-menu .df-menu-item{padding:8px}
  .dfx-perm-menu .df-menu-item .df-mi-main span{line-height:1.5}
  .dfx-perm-menu .df-menu-item[disabled]{opacity:.6;cursor:progress}
  .dfx-perm-foot{margin-top:5px;padding:7px 8px 4px;border-top:1px solid var(--df-line-soft);
    font-size:12px;line-height:1.5;color:var(--df-faint)}
  .df-zoom{display:inline-flex;align-items:center;gap:1px;height:24px;padding:1px;border-radius:var(--df-r-sm);
    background:var(--df-surface-2);color:var(--df-sub);flex:none}
  .df-zoom button{height:20px;min-width:20px;border:0;border-radius:var(--df-r-xs);background:transparent;color:inherit;
    font-family:var(--df-mono);font-size:12px;font-weight:600;line-height:1;cursor:pointer;
    display:inline-flex;align-items:center;justify-content:center}
  .df-zoom button:hover{background:var(--df-surface);color:var(--df-ink)}
  .df-zoom .df-zoom-v{min-width:38px;font-size:12px}

  /* ---------------------------------------------------------------- 靶标下拉 */
  .df-target{position:relative;display:flex;min-width:0;max-width:340px}
  /* 靶标是「我在哪」，但不需要做成一颗实心胶囊：顶栏的胶囊已经够多了。
     改成扁平入口 —— 悬停浮出底色、打开时才有底，靠前置图标区分层级。 */
  .df-target-btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 8px;max-width:100%;min-width:0;
    border:0;border-radius:var(--df-r-sm);background:transparent;color:var(--df-ink);
    font-size:13px;font-weight:500;line-height:1;cursor:pointer;transition:background .15s}
  .df-target-btn:hover{background:var(--df-hover)}
  .df-target-btn.is-open{background:var(--df-fill);box-shadow:0 0 0 2px var(--df-accent-soft)}
  .df-target-btn>svg:first-child{color:var(--df-accent)}
  .df-target-btn>svg:last-child{opacity:.5}
  .df-target-name{min-width:0;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
  .df-target-meta{font-size:12px;color:var(--df-sub);white-space:nowrap;font-variant-numeric:tabular-nums}
  .df-menu{position:absolute;left:0;top:calc(100% + 6px);z-index:40;width:352px;max-width:min(420px,86vw);
    background:var(--df-surface);border:1px solid var(--df-line);border-radius:var(--df-r);box-shadow:var(--df-shadow-2);
    padding:6px;animation:df-pop .16s cubic-bezier(.2,.7,.3,1)}
  .df-menu-hd{display:flex;align-items:center;gap:7px;padding:5px 8px 7px;font-size:12px;font-weight:650;
    color:var(--df-sub);letter-spacing:.04em}
  .df-menu-list{max-height:300px;overflow:auto;display:flex;flex-direction:column;gap:1px}
  .df-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:7px 8px;border:0;border-radius:var(--df-r-sm);
    background:transparent;color:var(--df-ink);text-align:left;cursor:pointer;font:inherit}
  .df-menu-item:hover{background:var(--df-hover)}
  .df-menu-item.on{background:var(--df-sel)}
  .df-menu-item .df-mi-ico{width:18px;flex:none;display:flex;align-items:center;justify-content:center;color:var(--df-faint)}
  .df-menu-item.on .df-mi-ico{color:var(--df-ink)}
.df-menu-item.is-broken .df-mi-side{color:var(--df-warn)}
  .df-menu-item .df-mi-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
  .df-menu-item .df-mi-main b{font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-menu-item .df-mi-main span{font-size:12px;color:var(--df-sub);font-variant-numeric:tabular-nums}
  .df-menu-item .df-mi-side{font-size:12px;color:var(--df-sub);flex:none}
  .df-menu-empty{padding:18px 10px;text-align:center;font-size:13px;color:var(--df-sub)}
  .df-menu-ft{display:flex;align-items:center;gap:6px;padding:7px 6px 3px;margin-top:4px;
    border-top:1px solid var(--df-line-soft)}
  .df-menu-form{display:flex;flex-direction:column;gap:9px;padding:2px 4px 3px}
  .df-menu-warn{display:flex;flex-direction:column;gap:2px;padding:8px 9px;border-radius:var(--df-r-sm);
    background:var(--df-err-soft);color:var(--df-err);font-size:13px;line-height:1.55}
  .df-menu-warn b{font-size:14px}
  .df-menu-note{padding:7px 9px;border-radius:var(--df-r-sm);background:var(--df-surface-2);color:var(--df-sub);
    font-size:13px;line-height:1.55}
  .df-menu-note.is-err{background:var(--df-err-soft);color:var(--df-err)}
  .df-menu-note.is-warn{background:var(--df-warn-soft);color:var(--df-warn)}
  .df-del-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
  .df-del-cell{display:flex;flex-direction:column;align-items:center;gap:1px;padding:7px 4px;
    border:1px solid var(--df-line-soft);border-radius:var(--df-r-sm);background:var(--df-surface-2)}
  .df-del-cell b{font-size:17px;font-variant-numeric:tabular-nums}
  .df-del-cell span{font-size:12px;color:var(--df-sub)}

  .df-cwdrow{cursor:pointer;padding:6px 8px;gap:9px}
  .df-cwdrow input{flex:none;width:14px;height:14px;accent-color:var(--df-accent)}
  .df-cwdrow .df-ri-main{display:flex;flex-direction:column;gap:1px;white-space:normal;overflow:hidden}
  .df-cwdrow b{font-size:13px;font-weight:600}
  .df-cwdrow small{font-size:12px;color:var(--df-sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-btnrow{display:flex;align-items:center;gap:6px;flex:none}

  /* ---------------------------------------------------------------- 抽屉 / 空白 */
  .dfx-side{position:relative;overflow:hidden;gap:0;container-type:inline-size}
  /* 抽屉窄时表单改单列：两列会把输入框压到只剩几十像素。 */
  @container (max-width: 430px){
    .df-formgrid{grid-template-columns:1fr}
    .df-formgrid .df-field--wide{grid-column:auto}
  }
  /* 抽屉必须恰好填满侧栏：否则内容会顶出去、滚动条被侧栏的 overflow:hidden 吃掉。 */
  .dfx-side>.df-drawer{flex:1;min-height:0;height:auto}
  .dfx-side-grip{position:absolute;left:-3px;top:0;bottom:0;width:7px;cursor:ew-resize;z-index:3}
  .dfx-side-grip:hover{background:var(--df-accent-soft)}
  .df-blank{flex:1;display:flex;align-items:center;justify-content:center;min-height:280px}
  .df-blank .df-empty{padding:20px}
  .df-cmd-none{padding:18px 10px;text-align:center;font-size:13px;color:var(--df-sub)}
  .df-cmd .df-cmd-in .df-cmd-esc{flex:none}

  /* ---------------------------------------------------------------- 智能体 */
  .df-agents-set{display:flex;align-items:flex-end;gap:18px;padding:4px 14px 14px;flex-wrap:wrap}
  .df-agents-slider{flex:1;min-width:220px;display:flex;flex-direction:column;gap:5px}
  .df-agents-slider input[type="range"]{width:100%;accent-color:var(--df-accent);cursor:pointer}
  .df-agents-scale{display:flex;justify-content:space-between;font-size:12px;color:var(--df-sub)}
  .df-agents-num{display:flex;align-items:center;gap:6px}
  .df-agents-num .df-input{width:86px}

  /* ---------------------------------------------------------------- 按钮 */
  .df-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;
    border:1px solid var(--df-line-soft);border-radius:var(--df-r-sm);background:var(--df-surface);color:var(--df-ink);
    font-size:14px;font-weight:560;line-height:1;cursor:pointer;white-space:nowrap;
    transition:background .15s,border-color .15s,color .15s,transform .1s}
  .df-btn:hover{background:var(--df-hover)}
  .df-btn:active{transform:translateY(.5px)}
  .df-btn[disabled]{opacity:.45;cursor:not-allowed;transform:none}
  .df-btn--sm{height:26px;padding:0 9px;font-size:13px}
  .df-btn--lg{height:34px;padding:0 16px;font-size:15px}
  .df-btn--icon{width:30px;padding:0}
  .df-btn--primary{background:var(--df-accent);border-color:var(--df-accent);color:var(--df-ink-inv);font-weight:600;
    box-shadow:0 1px 2px rgba(0,122,255,.24)}
  .df-btn--primary:hover{background:var(--df-accent-hover);border-color:var(--df-accent-hover)}
  .df-btn--ghost{background:transparent;border-color:transparent;color:var(--df-sub)}
  .df-btn--ghost:hover{background:var(--df-hover);color:var(--df-ink);border-color:transparent}
  .df-btn--danger{color:var(--df-err);border-color:color-mix(in srgb,var(--df-err) 35%,var(--df-line))}
  .df-btn--danger:hover{background:var(--df-err-soft)}
  .df-btn--solid-danger{background:var(--df-err-solid);border-color:var(--df-err-solid);color:#fff}
  .df-btn--solid-danger:hover{background:color-mix(in srgb,var(--df-err-solid) 86%,#000)}

  /* ---------------------------------------------------------------- 表单 */
  .df-input,.df-select,.df-area{width:100%;border:1px solid transparent;border-radius:var(--df-r-sm);
    background:var(--df-surface-2);color:var(--df-ink);font-size:14px;line-height:1.4;padding:0 11px;height:32px;min-width:0;
    transition:border-color .15s,box-shadow .15s,background .15s}
  .df-area{height:auto;min-height:120px;padding:9px 11px;resize:vertical;line-height:1.65}
  /* 短清单（一行一个目录）按 rows 走，别被 120px 的下限撑成一大块空框。 */
  .df-area--list{min-height:0;height:64px}
  .df-input::placeholder,.df-area::placeholder{color:var(--df-faint)}
  .df-input:focus,.df-select:focus,.df-area:focus{outline:none;background:var(--df-surface);border-color:var(--df-accent);
    box-shadow:0 0 0 3px var(--df-accent-soft)}
  .df-input--sm{height:26px;font-size:13px}
  .df-search{position:relative;display:flex;align-items:center;min-width:180px}
  .df-search .df-search-ico{position:absolute;left:8px;color:var(--df-faint);pointer-events:none}
  .df-search .df-input{padding-left:28px;padding-right:26px}
  /* 用自绘的清空按钮，隐藏 WebKit 原生那个，避免叠两个 ×。 */
  .df-search .df-input::-webkit-search-cancel-button,
  .df-search .df-input::-ms-clear{display:none}
  .df-search .df-search-clear{position:absolute;right:4px;border:0;background:transparent;color:var(--df-faint);
    width:20px;height:20px;border-radius:var(--df-r-xs);cursor:pointer;display:flex;align-items:center;justify-content:center}
  .df-search .df-search-clear:hover{background:var(--df-hover);color:var(--df-ink)}
  .df-field{display:flex;flex-direction:column;gap:5px;min-width:0}
  .df-field>label,.df-label{font-size:13px;font-weight:600;color:var(--df-sub);letter-spacing:.01em}
  .df-field .df-hint{font-size:var(--df-t-meta);color:var(--df-sub);line-height:1.5}
  /* 表单校验：出错时输入框描红、提示行跟着变红；归一化/范围过大这类「不是错」的说明压暗一档。 */
  .df-field .df-hint.is-err{color:var(--df-err)}
  .df-field .df-hint .df-hint-sub{color:var(--df-faint)}
  .df-input.is-err{border-color:var(--df-err)}
  .df-input.is-err:focus{box-shadow:0 0 0 2px var(--df-err-soft)}
  .df-switch{position:relative;display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:14px}
  .df-switch input{position:absolute;opacity:0;width:0;height:0}
  .df-switch i{width:34px;height:20px;border-radius:999px;background:var(--df-surface-2);border:1px solid var(--df-line);
    position:relative;transition:background .16s,border-color .16s;flex:none}
  .df-switch i:after{content:"";position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;
    background:var(--df-surface);box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .16s}
  .df-switch input:checked+i{background:var(--df-accent);border-color:var(--df-accent)}
  .df-switch input:checked+i:after{transform:translateX(14px);background:var(--df-ink-inv)}

  /* ---------------------------------------------------------------- 胶囊 / 徽标 */
  .df-chip{display:inline-flex;align-items:center;gap:5px;height:23px;padding:0 9px;border-radius:999px;
    font-size:13px;font-weight:600;letter-spacing:.01em;white-space:nowrap;background:var(--df-surface-2);
    color:var(--df-sub);border:1px solid transparent}
  .df-chip .df-dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
  .df-chip--ok{background:var(--df-ok-soft);color:var(--df-ok)}
  .df-chip--warn{background:var(--df-warn-soft);color:var(--df-warn)}
  .df-chip--err{background:var(--df-err-soft);color:var(--df-err)}
  .df-chip--info{background:var(--df-info-soft);color:var(--df-info)}
  .df-chip--line{background:transparent;border-color:var(--df-line);color:var(--df-sub)}
  .df-count{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;
    border-radius:999px;background:var(--df-surface-2);color:var(--df-sub);font-size:12px;font-weight:650;
    font-variant-numeric:tabular-nums}

  /* ---------------------------------------------------------------- 卡片 / KPI */
  .df-card{background:var(--df-surface);border:1px solid var(--df-line-soft);border-radius:var(--df-r-lg);min-width:0;
    box-shadow:var(--df-shadow-1);overflow:hidden}
  .df-card-hd{display:flex;align-items:center;gap:8px;padding:14px 18px;border-bottom:1px solid var(--df-line-soft);min-height:50px}
  .df-card-hd b{font-size:var(--df-t-card);font-weight:650;letter-spacing:normal;white-space:nowrap;flex:none}
  .df-card-hd .df-sub{font-size:13px;color:var(--df-sub);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-card-hd .df-spacer{margin-left:auto}
  .df-card-hd>.df-opsbar{flex:0 1 auto;flex-wrap:wrap;justify-content:flex-end;row-gap:6px;min-width:0}
  .df-card-bd{padding:10px 8px}
  .df-card-bd--pad{padding:16px}
  .df-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:12px}
  .df-kpi{position:relative;background:var(--df-surface);border:1px solid var(--df-line-soft);border-radius:var(--df-r-lg);
    padding:14px 16px 12px;overflow:hidden;min-width:0;box-shadow:var(--df-shadow-1)}
  .df-kpi .df-kpi-l{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:var(--df-sub);
    letter-spacing:.01em}
  .df-kpi .df-kpi-v{margin-top:6px;font-size:var(--df-t-num);font-weight:700;letter-spacing:-.03em;
    font-variant-numeric:tabular-nums;line-height:1.1}
  .df-kpi .df-kpi-v small{font-size:13px;font-weight:500;color:var(--df-sub);margin-left:4px;letter-spacing:0}
  .df-kpi .df-kpi-f{font-size:13px;color:var(--df-sub);margin-top:4px;
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
  .df-kpi .df-spark{position:absolute;right:12px;bottom:10px;display:flex;align-items:flex-end;gap:2px;height:22px;opacity:.85}
  .df-kpi .df-spark i{width:3px;border-radius:999px;background:var(--df-accent);opacity:.35}
  .df-kpi .df-spark i:last-child{opacity:.9}
  .df-kpi--accent{background:linear-gradient(160deg,var(--df-accent-soft),transparent 66%),var(--df-surface)}

  /* ---------------------------------------------------------------- 横向状态带 */
  /* 一排数字装在同一张白卡里：首屏依然是一整块白，切页明暗连续。
     窄了就自动折行，每条自带左侧分隔线，不靠外面切格子。 */
  .df-statsbar{display:flex;flex-wrap:wrap;background:var(--df-surface);border:1px solid var(--df-line-soft);
    border-radius:var(--df-r-lg);box-shadow:var(--df-shadow-1);padding:4px 0;overflow:hidden}
  /* 数字和标签同一行：数字大、标签跟在后头当说明，副行垫底。
     一条带子压到两行高，切页时首屏重心不上移。 */
  .df-stat{flex:1 1 168px;min-width:0;padding:8px 16px;position:relative;display:flex;flex-direction:column;justify-content:center;gap:0}
  .df-stat+.df-stat::before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:1px;background:var(--df-line-soft)}
  .df-stat-l{display:flex;align-items:center;gap:5px;font-size:13px;font-weight:500;color:var(--df-sub);
    white-space:nowrap;order:2}
  .df-stat-l svg{flex:none;opacity:.75}
  .df-stat-v{font-size:var(--df-t-num);font-weight:700;letter-spacing:-.03em;line-height:1.2;order:1;display:inline-flex;
    align-items:baseline;flex-wrap:wrap;row-gap:0;font-variant-numeric:tabular-nums;color:var(--df-ink)}
  .df-stat-v small{font-size:13px;font-weight:500;color:var(--df-sub);letter-spacing:0}
  .df-stat-f{font-size:var(--df-t-meta);font-weight:500;color:var(--df-sub);white-space:nowrap;overflow:hidden;
    text-overflow:ellipsis;margin-left:10px;opacity:.8}
  .df-stat--accent .df-stat-v{color:var(--df-accent)}
  @container (max-width:560px){
    .df-stat{flex-basis:50%}
    .df-stat+.df-stat::before{display:none}
  }

  /* ---------------------------------------------------------------- 表格 */
  .df-table{width:100%;border-collapse:separate;border-spacing:0;font-size:var(--df-t-body)}
  /* 主区表格给个下限：列被压到几十像素时还不如横向滚动。抽屉里的表格不适用。 */
  .dfx-main .df-table{min-width:560px}
  .df-table th{position:sticky;top:0;z-index:2;background:var(--df-surface);text-align:left;font-size:13px;
    font-weight:600;color:var(--df-sub);letter-spacing:.02em;padding:0 12px;height:38px;white-space:nowrap;
    border-bottom:1px solid var(--df-line-soft)}
  .df-table th.df-sortable{cursor:pointer;user-select:none}
  .df-table th.df-sortable:hover{color:var(--df-ink)}
  .df-table th .df-sortico{display:inline-flex;vertical-align:-2px;margin-left:3px;opacity:.5}
  .df-table th.df-sorted .df-sortico{opacity:1;color:var(--df-accent)}
  .df-table td{padding:0 12px;height:var(--df-row);border-bottom:1px solid var(--df-line-soft);vertical-align:middle}
  /* 身份列（资产 IP、技能名、URL…）加重一档，让表格有一列主信息。
     注意：**不要加负的小数字距**（-0.01em 这类）——Windows 上字形会落到非整数像素位，
     灰度抗锯齿把笔画摊开，看起来就是「糊」。实测漏洞清单里字距是 normal，所以显清晰。 */
  .df-table td:first-child{font-size:var(--df-t-row);font-weight:560;letter-spacing:normal}
  .df-table tbody tr{transition:background .12s}
  .df-table tbody tr:hover{background:var(--df-hover)}
  .df-table tbody tr.df-row--sel{background:var(--df-sel)}
  .df-table tbody tr.df-row--click{cursor:pointer}
  .df-table tbody tr.df-row--click:focus-visible{outline:2px solid var(--df-accent);outline-offset:-2px}
  .df-table tbody tr:last-child td{border-bottom:0}
  .df-table .df-num{font-variant-numeric:tabular-nums;color:var(--df-sub);white-space:nowrap}
  .df-table .df-nm{font-weight:560}
  /* 维护页补丁表：主行中文名，副行一句人话。两行都要能省略，不然窄窗撑破表格。
     注意 td.df-ellip>* 会把直接子元素强制 display:block，这里用更高特异性改回 flex。 */
  .df-table td.df-ellip>span.df-pname{display:flex;flex-direction:column;gap:1px;min-width:0;max-width:100%}
  .df-table .df-pname.is-off{opacity:.55}
  .df-table .df-pname-core{display:inline-block;margin-left:6px;padding:0 4px;border-radius:4px;font-style:normal;font-size:9px;line-height:14px;font-weight:700;letter-spacing:.04em;vertical-align:1px;
    background:var(--df-accent-soft);color:var(--df-accent);
    box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--df-accent) 32%,transparent)}
  /* 核心补丁整行加重：左侧色条 + 淡底，滚动时一眼能找到。 */
  .df-table tbody tr.df-row--core{background:color-mix(in srgb,var(--df-accent-soft) 55%,var(--df-surface))}
  .df-table tbody tr.df-row--core td:first-child{box-shadow:inset 3px 0 0 var(--df-accent)}
  .df-table tbody tr.df-row--core:hover{background:color-mix(in srgb,var(--df-accent-soft) 80%,var(--df-surface))}
  /* 补丁标签：核心最重，其它按语义色轻量显示。 */
  .df-ptags{display:flex;align-items:center;gap:3px;flex-wrap:wrap}
  .df-ptag{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:5px;
    font-size:10px;line-height:1;font-weight:600;letter-spacing:.02em;white-space:nowrap;
    background:var(--df-surface-2);color:var(--df-sub)}
  .df-ptag--core{background:var(--df-accent-soft);color:var(--df-accent);font-weight:750;
    box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--df-accent) 32%,transparent)}
  .df-ptag--info{background:var(--df-info-soft);color:var(--df-info)}
  .df-ptag--warn{background:var(--df-warn-soft);color:var(--df-warn)}
  .df-ptag--ok{background:var(--df-ok-soft);color:var(--df-ok)}
  /* 表格里的开关缩一号：默认 34×20 在 42px 行高里太抢眼。 */
  .df-table .df-switch--sm i{width:28px;height:16px}
  .df-table .df-switch--sm i:after{width:12px;height:12px;top:1px;left:1px}
  .df-table .df-switch--sm input:checked+i:after{transform:translateX(12px)}
  .df-table .df-switch--sm.is-busy{opacity:.5;pointer-events:none}
  .df-table .df-switch--sm.is-confirm i{border-color:var(--df-warn);box-shadow:0 0 0 3px var(--df-warn-soft)}
  .df-table .df-pname b{font-size:12.5px;font-weight:620;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .df-table .df-pname small{font-size:10.5px;line-height:1.35;font-weight:400;color:var(--df-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  /* 表格里的等宽（IP / URL / 路径）跟正文同字号：等宽体本身字面窄，
     再压到 13px 就会显得比旁边的正文小一号、也发虚。 */
  .df-table .df-mono{font-family:var(--df-mono);font-size:var(--df-t-body);letter-spacing:normal}
  .df-table .df-tight{width:1%;white-space:nowrap}
  .df-table--compact td{height:32px}
  .df-table--cozy td{height:40px}
  .df-table .df-ellip{max-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  /* 固定布局：列的百分比宽度真的按表格宽度算，不会因为某列内容长就把表撑出卡片。
     单元格里的内容要自己省略（td.df-ellip>* 或 .df-dvc-t 这类）。 */
  .df-table--fixed{table-layout:fixed}
  /* 省略列里的内容常包一层 span（等宽路径、带图标的单元）。td 上的 ellipsis
     管不到子元素，窄窗时会把整张表顶宽、右侧被卡片裁掉；让子元素自己在格子里截断。 */
  .df-table td.df-ellip>*{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

  /* ---------------------------------------------------------------- 覆盖矩阵
     格子是「状态」不是按钮：只用一个彩点 + 文字，不填底色、不加 hover 放大。
     要动数据得点整行去资产页补测，行尾的 › 就是这个入口。 */
  .df-mxbox{display:flex;flex-direction:column;gap:8px;padding:0 6px 4px}
  .df-mx-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:2px 8px 0}
  .df-mx-legend{display:flex;align-items:center;gap:14px;font-size:12.5px;color:var(--df-sub);flex-wrap:wrap;row-gap:4px}
  .df-mx-lg{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
  .df-mx-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--df-faint)}
  .df-mx-dot--tested{background:var(--df-ok-solid)}
  .df-mx-dot--clean{background:var(--df-faint)}
  .df-mx-dot--skipped{background:var(--df-warn-solid)}
  .df-mx-dot--untested{background:transparent;border:1.5px dashed var(--df-faint);width:7px;height:7px}
  .df-mx-tools{margin-left:auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .df-mx-note{font-size:12.5px;color:var(--df-faint);padding:0 10px}
  .df-mxwrap{overflow:auto;max-height:min(56vh,520px);border-radius:var(--df-r)}
  .df-mx{width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed}
  .df-mx th{font-weight:600;text-align:center;padding:9px 2px 10px;vertical-align:bottom;background:transparent}
  .df-mx th.df-mx-an{text-align:left;padding-left:12px;width:23%}
  .df-mx .df-mx-l{display:block;font-size:13px;font-weight:650;color:var(--df-ink);white-space:nowrap}
  .df-mx .df-mx-h{display:block;font-size:11.5px;font-weight:500;color:var(--df-faint);margin-top:2px;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .df-mx td{height:44px;padding:0 4px;border-bottom:1px solid var(--df-line-soft)}
  .df-mx tbody tr:last-child td{border-bottom:0}
  .df-mx tbody tr{transition:background .12s}
  .df-mx tbody tr:hover{background:var(--df-hover)}
  .df-mx tbody tr.df-row--click{cursor:pointer}
  .df-mx td.df-mx-an{padding-left:12px;padding-right:8px}
  .df-mx .df-mx-aip{font-family:var(--df-mono);font-size:15px;font-weight:600;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .df-mx .df-mx-sub{font-size:13px;color:var(--df-sub);margin-top:1px;white-space:nowrap;
    overflow:hidden;text-overflow:ellipsis}
  /* 「差 N 类」单独一段，不是 done 时橙色，让缺口一眼跳出来。 */
  .df-mx .df-mx-gap{font-weight:650}
  .df-mx .df-mx-gap--all{color:var(--df-err)}
  .df-mx .df-mx-gap--some{color:var(--df-warn)}
  .df-mx .df-cell{display:flex;align-items:center;justify-content:center;gap:6px;height:44px;
    font-size:14px;font-weight:550;color:var(--df-sub);white-space:nowrap}
  .df-mx .df-cell i{width:7px;height:7px;border-radius:50%;flex:none}
  .df-mx .df-cell--tested i{background:var(--df-ok-solid)}
  .df-mx .df-cell--clean i{background:var(--df-faint)}
  .df-mx .df-cell--blocked i,.df-mx .df-cell--skipped i{background:var(--df-warn-solid)}
  .df-mx .df-cell--untested{color:var(--df-faint)}
  .df-mx .df-cell--untested i{background:transparent;border:1.5px dashed var(--df-faint);width:6px;height:6px}
  .df-mx th.df-mx-th{white-space:nowrap;padding-left:2px;padding-right:2px}
  .df-mx td.df-mx-go{width:20px;text-align:right;padding-right:6px;color:var(--df-faint);font-size:16px;font-weight:600}
  .df-mx tbody tr:hover td.df-mx-go{color:var(--df-accent)}

  /* ---------------------------------------------------------------- 列表 / 时间线 */
  .df-rows{display:flex;flex-direction:column}
  .df-rowitem{display:flex;align-items:center;gap:10px;min-height:38px;padding:5px 8px;border-radius:var(--df-r-sm);
    border-bottom:1px solid var(--df-line-soft);font-size:14px;transition:background .12s}
  .df-rowitem:last-child{border-bottom:0}
  .df-rowitem:hover{background:var(--df-hover)}
  .df-rowitem--click{cursor:pointer}
  .df-rowitem .df-ri-main{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-rowitem .df-ri-side{flex:none;font-size:13px;color:var(--df-sub);font-variant-numeric:tabular-nums}
  .df-ri-bar{width:3px;height:22px;border-radius:999px;background:var(--df-line);flex:none}
  .df-ri-bar--err{background:var(--df-err)} .df-ri-bar--warn{background:var(--df-warn)}
  .df-ri-bar--ok{background:var(--df-ok)} .df-ri-bar--info{background:var(--df-info)}

  .df-tl{position:relative;padding-left:18px}
  .df-tl:before{content:"";position:absolute;left:5px;top:6px;bottom:6px;width:1.5px;background:var(--df-line)}
  .df-tl-item{position:relative;padding:7px 0 9px;cursor:pointer}
  .df-tl-item:before{content:"";position:absolute;left:-17px;top:13px;width:9px;height:9px;border-radius:50%;
    background:var(--df-surface);border:2px solid var(--df-line);transition:border-color .15s}
  .df-tl-item:hover:before{border-color:var(--df-accent)}
  .df-tl-item--ok:before{border-color:var(--df-ok)}
  .df-tl-item--err:before{border-color:var(--df-err)}
  .df-tl-item--warn:before{border-color:var(--df-warn)}
  .df-tl-item .df-tl-h{display:flex;align-items:center;gap:8px;font-size:var(--df-t-row);font-weight:600}
  .df-tl-item .df-tl-d{font-size:13px;color:var(--df-sub);margin-top:1px}
  .df-tl-item .df-tl-t{font-size:var(--df-t-meta);color:var(--df-sub);font-variant-numeric:tabular-nums;flex:none;margin-left:auto}

  /* ---------------------------------------------------------------- 空 / 骨架 / 加载 */
  .df-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;
    padding:34px 20px;text-align:center;color:var(--df-sub)}
  .df-empty .df-empty-ico{width:34px;height:34px;border-radius:var(--df-r-sm);display:flex;align-items:center;justify-content:center;
    background:var(--df-surface-2);color:var(--df-faint)}
  .df-empty b{font-size:14px;font-weight:600;color:var(--df-ink)}
  .df-empty span{font-size:13px;color:var(--df-sub);max-width:360px;line-height:1.6}
  .df-skel{background:var(--df-surface-2);border-radius:var(--df-r-xs)}
  .df-skel--line{height:12px;margin:6px 0}
  /* 切页那一瞬的占位：三个静态小点，安静但不至于一屏全空。
     刻意不做呼吸动画 —— 这段占位只活几十毫秒，动画刚起就被内容顶掉，
     眼睛收到的是「有个东西动了一下又没了」，反而像闪。切页里不放任何正在动的东西。 */
  .df-inline-wait{display:flex;align-items:center;justify-content:center;gap:6px;min-height:160px}
  .df-inline-wait i{width:6px;height:6px;border-radius:50%;background:var(--df-faint);opacity:.3}
  /* 等得久的加载态：一个图标 + 主句 + 说明，跟「空状态」同一套骨架，不闪。 */
  .df-wait{min-height:190px;display:flex;flex-direction:column;align-items:center;justify-content:center;
    gap:6px;text-align:center;padding:28px 20px}
  .df-wait-badge{width:38px;height:38px;border-radius:11px;display:flex;align-items:center;justify-content:center;
    background:var(--df-surface-2);color:var(--df-sub);margin-bottom:4px}
  .df-wait p{margin:0;font-size:14px;font-weight:600;color:var(--df-ink)}
  .df-wait span{font-size:13px;color:var(--df-sub);line-height:1.6;max-width:320px}
  /* 切页时上一帧留在原位（不重新挂载、不卸 DOM），只逐出交互与过渡，
     等新视图数据回来再整体换掉 —— 避免「空白 → 骨架 → 内容」三道闪。 */
  .df-keepalive{transition:none !important}
  .df-keepalive *{animation:none !important;transition:none !important}
  .df-keepalive[aria-hidden="true"]{pointer-events:none !important;user-select:none}
  .df-keepalive[aria-hidden="true"] a,.df-keepalive[aria-hidden="true"] button,
  .df-keepalive[aria-hidden="true"] input,.df-keepalive[aria-hidden="true"] select{pointer-events:none !important}
  .df-spin{width:14px;height:14px;border-radius:50%;border:2px solid color-mix(in srgb,var(--df-ink) 16%,transparent);
    border-top-color:var(--df-accent);animation:df-spin .7s linear infinite;flex:none}
  @keyframes df-spin{to{transform:rotate(360deg)}}

  /* ---------------------------------------------------------------- 分段 / 标签页 */
  .df-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;background:var(--df-surface-2);border-radius:var(--df-r-sm)}
  .df-seg button{height:28px;padding:0 11px;border:0;border-radius:8px;background:transparent;color:var(--df-sub);
    font-size:13px;font-weight:500;line-height:1;cursor:pointer;white-space:nowrap;transition:background .14s,color .14s}
  .df-seg button:hover{color:var(--df-ink)}
  .df-seg button.on{background:var(--df-surface);color:var(--df-ink);font-weight:600;box-shadow:var(--df-shadow-1)}
  .df-tabs{display:flex;align-items:center;gap:2px;border-bottom:1px solid var(--df-line);padding:0 4px}
  .df-tab{position:relative;height:34px;padding:0 11px;border:0;background:transparent;color:var(--df-sub);
    font-size:14px;font-weight:500;line-height:1;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
  .df-tab:hover{color:var(--df-ink)}
  .df-tab.on{color:var(--df-ink);font-weight:600}
  .df-tab.on:after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;border-radius:999px;background:var(--df-accent)}

  /* ---------------------------------------------------------------- 抽屉 */
  .df-drawer{display:flex;flex-direction:column;min-height:0;height:100%}
  .df-drawer-hd{display:flex;align-items:flex-start;gap:8px;padding:0 0 10px;border-bottom:1px solid var(--df-line-soft)}
  .df-drawer-hd .df-drawer-t{flex:1;min-width:0}
  .df-drawer-hd b{display:block;font-size:15px;font-weight:650;word-break:break-all;line-height:1.4}
  .df-drawer-hd .df-sub{font-size:13px;color:var(--df-sub);margin-top:2px}
  .df-drawer-bd{flex:1;overflow:auto;padding:12px 0 4px;display:flex;flex-direction:column;gap:12px}
  /* 抽屉里只保留一层滚动：正文块跟随内容展开，别再套内部滚动条。 */
  .df-drawer .df-code{max-height:none}
  .df-kv{display:grid;grid-template-columns:76px minmax(0,1fr);gap:7px 10px;font-size:14px}
  .df-kv dt{color:var(--df-sub);font-size:13px;line-height:1.6}
  .df-kv dd{margin:0;word-break:break-word;line-height:1.6}
  .df-code{font-family:var(--df-mono);font-size:13px;line-height:1.65;background:var(--df-surface-2);
    color:var(--df-ink);border:1px solid var(--df-line-soft);border-radius:var(--df-r-sm);padding:9px 10px;
    white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto}
  .df-copy{display:inline-flex;align-items:center;gap:4px;border:0;background:transparent;color:var(--df-sub);
    font:inherit;font-size:12px;cursor:pointer;padding:2px 4px;border-radius:var(--df-r-xs)}
  .df-copy:hover{background:var(--df-hover);color:var(--df-ink)}

  /* ---------------------------------------------------------------- Toast */
  .df-toasts{position:absolute;right:16px;bottom:16px;z-index:20;display:flex;flex-direction:column;gap:8px;
    pointer-events:none;max-width:380px}
  .df-toast{display:flex;align-items:flex-start;gap:8px;padding:9px 12px;border-radius:var(--df-r);background:var(--df-surface);
    border:1px solid var(--df-line);box-shadow:var(--df-shadow-2);font-size:14px;color:var(--df-ink);
    pointer-events:auto;animation:df-toast-in .18s cubic-bezier(.2,.7,.3,1)}
  .df-toast .df-toast-i{flex:none;margin-top:1px}
  .df-toast--ok .df-toast-i{color:var(--df-ok)}
  .df-toast--err .df-toast-i{color:var(--df-err)}
  .df-toast--info .df-toast-i{color:var(--df-info)}
  @keyframes df-toast-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}

  /* ---------------------------------------------------------------- 命令面板 */
  .df-cmd-mask{position:absolute;inset:0;z-index:30;background:var(--df-mask);
    display:flex;align-items:flex-start;justify-content:center;padding-top:12vh;animation:df-fade .14s ease}
  @keyframes df-fade{from{opacity:0}to{opacity:1}}
  .df-cmd{width:min(520px,86%);background:var(--df-surface);border:1px solid var(--df-line);border-radius:var(--df-r-lg);
    box-shadow:var(--df-shadow-2);overflow:hidden;animation:df-pop .18s cubic-bezier(.2,.7,.3,1)}
  @keyframes df-pop{from{opacity:0;transform:translateY(-6px) scale(.99)}to{opacity:1;transform:none}}
  .df-cmd .df-cmd-in{display:flex;align-items:center;gap:8px;padding:10px 13px;border-bottom:1px solid var(--df-line-soft)}
  .df-cmd .df-cmd-in input{flex:1;border:0;background:transparent;color:var(--df-ink);font-size:15px;line-height:1.4;outline:none}
  .df-cmd .df-cmd-list{max-height:320px;overflow:auto;padding:6px}
  .df-cmd .df-cmd-item{display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:var(--df-r-sm);font-size:14px;
    color:var(--df-ink);cursor:pointer}
  .df-cmd .df-cmd-item .df-cmd-k{margin-left:auto;font-size:12px;color:var(--df-sub);font-family:var(--df-mono)}
  .df-cmd .df-cmd-item.on,.df-cmd .df-cmd-item:hover{background:var(--df-sel)}

  /* ---------------------------------------------------------------- 兼容旧视图 */
  .dfx-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
  .dfx-kpi{background:var(--df-surface);border:1px solid var(--df-line);border-radius:var(--df-r);
    padding:11px 13px}
  .dfx-kpi .v{font-size:var(--df-t-num);font-weight:650;font-variant-numeric:tabular-nums;line-height:1.15}
  .dfx-kpi .l{font-size:13px;font-weight:600;color:var(--df-sub);margin-top:2px}
  .dfx-card{background:var(--df-surface);border:1px solid var(--df-line);border-radius:var(--df-r);
    padding:6px 8px;min-width:0}
  .dfx-sect{display:flex;align-items:baseline;gap:8px;margin:4px 0 -4px}
  .dfx-sect b{font-size:14px;font-weight:650}
  .dfx-sect span{font-size:13px;color:var(--df-sub)}
  .dfx-table{width:100%;border-collapse:separate;border-spacing:0;font-size:14px}
  .dfx-table th{text-align:left;font-size:12px;font-weight:600;color:var(--df-sub);letter-spacing:.03em;
    padding:8px 10px;border-bottom:1px solid var(--df-line);white-space:nowrap}
  .dfx-table td{padding:8px 10px;border-bottom:1px solid var(--df-line-soft);height:var(--df-row)}
  .dfx-table tbody tr{transition:background .12s}
  .dfx-table tbody tr:hover{background:var(--df-hover)}
  .dfx-table tbody tr:last-child td{border-bottom:0}
  .dfx-nm{font-weight:560}
  .dfx-num{font-variant-numeric:tabular-nums;color:var(--df-sub)}
  .dfx-sev{display:inline-flex;align-items:center;height:18px;font-size:12px;font-weight:700;padding:0 6px;
    border-radius:var(--df-r-xs);color:var(--df-ink-inv);letter-spacing:.02em}
  .dfx-sev.critical{background:var(--df-err)}
  .dfx-sev.high{background:color-mix(in srgb,var(--df-err) 62%,var(--df-warn))}
  .dfx-sev.medium{background:var(--df-warn)}
  .dfx-sev.low{background:var(--df-sub)}
  .dfx-sev.info{background:var(--df-info)}
  .dfx-st{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;padding:0 7px;height:20px;
    border-radius:999px;white-space:nowrap}
  .dfx-st i{width:5px;height:5px;border-radius:50%}
  .dfx-st.ok{color:var(--df-ok);background:var(--df-ok-soft)} .dfx-st.ok i{background:var(--df-ok)}
  .dfx-st.run{color:var(--df-info);background:var(--df-info-soft)} .dfx-st.run i{background:var(--df-info)}
  .dfx-st.blk{color:var(--df-warn);background:var(--df-warn-soft)} .dfx-st.blk i{background:var(--df-warn)}
  .dfx-st.idle{color:var(--df-sub);background:var(--df-surface-2)} .dfx-st.idle i{background:var(--df-sub)}
  .dfx-todo{display:flex;flex-direction:column;padding:2px 6px}
  .dfx-trow{display:flex;align-items:center;gap:9px;min-height:38px;padding:5px 2px;
    border-bottom:1px solid var(--df-line-soft);font-size:14px}
  .dfx-trow:last-child{border-bottom:0}
  .dfx-kind{font-size:12px;font-weight:600;color:var(--df-sub);border:1px solid var(--df-line);
    border-radius:var(--df-r-xs);padding:0 6px;flex:none;background:var(--df-surface-2);height:18px;display:inline-flex;align-items:center}
  .dfx-trow .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .dfx-trow .why{font-size:var(--df-t-meta);color:var(--df-sub);flex:none}
  .dfx-mx{width:100%;border-collapse:separate;border-spacing:3px;table-layout:fixed}
  .dfx-mx th{font-size:12px;font-weight:600;color:var(--df-sub);text-align:center;padding:0 0 3px}
  .dfx-mx th.an{text-align:left;padding-left:4px;width:34%}
  .dfx-mx td{text-align:center;padding:0;border:0}
  .dfx-mx td.an{text-align:left;font-size:13px;font-weight:560;padding:0 6px 0 4px;white-space:nowrap;
    overflow:hidden;text-overflow:ellipsis}
  .dfx-cell{display:flex;align-items:center;justify-content:center;height:28px;border-radius:var(--df-r-xs);
    font-size:12px;font-weight:650}
  .dfx-cell.tested{background:var(--df-ok-soft);color:var(--df-ok)}
  .dfx-cell.clean{background:var(--df-surface-2);color:var(--df-sub)}
  .dfx-cell.untested{background:transparent;color:var(--df-sub);border:1px dashed var(--df-line)}
  .dfx-cell.blocked,.dfx-cell.skipped{background:var(--df-warn-soft);color:var(--df-warn)}
  .dfx-note{font-size:13px;color:var(--df-sub);border:1px dashed var(--df-line);border-radius:var(--df-r-sm);
    padding:8px 10px;line-height:1.6;background:var(--df-surface)}
  .dfx-kv{display:grid;grid-template-columns:76px minmax(0,1fr);gap:7px 10px;font-size:14px}
  .dfx-kv dt{color:var(--df-sub);font-size:13px} .dfx-kv dd{margin:0;word-break:break-word}
  .dfx-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;
    padding:30px 18px;text-align:center;font-size:13px;color:var(--df-sub)}
  .dfx-path{position:relative;padding-left:16px}
  .dfx-path:before{content:"";position:absolute;left:4px;top:8px;bottom:8px;width:1.5px;background:var(--df-line)}
  .dfx-hop{position:relative;display:flex;gap:9px;align-items:flex-start;padding:7px 0;cursor:pointer}
  .dfx-hop:before{content:"";position:absolute;left:-15px;top:14px;width:9px;height:9px;border-radius:50%;
    background:var(--df-surface);border:2px solid var(--df-ok)}
  .dfx-stage{font-size:12px;font-weight:700;letter-spacing:.03em;padding:1px 6px;border-radius:var(--df-r-xs);
    background:var(--df-surface-2);color:var(--df-sub);flex:none;margin-top:1px}
  .dfx-hop .t{flex:1;min-width:0}
  .dfx-hop .h{font-size:14px;font-weight:560}
  .dfx-hop .s{font-size:13px;color:var(--df-sub);margin-top:1px}
  .dfx-btn{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;font-size:14px;
    border:1px solid var(--df-line);background:var(--df-surface);color:var(--df-ink);border-radius:var(--df-r-sm);cursor:pointer;
    font-weight:500;transition:background .15s,border-color .15s}
  .dfx-btn:hover{background:var(--df-hover)}
  .dfx-btn.primary{background:var(--df-accent);color:var(--df-ink-inv);border-color:var(--df-accent);font-weight:600}
  .dfx-code{font-family:var(--df-mono);font-size:13px;background:var(--df-surface-2);color:var(--df-ink);
    border:1px solid var(--df-line-soft);border-radius:var(--df-r-sm);padding:9px 10px;white-space:pre-wrap;word-break:break-word}

  /* ---------------------------------------------------------------- 作战视图 */
  .df-ops{display:flex;flex-direction:column;gap:14px;min-height:0;flex:none}
  .df-opsbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:32px}
  .df-ops-title{font-size:var(--df-t-page);font-weight:700;letter-spacing:normal}
  .df-ops-meta{font-size:13px;color:var(--df-sub);white-space:nowrap}
  /* 通用弹性占位：放在标题行 / 卡片头 / 页脚里，把后面的操作推到右侧。
     只在 flex 容器内生效，宽度为 0，靠 margin 吃掉剩余空间。 */
  .df-spacer{margin-left:auto}
  .df-ops-blank{display:flex;align-items:center;justify-content:center;min-height:260px}
  /* 概览三块：窄列放「下一步 / 最近作业」，宽列给覆盖矩阵。
     宽窄由主区自己的容器宽度决定（@container），与窗口缩放无关。 */
  .df-ov-cols{display:grid;grid-template-columns:minmax(300px,.82fr) minmax(0,1.55fr);gap:14px;align-items:start;
    grid-template-areas:"next matrix" "log matrix";grid-template-rows:min-content 1fr}
  .df-ov-next{grid-area:next}
  .df-ov-log{grid-area:log}
  .df-ov-mx{grid-area:matrix}
  @container (max-width: 900px){
    .df-ov-cols{grid-template-columns:1fr;grid-template-rows:auto auto auto;
      grid-template-areas:"next" "matrix" "log"}
  }
  .df-tablewrap{max-height:min(64vh,680px);overflow:auto;border-radius:var(--df-r)}
  .df-tablewrap--flat{max-height:240px;border:1px solid var(--df-line-soft)}
  .df-kpis--4{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
  .df-opsbar .df-select{width:auto;min-width:108px;flex:none}
  .df-opsbar .df-search{flex:0 1 260px}
  .df-note{padding:9px 12px;border-radius:var(--df-r-sm);background:var(--df-surface-2);border:1px solid var(--df-line-soft);
    color:var(--df-sub);font-size:13px;line-height:1.6}
  .df-note--warn{background:var(--df-warn-soft);border-color:var(--df-warn);color:var(--df-ink)}
  .df-maint{padding:12px 14px 14px}
  .df-maint .df-ops{gap:12px}
  .df-more{display:flex;justify-content:center;padding:10px 0 4px}
  /* 关于：三行「键—值—标签」，键弱值强，标签靠右收成弱色小字。 */
  .df-about{display:flex;flex-direction:column;gap:2px;margin-bottom:10px}
  .df-about-row{display:flex;align-items:baseline;gap:12px;padding:6px 0;font-size:13px;
    border-bottom:1px solid var(--df-line-soft)}
  .df-about-row:last-child{border-bottom:0}
  .df-about-row>span:first-child{width:56px;flex:none;color:var(--df-sub)}
  .df-about-row b{font-weight:600;color:var(--df-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-about-tag{margin-left:auto;flex:none;font-size:12px;color:var(--df-faint)}

  .df-asset{min-width:0}
  .df-asset-ip{font-family:var(--df-mono);font-size:var(--df-t-body);font-weight:650;letter-spacing:normal;line-height:1.35}
  /* 资产名下那行域名是列表里最常看的东西之一，不能是注释级别的字号。 */
  .df-asset-name{font-size:13.5px;color:var(--df-sub);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-portlist{display:flex;gap:4px;flex-wrap:wrap}
  .df-port{font-family:var(--df-mono);font-size:var(--df-t-meta);font-weight:600;line-height:1.7;padding:0 6px;border-radius:var(--df-r-xs);
    background:var(--df-surface-2);color:var(--df-sub);white-space:nowrap}
  .df-port--more{background:transparent;color:var(--df-sub);border:1px dashed var(--df-line)}

  .df-sev{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 9px 0 8px;border-radius:999px;
    font-size:12.5px;font-weight:700;letter-spacing:.02em;line-height:1;white-space:nowrap;
    background:var(--df-sev-low-bg);color:var(--df-sev-low-fg)}
  .df-sev i{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none;opacity:.9}
  /* 严重/高 = 实心，中/低 = 淡底：扫一眼先看到该先修的。 */
  .df-sev--critical{background:var(--df-sev-critical-bg);color:var(--df-sev-critical-fg)}
  .df-sev--high{background:var(--df-sev-high-bg);color:var(--df-sev-high-fg)}
  .df-sev--medium{background:var(--df-sev-medium-bg);color:var(--df-sev-medium-fg)}
  .df-sev--low{background:var(--df-sev-low-bg);color:var(--df-sev-low-fg)}
  .df-sev--info{background:var(--df-sev-low-bg);color:var(--df-sev-low-fg)}
  .df-vuln-t{font-weight:560;min-width:0}
  .df-vuln-t small{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1;
    font-weight:400;color:var(--df-sub);font-size:12px;margin-top:1px;
    overflow:hidden;word-break:break-word}

  /* ---------------------------------------------------------------- 漏洞：严重度筛选 + 成果列表 */
  .df-sevbar{display:grid;grid-template-columns:repeat(auto-fit,minmax(116px,1fr));gap:10px}
  /* 上下文页：上次实际组装的段大小条 */
  .df-ctx-bars{display:flex;flex-direction:column;gap:7px;padding:2px 0}
  .df-ctx-bar{display:grid;grid-template-columns:232px 1fr 76px;gap:9px;align-items:center;font-size:12.5px}
  .df-ctx-bar-name{color:var(--df-sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--df-mono)}
  .df-ctx-bar-tag{display:inline-block;font-style:normal;font-family:var(--df-font);font-size:10.5px;font-weight:600;
    line-height:16px;padding:0 5px;border-radius:4px;margin-right:6px;background:var(--df-surface-2);color:var(--df-sub)}
  .df-ctx-bar-tag.is-system{background:var(--df-info-soft);color:var(--df-info)}
  .df-ctx-bar-tag.is-workspace{background:var(--df-ok-soft);color:var(--df-ok)}
  .df-ctx-bar-tag.is-sub{background:var(--df-warn-soft);color:var(--df-warn)}
  .df-ctx-bar-track{height:6px;border-radius:3px;background:var(--df-surface-2);overflow:hidden}
  .df-ctx-bar-track i{display:block;height:100%;background:var(--df-info);border-radius:3px}
  .df-ctx-bar.is-forge .df-ctx-bar-track i{background:var(--df-warn)}
  .df-ctx-bar-num{text-align:right;color:var(--df-faint);font-variant-numeric:tabular-nums}
  /* 提示词生效链路：左侧编号、中间是什么、右侧何时生效；当前页整行加底色。 */
  .df-layers{border:1px solid var(--df-line-soft);border-radius:var(--df-r-lg);background:var(--df-surface);overflow:hidden}
  .df-layers-hd{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 16px;
    border-bottom:1px solid var(--df-line-soft)}
  .df-layers-hd b{font-size:var(--df-t-card);font-weight:650}
  .df-layers-note{font-size:12.5px;color:var(--df-sub);min-width:0}
  .df-layers-body{display:flex;flex-direction:column}
  .df-layer{display:grid;grid-template-columns:30px minmax(0,1fr) 132px;gap:12px;align-items:center;
    padding:12px 16px;position:relative;border-bottom:1px solid var(--df-line-soft)}
  .df-layer:last-child{border-bottom:0}
  .df-layer.is-link{cursor:pointer}
  .df-layer.is-link:hover{background:var(--df-hover)}
  .df-layer.is-focus{background:linear-gradient(90deg,var(--df-accent-soft),transparent 62%)}
  .df-layer.is-focus::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--df-accent)}
  .df-layer-no{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;
    font-family:var(--df-mono);font-size:11px;font-weight:700;color:var(--df-sub);background:var(--df-surface-2)}
  .df-layer.is-focus .df-layer-no{background:var(--df-accent);color:var(--df-ink-inv)}
  .df-layer-main{min-width:0}
  .df-layer-hd{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:0}
  .df-layer-hd b{font-size:var(--df-t-row);font-weight:650}
  .df-layer-role{font-family:var(--df-mono);font-size:11px;color:var(--df-sub);background:var(--df-surface-2);
    border-radius:5px;padding:1px 6px;white-space:nowrap}
  .df-layer-scope{font-size:12px;color:var(--df-faint);white-space:nowrap}
  .df-layer-here{font-size:11px;font-weight:650;color:var(--df-accent);background:var(--df-accent-soft);
    border-radius:999px;padding:1px 7px}
  .df-layer-purpose{font-size:12.5px;color:var(--df-sub);margin-top:3px;line-height:1.45}
  .df-layer-items{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}
  .df-layer-item{display:inline-flex;align-items:center;gap:5px;height:21px;padding:0 8px;border-radius:6px;
    background:var(--df-surface-2);font-size:11.5px;color:var(--df-sub);white-space:nowrap}
  .df-layer-item i{width:5px;height:5px;border-radius:50%;background:var(--df-accent);flex:none}
  .df-layer-item.is-edit{background:var(--df-accent-soft);color:var(--df-ink);font-weight:550}
  .df-layer-side{display:flex;flex-direction:column;align-items:flex-end;gap:5px;justify-self:end}
  .df-layer-when{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;color:var(--df-sub);white-space:nowrap}
  .df-layer-go{font-size:11.5px;color:var(--df-accent);white-space:nowrap}
  .df-layers-ft{padding:9px 16px;border-top:1px solid var(--df-line-soft);font-size:11.5px;
    color:var(--df-faint);line-height:1.5}
  .df-layers--compact .df-layers-hd{padding:10px 14px}
  .df-layers--compact .df-layer{grid-template-columns:26px minmax(0,1fr) auto;padding:9px 14px}
  .df-layers--compact .df-layer-no{width:22px;height:22px;font-size:10.5px}
  .df-layers--compact .df-layers-ft{padding:7px 14px}
  /* 工作区指令：按 用户级 → 共享级 → 项目根 → 当前目录 分组，每组一个编号头。 */
  .df-tierlist{display:flex;flex-direction:column;gap:10px;margin-top:8px}
  .df-tiergroup{border:1px solid var(--df-line-soft);border-radius:var(--df-r);overflow:hidden;background:var(--df-surface)}
  .df-tierhd{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--df-surface-2);min-width:0}
  .df-tierno{font-family:var(--df-mono);font-size:10px;font-weight:700;color:var(--df-sub);
    min-width:26px;height:20px;padding:0 5px;border-radius:999px;background:var(--df-surface);display:grid;place-items:center;flex:none}
  .df-tiert{font-size:12.5px;font-weight:650;color:var(--df-ink);white-space:nowrap}
  .df-tierw{font-size:12px;color:var(--df-sub);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-tiern{margin-left:auto;font-size:11.5px;color:var(--df-faint);white-space:nowrap}
  .df-vlist--flat{margin:0}
  @container (max-width:560px){
    .df-layer{grid-template-columns:26px minmax(0,1fr);row-gap:6px}
    .df-layer-side{grid-column:2;flex-direction:row;align-items:center;justify-content:flex-start}
  }
  .df-sevbtn{display:flex;flex-direction:column;align-items:flex-start;gap:3px;padding:12px 14px;min-width:0;position:relative;
    border:1.5px solid transparent;border-radius:var(--df-r-lg);background:var(--df-surface);
    box-shadow:var(--df-shadow-1);cursor:pointer;text-align:left;font:inherit;color:inherit;
    transition:background .15s,border-color .15s,transform .1s}
  .df-sevbtn:hover{transform:translateY(-1px)}
  .df-sevbtn:active{transform:none}
  .df-sevbtn .df-sb-l{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;
    color:var(--df-sub);white-space:nowrap}
  .df-sevbtn .df-sb-l i{width:8px;height:8px;border-radius:50%;background:var(--df-faint);flex:none}
  .df-sevbtn .df-sb-v{font-size:var(--df-t-num);font-weight:700;letter-spacing:-.03em;line-height:1.1;
    font-variant-numeric:tabular-nums;color:var(--df-ink)}
  .df-sevbtn.on{border-color:var(--df-accent);background:var(--df-accent-soft)}
  .df-sevbtn .df-sb-on{position:absolute;top:10px;right:11px;width:18px;height:18px;border-radius:50%;
    background:var(--df-accent);color:var(--df-ink-inv);font-size:12px;font-weight:700;line-height:1;
    display:flex;align-items:center;justify-content:center}
  .df-sevbtn--all i{background:var(--df-info-solid)}
  .df-sevbtn--critical i{background:var(--df-err-solid)}
  .df-sevbtn--high i{background:var(--df-warn-solid)}
  .df-sevbtn--medium i{background:#e6a400}
  .df-sevbtn--low i{background:var(--df-faint)}
  .df-sevbtn--critical .df-sb-v{color:var(--df-err)}
  .df-sevbtn--high .df-sb-v{color:var(--df-warn)}

  .df-vlist{display:flex;flex-direction:column;margin:-10px -8px}
  .df-vrow{display:flex;align-items:stretch;gap:12px;width:100%;padding:13px 16px 13px 14px;
    border:0;border-bottom:1px solid var(--df-line-soft);background:transparent;text-align:left;
    cursor:pointer;font:inherit;color:inherit;transition:background .12s}
  .df-vrow:last-child{border-bottom:0}
  .df-vrow:hover{background:var(--df-hover)}
  .df-vrow:active{background:var(--df-hover-2)}
  .df-vrow:focus-visible{outline:2px solid var(--df-accent);outline-offset:-2px}
  .df-vrow-rail{width:3px;border-radius:999px;flex:none;background:var(--df-faint);align-self:stretch}
  .df-vrow--critical .df-vrow-rail{background:var(--df-err-solid)}
  .df-vrow--high .df-vrow-rail{background:var(--df-warn-solid)}
  .df-vrow--medium .df-vrow-rail{background:#e6a400}
  .df-vrow--low .df-vrow-rail,.df-vrow--info .df-vrow-rail{background:var(--df-line)}
  .df-vrow-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px;justify-content:center}
  .df-vrow-hd{display:flex;align-items:center;gap:8px;min-width:0}
  .df-vrow-t{font-size:14.5px;font-weight:600;line-height:1.35;min-width:0;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-vrow-m{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:var(--df-t-meta);color:var(--df-sub);min-width:0}
  /* 靶标 IP 是这一行最需要被扫到的标识：和正文同级，不再单独缩到 13.5。 */
  .df-vrow-m .df-vrow-ip{font-family:var(--df-mono);font-size:var(--df-t-meta);font-weight:600;letter-spacing:normal}
  /* 目标 URL 可以很长：单行省略，绝不让它把行撑出卡片。 */
  .df-vrow-m .df-vrow-url{flex:0 1 auto;min-width:0;max-width:52ch;overflow:hidden;
    text-overflow:ellipsis;white-space:nowrap}
  .df-vrow-sep{color:var(--df-faint)}
  .df-vrow-right{display:flex;align-items:center;gap:10px;flex:none;padding-left:4px}
  .df-vrow-ago{font-size:var(--df-t-meta);color:var(--df-faint);white-space:nowrap}
  .df-vrow-go{color:var(--df-faint);font-size:18px;font-weight:600;line-height:1}
  .df-vrow:hover .df-vrow-go{color:var(--df-accent)}

  .df-next-ico{width:22px;height:22px;border-radius:var(--df-r-xs);display:flex;align-items:center;justify-content:center;
    background:var(--df-surface-2);color:var(--df-sub);flex:none}

  .df-seq{font-family:var(--df-mono);font-size:12px;font-weight:650;line-height:1;color:var(--df-sub);background:var(--df-surface-2);
    border:1px solid var(--df-line-soft);border-radius:var(--df-r-xs);padding:3px 5px;flex:none}
  .df-chain-tool{font-family:var(--df-mono);font-size:12px;color:var(--df-sub);max-width:46%;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-tl--pad{padding:10px 12px 10px 24px}
  .df-tl--pad .df-tl-item{padding:8px 0 10px}
  .df-tl-r{font-size:13px;color:var(--df-sub);margin-top:2px;line-height:1.55;
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .df-tl--pad .df-tl-d{display:flex;align-items:center;gap:8px;margin-top:2px}
  .df-act-ico{width:20px;height:20px;border-radius:var(--df-r-xs);display:inline-flex;align-items:center;justify-content:center;
    background:var(--df-surface-2);color:var(--df-sub);flex:none}

  .df-detail{display:flex;flex-direction:column;gap:14px;padding:4px 2px 10px}
  /* 补丁详情：状态卡 + 分段卡片。状态先解释清楚“为什么现在是这样、下一步做什么”。 */
  .df-patch-status{display:flex;align-items:flex-start;gap:11px;padding:12px 13px;
    border:1px solid var(--df-line);border-radius:11px;background:var(--df-surface-2)}
  .df-patch-status-ico{flex:none;width:30px;height:30px;border-radius:9px;display:flex;
    align-items:center;justify-content:center;background:var(--df-fill);color:var(--df-sub)}
  .df-patch-status-main{min-width:0;display:flex;flex-direction:column;gap:4px}
  .df-patch-status-badge{align-self:flex-start;display:inline-flex;align-items:center;gap:5px;
    height:24px;padding:0 9px;border-radius:7px;font-size:11.5px;font-weight:700;
    letter-spacing:.02em;white-space:nowrap;
    background:var(--df-surface);color:var(--df-ink);border:1px solid var(--df-line-strong)}
  .df-patch-status-badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
  .df-patch-status-main b{font-size:13px;font-weight:620;color:var(--df-ink);line-height:1.45}
  .df-patch-status-next{font-size:12px;color:var(--df-sub);line-height:1.55}
  .df-patch-status--ok{border-color:color-mix(in srgb,var(--df-ok-solid) 34%,var(--df-line));
    background:color-mix(in srgb,var(--df-ok-solid) 8%,var(--df-surface))}
  .df-patch-status--ok .df-patch-status-ico{background:var(--df-ok-soft);color:var(--df-ok)}
  .df-patch-status--ok .df-patch-status-badge{background:var(--df-ok-soft);color:var(--df-ok);
    border-color:color-mix(in srgb,var(--df-ok) 40%,var(--df-line))}
  .df-patch-status--warn{border-color:color-mix(in srgb,var(--df-warn-solid) 38%,var(--df-line));
    background:color-mix(in srgb,var(--df-warn-solid) 9%,var(--df-surface))}
  .df-patch-status--warn .df-patch-status-ico{background:var(--df-warn-soft);color:var(--df-warn)}
  .df-patch-status--warn .df-patch-status-badge{background:var(--df-warn-soft);color:var(--df-warn);
    border-color:color-mix(in srgb,var(--df-warn) 40%,var(--df-line))}
  .df-patch-status--err{border-color:color-mix(in srgb,var(--df-err-solid) 38%,var(--df-line));
    background:color-mix(in srgb,var(--df-err-solid) 8%,var(--df-surface))}
  .df-patch-status--err .df-patch-status-ico{background:var(--df-err-soft);color:var(--df-err)}
  .df-patch-status--err .df-patch-status-badge{background:var(--df-err-soft);color:var(--df-err);
    border-color:color-mix(in srgb,var(--df-err) 40%,var(--df-line))}
  .df-patch-status--info{border-color:color-mix(in srgb,var(--df-info-solid) 34%,var(--df-line));
    background:color-mix(in srgb,var(--df-info-solid) 8%,var(--df-surface))}
  .df-patch-status--info .df-patch-status-ico{background:var(--df-info-soft);color:var(--df-info)}
  .df-patch-status--info .df-patch-status-badge{background:var(--df-info-soft);color:var(--df-info);
    border-color:color-mix(in srgb,var(--df-info) 40%,var(--df-line))}
  /* 作用 / 开启后 / 关闭后：一段一张淡卡，和上方状态卡拉开层次。 */
  .df-patch-sec{padding:10px 12px;border:1px solid var(--df-line-soft);border-radius:10px;
    background:var(--df-surface)}
  .df-patch-sec .df-detail-hd{margin-bottom:4px}
  .df-patch-sec .df-detail-p{color:var(--df-ink);opacity:.9}
  .df-patch-sec.is-on{border-left:3px solid var(--df-ok-solid);padding-left:10px}
  .df-patch-sec.is-off{border-left:3px solid var(--df-line-strong);padding-left:10px}
  .df-detail-sec>h4{font-size:var(--df-t-micro);font-weight:650;color:var(--df-sub);letter-spacing:.04em;
    margin:0 0 6px}
  .df-detail-hd{display:flex;align-items:center;gap:8px;margin-bottom:6px}
  .df-detail-hd>h4{margin:0}
  .df-detail-hd .df-copy{margin-left:auto}
  .df-chips{display:flex;flex-wrap:wrap;gap:4px}
  .df-evi{font-family:var(--df-mono);font-size:var(--df-t-meta);line-height:1.6;white-space:pre-wrap;word-break:break-word;
    background:var(--df-surface-2);border:1px solid var(--df-line-soft);border-radius:var(--df-r-sm);
    padding:9px 10px;max-height:200px;overflow:auto;margin:0}
  .df-evi-card{border:1px solid var(--df-line-soft);border-radius:var(--df-r);padding:8px;margin-bottom:8px;
    display:flex;flex-direction:column;gap:6px;background:var(--df-surface)}
  .df-evi-hd{display:flex;align-items:center;gap:8px;font-family:var(--df-mono);font-size:var(--df-t-meta);color:var(--df-sub)}
  .df-evi-hd b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-evi-hd span{margin-left:auto;color:var(--df-sub);flex:none}
  /* 复现报文：抬头（方法/路径/状态）+ Request / Response 两栏，像 Burp Repeater。 */
  .df-pkt-list{display:flex;flex-direction:column;gap:8px}
  .df-pkt{border:1px solid var(--df-line-soft);border-radius:var(--df-r);overflow:hidden;background:var(--df-surface)}
  .df-pkt-hd{display:flex;align-items:center;gap:7px;min-width:0;padding:5px 9px;
    background:var(--df-surface-2);border-bottom:1px solid var(--df-line-soft);
    font-family:var(--df-mono);font-size:var(--df-t-meta)}
  .df-pkt-i{flex:none;color:var(--df-faint)}
  .df-pkt-m{flex:none;font-weight:700;color:var(--df-ink);letter-spacing:.02em}
  .df-pkt-u{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--df-sub)}
  .df-pkt-st{flex:none;padding:0 7px;border-radius:999px;font-size:var(--df-t-micro);font-weight:600;line-height:1.75}
  .df-pkt-st--ok{background:var(--df-ok-soft);color:var(--df-ok)}
  .df-pkt-st--info{background:var(--df-info-soft);color:var(--df-info)}
  .df-pkt-st--warn{background:var(--df-warn-soft);color:var(--df-warn)}
  .df-pkt-st--err{background:var(--df-err-soft);color:var(--df-err)}
  .df-pkt-st--line{background:var(--df-fill);color:var(--df-sub)}
  .df-pkt-tag{flex:none;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    color:var(--df-faint);font-size:var(--df-t-micro)}
  .df-pkt-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);
    gap:1px;background:var(--df-line-soft)}
  .df-pkt-grid--one{grid-template-columns:minmax(0,1fr)}
  @media (max-width: 760px){.df-pkt-grid{grid-template-columns:minmax(0,1fr)}}
  .df-pkt-col{min-width:0;background:var(--df-surface)}
  .df-pkt-cap{padding:3px 9px;border-bottom:1px dashed var(--df-line-soft);
    font-family:var(--df-mono);font-size:var(--df-t-micro);letter-spacing:.06em;
    color:var(--df-faint);text-transform:uppercase}
  .df-pkt-raw{margin:0;padding:8px 10px;max-height:300px;overflow:auto;
    font-family:var(--df-mono);font-size:var(--df-t-meta);line-height:1.6;
    white-space:pre;tab-size:2}
  .df-htp-start{color:var(--df-accent);font-weight:600}
  .df-htp-status{color:var(--df-ok);font-weight:600}
  .df-htp-head{color:var(--df-sub)}
  .df-evi-raw{margin-top:2px}
  .df-evi-raw>summary{cursor:pointer;color:var(--df-faint);font-size:var(--df-t-micro);
    padding:2px 0;user-select:none}
  .df-evi-raw>summary:hover{color:var(--df-sub)}
  .df-evi-raw .df-evi{margin-top:6px;max-height:240px}

  /* ---------------------------------------------------------------- 评分 / 报告 */
  .df-sgroup+.df-sgroup{border-top:1px solid var(--df-line-soft)}
  /* 交付清单：危害徽标 + 标题同行，标题单行截断，表格不会因长标题把列撑开。
     注意类名前缀用 df-dvc：.df-del-cell 已经被「删除靶标」的统计格占用了。 */
  .df-dvc{display:flex;align-items:center;gap:8px;min-width:0}
  .df-dvc-t{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-sgroup-hd{display:flex;align-items:baseline;gap:8px;padding:8px 10px 6px;background:var(--df-surface-2)}
  .df-sgroup-hd b{font-size:13px;font-weight:650}
  .df-sgroup-hd .df-sub{font-size:12px;color:var(--df-sub);margin-left:auto;font-variant-numeric:tabular-nums}
  .df-sgroup .df-tablewrap{max-height:none}
  .df-score-name{min-width:0}
  .df-score-name b{display:block;font-weight:600;font-size:var(--df-t-row);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-score-name small{display:block;font-family:var(--df-mono);font-size:var(--df-t-micro);color:var(--df-sub);margin-top:1px;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-score-num{font-variant-numeric:tabular-nums;font-weight:600}
  .df-score-num small{font-weight:400;color:var(--df-sub);font-size:var(--df-t-micro);margin-left:2px}
  .df-hits{display:flex;flex-direction:column;gap:8px}
  .df-hit{border:1px solid var(--df-line-soft);border-radius:var(--df-r-sm);padding:8px 10px;background:var(--df-surface)}
  .df-hit-hd{display:flex;align-items:center;gap:8px;font-size:13px;min-width:0}
  .df-hit-hd>.df-mono{font-size:var(--df-t-meta);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
  .df-hit-pts{font-weight:650;font-variant-numeric:tabular-nums;flex:none}
  .df-hit-d{font-size:var(--df-t-meta);color:var(--df-sub);margin:2px 0 5px}
  .df-hit .df-evi{max-height:120px;margin-top:5px}
  .df-hit .df-note{margin:4px 0 2px}
  .df-report-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 14px;border-bottom:1px solid var(--df-line-soft)}
  /* 生成前检查：报告是显式动作，所以把「会包含什么、不包含什么、代价是什么」先摆清楚，
     再给一个主按钮。清单不写成纯文字，是因为这里要让人一眼决定「现在生成还是先去补料」。 */
  .df-gen{padding:14px 16px 16px;display:flex;flex-direction:column;gap:14px}
  /* 单列四条：标签定宽、说明跟在后面。两列会把「包含」那条挤成折行，反而不像清单。 */
  .df-gen-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:9px}
  .df-gen-list li{display:flex;gap:12px;align-items:baseline;font-size:var(--df-t-body);line-height:1.6}
  .df-gen-list li b{flex:none;min-width:3.2em;font-size:var(--df-t-meta);font-weight:600;color:var(--df-faint);
    text-align:left}
  .df-gen-list li span{color:var(--df-sub);min-width:0}
  .df-gen-act{display:flex;align-items:center;gap:12px;flex-wrap:wrap;
    padding-top:14px;border-top:1px solid var(--df-line-soft)}
  /* 按钮旁边的说明不要那块灰底：它是提示语，不是一个信息块。 */
  .df-gen-act .df-note{padding:0;margin:0;flex:1 1 220px;background:none;border:0;font-size:var(--df-t-body)}

  .df-report-meta{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:8px 14px 0;font-size:var(--df-t-meta);color:var(--df-sub)}
  .df-report-bd{max-height:min(62vh,680px);overflow:auto;padding:6px 14px 18px}
  .df-md{max-width:1000px;font-size:var(--df-t-body);line-height:1.72;color:var(--df-ink)}
  .df-md h1{font-size:19px;font-weight:680;letter-spacing:-.01em;margin:4px 0 10px;line-height:1.35}
  .df-md h2{font-size:16px;font-weight:660;margin:18px 0 8px;padding-bottom:5px;border-bottom:1px solid var(--df-line-soft)}
  .df-md h3{font-size:14px;font-weight:650;margin:13px 0 5px}
  .df-md h4{font-size:13px;font-weight:650;margin:10px 0 4px;color:var(--df-sub)}
  .df-md p{margin:0 0 8px}
  .df-md ul,.df-md ol{margin:0 0 9px;padding-left:19px}
  .df-md li{margin:1px 0}
  .df-md b{font-weight:650}
  .df-md em{font-style:normal;color:var(--df-sub)}
  .df-md code{font-family:var(--df-mono);font-size:12px;background:var(--df-surface-2);color:var(--df-ink);
    border:1px solid var(--df-line-soft);border-radius:var(--df-r-xs);padding:0 4px;word-break:break-word}
  .df-md-code{margin:0 0 10px;padding:9px 11px;background:var(--df-surface-2);border:1px solid var(--df-line-soft);
    border-radius:var(--df-r-sm);overflow:auto;max-height:320px}
  .df-md-code code{background:none;border:0;padding:0;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
  .df-md blockquote{margin:6px 0 11px;padding:6px 10px;border-left:2px solid var(--df-line);
    background:var(--df-surface-2);border-radius:0 var(--df-r-sm) var(--df-r-sm) 0;color:var(--df-sub);font-size:13px}
  .df-md-tblwrap{overflow:auto;margin:0 0 11px;border:1px solid var(--df-line-soft);border-radius:var(--df-r-sm)}
  .df-md-tbl{border-collapse:collapse;width:100%;font-size:var(--df-t-meta)}
  .df-md-tbl th{text-align:left;font-weight:650;background:var(--df-surface-2);color:var(--df-ink);white-space:nowrap}
  .df-md-tbl th,.df-md-tbl td{padding:5px 8px;border-bottom:1px solid var(--df-line-soft);vertical-align:top}
  .df-md-tbl tr:last-child td{border-bottom:0}
  .df-md hr{border:0;border-top:1px solid var(--df-line-soft);margin:14px 0}
  .df-md-fig{margin:0 0 10px;padding:8px 10px;border:1px dashed var(--df-line);border-radius:var(--df-r-sm);
    background:var(--df-surface-2);display:flex;flex-direction:column;gap:2px}
  .df-md-fig figcaption{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--df-sub);min-width:0}
  .df-md-fig figcaption b{color:var(--df-ink);font-weight:600;flex:none}
  .df-md-fig figcaption code{margin-left:auto;max-width:56%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

  /* ---------------------------------------------------------------- 证据截图 */
  .df-shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px}
  .df-shot{position:relative;min-width:0}
  .df-shot-b{display:block;width:100%;aspect-ratio:16/10;padding:0;border:1px solid var(--df-line-soft);
    border-radius:var(--df-r-sm);overflow:hidden;background:var(--df-surface-2);cursor:zoom-in;position:relative}
  .df-shot-b:hover{border-color:var(--df-line)}
  .df-shot-b img{width:100%;height:100%;object-fit:cover;display:block}
  .df-shot-ph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--df-sub);font-size:var(--df-t-micro)}
  .df-shot-cap{margin-top:3px;font-size:var(--df-t-micro);line-height:1.4;color:var(--df-sub);
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-shot-del{position:absolute;top:3px;right:3px;width:20px;height:20px;padding:0;border:0;border-radius:var(--df-r-xs);
    display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);color:#fff;
    cursor:pointer;opacity:0;transition:opacity .12s}
  .df-shot:hover .df-shot-del,.df-shot-del.is-on{opacity:1}
  .df-shot-del.is-on{background:var(--df-err);color:var(--df-ink-inv)}
  .df-shot-full{margin-top:8px;border:1px solid var(--df-line-soft);border-radius:var(--df-r);overflow:hidden;
    background:var(--df-surface-2);max-height:min(46vh,460px);overflow:auto}
  .df-shot-full img{display:block;width:100%;height:auto}
  .df-shot-lightbox{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;
    padding:24px;background:rgba(8,10,14,.78);backdrop-filter:blur(2px);cursor:zoom-out}
  .df-shot-lightbox-body{position:relative;max-width:94vw;max-height:92vh;display:flex;flex-direction:column;
    gap:8px;padding:10px;border:1px solid var(--df-line);border-radius:var(--df-r);background:var(--df-surface);
    box-shadow:var(--df-shadow-2);cursor:default;overflow:auto}
  .df-shot-lightbox-body img{display:block;max-width:min(92vw,1800px);max-height:82vh;width:auto;height:auto;object-fit:contain;
    border-radius:var(--df-r-xs);background:var(--df-surface-2)}
  .df-shot-lightbox-cap{font-size:var(--df-t-micro);color:var(--df-sub);line-height:1.45;max-width:min(92vw,1800px);
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-shot-lightbox-x{position:absolute;top:14px;right:16px;width:30px;height:30px;border:1px solid rgba(255,255,255,.28);
    border-radius:50%;background:rgba(0,0,0,.55);color:#fff;font-size:20px;line-height:1;cursor:pointer;
    display:flex;align-items:center;justify-content:center}
  .df-shot-lightbox-x:hover{background:rgba(0,0,0,.78)}
  .df-shotbar{display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap}
  .df-upload{position:relative;overflow:hidden}
  .df-upload input{position:absolute;inset:0;opacity:0;cursor:pointer;font-size:0}

  /* ---------------------------------------------------------------- 资源 / 配置 */
  .df-opsbar--pad{padding:10px 12px 8px}
  .df-detail-p{font-size:var(--df-t-body);line-height:1.7;color:var(--df-sub);white-space:pre-wrap;word-break:break-word}
  .df-formgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:2px 14px 14px}
  .df-formsec{grid-column:1 / -1;display:flex;align-items:baseline;gap:10px;padding:10px 0 2px;border-top:1px solid var(--df-line-soft);margin-top:2px}
  .df-formsec:first-child{border-top:0;padding-top:0}
  .df-formsec h4{margin:0;font-size:13px;font-weight:600;color:var(--df-ink)}
  .df-formsec span{font-size:12px;color:var(--df-faint)}
  .df-formgrid .df-field--wide{grid-column:1 / -1}
  .dfx-dock[data-narrow="1"] .df-formgrid{grid-template-columns:1fr}
  .df-formfoot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;
    padding:9px 14px;border-top:1px solid var(--df-line-soft);background:var(--df-surface-2);
    border-radius:0 0 var(--df-r) var(--df-r)}
  .df-area--code{font-family:var(--df-mono);font-size:13px;line-height:1.65;min-height:260px}
  .df-kpi .df-kpi-v{word-break:break-word}

  /* ---------------------------------------------------------------- 门禁 / 授权 / 回退 */
  .df-crash{position:fixed;inset:0;z-index:2147483002;display:flex;align-items:center;justify-content:center;
    padding:24px;pointer-events:auto;background:var(--df-mask)}
  .df-crash-card{width:min(520px,100%);background:var(--df-surface);color:var(--df-ink);
    border:1px solid var(--df-line);border-radius:var(--df-r-lg);box-shadow:var(--df-shadow-2);padding:16px 18px 14px;
    display:flex;flex-direction:column;gap:10px}
  .df-crash-hd{display:flex;align-items:center;gap:9px;font-size:15px}
  .df-crash-hd .df-crash-mark{width:28px;height:28px;border-radius:var(--df-r-sm);display:flex;align-items:center;justify-content:center;
    background:var(--df-err-soft);color:var(--df-err);flex:none}
  .df-crash-card p{margin:0;font-size:13px;color:var(--df-sub);line-height:1.6}
  .df-crash-msg{margin:0;max-height:180px;overflow:auto;font-family:var(--df-mono);font-size:12px;line-height:1.55;color:var(--df-sub);
    background:var(--df-surface-2);border:1px solid var(--df-line-soft);border-radius:var(--df-r-sm);padding:8px 10px;
    white-space:pre-wrap;word-break:break-word}
  .df-crash-ft{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  /* 视图级兜底：留在主区里，导航和面板都还能用。 */
  .df-crash--inline{position:static;z-index:auto;padding:0;background:transparent;
    display:block;overflow:auto}
  .df-crash--inline .df-crash-card{margin:8px auto;max-width:560px}
  .df-mask{position:fixed;inset:0;z-index:2147483002;display:flex;align-items:center;justify-content:center;
    padding:24px;background:var(--df-mask);pointer-events:auto;animation:dfFade .16s ease-out}
  @keyframes dfFade{from{opacity:0}to{opacity:1}}
  .df-modal{width:min(560px,100%);max-height:min(88vh,780px);display:flex;flex-direction:column;
    background:var(--df-surface);border:1px solid var(--df-line);border-radius:var(--df-r-lg);
    box-shadow:var(--df-shadow-2);overflow:hidden}
  .df-modal--wide{width:min(660px,100%)}
  .df-modal-hd{display:flex;align-items:flex-start;gap:11px;padding:16px 18px 13px;
    border-bottom:1px solid var(--df-line-soft);background:var(--df-surface)}
  .df-modal-hd .df-mark{width:30px;height:30px;border-radius:var(--df-r-sm);flex:none;display:flex;align-items:center;
    justify-content:center;background:var(--df-accent);color:var(--df-ink-inv)}
  .df-modal-hd .df-mark.is-warn{background:var(--df-warn);color:var(--df-ink-inv)}
  .df-modal-hd .df-mh-t{flex:1;min-width:0}
  .df-modal-hd h2{margin:0;font-size:17px;font-weight:680;letter-spacing:.1px;line-height:1.35}
  .df-modal-hd p{margin:2px 0 0;font-size:13px;color:var(--df-sub);line-height:1.5}
  .df-modal-bd{flex:1;min-height:0;overflow:auto;padding:14px 18px 4px;display:flex;flex-direction:column;
    gap:10px;font-size:14px;line-height:1.72;color:var(--df-sub)}
  .df-modal-bd p{margin:0}
  .df-modal-bd h3{margin:4px 0 0;font-size:14px;font-weight:660;color:var(--df-ink)}
  .df-warnbox{padding:9px 12px;border-radius:var(--df-r-sm);background:var(--df-warn-soft);
    border:1px solid color-mix(in srgb,var(--df-warn) 28%,transparent);color:var(--df-ink);
    font-size:13px;line-height:1.65}
  .df-legal{max-height:236px;overflow:auto;padding:11px 13px;border:1px solid var(--df-line-soft);
    border-radius:var(--df-r);background:var(--df-surface-2);font-size:13px;line-height:1.72;color:var(--df-sub)}
  .df-legal p{margin:0 0 7px}
  .df-legal h3{margin:10px 0 5px;font-size:14px;font-weight:660;color:var(--df-ink)}
  .df-legal p:first-child{margin-top:0}
  .df-check{display:flex;align-items:flex-start;gap:8px;padding:7px 9px;border-radius:var(--df-r-sm);
    border:1px solid var(--df-line-soft);background:var(--df-surface-2);font-size:13px;line-height:1.55;
    color:var(--df-sub);cursor:pointer;transition:background .14s,border-color .14s}
  .df-check:hover{background:var(--df-hover)}
  .df-check.is-on{border-color:color-mix(in srgb,var(--df-accent) 40%,transparent);
    background:var(--df-accent-soft);color:var(--df-ink)}
  .df-check.is-locked{opacity:.55;cursor:default}
  .df-check input{margin:2px 0 0;accent-color:var(--df-accent);flex:none}
  .df-check span{flex:1;min-width:0}
  /* VPS 登录方式二选一：整块可点，选中描边，不做成裸 radio。 */
  .df-vps-opt{display:flex;align-items:flex-start;gap:10px;padding:12px;border:1px solid var(--df-line-soft);
    border-radius:var(--df-r);background:var(--df-surface-2);cursor:pointer;transition:border-color .14s,background .14s}
  .df-vps-opt+.df-vps-opt{margin-top:8px}
  .df-vps-opt:hover{border-color:color-mix(in srgb,var(--df-accent) 30%,var(--df-line-soft))}
  .df-vps-opt.on{border-color:color-mix(in srgb,var(--df-accent) 55%,transparent);background:var(--df-accent-soft)}
  .df-vps-opt.is-off{opacity:.55;cursor:default}
  .df-vps-opt.is-off:hover{border-color:var(--df-line-soft)}
  .df-vps-opt input{margin:3px 0 0;accent-color:var(--df-accent);flex:none}
  .df-vps-opt b{display:block;font-size:14px;font-weight:600;color:var(--df-ink);margin-bottom:3px}
  .df-vps-opt p{margin:0;font-size:13px;line-height:1.65;color:var(--df-sub)}
  .df-vps-sub{margin-top:10px;padding-top:10px;border-top:1px solid var(--df-line-soft)}
  .df-vps-native{display:flex;align-items:center;gap:12px;margin-top:10px;padding-top:10px;border-top:1px solid var(--df-line-soft)}
  .df-vps-native .df-check{flex:none}
  .df-vps-native .df-hint{flex:1;min-width:0}
  /* 外部接入：一行一个服务，状态和操作固定位置。 */
  .df-svc-list{display:flex;flex-direction:column;margin:-2px 0}
  .df-svc{display:grid;grid-template-columns:26px minmax(0,1fr) auto;gap:12px;align-items:center;
    padding:14px 2px;border-top:1px solid var(--df-line-soft)}
  .df-svc:first-child{border-top:0;padding-top:4px}
  .df-svc:last-child{padding-bottom:4px}
  .df-svc-ico{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;
    border-radius:8px;background:var(--df-surface-2);color:var(--df-sub)}
  .df-svc-title{display:flex;align-items:center;gap:8px;min-width:0}
  .df-svc-title b{font-size:14px;font-weight:600;color:var(--df-ink)}
  .df-svc-desc{font-size:13px;color:var(--df-sub);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .df-svc-actions{display:flex;align-items:center;gap:6px;flex:none}
  .df-svc-extra{grid-column:2/-1;margin-top:8px}
  .dfx-dock[data-narrow="1"] .df-svc{grid-template-columns:26px minmax(0,1fr)}
  .dfx-dock[data-narrow="1"] .df-svc-actions{grid-column:2;justify-content:flex-start;margin-top:8px;flex-wrap:wrap}
  .df-modal-ft{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 18px 14px;
    border-top:1px solid var(--df-line-soft);background:var(--df-surface)}
  .df-modal-hint{font-size:13px;color:var(--df-sub);line-height:1.5}
  .df-modal-hint.is-err{color:var(--df-err)}
  .df-modal-hint.is-warn{color:var(--df-warn)}

  .df-rewind-wrap{position:relative;display:inline-flex}
  .df-rewind{appearance:none;display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;
    border:0;border-radius:var(--df-r-sm);background:transparent;color:var(--df-sub);
    font-size:13px;line-height:1;cursor:pointer}
  .df-rewind:hover:not(:disabled){background:var(--df-hover);color:var(--df-ink)}
  .df-rewind:disabled{opacity:.4;cursor:default}
  .df-rewind svg{display:block}
  .df-rewind-menu{position:fixed;z-index:2147483003;box-sizing:border-box;min-width:238px;padding:4px;
    border:1px solid var(--df-line);border-radius:var(--df-r);background:var(--df-surface);color:var(--df-ink);
    box-shadow:var(--df-shadow-2);transform:translateY(-100%)}
  .df-rewind-item{display:flex;flex-direction:column;gap:2px;width:100%;padding:8px 10px;border:0;
    border-radius:var(--df-r-sm);background:transparent;color:inherit;text-align:left;cursor:pointer;
    font-size:13px;line-height:1.35}
  .df-rewind-item:hover{background:var(--df-hover)}
  .df-rewind-item b{font-size:14px;font-weight:620;color:var(--df-ink)}
  .df-rewind-item span{font-size:12px;color:var(--df-sub)}

  /* ---------------------------------------------------------------- 动效与降级 */
  @media (prefers-reduced-motion:reduce){
    .dfx-dock *,.df-portal *{animation-duration:.01ms!important;transition-duration:.01ms!important}
  }
  .dfx-dock[data-narrow="1"] .dfx-side{width:320px}
  .dfx-dock[data-narrow="1"] .dfx-sub,
  .dfx-dock[data-narrow="1"] .dfx-by,
  .dfx-dock[data-narrow="1"] .df-topbtn-t,
  .dfx-dock[data-narrow="1"] .df-topbtn kbd,
  .dfx-dock[data-narrow="1"] .df-target-meta{display:none}
  .dfx-dock[data-narrow="1"] .df-inject-label{display:none}
  .dfx-dock[data-narrow="1"] .df-target-name{max-width:118px}
  .dfx-dock[data-narrow="1"] .dfx-head{gap:6px;padding:0 8px 0 10px}
  .dfx-dock[data-narrow="1"] .dfx-main{padding:12px}
  .dfx-dock[data-narrow="1"] .dfx-frame{padding:12px}
  .dfx-dock[data-narrow="1"] .df-topbtn{padding:0 6px}
  .dfx-dock[data-narrow="1"] .df-target-btn{padding:0 9px;height:30px}
  /* 极窄（150% 缩放 / 小窗）抽屉浮在主区上，不再挤压表格。 */
  .dfx-dock[data-tight="1"] .dfx-body{position:relative}
  .dfx-dock[data-tight="1"] .dfx-side{position:absolute;right:0;top:0;bottom:0;z-index:6;
    border-left:1px solid var(--df-line);box-shadow:var(--df-shadow-2);border-radius:var(--df-r) 0 0 var(--df-r)}

  /* ---------------------------------------------------------------- 排版刻度收敛 */
  /* 上面各段是逐块写的，字号难免有 11.5 / 12 / 12.5 / 13 混着用的情况 ——
     切页时就会觉得「这一页字突然变小了」。这一层只改 font-size，把内容区收敛到刻度上：

       26 大数字 / 17 页面标题 / 15 卡片标题 / 14.5 列表主标题与身份列
       14 正文与表格 / 13 次要标签与 chip / 12.5 副行与细字 / 12 结构性微标签

     注意：11.5px 只在「矩阵列头副行」保留（那里一行要塞 6 个字，只能这么小）。
     顶栏、菜单、快捷键属于 chrome，本来就更小更紧，不在收敛范围内。 */
  .df-vuln-t small,
  .df-score-name small,
  .df-score-num small,
  .df-hit-hd>.df-mono,
  .df-hit-d,
  .df-sgroup-hd .df-sub,
  .df-chain-tool,
  .df-seq,
  .df-detail-sec>h4,
  .df-evi,
  .df-evi-hd,
  .df-md code,
  .df-md-code code,
  .df-md-fig figcaption,
  .df-shot-cap,
  .df-about-tag,
  .dfx-sev,
  .dfx-st,
  .dfx-kind,
  .dfx-trow .why,
  .dfx-mx th,
  .dfx-cell,
  .dfx-stage,
  .df-copy,
  .df-count,
  .df-rewind-item span,
  .df-crash-msg{font-size:var(--df-t-meta)}

  /* 行标题、卡片标题、页面标题统一走刻度，别再各写各的。 */
  .df-ops-title{font-size:var(--df-t-page)}
  .df-card-hd b{font-size:var(--df-t-card)}
  .df-vrow-t{font-size:var(--df-t-row)}
  /* 交付页的旧表格（.dfx-table）表头和主表保持同一级。 */
  .dfx-table th{font-size:13px}

  /* 主区被抽屉挤窄时：搜索框和说明先让步，别让工具条折成两行、掉一个控件在左端。
     容器查询挂在 .dfx-main 上，抽屉开合会自然触发。 */
  @container (max-width:840px){
    .df-opsbar .df-search{min-width:118px;flex:0 1 180px}
    /* 窄的时候副标题先缩到 300px：够放下大多数说明，又不会把右侧按钮挤到下一行。
       再窄（≤640）直接整条收起，见下一条。 */
    .df-opsbar .df-ops-meta{max-width:300px;overflow:hidden;text-overflow:ellipsis}
  }
  @container (max-width:640px){
    .df-opsbar .df-ops-meta{display:none}
  }

  /* ---------------------------------------------------------------- 本地应用手感 */
  /* 浏览器味的一大半来自这几件事：切页时滚动条消失/出现导致内容横向抖、
     滚到底继续滚会把宿主页面一起带走、文字到处能选中。 */
  .dfx-main{scrollbar-gutter:stable;overscroll-behavior:contain}
  .dfx-side,.df-portal .df-drawer-bd,.df-cmd-list{overscroll-behavior:contain}
  /* 界面本身不该被当成网页文本选中；真正的内容（代码、证据、报告）仍然可选。 */
  .dfx-head,.dfx-nav,.dfx-navbtn,.df-card-hd,.df-opsbar,.df-ops-title,.df-ops-meta,
  .df-table th,.df-stat,.df-sevbtn,.df-tabs,.df-seg{user-select:none;-webkit-user-select:none}
  .df-md,.df-evi,.df-code,.df-area--code,.df-detail-p,.df-crash-msg{user-select:text;-webkit-user-select:text}
  /* 按钮按下时轻微下沉，是「本机应用」最便宜的那种反馈。 */
  .df-btn:active:not(:disabled),.df-chip--btn:active,.df-navbtn:active,.df-sevbtn:active,
  .dfx-launch:active,.df-iconbtn:active{transform:scale(.975)}
  .df-btn,.df-iconbtn,.df-navbtn,.df-seg button{transition:background .12s ease,color .12s ease,
    border-color .12s ease,box-shadow .12s ease,transform .09s ease}

  /* ================================================================
     v2 整改层 · 设计令牌 + 外壳
     只改视觉语言，不动视图结构；后续再拆提示词工作台。
     ================================================================ */
  .dfx-dock,.dfx-launch,.df-portal,.df-rewind-wrap{
    --df-bg:#f0ebe1;
    --df-surface:#fffdf8;
    --df-surface-2:#f6f1e7;
    --df-fill:rgba(181,80,44,.10);
    --df-fill-hover:rgba(181,80,44,.16);
    --df-line:rgba(90,73,48,.23);
    --df-line-soft:rgba(90,73,48,.14);
    --df-line-strong:rgba(90,73,48,.36);
    --df-ink:#27241e;
    --df-sub:#5f5a50;
    --df-faint:#857d70;
    --df-ink-inv:#ffffff;
    --df-accent:#b5502c;
    --df-accent-hover:#963e20;
    --df-accent-soft:rgba(181,80,44,.12);
    --df-sel:rgba(181,80,44,.16);
    --df-hover:rgba(90,73,48,.06);
    --df-hover-2:rgba(90,73,48,.12);
    --df-ok:#2f7350;
    --df-warn:#a36a12;
    --df-err:#9a2f2a;
    --df-info:#356a7a;
    --df-ok-solid:#3c8f63;
    --df-warn-solid:#b07a1c;
    --df-err-solid:#b84a43;
    --df-info-solid:#4a8392;
    --df-ok-soft:rgba(60,143,99,.14);
    --df-warn-soft:rgba(176,122,28,.14);
    --df-err-soft:rgba(154,47,42,.13);
    --df-info-soft:rgba(74,131,146,.13);
    --df-sev-critical-bg:#9a2f2a;
    --df-sev-critical-fg:#ffffff;
    --df-sev-high-bg:#b26a1f;
    --df-sev-high-fg:#ffffff;
    --df-sev-medium-bg:#f7ecd3;
    --df-sev-medium-fg:#8a5a12;
    --df-sev-low-bg:#e0edf0;
    --df-sev-low-fg:#356a7a;
    --df-mask:rgba(25,20,12,.34);
    --df-shadow-1:0 1px 2px rgba(60,46,25,.06),0 12px 26px -20px rgba(60,46,25,.38);
    --df-shadow-2:0 30px 80px -30px rgba(40,30,15,.46),0 4px 14px rgba(40,30,15,.08);
    --df-t-num:25px;
    --df-t-page:24px;
    --df-t-card:13.5px;
    --df-t-row:13px;
    --df-t-body:13px;
    --df-t-meta:12px;
    --df-t-micro:11px;
    --df-font:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
    --df-serif:"Iowan Old Style","Palatino Linotype","Songti SC","Noto Serif CJK SC",Georgia,serif;
    --df-mono:"SFMono-Regular",Consolas,"Liberation Mono","Courier New",monospace;
    --df-r-xs:7px;
    --df-r-sm:9px;
    --df-r:13px;
    --df-r-lg:14px;
    --df-row:42px;
    --df-fs:13.5px;
  }
  body[data-ds-dark-theme] .dfx-dock,body[data-ds-dark-theme] .dfx-launch,
  body[data-ds-dark-theme] .df-portal,body[data-ds-dark-theme] .df-rewind-wrap{
    /* 暗色底跟宿主的中性色走（宿主暗色是偏蓝的灰，不是暖褐）：
       底色取在宿主 bg-base 与 layer-1 之间，面板才像「浮起来的一层」，
       又不会在宿主底色上显出一块发黄的脏灰。强调色仍保留暖色，和 dsh 区分开。 */
    --df-bg:#17181b;
    --df-surface:#202226;
    --df-surface-2:#272a2e;
    --df-fill:rgba(255,255,255,.06);
    --df-fill-hover:rgba(255,255,255,.11);
    --df-line:rgba(255,255,255,.12);
    --df-line-soft:rgba(255,255,255,.06);
    --df-line-strong:rgba(255,255,255,.22);
    --df-ink:#e9ecf1;
    --df-sub:#b7bdc7;
    --df-faint:#8a9099;
    /* 强调色上的文字用深色：白字压在暖橙上只有 3:1，会发灰。 */
    --df-ink-inv:#1c1410;
    --df-accent:#e0906a;
    --df-accent-hover:#f0a880;
    --df-accent-soft:rgba(224,144,106,.14);
    --df-sel:rgba(224,144,106,.22);
    --df-hover:rgba(255,255,255,.05);
    --df-hover-2:rgba(255,255,255,.10);
    --df-ok:#5fcb8c;
    --df-warn:#e3b566;
    --df-err:#f08b85;
    --df-info:#8fb8d8;
    --df-ok-solid:#3c8f63;
    --df-warn-solid:#b07a1c;
    --df-err-solid:#b84a43;
    --df-info-solid:#4a8392;
    --df-ok-soft:rgba(95,203,140,.16);
    --df-warn-soft:rgba(227,181,102,.16);
    --df-err-soft:rgba(240,139,133,.16);
    --df-info-soft:rgba(143,184,216,.16);
    --df-sev-critical-bg:#b84a43;
    --df-sev-critical-fg:#ffffff;
    --df-sev-high-bg:#b07a1c;
    --df-sev-high-fg:#1c1410;
    --df-sev-medium-bg:#332a1d;
    --df-sev-medium-fg:#e3b566;
    --df-sev-low-bg:#252a30;
    --df-sev-low-fg:#b7bdc7;
    --df-mask:rgba(0,0,0,.55);
    --df-shadow-1:0 1px 2px rgba(0,0,0,.2),0 18px 40px -30px rgba(0,0,0,.65);
    --df-shadow-2:0 30px 90px -24px rgba(0,0,0,.74),0 4px 14px rgba(0,0,0,.2);
  }

  .dfx-dock{border:1px solid var(--df-line);border-radius:16px;box-shadow:var(--df-shadow-2);background:var(--df-bg)}
  .dfx-head{height:52px;padding:0 12px 0 16px;gap:8px;background:var(--df-bg);border-bottom:1px solid var(--df-line)}
  .dfx-mark{width:28px;height:28px;border-radius:8px;background:var(--df-ink);color:var(--df-surface);box-shadow:inset 0 0 0 1px rgba(255,255,255,.06)}
  body[data-ds-dark-theme] .dfx-mark{background:var(--df-accent);color:var(--df-ink-inv)}
  .dfx-brand{font-size:14px;font-weight:750;letter-spacing:.01em}
  .dfx-sub{font-size:9.5px;letter-spacing:.08em;color:var(--df-faint)}
  .dfx-by{font-size:10px;color:var(--df-faint)}
  .dfx-tag{height:27px;border-radius:8px;background:var(--df-surface);border:1px solid var(--df-line);font-size:11.5px;padding:0 9px}
  .dfx-tag:hover{border-color:var(--df-line-strong);background:var(--df-surface-2)}
  .dfx-head .df-topbtn{height:30px;border-radius:8px;border:1px solid var(--df-line);background:var(--df-surface);font-size:11px;color:var(--df-sub)}
  .dfx-head .df-topbtn:hover{background:var(--df-surface-2);border-color:var(--df-line-strong)}
  .dfx-head .df-iconbtn{width:30px;height:30px;border-radius:8px}
  .dfx-body{background:var(--df-bg)}
  .dfx-nav{width:206px;padding:9px 9px 11px;border-right:1px solid var(--df-line);background:linear-gradient(180deg,var(--df-surface),var(--df-surface-2))}
  .dfx-ngrp{height:20px;padding:0 9px;font:9px/20px var(--df-mono);letter-spacing:.14em;text-transform:uppercase;color:var(--df-sub);opacity:.72}
  .dfx-ngrp-block:first-child .dfx-ngrp{padding-top:1px}
  .dfx-navbtn{height:33px;border-radius:8px;padding:0 9px;gap:9px;font-size:12.5px;font-weight:560;color:var(--df-sub)}
  .dfx-navbtn:hover{background:var(--df-hover);color:var(--df-ink)}
  .dfx-navbtn.on{background:var(--df-accent-soft);color:var(--df-accent);font-weight:650;box-shadow:none;border:0}
  .dfx-navbtn.on>svg{color:var(--df-accent);opacity:1}
  .dfx-navbtn.on::before{content:"";position:absolute;left:-9px;top:9px;bottom:9px;width:3px;border-radius:0 3px 3px 0;background:var(--df-accent)}
  .dfx-navbtn .df-navdot{width:5px;height:5px;background:var(--df-err);box-shadow:0 0 0 3px var(--df-err-soft)}
  .dfx-navfoot{border-top:1px solid var(--df-line);padding-top:7px;margin-top:7px}
  .dfx-navfold{height:30px;border-radius:8px;font-size:11px;color:var(--df-faint)}
  .dfx-navfold:hover{background:var(--df-hover);color:var(--df-sub)}
  .dfx-main{padding:22px 24px 32px;gap:14px;background:transparent}
  .dfx-pane{gap:14px}
  .dfx-side{background:var(--df-surface);border-left:1px solid var(--df-line)}

  .df-ops-title{font-family:var(--df-serif);font-size:24px;line-height:1.16;font-weight:600;letter-spacing:-.02em}
  .df-ops-meta{font-size:11px;color:var(--df-sub)}
  .df-card{border:1px solid var(--df-line);border-radius:var(--df-r);box-shadow:var(--df-shadow-1);background:var(--df-surface)}
  .df-card-hd{min-height:47px;padding:13px 16px;border-bottom-color:var(--df-line-soft)}
  .df-card-hd b{font-size:13px;font-weight:700}
  .df-card-hd .df-sub{font-size:10.5px;color:var(--df-faint)}
  .df-card-bd{padding:12px}
  .df-card-bd--pad{padding:15px}
  .df-card-hd .df-opsbar{gap:6px}
  .df-btn{height:31px;padding:0 11px;border-radius:8px;border-color:var(--df-line);background:var(--df-surface);font-size:12px;font-weight:620}
  .df-btn:hover{background:var(--df-surface-2);border-color:var(--df-line-strong)}
  .df-btn--sm{height:27px;padding:0 8px;font-size:11px}
  .df-btn--lg{height:35px;padding:0 15px;font-size:12.5px}
  .df-btn--primary{background:var(--df-accent);border-color:var(--df-accent);color:var(--df-ink-inv);box-shadow:0 6px 16px -12px var(--df-accent)}
  .df-btn--primary:hover{background:var(--df-accent-hover);border-color:var(--df-accent-hover)}
  .df-btn--ghost{border-color:transparent;color:var(--df-sub)}
  .df-btn--ghost:hover{background:var(--df-hover);border-color:transparent;color:var(--df-ink)}
  .df-btn--danger{border-color:var(--df-err-soft)}
  .df-input,.df-select,.df-area{border:1px solid var(--df-line);border-radius:8px;background:var(--df-surface-2);font-size:12px;height:31px}
  .df-input:focus,.df-select:focus,.df-area:focus{background:var(--df-surface);border-color:var(--df-accent);box-shadow:0 0 0 3px var(--df-accent-soft)}
  .df-chip{height:21px;padding:0 7px;font-size:9.5px;font-weight:650}
  .df-table th{background:var(--df-surface-2);font:9.5px/1.2 var(--df-mono);letter-spacing:.10em;text-transform:uppercase;color:var(--df-faint);height:33px}
  .df-table td{height:42px;font-size:12px;border-bottom-color:var(--df-line-soft)}
  .df-table td:first-child{font-size:12.5px;font-weight:620}
  .df-table tbody tr:hover{background:var(--df-hover)}
  .df-stat-l{font-size:11px;color:var(--df-faint)}
  .df-stat-v{font-size:25px;font-weight:600;font-family:var(--df-serif)}
  .df-stat-f{font-size:10px;color:var(--df-faint)}
  .df-note{border-radius:8px;font-size:11px;line-height:1.55}
  .df-menu{border-radius:12px;border-color:var(--df-line);box-shadow:var(--df-shadow-2);background:var(--df-surface)}
  .df-menu-hd{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--df-faint);font-family:var(--df-mono)}
  .df-menu-item{border-radius:7px;font-size:11.5px}
  .df-menu-item.on{background:var(--df-accent-soft)}
  .dfx-head .df-target{border-radius:8px;background:var(--df-surface);border:1px solid var(--df-line);height:27px;padding:0 9px}
  .dfx-head .df-target-name{font-size:11.5px;font-weight:650}
  .dfx-head .df-target-meta{font-size:9px;color:var(--df-faint)}
  .dfx-head .df-inject-chip{height:27px;border-radius:8px;background:var(--df-surface);border:1px solid var(--df-line)}
  .dfx-head .df-inject-label{font-size:11px}
  /* 总开关要一眼看出来：开=绿底绿边，关=灰底；点击直接切，不再只是状态灯。 */
  .dfx-head .df-inject-chip.is-on{background:var(--df-ok-soft);border-color:color-mix(in srgb,var(--df-ok) 42%,transparent);color:var(--df-ink)}
  .dfx-head .df-inject-chip.is-off{background:var(--df-surface-2);border-color:var(--df-line);color:var(--df-sub)}
  .dfx-head .df-inject-chip:disabled{opacity:.6;cursor:default}
  .dfx-head .df-inject-state{padding:0 4px;border-radius:4px;font-size:10px;font-weight:700;line-height:15px;background:var(--df-surface)}
  .dfx-head .df-inject-chip.is-on .df-inject-state{color:var(--df-ok)}
  .dfx-head .df-inject-chip.is-off .df-inject-state{color:var(--df-faint)}
  .dfx-head .df-inject-gear{height:27px;padding:0 7px;margin-left:6px;border-radius:8px;border:1px solid var(--df-line);
    background:var(--df-surface);color:var(--df-sub);display:inline-flex;align-items:center;cursor:pointer}
  .dfx-head .df-inject-gear:hover{background:var(--df-hover);color:var(--df-ink)}
  .df-zoom{font-size:10px;color:var(--df-faint)}
  .df-sevtag{font-size:9px;font-weight:700}

  /* ---------------------------------------------------------------- 提示词工作台 */
  /* 宽屏不再留一条只有六个按钮的左栏：层导航改成顶部六格，详情拿到整幅宽度，
     全屏时也不会出现导航下方的大片空白。 */
  .df-prompt-workbench{display:flex;flex-direction:column;gap:12px}
  .df-prompt-nav{padding:7px;border:1px solid var(--df-line);border-radius:var(--df-r);background:var(--df-surface);box-shadow:var(--df-shadow-1)}
  .df-prompt-navhd{padding:4px 7px 7px;font:9px/1 var(--df-mono);letter-spacing:.14em;text-transform:uppercase;color:var(--df-faint)}
  .df-prompt-items{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:5px}
  /* 顶部导航下方的「本层摘要」：一句话交代选中层的作用域、存储位置与生效条件，
     每次切换都有确定的阅读落点。 */
  .df-prompt-side{display:flex;align-items:center;flex-wrap:wrap;gap:5px 14px;margin-top:7px;padding:8px 7px 1px;border-top:1px solid var(--df-line-soft)}
  .df-prompt-sidehd{display:inline-flex;align-items:center;gap:7px;font-size:10px;font-weight:700;color:var(--df-sub)}
  .df-prompt-when{padding:2px 6px;border-radius:5px;font-size:9px;font-weight:700;line-height:1.35;background:var(--df-surface-2);border:1px solid var(--df-line-soft);color:var(--df-sub)}
  .df-prompt-when.is-live{background:var(--df-ok-soft);border-color:color-mix(in srgb,var(--df-ok) 32%,transparent);color:var(--df-ok)}
  .df-prompt-when.is-restart{background:var(--df-warn-soft);border-color:color-mix(in srgb,var(--df-warn) 32%,transparent);color:var(--df-warn)}
  .df-prompt-when.is-spawn{background:var(--df-info-soft);border-color:color-mix(in srgb,var(--df-info) 32%,transparent);color:var(--df-info)}
  .df-prompt-when.is-read{color:var(--df-faint)}
  .df-prompt-srow{display:inline-flex;gap:6px;font-size:9.5px;line-height:1.55;color:var(--df-faint)}
  .df-prompt-srow b{flex:none;font-weight:600;color:var(--df-sub)}
  .df-prompt-srow span{min-width:0;word-break:break-word}
  .df-prompt-show{flex:1 1 300px;min-width:0;font-size:9.5px;line-height:1.55;color:var(--df-faint)}
  .df-prompt-item{display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:8px;border-radius:8px;border:1px solid transparent;background:transparent;text-align:left;color:var(--df-sub);transition:background .14s,border-color .14s,color .14s}
  .df-prompt-item:hover{background:var(--df-hover);color:var(--df-ink)}
  .df-prompt-item.on{background:var(--df-accent-soft);border-color:color-mix(in srgb,var(--df-accent) 26%,transparent);color:var(--df-accent)}
  .df-prompt-ico{width:27px;height:27px;flex:0 0 auto;border-radius:7px;display:flex;align-items:center;justify-content:center;background:var(--df-surface-2);color:var(--df-sub)}
  .df-prompt-item.on .df-prompt-ico{background:var(--df-surface);color:var(--df-accent)}
  .df-prompt-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
  .df-prompt-copy strong{font-size:12px;font-weight:650;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .df-prompt-copy small{font-size:9.5px;line-height:1.35;color:var(--df-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .df-prompt-item.on .df-prompt-copy small{color:var(--df-accent);opacity:.75}
  .df-prompt-dot{width:6px;height:6px;flex:0 0 auto;border-radius:50%;background:var(--df-faint)}
  .df-prompt-dot.is-ok{background:var(--df-ok);box-shadow:0 0 0 3px var(--df-ok-soft)}
  .df-prompt-dot.is-warn{background:var(--df-warn);box-shadow:0 0 0 3px var(--df-warn-soft)}
  .df-prompt-dot.is-err{background:var(--df-err);box-shadow:0 0 0 3px var(--df-err-soft)}
  .df-prompt-dot.is-info{background:var(--df-info);box-shadow:0 0 0 3px var(--df-info-soft)}
  .df-prompt-foot{margin-top:7px;padding:9px 8px 1px;border-top:1px solid var(--df-line-soft);font-size:9px;line-height:1.5;color:var(--df-faint)}
  .df-prompt-detail{min-width:0}
  .df-prompt-detail>.df-ops{gap:12px}
  .df-prompt-detail>.df-ops>.df-opsbar{display:none}
  .df-prompt-detail .df-layers{display:none}
  .df-prompt-note{margin-top:0}
  /* 六格排不下完整层名时折成 3+3，而不是把中间几项截成省略号。 */
  @container (max-width: 1080px){
    .df-prompt-items{grid-template-columns:repeat(3,minmax(0,1fr))}
  }
  @container (max-width: 820px){
    .df-prompt-nav{padding:7px}
    .df-prompt-navhd,.df-prompt-foot{display:none}
    .df-prompt-items{gap:4px}
    .df-prompt-item{padding:8px;gap:6px}
    .df-prompt-side{gap:4px 10px;padding-top:7px}
    .df-prompt-show{display:none}
  }
  @container (max-width: 560px){
    .df-prompt-items{grid-template-columns:repeat(2,minmax(0,1fr))}
    .df-prompt-copy small{display:none}
    .df-prompt-ico{display:none}
  }
  `
  document.head.appendChild(el)
}
