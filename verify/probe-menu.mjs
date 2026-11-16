// Probe the sidebar account menu: click the avatar, then dump the menu popover
// ancestry so the gateway controls can be injected next to 设置 / 意见反馈 / 退出登录
//
// usage: node verify/probe-menu.mjs [--from-auth gateway/auth.json]
import { spawn } from 'node:child_process'
import { defaultUrl, findBrowser } from './_env.mjs'
import { createHmac } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const PORT = 9335
const argv = process.argv.slice(2)
const argOf = (name, fallback = '') => {
  const at = argv.indexOf(name)
  return at === -1 ? fallback : (argv[at + 1] ?? fallback)
}
const url = argOf('--url', defaultUrl())
const authPath = argOf('--from-auth', join(ROOT, 'gateway', 'auth.json'))
const width = Number(argOf('--width', '1440'))
const height = Number(argOf('--height', '900'))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const auth = JSON.parse(readFileSync(authPath, 'utf8'))
const expiresAt = Date.now() + 3_600_000
const signature = createHmac('sha256', Buffer.from(auth.sessionKey, 'base64')).update(`dshgw.${String(expiresAt)}`).digest('base64url')
const cookie = `${String(expiresAt)}.${signature}`
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

const STEP1 = `(() => {
  const info = (element) => {
    const box = element.getBoundingClientRect();
    return { tag: element.tagName.toLowerCase(), slot: element.getAttribute('data-slot') || '', text: (element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30), x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) };
  };
  const candidates = [...document.querySelectorAll('[data-slot="sidebar.footer.action"] *, [data-avatar-status], [data-signed-out]')]
    .filter((element) => element.getBoundingClientRect().width > 0)
    .map(info);
  const buttons = [...document.querySelectorAll('button, [role=button]')]
    .filter((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.left < 260 && box.top > window.innerHeight - 140;
    })
    .map(info);
  return JSON.stringify({ footer: candidates.slice(-12), bottomButtons: buttons.slice(-12) }, null, 2);
})()`

const STEP2 = `(() => {
  const info = (element) => {
    if (element === null || element === undefined) return null;
    const box = element.getBoundingClientRect();
    return {
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role') || '',
      attrs: [...element.attributes].map((a) => a.name + (a.name.startsWith('data-') || a.name === 'role' ? '=' + a.value : '')).filter((text) => text.includes('=')).slice(0, 6).join(' '),
      text: (element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
      svgs: element.querySelectorAll('svg').length,
      w: Math.round(box.width), h: Math.round(box.height),
      html: element.outerHTML.replace(/\\s+/g, ' ').slice(0, 300),
    };
  };
  const menu = document.querySelector('[role=menu]');
  if (menu === null) return JSON.stringify({ menu: null });
  const viewport = menu.querySelector('[role=presentation]');
  const items = viewport === null ? [] : [...viewport.children].map((element) => (element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24));
  const injected = [...menu.querySelectorAll('[data-dshgw-item]')].map((element) => (element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24));
  return JSON.stringify({ menu: info(menu), items, injected }, null, 2);
})()`

async function main() {
  const profile = join(ROOT, 'artifacts', `.edge-menu-${String(Date.now())}`)
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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height })
    await cdp.send('Network.setCookie', { name: 'dshgw', value: cookie, domain: base.hostname, path: '/', httpOnly: true })
    await cdp.send('Page.navigate', { url: `${base.origin}/` })
    await sleep(6000)

    console.log('--- bottom-left controls ---')
    console.log(await cdp.evaluate(STEP1))

    const clicked = await cdp.evaluate(`(() => {
      const buttons = [...document.querySelectorAll('button, [role=button]')]
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && box.left < 260 && box.top > window.innerHeight - 140;
        });
      const target = buttons[buttons.length - 1];
      if (target === undefined) return 'none';
      const label = target.getAttribute('aria-label') || target.title || target.textContent || '';
      target.click();
      return label.trim().slice(0, 40);
    })()`)
    console.log(`--- clicked: ${String(clicked)} ---`)
    await sleep(1200)
    console.log(await cdp.evaluate(STEP2))
  } finally {
    try { cdp?.socket.close() } catch { /* ignore */ }
    edge.kill()
  }
}

await main()
