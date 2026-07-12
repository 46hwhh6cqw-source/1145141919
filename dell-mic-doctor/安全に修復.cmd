@echo off
chcp 65001 >nul
title MicDoctor - Diagnose + safe fix
echo Diagnose, then apply only reversible fixes. No driver removal, no download, no reboot.
echo Click "Yes" if a User Account Control prompt appears.
echo %~dp0 | find /i "\Temp\" >nul && echo [!] Running from a temp folder. Please EXTRACT the ZIP first, then run.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0' -Filter *.ps1 | Unblock-File; & '%~dp0MicDoctor.ps1' -Fix"
echo.
echo (This window stays open. Press any key to close.)
pause >nul
