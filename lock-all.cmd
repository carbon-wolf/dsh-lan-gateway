@echo off
chcp 65001 >nul
setlocal
call "%~dp0_node.cmd" || (pause & exit /b 1)
echo 轮换签名密钥：所有已登录设备（手机、平板、浏览器）都会被登出。
"%NODE%" "%~dp0gateway\server.mjs" --rotate-session-key || goto :done
echo 正在重启网关…
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$cfg = Get-Content '%~dp0gateway\config.json' -Raw | ConvertFrom-Json; $port = if ($cfg.listenPort) { $cfg.listenPort } else { 3080 }; $pids = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; foreach ($id in $pids) { Stop-Process -Id $id -Force }; Start-Sleep -Milliseconds 800; Start-Process -FilePath '%NODE%' -ArgumentList '%~dp0gateway\server.mjs' -WindowStyle Minimized"
echo 完成。
:done
pause
