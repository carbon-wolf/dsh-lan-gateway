// Screenshot the bottom of a chat session (deliverable cards, footer stats) at a
// phone viewport, to check that injected CSS does not distort the shell.
//
// usage: node verify/shot-chat.mjs [--width 390 --height 844] [--open 1] [--out chat-bottom.png]
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultUrl, findBrowser, ROOT_DIR } from './_env.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = 9339
const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const at = argv.indexOf(name)
  return at === -1 ? fallback : (argv[at + 1] ?? fallback)
}
const url = argOf('--url', defaultUrl())
const width = Number(argOf('--width', '390'))
const height = Number(argOf('--height', '844'))
const openIndex = Number(argOf('--open', '1'))
const out = argOf('--out', 'chat-bottom.png')
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

async function main() {
  const profile = join(ROOT_DIR, 'artifacts', `.edge-chat-${String(Date.now())}`)
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

    console.log('open session:', await cdp.evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-row-key^="session:"]')];
      const target = rows[${String(openIndex)}];
      if (!target) return 'none (' + String(rows.length) + ')';
      const rect = target.getBoundingClientRect();
      const options = { bubbles: true, cancelable: true, clientX: rect.left + 24, clientY: rect.top + rect.height / 2 };
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) target.dispatchEvent(new MouseEvent(type, options));
      return 'clicked ' + String(${String(openIndex)});
    })()`))
    await sleep(5000)

    // The session header defaults to the trajectory tab after a reload; switch
    // back to the conversation so the deliverable cards are in view.
    console.log('tab:', await cdp.evaluate(`(() => {
      const tabs = [...document.querySelectorAll('[role=tab], button')];
      const target = tabs.find((element) => (element.textContent || '').trim() === '对话');
      if (!target) return 'no-tab';
      target.click();
      return 'clicked';
    })()`))
    await sleep(1500)

    console.log('scroll:', await cdp.evaluate(`(() => {
      const scroller = document.querySelector('[data-conversation-scroll]') ?? document.querySelector('[data-conversation-content]');
      if (!scroller) return 'no-scroller';
      scroller.scrollTop = scroller.scrollHeight;
      return 'scrollTop=' + String(Math.round(scroller.scrollTop)) + '/' + String(Math.round(scroller.scrollHeight));
    })()`))
    // The transcript virtualises its height; keep pushing until it stops growing.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await sleep(600)
      await cdp.evaluate(`(() => {
        const scroller = document.querySelector('[data-conversation-scroll]') ?? document.querySelector('[data-conversation-content]');
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
        return 1;
      })()`)
    }
    await sleep(1500)

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const file = join(ROOT_DIR, 'artifacts', out)
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    console.log('screenshot:', file)
  } finally {
    try { cdp?.socket.close() } catch { /* ignore */ }
    edge.kill()
  }
}

await main()
