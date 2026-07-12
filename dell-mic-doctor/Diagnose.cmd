@echo off
chcp 65001 >nul
title MicDoctor - Diagnose only
echo Checking your microphone (this mode changes nothing).
echo %~dp0 | find /i "\Temp\" >nul && echo [!] Running from a temp folder. Please EXTRACT the ZIP first, then run.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0' -Filter *.ps1 | Unblock-File; & '%~dp0MicDoctor.ps1'"
echo.
echo (This window stays open. Press any key to close.)
pause >nul
