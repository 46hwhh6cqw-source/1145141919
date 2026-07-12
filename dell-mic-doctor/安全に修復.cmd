@echo off
chcp 65001 >nul
title MicDoctor - 診断 + 安全な自動修正
echo まず診断し、そのうえで「元に戻せる安全な修正」だけを適用します。
echo （ドライバー削除・大容量ダウンロード・再起動は行いません）
echo 管理者の確認画面が出たら「はい」を押してください。
echo.
echo %~dp0 | find /i "\Temp\" >nul && (
  echo [注意] 一時フォルダーから実行されています。ZIPを右クリック→「すべて展開」してから実行してください。
  echo.
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0' -Filter *.ps1 | Unblock-File; & '%~dp0MicDoctor.ps1' -Fix"
echo.
echo （このウィンドウは自動では閉じません。内容を確認したら何かキーを押してください）
pause >nul
