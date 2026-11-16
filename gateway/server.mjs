#!/usr/bin/env node
// DSH remote gateway: a password-protected reverse proxy in front of the
// Desktop app's loopback Host, so a phone on the LAN drives the SAME Host the
// Electron window drives (same sessions, same running turns, same files).
//
// Why a proxy instead of a second `dsh web`:
//   - the desktop Host binds 127.0.0.1 with an OS-assigned port;
//   - its browser cookie is HMAC-signed with a secret that lives in
//     ~/.dsh/.credentials.yaml (see dsh-auth.mjs), so the gateway can mint a
//     valid owner session without the process-lifetime launch token;
//   - /api accepts a loopback Host plus a same-origin Origin, so rewriting
//     those headers is enough and no second process touches the data.
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, request as httpRequest, Agent } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect, isIP } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync, inflateSync } from 'node:zlib'
import { discoverHostPort } from './discover.mjs'
import { SecretSource, mintCookie, credentialsPath } from './dsh-auth.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CONFIG_PATH = join(HERE, 'config.json')
const AUTH_PATH = join(HERE, 'auth.json')
const SESSIONS_PATH = join(HERE, 'sessions.json')
const INJECT_DIR = join(ROOT, 'inject')
const LOG_DIR = join(HERE, 'logs')

const SESSION_COOKIE = 'dshgw'
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 128 * 32768 * 8 * 2 }
const HTML_BUFFER_LIMIT = 4 * 1024 * 1024
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
const MAX_SESSIONS = 200
/** Rows kept per client address; browsers change UA when they update. */
const MAX_PER_IP = 6

// ── small utilities ─────────────────────────────────────────────────────────

const b64url = (value) => Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const now = () => new Date().toISOString()

function formatUptime(milliseconds) {
  const minutes = Math.floor(milliseconds / 60_000)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return `${String(hours)} 小时 ${String(minutes % 60)} 分钟`
  return `${String(minutes)} 分钟`
}

function log(...parts) {
  const line = `[${now()}] ${parts.join(' ')}`
  process.stdout.write(`${line}\n`)
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    const name = `gateway-${new Date().toISOString().slice(0, 10)}.log`
    writeFileSync(join(LOG_DIR, name), `${line}\n`, { flag: 'a' })
  } catch {
    // logging must never break a request
  }
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

const DEFAULT_CONFIG = {
  listenHost: '127.0.0.1',
  listenPort: 3080,
  sessionDays: 30,
  maxFailures: 8,
  lockMinutes: 15,
  dshPort: null,
  tls: null,
  inject: { css: true, js: true },
}

