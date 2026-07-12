@echo off
chcp 65001 >nul
title MicSST-Repair - Intel SST reinstall (Phase C)
echo Reinstalls the Intel SST audio layer. Creates a restore point first,
echo deletes only if the reinstall source is confirmed, reboots once automatically.
echo Click "Yes" if a User Account Control prompt appears.
echo %~dp0 | find /i "\Temp\" >nul && echo [!] Running from a temp folder. Please EXTRACT the ZIP first, then run.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0' -Filter *.ps1 | Unblock-File; & '%~dp0MicSST-Repair.ps1'"
echo.
echo (This window stays open. Press any key to close.)
pause >nul
