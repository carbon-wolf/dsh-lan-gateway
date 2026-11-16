@echo off
rem Resolve a Node.js executable into %NODE%. Called by the other .cmd files.
set "NODE="
where node >nul 2>&1 && set "NODE=node"
if not defined NODE if exist "D:\nodejs\node.exe" set "NODE=D:\nodejs\node.exe"
if not defined NODE (
  echo 未找到 Node.js。请先安装 Node.js 20+（https://nodejs.org），再重新运行。
  exit /b 1
)
exit /b 0
