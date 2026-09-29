@echo off
rem Double-click to uninstall the HTML to Figma bridge (Windows).
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Download it from https://nodejs.org, then run this again.
) else (
  node install.mjs uninstall
)
echo.
pause
