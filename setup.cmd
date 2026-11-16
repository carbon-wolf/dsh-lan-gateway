@echo off
chcp 65001 >nul
setlocal
call "%~dp0_node.cmd" || (pause & exit /b 1)
"%NODE%" "%~dp0setup.mjs" %*
echo.
pause
