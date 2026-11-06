@echo off
title RTdbX MultiView Watchdog

set "SHORTCUT=%USERPROFILE%\Desktop\RTdbX MultiView - Shortcut.lnk"
set "PROFILE=%TEMP%\RTdbX_Edge"

:CHECK
powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter \"Name = 'msedge.exe'\" | Where-Object { $_.CommandLine -like '*RTdbX_Edge*' }; if ($p) { exit 0 } else { exit 1 }"

if errorlevel 1 (
    timeout /t 3 /nobreak >nul
    start "" "%SHORTCUT%"
)

timeout /t 5 /nobreak >nul
goto CHECK