@echo off
rem Double-click launcher for switchboard.ai (dev convenience — not a package).
rem Installs deps + builds on first run, then launches the built app.
cd /d "%~dp0"

if not exist "node_modules" (
  echo First run: installing dependencies ^(this takes a minute^)...
  call npm install || goto :error
)

if not exist "out\main\index.js" (
  echo Building the app...
  call npm run build || goto :error
)

echo Launching switchboard...
node scripts\launch-app.js
goto :eof

:error
echo.
echo Launch failed. See the messages above.
pause
