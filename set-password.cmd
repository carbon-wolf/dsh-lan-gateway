@echo off
chcp 65001 >nul
setlocal
call "%~dp0_node.cmd" || (pause & exit /b 1)
set /p "PW=新的网关密码（至少 8 位）："
if "%PW%"=="" goto :empty
"%NODE%" "%~dp0gateway\server.mjs" --set-password "%PW%"
echo 已更新；重启网关后生效。
pause
exit /b 0
:empty
echo 未输入，密码保持不变。
pause
