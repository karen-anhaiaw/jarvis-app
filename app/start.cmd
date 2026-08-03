@echo off
setlocal EnableExtensions
rem JARVIS - full build & start (Windows / CMD)
rem Builds UI (Vite), then starts the backend (tsx).

set "JarvisDir=%~dp0"
cd /d "%JarvisDir%"

rem Python\bin must come BEFORE WindowsApps (Store stub) so python3.exe resolves.
set "PATH=%LOCALAPPDATA%\Python\bin;C:\Program Files\nodejs;C:\Program Files\Git\usr\bin;C:\Program Files\Git\cmd;C:\Program Files\Git\bin;%PATH%"

echo Building UI...
pushd "%JarvisDir%ui"
call npm run build
if errorlevel 1 (
  echo UI build failed
  popd
  exit /b 1
)
popd

echo Starting JARVIS...
if exist "%JarvisDir%..\node_modules\.bin\tsx.cmd" (
  call "%JarvisDir%..\node_modules\.bin\tsx.cmd" src\main.ts
) else (
  call npx tsx src\main.ts
)
exit /b %ERRORLEVEL%