function loadConfig() {
  const stored = readJson(CONFIG_PATH, null)
  if (stored === null) {
    writeFileSync(CONFIG_PATH, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`)
    return { ...DEFAULT_CONFIG, inject: { ...DEFAULT_CONFIG.inject } }
  }
  return { ...DEFAULT_CONFIG, ...stored, inject: { ...DEFAULT_CONFIG.inject, ...(stored.inject ?? {}) } }
}

// ── gateway password ────────────────────────────────────────────────────────

function newSessionKey() {
  return randomBytes(32).toString('base64')
}

function hashPassword(password, salt = randomBytes(16)) {
  const hash = scryptSync(password, salt, 32, SCRYPT)
  return { salt: salt.toString('base64'), hash: hash.toString('base64') }
}

function verifyPassword(password, stored) {
  const expected = Buffer.from(stored.hash, 'base64')
  const actual = scryptSync(password, Buffer.from(stored.salt, 'base64'), expected.byteLength, SCRYPT)
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected)
}

function writeAuthFile(password) {
  const previous = readJson(AUTH_PATH, null)
  const auth = {
    scrypt: hashPassword(password),
    sessionKey: previous?.sessionKey ?? newSessionKey(),
    updatedAt: now(),
  }
  writeFileSync(AUTH_PATH, `${JSON.stringify(auth, null, 2)}\n`)
  return auth
}

function loadAuth({ allowInit }) {
  const stored = readJson(AUTH_PATH, null)
  if (stored !== null) return stored
  if (!allowInit) return null
  const generated = b64url(randomBytes(12))
  const auth = writeAuthFile(generated)
  log(`gateway: created ${AUTH_PATH}`)
  log(`gateway: temporary password is ${generated} — change it from the settings page or with --set-password`)
  return auth
}

// ── session cookie ──────────────────────────────────────────────────────────

function sessionKeyBytes(auth) {
  return Buffer.from(auth.sessionKey, 'base64')
}

function signSession(auth, expiresAt) {
  return b64url(createHmac('sha256', sessionKeyBytes(auth)).update(`${SESSION_COOKIE}.${String(expiresAt)}`).digest())
}

/** Days → cookie lifetime. 0 means "stay signed in" (browser cap is 400 days). */
function cookieLifetimeDays(days) {
  if (days === 0) return 400
  return Math.min(Math.max(1, Math.floor(days)), 90)
}

function issueSessionCookie(auth, days, secure) {
  const lifetime = cookieLifetimeDays(days)
  const expiresAt = Date.now() + lifetime * 86_400_000
  const value = `${String(expiresAt)}.${signSession(auth, expiresAt)}`
  const attributes = `${SESSION_COOKIE}=${value}; Max-Age=${String(lifetime * 86_400)}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}`
  return secure ? `${attributes}; Secure` : attributes
}

function clearSessionCookie(secure) {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
}

function readCookie(header, name) {
  if (typeof header !== 'string') return undefined
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    if (segment.slice(0, at).trim() === name) return segment.slice(at + 1).trim()
  }
  return undefined
}

// ── session registry (lets the settings page list and revoke devices) ──────

let sessionRecords = []
let sessionsDirty = false

function parseSessionValue(rawCookie) {
  if (typeof rawCookie !== 'string') return null
  const [expiresText, signature] = rawCookie.split('.')
  const expiresAt = Number(expiresText)
  if (signature === undefined || !Number.isSafeInteger(expiresAt)) return null
  return { signature, expiresAt }
}

/** Sessions cancelled by "lock"; kept until the cookie expires anyway. */
const revokedSessions = new Map()

function loadSessionRecords() {
  const stored = readJson(SESSIONS_PATH, null)
  const list = Array.isArray(stored?.sessions) ? stored.sessions : []
  const current = Date.now()
  sessionRecords = list.filter((record) => Number.isSafeInteger(record?.expiresAt) && record.expiresAt > current)
  for (const record of sessionRecords) {
    if (record.revokedAt !== null && record.revokedAt !== undefined) revokedSessions.set(record.sig, record.expiresAt)
  }
}

function saveSessionRecords(force = false) {
  if (!sessionsDirty && !force) return
  sessionsDirty = false
  try {
    writeFileSync(SESSIONS_PATH, `${JSON.stringify({ sessions: sessionRecords }, null, 2)}\n`)
  } catch {
    // persistence is best-effort
  }
}

/** Tool traffic (scripts, probes, PowerShell) is not a device and must not fill the list. */
const AUTOMATION_UA = /PowerShell|curl\/|Wget|python-requests|Go-http-client|axios|node-fetch|undici|HeadlessChrome|HTTPie/i

function registerSession(req, rawCookie) {
  const parsed = parseSessionValue(rawCookie)
  if (parsed === null || parsed.expiresAt <= Date.now()) return
  const current = Date.now()
  const ua = String(req.headers['user-agent'] ?? '').slice(0, 300)
  if (ua === '' || !/Mozilla\//i.test(ua) || AUTOMATION_UA.test(ua)) return
  const ip = clientKey(req)
  const bySig = sessionRecords.find((record) => record.sig === parsed.signature)
  if (bySig !== undefined) {
    bySig.lastSeenAt = current
    bySig.ip = ip
    bySig.ua = ua
  } else {
    // The list is meant to show devices, not every cookie ever issued: a later
    // login from the same address and user agent replaces the older row.
    const sameDevice = sessionRecords.find((record) => record.ip === ip && record.ua === ua && !record.revokedAt)
    if (sameDevice !== undefined) {
      sameDevice.sig = parsed.signature
      sameDevice.expiresAt = parsed.expiresAt
      sameDevice.lastSeenAt = current
    } else {
      // Browser upgrades change the UA string; keep a short list per address so
      // historical rows cannot pile up.
      const sameIp = sessionRecords
        .filter((record) => record.ip === ip && !record.revokedAt)
        .sort((left, right) => Number(left.lastSeenAt ?? 0) - Number(right.lastSeenAt ?? 0))
      while (sameIp.length >= MAX_PER_IP) {
        const oldest = sameIp.shift()
        const at = sessionRecords.indexOf(oldest)
        if (at !== -1) sessionRecords.splice(at, 1)
      }
      sessionRecords.unshift({
        sig: parsed.signature,
        expiresAt: parsed.expiresAt,
        createdAt: current,
        lastSeenAt: current,
        ip,
        ua,
        note: '',
        revokedAt: null,
      })
      if (sessionRecords.length > MAX_SESSIONS) sessionRecords.length = MAX_SESSIONS
    }
  }
  sessionsDirty = true
}

function revokeBySignature(signature) {
  const record = sessionRecords.find((item) => item.sig === signature)
  revokedSessions.set(signature, record?.expiresAt ?? Date.now() + 86_400_000)
  if (record !== undefined) {
    record.revokedAt = Date.now()
    sessionsDirty = true
  }
  saveSessionRecords(true)
}

function revokeSession(rawCookie) {
  const parsed = parseSessionValue(rawCookie)
  if (parsed === null) return
  revokeBySignature(parsed.signature)
  const current = Date.now()
  for (const [key, until] of revokedSessions) if (until <= current) revokedSessions.delete(key)
}

function hasValidSession(req, auth) {
  const raw = readCookie(req.headers.cookie, SESSION_COOKIE)
  if (raw === undefined) return false
  const parsed = parseSessionValue(raw)
  if (parsed === null || parsed.expiresAt <= Date.now()) return false
  const { signature, expiresAt } = parsed
  const expected = Buffer.from(signSession(auth, expiresAt), 'utf8')
  const actual = Buffer.from(signature, 'utf8')
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) return false
  const revokedUntil = revokedSessions.get(signature)
  if (revokedUntil !== undefined && revokedUntil > Date.now()) return false
  registerSession(req, raw)
  return true
}

// ── login throttling ────────────────────────────────────────────────────────

const failures = new Map()

function clientKey(req) {
  return req.socket.remoteAddress ?? 'unknown'
}

function lockState(req, config) {
  const record = failures.get(clientKey(req))
  if (record === undefined) return { locked: false, remaining: 0 }
  if (record.lockedUntil > Date.now()) {
    return { locked: true, minutes: Math.ceil((record.lockedUntil - Date.now()) / 60_000) }
  }
  return { locked: false, remaining: Math.max(0, config.maxFailures - record.count) }
}

function recordFailure(req, config) {
  const key = clientKey(req)
  const record = failures.get(key) ?? { count: 0, lockedUntil: 0 }
  record.count += 1
  if (record.count >= config.maxFailures) {
    record.lockedUntil = Date.now() + config.lockMinutes * 60_000
    record.count = 0
  }
  failures.set(key, record)
}

// ── upstream host port ──────────────────────────────────────────────────────

const secretSource = new SecretSource()
let cachedPort = null
let cachedAt = 0

async function hostPort(config, { force = false } = {}) {
  if (!force && cachedPort !== null && Date.now() - cachedAt < 10_000) return cachedPort
  const found = await discoverHostPort({ fixedPort: config.dshPort })
  cachedPort = found?.port ?? null
  cachedAt = Date.now()
  if (found !== null) log(`gateway: desktop host on 127.0.0.1:${String(found.port)} (via ${found.via})`)
  else log('gateway: desktop host not found; is the Desktop app running?')
  return cachedPort
}

function invalidatePort() {
  cachedPort = null
  cachedAt = 0
}

// ── injection assets ────────────────────────────────────────────────────────

const assetCache = new Map()

function readInjectAsset(name) {
  const path = join(INJECT_DIR, name)
  let stamp
  try {
    stamp = statSync(path).mtimeMs
  } catch {
    return null
  }
  const cached = assetCache.get(name)
  if (cached !== undefined && cached.stamp === stamp) return cached.text
  const text = readFileSync(path, 'utf8')
  assetCache.set(name, { stamp, text })
  return text
}

function injectionMarkup(config) {
  const chunks = []
  if (config.inject.css) {
    const css = readInjectAsset('mobile.css')
    if (css !== null) chunks.push(`<style id="dshgw-mobile-css">${css}</style>`)
  }
  if (config.inject.js) {
    const js = readInjectAsset('mobile.js')
    if (js !== null) chunks.push(`<script id="dshgw-mobile-js">${js}</script>`)
  }
  return chunks.join('')
}

function decodeBody(buffer, encoding) {
  switch ((encoding ?? '').toLowerCase()) {
    case 'gzip': return gunzipSync(buffer)
    case 'deflate': return inflateSync(buffer)
    case 'br': return brotliDecompressSync(buffer)
    default: return buffer
  }
}

function encodeBody(buffer, encoding) {
  switch ((encoding ?? '').toLowerCase()) {
    case 'gzip': return gzipSync(buffer)
    case 'br': return brotliCompressSync(buffer)
    default: return buffer
  }
}

// ── header rewriting ────────────────────────────────────────────────────────

function upstreamAuthority(port) {
  return `127.0.0.1:${String(port)}`
}

let mintedCache = { authority: null, header: '', mintedAt: 0 }

/** Re-mint well before the Host's own 30-day cap so a long-lived gateway never logs itself out. */
const MINT_REFRESH_MILLISECONDS = 20 * 86_400_000

function dshCookieHeader(port, days) {
  const authority = upstreamAuthority(port)
  const lifetime = Math.min(days === 0 ? 30 : Math.max(1, days), 29)
  const stale = Date.now() - mintedCache.mintedAt > MINT_REFRESH_MILLISECONDS
  if (mintedCache.authority === authority && mintedCache.header !== '' && !stale) return mintedCache.header
  const cookie = mintCookie(authority, secretSource.get(), lifetime)
  mintedCache = { authority, header: cookie.header, mintedAt: Date.now() }
  return cookie.header
}

function rewriteRequestHeaders(incoming, port, days) {
  const authority = upstreamAuthority(port)
  const headers = {}
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue
    const key = name.toLowerCase()
    if (key === 'host' || key === 'cookie' || key === 'origin' || key === 'referer' || key === 'connection' || key === 'proxy-connection') continue
    headers[key] = value
  }
  headers.host = authority

  // Only relay an Origin that belongs to this gateway, rewritten to the
  // upstream authority: the Host fence requires origin.host === host, and an
  // unknown Origin is dropped rather than trusted.
  const origin = incoming.origin
  if (typeof origin === 'string') {
    try {
      const url = new URL(origin)
      if (url.host === String(incoming.host ?? '')) headers.origin = `http://${authority}`
    } catch {
      // unparsable Origin: drop it
    }
  }
  if (typeof incoming.referer === 'string') {
    try {
      const referer = new URL(incoming.referer)
      headers.referer = `http://${authority}${referer.pathname}${referer.search}`
    } catch {
      delete headers.referer
    }
  }

  const forwarded = (incoming.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '' && !part.startsWith('dsh-auth-') && !part.startsWith(`${SESSION_COOKIE}=`))
  forwarded.push(dshCookieHeader(port, days))
  headers.cookie = forwarded.join('; ')
  return headers
}

