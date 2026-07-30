@echo off
:: ---------------------------------------------------------------------------
:: JARVIS — Windows launcher
::
:: Locates Git Bash and re-launches scripts/start.sh under it.
:: Exists so JARVIS can be started from cmd.exe, PowerShell, a shortcut, or a
:: double-click — while still running inside a bash environment, which is what
:: the bash-backed capabilities in app/capabilities/*.json require.
::
:: Usage:
::   start-windows.cmd            normal start
::   start-windows.cmd --dev      tsx watch mode
::   start-windows.cmd --check    preflight only, do not start JARVIS
:: ---------------------------------------------------------------------------

setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"

:: --- Locate bash.exe -------------------------------------------------------
set "BASH_EXE="

:: 1. Explicit override
if defined JARVIS_BASH (
    if exist "%JARVIS_BASH%" set "BASH_EXE=%JARVIS_BASH%"
)

:: 2. Already on PATH
if not defined BASH_EXE (
    for /f "delims=" %%i in ('where bash 2^>nul') do (
        if not defined BASH_EXE set "BASH_EXE=%%i"
    )
)

:: 3. Known Git for Windows install locations
if not defined BASH_EXE if exist "%ProgramFiles%\Git\bin\bash.exe" set "BASH_EXE=%ProgramFiles%\Git\bin\bash.exe"
if not defined BASH_EXE if exist "%ProgramFiles(x86)%\Git\bin\bash.exe" set "BASH_EXE=%ProgramFiles(x86)%\Git\bin\bash.exe"
if not defined BASH_EXE if exist "%LOCALAPPDATA%\Programs\Git\bin\bash.exe" set "BASH_EXE=%LOCALAPPDATA%\Programs\Git\bin\bash.exe"

if not defined BASH_EXE (
    echo.
    echo [X] Git Bash not found.
    echo.
    echo     Install Git for Windows:  https://git-scm.com/download/win
    echo     Or set JARVIS_BASH to the full path of bash.exe, e.g.
    echo       set JARVIS_BASH=C:\Program Files\Git\bin\bash.exe
    echo.
    exit /b 1
)

echo [*] Using bash: %BASH_EXE%

:: --- Re-launch start.sh under bash (login shell = full MSYS environment) ----
"%BASH_EXE%" -l "%SCRIPT_DIR%scripts/start.sh" %*
exit /b %errorlevel%
