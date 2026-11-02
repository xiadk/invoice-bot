@echo off
chcp 65001 >nul
title JD Bmall Probe
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js not found in PATH.
  echo.
  pause
  exit /b 2
)
node "%~dp0index.js" %*
set RC=%ERRORLEVEL%
echo.
pause
exit /b %RC%
