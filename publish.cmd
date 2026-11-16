@echo off
chcp 65001 >nul
setlocal
rem 首次推送：先在 GitHub 网页新建一个空仓库（不要勾选 README / .gitignore / LICENSE），
rem 再把仓库地址作为参数传进来。
if "%~1"=="" (
  echo 用法: publish.cmd ^<仓库地址^>
  echo 例如: publish.cmd https://github.com/^<你的账号^>/dsh-lan-gateway.git
  echo.
  echo 还没建仓库？打开 https://github.com/new ，仓库名建议 dsh-lan-gateway，
  echo 可见性随意，千万别勾选 “Add a README file”。
  exit /b 2
)
git remote remove origin >nul 2>&1
git remote add origin %~1
git branch -M main
git push -u origin main
if errorlevel 1 (
  echo.
  echo 推送失败：通常是还没有认证。任选一种方式再试：
  echo   1^) 安装 GitHub CLI 后运行: gh auth login
  echo   2^) 使用个人访问令牌: 推送时用户名填账号、密码填 PAT
  echo   3^) 在 GitHub Desktop / VS Code 里登录一次后重试
) else (
  echo.
  echo 已推送。之后打开仓库的 Settings -^> Pages 可考虑放文档站，或在 About 里加 topics。
)
pause
