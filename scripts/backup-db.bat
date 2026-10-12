@echo off
REM ============================================================
REM  invoice-bot database backup (mysqldump)
REM  Usage:  scripts\backup-db.bat        (or npm run db:backup)
REM  Output: data\backups\invoice_bot-YYYYMMDD_HHMMSS.sql
REM  Retain: newest 14 files, older ones are deleted
REM ============================================================
setlocal enabledelayedexpansion
set "MYSQL_HOME=C:\Users\hspcadmin\WorkBuddy\mysql"
set "MYSQL_PORT=3306"
set "DB=invoice_bot"
set "OUT_DIR=%~dp0..\data\backups"

if not exist "%MYSQL_HOME%\bin\mariadb-dump.exe" (
  echo [ERROR] mariadb-dump.exe not found under %MYSQL_HOME%\bin\
  exit /b 1
)

REM 先确认 MySQL 在跑
"%MYSQL_HOME%\bin\mariadb-admin.exe" -h127.0.0.1 -P%MYSQL_PORT% -uroot -pinvoice123 ping >nul 2>&1
if not %errorlevel%==0 (
  echo [ERROR] MySQL is not running. Run scripts\mysql-start.bat first.
  exit /b 1
)

if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"

for /f "tokens=1-4 delims=/:. " %%a in ("%date% %time%") do set TS=%%a%%b%%c%%d
REM 兼容不同区域设置的日期格式：统一用 powershell 生成时间戳
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set TS=%%i

set "OUT_FILE=%OUT_DIR%\%DB%-%TS%.sql"
echo Dumping %DB% -^> %OUT_FILE% ...
"%MYSQL_HOME%\bin\mariadb-dump.exe" -h127.0.0.1 -P%MYSQL_PORT% -uroot -pinvoice123 --default-character-set=utf8mb4 --single-transaction --routines "%DB%" > "%OUT_FILE%"

if not %errorlevel%==0 (
  echo [FAIL] Dump failed, see error above.
  del "%OUT_FILE%" 2>nul
  exit /b 1
)

for %%f in ("%OUT_FILE%") do echo [OK] Wrote %%~zf bytes

REM 只保留最近 14 个备份
for /f %%i in ('dir /b /o-n "%OUT_DIR%\%DB%-*.sql" 2^>nul ^| find /c /v ""') do set CNT=%%i
if !CNT! GTR 14 (
  for /f "skip=14 delims=" %%f in ('dir /b /o-n "%OUT_DIR%\%DB%-*.sql"') do (
    echo [CLEAN] Removing old backup %%f
    del "%OUT_DIR%\%%f"
  )
)

dir /b /o-n "%OUT_DIR%\%DB%-*.sql" | more
echo [DONE] Backups kept: 14 newest in %OUT_DIR%
endlocal
