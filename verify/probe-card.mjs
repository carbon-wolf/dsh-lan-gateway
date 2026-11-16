// Inspect the deliverable card's action buttons (folder + chevron) to find why
// their glyphs sit on different baselines on a phone viewport.
//
// usage: node verify/probe-card.mjs [--open 1]
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultUrl, findBrowser, ROOT_DIR } from './_env.mjs'

const PORT = 9340
const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const at = argv.indexOf(name)
  return at === -1 ? fallback : (argv[at + 1] ?? fallback)
}
const url = argOf('--url', defaultUrl())
const openIndex = Number(argOf('--open', '1'))
const width = Number(argOf('--width', '390'))
const height = Number(argOf('--height', '844'))
const authPath = argOf('--from-auth', join(ROOT_DIR, 'gateway', 'auth.json'))

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

  evaluate(expression) {
    return this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }).then((result) => result.result.value)
  }
}

const PROBE = `(() => {
  const describe = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const centerY = Math.round(rect.top + rect.height / 2);
    return {
      tag: element.tagName.toLowerCase(),
      rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height), centerY },
      display: style.display,
      alignItems: style.alignItems,
      justifyContent: style.justifyContent,
      padding: style.padding,
      lineHeight: style.lineHeight,
      transform: style.transform,
      html: element.outerHTML.replace(/\\s+/g, ' ').slice(0, 180),
    };
  };
  const label = [...document.querySelectorAll('*')].find((element) => element.children.length === 0 && (element.textContent || '').trim() === 'settings-390.png');
  if (!label) return JSON.stringify({ found: false });
  let card = label;
  for (let depth = 0; depth < 8 && card !== null; depth += 1) {
    if (card.querySelectorAll('button').length >= 2) break;
    card = card.parentElement;
  }
  if (card === null) return JSON.stringify({ found: false, reason: 'no buttons' });
  const buttons = [...card.querySelectorAll('button')].slice(-2).map(describe);
  const svgs = [...card.querySelectorAll('button svg')].slice(-4).map((svg) => {
    const rect = svg.getBoundingClientRect();
    return {
      rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height), centerY: Math.round(rect.top + rect.height / 2) },
      parent: describe(svg.parentElement),
    };
  });
  return JSON.stringify({ found: true, card: describe(card), buttons, svgs }, null, 2);
})()`

async function main() {
  const profile = join(ROOT_DIR, 'artifacts', `.edge-card-${String(Date.now())}`)
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
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' })
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await cdp.send('Network.setCookie', { name: 'dshgw', value, domain: base.hostname, path: '/', httpOnly: true })
    await cdp.send('Page.navigate', { url: `${base.origin}/` })
    await sleep(5000)

    for (let round = 0; round < 5; round += 1) {
      await cdp.evaluate(`(() => {
        for (const box of document.querySelectorAll('input[type=checkbox]')) { if (!box.checked) box.click() }
        for (const button of document.querySelectorAll('button, [role=button]')) {
          const rect = button.getBoundingClientRect();
          if (button.disabled || rect.width === 0) continue;
          if (button.closest('[role=dialog]') !== null || button.closest('[data-portal]') !== null) { button.click(); break }
        }
        return 1;
      })()`)
      await sleep(700)
    }

    await cdp.evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-row-key^="session:"]')];
      const target = rows[${String(openIndex)}];
      if (!target) return 'none';
      const rect = target.getBoundingClientRect();
      const options = { bubbles: true, cancelable: true, clientX: rect.left + 24, clientY: rect.top + rect.height / 2 };
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) target.dispatchEvent(new MouseEvent(type, options));
      return 'clicked';
    })()`)
    await sleep(5000)
    await cdp.evaluate(`(() => {
      const scroller = document.querySelector('[data-conversation-scroll]') ?? document.querySelector('[data-conversation-content]');
      if (scroller) scroller.scrollTop = scroller.scrollHeight - 900;
      return 'scrolled';
    })()`)
    await sleep(1500)

    console.log(await cdp.evaluate(PROBE))
  } finally {
    try { cdp?.socket.close() } catch { /* ignore */ }
    edge.kill()
  }
}

await main()
