@echo off
REM Breakpoint Zero launcher for Windows
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 goto :error
)
echo Starting Breakpoint Zero on http://localhost:3001
call npm start
goto :eof
:error
echo npm install failed. Make sure Node.js 18.17+ is installed: https://nodejs.org
pause
