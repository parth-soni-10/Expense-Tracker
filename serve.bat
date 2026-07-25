@echo off
REM serve.bat — Local dev server for cents.
REM
REM Browsers refuse to load ES modules over file://, so opening
REM index.html directly shows a blank page. This script picks the
REM first available static server and listens on a port.
REM
REM Usage:
REM   serve.bat            (default port 8080)
REM   serve.bat 9000       (custom port)
REM
REM Stop with Ctrl+C.

setlocal
if /i "%1"=="-h" goto :usage
if /i "%1"=="--help" goto :usage
if /i "%1"=="/?" goto :usage

set PORT=%1
if "%PORT%"=="" set PORT=8080

if not exist "index.html" (
  echo.
  echo Usage: serve.bat [port]
  echo   port   optional, default 8080
  echo.
  echo error: run this from the project root ^(the folder that contains index.html^)
  exit /b 1
)
goto :start_server

:usage
echo Usage: serve.bat [port]
echo   port   optional, default 8080
echo.
echo Picks python, then py launcher, then npx serve, and listens on the given port.
echo Open the printed URL in your browser. Ctrl+C to stop.
exit /b 0

:start_server

where python >nul 2>nul
if %ERRORLEVEL%==0 (
  echo Serving on http://localhost:%PORT%/   ^(via python^)
  echo Open that URL in your browser. Press Ctrl+C to stop.
  python -m http.server %PORT%
  goto :eof
)

where py >nul 2>nul
if %ERRORLEVEL%==0 (
  echo Serving on http://localhost:%PORT%/   ^(via py launcher^)
  echo Open that URL in your browser. Press Ctrl+C to stop.
  py -m http.server %PORT%
  goto :eof
)

where npx >nul 2>nul
if %ERRORLEVEL%==0 (
  echo Serving on http://localhost:%PORT%/   ^(via npx serve^)
  echo Open that URL in your browser. Press Ctrl+C to stop.
  npx --yes serve -l %PORT% .
  goto :eof
)

echo error: no static server found. Install one of: python, py launcher, or node/npm.
exit /b 1
