@echo off
chcp 65001 >nul
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$cfg = Get-Content '%~dp0gateway\config.json' -Raw | ConvertFrom-Json; $port = if ($cfg.listenPort) { $cfg.listenPort } else { 3080 }; $pids = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; if ($pids) { foreach ($id in $pids) { Stop-Process -Id $id -Force; Write-Host ('已停止网关进程 ' + $id) } } else { Write-Host ('端口 ' + $port + ' 上没有网关在监听') }"
