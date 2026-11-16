@echo off
chcp 65001 >nul
setlocal
call "%~dp0_node.cmd" || (pause & exit /b 1)
echo 前台启动网关（Ctrl+C 停止）。日志同时写入 gateway\logs\。
echo.
"%NODE%" "%~dp0gateway\server.mjs" %*
echo.
echo 网关已退出，代码 %ERRORLEVEL%。
pause
