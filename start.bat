@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 微信伴侣

echo ============================================
echo   微信伴侣 · 一键启动
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [X] 没有找到 Node.js。
  echo     请先安装 Node 20 或更高版本： https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo [OK] Node 已就绪
echo.
echo   控制台地址： http://127.0.0.1:43121/
echo   关闭这个窗口即可停止她。
echo.

node src/main.js
set EXITCODE=%errorlevel%

echo.
if not "%EXITCODE%"=="0" (
  echo [X] 启动失败（退出码 %EXITCODE%），请看上面的输出。
  echo     若提示还没绑定微信，先运行：  npm run login
) else (
  echo 她已停止。
)
echo.
pause
