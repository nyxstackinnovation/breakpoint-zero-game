@echo off
REM Rebuilds all Blender-made game assets (characters, weapons, props) in background mode.
cd /d "%~dp0"
set "BLENDER="
for /d %%D in ("C:\Program Files\Blender Foundation\Blender*") do if exist "%%D\blender.exe" set "BLENDER=%%D\blender.exe"
if not defined BLENDER (
  echo Blender was not found under C:\Program Files\Blender Foundation
  pause
  exit /b 1
)
echo Using %BLENDER%
"%BLENDER%" --background --factory-startup --python "%~dp0run_all.py"
echo.
echo Finished. Log: %~dp0build_log.txt
timeout /t 8
