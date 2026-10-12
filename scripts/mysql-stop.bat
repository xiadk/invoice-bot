@echo off
REM ============================================================
REM  invoice-bot local MySQL (MariaDB 11.4) stopper
REM ============================================================
setlocal
set "MYSQL_HOME=C:\Users\hspcadmin\WorkBuddy\mysql"
set "MYSQL_PORT=3306"

echo Stopping MySQL on 127.0.0.1:%MYSQL_PORT% ...
"%MYSQL_HOME%\bin\mariadb-admin.exe" -h127.0.0.1 -P%MYSQL_PORT% -uroot -pinvoice123 shutdown
if %errorlevel%==0 (
  echo [OK] MySQL stopped.
) else (
  echo [FAIL] Shutdown command failed - the server may already be stopped.
)
endlocal
