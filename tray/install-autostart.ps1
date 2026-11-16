# 把托盘加入开机启动：向启动文件夹写一个 ASCII 的 .vbs，登录时静默拉起托盘。
$ErrorActionPreference = 'Stop'

$startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$target = Join-Path $startup 'DSH网关托盘.vbs'
$trayScript = Join-Path $PSScriptRoot 'dsh-gateway-tray.ps1'

if (-not (Test-Path $trayScript)) {
  Write-Host ('找不到托盘脚本：' + $trayScript)
  exit 1
}

$lines = @(
  "' Start the DSH gateway tray silently at sign-in.",
  'Set shell = CreateObject("WScript.Shell")',
  ('shell.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ""' + $trayScript + '""", 0, False')
)
New-Item -ItemType Directory -Force -Path $startup | Out-Null
Set-Content -Path $target -Value $lines -Encoding ASCII

Write-Host ('已加入开机启动：' + $target)
Write-Host '提示：托盘脚本需要和 dsh-gateway.exe（或 gateway 目录）位于同一父目录。'
Write-Host '取消自启请运行 remove-autostart.cmd。'
