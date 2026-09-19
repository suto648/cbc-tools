# =============================================================
#  CbC Tools — 全部止める
#
#  CbC が起動したツールを止め、環境を元に戻してから
#  ハブとトレイを畳む。トレイ右クリックの
#  「全部止めて終了」と同じことをする。
#
#  日本語のメッセージはここに置く。呼び出し元の .bat は
#  ASCII 限定（cmd が CP932 で読むため）。
#
#  【重要】UTF-8 BOM 付きで保存すること。
# =============================================================
$ErrorActionPreference = 'SilentlyContinue'

$BaseUrl = 'http://127.0.0.1:47821'
$Root = Split-Path -Parent $PSScriptRoot

Write-Host ''
try {
    Invoke-RestMethod -Uri "$BaseUrl/api/shutdown" -Method POST -Body '{}' `
                      -ContentType 'application/json' -TimeoutSec 20 | Out-Null
    Write-Host '  ツールを止めて、環境を元に戻しました。' -ForegroundColor Green
} catch {
    Write-Host '  CbC は動いていませんでした。' -ForegroundColor Yellow
}

# トレイが shutdown.flag を見て自分で畳むのを待つ
Start-Sleep -Seconds 6

# 罠: 「コマンド文字列に 'CbC Tools' を含む」で
# 探すと、自分自身も、自分を起動した cmd.exe も引っかかる。実際に
# ①自分を kill し ②親の cmd を kill した（どちらも exit 255 になる）。
#
# 曖昧な部分一致で薙ぎ払わず、**自分が持っている3つだけを名指しする**。
$Owned = @('tray\tray.ps1', 'hub\hub.js', 'adapters\probe.ps1')

function Get-Leftovers {
    $all = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='node.exe'")
    @($all | Where-Object {
        $cmd = $_.CommandLine
        if (-not $cmd) { return $false }
        if ($_.ProcessId -eq $PID) { return $false }
        if ($cmd -like '*-Command*') { return $false }     # 誰かの対話シェル
        $hit = $false
        foreach ($o in $Owned) { if ($cmd -like "*$o*") { $hit = $true } }
        $hit
    })
}

# @() で受け直す。空を返した関数の戻り値は $null に潰れ、
# .Count が空になって判定を誤る（PowerShell の癖）。
$left = @(Get-Leftovers)

if ($left.Count -gt 0) {
    Write-Host "  自分で畳まなかった $($left.Count) 個を片付けます。" -ForegroundColor Yellow
    foreach ($p in $left) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
}

Remove-Item (Join-Path $Root 'logs\shutdown.flag') -Force -ErrorAction SilentlyContinue

$still = @(Get-Leftovers)

Write-Host ''
if ($still.Count -eq 0) {
    Write-Host '  停止しました。' -ForegroundColor Green
} else {
    Write-Host "  $($still.Count) 個が残っています。タスクマネージャーで確認してください。" -ForegroundColor Red
}
Write-Host ''
Start-Sleep -Seconds 2
