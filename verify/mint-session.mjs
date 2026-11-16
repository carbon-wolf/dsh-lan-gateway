// Print a gateway session cookie signed with gateway/auth.json's key.
// Useful for scripted checks without knowing the password:
//   node verify/mint-session.mjs > cookie.txt
//   curl -H "Cookie: $(cat cookie.txt)" http://192.168.1.192:3080/_gw/settings
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const authPath = process.argv[2] ?? join(HERE, '..', 'gateway', 'auth.json')
const hours = Number(process.argv[3] ?? 1)
const auth = JSON.parse(readFileSync(authPath, 'utf8'))
const expiresAt = Date.now() + hours * 3_600_000
const signature = createHmac('sha256', Buffer.from(auth.sessionKey, 'base64'))
  .update(`dshgw.${String(expiresAt)}`)
  .digest('base64url')
process.stdout.write(`dshgw=${String(expiresAt)}.${signature}`)
