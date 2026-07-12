<#
    MicSST-Repair.ps1
    フェーズC(Intel SST 入れ直し)の自動化

    背景:
      内蔵マイクアレイ(DMIC)は Intel Smart Sound Technology(SST)の DSP 直結。
      「レベル0〜1%・ノイズのみ・Intel(R) Audio Service が 7024 で毎回エラー終了」
      という症状は SST 層の破損が最有力。手動のデバイスマネージャー操作を、
      確認1回＋再起動1回で回るように自動化する。

    安全ガード:
      - 実行前にシステムの復元ポイントを作成
      - 「再導入元(YYCKX 内の Intel SST ドライバー)が存在する」ことを
         確認できたときだけ、既存 SST ドライバーの削除に進む
      - 削除〜再導入の間は Windows Update のドライバー自動配布を一時停止し、
         完了後に元の設定へ必ず戻す
      - 全操作をログに記録: C:\ProgramData\DellMicRepair\sst_repair.log

    使い方: 付属の「SST入れ直し.cmd」をダブルクリック(管理者確認は「はい」)。
    途中で1回だけ自動再起動し、サインイン後に続きが走る。
#>

param(
    [ValidateSet(1,2)]
    [int]$Phase = 1
)

$ErrorActionPreference = "Continue"
$ProgressPreference    = "SilentlyContinue"

$workDir     = "C:\ProgramData\DellMicRepair"
$logFile     = Join-Path $workDir "sst_repair.log"
$scriptCopy  = Join-Path $workDir "MicSST-Repair.ps1"
$extractDir  = Join-Path $workDir "yyckx_extract"
$wuStateFile = Join-Path $workDir "sst_wu_restore.txt"
$resultFile  = Join-Path ([Environment]::GetFolderPath("Desktop")) "SST修復_結果.txt"

New-Item -ItemType Directory -Path $workDir -Force | Out-Null

function Write-Log {
    param([string]$Message)
    $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    $line | Tee-Object -FilePath $logFile -Append
}

