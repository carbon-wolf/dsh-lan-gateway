#!/usr/bin/env node
// Keep the gateway alive whenever the Desktop app is running.
//
// The Desktop host binds 127.0.0.1 with an OS-assigned port and its lifetime is
// the app's lifetime, so "start the gateway when Harness starts" is the same as
// "make sure the gateway is up while the Desktop host exists". This watcher
// polls cheaply (one CIM query, no HTTP scanning) and spawns the gateway
// detached the first time it sees the host.
//
// usage:
//   node watch-gateway.mjs            run forever (log to gateway/logs/watch-YYYY-MM-DD.log)
//   node watch-gateway.mjs --once     single check, prints what it would do
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lookupDesktopPort } from './gateway/discover.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const GW_DIR = join(HERE, 'gateway')
const CONFIG_PATH = join(GW_DIR, 'config.json')
const SERVER = join(GW_DIR, 'server.mjs')
const LOG_DIR = join(GW_DIR, 'logs')
const INTERVAL_MS = 5000
const once = process.argv.includes('--once')

function stamp() {
  return new Date().toISOString()
}

function note(message) {
  const line = `[${stamp()}] watch: ${message}`
  process.stdout.write(`${line}\n`)
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    writeFileSync(join(LOG_DIR, `watch-${new Date().toISOString().slice(0, 10)}.log`), `${line}\n`, { flag: 'a' })
  } catch {
    // best effort
  }
}

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return { listenHost: '127.0.0.1', listenPort: 3080 }
  }
}

function portOpen(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (value) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

async function gatewayRunning(config) {
  const hosts = [config.listenHost, '127.0.0.1'].filter((value) => typeof value === 'string' && value !== '')
  for (const host of hosts) {
    if (await portOpen(host, config.listenPort)) return true
  }
  return false
}

function startGateway() {
  const child = spawn(process.execPath, [SERVER], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: GW_DIR,
  })
  child.unref()
  note(`gateway spawned (pid ${String(child.pid ?? 'unknown')})`)
}

async function tick() {
  const config = loadConfig()
  const port = await lookupDesktopPort()
  const running = await gatewayRunning(config)

  if (port === null) {
    if (once) note('desktop host not running; gateway untouched')
    return
  }
  if (running) {
    if (once) note(`gateway already listening on ${String(config.listenPort)}; desktop host on 127.0.0.1:${String(port)}`)
    return
  }
  note(`desktop host detected on 127.0.0.1:${String(port)}; starting gateway`)
  if (!once) startGateway()
}

if (once) {
  await tick()
  process.exit(0)
}

note('watching for the DeepSeek Harness desktop host')
await tick()
setInterval(() => {
  tick().catch((error) => note(`tick failed: ${error.message}`))
}, INTERVAL_MS).unref?.()
// Keep the process alive on the interval alone.
process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
