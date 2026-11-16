@echo off
chcp 65001 >nul
setlocal
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0stop-tray.ps1"
ping -n 3 127.0.0.1 >nul
