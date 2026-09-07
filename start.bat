@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo [1] boot > start.log
set "NODE=node.exe"
if exist "%~dp0node.exe" set "NODE=%~dp0node.exe"

echo [2] node=%NODE% >> start.log
if not exist "%NODE%" (
  echo [E] node not found >> start.log
  echo 未检测到 Node.js，请先安装：https://nodejs.org
  pause
  exit /b 1
)

echo [3] open browser + run server >> start.log
start "" http://localhost:8080
"%NODE%" server.js

echo [4] server exited >> start.log
echo 服务已停止。按任意键关闭窗口。
pause >nul
