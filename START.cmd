@echo off
chcp 65001 >nul
cd /d "%~dp0"
title DSH 局域网网关
echo ============================================
echo  DeepSeek Harness 局域网网关 - 一键启动
echo ============================================
echo.
call "%~dp0_node.cmd" || (echo & pause & exit /b 1)
"%NODE%" "%~dp0setup.mjs" --yes --start
echo.
echo 上面是手机访问地址和密码。把密码存好，之后可在设置页修改。
echo 关闭本窗口不会停止网关；需要停止请运行 stop-gateway.cmd
echo.
pause
