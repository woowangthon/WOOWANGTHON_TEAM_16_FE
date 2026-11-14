@echo off
rem Watchmate demo split screen: left = live site, right = phone camera
cd /d "%~dp0"
"C:\wm\watchmate-be\.venv\Scripts\python.exe" "%~dp0server.py" --open %*
pause
