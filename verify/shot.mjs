// Screenshot any gateway path with a signed session (settings page, login page).
// usage: node verify/shot.mjs --path /_gw/settings --out settings-390.png [--width 390 --height 844]
import { spawn } from 'node:child_process'
import { defaultUrl, findBrowser } from './_env.mjs'
import { createHmac } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const PORT = 9336
const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const at = argv.indexOf(name)
  return at === -1 ? fallback : (argv[at + 1] ?? fallback)
}
const url = argOf('--url', defaultUrl())
const path = argOf('--path', '/_gw/settings')
const out = argOf('--out', 'settings-390.png')
const width = Number(argOf('--width', '390'))
const height = Number(argOf('--height', '844'))
const authPath = argOf('--from-auth', join(ROOT, 'gateway', 'auth.json'))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const auth = JSON.parse(readFileSync(authPath, 'utf8'))
const expiresAt = Date.now() + 3_600_000
const signature = createHmac('sha256', Buffer.from(auth.sessionKey, 'base64')).update(`dshgw.${String(expiresAt)}`).digest('base64url')
const value = `${String(expiresAt)}.${signature}`
const base = new URL(url)

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

async function main() {
  const profile = join(ROOT, 'artifacts', `.edge-shot-${String(Date.now())}`)
  mkdirSync(profile, { recursive: true })
  const edge = spawn(findBrowser(), ['--headless=new', `--remote-debugging-port=${String(PORT)}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore', windowsHide: true })
  let cdp
  try {
    for (let attempt = 0; attempt < 80; attempt += 1) {
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
    await cdp.send('Network.setCookie', { name: 'dshgw', value, domain: base.hostname, path: '/', httpOnly: true })
    await cdp.send('Page.navigate', { url: `${base.origin}${path}` })
    await sleep(2500)
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    const target2 = join(ROOT, 'artifacts', out)
    writeFileSync(target2, Buffer.from(shot.data, 'base64'))
    console.log(`saved ${target2}`)
  } finally {
    try { cdp?.socket.close() } catch { /* ignore */ }
    edge.kill()
  }
}

await main()
