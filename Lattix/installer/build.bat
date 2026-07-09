@echo off
REM Convenience wrapper around installer\build.ps1.
REM Run from the project root:  installer\build.bat
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1"
if errorlevel 1 (
  echo.
  echo Build failed. See the output above.
  exit /b 1
)
