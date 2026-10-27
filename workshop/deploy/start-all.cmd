@echo off
rem start-all.cmd —— Windows 批量启动（生产建议 Linux+systemd）
cd /d %~dp0
node start-all.mjs