// ── HTML injection ──────────────────────────────────────────────────────────

function injectIntoHtml(html, markup) {
  if (markup === '') return html
  const head = html.indexOf('</head>')
  if (head !== -1) return `${html.slice(0, head)}${markup}${html.slice(head)}`
  const body = html.indexOf('</body>')
  if (body !== -1) return `${html.slice(0, body)}${markup}${html.slice(body)}`
  return `${html}${markup}`
}

function isHtmlResponse(headers) {
  const type = headers['content-type']
  return typeof type === 'string' && type.toLowerCase().includes('text/html')
}

// ── pages ───────────────────────────────────────────────────────────────────

const LOGIN_STYLE = `
  :root { color-scheme: light dark }
  * { box-sizing: border-box }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center;
    font: 16px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    background: #0f1115; color: #e8eaed; padding: 24px env(safe-area-inset-right) calc(24px + env(safe-area-inset-bottom)) env(safe-area-inset-left) }
  form.login { width: min(360px, 100%); background: #171a21; border: 1px solid #262b36; border-radius: 16px; padding: 24px }
  h1 { font-size: 18px; margin: 0 0 4px }
  p.hint { margin: 0 0 20px; font-size: 13px; color: #9aa3b2 }
  input, button { width: 100%; font-size: 16px; border-radius: 10px; padding: 14px 16px; border: 1px solid #2f3542;
    background: #0f131a; color: #e8eaed }
  input:focus { outline: 2px solid #4c8dff; outline-offset: 1px }
  button { margin-top: 12px; background: #2b6ef6; border-color: #2b6ef6; font-weight: 600; color: #fff }
  .error { margin: 12px 0 0; color: #ff8f8f; font-size: 14px }
`

function loginPage({ error, lockedMinutes, next }) {
  const message = error === undefined ? '' : `<p class="error">${error}</p>`
  const lockText = lockedMinutes === undefined ? '' : `<p class="error">尝试次数过多，请 ${String(lockedMinutes)} 分钟后再试。</p>`
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex"><title>DeepSeek Harness 远程网关</title>
<style>${LOGIN_STYLE}</style></head><body>
<form class="login" method="post" action="/_gw/login">
  <h1>DeepSeek Harness 远程网关</h1>
  <p class="hint">请输入网关密码，登录后继续使用桌面版里的会话。</p>
  <input type="password" name="password" autocomplete="current-password" autofocus required placeholder="网关密码">
  <input type="hidden" name="next" value="${next.replaceAll('"', '&quot;')}">
  <button type="submit">登录</button>
  ${lockText}${message}
</form></body></html>`
}

function errorPage(title, detail) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>${LOGIN_STYLE}</style></head><body><div style="max-width:420px">
<h1>${title}</h1><p class="hint">${detail}</p></div></body></html>`
}

