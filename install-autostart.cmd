@echo off
chcp 65001 >nul
setlocal
set "TARGET=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\DSH-gateway-watcher.cmd"
call "%~dp0_node.cmd" || (pause & exit /b 1)
> "%TARGET%" echo @echo off
>>"%TARGET%" echo start "DSH gateway watcher" /min "%NODE%" "%~dp0watch-gateway.mjs"
echo 已写入开机自启项：%TARGET%
echo 登录 Windows 后守护进程会自动启动，并在检测到 DeepSeek Harness 时拉起网关。
echo 取消自启请运行 remove-autostart.cmd
timeout /t 4 >nul
