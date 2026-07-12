@echo off
chcp 65001 >nul
title MicSST-Repair - Intel SST 入れ直し(フェーズC自動化)
echo Intel SST(スマートサウンド)を入れ直します。
echo ・実行前に復元ポイントを作成します
echo ・再導入元が確認できたときだけ削除に進みます
echo ・途中で1回だけ自動再起動します（作業を保存してください）
echo 管理者の確認画面が出たら「はい」を押してください。
echo.
echo %~dp0 | find /i "\Temp\" >nul && (
  echo [注意] 一時フォルダーから実行されています。ZIPを右クリック→「すべて展開」してから実行してください。
  echo.
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0' -Filter *.ps1 | Unblock-File; & '%~dp0MicSST-Repair.ps1'"
echo.
echo （このウィンドウは自動では閉じません。内容を確認したら何かキーを押してください）
pause >nul
