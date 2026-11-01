/**
 * 从宿主解析 `@deepseek-ai/dsh-tools` 的 defineTool。
 *
 * 破解模块不在 profile 的 node_modules 树里时，静态 import 会解析失败；
 * 这里按已知安装位置逐个探测。rea-tools / case-tools 共用这一份。
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

function pick(mod) {
  const fn = mod && (mod.defineTool || (mod.default && mod.default.defineTool))
  return typeof fn === 'function' ? fn : null
}

export function loadDefineTool() {
  /* 1) 本模块自己的 node_modules 链（profile junction 正常时就走这里）。 */
  try {
    const fn = pick(createRequire(import.meta.url)('@deepseek-ai/dsh-tools'))
    if (fn) return fn
  } catch { /* 继续找 */ }

  /* 2) 插件被链接/复制到别处时，按已知宿主安装位置逐个试探。 */
  const anchors = []
  const pushAnchor = (p) => { if (p && !anchors.includes(p)) anchors.push(p) }
  const addChain = (start, depth) => {
    let dir = start ? dirname(start) : ''
    for (let i = 0; i < depth && dir; i += 1) {
      pushAnchor(dir)
      const up = dirname(dir)
      if (up === dir) break
      dir = up
    }
  }
  for (const home of [process.env.DSH_HOME, join(homedir(), '.dsh')].filter(Boolean)) {
    pushAnchor(home)
    for (const profile of ['web', 'desktop', 'default']) pushAnchor(join(home, 'profiles', profile))
  }
  pushAnchor(process.cwd())
  addChain(process.execPath, 6)
  addChain(process.resourcesPath, 5)

  for (const anchor of anchors) {
    try {
      const fn = pick(createRequire(join(anchor, 'package.json'))('@deepseek-ai/dsh-tools'))
      if (fn) return fn
    } catch { /* next */ }
    for (const entry of [
      join(anchor, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
      join(anchor, 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
      join(anchor, 'resources', 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
    ]) {
      try {
        if (!existsSync(entry)) continue
        const fn = pick(createRequire(entry)(entry))
        if (fn) return fn
      } catch { /* next */ }
    }
  }
  throw new Error('dsh-forge/crack: cannot resolve @deepseek-ai/dsh-tools from host')
}
