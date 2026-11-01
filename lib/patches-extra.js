// 新增补丁：针对本机 0.2.1-rc.3 有实际收益的 4 条。
//
//   #32 WEB_SURFACE_IDENTITY_NEUTRAL  升级版：同时覆盖 harness-dev-context 包
//   #40 COMPLETE_PROMPT_KEEP_INJECT   升级版：fold-complete 段序（inject 在前）
//   #89 SYSTEM_MESSAGE_CONTRACT       新增：原生 system 消息与顺序保留
//   #92 SUBAGENT_SAME_INJECT_PATH     新增：子代理继承父会话 assemble
//                                      ★ 已删掉 permissionPreset 提权两条，子代理不再被抬成 danger-full-access
//
// 故意不移植：
//   #85 #86  forbid[] 命中本机已有标记 → 永远判 pending，且语义与本机 steer 修复相反
//   #88      标记串与本机不一致，会让已 applied 的 #87/#88 掉成 skipped
//   #90 #91  目标包 pi-ai-completions / pi-ai-anthropic-messages 在 0.2.1-rc.2 不存在
//
// 本文件是纯数据，无副作用。

export const EXTRA_PATCHES = [
  {
    "id": 32,
    "name": "WEB_SURFACE_IDENTITY_NEUTRAL",
    "layer": "提示词",
    "layer_en": "Prompt",
    "desc": "Web 面：去掉 DeepSeek Harness 自称 / neutralize web GUI identity branding",
    "file": [
      "web-app-lib",
      "harness-dev-context"
    ],
    "optional": true,
    "replacements": [
      {
        "pattern": "You are interacting with the user through the DeepSeek Harness Web GUI at ${webUrl}.",
        "replace": "You are interacting with the user through the local web GUI at ${webUrl}."
      },
      {
        "pattern": "description: \"Canonical local URL of the DeepSeek Harness Web GUI serving this session.\"",
        "replace": "description: \"Canonical local URL of the web GUI serving this session.\" /* [dsh-forge] web surface identity neutralized */"
      },
      {
        "pattern": "description: \"Advertised URL of the DeepSeek Harness Web GUI serving this session.\"",
        "replace": "description: \"Advertised URL of the web GUI serving this session.\" /* [dsh-forge] web surface identity neutralized */"
      },
      {
        "pattern": "const WEB_SURFACE_PROMPT = `You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.",
        "replace": "const WEB_SURFACE_PROMPT = /* [dsh-forge] web surface identity neutralized */ `You are interacting with the user through the local web GUI whose URL the runtime context names."
      },
      {
        "pattern": "const HARNESS_SOURCE_PROMPT = `The runtime context names the DeepSeek Harness implementation checkout.",
        "replace": "const HARNESS_SOURCE_PROMPT = /* [dsh-forge] harness source identity neutralized */ `The runtime context names the implementation checkout."
      },
      {
        "pattern": "text: `Current DeepSeek Harness implementation checkout: ${JSON.stringify(SOURCE_ROOT)}.`",
        "replace": "text: /* [dsh-forge] harness source identity neutralized */ `Current implementation checkout: ${JSON.stringify(SOURCE_ROOT)}.`"
      },
      {
        "pattern": "text: () => `Current DeepSeek Harness Web GUI URL: ${JSON.stringify(ctx.webApp.getAdvertisedUrl())}.`",
        "replace": "text: /* [dsh-forge] web surface identity neutralized */ () => `Current web GUI URL: ${JSON.stringify(ctx.webApp.getAdvertisedUrl())}.`"
      }
    ],
    "markers": [
      "[dsh-forge] web surface identity neutralized",
      "[dsh-forge] harness source identity neutralized",
      "through the local web GUI at ${webUrl}."
    ],
    "markersAny": true
  },
  {
    "id": 40,
    "name": "COMPLETE_PROMPT_KEEP_INJECT",
    "layer": "0.1.5 兼容",
    "layer_en": "0.1.5",
    "desc": "complete 预设把已折进 persona 的注入放最前 / keep folded inject first after complete prompt",
    "file": [
      "system-prompt",
      "system-prompt-nested"
    ],
    "replacements": [
      {
        "pattern": "\t\tconst transformed = await this.ctx.waterfall(scopeTarget(this, scope), \"system-prompt/assemble\", assembly, context, () => Promise.resolve(assembly));\n\t\tconst dshForgeSections = (transformed.sections || []).filter((s) => String(s && s.name || \"\").startsWith(\"dsh-forge\") && String(s.text || \"\").length > 0);\n\t\tconst dshForgeRest = (transformed.sections || []).filter((s) => !String(s && s.name || \"\").startsWith(\"dsh-forge\"));\n\t\tif (completeSection === void 0 && !runtimeContextSuppressed) return { ...transformed, sections: [...dshForgeSections, ...dshForgeRest] }; // [dsh-forge] every mode keeps system inject\n\t\tconst requiredContexts = new Set([...contextByName.values()].filter((entry) => entry.required === true).map((entry) => entry.name));\n\t\treturn {\n\t\t\t...transformed,\n\t\t\tsections: completeSection === void 0 ? [...dshForgeSections, ...dshForgeRest] : (function (complete, forge, rest) {\n\t\t\t\tconst base = { ...complete };\n\t\t\t\tconst tail = rest.filter((s) => String(s?.name || \"\") !== String(base.name || \"\"));\n\t\t\t\treturn [...forge, ...tail, base]; // [dsh-forge] complete prompt keeps inject + agent-instructions\n\t\t\t})(completeSection, dshForgeSections, dshForgeRest),\n\t\t\tcontexts: runtimeContextSuppressed ? transformed.contexts.filter((entry) => requiredContexts.has(entry.name)) : transformed.contexts\n\t\t};",
        "replace": "\t\tconst transformed = await this.ctx.waterfall(scopeTarget(this, scope), \"system-prompt/assemble\", assembly, context, () => Promise.resolve(assembly));\n\t\tconst dshForgeSections = (transformed.sections || []).filter((s) => String(s && s.name || \"\").startsWith(\"dsh-forge\") && String(s.text || \"\").length > 0);\n\t\tconst dshForgeRest = (transformed.sections || []).filter((s) => !String(s && s.name || \"\").startsWith(\"dsh-forge\"));\n\t\tif (completeSection === void 0 && !runtimeContextSuppressed) return { ...transformed, sections: [...dshForgeSections, ...dshForgeRest] }; // [dsh-forge] fold-complete inject first\n\t\tconst requiredContexts = new Set([...contextByName.values()].filter((entry) => entry.required === true).map((entry) => entry.name));\n\t\treturn {\n\t\t\t...transformed,\n\t\t\tsections: completeSection === void 0 ? [...dshForgeSections, ...dshForgeRest] : (function (complete, forge, rest, assembled) {\n\t\t\t\tconst name = String(complete && complete.name || \"\");\n\t\t\t\tconst after = (assembled || []).find((s) => String(s && s.name || \"\") === name);\n\t\t\t\tconst base = after ? { ...after } : { ...complete };\n\t\t\t\tconst tail = rest.filter((s) => String(s?.name || \"\") !== name);\n\t\t\t\treturn [...forge, base, ...tail]; // [dsh-forge] fold-complete inject first\n\t\t\t})(completeSection, dshForgeSections, dshForgeRest, transformed.sections),\n\t\t\tcontexts: runtimeContextSuppressed ? transformed.contexts.filter((entry) => requiredContexts.has(entry.name)) : transformed.contexts\n\t\t};"
      },
      {
        "pattern": "\t\tconst transformed = await this.ctx.waterfall(scopeTarget(this, scope), \"system-prompt/assemble\", assembly, context, () => Promise.resolve(assembly));\n\t\tconst dshForgeSections = (transformed.sections || []).filter((s) => String(s && s.name || \"\").startsWith(\"dsh-forge\") && String(s.text || \"\").length > 0);\n\t\tconst dshForgeRest = (transformed.sections || []).filter((s) => !String(s && s.name || \"\").startsWith(\"dsh-forge\"));\n\t\tif (completeSection === void 0 && !runtimeContextSuppressed) return { ...transformed, sections: [...dshForgeRest, ...dshForgeSections] }; // [dsh-forge] inject last after closer\n\t\tconst requiredContexts = new Set([...contextByName.values()].filter((entry) => entry.required === true).map((entry) => entry.name));\n\t\treturn {\n\t\t\t...transformed,\n\t\t\tsections: completeSection === void 0 ? [...dshForgeRest, ...dshForgeSections] : (function (complete, forge, rest, assembled) {\n\t\t\t\tconst name = String(complete && complete.name || \"\");\n\t\t\t\tconst after = (assembled || []).find((s) => String(s && s.name || \"\") === name);\n\t\t\t\tconst base = after ? { ...after } : { ...complete };\n\t\t\t\tconst tail = rest.filter((s) => String(s?.name || \"\") !== name);\n\t\t\t\treturn [...tail, base, ...forge]; // [dsh-forge] inject last after closer\n\t\t\t})(completeSection, dshForgeSections, dshForgeRest, transformed.sections),\n\t\t\tcontexts: runtimeContextSuppressed ? transformed.contexts.filter((entry) => requiredContexts.has(entry.name)) : transformed.contexts\n\t\t};",
        "replace": "\t\tconst transformed = await this.ctx.waterfall(scopeTarget(this, scope), \"system-prompt/assemble\", assembly, context, () => Promise.resolve(assembly));\n\t\tconst dshForgeSections = (transformed.sections || []).filter((s) => String(s && s.name || \"\").startsWith(\"dsh-forge\") && String(s.text || \"\").length > 0);\n\t\tconst dshForgeRest = (transformed.sections || []).filter((s) => !String(s && s.name || \"\").startsWith(\"dsh-forge\"));\n\t\tif (completeSection === void 0 && !runtimeContextSuppressed) return { ...transformed, sections: [...dshForgeSections, ...dshForgeRest] }; // [dsh-forge] fold-complete inject first\n\t\tconst requiredContexts = new Set([...contextByName.values()].filter((entry) => entry.required === true).map((entry) => entry.name));\n\t\treturn {\n\t\t\t...transformed,\n\t\t\tsections: completeSection === void 0 ? [...dshForgeSections, ...dshForgeRest] : (function (complete, forge, rest, assembled) {\n\t\t\t\tconst name = String(complete && complete.name || \"\");\n\t\t\t\tconst after = (assembled || []).find((s) => String(s && s.name || \"\") === name);\n\t\t\t\tconst base = after ? { ...after } : { ...complete };\n\t\t\t\tconst tail = rest.filter((s) => String(s?.name || \"\") !== name);\n\t\t\t\treturn [...forge, base, ...tail]; // [dsh-forge] fold-complete inject first\n\t\t\t})(completeSection, dshForgeSections, dshForgeRest, transformed.sections),\n\t\t\tcontexts: runtimeContextSuppressed ? transformed.contexts.filter((entry) => requiredContexts.has(entry.name)) : transformed.contexts\n\t\t};"
      },
      {
        "pattern": "\t\tconst transformed = await this.ctx.waterfall(scopeTarget(this, scope), \"system-prompt/assemble\", assembly, context, () => Promise.resolve(assembly));\n\t\tif (completeSection === void 0 && !runtimeContextSuppressed) return transformed;\n\t\tconst requiredContexts = new Set([...contextByName.values()].filter((entry) => entry.required === true).map((entry) => entry.name));\n\t\treturn {\n\t\t\t...transformed,\n\t\t\tsections: completeSection === void 0 ? transformed.sections : [completeSection],\n\t\t\tcontexts: runtimeContextSuppressed ? transformed.contexts.filter((entry) => requiredContexts.has(entry.name)) : transformed.contexts\n\t\t};",
        "replace": "\t\tconst transformed = await this.ctx.waterfall(scopeTarget(this, scope), \"system-prompt/assemble\", assembly, context, () => Promise.resolve(assembly));\n\t\tconst dshForgeSections = (transformed.sections || []).filter((s) => String(s && s.name || \"\").startsWith(\"dsh-forge\") && String(s.text || \"\").length > 0);\n\t\tconst dshForgeRest = (transformed.sections || []).filter((s) => !String(s && s.name || \"\").startsWith(\"dsh-forge\"));\n\t\tif (completeSection === void 0 && !runtimeContextSuppressed) return { ...transformed, sections: [...dshForgeSections, ...dshForgeRest] }; // [dsh-forge] fold-complete inject first\n\t\tconst requiredContexts = new Set([...contextByName.values()].filter((entry) => entry.required === true).map((entry) => entry.name));\n\t\treturn {\n\t\t\t...transformed,\n\t\t\tsections: completeSection === void 0 ? [...dshForgeSections, ...dshForgeRest] : (function (complete, forge, rest, assembled) {\n\t\t\t\tconst name = String(complete && complete.name || \"\");\n\t\t\t\tconst after = (assembled || []).find((s) => String(s && s.name || \"\") === name);\n\t\t\t\tconst base = after ? { ...after } : { ...complete };\n\t\t\t\tconst tail = rest.filter((s) => String(s?.name || \"\") !== name);\n\t\t\t\treturn [...forge, base, ...tail]; // [dsh-forge] fold-complete inject first\n\t\t\t})(completeSection, dshForgeSections, dshForgeRest, transformed.sections),\n\t\t\tcontexts: runtimeContextSuppressed ? transformed.contexts.filter((entry) => requiredContexts.has(entry.name)) : transformed.contexts\n\t\t};"
      },
      {
        "pattern": {},
        "replace": "\t\tconst transformed = await this.ctx.waterfall(scopeTarget(this, scope), \"system-prompt/assemble\", assembly, context, () => Promise.resolve(assembly));\n\t\tconst dshForgeSections = (transformed.sections || []).filter((s) => String(s && s.name || \"\").startsWith(\"dsh-forge\") && String(s.text || \"\").length > 0);\n\t\tconst dshForgeRest = (transformed.sections || []).filter((s) => !String(s && s.name || \"\").startsWith(\"dsh-forge\"));\n\t\tif (completeSection === void 0 && !runtimeContextSuppressed) return { ...transformed, sections: [...dshForgeSections, ...dshForgeRest] }; // [dsh-forge] fold-complete inject first\n\t\treturn {\n\t\t\t...transformed,\n\t\t\tsections: completeSection === void 0 ? [...dshForgeSections, ...dshForgeRest] : (function (complete, forge, rest, assembled) {\n\t\t\t\tconst name = String(complete && complete.name || \"\");\n\t\t\t\tconst after = (assembled || []).find((s) => String(s && s.name || \"\") === name);\n\t\t\t\tconst base = after ? { ...after } : { ...complete };\n\t\t\t\tconst tail = rest.filter((s) => String(s?.name || \"\") !== name);\n\t\t\t\treturn [...forge, base, ...tail]; // [dsh-forge] fold-complete inject first\n\t\t\t})(completeSection, dshForgeSections, dshForgeRest, transformed.sections),\n\t\t\tcontexts: runtimeContextSuppressed ? [] : transformed.contexts\n\t\t};"
      },
      {
        "pattern": "\t\tconst dshForgeInject = (assembly.sections || []).filter((s) => String(s && s.name || \"\").startsWith(\"dsh-forge\")).map((s) => String(s.text || \"\")).filter((t) => t.length > 0).join(\"\\n\\n\");\n\t\tconst transformed = await this.ctx.waterfall(scopeTarget(this, scope), \"system-prompt/assemble\", assembly, context, () => Promise.resolve(assembly));\n\t\tif (completeSection === void 0 && !runtimeContextSuppressed) return transformed;\n\t\treturn {\n\t\t\t...transformed,\n\t\t\tsections: completeSection === void 0 ? transformed.sections : (function (complete, inject) {\n\t\t\t\tconst base = { ...complete };\n\t\t\t\tif (!inject) return [base];\n\t\t\t\tif (String(base.text || \"\").includes(inject)) return [base];\n\t\t\t\treturn [{ ...base, text: inject + \"\\n\\n\" + base.text }]; // [dsh-forge] complete prompt keeps inject\n\t\t\t})(completeSection, dshForgeInject),\n\t\t\tcontexts: runtimeContextSuppressed ? [] : transformed.contexts\n\t\t};",
        "replace": "\t\tconst transformed = await this.ctx.waterfall(scopeTarget(this, scope), \"system-prompt/assemble\", assembly, context, () => Promise.resolve(assembly));\n\t\tconst dshForgeSections = (transformed.sections || []).filter((s) => String(s && s.name || \"\").startsWith(\"dsh-forge\") && String(s.text || \"\").length > 0);\n\t\tconst dshForgeRest = (transformed.sections || []).filter((s) => !String(s && s.name || \"\").startsWith(\"dsh-forge\"));\n\t\tif (completeSection === void 0 && !runtimeContextSuppressed) return { ...transformed, sections: [...dshForgeSections, ...dshForgeRest] }; // [dsh-forge] fold-complete inject first\n\t\treturn {\n\t\t\t...transformed,\n\t\t\tsections: completeSection === void 0 ? [...dshForgeSections, ...dshForgeRest] : (function (complete, forge, rest, assembled) {\n\t\t\t\tconst name = String(complete && complete.name || \"\");\n\t\t\t\tconst after = (assembled || []).find((s) => String(s && s.name || \"\") === name);\n\t\t\t\tconst base = after ? { ...after } : { ...complete };\n\t\t\t\tconst tail = rest.filter((s) => String(s?.name || \"\") !== name);\n\t\t\t\treturn [...forge, base, ...tail]; // [dsh-forge] fold-complete inject first\n\t\t\t})(completeSection, dshForgeSections, dshForgeRest, transformed.sections),\n\t\t\tcontexts: runtimeContextSuppressed ? [] : transformed.contexts\n\t\t};"
      },
      {
        "pattern": "\t\tconst transformed = await this.ctx.waterfall(scopeTarget(this, scope), \"system-prompt/assemble\", assembly, context, () => Promise.resolve(assembly));\n\t\tconst dshForgeSections = (transformed.sections || []).filter((s) => String(s && s.name || \"\").startsWith(\"dsh-forge\") && String(s.text || \"\").length > 0);\n\t\tif (completeSection === void 0 && !runtimeContextSuppressed) return transformed;\n\t\treturn {\n\t\t\t...transformed,\n\t\t\tsections: completeSection === void 0 ? transformed.sections : (function (complete, forge) {\n\t\t\t\tconst base = { ...complete };\n\t\t\t\treturn [...forge, base]; // [dsh-forge] complete prompt keeps waterfall inject\n\t\t\t})(completeSection, dshForgeSections),\n\t\t\tcontexts: runtimeContextSuppressed ? [] : transformed.contexts\n\t\t};",
        "replace": "\t\tconst transformed = await this.ctx.waterfall(scopeTarget(this, scope), \"system-prompt/assemble\", assembly, context, () => Promise.resolve(assembly));\n\t\tconst dshForgeSections = (transformed.sections || []).filter((s) => String(s && s.name || \"\").startsWith(\"dsh-forge\") && String(s.text || \"\").length > 0);\n\t\tconst dshForgeRest = (transformed.sections || []).filter((s) => !String(s && s.name || \"\").startsWith(\"dsh-forge\"));\n\t\tif (completeSection === void 0 && !runtimeContextSuppressed) return { ...transformed, sections: [...dshForgeSections, ...dshForgeRest] }; // [dsh-forge] fold-complete inject first\n\t\treturn {\n\t\t\t...transformed,\n\t\t\tsections: completeSection === void 0 ? [...dshForgeSections, ...dshForgeRest] : (function (complete, forge, rest, assembled) {\n\t\t\t\tconst name = String(complete && complete.name || \"\");\n\t\t\t\tconst after = (assembled || []).find((s) => String(s && s.name || \"\") === name);\n\t\t\t\tconst base = after ? { ...after } : { ...complete };\n\t\t\t\tconst tail = rest.filter((s) => String(s?.name || \"\") !== name);\n\t\t\t\treturn [...forge, base, ...tail]; // [dsh-forge] fold-complete inject first\n\t\t\t})(completeSection, dshForgeSections, dshForgeRest, transformed.sections),\n\t\t\tcontexts: runtimeContextSuppressed ? [] : transformed.contexts\n\t\t};"
      },
      {
        "pattern": "\t\tconst transformed = await this.ctx.waterfall(scopeTarget(this, scope), \"system-prompt/assemble\", assembly, context, () => Promise.resolve(assembly));\n\t\tconst dshForgeSections = (transformed.sections || []).filter((s) => String(s && s.name || \"\").startsWith(\"dsh-forge\") && String(s.text || \"\").length > 0);\n\t\tconst dshForgeRest = (transformed.sections || []).filter((s) => !String(s && s.name || \"\").startsWith(\"dsh-forge\"));\n\t\t\t\tif (completeSection === void 0 && !runtimeContextSuppressed) return { ...transformed, sections: [...dshForgeSections, ...dshForgeRest] }; // [dsh-forge] every mode keeps system inject\n\t\treturn {\n\t\t\t...transformed,\n\t\t\tsections: completeSection === void 0 ? [...dshForgeSections, ...dshForgeRest] : (function (complete, forge) {\n\t\t\t\tconst base = { ...complete };\n\t\t\t\treturn [...forge, base]; // [dsh-forge] complete prompt keeps waterfall inject\n\t\t\t})(completeSection, dshForgeSections),\n\t\t\tcontexts: runtimeContextSuppressed ? [] : transformed.contexts\n\t\t};",
        "replace": "\t\tconst transformed = await this.ctx.waterfall(scopeTarget(this, scope), \"system-prompt/assemble\", assembly, context, () => Promise.resolve(assembly));\n\t\tconst dshForgeSections = (transformed.sections || []).filter((s) => String(s && s.name || \"\").startsWith(\"dsh-forge\") && String(s.text || \"\").length > 0);\n\t\tconst dshForgeRest = (transformed.sections || []).filter((s) => !String(s && s.name || \"\").startsWith(\"dsh-forge\"));\n\t\tif (completeSection === void 0 && !runtimeContextSuppressed) return { ...transformed, sections: [...dshForgeSections, ...dshForgeRest] }; // [dsh-forge] fold-complete inject first\n\t\treturn {\n\t\t\t...transformed,\n\t\t\tsections: completeSection === void 0 ? [...dshForgeSections, ...dshForgeRest] : (function (complete, forge, rest, assembled) {\n\t\t\t\tconst name = String(complete && complete.name || \"\");\n\t\t\t\tconst after = (assembled || []).find((s) => String(s && s.name || \"\") === name);\n\t\t\t\tconst base = after ? { ...after } : { ...complete };\n\t\t\t\tconst tail = rest.filter((s) => String(s?.name || \"\") !== name);\n\t\t\t\treturn [...forge, base, ...tail]; // [dsh-forge] fold-complete inject first\n\t\t\t})(completeSection, dshForgeSections, dshForgeRest, transformed.sections),\n\t\t\tcontexts: runtimeContextSuppressed ? [] : transformed.contexts\n\t\t};"
      },
      {
        "pattern": "\t\tconst transformed = await this.ctx.waterfall(scopeTarget(this, scope), \"system-prompt/assemble\", assembly, context, () => Promise.resolve(assembly));\n\t\tconst dshForgeSections = (transformed.sections || []).filter((s) => String(s && s.name || \"\").startsWith(\"dsh-forge\") && String(s.text || \"\").length > 0);\n\t\tconst dshForgeRest = (transformed.sections || []).filter((s) => !String(s && s.name || \"\").startsWith(\"dsh-forge\"));\n\t\tif (completeSection === void 0 && !runtimeContextSuppressed) return { ...transformed, sections: [...dshForgeSections, ...dshForgeRest] }; // [dsh-forge] every mode keeps system inject\n\t\treturn {\n\t\t\t...transformed,\n\t\t\tsections: completeSection === void 0 ? [...dshForgeSections, ...dshForgeRest] : (function (complete, forge, rest, assembled) {\n\t\t\t\tconst name = String(complete && complete.name || \"\");\n\t\t\t\tconst after = (assembled || []).find((s) => String(s && s.name || \"\") === name);\n\t\t\t\tconst base = after ? { ...after } : { ...complete };\n\t\t\t\tconst tail = rest.filter((s) => String(s?.name || \"\") !== name);\n\t\t\t\treturn [...forge, ...tail, base]; // [dsh-forge] complete prompt keeps inject + assembled complete\n\t\t\t})(completeSection, dshForgeSections, dshForgeRest, transformed.sections),\n\t\t\tcontexts: runtimeContextSuppressed ? [] : transformed.contexts\n\t\t};",
        "replace": "\t\tconst transformed = await this.ctx.waterfall(scopeTarget(this, scope), \"system-prompt/assemble\", assembly, context, () => Promise.resolve(assembly));\n\t\tconst dshForgeSections = (transformed.sections || []).filter((s) => String(s && s.name || \"\").startsWith(\"dsh-forge\") && String(s.text || \"\").length > 0);\n\t\tconst dshForgeRest = (transformed.sections || []).filter((s) => !String(s && s.name || \"\").startsWith(\"dsh-forge\"));\n\t\tif (completeSection === void 0 && !runtimeContextSuppressed) return { ...transformed, sections: [...dshForgeSections, ...dshForgeRest] }; // [dsh-forge] fold-complete inject first\n\t\treturn {\n\t\t\t...transformed,\n\t\t\tsections: completeSection === void 0 ? [...dshForgeSections, ...dshForgeRest] : (function (complete, forge, rest, assembled) {\n\t\t\t\tconst name = String(complete && complete.name || \"\");\n\t\t\t\tconst after = (assembled || []).find((s) => String(s && s.name || \"\") === name);\n\t\t\t\tconst base = after ? { ...after } : { ...complete };\n\t\t\t\tconst tail = rest.filter((s) => String(s?.name || \"\") !== name);\n\t\t\t\treturn [...forge, base, ...tail]; // [dsh-forge] fold-complete inject first\n\t\t\t})(completeSection, dshForgeSections, dshForgeRest, transformed.sections),\n\t\t\tcontexts: runtimeContextSuppressed ? [] : transformed.contexts\n\t\t};"
      },
      {
        "pattern": "\t\tconst transformed = await this.ctx.waterfall(scopeTarget(this, scope), \"system-prompt/assemble\", assembly, context, () => Promise.resolve(assembly));\n\t\tconst dshForgeSections = (transformed.sections || []).filter((s) => String(s && s.name || \"\").startsWith(\"dsh-forge\") && String(s.text || \"\").length > 0);\n\t\tconst dshForgeRest = (transformed.sections || []).filter((s) => !String(s && s.name || \"\").startsWith(\"dsh-forge\"));\n\t\tif (completeSection === void 0 && !runtimeContextSuppressed) return { ...transformed, sections: [...dshForgeRest, ...dshForgeSections] }; // [dsh-forge] inject last after closer\n\t\treturn {\n\t\t\t...transformed,\n\t\t\tsections: completeSection === void 0 ? [...dshForgeRest, ...dshForgeSections] : (function (complete, forge, rest, assembled) {\n\t\t\t\tconst name = String(complete && complete.name || \"\");\n\t\t\t\tconst after = (assembled || []).find((s) => String(s && s.name || \"\") === name);\n\t\t\t\tconst base = after ? { ...after } : { ...complete };\n\t\t\t\tconst tail = rest.filter((s) => String(s?.name || \"\") !== name);\n\t\t\t\treturn [...tail, base, ...forge]; // [dsh-forge] inject last after closer\n\t\t\t})(completeSection, dshForgeSections, dshForgeRest, transformed.sections),\n\t\t\tcontexts: runtimeContextSuppressed ? [] : transformed.contexts\n\t\t};",
        "replace": "\t\tconst transformed = await this.ctx.waterfall(scopeTarget(this, scope), \"system-prompt/assemble\", assembly, context, () => Promise.resolve(assembly));\n\t\tconst dshForgeSections = (transformed.sections || []).filter((s) => String(s && s.name || \"\").startsWith(\"dsh-forge\") && String(s.text || \"\").length > 0);\n\t\tconst dshForgeRest = (transformed.sections || []).filter((s) => !String(s && s.name || \"\").startsWith(\"dsh-forge\"));\n\t\tif (completeSection === void 0 && !runtimeContextSuppressed) return { ...transformed, sections: [...dshForgeSections, ...dshForgeRest] }; // [dsh-forge] fold-complete inject first\n\t\treturn {\n\t\t\t...transformed,\n\t\t\tsections: completeSection === void 0 ? [...dshForgeSections, ...dshForgeRest] : (function (complete, forge, rest, assembled) {\n\t\t\t\tconst name = String(complete && complete.name || \"\");\n\t\t\t\tconst after = (assembled || []).find((s) => String(s && s.name || \"\") === name);\n\t\t\t\tconst base = after ? { ...after } : { ...complete };\n\t\t\t\tconst tail = rest.filter((s) => String(s?.name || \"\") !== name);\n\t\t\t\treturn [...forge, base, ...tail]; // [dsh-forge] fold-complete inject first\n\t\t\t})(completeSection, dshForgeSections, dshForgeRest, transformed.sections),\n\t\t\tcontexts: runtimeContextSuppressed ? [] : transformed.contexts\n\t\t};"
      },
      {
        "pattern": "\t\tconst transformed = await this.ctx.waterfall(scopeTarget(this, scope), \"system-prompt/assemble\", assembly, context, () => Promise.resolve(assembly));\n\t\tconst dshForgeSections = (transformed.sections || []).filter((s) => String(s && s.name || \"\").startsWith(\"dsh-forge\") && String(s.text || \"\").length > 0);\n\t\tconst dshForgeRest = (transformed.sections || []).filter((s) => !String(s && s.name || \"\").startsWith(\"dsh-forge\"));\n\t\tif (completeSection === void 0 && !runtimeContextSuppressed) return { ...transformed, sections: [...dshForgeSections, ...dshForgeRest] }; // [dsh-forge] every mode keeps system inject\n\t\treturn {\n\t\t\t...transformed,\n\t\t\tsections: completeSection === void 0 ? [...dshForgeSections, ...dshForgeRest] : (function (complete, forge, rest, assembled) {\n\t\t\t\tconst name = String(complete && complete.name || \"\");\n\t\t\t\tconst after = (assembled || []).find((s) => String(s && s.name || \"\") === name);\n\t\t\t\tconst base = after ? { ...after } : { ...complete };\n\t\t\t\tconst tail = rest.filter((s) => String(s?.name || \"\") !== name);\n\t\t\t\treturn [...forge, ...tail, base]; // [dsh-forge] complete prompt keeps inject + assembled complete\n\t\t\t})(completeSection, dshForgeSections, dshForgeRest, transformed.sections),\n\t\t\tcontexts: runtimeContextSuppressed ? [] : transformed.contexts\n\t\t};",
        "replace": "\t\tconst transformed = await this.ctx.waterfall(scopeTarget(this, scope), \"system-prompt/assemble\", assembly, context, () => Promise.resolve(assembly));\n\t\tconst dshForgeSections = (transformed.sections || []).filter((s) => String(s && s.name || \"\").startsWith(\"dsh-forge\") && String(s.text || \"\").length > 0);\n\t\tconst dshForgeRest = (transformed.sections || []).filter((s) => !String(s && s.name || \"\").startsWith(\"dsh-forge\"));\n\t\tif (completeSection === void 0 && !runtimeContextSuppressed) return { ...transformed, sections: [...dshForgeSections, ...dshForgeRest] }; // [dsh-forge] fold-complete inject first\n\t\treturn {\n\t\t\t...transformed,\n\t\t\tsections: completeSection === void 0 ? [...dshForgeSections, ...dshForgeRest] : (function (complete, forge, rest, assembled) {\n\t\t\t\tconst name = String(complete && complete.name || \"\");\n\t\t\t\tconst after = (assembled || []).find((s) => String(s && s.name || \"\") === name);\n\t\t\t\tconst base = after ? { ...after } : { ...complete };\n\t\t\t\tconst tail = rest.filter((s) => String(s?.name || \"\") !== name);\n\t\t\t\treturn [...forge, base, ...tail]; // [dsh-forge] fold-complete inject first\n\t\t\t})(completeSection, dshForgeSections, dshForgeRest, transformed.sections),\n\t\t\tcontexts: runtimeContextSuppressed ? [] : transformed.contexts\n\t\t};"
      },
      {
        "pattern": "\t\tconst transformed = await this.ctx.waterfall(scopeTarget(this, scope), \"system-prompt/assemble\", assembly, context, () => Promise.resolve(assembly));\n\t\tconst dshForgeSections = (transformed.sections || []).filter((s) => String(s && s.name || \"\").startsWith(\"dsh-forge\") && String(s.text || \"\").length > 0);\n\t\tconst dshForgeRest = (transformed.sections || []).filter((s) => !String(s && s.name || \"\").startsWith(\"dsh-forge\"));\n\t\tif (completeSection === void 0 && !runtimeContextSuppressed) return { ...transformed, sections: [...dshForgeRest, ...dshForgeSections] }; // [dsh-forge] inject last after closer\n\t\treturn {\n\t\t\t...transformed,\n\t\t\tsections: completeSection === void 0 ? [...dshForgeRest, ...dshForgeSections] : (function (complete, forge, rest) {\n\t\t\t\tconst base = { ...complete };\n\t\t\t\tconst tail = rest.filter((s) => String(s?.name || \"\") !== String(base.name || \"\"));\n\t\t\t\treturn [...tail, base, ...forge]; // [dsh-forge] inject last after closer\n\t\t\t})(completeSection, dshForgeSections, dshForgeRest),\n\t\t\tcontexts: runtimeContextSuppressed ? [] : transformed.contexts\n\t\t};",
        "replace": "\t\tconst transformed = await this.ctx.waterfall(scopeTarget(this, scope), \"system-prompt/assemble\", assembly, context, () => Promise.resolve(assembly));\n\t\tconst dshForgeSections = (transformed.sections || []).filter((s) => String(s && s.name || \"\").startsWith(\"dsh-forge\") && String(s.text || \"\").length > 0);\n\t\tconst dshForgeRest = (transformed.sections || []).filter((s) => !String(s && s.name || \"\").startsWith(\"dsh-forge\"));\n\t\tif (completeSection === void 0 && !runtimeContextSuppressed) return { ...transformed, sections: [...dshForgeSections, ...dshForgeRest] }; // [dsh-forge] fold-complete inject first\n\t\treturn {\n\t\t\t...transformed,\n\t\t\tsections: completeSection === void 0 ? [...dshForgeSections, ...dshForgeRest] : (function (complete, forge, rest, assembled) {\n\t\t\t\tconst name = String(complete && complete.name || \"\");\n\t\t\t\tconst after = (assembled || []).find((s) => String(s && s.name || \"\") === name);\n\t\t\t\tconst base = after ? { ...after } : { ...complete };\n\t\t\t\tconst tail = rest.filter((s) => String(s?.name || \"\") !== name);\n\t\t\t\treturn [...forge, base, ...tail]; // [dsh-forge] fold-complete inject first\n\t\t\t})(completeSection, dshForgeSections, dshForgeRest, transformed.sections),\n\t\t\tcontexts: runtimeContextSuppressed ? [] : transformed.contexts\n\t\t};"
      }
    ],
    "markers": [
      "fold-complete inject first"
    ],
    "forbid": [
      "dsh-forge:committed"
    ]
  },
  {
    "id": 89,
    "name": "SYSTEM_MESSAGE_CONTRACT",
    "layer": "代码",
    "layer_en": "Code",
    "desc": "保留原生 system 消息及更新顺序，修复旧提取补丁造成的提示词丢失 / preserve native system messages and update ordering",
    "file": [
      "agent-loop"
    ],
    "optional": true,
    "skipIfMarked": true,
    "replacements": [
      {
        "pattern": "\t\tconst boundaryMessages = session.deriveMessages(); // [dsh-forge-89] system field extract\n\t\tconst systemParts = [];\n\t\tconst nonSystemMessages = [];\n\t\tfor (const message of boundaryMessages) {\n\t\t\tif (message && message.role === \"system\") {\n\t\t\t\tconst content = message.content;\n\t\t\t\tif (Array.isArray(content)) {\n\t\t\t\t\tfor (const block of content) {\n\t\t\t\t\t\tif (block && block.type === \"text\" && typeof block.text === \"string\" && block.text.length > 0) {\n\t\t\t\t\t\t\tsystemParts.push(block.text);\n\t\t\t\t\t\t}\n\t\t\t\t\t}\n\t\t\t\t} else if (typeof content === \"string\" && content.length > 0) {\n\t\t\t\t\tsystemParts.push(content);\n\t\t\t\t}\n\t\t\t} else {\n\t\t\t\tnonSystemMessages.push(message);\n\t\t\t}\n\t\t}\n\t\tconst systemField = systemParts.length > 0 ? systemParts.join(\"\\n\\n\") : void 0;\n\t\tfor (const message of nonSystemMessages) {\n\t\t\tif (this.frozenMessages.has(message)) continue;\n\t\t\tdeepFreeze(message);\n\t\t\tthis.frozenMessages.add(message);\n\t\t}\n\t\tObject.freeze(nonSystemMessages);\n\t\treturn markAgentLoopRequest(Object.freeze({\n\t\t\t...header.config,\n\t\t\t...systemField !== void 0 ? { system: systemField } : {},\n\t\t\tmessages: nonSystemMessages,\n\t\t\ttoolHistory: session.toolHistory(),\n\t\t\t...header.tools !== void 0 ? { tools: header.tools } : {},\n\t\t\tsessionId: this.session.id,\n\t\t\tsignal\n\t\t}));",
        "replace": "\t\tconst boundaryMessages = session.deriveMessages(); // [dsh-forge-89] native system messages preserved\n\t\tfor (const message of boundaryMessages) {\n\t\t\tif (this.frozenMessages.has(message)) continue;\n\t\t\tdeepFreeze(message);\n\t\t\tthis.frozenMessages.add(message);\n\t\t}\n\t\tObject.freeze(boundaryMessages);\n\t\treturn markAgentLoopRequest(Object.freeze({\n\t\t\t...header.config,\n\t\t\tmessages: boundaryMessages,\n\t\t\ttoolHistory: session.toolHistory(),\n\t\t\t...header.tools !== void 0 ? { tools: header.tools } : {},\n\t\t\tsessionId: this.session.id,\n\t\t\tsignal\n\t\t}));"
      },
      {
        "pattern": "\t\tconst boundaryMessages = session.deriveMessages();\n\t\tfor (const message of boundaryMessages) {\n\t\t\tif (this.frozenMessages.has(message)) continue;\n\t\t\tdeepFreeze(message);\n\t\t\tthis.frozenMessages.add(message);\n\t\t}\n\t\tObject.freeze(boundaryMessages);\n\t\treturn markAgentLoopRequest(Object.freeze({\n\t\t\t...header.config,\n\t\t\tmessages: boundaryMessages,\n\t\t\ttoolHistory: session.toolHistory(),\n\t\t\t...header.tools !== void 0 ? { tools: header.tools } : {},\n\t\t\tsessionId: this.session.id,\n\t\t\tsignal\n\t\t}));",
        "replace": "\t\tconst boundaryMessages = session.deriveMessages(); // [dsh-forge-89] native system messages preserved\n\t\tfor (const message of boundaryMessages) {\n\t\t\tif (this.frozenMessages.has(message)) continue;\n\t\t\tdeepFreeze(message);\n\t\t\tthis.frozenMessages.add(message);\n\t\t}\n\t\tObject.freeze(boundaryMessages);\n\t\treturn markAgentLoopRequest(Object.freeze({\n\t\t\t...header.config,\n\t\t\tmessages: boundaryMessages,\n\t\t\ttoolHistory: session.toolHistory(),\n\t\t\t...header.tools !== void 0 ? { tools: header.tools } : {},\n\t\t\tsessionId: this.session.id,\n\t\t\tsignal\n\t\t}));"
      }
    ],
    "markers": [
      "[dsh-forge-89] native system messages preserved"
    ],
    "forbid": [
      "[dsh-forge-89] system field extract"
    ]
  },
  {
    "id": 92,
    "name": "SUBAGENT_SAME_INJECT_PATH",
    "layer": "代码",
    "layer_en": "Code",
    "desc": "子代理创建时立刻挂 assemble 注入，并继承父会话权限 / wrap child assemble at spawn and inherit parent permission preset",
    "file": [
      "subagent",
      "subagent-types"
    ],
    "optional": true,
    "skipIfMarked": true,
    "replacements": [
      {
        "pattern": "\tif (composition.toolFilter !== void 0) childCtx.tools.restrict(composition.toolFilter);\n}",
        "replace": "\tif (composition.toolFilter !== void 0) childCtx.tools.restrict(composition.toolFilter);\n\ttry {\n\t\tconst prepare = globalThis.__dshForgePrepareAssemble;\n\t\tif (typeof prepare === \"function\") prepare(childCtx);\n\t} catch {}\n} // [dsh-forge-92] child assemble same as parent"
      },
      {
        "pattern": "    if (composition.toolFilter !== undefined)\n        childCtx.tools.restrict(composition.toolFilter);\n}",
        "replace": "    if (composition.toolFilter !== undefined)\n        childCtx.tools.restrict(composition.toolFilter);\n    try {\n        const prepare = globalThis.__dshForgePrepareAssemble;\n        if (typeof prepare === \"function\") prepare(childCtx);\n    } catch {}\n} // [dsh-forge-92] child assemble same as parent"
      }
    ],
    "markers": [
      "[dsh-forge-92] child assemble same as parent"
    ]
  },
  {
    "id": 93,
    "name": "HIDE_WORKER_PRESETS",
    "layer": "代码",
    "layer_en": "Code",
    "desc": "执行角色预设（*-worker）不进新建会话下拉与预设管理页 / hide subagent-only presets from pickers",
    // 背景：spawn 只认预设 id，所以 redteam-worker / crack-worker 必须注册；
    // 而 dsh 的 PresetDefinition 没有 hidden 字段，选择器只过滤 broken，
    // 注册即出现在用户能点到的地方。手动选用是降级会话（无指挥人格、不能派活、
    // 也不注入角色稿），只能在 UI 层隐藏。
    "file": [
      "agent-preset-client"
    ],
    "optional": true,
    "skipIfMarked": true,
    "replacements": [
      {
        // 新建会话下拉 / 标题栏标签：presetOptions 决定 options。
        "pattern": "return presets.filter((preset) => preset.broken === void 0).map((preset) => ({",
        "replace": "return presets.filter((preset) => preset.broken === void 0 && !/^(?:redteam|crack)-worker$/.test(preset.id)).map((preset) => ({ // [dsh-forge-93] worker presets are subagent-only"
      },
      {
        // 设置 → Agent 预设：完整 roster 在这里分组渲染，还能「设为默认」。
        "pattern": "const rows = state.rows.filter((row) => isBuiltInPreset(row) === builtIn && (developerTools || !requiresCodingTools(row)));",
        "replace": "const rows = state.rows.filter((row) => isBuiltInPreset(row) === builtIn && !/^(?:redteam|crack)-worker$/.test(row.id) && (developerTools || !requiresCodingTools(row))); // [dsh-forge-93] worker presets are subagent-only"
      }
    ],
    "markers": [
      "[dsh-forge-93] worker presets are subagent-only"
    ],
    "markersAny": true
  },
  {
    "id": 94,
    "name": "PRUNE_STALE_AUTH_COOKIES",
    "layer": "运行",
    "layer_en": "Code",
    "desc": "启动前清理残留 dsh-auth cookie，避免 Cookie 头超 16KB 导致 431 / 欢迎握手失败",
    // 背景（2026-10-28 真机事故）：桌面壳每次启动都会为 127.0.0.1:<新端口> 换发一枚
    // dsh-auth-* cookie（HttpOnly / SameSite=Strict），旧端口的那枚永不过期也不回收。
    // 约 70 次重启后 Cookie 请求头到 16.1KB，加上其他头就超过 Node 默认 maxHeaderSize
    // 16384，Host 直接回 431，壳的 net.fetch 拿不到 2xx，于是
    // "desktop welcome: Web authentication failed" 并把 Host 关掉（看起来像启动崩溃）。
    // 这里在欢迎握手前把旧 dsh-auth-* 全部删掉，握手会立刻换发新的。
    "file": [
      "desktop-shell"
    ],
    "surfaces": [
      "desktop"
    ],
    "optional": true,
    "skipIfMarked": true,
    "replacements": [
      {
        "pattern": "\t\t\t\twelcomeBackend = await connectDesktopWelcome(ready.url, (input, init) => net.fetch(input, init), async () => (await session.defaultSession.cookies.get({ url: ready.url })).map((cookie) => `${cookie.name}=${cookie.value}`).join(\"; \"));",
        "replace": "\t\t\t\t// [dsh-forge-94] prune stale dsh-auth cookies before the welcome handshake\n" +
          "\t\t\t\ttry {\n" +
          "\t\t\t\t\tconst dshForgeStale = await session.defaultSession.cookies.get({ url: ready.url });\n" +
          "\t\t\t\t\tfor (const dshForgeCookie of dshForgeStale) {\n" +
          "\t\t\t\t\t\tif (dshForgeCookie.name.indexOf(\"dsh-auth-\") === 0) await session.defaultSession.cookies.remove(ready.url, dshForgeCookie.name);\n" +
          "\t\t\t\t\t}\n" +
          "\t\t\t\t} catch {}\n" +
          "\t\t\t\twelcomeBackend = await connectDesktopWelcome(ready.url, (input, init) => net.fetch(input, init), async () => (await session.defaultSession.cookies.get({ url: ready.url })).map((cookie) => `${cookie.name}=${cookie.value}`).join(\"; \"));"
      }
    ],
    "markers": [
      "[dsh-forge-94] prune stale dsh-auth cookies before the welcome handshake"
    ]
  },
];
