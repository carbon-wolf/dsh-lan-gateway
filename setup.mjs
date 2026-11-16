#!/usr/bin/env node
// One-shot setup for a fresh machine (the "小白" path).
//
//   node setup.mjs             interactive: pick the LAN IP, set a password
//   node setup.mjs --yes       non-interactive, generates the password
//   node setup.mjs --list-ips  print candidate LAN addresses and exit
//
// Writes gateway/config.json + gateway/auth.json, optionally adds a sign-in
// autostart entry, then starts the watcher. It never touches DSH itself.
import { spawn } from 'node:child_process'
import { randomBytes, scryptSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const GW_DIR = join(HERE, 'gateway')
const CONFIG_PATH = join(GW_DIR, 'config.json')
const AUTH_PATH = join(GW_DIR, 'auth.json')
const WATCHER = join(HERE, 'watch-gateway.mjs')

const argv = process.argv.slice(2)
const auto = argv.includes('--yes')

function candidates() {
  const found = []
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      if (address.address.startsWith('169.254.')) continue
      found.push({ name, address: address.address })
    }
  }
  return found
}

if (argv.includes('--list-ips')) {
  for (const entry of candidates()) console.log(`${entry.address}\t${entry.name}`)
  process.exit(0)
}

const list = candidates()
if (list.length === 0) {
  console.error('没有找到局域网 IPv4 地址：请先连上 WiFi 或网线，再运行本脚本。')
  process.exit(1)
}

const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = async (text) => (await rl.question(text)).trim()

let chosen = list[0]
let port = 3080
let password = ''
let autostart = false

if (auto) {
  password = randomBytes(12).toString('base64url')
} else {
  console.log('本机的局域网地址：')
  list.forEach((entry, index) => console.log(`  ${String(index + 1)}) ${entry.address}  (${entry.name})`))
  const pick = await ask(`\n用哪个地址给手机访问？[1-${String(list.length)}，默认 1] `)
  const index = Number(pick === '' ? 1 : pick)
  if (Number.isInteger(index) && index >= 1 && index <= list.length) chosen = list[index - 1]
  const portText = await ask('端口 [默认 3080] ')
  if (portText !== '') port = Number(portText)
  password = await ask('网关密码（至少 8 位，直接回车自动生成） ')
  autostart = /^y?$/iu.test(await ask('是否随开机自动启动 watcher？[Y/n] '))
  if (password === '') password = randomBytes(12).toString('base64url')
}
rl.close()

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error('端口不合法。')
  process.exit(1)
}
if (password.length < 8) {
  console.error('密码至少 8 位。')
  process.exit(1)
}

const config = {
  listenHost: chosen.address,
  listenPort: port,
  sessionDays: 30,
  maxFailures: 8,
  lockMinutes: 15,
  dshPort: null,
  tls: null,
  inject: { css: true, js: true },
}
mkdirSync(GW_DIR, { recursive: true })
writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`)

const salt = randomBytes(16)
const previous = existsSync(AUTH_PATH) ? JSON.parse(readFileSync(AUTH_PATH, 'utf8')) : null
const auth = {
  scrypt: {
    salt: salt.toString('base64'),
    hash: scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 32768 * 8 * 2 }).toString('base64'),
  },
  sessionKey: previous?.sessionKey ?? randomBytes(32).toString('base64'),
  updatedAt: new Date().toISOString(),
}
writeFileSync(AUTH_PATH, `${JSON.stringify(auth, null, 2)}\n`)

console.log(`\n配置已写入 ${CONFIG_PATH}`)
console.log(`手机访问地址：http://${chosen.address}:${String(port)}`)
if (auto) console.log(`网关密码（自动生成，请保存）：${password}`)
else console.log('网关密码已保存。')

if (autostart) {
  // Sign-in autostart through the Startup folder: no admin rights required.
  const startup = join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
  const target = join(startup, 'DSH-gateway-watcher.cmd')
  try {
    mkdirSync(startup, { recursive: true })
    writeFileSync(target, `@echo off\r\nstart "DSH gateway watcher" /min "${process.execPath}" "${WATCHER}"\r\n`)
    console.log(`已加入开机自启：${target}`)
  } catch {
    console.log('写入启动文件夹失败；可手动运行 install-autostart.cmd。')
  }
}

const child = spawn(process.execPath, [WATCHER], { detached: true, stdio: 'ignore', windowsHide: true, cwd: GW_DIR })
child.unref()
console.log('watcher 已在后台运行：只要桌面版 DeepSeek Harness 在跑，网关就会自动就位。')
console.log(`设置页（登录后可改配置与密码）：http://${chosen.address}:${String(port)}/_gw/settings`)
