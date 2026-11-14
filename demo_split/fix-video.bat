@echo off
chcp 65001 >nul
set PYTHONUTF8=1
cd /d "%~dp0"
python fix_video.py %*
echo.
pause
