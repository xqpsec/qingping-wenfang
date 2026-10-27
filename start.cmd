@echo off
setlocal
cd /d "%~dp0"
if "%WORKSHOP_PORT%"=="" set "WORKSHOP_PORT=4580"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install Node 20+ from https://nodejs.org
  pause
  exit /b 1
)
echo Qingping Wenfang - open http://127.0.0.1:%WORKSHOP_PORT%
echo Close this window to stop the server.
node workshop\server.mjs
if errorlevel 1 pause
