@echo off
chcp 65001 >nul
title MicDoctor - 診断のみ
echo 内蔵マイクの状態を診断します（このモードはシステムを一切変更しません）。
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0MicDoctor.ps1"
