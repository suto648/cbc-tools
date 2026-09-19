@echo off
rem ============================================================
rem  CbC Tools - launcher
rem
rem  Double-click to start CbC and open its window.
rem  If it is already running, this just opens the window
rem  (the tray uses a mutex, so nothing starts twice).
rem
rem  Pass /silent to start the tray without opening a window.
rem
rem  ASCII ONLY -- do not put Japanese in this file.
rem  cmd.exe reads .bat using the system code page (CP932), and
rem  a Shift-JIS trail byte can be 0x7C ("|"), which cmd then
rem  treats as a pipe and splits the line. All Japanese lives
rem  on the PowerShell side, same rule as cbc.vbs.
rem ============================================================
setlocal

set "VBS=%~dp0cbc.vbs"

if not exist "%VBS%" (
    echo.
    echo   cbc.vbs not found:
    echo   %VBS%
    echo.
    echo   Keep this .bat directly inside the "CbC Tools" folder.
    echo.
    pause
    exit /b 1
)

start "" wscript.exe "%VBS%" %*

exit /b 0
