// Discover the loopback port of the running DeepSeek Harness Host that the
// Desktop app started. The Desktop host binds 127.0.0.1 with an OS-assigned
// port (dsh-desktop-host passes --host 127.0.0.1 --port 0), so the port is
// re-discovered whenever the upstream refuses a connection.
import { execFile } from 'node:child_process'
import { connect } from 'node:net'
import { join } from 'node:path'

const PS = join(process.env.SystemRoot ?? 'C:\\WINDOWS', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

const WMI_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$p = Get-CimInstance Win32_Process -Filter \"Name='DeepSeek Harness.exe'\" |",
  "  Where-Object { $_.CommandLine -like '*dsh-desktop-host*' } | Select-Object -First 1",
  'if ($p) {',
  '  $c = Get-NetTCPConnection -State Listen -OwningProcess $p.ProcessId |',
  "    Where-Object { $_.LocalAddress -eq '127.0.0.1' } | Select-Object -First 1",
  '  if ($c) { [Console]::Out.Write([string]$c.LocalPort) }',
  '}',
].join('\n')

function runPowerShell(script, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      resolve(error === null ? String(stdout).trim() : '')
    })
  })
}

/**
 * Ask Windows which loopback port the Desktop host process listens on.
 * Cheap enough to poll (one CIM query, no HTTP probes, no scanning).
 * @returns {Promise<number|null>}
 */
export async function lookupDesktopPort() {
  const output = await runPowerShell(WMI_SCRIPT)
  const port = Number.parseInt(output, 10)
  return Number.isInteger(port) && port > 0 ? port : null
}

/** True when something accepts TCP on the loopback port. */
export function isOpen(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
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

/** Identify a candidate port as the DSH Host by its unauthenticated 401 reply. */
async function looksLikeDsh(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/`, { signal: AbortSignal.timeout(1200) })
    if (response.status === 401) {
      const text = await response.text()
      return /dsh web authentication required/i.test(text)
    }
    if (response.status === 200) {
      const text = await response.text()
      return /__DSH_|DeepSeek Harness/.test(text)
    }
  } catch {
    // closed or not HTTP: fall through
  }
  return false
}

/**
 * Find the Desktop Host port.
 * @param {object} options
 * @param {number|null} [options.fixedPort] configured override, verified before use
 * @param {number[]} [options.scanRanges] fallback candidate ports
 * @returns {Promise<{port:number, via:string}|null>}
 */
export async function discoverHostPort({ fixedPort = null, scanRanges = [[1200, 1400], [3000, 9100]] } = {}) {
  if (typeof fixedPort === 'number' && await isOpen(fixedPort) && await looksLikeDsh(fixedPort)) {
    return { port: fixedPort, via: 'config' }
  }

  const wmiPort = await lookupDesktopPort()
  if (wmiPort !== null && await looksLikeDsh(wmiPort)) {
    return { port: wmiPort, via: 'wmi' }
  }

  for (const [start, end] of scanRanges) {
    const candidates = []
    for (let port = start; port <= end; port += 1) candidates.push(port)
    const open = []
    const chunk = 96
    for (let index = 0; index < candidates.length; index += chunk) {
      const slice = candidates.slice(index, index + chunk)
      const results = await Promise.all(slice.map(async (port) => (await isOpen(port, 120) ? port : null)))
      for (const port of results) if (port !== null) open.push(port)
    }
    for (const port of open) {
      if (await looksLikeDsh(port)) return { port, via: 'scan' }
    }
  }
  return null
}