function safeNext(value) {
  if (typeof value !== 'string' || value === '') return '/'
  if (!value.startsWith('/') || value.startsWith('//')) return '/'
  return value
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// ── settings page ───────────────────────────────────────────────────────────

const SETTINGS_STYLE = `${LOGIN_STYLE}
  body { display: block; padding: 16px env(safe-area-inset-right) calc(24px + env(safe-area-inset-bottom)) env(safe-area-inset-left) }
  .wrap { max-width: 560px; margin: 0 auto }
  /* Forms here are plain containers; the login card rules only apply to form.login. */
  form { width: auto; margin: 0; padding: 0; border: 0; background: transparent; border-radius: 0 }
  form.card { padding: 16px; background: #171a21; border: 1px solid #262b36; border-radius: 14px }
  button { width: auto }
  @media (min-width: 900px) {
    .wrap { max-width: 760px }
    .row { gap: 16px }
  }
  h1 { font-size: 19px; margin: 8px 0 2px }
  h2 { font-size: 15px; margin: 26px 0 10px; color: #cfd5e1 }
  .sub { color: #9aa3b2; font-size: 13px; margin: 0 0 10px }
  .card { background: #171a21; border: 1px solid #262b36; border-radius: 14px; padding: 16px }
  .card + .card, form.card { margin-top: 12px }
  label { display: block; font-size: 13px; color: #aab2c0; margin: 12px 0 6px }
  label:first-child { margin-top: 0 }
  input[type=text], input[type=password], input[type=number] {
    width: 100%; font-size: 16px; border-radius: 10px; padding: 11px 13px;
    border: 1px solid #2f3542; background: #0f131a; color: #e8eaed;
  }
  .row { display: flex; gap: 12px; align-items: flex-start }
  .row > * { flex: 1; min-width: 0 }
  .check { display: flex; gap: 10px; align-items: center; margin: 10px 0; font-size: 14px; color: #cfd5e1 }
  .check input { width: 18px; height: 18px; margin: 0 }
  .check label { margin: 0 }
  button { font-size: 15px; border-radius: 10px; padding: 12px 16px; border: 1px solid #2b6ef6; background: #2b6ef6; color: #fff; font-weight: 600; cursor: pointer }
  button.ghost { background: transparent; color: #cfd5e1; border-color: #2f3542; font-weight: 500 }
  button.danger { background: transparent; color: #ff9b9b; border-color: #5a2b33; font-weight: 500 }
  .actions { display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap }
  .note { font-size: 13px; color: #9aa3b2; margin: 6px 0 0 }
  .banner { border-radius: 10px; padding: 11px 13px; font-size: 14px; margin: 12px 0 }
  .banner.ok { background: #14301f; color: #9be3b6; border: 1px solid #23492f }
  .banner.bad { background: #341a1d; color: #ffb3b3; border: 1px solid #57262c }
  .kv { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; color: #aab2c0; padding: 6px 0; border-bottom: 1px solid #20242c }
  .kv:last-child { border-bottom: 0 }
  .kv b { color: #e8eaed; font-weight: 500 }
  a.back { display: inline-block; margin-top: 18px; color: #7aa7ff; font-size: 14px; text-decoration: none }
  .device { border-top: 1px solid #20242c; padding: 12px 0 }
  .device:first-of-type { border-top: 0; padding-top: 0 }
  .device-head { display: flex; align-items: center; gap: 8px; font-size: 14px; color: #e8eaed }
  .device-meta { font-size: 12px; color: #9aa3b2; margin: 4px 0 8px }
  .device-note { font-size: 13px; color: #cfd5e1; margin: 0 0 8px }
  .tag { font-size: 11px; color: #9be3b6; border: 1px solid #23492f; background: #14301f; border-radius: 999px; padding: 1px 8px }
  .device-actions { display: flex; gap: 8px; margin-top: 8px; align-items: center; flex-wrap: nowrap }
  .device-actions input[type=text] { flex: 1 1 auto; min-width: 0; width: auto; font-size: 15px; padding: 9px 11px }
  .device-actions button { flex: 0 0 auto; width: auto; margin: 0; padding: 9px 14px; font-size: 13px; white-space: nowrap }
`

const SETTINGS_MESSAGES = {
  'config-saved': '配置已保存。监听地址、端口或 TLS 的改动要重启网关后生效，其余项立即生效。',
  'password-changed': '密码已更新，请用新密码重新登录。',
  rotated: '已轮换签名密钥：所有设备都已退出，设备列表也已清空。',
  revoked: '该设备已登出。',
  noted: '备注已保存。',
}

const SETTINGS_ERRORS = {
  password: '当前密码不正确，或新密码不符合要求（至少 8 位，且两次输入一致）。',
  host: '监听地址必须是本机的一个具体 IPv4/IPv6 地址，不能是通配地址（0.0.0.0）。',
  port: '端口必须是 1–65535 的整数。',
  number: '数字项超出允许范围（登录保持：0–90 天）。',
  tls: 'TLS 证书与私钥必须同时填写，或同时留空。',
  write: '写入配置文件失败，请检查目录权限。',
  session: '找不到这个会话记录（可能已经登出）。',
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** Short, human label for a User-Agent: platform plus browser. */
function describeClient(ua) {
  const text = String(ua ?? '')
  let platform = '未知设备'
  if (/iPhone/i.test(text)) platform = 'iPhone'
  else if (/iPad/i.test(text)) platform = 'iPad'
  else if (/Android/i.test(text)) platform = 'Android 手机'
  else if (/Macintosh|Mac OS X/i.test(text)) platform = 'Mac'
  else if (/Windows/i.test(text)) platform = 'Windows'
  else if (/Linux/i.test(text)) platform = 'Linux'
  let browser = ''
  if (/MicroMessenger/i.test(text)) browser = '微信'
  else if (/Edg\//i.test(text)) browser = 'Edge'
  else if (/CriOS/i.test(text)) browser = 'Chrome'
  else if (/FxiOS/i.test(text)) browser = 'Firefox'
  else if (/Chrome\//i.test(text)) browser = 'Chrome'
  else if (/Firefox\//i.test(text)) browser = 'Firefox'
  else if (/Safari\//i.test(text)) browser = 'Safari'
  return browser === '' ? platform : `${platform} · ${browser}`
}

function formatAgo(milliseconds) {
  const minutes = Math.floor(milliseconds / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${String(minutes)} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)} 小时前`
  return `${String(Math.floor(hours / 24))} 天前`
}

function settingsPage({ config, runtime, devices, notice, problem }) {
  const banner = notice === undefined ? '' : `<div class="banner ok">${escapeHtml(SETTINGS_MESSAGES[notice] ?? notice)}</div>`
  const badBanner = problem === undefined ? '' : `<div class="banner bad">${escapeHtml(SETTINGS_ERRORS[problem] ?? problem)}</div>`
  const tls = config.tls ?? { cert: '', key: '' }
  const scheme = config.tls === null ? 'http' : 'https'
  const deviceRows = devices.length === 0
    ? '<p class="sub">还没有登记的会话。登录一次就会出现在这里。</p>'
    : devices.map((device) => `<div class="device">
    <div class="device-head"><b>${escapeHtml(device.label)}</b>${device.current ? '<span class="tag">这台设备</span>' : ''}</div>
    <div class="device-meta">${escapeHtml(device.ip)} · 最后活跃 ${escapeHtml(device.lastSeen)} · ${escapeHtml(device.expires)}</div>
    ${device.note === '' ? '' : `<div class="device-note">备注：${escapeHtml(device.note)}</div>`}
    <form method="post" class="device-actions">
      <input type="hidden" name="action" value="note">
      <input type="hidden" name="sig" value="${escapeHtml(device.sig)}">
      <input type="text" name="note" value="${escapeHtml(device.note)}" placeholder="备注（例如：我的 iPhone）" maxlength="60">
      <button type="submit" class="ghost">保存备注</button>
    </form>
    <form method="post" class="device-actions">
      <input type="hidden" name="action" value="revoke">
      <input type="hidden" name="sig" value="${escapeHtml(device.sig)}">
      <button type="submit" class="danger">登出这台</button>
    </form>
  </div>`).join('')

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex"><title>网关设置 · DeepSeek Harness</title>
<style>${SETTINGS_STYLE}</style></head><body><div class="wrap">
<h1>网关设置</h1>
<p class="sub">在这里改配置，等同于编辑 gateway\\config.json。</p>
${banner}${badBanner}

<h2>运行状态</h2>
<div class="card">
  <div class="kv"><span>桌面版 Host</span><b>${runtime.upstreamPort === null ? '未连接' : `127.0.0.1:${String(runtime.upstreamPort)}`}</b></div>
  <div class="kv"><span>访问地址</span><b>${scheme}://${escapeHtml(config.listenHost)}:${String(config.listenPort)}</b></div>
  <div class="kv"><span>已运行</span><b>${runtime.uptime}</b></div>
  <div class="kv"><span>已吊销会话</span><b>${String(runtime.revokedCount)}</b></div>
</div>

<h2>已登录设备</h2>
<div class="card">
  <p class="sub">当前有 ${String(devices.length)} 台会话。可以加备注或单独登出；登出后该设备需要重新输入密码。</p>
  ${deviceRows}
</div>

<h2>监听与访问</h2>
<form method="post" class="card">
  <input type="hidden" name="action" value="save">
  <label>监听地址（本机网卡 IP，不能填 0.0.0.0）</label>
  <input type="text" name="listenHost" value="${escapeHtml(config.listenHost)}" required>
  <div class="row">
    <div>
      <label>端口</label>
      <input type="number" name="listenPort" min="1" max="65535" value="${String(config.listenPort)}" required>
    </div>
    <div>
      <label>登录保持（天，0 = 不退出）</label>
      <input type="number" name="sessionDays" min="0" max="90" value="${String(config.sessionDays)}" required>
    </div>
  </div>
  <div class="row">
    <div>
      <label>连续失败上限</label>
      <input type="number" name="maxFailures" min="1" max="50" value="${String(config.maxFailures)}" required>
    </div>
    <div>
      <label>锁定分钟数</label>
      <input type="number" name="lockMinutes" min="1" max="1440" value="${String(config.lockMinutes)}" required>
    </div>
  </div>
  <label>桌面版 Host 端口（留空表示自动发现）</label>
  <input type="text" name="dshPort" value="${config.dshPort === null ? '' : String(config.dshPort)}" placeholder="自动发现">

  <h2>页面注入</h2>
  <div class="check"><input type="checkbox" id="injectCss" name="injectCss" ${config.inject.css ? 'checked' : ''}><label for="injectCss">注入移动端样式（建议开启）</label></div>
  <div class="check"><input type="checkbox" id="injectJs" name="injectJs" ${config.inject.js ? 'checked' : ''}><label for="injectJs">注入菜单项与锁定按钮（建议开启）</label></div>

  <h2>TLS（可选）</h2>
  <label>证书 PEM 路径</label>
  <input type="text" name="tlsCert" value="${escapeHtml(tls.cert ?? '')}" placeholder="留空则使用 HTTP">
  <label>私钥 PEM 路径</label>
  <input type="text" name="tlsKey" value="${escapeHtml(tls.key ?? '')}" placeholder="留空则使用 HTTP">
  <p class="note">两项要么都填，要么都留空。改动需要重启网关。</p>

  <div class="actions"><button type="submit">保存配置</button></div>
</form>

<h2>密码</h2>
<form method="post" class="card">
  <input type="hidden" name="action" value="password">
  <label>当前密码</label>
  <input type="password" name="currentPassword" autocomplete="current-password" required>
  <div class="row">
    <div>
      <label>新密码（至少 8 位）</label>
      <input type="password" name="newPassword" autocomplete="new-password" minlength="8" required>
    </div>
    <div>
      <label>再次输入新密码</label>
      <input type="password" name="confirmPassword" autocomplete="new-password" minlength="8" required>
    </div>
  </div>
  <div class="actions"><button type="submit">更新密码</button></div>
</form>

<h2>会话</h2>
<div class="card">
  <p class="sub">轮换签名密钥会立即注销所有设备，并清空下面的设备列表。</p>
  <form method="post">
    <input type="hidden" name="action" value="rotate">
    <div class="actions"><button type="submit" class="danger">让所有设备退出</button></div>
  </form>
  <form method="post">
    <input type="hidden" name="action" value="lock">
    <div class="actions"><button type="submit" class="ghost">锁定这台设备</button></div>
  </form>
</div>

<a class="back" href="/">← 返回 Harness</a>
</div></body></html>`
}

const INTEGER_FIELDS = { listenPort: [1, 65_535], sessionDays: [0, 90], maxFailures: [1, 50], lockMinutes: [1, 1440] }

function parseSettingsForm(form, current) {
  const next = { ...current, inject: { ...current.inject }, tls: null }
  const host = (form.get('listenHost') ?? '').trim()
  const wildcard = /^0+\.0+\.0+\.0$/u.test(host) || host === '::' || host === '0:0:0:0:0:0:0:0' || host === ''
  if (wildcard || isIP(host) === 0) return { problem: 'host' }
  next.listenHost = host

  for (const [field, [min, max]] of Object.entries(INTEGER_FIELDS)) {
    const value = Number(form.get(field))
    if (!Number.isInteger(value) || value < min || value > max) return { problem: field === 'listenPort' ? 'port' : 'number' }
    next[field] = value
  }

  const rawPort = (form.get('dshPort') ?? '').trim()
  if (rawPort === '') next.dshPort = null
  else {
    const port = Number(rawPort)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return { problem: 'port' }
    next.dshPort = port
  }

  next.inject = { css: form.get('injectCss') !== null, js: form.get('injectJs') !== null }

  const cert = (form.get('tlsCert') ?? '').trim()
  const key = (form.get('tlsKey') ?? '').trim()
  if ((cert === '') !== (key === '')) return { problem: 'tls' }
  next.tls = cert === '' ? null : { cert, key }
  return { value: next }
}

async function handleSettingsRoute(req, res, config, auth, runtime) {
  const url = new URL(req.url ?? '/', 'http://gateway.invalid')
  if (url.pathname !== '/_gw/settings') return false

  const redirect = (query) => {
    res.writeHead(303, { location: `/_gw/settings${query}`, 'cache-control': 'no-store' })
    res.end()
  }

  if (req.method === 'GET') {
    const currentSig = parseSessionValue(readCookie(req.headers.cookie, SESSION_COOKIE))?.signature ?? null
    const lifetime = cookieLifetimeDays(config.sessionDays)
    const devices = sessionRecords
      .filter((record) => record.revokedAt === null || record.revokedAt === undefined)
      .sort((left, right) => Number(right.lastSeenAt ?? 0) - Number(left.lastSeenAt ?? 0))
      .map((record) => ({
        sig: record.sig,
        label: describeClient(record.ua),
        ip: record.ip ?? '未知地址',
        note: record.note ?? '',
        current: record.sig === currentSig,
        lastSeen: formatAgo(Date.now() - Number(record.lastSeenAt ?? record.createdAt ?? Date.now())),
        expires: lifetime === 400
          ? '长期有效'
          : `${String(Math.max(0, Math.ceil((record.expiresAt - Date.now()) / 86_400_000)))} 天后过期`,
      }))
    const html = settingsPage({
      config,
      runtime,
      devices,
      notice: url.searchParams.get('ok') ?? undefined,
      problem: url.searchParams.get('err') ?? undefined,
    })
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
    res.end(html)
    return true
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'GET, POST' })
    res.end()
    return true
  }

  let form
  try {
    form = new URLSearchParams(await readBody(req, 32 * 1024))
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('bad request\n')
    return true
  }

  const action = form.get('action') ?? 'save'

  if (action === 'revoke' || action === 'note') {
    const sig = form.get('sig') ?? ''
    const record = sessionRecords.find((item) => item.sig === sig)
    if (record === undefined) {
      redirect('?err=session')
      return true
    }
    if (action === 'revoke') {
      revokeBySignature(sig)
      log('gateway: one device revoked from settings page')
      redirect('?ok=revoked')
      return true
    }
    record.note = (form.get('note') ?? '').trim().slice(0, 60)
    sessionsDirty = true
    saveSessionRecords(true)
    redirect('?ok=noted')
    return true
  }

  if (action === 'rotate') {
    const next = { ...auth, sessionKey: newSessionKey(), updatedAt: now() }
    try {
      writeFileSync(AUTH_PATH, `${JSON.stringify(next, null, 2)}\n`)
    } catch {
      redirect('?err=write')
      return true
    }
    Object.assign(auth, next)
    // Rotating the key invalidates every cookie, so the device list starts empty
    // as well — otherwise stale rows linger with no way to clear them.
    sessionRecords = []
    revokedSessions.clear()
    saveSessionRecords(true)
    log('gateway: session key rotated and device list reset from settings page')
    redirect('?ok=rotated')
    return true
  }

  if (action === 'lock') {
    revokeSession(readCookie(req.headers.cookie, SESSION_COOKIE))
    res.writeHead(303, {
      location: '/_gw/login',
      'set-cookie': clearSessionCookie(config.tls !== null),
      'cache-control': 'no-store',
    })
    res.end()
    log('gateway: session locked from settings page')
    return true
  }

  if (action === 'password') {
    const current = form.get('currentPassword') ?? ''
    const nextPassword = form.get('newPassword') ?? ''
    const confirm = form.get('confirmPassword') ?? ''
    if (!verifyPassword(current, auth.scrypt) || nextPassword.length < 8 || nextPassword !== confirm) {
      redirect('?err=password')
      return true
    }
    const update = { ...auth, scrypt: hashPassword(nextPassword), updatedAt: now() }
    try {
      writeFileSync(AUTH_PATH, `${JSON.stringify(update, null, 2)}\n`)
    } catch {
      redirect('?err=write')
      return true
    }
    Object.assign(auth, update)
    revokeSession(readCookie(req.headers.cookie, SESSION_COOKIE))
    log('gateway: password changed from settings page')
    redirect('?ok=password-changed')
    return true
  }

  const parsed = parseSettingsForm(form, config)
  if (parsed.problem !== undefined) {
    redirect(`?err=${parsed.problem}`)
    return true
  }
  const next = parsed.value
  const restartNeeded = next.listenHost !== config.listenHost
    || next.listenPort !== config.listenPort
    || JSON.stringify(next.tls) !== JSON.stringify(config.tls)
  try {
    writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`)
  } catch {
    redirect('?err=write')
    return true
  }
  const portChanged = next.dshPort !== config.dshPort
  Object.assign(config, next)
  if (portChanged) invalidatePort()
  log(`gateway: config saved from settings page${restartNeeded ? ' (listener/TLS change needs a restart)' : ''}`)
  redirect('?ok=config-saved')
  return true
}

// ── request handling ────────────────────────────────────────────────────────

const agent = new Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16, timeout: 30_000 })

/** A reused keep-alive socket can already be closed by the Host; without a
 *  timeout such a request waits forever and the page just appears to hang. */
const UPSTREAM_TIMEOUT_MS = 20_000
const RETRYABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ERR_STREAM_PREMATURE_CLOSE'])

function isRetryable(error) {
  return RETRYABLE_CODES.has(String(error.code)) || /socket hang up|aborted|premature/i.test(String(error.message))
}

function wantsHtml(req) {
  return String(req.headers.accept ?? '').includes('text/html')
}

async function handleGatewayRoute(req, res, config, auth) {
  const url = new URL(req.url ?? '/', 'http://gateway.invalid')

  if (url.pathname === '/_gw/healthz') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: true, upstreamPort: cachedPort, authenticated: hasValidSession(req, auth) }))
    return true
  }

  // Lock = drop the gateway session. POST is what the in-page control uses; the
  // GET alias stays for bookmarks and manual links.
  if (url.pathname === '/_gw/lock' || url.pathname === '/_gw/logout') {
    revokeSession(readCookie(req.headers.cookie, SESSION_COOKIE))
    if (req.method === 'POST' && url.pathname === '/_gw/lock') {
      res.writeHead(204, { 'set-cookie': clearSessionCookie(config.tls !== null), 'cache-control': 'no-store' })
      res.end()
    } else {
      res.writeHead(303, { location: '/_gw/login', 'set-cookie': clearSessionCookie(config.tls !== null), 'cache-control': 'no-store' })
      res.end()
    }
    log(`gateway: session locked from ${clientKey(req)}`)
    return true
  }

  if (url.pathname === '/_gw/login') {
    const secure = config.tls !== null
    if (req.method === 'GET') {
      if (hasValidSession(req, auth)) {
        res.writeHead(303, { location: safeNext(url.searchParams.get('next') ?? '/'), 'cache-control': 'no-store' })
        res.end()
        return true
      }
      const state = lockState(req, config)
      const html = loginPage({ next: safeNext(url.searchParams.get('next') ?? '/'), lockedMinutes: state.locked ? state.minutes : undefined })
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
      res.end(html)
      return true
    }
    if (req.method === 'POST') {
      const state = lockState(req, config)
      if (state.locked) {
        const html = loginPage({ next: '/', lockedMinutes: state.minutes })
        res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': String(state.minutes * 60) })
        res.end(html)
        return true
      }
      let form
      try {
        form = new URLSearchParams(await readBody(req, 8192))
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('bad request\n')
        return true
      }
      const password = form.get('password') ?? ''
      const next = safeNext(form.get('next') ?? '/')
      if (verifyPassword(password, auth.scrypt)) {
        failures.delete(clientKey(req))
        const cookie = issueSessionCookie(auth, config.sessionDays, secure)
        registerSession(req, cookie.slice(`${SESSION_COOKIE}=`.length).split(';')[0])
        res.writeHead(303, {
          location: next,
          'set-cookie': cookie,
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        })
        res.end()
        log(`gateway: sign-in ok from ${clientKey(req)}`)
        return true
      }
      recordFailure(req, config)
      const after = lockState(req, config)
      const html = loginPage({
        next,
        lockedMinutes: after.locked ? after.minutes : undefined,
        error: after.locked ? undefined : '密码不正确。',
      })
      res.writeHead(after.locked ? 429 : 401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
      log(`gateway: sign-in failed from ${clientKey(req)}`)
      return true
    }
    res.writeHead(405, { allow: 'GET, POST' })
    res.end()
    return true
  }

  return false
}

function sendUpstreamFailure(res, detail) {
  if (res.headersSent || res.writableEnded || res.destroyed) {
    res.destroy?.()
    return
  }
  const html = errorPage('桌面版未就绪', detail)
  res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(html)
}

const NO_HOST_DETAIL = '没有找到桌面版 DeepSeek Harness 的 Host。请先启动桌面版，然后刷新本页。'

async function proxyRequest(req, res, config) {
  let port = await hostPort(config)
  if (port === null) {
    sendUpstreamFailure(res, NO_HOST_DETAIL)
    return
  }

  const attempt = (retry) => {
    const headers = rewriteRequestHeaders(req.headers, port, config.sessionDays)
    const upstream = httpRequest({ host: '127.0.0.1', port, method: req.method, path: req.url ?? '/', headers, agent, timeout: UPSTREAM_TIMEOUT_MS }, (upstreamRes) => {
      const status = upstreamRes.statusCode ?? 502
      const headersOut = {}
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined) continue
        if (HOP_BY_HOP.has(name.toLowerCase())) continue
        headersOut[name] = value
      }
      if (!isHtmlResponse(upstreamRes.headers)) {
        res.writeHead(status, headersOut)
        upstreamRes.pipe(res)
        return
      }
      const chunks = []
      let size = 0
      let overflow = false
      upstreamRes.on('data', (chunk) => {
        size += chunk.length
        if (size > HTML_BUFFER_LIMIT) {
          overflow = true
          return
        }
        chunks.push(chunk)
      })
      upstreamRes.on('end', () => {
        if (overflow) {
          res.writeHead(status, headersOut)
          res.end(Buffer.concat(chunks))
          return
        }
        const encoding = upstreamRes.headers['content-encoding']
        let body
        try {
          body = decodeBody(Buffer.concat(chunks), encoding)
        } catch {
          res.writeHead(status, headersOut)
          res.end(Buffer.concat(chunks))
          return
        }
        const markup = injectionMarkup(config)
        const injected = injectIntoHtml(body.toString('utf8'), markup)
        const encoded = encodeBody(Buffer.from(injected, 'utf8'), encoding)
        delete headersOut['content-length']
        headersOut['content-length'] = String(encoded.byteLength)
        res.writeHead(status, headersOut)
        res.end(encoded)
      })
      upstreamRes.on('error', () => res.destroy())
    })

    upstream.on('timeout', () => {
      const error = new Error('upstream timeout')
      error.code = 'ETIMEDOUT'
      upstream.destroy(error)
    })

    upstream.on('error', (error) => {
      if (retry && isRetryable(error)) {
        log(`gateway: upstream ${String(error.code ?? error.message)} on 127.0.0.1:${String(port)}; rediscovering and retrying`)
        // A pooled socket may be stale; drop the pool so the retry dials fresh.
        agent.destroy()
        invalidatePort()
        void hostPort(config, { force: true }).then((next) => {
          if (next === null) {
            sendUpstreamFailure(res, NO_HOST_DETAIL)
            return
          }
          port = next
          attempt(false)
        }).catch((retryError) => {
          log(`gateway: retry failed ${String(retryError?.message ?? retryError)}`)
          sendUpstreamFailure(res, '代理重试失败，请刷新页面。')
        })
        return
      }
      log(`gateway: upstream error ${error.code ?? error.message}`)
      if (!res.headersSent) sendUpstreamFailure(res, `代理转发失败：${error.message}`)
      else res.destroy()
    })

    req.pipe(upstream)
  }

  attempt(true)
}

function handleUpgrade(req, socket, head, config, auth) {
  const reject = (status, text) => {
    try {
      socket.write(`HTTP/1.1 ${String(status)} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    } catch {
      // ignore
    }
    socket.destroy()
  }

  if (!hasValidSession(req, auth)) {
    reject(401, 'Unauthorized')
    return
  }

  void (async () => {
    let port = await hostPort(config)
    if (port === null) {
      reject(502, 'Bad Gateway')
      return
    }
    let headers
    try {
      headers = rewriteRequestHeaders(req.headers, port, config.sessionDays)
    } catch (error) {
      log(`gateway: mint failure ${error.message}`)
      reject(500, 'Internal Server Error')
      return
    }
    const upstream = connect(port, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url ?? '/'} HTTP/1.1`]
      for (const [name, value] of Object.entries(headers)) {
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${String(item)}`)
      }
      // Preserve the upgrade-only headers the rewrite dropped.
      for (const [name, value] of Object.entries(req.headers)) {
        const key = name.toLowerCase()
        if (['upgrade', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol'].includes(key) && !(key in headers)) {
          lines.push(`${key}: ${String(value)}`)
        }
      }
      lines.push('connection: upgrade')
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.setTimeout(10_000, () => upstream.destroy())
    upstream.on('error', () => {
      invalidatePort()
      socket.destroy()
    })
    socket.on('error', () => upstream.destroy())
  })()
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2)

  const setPasswordAt = argv.indexOf('--set-password')
  if (setPasswordAt !== -1) {
    const password = argv[setPasswordAt + 1]
    if (password === undefined || password.length < 8) {
      process.stderr.write('usage: node server.mjs --set-password <password at least 8 chars>\n')
      process.exitCode = 2
      return
    }
    writeAuthFile(password)
    process.stdout.write(`password updated in ${AUTH_PATH}\n`)
    return
  }
  if (argv.includes('--generate-password')) {
    const generated = b64url(randomBytes(12))
    writeAuthFile(generated)
    process.stdout.write(`${generated}\n`)
    return
  }
  if (argv.includes('--rotate-session-key')) {
    const stored = readJson(AUTH_PATH, null)
    if (stored === null) {
      process.stderr.write(`gateway: ${AUTH_PATH} is missing; start the gateway once first\n`)
      process.exitCode = 1
      return
    }
    writeFileSync(AUTH_PATH, `${JSON.stringify({ ...stored, sessionKey: newSessionKey(), updatedAt: now() }, null, 2)}\n`)
    process.stdout.write('session key rotated: every signed-in browser must log in again (restart the gateway to apply)\n')
    return
  }

  const config = loadConfig()
  const auth = loadAuth({ allowInit: true })
  if (auth === null) {
    process.stderr.write('gateway: auth.json missing and could not be created\n')
    process.exitCode = 1
    return
  }

  // Validate the secret early so a broken credentials file fails at boot.
  try {
    secretSource.get()
    log(`gateway: signing secret loaded from ${credentialsPath()}`)
  } catch (error) {
    process.stderr.write(`gateway: ${error.message}\n`)
    process.exitCode = 1
    return
  }

  const startedAt = Date.now()
  loadSessionRecords()
  setInterval(() => saveSessionRecords(), 15_000).unref()

  const handler = (req, res) => {
    const started = Date.now()
    const path = (req.url ?? '/').split('?')[0]
    void (async () => {
      try {
        if (await handleGatewayRoute(req, res, config, auth)) {
          log(`gw ${req.method} ${path} ${String(res.statusCode)} ${String(Date.now() - started)}ms`)
          return
        }
        if (!hasValidSession(req, auth)) {
          if (req.method === 'GET' && wantsHtml(req)) {
            res.writeHead(303, { location: `/_gw/login?next=${encodeURIComponent(req.url ?? '/')}`, 'cache-control': 'no-store' })
            res.end()
          } else {
            res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
            res.end('gateway authentication required\n')
          }
          log(`gw ${req.method} ${path} 401 ${String(Date.now() - started)}ms`)
          return
        }
        const runtime = {
          upstreamPort: cachedPort,
          uptime: formatUptime(Date.now() - startedAt),
          revokedCount: revokedSessions.size,
        }
        if (await handleSettingsRoute(req, res, config, auth, runtime)) {
          log(`gw ${req.method} ${path} ${String(res.statusCode)} ${String(Date.now() - started)}ms`)
          return
        }
        res.on('finish', () => log(`gw ${req.method} ${path} ${String(res.statusCode)} ${String(Date.now() - started)}ms`))
        await proxyRequest(req, res, config)
      } catch (error) {
        log(`gw error ${req.method} ${path}: ${error.message}`)
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('gateway error\n')
        } else {
          res.destroy()
        }
      }
    })()
  }

  let server
  if (config.tls !== null && config.tls !== undefined) {
    server = createHttpsServer({ cert: readFileSync(config.tls.cert), key: readFileSync(config.tls.key) }, handler)
  } else {
    server = createHttpServer(handler)
  }
  server.timeout = 0
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  server.keepAliveTimeout = 65_000
  server.on('upgrade', (req, socket, head) => {
    log(`gw upgrade ${(req.url ?? '/').split('?')[0]}`)
    handleUpgrade(req, socket, head, config, auth)
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.listenPort, config.listenHost, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const scheme = config.tls === null || config.tls === undefined ? 'http' : 'https'
  log(`gateway: listening on ${scheme}://${config.listenHost}:${String(config.listenPort)}`)
  log(`gateway: settings at ${scheme}://${config.listenHost}:${String(config.listenPort)}/_gw/settings`)
  const found = await hostPort(config, { force: true })
  if (found !== null) log(`gateway: desktop host port ${String(found)} — open ${scheme}://${config.listenHost}:${String(config.listenPort)} on your phone`)

  const shutdown = () => {
    log('gateway: shutting down')
    saveSessionRecords(true)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // This process is a long-lived proxy: an unexpected rejection in one request
  // path must not take the whole gateway (and every phone session) down.
  process.on('unhandledRejection', (reason) => {
    log(`gateway: unhandled rejection ${String(reason?.stack ?? reason)}`)
  })
  process.on('uncaughtException', (error) => {
    log(`gateway: uncaught exception ${String(error?.stack ?? error)}`)
  })
}

await main()
