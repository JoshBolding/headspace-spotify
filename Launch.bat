@echo off
title Headspace Spotify
cd /d "%~dp0"
if not exist "dist-main\main\main.js" (
  echo Building first...
  call npm run build
)
start "" "%~dp0node_modules\electron\dist\electron.exe" .
