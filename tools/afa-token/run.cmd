@echo off
chcp 65001 >nul
title AFA Token Tool
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js not found in PATH.
  echo         Install Node.js 18+ and run this file again.
  echo.
  pause
  exit /b 2
)
node "%~dp0index.js" %*
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" (
  echo Done. You can close this window.
) else (
  echo Exit code: %RC%
)
pause
exit /b %RC%
