// One-off DOM probe: locate the bottom-left anchor area and every data-* hook
// the shell exposes, so the gateway can place its controls where the UI already
// has a home for them instead of floating over the composer.
//
// usage: node verify/probe-dom.mjs [--from-auth gateway/auth.json] [--password <pw>]
import { spawn } from 'node:child_process'
import { defaultUrl, findBrowser } from './_env.mjs'
import { createHmac } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const PORT = 9334
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

const argv = process.argv.slice(2)
const argOf = (name, fallback = '') => {
  const at = argv.indexOf(name)
  return at === -1 ? fallback : (argv[at + 1] ?? fallback)
}
const url = argOf('--url', defaultUrl())
const authPath = argOf('--from-auth', '')
const password = argOf('--password', '')
const width = Number(argOf('--width', '390'))
const height = Number(argOf('--height', '844'))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function session() {
  const base = new URL(url)
  if (authPath !== '') {
    const auth = JSON.parse(readFileSync(authPath, 'utf8'))
    const expiresAt = Date.now() + 3_600_000
    const signature = createHmac('sha256', Buffer.from(auth.sessionKey, 'base64')).update(`dshgw.${String(expiresAt)}`).digest('base64url')
    return { origin: base.origin, host: base.hostname, value: `${String(expiresAt)}.${signature}` }
  }
  const response = await fetch(`${base.origin}/_gw/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password, next: '/' }).toString(),
    redirect: 'manual',
  })
  const raw = response.headers.getSetCookie().find((value) => value.startsWith('dshgw='))
  if (raw === undefined) throw new Error(`login failed: HTTP ${String(response.status)}`)
  return { origin: base.origin, host: base.hostname, value: raw.split(';')[0].slice('dshgw='.length) }
}

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 0
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    })
  }

  static connect(target) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(target)
      socket.addEventListener('open', () => resolve(new Cdp(socket)))
      socket.addEventListener('error', () => reject(new Error('cannot connect')))
    })
  }

  send(method, params = {}) {
    const id = (this.nextId += 1)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
      setTimeout(() => reject(new Error(`timeout ${method}`)), 30_000)
    })
  }
}

const PROBE = `(() => {
  const info = (element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      tag: element.tagName.toLowerCase(),
      slot: element.getAttribute('data-slot') || '',
      aria: element.getAttribute('aria-label') || '',
      text: (element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 32),
      x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height),
      display: style.display, position: style.position,
    };
  };
  const pick = (selector) => [...document.querySelectorAll(selector)].map(info);
  return JSON.stringify({
    slots: pick('[data-slot]'),
    composerDock: pick('[data-composer-dock]'),
    composerSeat: pick('[data-composer-seat]'),
    shellBottom: pick('[data-shell-bottom]'),
    shellLeading: pick('[data-shell-leading]'),
    sidebarOpener: pick('[data-sidebar-opener]'),
    dshBottomToggle: pick('[data-dsh-bottom-toggle]'),
    dockChildren: [...document.querySelectorAll('[data-composer-dock] > *, [data-composer-seat] > *')].map(info),
  }, null, 2);
})()`
async function main() {
  const sessionInfo = await session()
  const profile = join(ROOT, 'artifacts', `.edge-probe-${String(Date.now())}`)
  mkdirSync(profile, { recursive: true })
  const edge = spawn(findBrowser(), ['--headless=new', `--remote-debugging-port=${String(PORT)}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore', windowsHide: true })
  let cdp
  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${String(PORT)}/json/version`, { signal: AbortSignal.timeout(800) })
        if (response.ok) break
      } catch { /* wait */ }
      await sleep(250)
    }
    const created = await fetch(`http://127.0.0.1:${String(PORT)}/json/new?about:blank`, { method: 'PUT' })
    const target = await created.json()
    cdp = await Cdp.connect(target.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Network.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true, screenWidth: width, screenHeight: height })
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: UA })
    await cdp.send('Network.setCookie', { name: 'dshgw', value: sessionInfo.value, domain: sessionInfo.host, path: '/', httpOnly: true })
    await cdp.send('Page.navigate', { url: `${sessionInfo.origin}/` })
    await sleep(6000)
    const result = await cdp.send('Runtime.evaluate', { expression: PROBE, returnByValue: true })
    console.log(result.result.value)
  } finally {
    try { cdp?.socket.close() } catch { /* ignore */ }
    edge.kill()
  }
}

await main()
