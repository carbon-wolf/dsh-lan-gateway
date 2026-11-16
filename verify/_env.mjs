// Shared environment lookups for the verification scripts: where the gateway
// listens and which Chromium-family browser to drive.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT_DIR = join(HERE, '..')

/** The gateway's own config, or a sane default when it has not been created yet. */
export function gatewayConfig() {
  try {
    return JSON.parse(readFileSync(join(ROOT_DIR, 'gateway', 'config.json'), 'utf8'))
  } catch {
    return { listenHost: '127.0.0.1', listenPort: 3080 }
  }
}

/** Base URL to drive: the configured address, with 0.0.0.0 folded to loopback. */
export function defaultUrl() {
  const config = gatewayConfig()
  const host = config.listenHost === '0.0.0.0' || config.listenHost === undefined ? '127.0.0.1' : config.listenHost
  return `http://${host}:${String(config.listenPort ?? 3080)}`
}

/**
 * Locate a Chromium-family browser for headless checks.
 * Override with DSHGW_BROWSER=/path/to/msedge.exe.
 */
export function findBrowser() {
  const candidates = [
    process.env.DSHGW_BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '' && existsSync(candidate)) return candidate
  }
  throw new Error('没有找到 Edge/Chrome。设置环境变量 DSHGW_BROWSER 指向浏览器可执行文件后重试。')
}
