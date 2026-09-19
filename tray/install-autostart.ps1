# =============================================================
#  CbC-Hub をログオン時に自動起動させる（登録／解除）
#
#  Windows に登録するタスクはこれ1個だけにする。
#  ツールごとの自動起動は CbC の窓のトグルで決める。
#
#  使い方:
#     .\install-autostart.ps1            登録する
#     .\install-autostart.ps1 -Remove    解除する
#     .\install-autostart.ps1 -Status    今どうなっているか見る
#
#  UTF-8 BOM 付きで保存すること（PS 5.1 が日本語を壊すため）。
# =============================================================
param([switch]$Remove, [switch]$Status)

$ErrorActionPreference = 'Stop'
$TaskName = 'CbC-Hub'
$Root = Split-Path -Parent $PSScriptRoot
$Vbs  = Join-Path $Root 'cbc.vbs'

function Show-Status {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $t) { Write-Host "未登録です。" -ForegroundColor Yellow; return }
    $i = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
    Write-Host "登録済み: $TaskName" -ForegroundColor Green
    Write-Host "  状態     : $($t.State)"
    Write-Host "  実行内容 : $($t.Actions[0].Execute) $($t.Actions[0].Arguments)"
    if ($i) { Write-Host "  前回実行 : $($i.LastRunTime)  (結果 $($i.LastTaskResult))" }
}

if ($Status) { Show-Status; return }

if ($Remove) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "解除しました: $TaskName" -ForegroundColor Green
    } else {
        Write-Host "もともと登録されていません。" -ForegroundColor Yellow
    }
    return
}

if (-not (Test-Path $Vbs)) { throw "cbc.vbs が見つかりません: $Vbs" }

# パスにスペース("CbC Tools")があるので引用符は必須。
# /silent = 窓を開かずトレイだけ常駐する（ログオン時に窓が出ると邪魔なため）。
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $Vbs + '" /silent')

$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$trigger.Delay = 'PT20S'   # 起動直後の混雑を避けて少し待つ

# 非昇格で走らせる。昇格が要るツールは
# ツール個別の CbC-<tool> タスク経由で上げる設計。
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
                                        -LogonType Interactive -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
                                         -DontStopIfGoingOnBatteries `
                                         -StartWhenAvailable `
                                         -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
                       -Principal $principal -Settings $settings `
                       -Description 'CbC Tools のトレイとハブをログオン時に起動する' -Force | Out-Null

Write-Host "登録しました。" -ForegroundColor Green
Show-Status
