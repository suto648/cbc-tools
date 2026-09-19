@echo off
rem ============================================================
rem  CbC Tools - stop everything
rem
rem  Stops the tools CbC started, restores the environment,
rem  then shuts the hub and tray down. Same as the tray's
rem  right-click "stop everything and quit".
rem
rem  ASCII ONLY -- see CbC-kidou.bat header for why.
rem  The Japanese messages live in tray\stop-all.ps1.
rem ============================================================
setlocal

set "PS1=%~dp0tray\stop-all.ps1"

if not exist "%PS1%" (
    echo.
    echo   stop-all.ps1 not found:
    echo   %PS1%
    echo.
    pause
    exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%"

exit /b 0
