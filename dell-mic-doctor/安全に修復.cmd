@echo off
chcp 65001 >nul
title MicDoctor - 診断 + 安全な自動修正
echo まず診断し、そのうえで「元に戻せる安全な修正」だけを適用します。
echo （ドライバー削除・大容量ダウンロード・再起動は行いません）
echo 管理者の確認画面が出たら「はい」を押してください。
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0MicDoctor.ps1" -Fix
