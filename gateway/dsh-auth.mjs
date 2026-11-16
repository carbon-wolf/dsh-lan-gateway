// Mint the DeepSeek Harness browser-session cookie for the desktop Host.
//
// The Host verifies a cookie as:
//   name  = 'dsh-auth-' + base64url(sha256(authority))       // authority = Host header
//   value = 'v1.' + base64url(JSON {version:1,authority,issuedAt,expiresAt}) + '.' + base64url(HMAC-SHA256(secret, body))
// The signing secret lives in the Harness home credentials file under
// `client-connection/browser-session`; the gateway reads it read-only.
import { createHash, createHmac } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const RECORD_KEY = 'client-connection/browser-session'
const MAX_COOKIE_DAYS = 30

function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
}

export function credentialsPath() {
  return join(dshHome(), '.credentials.yaml')
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/**
 * Read the browser-session signing secret out of the credentials YAML.
 * The file is a small, fixed-shape document; only the one record is parsed.
 * @returns {Buffer} 32-byte secret
 */
export function readSigningSecret() {
  const path = credentialsPath()
  const text = readFileSync(path, 'utf8')
  const lines = text.split(/\r?\n/u)
  let inside = false
  for (const line of lines) {
    if (!inside) {
      if (line.trim() === `${RECORD_KEY}:`) inside = true
      continue
    }
    if (/^\S/u.test(line) && line.trim() !== '') break
    const match = /^\s+secret:\s*(\S+)\s*$/u.exec(line)
    if (match !== null) {
      const decoded = Buffer.from(match[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64')
      if (decoded.byteLength !== 32) throw new Error(`dsh-auth: ${RECORD_KEY}.secret is ${String(decoded.byteLength)} bytes, expected 32`)
      return decoded
    }
  }
  throw new Error(`dsh-auth: no ${RECORD_KEY}.secret in ${path}; open the Desktop window once so the Host creates it`)
}

/** Secret holder that reloads when the credentials file changes. */
export class SecretSource {
  #secret = null
  #mtime = 0

  get() {
    let mtime = 0
    try {
      mtime = statSync(credentialsPath()).mtimeMs
    } catch {
      throw new Error(`dsh-auth: ${credentialsPath()} is unreadable`)
    }
    if (this.#secret === null || mtime !== this.#mtime) {
      this.#secret = readSigningSecret()
      this.#mtime = mtime
    }
    return this.#secret
  }
}

/**
 * Build one browser-session cookie for an authority.
 * @param {string} authority Host authority the browser uses, e.g. `127.0.0.1:1215`
 * @param {Buffer} secret signing secret
 * @param {number} days cookie lifetime, at most 30
 * @returns {{header:string, name:string}}
 */
export function mintCookie(authority, secret, days = MAX_COOKIE_DAYS) {
  const lifetime = Math.min(Math.max(1, Math.floor(days)), MAX_COOKIE_DAYS) * 24 * 60 * 60 * 1000
  const issuedAt = Date.now()
  const expiresAt = issuedAt + lifetime - 60_000
  const body = base64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8'))
  const signature = base64url(createHmac('sha256', secret).update(body).digest())
  const name = `dsh-auth-${base64url(createHash('sha256').update(authority).digest())}`
  return { name, header: `${name}=v1.${body}.${signature}` }
}
