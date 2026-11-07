@echo off
rem Watchmate collector auto start: plug in the gateway, then double-click this file.
chcp 65001 >nul
set PYTHONUTF8=1
if "%WATCHMATE_BE%"=="" set "WATCHMATE_BE=%~dp0..\watchmate-be"
"%WATCHMATE_BE%\.venv\Scripts\python.exe" "%~dp0scripts\start_collector.py" %*
echo.
pause
