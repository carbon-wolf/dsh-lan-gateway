@echo off
chcp 65001 >nul
setlocal
call "%~dp0_node.cmd" || (pause & exit /b 1)
echo 用法:
echo   verify.cmd ^<网关密码^> [宽] [高]          用密码登录后核验并截图
echo   verify.cmd --from-auth gateway\auth.json [--test-lock]   不输密码核验
if "%~1"=="" (
  exit /b 2
)
echo %~1 | findstr /b /c:"--" >nul
if errorlevel 1 (
  if "%~2"=="" (
    "%NODE%" "%~dp0verify\mobile-check.mjs" --password "%~1"
  ) else (
    "%NODE%" "%~dp0verify\mobile-check.mjs" --password "%~1" --width %2 --height %3 --out mobile-%2.png
  )
) else (
  "%NODE%" "%~dp0verify\mobile-check.mjs" %*
)
