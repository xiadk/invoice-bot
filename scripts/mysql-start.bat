@echo off
REM ============================================================
REM  invoice-bot local MySQL (MariaDB 11.4) starter
REM  Usage:  scripts\mysql-start.bat     (double click or npm run db:start)
REM ============================================================
setlocal enabledelayedexpansion
set "MYSQL_HOME=C:\Users\hspcadmin\WorkBuddy\mysql"
set "MYSQL_PORT=3306"

if not exist "%MYSQL_HOME%\bin\mysqld.exe" (
  echo [ERROR] mysqld.exe not found under %MYSQL_HOME%\bin\
  echo         Please check the MariaDB installation path.
  exit /b 1
)

netstat -ano | findstr ":%MYSQL_PORT% " | findstr LISTENING >nul 2>&1
if %errorlevel%==0 (
  echo [SKIP] Port %MYSQL_PORT% is already listening - MySQL seems to be running.
  goto :check
)

echo Starting MySQL (MariaDB) on port %MYSQL_PORT% ...
start "" /B "%MYSQL_HOME%\bin\mysqld.exe" --defaults-file="%MYSQL_HOME%\my.ini"
echo Waiting for the server to accept connections (up to 30s) ...
for /l %%i in (1,1,30) do (
  "%MYSQL_HOME%\bin\mariadb-admin.exe" -h127.0.0.1 -P%MYSQL_PORT% -uroot -pinvoice123 ping >nul 2>&1
  if !errorlevel! EQU 0 goto :check
  timeout /t 1 /nobreak >nul
)

:check
"%MYSQL_HOME%\bin\mariadb.exe" -h127.0.0.1 -P%MYSQL_PORT% -uroot -pinvoice123 -e "SELECT VERSION() AS version;" 2>nul
if %errorlevel%==0 (
  echo [OK] MySQL is up on 127.0.0.1:%MYSQL_PORT% (user root / db invoice_bot)
) else (
  echo [FAIL] Cannot connect. See %MYSQL_HOME%\data\error.log
)
endlocal