function Test-Administrator {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p  = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Start-Elevated {
    $psArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$scriptCopy`" -Phase $Phase"
    Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $psArgs
    exit
}

function Set-NextPhase {
    param([int]$NextPhase)
    $cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$scriptCopy`" -Phase $NextPhase"
    $rk = "HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce"
    New-Item -Path $rk -Force | Out-Null
    Set-ItemProperty -Path $rk -Name "MicSSTRepair" -Value $cmd -Force
}

function Get-DellDriverExe {
    $exe = Get-ChildItem -Path $workDir -Filter "*YYCKX*.EXE" -ErrorAction SilentlyContinue |
        Sort-Object Length -Descending | Select-Object -First 1
    return $exe
}

# SST デバイス/ドライバーの現状を記録し、対象 INF 名(oemNN.inf)を返す。
function Get-SstInventory {
    Write-Log "---- SST インベントリ ----"
    $infNames = @()
    try {
        $devs = Get-PnpDevice -ErrorAction SilentlyContinue |
            Where-Object { $_.FriendlyName -match "Smart Sound|Intel\(R\) SST|スマート・サウンド" }
        if ($devs) {
            foreach ($d in $devs) {
                Write-Log ("PnP: {0} / Status={1} / {2}" -f $d.FriendlyName, $d.Status, $d.InstanceId)
            }
        } else {
            Write-Log "SST デバイスは見つかりませんでした。"
        }

        $drv = Get-CimInstance Win32_PnPSignedDriver -ErrorAction SilentlyContinue |
            Where-Object { $_.DeviceName -match "Smart Sound|Intel.*SST" }
        foreach ($x in $drv) {
            Write-Log ("Driver: {0} / Ver={1} / Inf={2}" -f $x.DeviceName, $x.DriverVersion, $x.InfName)
            if ($x.InfName -and $x.InfName -match "^oem\d+\.inf$") {
                $infNames += $x.InfName
            }
        }
    } catch {
        Write-Log "インベントリ取得でエラー: $($_.Exception.Message)"
    }
    return ($infNames | Select-Object -Unique)
}

# YYCKX を展開し、中に Intel SST ドライバー(intc*.inf)が在るか確認。
# 見つかった inf のパスを返す(無ければ $null)。
function Confirm-SstSourceInPackage {
    param($DriverExe)
    Write-Log "再導入元の確認: YYCKX を展開して Intel SST ドライバーを探す。"
    try {
        if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force -ErrorAction SilentlyContinue }
        New-Item -ItemType Directory -Path $extractDir -Force | Out-Null

        # Dell の自己展開 EXE は /e=<dir> で中身を取り出せる。
        $p = Start-Process -FilePath $DriverExe.FullName -ArgumentList "/e=`"$extractDir`"" -Wait -PassThru -ErrorAction Stop
        Write-Log "展開の終了コード: $($p.ExitCode)"
        Start-Sleep -Seconds 2

        $infs = Get-ChildItem -Path $extractDir -Recurse -Filter "intc*.inf" -ErrorAction SilentlyContinue
        if ($infs) {
            foreach ($i in $infs) { Write-Log "同梱 SST inf: $($i.FullName)" }
            return $infs
        }
        Write-Log "YYCKX 内に Intel SST ドライバー(intc*.inf)が見つかりませんでした。"
        return $null
    } catch {
        Write-Log "展開に失敗: $($_.Exception.Message)"
        return $null
    }
}

function Disable-WUDriverUpdates {
    # 削除直後に Windows Update が問題版を再配布するのを一時的に止める。
    # 元の値を保存し、フェーズ2で必ず戻す。
    $key = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\DriverSearching"
    try {
        $orig = (Get-ItemProperty -Path $key -Name "SearchOrderConfig" -ErrorAction SilentlyContinue).SearchOrderConfig
        if ($null -eq $orig) { $orig = "unset" }
        Set-Content -Path $wuStateFile -Value $orig -Force
        if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
        Set-ItemProperty -Path $key -Name "SearchOrderConfig" -Value 0 -Type DWord -Force
        Write-Log "Windows Update のドライバー自動配布を一時停止(元値: $orig)。"
    } catch {
        Write-Log "WU ドライバー配布の停止に失敗(処理は継続): $($_.Exception.Message)"
    }
}

function Restore-WUDriverUpdates {
    $key = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\DriverSearching"
    try {
        if (Test-Path $wuStateFile) {
            $orig = (Get-Content -Path $wuStateFile -ErrorAction SilentlyContinue | Select-Object -First 1)
            if ($orig -eq "unset" -or [string]::IsNullOrWhiteSpace($orig)) {
                Remove-ItemProperty -Path $key -Name "SearchOrderConfig" -ErrorAction SilentlyContinue
                Write-Log "WU ドライバー配布設定を既定(未設定)へ復元。"
            } else {
                Set-ItemProperty -Path $key -Name "SearchOrderConfig" -Value ([int]$orig) -Type DWord -Force
                Write-Log "WU ドライバー配布設定を元値($orig)へ復元。"
            }
            Remove-Item $wuStateFile -Force -ErrorAction SilentlyContinue
        }
    } catch {
        Write-Log "WU 設定の復元に失敗: $($_.Exception.Message)"
    }
}

function Remove-SstDrivers {
    param([string[]]$InfNames)
    foreach ($inf in $InfNames) {
        if ($inf -match "^oem\d+\.inf$") {
            Write-Log "SST ドライバー削除: $inf"
            $out = & pnputil.exe /delete-driver $inf /uninstall /force 2>&1
            $out | Add-Content -Path $logFile
        }
    }
}

function Install-DellPackage {
    param($DriverExe)
    Write-Log "YYCKX をサイレント再インストール(SST を含む音声一式)。"
    $p = Start-Process -FilePath $DriverExe.FullName -ArgumentList "/s" -Wait -PassThru
    Write-Log "インストーラー終了コード: $($p.ExitCode)"
}

function Get-Intel7024Events {
    try {
        $ev = Get-WinEvent -FilterHashtable @{
            LogName='System'; Id=7024; StartTime=(Get-Date).AddMinutes(-60)
        } -ErrorAction SilentlyContinue | Where-Object { $_.Message -match "Intel|SST|Audio" }
        if ($ev) {
            foreach ($e in $ev) {
                Write-Log ("7024: {0} / {1}" -f $e.TimeCreated, ($e.Message -replace "\s+"," ").Substring(0,[Math]::Min(160,$e.Message.Length)))
            }
            return $true
        }
        Write-Log "直近60分の Intel 系 7024 エラーは検出されず。"
        return $false
    } catch {
        Write-Log "イベント確認でエラー: $($_.Exception.Message)"
        return $false
    }
}

# ============================================================
#  実行
# ============================================================

Copy-Item -Path $PSCommandPath -Destination $scriptCopy -Force -ErrorAction SilentlyContinue

if (-not (Test-Administrator)) { Start-Elevated }

Write-Log "==== MicSST-Repair 開始 Phase=$Phase ===="
$model = try { (Get-CimInstance Win32_ComputerSystem).Model } catch { "unknown" }
Write-Log "Model=$model"

switch ($Phase) {

    1 {
        Write-Host ""
        Write-Host "== フェーズC自動化: Intel SST(スマートサウンド)の入れ直し ==" -ForegroundColor Cyan
        Write-Host ""

        $exe = Get-DellDriverExe
        if (-not $exe) {
            Write-Host "Dell YYCKX ドライバー(EXE)が $workDir に見つかりません。" -ForegroundColor Red
            Write-Host "先に元の修復ツールでダウンロードするか、YYCKX の EXE をこのフォルダーに置いてください。"
            Write-Log "YYCKX EXE が無いため中止。"
            Write-Host ""; Read-Host "Enter で終了"; exit 1
        }
        Write-Log "使用する Dell パッケージ: $($exe.FullName)"

        # C-1: 現状記録 & 対象 INF 抽出
        $infNames = Get-SstInventory
        if (-not $infNames -or $infNames.Count -eq 0) {
            Write-Host "削除対象の Intel SST ドライバー(oemNN.inf)が特定できませんでした。" -ForegroundColor Yellow
            Write-Host "この機体では SST 入れ直しの対象外の可能性があります。フェーズE(Ubuntu USB)での切り分けを推奨します。"
            Write-Log "SST の oem inf を特定できず中止。"
            Write-Host ""; Read-Host "Enter で終了"; exit 1
        }
        Write-Host ("削除対象の SST ドライバー: {0}" -f ($infNames -join ", ")) -ForegroundColor Gray

        # C-2: 再導入元が在るか(安全ガード)。無ければ削除に進まない。
        $srcInfs = Confirm-SstSourceInPackage -DriverExe $exe
        if (-not $srcInfs) {
            Write-Host ""
            Write-Host "安全のため中止しました。" -ForegroundColor Yellow
            Write-Host "YYCKX パッケージ内に Intel SST ドライバーが確認できませんでした。"
            Write-Host "この場合、削除すると入れ直せず無音になる恐れがあるため実行しません。"
            Write-Host "→ フェーズC-4(Windows Update / Microsoft Update カタログ経由)で SST を取得してください。"
            Write-Log "再導入元が確認できず、削除を中止(安全ガード作動)。"
            Write-Host ""; Read-Host "Enter で終了"; exit 1
        }
        Write-Host "再導入元(YYCKX 内の Intel SST ドライバー)を確認しました。" -ForegroundColor Green

        Write-Host ""
        Write-Host "これから行うこと:" -ForegroundColor White
        Write-Host "  1) システムの復元ポイントを作成"
        Write-Host "  2) 既存の Intel SST ドライバーを削除"
        Write-Host "  3) YYCKX を再インストール(SST 含む)"
        Write-Host "  4) 1回だけ自動で再起動 → サインイン後に自動で仕上げ・再テスト案内"
        Write-Host "※ 復元ポイントがあるので、問題があれば元に戻せます。作業中の保存を済ませてください。" -ForegroundColor DarkGray
        Write-Host ""
        $ans = Read-Host "実行してよければ Y を入力"
        if ($ans -notmatch "^[Yy]$") { Write-Log "ユーザー中止。"; exit }

        try {
            Checkpoint-Computer -Description "Before Intel SST Repair" -RestorePointType "MODIFY_SETTINGS" -ErrorAction Stop
            Write-Log "復元ポイント作成成功。"
        } catch {
            Write-Log "復元ポイント作成不可(処理は継続): $($_.Exception.Message)"
        }

        Disable-WUDriverUpdates
        Remove-SstDrivers -InfNames $infNames
        Install-DellPackage -DriverExe $exe

        Set-NextPhase -NextPhase 2
        Write-Log "フェーズ1完了。再起動します。"
        Write-Host ""
        Write-Host "再起動します。サインイン後、管理者確認が出たら「はい」を押してください。" -ForegroundColor Yellow
        Start-Sleep -Seconds 3
        Restart-Computer -Force
    }

    2 {
        Write-Host "== 仕上げ: 設定の復元と再テスト ==" -ForegroundColor Cyan
        Restore-WUDriverUpdates

        Start-Sleep -Seconds 5
        $infAfter = Get-SstInventory
        $still7024 = Get-Intel7024Events

        $verdict = if ($still7024) {
            "SST サービスの 7024 エラーがまだ出ています。SST 層以外(またはハード)の可能性が上がりました。"
        } else {
            "SST サービスの 7024 エラーは解消。SST 層は正常化した可能性が高いです。"
        }

        @"
Intel SST(スマートサウンド)入れ直し 結果
==========================================

再導入後の SST ドライバー: $($infAfter -join ", ")

$verdict

次の確認:
  設定 → システム → サウンド → 入力 → マイク → 「テストの開始」
  でレベルが振れるかを確認してください。

・レベルが振れた           → 原因確定(SST 破損)。再発防止に Windows Update を
                              1〜2週間一時停止しておくと安心です。
・7024 は消えたのに 0〜1%  → SST は治ったが原因は別。次はフェーズE(Ubuntu USB)で
                              ハード/ソフトを確定させるのが最短です。
・7024 がまだ出る/悪化      → 復元ポイントで戻せます。フェーズE へ。

ログ: $logFile
"@ | Set-Content -Path $resultFile -Encoding UTF8

        Write-Log "フェーズ2完了。$verdict"

        Start-Process "ms-settings:sound" -ErrorAction SilentlyContinue

        Write-Host ""
        Write-Host $verdict -ForegroundColor Green
        Write-Host "サウンド設定を開きました。マイクの「テストの開始」でレベルを確認してください。"
        Write-Host "結果ファイル: $resultFile" -ForegroundColor DarkGray
        Write-Host ""
        Read-Host "確認したら Enter で終了"
    }
}
