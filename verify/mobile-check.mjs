// Mobile layout + lock-flow check through headless Edge + CDP.
//
// Opens the proxied page at phone metrics, reports horizontal overflow, the
// mobile marker, the dock geometry and the gateway lock button, optionally
// exercises the lock button end to end, and writes screenshots to artifacts/.
//
// usage:
//   node verify/mobile-check.mjs --password <gw password> [--width 390 --height 844]
//   node verify/mobile-check.mjs --from-auth gateway/auth.json [--sidebar] [--test-lock]
import { spawn } from 'node:child_process'
import { defaultUrl, findBrowser } from './_env.mjs'
import { createHmac } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DEVTOOLS_PORT = 9333
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

function parseArgs(argv) {
  const out = {
    width: 390,
    height: 844,
    out: 'mobile-390.png',
    url: defaultUrl(),
    password: process.env.DSHGW_PASSWORD ?? '',
    fromAuth: '',
    sidebar: false,
    testLock: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[index + 1]
    if (key === '--width') { out.width = Number(value); index += 1 } else if (key === '--height') { out.height = Number(value); index += 1 } else if (key === '--out') { out.out = value; index += 1 } else if (key === '--url') { out.url = value; index += 1 } else if (key === '--password') { out.password = value; index += 1 } else if (key === '--from-auth') { out.fromAuth = value; index += 1 } else if (key === '--sidebar') { out.sidebar = true } else if (key === '--test-lock') { out.testLock = true }
  }
  return out
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForDevtools() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(DEVTOOLS_PORT)}/json/version`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) return await response.json()
    } catch {
      // not up yet
    }
    await sleep(250)
  }
  throw new Error('Edge DevTools endpoint did not come up')
}

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 0
    this.pending = new Map()
    this.events = []
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (typeof message.id === 'number' && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error !== undefined) reject(new Error(`${message.error.message}`))
        else resolve(message.result)
        return
      }
      this.events.push(message)
    })
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      socket.addEventListener('open', () => resolve(new Cdp(socket)))
      socket.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)))
    })
  }

  send(method, params = {}, timeoutMs = 30_000) {
    const id = (this.nextId += 1)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        reject(new Error(`CDP timeout: ${method}`))
      }, timeoutMs)
    })
  }

  takeEvents(method) {
    const matches = this.events.filter((event) => event.method === method)
    this.events = this.events.filter((event) => event.method !== method)
    return matches
  }

  close() {
    try { this.socket.close() } catch { /* ignore */ }
  }
}

async function loginCookie(url, password) {
  const base = new URL(url)
  const response = await fetch(`${base.origin}/_gw/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password, next: '/' }).toString(),
    redirect: 'manual',
  })
  if (response.status !== 303) throw new Error(`gateway login failed: HTTP ${String(response.status)}`)
  const raw = response.headers.getSetCookie().find((value) => value.startsWith('dshgw='))
  if (raw === undefined) throw new Error('gateway login returned no session cookie')
  return { origin: base.origin, host: base.hostname, value: raw.split(';')[0].slice('dshgw='.length) }
}

/** Sign a gateway session from gateway/auth.json's hidden key (no password needed). */
function sessionFromAuthFile(url, authPath) {
  const base = new URL(url)
  const auth = JSON.parse(readFileSync(authPath, 'utf8'))
  const expiresAt = Date.now() + 3_600_000
  const signature = createHmac('sha256', Buffer.from(auth.sessionKey, 'base64')).update(`dshgw.${String(expiresAt)}`).digest('base64url')
  return { origin: base.origin, host: base.hostname, value: `${String(expiresAt)}.${signature}` }
}

const PROBE = `(() => {
  const root = document.documentElement;
  const rect = (element) => element === null ? null : (() => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return { w: Math.round(box.width), h: Math.round(box.height), display: style.display, position: style.position };
  })();
  const lockHost = document.getElementById('dshgw-lock');
  const lockButton = lockHost !== null && lockHost.shadowRoot !== null
    ? (lockHost.shadowRoot.querySelector('button[aria-label="锁定并退出网关"]') ?? lockHost.shadowRoot.querySelector('button:last-of-type'))
    : null;
  const settingsButton = lockHost !== null && lockHost.shadowRoot !== null
    ? lockHost.shadowRoot.querySelector('button[aria-label="打开网关设置"]')
    : null;
  const lockRect = lockButton === null ? null : (() => {
    const box = lockButton.getBoundingClientRect();
    return { w: Math.round(box.width), h: Math.round(box.height), x: Math.round(box.left), y: Math.round(box.top), right: Math.round(window.innerWidth - box.right), bottom: Math.round(window.innerHeight - box.bottom), label: lockButton.getAttribute('aria-label'), placement: lockHost.dataset.placement };
  })();
  const dock = document.querySelector('[data-dockkit-host]');
  return JSON.stringify({
    viewport: [window.innerWidth, window.innerHeight],
    overflowX: Math.round(root.scrollWidth - window.innerWidth),
    mobileMarker: root.hasAttribute('data-dsh-mobile'),
    boot: typeof window.__DSH_BOOT__ === 'object',
    dock: rect(dock),
    lockButton: lockRect,
    settingsButton: settingsButton === null ? null : { label: settingsButton.getAttribute('aria-label') },
    textHead: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 140),
  }, null, 2);
})()`

