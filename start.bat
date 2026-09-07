@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "NODE=node"
rem 默认 GM 口令，可改。任何人输入该口令即获得 GM 权限（可见/管理所有频道）。
set "GM_CODE=warden"

rem 优先用同目录自带的 node.exe（免安装 Node 即可运行）
if exist "%~dp0node.exe" (
  set "NODE=%~dp0node.exe"
) else if exist "C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-2\node.exe" (
  set "NODE=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-2\node.exe"
)

if not exist "%NODE%" (
  where node >nul 2>nul
  if %errorlevel%==0 ( set "NODE=node" ) else (
    echo 未检测到 Node.js，请先安装：https://nodejs.org
    pause
    exit /b 1
  )
)

echo 正在启动母舰通讯终端...
"%NODE%" server.js
pause
