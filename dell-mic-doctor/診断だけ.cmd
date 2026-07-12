@echo off
chcp 65001 >nul
title MicDoctor - 診断のみ
echo 内蔵マイクの状態を診断します（このモードはシステムを一切変更しません）。
echo.
rem ZIP内から直接実行するとうまく動きません。展開先で実行してください。
echo %~dp0 | find /i "\Temp\" >nul && (
  echo [注意] 一時フォルダーから実行されています。ZIPを右クリック→「すべて展開」してから実行してください。
  echo.
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0' -Filter *.ps1 | Unblock-File; & '%~dp0MicDoctor.ps1'"
echo.
echo （このウィンドウは自動では閉じません。内容を確認したら何かキーを押してください）
pause >nul
