<#
    MicDoctor.ps1
    内蔵マイクの「診断ファースト」トラブルシューター（Windows / Dell Inspiron 向け）

    設計方針:
      - 既定は「診断のみ」。読み取りしかせず、システムを一切変更しない。
      - -Fix を付けたときだけ、安全で元に戻せる修正だけを適用する。
        （プライバシー許可・音声サービス再起動・無効化された録音デバイスの有効化）
      - ドライバー削除・大容量ダウンロード・再起動は一切しない。
      - 原因が「ソフト設定」か「ドライバー」か「ハードウェア故障」かを切り分け、
        必要なときだけ、より重い対処（ドライバー入れ直し）へ案内する。

    使い方:
      診断のみ            : powershell -ExecutionPolicy Bypass -File MicDoctor.ps1
      安全な自動修正つき  : powershell -ExecutionPolicy Bypass -File MicDoctor.ps1 -Fix
#>

[CmdletBinding()]
param(
    [switch]$Fix
)

$ErrorActionPreference = "Continue"
$ProgressPreference    = "SilentlyContinue"

# コンソール出力を UTF-8 に固定（chcp 65001 と一致させ、日本語の文字化けを防ぐ）。
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
try { $OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

$workDir = Join-Path $env:LOCALAPPDATA "MicDoctor"
New-Item -ItemType Directory -Path $workDir -Force | Out-Null
$logFile = Join-Path $workDir ("micdoctor_{0}.log" -f (Get-Date -Format "yyyyMMdd_HHmmss"))

# --- 集計用 ---
$script:Findings = New-Object System.Collections.ArrayList
$script:FixesApplied = New-Object System.Collections.ArrayList

function Write-Log {
    param([string]$Message)
    ("{0}  {1}" -f (Get-Date -Format "HH:mm:ss"), $Message) | Add-Content -Path $logFile
}

function Test-Administrator {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p  = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Write-Head {
    param([string]$Text)
    Write-Host ""
    Write-Host "== $Text ==" -ForegroundColor Cyan
    Write-Log  "== $Text =="
}

# 診断結果を1件記録して画面にも出す。
# Status: OK / WARN / FAIL / INFO
function Add-Finding {
    param(
        [string]$Name,
        [ValidateSet("OK","WARN","FAIL","INFO")][string]$Status,
        [string]$Detail,
        [string]$Fixable = ""   # -Fix で直せる場合、その説明を入れる
    )
    $mark = switch ($Status) {
        "OK"   { "[ OK ]" }
        "WARN" { "[WARN]" }
        "FAIL" { "[FAIL]" }
        "INFO" { "[ .. ]" }
    }
    $color = switch ($Status) {
        "OK"   { "Green" }
        "WARN" { "Yellow" }
        "FAIL" { "Red" }
        "INFO" { "Gray" }
    }
    Write-Host ("{0} {1}" -f $mark, $Name) -ForegroundColor $color
    if ($Detail) { Write-Host ("       {0}" -f $Detail) -ForegroundColor DarkGray }
    Write-Log ("{0} {1} - {2}" -f $mark, $Name, $Detail)

    [void]$script:Findings.Add([pscustomobject]@{
        Name    = $Name
        Status  = $Status
        Detail  = $Detail
        Fixable = $Fixable
    })
}

function Get-RegValue {
    param([string]$Path, [string]$Name)
    try {
        $item = Get-ItemProperty -Path $Path -Name $Name -ErrorAction Stop
        return $item.$Name
    } catch {
        return $null
    }
}

# ======================================================================
#  診断
# ======================================================================

function Invoke-Diagnostics {
    Write-Head "1. Windows のマイク プライバシー設定"

    # システム全体（HKLM）。既定は Allow。
    $sysConsent = Get-RegValue "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone" "Value"
    if ($sysConsent -eq "Deny") {
        Add-Finding "システム全体のマイクアクセス" "FAIL" "このPCではマイクアクセスが「オフ」になっています。" "システム全体のマイクアクセスを許可"
    } elseif ($null -eq $sysConsent -or $sysConsent -eq "Allow") {
        Add-Finding "システム全体のマイクアクセス" "OK" "許可されています。"
    } else {
        Add-Finding "システム全体のマイクアクセス" "WARN" "値: $sysConsent"
    }

    # 現在ユーザー（HKCU）。
    $userConsent = Get-RegValue "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone" "Value"
    if ($userConsent -eq "Deny") {
        Add-Finding "このユーザーのマイクアクセス" "FAIL" "このユーザーでマイクアクセスが「オフ」です。" "このユーザーのマイクアクセスを許可"
    } elseif ($null -eq $userConsent -or $userConsent -eq "Allow") {
        Add-Finding "このユーザーのマイクアクセス" "OK" "許可されています。"
    } else {
        Add-Finding "このユーザーのマイクアクセス" "WARN" "値: $userConsent"
    }

    # デスクトップアプリ（Zoom/Teams/ブラウザ等）のアクセス。
    $desktopConsent = Get-RegValue "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged" "Value"
    if ($desktopConsent -eq "Deny") {
        Add-Finding "デスクトップアプリのマイクアクセス" "FAIL" "従来型アプリ（会議アプリ・ブラウザ等）がマイクを使えません。" "デスクトップアプリのマイクアクセスを許可"
    } elseif ($null -eq $desktopConsent -or $desktopConsent -eq "Allow") {
        Add-Finding "デスクトップアプリのマイクアクセス" "OK" "許可されています。"
    } else {
        Add-Finding "デスクトップアプリのマイクアクセス" "WARN" "値: $desktopConsent"
    }

    # 組織ポリシーによる強制ブロック。
    $policy = Get-RegValue "HKLM:\SOFTWARE\Policies\Microsoft\Windows\AppPrivacy" "LetAppsAccessMicrophone"
    if ($policy -eq 2) {
        Add-Finding "グループポリシー" "FAIL" "ポリシー『LetAppsAccessMicrophone=2(強制拒否)』でマイクがブロックされています。会社/学校管理PCの可能性。" ""
    } elseif ($null -ne $policy) {
        Add-Finding "グループポリシー" "INFO" "LetAppsAccessMicrophone=$policy が設定されています。"
    }

    Write-Head "2. 音声サービス"
    foreach ($svcName in @("Audiosrv","AudioEndpointBuilder")) {
        $svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
        if (-not $svc) {
            Add-Finding "サービス $svcName" "WARN" "見つかりません。"
            continue
        }
        if ($svc.Status -ne "Running") {
            Add-Finding "サービス $($svc.DisplayName)" "FAIL" "停止しています（状態: $($svc.Status)）。マイクが全く使えなくなります。" "音声サービスを開始"
        } else {
            Add-Finding "サービス $($svc.DisplayName)" "OK" "実行中。"
        }
    }

    Write-Head "3. 録音（キャプチャ）デバイス"
    $captureFound = $false
    $captureHealthy = $false
    try {
        $eps = Get-PnpDevice -Class AudioEndpoint -ErrorAction Stop
        # MMDEVAPI のキャプチャ端点は InstanceId が {0.0.1.xxxxxxxx} になる。
        $capture = $eps | Where-Object { $_.InstanceId -match '\{0\.0\.1\.' }
        if (-not $capture) {
            Add-Finding "録音デバイス" "FAIL" "録音デバイスがWindowsから1つも見えません。ドライバー未導入かハード故障の疑い。" ""
        } else {
            foreach ($ep in $capture) {
                $captureFound = $true
                switch ($ep.Status) {
                    "OK" {
                        $captureHealthy = $true
                        Add-Finding "録音: $($ep.FriendlyName)" "OK" "有効・正常。"
                    }
                    "Error" {
                        Add-Finding "録音: $($ep.FriendlyName)" "FAIL" "エラー状態です。"
                    }
                    default {
                        # Unknown は通常「無効化」されているデバイス。
                        Add-Finding "録音: $($ep.FriendlyName)" "WARN" "無効化されている可能性（状態: $($ep.Status)）。" "無効な録音デバイスを有効化"
                    }
                }
            }
        }
    } catch {
        Add-Finding "録音デバイス" "WARN" "列挙に失敗: $($_.Exception.Message)"
    }
    $script:CaptureFound   = $captureFound
    $script:CaptureHealthy = $captureHealthy

    Write-Head "4. 音声ドライバー / コントローラの健全性"
    $driverProblem = $false
    try {
        $mediaDevs = Get-PnpDevice -Class MEDIA -ErrorAction SilentlyContinue |
            Where-Object { $_.FriendlyName -match 'Realtek|High Definition Audio|Audio' }
        if (-not $mediaDevs) {
            Add-Finding "音声コントローラ" "WARN" "音声デバイス（MEDIAクラス）が見つかりません。"
        }
        foreach ($d in $mediaDevs) {
            $problem = $null
            try {
                $pp = Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName 'DEVPKEY_Device_ProblemCode' -ErrorAction Stop
                $problem = $pp.Data
            } catch {}
            if ($d.Status -eq "OK" -and (($null -eq $problem) -or ($problem -eq 0))) {
                Add-Finding "デバイス: $($d.FriendlyName)" "OK" "正常動作中。"
            } else {
                $driverProblem = $true
                $pcodeText = if ($problem) { " / 問題コード $problem" } else { "" }
                Add-Finding "デバイス: $($d.FriendlyName)" "FAIL" "状態: $($d.Status)$pcodeText。ドライバーの入れ直しが必要かもしれません。" ""
            }
        }
    } catch {
        Add-Finding "音声コントローラ" "WARN" "確認に失敗: $($_.Exception.Message)"
    }
    $script:DriverProblem = $driverProblem

    Write-Head "5. 導入済み Realtek 音声ドライバー（参考情報）"
    try {
        $drv = Get-CimInstance Win32_PnPSignedDriver -ErrorAction SilentlyContinue |
            Where-Object { $_.DeviceName -match 'Realtek.*Audio|Realtek\(R\) Audio|High Definition Audio' } |
            Select-Object -First 3 DeviceName, DriverVersion, DriverDate, Manufacturer
        if ($drv) {
            foreach ($x in $drv) {
                $date = if ($x.DriverDate) { ([datetime]$x.DriverDate).ToString("yyyy-MM-dd") } else { "?" }
                Add-Finding "$($x.DeviceName)" "INFO" "バージョン $($x.DriverVersion) / 日付 $date / $($x.Manufacturer)"
            }
        } else {
            Add-Finding "Realtek 音声ドライバー" "INFO" "情報を取得できませんでした。"
        }
    } catch {
        Add-Finding "Realtek 音声ドライバー" "INFO" "取得に失敗: $($_.Exception.Message)"
    }
}

# ======================================================================
#  安全な修正（-Fix のときだけ）
# ======================================================================

function Set-ConsentAllow {
    param([string]$Path, [string]$Label)
    try {
        if (-not (Test-Path $Path)) { New-Item -Path $Path -Force | Out-Null }
        Set-ItemProperty -Path $Path -Name "Value" -Value "Allow" -Type String -Force -ErrorAction Stop
        [void]$script:FixesApplied.Add("$Label を『許可』に変更しました。")
        Write-Host "  -> $Label を許可にしました。" -ForegroundColor Green
    } catch {
        Write-Host "  -> $Label の変更に失敗: $($_.Exception.Message)" -ForegroundColor Red
    }
}

function Invoke-SafeFixes {
    Write-Head "安全な自動修正を適用します（すべて元に戻せる範囲）"

    $needSysConsent  = $script:Findings | Where-Object { $_.Fixable -eq "システム全体のマイクアクセスを許可" }
    $needUserConsent = $script:Findings | Where-Object { $_.Fixable -eq "このユーザーのマイクアクセスを許可" }
    $needDesktop     = $script:Findings | Where-Object { $_.Fixable -eq "デスクトップアプリのマイクアクセスを許可" }
    $needSvc         = $script:Findings | Where-Object { $_.Fixable -eq "音声サービスを開始" }
    $needEnable      = $script:Findings | Where-Object { $_.Fixable -eq "無効な録音デバイスを有効化" }

    if ($needUserConsent) {
        Set-ConsentAllow "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone" "このユーザーのマイクアクセス"
    }
    if ($needDesktop) {
        Set-ConsentAllow "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged" "デスクトップアプリのマイクアクセス"
    }
    if ($needSysConsent) {
        Set-ConsentAllow "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone" "システム全体のマイクアクセス"
    }

    if ($needSvc) {
        foreach ($svcName in @("AudioEndpointBuilder","Audiosrv")) {
            try {
                Set-Service -Name $svcName -StartupType Automatic -ErrorAction SilentlyContinue
                Start-Service -Name $svcName -ErrorAction Stop
                [void]$script:FixesApplied.Add("音声サービス $svcName を開始しました。")
                Write-Host "  -> $svcName を開始しました。" -ForegroundColor Green
            } catch {
                Write-Host "  -> $svcName を開始できませんでした: $($_.Exception.Message)" -ForegroundColor Red
            }
        }
    }

    if ($needEnable) {
        try {
            $eps = Get-PnpDevice -Class AudioEndpoint -ErrorAction SilentlyContinue |
                Where-Object { $_.InstanceId -match '\{0\.0\.1\.' -and $_.Status -ne "OK" }
            foreach ($ep in $eps) {
                try {
                    Enable-PnpDevice -InstanceId $ep.InstanceId -Confirm:$false -ErrorAction Stop
                    [void]$script:FixesApplied.Add("録音デバイス『$($ep.FriendlyName)』を有効化しました。")
                    Write-Host "  -> $($ep.FriendlyName) を有効化しました。" -ForegroundColor Green
                } catch {
                    Write-Host "  -> $($ep.FriendlyName) の有効化に失敗: $($_.Exception.Message)" -ForegroundColor Red
                }
            }
        } catch {}
    }

    # 仕上げに音声スタックを再起動して設定を反映。
    try {
        Restart-Service -Name "Audiosrv" -Force -ErrorAction Stop
        [void]$script:FixesApplied.Add("Windows Audio を再起動して設定を反映しました。")
        Write-Host "  -> Windows Audio を再起動しました。" -ForegroundColor Green
    } catch {
        Write-Host "  -> Windows Audio の再起動をスキップしました。" -ForegroundColor DarkGray
    }

    if ($script:FixesApplied.Count -eq 0) {
        Write-Host "  自動で直せる問題は見つかりませんでした（設定はどこも変更していません）。" -ForegroundColor Gray
    }
}

# ======================================================================
#  総合判定と案内
# ======================================================================

function Show-Verdict {
    Write-Head "総合判定"

    $fails = $script:Findings | Where-Object { $_.Status -eq "FAIL" }
    $softwareFixable = $script:Findings | Where-Object { $_.Fixable -ne "" }

    if ($script:DriverProblem -or (-not $script:CaptureFound)) {
        Write-Host "判定: ドライバー、またはハードウェアの問題の可能性が高いです。" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "推奨する対処（軽い順・いずれも安全）:" -ForegroundColor White
        Write-Host "  1) デバイスマネージャー → 「サウンド、ビデオ、およびゲーム コントローラー」"
        Write-Host "     → 音声デバイスを右クリック → 『デバイスのアンインストール』"
        Write-Host "     → メニューの『操作』→『ハードウェア変更のスキャン』。"
        Write-Host "     これで“標準ドライバー”が自動で入り直します（ダウンロード不要・再起動不要）。"
        Write-Host "  2) それでも直らなければ、Dell公式ドライバーの入れ直し（渡された修復ツール等）。"
        Write-Host "  3) それでもマイクが出てこない/BIOSでも認識しない場合はハード故障。"
        Write-Host "     Dellサポートまたは修理を検討してください（Inspiron 7490は分解交換になります）。"
    }
    elseif ($softwareFixable) {
        if ($Fix) {
            Write-Host "判定: ソフト設定が原因でした。安全な修正を適用済みです。" -ForegroundColor Green
            Write-Host "サウンド設定でマイクの入力レベルが動くか確認してください。"
        } else {
            Write-Host "判定: ソフト設定が原因の可能性が高いです（設定のオフ・サービス停止・デバイス無効化など）。" -ForegroundColor Green
            Write-Host "上の [FAIL] は、-Fix を付けて実行すれば自動で直せます:"
            Write-Host "  もう一度『安全に修復.cmd』を実行してください。" -ForegroundColor White
        }
    }
    elseif ($fails) {
        Write-Host "判定: 問題は見つかりましたが自動修正の対象外です。上のログを確認してください。" -ForegroundColor Yellow
    }
    else {
        Write-Host "判定: 設定・サービス・ドライバーはすべて正常でした。" -ForegroundColor Green
        Write-Host ""
        Write-Host "この場合に多い原因:" -ForegroundColor White
        Write-Host "  - マイクがミュート、または入力レベルが0（サウンド設定で確認）。"
        Write-Host "  - 既定の録音デバイスが別のもの（外部/仮想デバイス等）になっている。"
        Write-Host "  - 使っているアプリ側だけの権限/デバイス選択の問題。"
        Write-Host "  - それでもどのアプリでも無音なら、内蔵マイクのハード故障の可能性。"
    }

    Write-Host ""
    Write-Host "詳細ログ: $logFile" -ForegroundColor DarkGray
}

# ======================================================================
#  実行
# ======================================================================

# -Fix は設定変更を伴うので管理者権限が要る。診断のみなら不要。
if ($Fix -and -not (Test-Administrator)) {
    Write-Host "修正の適用には管理者権限が必要です。昇格して開き直します..." -ForegroundColor Yellow
    $psArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Fix"
    try {
        Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $psArgs
    } catch {
        Write-Host "昇格をキャンセルしました。診断のみ続行します。" -ForegroundColor Yellow
        $Fix = $false
    }
    if ($Fix) { exit }
}

Write-Host "MicDoctor - 内蔵マイク診断ツール" -ForegroundColor Cyan
Write-Host ("モード: {0}" -f ($(if ($Fix) { "診断 + 安全な自動修正" } else { "診断のみ（システムは変更しません）" }))) -ForegroundColor Gray
Write-Log "MicDoctor 開始 (Fix=$Fix)"

$model = try { (Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue).Model } catch { "unknown" }
Write-Log "Model=$model"
Write-Host "検出した機種: $model" -ForegroundColor DarkGray

Invoke-Diagnostics

if ($Fix) {
    Invoke-SafeFixes
    # 修正後にもう一度だけ主要項目を再判定するのが理想だが、
    # ここでは適用結果を提示して手動確認に委ねる。
}

Show-Verdict

# サウンド設定を開いて、その場でマイクをテストしてもらう。
try { Start-Process "ms-settings:sound" -ErrorAction SilentlyContinue } catch {}

if ($script:FixesApplied.Count -gt 0) {
    Write-Host ""
    Write-Host "適用した修正:" -ForegroundColor Cyan
    foreach ($f in $script:FixesApplied) { Write-Host "  - $f" }
}

Write-Host ""
Write-Host "完了しました。Enterで閉じます。"
[void](Read-Host)
