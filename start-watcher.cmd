@echo off
chcp 65001 >nul
setlocal
call "%~dp0_node.cmd" || (pause & exit /b 1)
start "DSH gateway watcher" /min "%NODE%" "%~dp0watch-gateway.mjs"
echo 守护进程已启动：只要桌面版 DeepSeek Harness 在运行，网关就会自动就位。
timeout /t 2 >nul
