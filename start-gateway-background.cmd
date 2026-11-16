@echo off
chcp 65001 >nul
setlocal
call "%~dp0_node.cmd" || (pause & exit /b 1)
start "DSH gateway" /min "%NODE%" "%~dp0gateway\server.mjs"
echo 网关已在后台启动。日志：%~dp0gateway\logs\
timeout /t 2 >nul
