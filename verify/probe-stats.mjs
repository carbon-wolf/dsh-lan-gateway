// Probe the chat footer stats row ("9 turns 290 steps - 122 tok/s", "81.2M tok - cache hit 99%", "43%")
// to learn how its detail popover opens and whether narrow screens keep it.
//
// Locating strategy: bottom-band position + the literal "tok", so a chat message
// quoting the same words never matches. No non-ASCII needles on purpose - these
// probe files must survive any console code page.
//
// usage: node verify/probe-stats.mjs [--width 1440 --height 900] [--open last]
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultUrl, findBrowser, ROOT_DIR } from './_env.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = 9337
const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const at = argv.indexOf(name)
  return at === -1 ? fallback : (argv[at + 1] ?? fallback)
}
const url = argOf('--url', defaultUrl())
const width = Number(argOf('--width', '1440'))
const height = Number(argOf('--height', '900'))
const openIndex = Number(argOf('--open', '0'))
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

// First-run dialogs (third-party plugin notices) block the shell; accept them by
// clicking the visible confirm button, whatever its label language.
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
    if (text === '\\u77e5\\u6653' || text === '\\u7ee7\\u7eed' || text === '\\u540c\\u610f' || text === '\\u786e\\u5b9a') { button.click(); acted += 1; break }
    if (/^(Accept|Continue|OK|Got it|Close|Done)$/i.test(text)) { button.click(); acted += 1; break }
    // Any other short label inside a dialog is the plugin's own confirm button.
    if (button.closest('[role=dialog]') !== null || button.closest('[data-portal]') !== null) { button.click(); acted += 1; break }
  }
  return acted;
})()`

const clickSession = (index) => `(() => {
  const rows = [...document.querySelectorAll('[data-row-key^="session:"]')];
  const target = rows[${String(index)}];
  if (!target) return 'no-session-row:' + String(rows.length);
  const rect = target.getBoundingClientRect();
  const options = { bubbles: true, cancelable: true, clientX: rect.left + 24, clientY: rect.top + rect.height / 2 };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) target.dispatchEvent(new MouseEvent(type, options));
  return 'clicked index ' + String(${String(index)}) + ' of ' + String(rows.length);
})()`

const DESCRIBE = `(element) => {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return {
    tag: element.tagName.toLowerCase(),
    attrs: [...element.attributes]
      .map((attribute) => attribute.name + (attribute.name.startsWith('data-') || attribute.name === 'role' || attribute.name === 'title' ? '=' + attribute.value : ''))
      .filter((text) => text.includes('='))
      .slice(0, 10),
    text: (element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 70),
    rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
    display: style.display,
    visibility: style.visibility,
    opacity: style.opacity,
    cursor: style.cursor,
    descendants: element.querySelectorAll('*').length,
  };
}`

const FOOTER = `(() => {
  const describe = ${DESCRIBE};
  const hits = [...document.querySelectorAll('body *')].filter((element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    if (rect.top < window.innerHeight * 0.72) return false;
    return /tok/i.test(element.textContent || '');
  }).sort((left, right) => left.querySelectorAll('*').length - right.querySelectorAll('*').length);
  const chain = [];
  let node = hits[0] ?? null;
  for (let depth = 0; node !== null && depth < 6; depth += 1) { chain.push(describe(node)); node = node.parentElement; }
  const composer = document.querySelector('[data-composer-seat]');
  return JSON.stringify({
    hits: hits.length,
    viewport: [window.innerWidth, window.innerHeight],
    composerTop: composer === null ? null : Math.round(composer.getBoundingClientRect().top),
    chain,
  }, null, 2);
})()`

const FOOTER_HOVER = `(() => {
  const target = [...document.querySelectorAll('body *')].filter((element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    if (rect.top < window.innerHeight * 0.72) return false;
    return /tok/i.test(element.textContent || '');
  }).sort((left, right) => left.querySelectorAll('*').length - right.querySelectorAll('*').length)[0];
  if (target === undefined) return 'no-target';
  const rect = target.getBoundingClientRect();
  const options = { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove']) target.dispatchEvent(new MouseEvent(type, options));
  return 'hovered: ' + (target.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
})()`

const CLICK_STAT = `(() => {
  const stat = document.querySelector('[data-composer-stat] button') ?? document.querySelector('[data-composer-stat]');
  if (stat === null) return 'no-stat';
  const rect = stat.getBoundingClientRect();
  const options = { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) stat.dispatchEvent(new MouseEvent(type, options));
  return 'clicked stat: ' + (stat.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
})()`

const POPOVER = `(() => {
  const items = [...document.querySelectorAll('[role=tooltip], [data-portal], [data-anchor-side], [role=dialog]')]
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        role: element.getAttribute('role'),
        text: (element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 90),
        rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
        display: style.display,
        position: style.position,
      };
    })
    .filter((entry) => entry.text !== '');
  return JSON.stringify({ viewport: [window.innerWidth, window.innerHeight], items: items.slice(0, 6) }, null, 2);
})()`

async function main() {
  const profile = join(ROOT_DIR, 'artifacts', `.edge-stats-${String(Date.now())}`)
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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: width <= 900 ? 2 : 1, mobile: width <= 900, screenWidth: width, screenHeight: height })
    if (width <= 900) {
      // Without a mobile UA Chrome falls back to the 980px legacy viewport, which
      // hides the whole desktop layout instead of exercising the narrow one.
      await cdp.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' })
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    }
    await cdp.send('Network.setCookie', { name: 'dshgw', value, domain: base.hostname, path: '/', httpOnly: true })
    await cdp.send('Page.navigate', { url: `${base.origin}/` })
    await sleep(5000)

    for (let round = 0; round < 5; round += 1) {
      const dismissed = await cdp.evaluate(DISMISS)
      await sleep(700)
      if (Number(dismissed) === 0) break
    }
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(400)

    console.log(`--- viewport ${String(width)}x${String(height)}: open session ${String(openIndex)} ---`)
    console.log(await cdp.evaluate(clickSession(openIndex)))
    await sleep(5000)

    console.log('--- footer stats ---')
    console.log(await cdp.evaluate(FOOTER))

    console.log('--- hover ---')
    console.log(await cdp.evaluate(FOOTER_HOVER))
    await sleep(1200)
    console.log('--- popovers after hover ---')
    console.log(await cdp.evaluate(POPOVER))

    console.log('--- click each stat ---')
    for (let index = 0; index < 3; index += 1) {
      const clicked = await cdp.evaluate(`(() => {
        const stats = [...document.querySelectorAll('[data-composer-stat]')];
        const stat = stats[${String(index)}];
        if (stat === undefined) return 'none';
        const button = stat.querySelector('button') ?? stat;
        const rect = button.getBoundingClientRect();
        const options = { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) button.dispatchEvent(new MouseEvent(type, options));
        return (stat.getAttribute('data-composer-stat') ?? 'stat') + ' | ' + (stat.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 36);
      })()`)
      await sleep(1000)
      const first = await cdp.evaluate(POPOVER)
      await sleep(600)
      const settled = await cdp.evaluate(POPOVER)
      console.log(`[${String(index)}] ${String(clicked)}`)
      console.log('  immediate:', first.replace(/\s+/g, ' ').slice(0, 260))
      console.log('  settled  :', settled.replace(/\s+/g, ' ').slice(0, 260))
      if (index === 1) {
        // Prove it on a phone: capture the panel the report is about.
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
        const file = join(ROOT_DIR, 'artifacts', `stats-${String(width)}.png`)
        mkdirSync(join(ROOT_DIR, 'artifacts'), { recursive: true })
        writeFileSync(file, Buffer.from(shot.data, 'base64'))
        console.log(`screenshot: ${file}`)
      }
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await sleep(500)
    }
  } finally {
    try { cdp?.socket.close() } catch { /* ignore */ }
    edge.kill()
  }
}

await main()
