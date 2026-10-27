@echo off
cd /d "%~dp0"
node start-admin.mjs
timeout /t 3 /nobreak >nul
start "" http://127.0.0.1:4570/admin
