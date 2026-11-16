// Reproduce the session rename flow on a phone viewport and measure where the
// context menu / rename field land. Used to decide whether the gateway's panel
// follower is pulling the wrong overlay into place.
//
// usage: node verify/probe-rename.mjs [--width 390 --height 844]
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultUrl, findBrowser, ROOT_DIR } from './_env.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = 9338
const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const at = argv.indexOf(name)
  return at === -1 ? fallback : (argv[at + 1] ?? fallback)
}
const url = argOf('--url', defaultUrl())
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

const DISMISS = `(() => {
  let acted = 0;
  for (const box of document.querySelectorAll('input[type=checkbox]')) {
    if (!box.checked) { box.click(); acted += 1 }
  }
  for (const button of document.querySelectorAll('button, [role=button]')) {
    const style = getComputedStyle(button);
    const rect = button.getBoundingClientRect();
    if (button.disabled || rect.width === 0 || style.visibility === 'hidden') continue;
    if (button.getAttribute('role') === 'menuitem') continue;
    const text = (button.textContent || '').trim();
    if (text === '' || text.length > 24) continue;
    if (button.closest('[role=dialog]') !== null || button.closest('[data-portal]') !== null) { button.click(); acted += 1; break }
  }
  return acted;
})()`

const EXPAND_SIDEBAR = `(() => {
  const toggle = document.querySelector('[data-sidebar-toggle]');
  if (!toggle) return 'no-toggle';
  if (document.documentElement.hasAttribute('data-sidebar-expanded')) return 'already';
  toggle.click();
  return 'expanded';
})()`

const FIND_TRIGGERS = `(() => {
  const rows = [...document.querySelectorAll('[data-row-key^="session:"]')].slice(0, 3);
  const triggers = [...document.querySelectorAll('[data-context-menu-trigger]')].slice(0, 6).map((element) => {
    const rect = element.getBoundingClientRect();
    return { tag: element.tagName.toLowerCase(), aria: element.getAttribute('aria-label') ?? '', text: (element.textContent || '').trim().slice(0, 12), rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) } };
  });
  return JSON.stringify({ rows: rows.map((row) => (row.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24)), triggers }, null, 2);
})()`

const SCROLL_SIDEBAR = `(() => {
  const scroller = document.querySelector('[data-sidebar-scrollport]') ?? document.querySelector('[data-sidebar-list-area]')?.parentElement;
  if (!scroller) return 'no-scroller';
  scroller.scrollTop = scroller.scrollHeight;
  return 'scrolled to ' + String(Math.round(scroller.scrollTop)) + ' / ' + String(Math.round(scroller.scrollHeight));
})()`

const OPEN_ROW_MENU = `(() => {
  const triggers = [...document.querySelectorAll('[data-context-menu-trigger]')].filter((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.top > 0 && rect.bottom < window.innerHeight;
  });
  const trigger = triggers[triggers.length - 1];
  if (!trigger) return 'no-visible-trigger';
  const rect = trigger.getBoundingClientRect();
  const options = { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) trigger.dispatchEvent(new MouseEvent(type, options));
  return 'clicked trigger at y=' + String(Math.round(rect.top)) + ' (' + (trigger.getAttribute('aria-label') || '') + ')';
})()`

const PANELS = `(() => {
  const describe = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role'),
      anchorSide: element.getAttribute('data-anchor-side'),
      text: (element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
      rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
      display: style.display,
      position: style.position,
      inlineTop: element.style.getPropertyValue('top'),
      inlineLeft: element.style.getPropertyValue('left'),
      placed: element.dataset.dshgwPositioned ?? '',
    };
  };
  const panels = [...document.querySelectorAll('[role=menu], [role=dialog], [role=tooltip], [data-anchor-side]')].map(describe);
  const inputs = [...document.querySelectorAll('input[type=text], input:not([type])')].map((element) => {
    const rect = element.getBoundingClientRect();
    return { rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) }, value: element.value ?? '' };
  });
  return JSON.stringify({ viewport: [window.innerWidth, window.innerHeight], panels, inputs }, null, 2);
})()`

const CLICK_RENAME = `(() => {
  const item = [...document.querySelectorAll('[role=menuitem]')].find((element) => (element.textContent || '').includes('重命名'));
  if (!item) return 'no-rename-item: ' + [...document.querySelectorAll('[role=menuitem]')].map((element) => (element.textContent || '').trim()).join('|');
  item.click();
  return 'clicked rename';
})()`

async function main() {
  const profile = join(ROOT_DIR, 'artifacts', `.edge-rename-${String(Date.now())}`)
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
      const dismissed = await cdp.evaluate(DISMISS)
      await sleep(700)
      if (Number(dismissed) === 0) break
    }

    console.log('--- expand sidebar ---')
    console.log(await cdp.evaluate(EXPAND_SIDEBAR))
    await sleep(1200)
    console.log('--- scroll sidebar to the bottom ---')
    console.log(await cdp.evaluate(SCROLL_SIDEBAR))
    await sleep(600)
    console.log('--- rows and menu triggers ---')
    console.log(await cdp.evaluate(FIND_TRIGGERS))

    console.log('--- open row context menu ---')
    console.log(await cdp.evaluate(OPEN_ROW_MENU))
    await sleep(900)
    console.log(await cdp.evaluate(PANELS))

    console.log('--- click rename ---')
    console.log(await cdp.evaluate(CLICK_RENAME))
    await sleep(900)
    console.log(await cdp.evaluate(PANELS))

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const file = join(ROOT_DIR, 'artifacts', 'rename-390.png')
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    console.log(`screenshot: ${file}`)
  } finally {
    try { cdp?.socket.close() } catch { /* ignore */ }
    edge.kill()
  }
}

await main()
