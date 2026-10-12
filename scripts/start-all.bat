@echo off
REM ============================================================
REM  invoice-bot one-click start (MySQL + console server)
REM  Usage:  scripts\start-all.bat        (or npm run start:all)
REM  机器重启后跑这一个就够了。
REM ============================================================
setlocal
set "ROOT=%~dp0.."

echo [1/2] Starting MySQL ...
call "%~dp0mysql-start.bat"
if %errorlevel%==1 (
  echo [ABORT] MySQL failed to start - server not started.
  exit /b 1
)

echo.
echo [2/2] Starting console server (http://localhost:8787) ...
cd /d "%ROOT%"
node server.js
endlocal
