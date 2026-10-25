@echo off
chcp 936 >nul
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo 正在安装依赖，请稍候...
  call npm install
  if errorlevel 1 (
    echo 安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

start "" "node_modules\electron\dist\electron.exe" .
