@echo off
chcp 65001 >nul
setlocal
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0install-autostart.ps1"
echo.
pause
