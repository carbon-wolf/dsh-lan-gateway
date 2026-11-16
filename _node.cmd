@echo off
rem Resolve a Node.js executable into %NODE%.
rem Order: the bundled portable runtime (release zip), PATH, then a common install path.
set "NODE="
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"
if not defined NODE (
  where node >nul 2>&1 && set "NODE=node"
)
if not defined NODE if exist "D:\nodejs\node.exe" set "NODE=D:\nodejs\node.exe"
if not defined NODE (
  echo 未找到 Node.js。
  echo 如果用的是 release 包，请确认 node\node.exe 与本脚本在同一目录；
  echo 否则请安装 Node.js 20+（https://nodejs.org）后重试。
  exit /b 1
)
exit /b 0
