@echo off
cd /d "%~dp0"
set PORT=4173
set URL=http://127.0.0.1:%PORT%/
echo Starting Lexel Lab at %URL%
start "" "%URL%"
where python >nul 2>&1
if %ERRORLEVEL%==0 (
  python -m http.server %PORT% --bind 127.0.0.1
  exit /b
)
npx --yes serve -l tcp://127.0.0.1:%PORT% .
