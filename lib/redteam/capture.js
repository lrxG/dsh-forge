/**
 * 网页证据截图：用本机 Chrome / Edge 的无头模式截一张图，交给 store 入库。
 *
 * 为什么不做桌面截图：桌面要靠 Win32 抢前台窗口，会打断用户，还容易拍到
 * 聊天窗口/其他客户资料。这里只做「网页」和「登记已有文件」两种。
 *
 * 实现要点：
 *   · 每次用独立 `--user-data-dir`，否则会和用户正在开的 Chrome 抢 profile；
 *   · `--virtual-time-budget` 等 JS 渲染完再截；
 *   · 输出路径由调用方给绝对路径，参数走数组，不拼 shell。
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WIN_CANDIDATES = [
  process.env.DSH_CAPTURE_BROWSER || '',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)

const NIX_CANDIDATES = [
  process.env.DSH_CAPTURE_BROWSER || '',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
].filter(Boolean)

/** 找一个可用的 Chrome / Edge；找不到就返回空字符串。 */
export function findCaptureBrowser() {
  const list = process.platform === 'win32' ? WIN_CANDIDATES : NIX_CANDIDATES
  for (const fp of list) {
    try {
      if (existsSync(fp)) return fp
    } catch { /* ignore */ }
  }
  return ''
}

/**
 * 截一张网页。
 * @param {object} opts
 * @param {string} opts.url - http/https 地址。
 * @param {string} opts.out - 输出 PNG 的绝对路径。
 * @param {number} [opts.width] - 视口宽，默认 1440。
 * @param {number} [opts.height] - 视口高，默认 900。
 * @param {number} [opts.waitMs] - 等渲染的虚拟时间，默认 2500ms。
 * @param {boolean} [opts.fullPage] - true 时把视口加高，截长页。
 * @param {number} [opts.timeoutMs] - 进程超时，默认 45s。
 * @returns {Promise<{path:string, engine:string, width:number, height:number}>}
 */
export function captureWeb(opts = {}) {
  const url = String(opts.url || '').trim()
  const out = String(opts.out || '').trim()
  if (!/^https?:\/\//i.test(url)) return Promise.reject(new Error('只支持 http/https URL'))
  if (!out) return Promise.reject(new Error('缺少输出路径'))
  const exe = findCaptureBrowser()
  if (!exe) return Promise.reject(new Error('找不到 Chrome / Edge，无法自动截图（可设 DSH_CAPTURE_BROWSER）'))

  const width = Math.max(320, Math.min(4096, Number(opts.width) || 1440))
  const baseH = Math.max(320, Math.min(4096, Number(opts.height) || 900))
  const height = opts.fullPage === true ? Math.max(baseH, 2200) : baseH
  const wait = Math.max(500, Math.min(15000, Number(opts.waitMs) || 2500))
  const timeout = Math.max(5000, Math.min(120000, Number(opts.timeoutMs) || 45000))

  const profile = mkdtempSync(join(tmpdir(), 'dsh-forge-capture-'))
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    `--virtual-time-budget=${wait}`,
    `--screenshot=${out}`,
    url,
  ]

  return new Promise((resolve, reject) => {
    execFile(exe, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, _stdout, stderr) => {
      try { rmSync(profile, { recursive: true, force: true }) } catch { /* 临时目录清不掉不影响结果 */ }
      if (err) {
        const detail = String(stderr || err.message || err).trim().slice(0, 300)
        reject(new Error('截图失败：' + (detail || '进程退出异常')))
        return
      }
      if (!existsSync(out)) {
        reject(new Error('截图命令结束但没有生成文件（页面可能加载超时）'))
        return
      }
      resolve({ path: out, engine: exe, width: width, height: height })
    })
  })
}
