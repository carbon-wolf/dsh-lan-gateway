# 停止托盘宿主与网关（由 stop-tray.cmd 调用）。
#
# 托盘自己会把 PID 写进 tray\tray.pid，这里按 PID 精确结束，避免按命令行匹配
# 误杀调用方的父 shell。网关进程按端口兜底清理。

$ErrorActionPreference = 'Continue'

$pidFile = Join-Path $PSScriptRoot 'tray.pid'

function Get-GatewayPort {
  $candidates = @(
    (Join-Path $PSScriptRoot '..\config.json'),
    (Join-Path $PSScriptRoot '..\gateway\config.json')
  )
  foreach ($path in $candidates) {
    if (-not (Test-Path $path)) { continue }
    try {
      $config = Get-Content $path -Raw | ConvertFrom-Json
      if ($config.listenPort) { return [int]$config.listenPort }
    } catch { }
  }
  return 3080
}

$stoppedTray = 0
if (Test-Path $pidFile) {
  $raw = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  $trayPid = 0
  if ($raw -and [int]::TryParse($raw.Trim(), [ref]$trayPid) -and $trayPid -gt 0) {
    $process = Get-Process -Id $trayPid -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -like '*powershell*') {
      Stop-Process -Id $trayPid -Force -ErrorAction SilentlyContinue
      $stoppedTray = 1
    }
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

$port = Get-GatewayPort
$stoppedGateway = 0
$owners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique
foreach ($owner in $owners) {
  Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
  $stoppedGateway += 1
}

if ($stoppedTray -eq 0 -and $stoppedGateway -eq 0) {
  Write-Host ('没有找到运行中的托盘或网关（端口 ' + $port + '）')
} else {
  Write-Host ('已停止托盘 ' + $stoppedTray + ' 个进程，网关 ' + $stoppedGateway + ' 个进程（端口 ' + $port + '）')
}
