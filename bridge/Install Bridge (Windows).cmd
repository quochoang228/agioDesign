@echo off
rem Double-click to install the agioDesign bridge (Windows).
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Download it from https://nodejs.org, then run this again.
) else (
  node install.mjs install
)
echo.
pause