const DISMISS = `(() => {
  let acted = 0;
  for (const box of document.querySelectorAll('input[type=checkbox]')) {
    if (!box.checked) { box.click(); acted += 1 }
  }
  for (const button of document.querySelectorAll('button, [role=button]')) {
    const style = getComputedStyle(button);
    const box = button.getBoundingClientRect();
    if (button.disabled || box.width === 0 || style.visibility === 'hidden') continue;
    const text = (button.textContent || '').trim();
    if (/知晓|继续|同意|知道了|确定|跳过|不再|Accept|Continue|OK|Got it/i.test(text)) { button.click(); acted += 1; break }
  }
  return acted;
})()`

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.password === '' && args.fromAuth === '') throw new Error('pass --password (or DSHGW_PASSWORD) or --from-auth <auth.json>')
  const session = args.fromAuth === '' ? await loginCookie(args.url, args.password) : sessionFromAuthFile(args.url, args.fromAuth)
  console.log(`session ready for ${session.origin} (${args.fromAuth === '' ? 'password' : 'auth.json'})`)

  const profile = join(ROOT, 'artifacts', `.edge-profile-${String(Date.now())}`)
  mkdirSync(profile, { recursive: true })
  const edge = spawn(findBrowser(), [
    '--headless=new',
    `--remote-debugging-port=${String(DEVTOOLS_PORT)}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--disable-features=Translate',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true })

  let cdp
  try {
    await waitForDevtools()
    const created = await fetch(`http://127.0.0.1:${String(DEVTOOLS_PORT)}/json/new?about:blank`, { method: 'PUT' })
    const target = await created.json()
    cdp = await Cdp.connect(target.webSocketDebuggerUrl)

    await cdp.send('Network.enable')
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: args.width, height: args.height, deviceScaleFactor: 2, mobile: true, screenWidth: args.width, screenHeight: args.height })
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA })
    await cdp.send('Network.setCookie', { name: 'dshgw', value: session.value, domain: session.host, path: '/', httpOnly: true })

    await cdp.send('Page.navigate', { url: `${session.origin}/` })
    await sleep(5000)

    let dismissed = 0
    for (let round = 0; round < 6; round += 1) {
      const result = await cdp.send('Runtime.evaluate', { expression: DISMISS, returnByValue: true })
      dismissed += Number(result.result.value ?? 0)
      await sleep(900)
    }
    await sleep(1500)
    if (dismissed > 0) console.log(`dismissed ${String(dismissed)} first-run dialog control(s)`)

    const evaluated = await cdp.send('Runtime.evaluate', { expression: PROBE, returnByValue: true })
    const report = JSON.parse(evaluated.result.value)

    const wsUrls = [...new Set(cdp.takeEvents('Network.webSocketCreated').map((event) => event.params.url))]

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const shotPath = join(ROOT, 'artifacts', args.out)
    writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))

    let sidebarShot = null
    if (args.sidebar) {
      const clicked = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const buttons = [...document.querySelectorAll('button, [role=button]')]
            .filter((element) => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().top < 120);
          if (buttons.length === 0) return 'none';
          const label = buttons[0].getAttribute('aria-label') || buttons[0].title || buttons[0].textContent || '';
          buttons[0].click();
          return label.trim().slice(0, 40);
        })()`,
        returnByValue: true,
      })
      await sleep(1500)
      const image = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      sidebarShot = join(ROOT, 'artifacts', args.out.replace(/\.png$/u, '-sidebar.png'))
      writeFileSync(sidebarShot, Buffer.from(image.data, 'base64'))
      console.log(`sidebar toggle: ${String(clicked.result.value)}`)
    }

    let lockTest = null
    if (args.testLock) {
      const before = await cdp.send('Runtime.evaluate', { expression: 'location.pathname + location.search', returnByValue: true })
      void cdp.send('Runtime.evaluate', {
        expression: `(() => { const host = document.getElementById('dshgw-lock'); const button = host?.shadowRoot?.querySelector('button[aria-label="锁定并退出网关"]'); button?.click(); return button !== null })()`,
        returnByValue: true,
      }, 8000).catch(() => {})
      let dialogsAccepted = 0
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (cdp.takeEvents('Page.javascriptDialogOpening').length > 0) {
          await cdp.send('Page.handleJavaScriptDialog', { accept: true })
          dialogsAccepted += 1
          break
        }
        await sleep(150)
      }
      await sleep(3000)
      const after = await cdp.send('Runtime.evaluate', { expression: 'location.pathname + location.search', returnByValue: true })
      const probeStatus = await fetch(`${session.origin}/`, { redirect: 'manual', headers: { cookie: `dshgw=${session.value}` } })
      lockTest = {
        before: before.result.value,
        dialogsAccepted,
        after: after.result.value,
        gatewayStatusWithLockedCookie: probeStatus.status,
        reachableLockButton: report.lockButton !== null,
      }
    }

    console.log(JSON.stringify({ ...report, webSockets: wsUrls, screenshot: shotPath, sidebarScreenshot: sidebarShot, lockTest }, null, 2))
    if (report.overflowX > 1) console.log(`WARN: horizontal overflow ${String(report.overflowX)}px`)
    if (wsUrls.length === 0) console.log('WARN: no /api websocket observed')
  } finally {
    cdp?.close()
    edge.kill()
  }
}

await main()
