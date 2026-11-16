@echo off
chcp 65001 >nul
setlocal
set "TARGET=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\DSH-gateway-watcher.cmd"
if exist "%TARGET%" del /q "%TARGET%" && echo Removed: %TARGET%
schtasks /Delete /TN "DSH Gateway Watcher" /F >nul 2>&1 && echo Removed scheduled task "DSH Gateway Watcher".
echo A watcher that is already running keeps running; close its window to stop it.
timeout /t 3 >nul
