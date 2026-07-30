@echo off
:: bash-exec.cmd — Execute shell command on Windows (cmd.exe)
:: Usage: bash-exec.cmd <command> [timeout_seconds] [cwd]
:: Mirrors bash-exec.sh output protocol: __TYPE__:text / __TYPE__:error
::
:: NOTE: args are passed via the loader.ts spawn(cmd, [/C, script, arg1, arg2, arg3])
:: cmd /C passes all remaining tokens as the command line.
:: %~1, %~2, %~3 strip surrounding quotes from each argument.

setlocal enabledelayedexpansion

set "COMMAND=%~1"
set "TIMEOUT=%~2"
set "CWD=%~3"

if "%COMMAND%"=="" (
    echo __TYPE__:error
    echo command is required
    exit /b 0
)

:: Default timeout
if "%TIMEOUT%"=="" set "TIMEOUT=30"

:: Expand ~ to USERPROFILE
if defined USERPROFILE (
    set "COMMAND=!COMMAND:~=%USERPROFILE%!"
    if not "%CWD%"=="" set "CWD=!CWD:~=%USERPROFILE%!"
)

:: Set working directory
if not "%CWD%"=="" (
    if not exist "%CWD%\" (
        echo __TYPE__:error
        echo Working directory not found: %CWD%
        exit /b 0
    )
    cd /d "%CWD%"
) else (
    :: Default: two levels up from scripts\ → app\
    cd /d "%~dp0..\.."
)

:: Temp files for output capture
set "TMPOUT=%TEMP%\jarvis-out-%RANDOM%-%RANDOM%.txt"
set "TMPERR=%TEMP%\jarvis-err-%RANDOM%-%RANDOM%.txt"

:: Execute command, capturing stdout and stderr separately
cmd /C "%COMMAND%" > "%TMPOUT%" 2> "%TMPERR%"
set "EXIT_CODE=%errorlevel%"

:: Output protocol header
echo __TYPE__:text
echo exit_code: %EXIT_CODE%
echo ---

:: Dump captured stdout
if exist "%TMPOUT%" (
    type "%TMPOUT%"
    del "%TMPOUT%" >nul 2>&1
)

:: Dump captured stderr if non-empty
if exist "%TMPERR%" (
    for %%A in ("%TMPERR%") do if %%~zA GTR 0 (
        echo ---stderr---
        type "%TMPERR%"
    )
    del "%TMPERR%" >nul 2>&1
)

endlocal
exit /b 0
