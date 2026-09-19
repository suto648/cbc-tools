# =============================================================
#  CbC Tools — トレイ常駐
#  PowerShell 5.1 の NotifyIcon（追加インストール不要）。
#  常駐トレイの作り方として実績のある手法に揃えてある。
#
#  役割:
#    * ハブ(node)が居なければ起動する
#    * 3秒ごとに /api/tools を読み、アイコンの色とツールチップに反映
#    * 警報に変わった瞬間だけバルーンで知らせる
#
#  【重要】このファイルは UTF-8 BOM 付きで保存すること。
#  PS 5.1 は BOM が無いと日本語を壊す。
# =============================================================
param([switch]$Silent)

$ErrorActionPreference = 'Stop'

# --- 多重起動防止 -------------------------------------------------
# Global\ はプロセスは違えど制限ユーザーでは共有されず、ロックにならない。
# セッションローカルの mutex を使う（実機で確認済み）。
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'CbC-Tray-Singleton', [ref]$created)
if (-not $created) {
    # 既に常駐している。ここで黙って終わると、ランチャーを押した人には
    # 「何も起きなかった」ようにしか見えない。動いている方に窓を開かせる。
    if (-not $Silent) {
        try { Invoke-RestMethod -Uri 'http://127.0.0.1:47821/api/window' -Method POST -TimeoutSec 4 | Out-Null } catch {}
    }
    exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$Root     = Split-Path -Parent $PSScriptRoot
$HubJs    = Join-Path $Root 'hub\hub.js'
$LogDir   = Join-Path $Root 'logs'
$StopFlag = Join-Path $LogDir 'shutdown.flag'
$BaseUrl  = 'http://127.0.0.1:47821'

# --- ランプアイコン（色ごとに1回だけ作って使い回す） ----------------
function New-LampIcon([System.Drawing.Color]$fill) {
    $bmp = New-Object System.Drawing.Bitmap 16, 16
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $housing = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(235, 33, 36, 30))
    $g.FillEllipse($housing, 0, 0, 15, 15)
    $lamp = New-Object System.Drawing.SolidBrush $fill
    $g.FillEllipse($lamp, 3, 3, 9, 9)
    $housing.Dispose(); $lamp.Dispose(); $g.Dispose()
    $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
    $bmp.Dispose()
    return $icon
}

$Icons = @{
    ok      = New-LampIcon ([System.Drawing.Color]::FromArgb(99, 214, 142))
    partial = New-LampIcon ([System.Drawing.Color]::FromArgb(138, 147, 132))
    warn    = New-LampIcon ([System.Drawing.Color]::FromArgb(255, 176, 46))
    alert   = New-LampIcon ([System.Drawing.Color]::FromArgb(255, 81, 64))
    dead    = New-LampIcon ([System.Drawing.Color]::FromArgb(70, 76, 68))
}

# --- ハブの起動 ---------------------------------------------------
function Test-Hub {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $r = $c.BeginConnect('127.0.0.1', 47821, $null, $null)
        $ok = $r.AsyncWaitHandle.WaitOne(400)
        if ($ok) { $c.EndConnect($r) }
        $c.Close()
        return $ok
    } catch { return $false }
}

$script:hubTries = 0
$script:hubNextTry = [datetime]::MinValue
$script:hubGaveUp = $false
$script:quitting = $false

# Application::Exit() は WM_QUIT を投げるだけで、その場では止まらない。
# タイマーを先に止めて合図を立てておかないと、終了が処理されるまでの
# 数秒のあいだに次のティックが走ってハブを立て直してしまう（実測済み）。
function Quit-App {
    if ($script:quitting) { return }
    $script:quitting = $true
    try { $timer.Stop() } catch {}
    try { $ni.Visible = $false } catch {}
    [System.Windows.Forms.Application]::Exit()
}

function Start-Hub {
    if ($script:quitting) { return }
    if (Test-Hub) { $script:hubTries = 0; $script:hubGaveUp = $false; return }

    # 窓の「全部止める」が押されていたら、蘇生させずに自分も畳む。
    if (Test-Path $StopFlag) {
        Remove-Item $StopFlag -Force -ErrorAction SilentlyContinue
        Quit-App
        return
    }

    if ($script:hubGaveUp) { return }
    if ((Get-Date) -lt $script:hubNextTry) { return }

    $script:hubTries++
    $script:hubNextTry = (Get-Date).AddSeconds(12)

    if ($Silent) { $env:CBC_NO_WINDOW = '1' } else { Remove-Item Env:\CBC_NO_WINDOW -ErrorAction SilentlyContinue }
    try {
        # フォルダ名にスペースが入る（"CbC Tools"）。-ArgumentList は自動で
        # 引用してくれないので、自分で二重引用符を付ける。忘れると node は
        # 先頭の一語（例: "C:\Program"）だけを開こうとして黙って死ぬ。
        Start-Process -FilePath 'node' `
                      -ArgumentList @('"' + $HubJs + '"') `
                      -WorkingDirectory (Split-Path -Parent $HubJs) `
                      -NoNewWindow
    } catch {
        $script:hubGaveUp = $true
        [System.Windows.Forms.MessageBox]::Show("ハブを起動できませんでした。node が見つかりません。`n" + $_.Exception.Message, 'CbC Tools') | Out-Null
    }

    if ($script:hubTries -ge 4) {
        $script:hubGaveUp = $true
        $ni.BalloonTipTitle = 'CbC Tools'
        $ni.BalloonTipText  = 'ハブを起動できません。logs\hub.log を見てください。トレイの「窓を開く」で再試行します。'
        $ni.BalloonTipIcon  = [System.Windows.Forms.ToolTipIcon]::Error
        $ni.ShowBalloonTip(10000)
    }
}

function Invoke-Hub([string]$path, [string]$method = 'GET') {
    try { return Invoke-RestMethod -Uri ($BaseUrl + $path) -Method $method -TimeoutSec 3 }
    catch { return $null }
}

function Open-Window { Invoke-Hub '/api/window' 'POST' | Out-Null }

# --- トレイ本体 ---------------------------------------------------
$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = $Icons.partial
$ni.Text = 'CbC Tools'
$ni.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miOpen = $menu.Items.Add('窓を開く')
$miOpen.add_Click({
    # 手で押したときは「もう一度やってみろ」の意味なので、諦めを解除する
    $script:hubGaveUp = $false
    $script:hubTries = 0
    $script:hubNextTry = [datetime]::MinValue
    Start-Hub
    Open-Window
})

$miLogs = $menu.Items.Add('ログフォルダ')
$miLogs.add_Click({ Start-Process explorer.exe $LogDir })

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$miStopAll = $menu.Items.Add('全部止めて終了')
$miStopAll.add_Click({
    $script:quitting = $true          # 応答を待つ間にティックが走らないように先に止める
    try { $timer.Stop() } catch {}
    Invoke-Hub '/api/shutdown' 'POST' | Out-Null
    Remove-Item $StopFlag -Force -ErrorAction SilentlyContinue
    Quit-App
})

$miQuit = $menu.Items.Add('トレイだけ終了（ツールは動かしたまま）')
$miQuit.add_Click({ Quit-App })

$ni.ContextMenuStrip = $menu
$ni.add_MouseClick({ if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Open-Window } })

# --- 状態の見張り -------------------------------------------------
$script:lastLevel = ''

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.add_Tick({
    if ($script:quitting) { return }
    $data = Invoke-Hub '/api/tools'
    if ($null -eq $data) {
        $ni.Icon = $Icons.dead
        $ni.Text = 'CbC Tools — ハブが応答しません'
        $script:lastLevel = 'dead'
        Start-Hub
        return
    }

    $level = [string]$data.overall
    if (-not $Icons.ContainsKey($level)) { $level = 'partial' }
    $ni.Icon = $Icons[$level]

    $live    = @($data.tools | Where-Object { $_.implemented })
    $running = @($live | Where-Object { $_.state -eq 'running' }).Count
    $bad     = @($live | Where-Object { $_.state -eq 'alert' -or $_.state -eq 'warn' })

    $tip = "CbC Tools — $running/$($live.Count) 稼働中"
    if ($bad.Count -gt 0) { $tip = "CbC Tools — 要確認: " + (($bad | ForEach-Object { $_.name }) -join ', ') }
    if ($tip.Length -gt 62) { $tip = $tip.Substring(0, 61) + '…' }
    $ni.Text = $tip

    # 警報に「入った瞬間」だけ知らせる。鳴りっぱなしにはしない。
    if ($level -eq 'alert' -and $script:lastLevel -ne 'alert') {
        $first = $bad | Select-Object -First 1
        $ni.BalloonTipTitle = 'CbC Tools'
        $ni.BalloonTipText  = if ($first) { "$($first.name): $($first.detail)" } else { '要確認の状態があります' }
        $ni.BalloonTipIcon  = [System.Windows.Forms.ToolTipIcon]::Warning
        $ni.ShowBalloonTip(8000)
    }
    $script:lastLevel = $level
})

# 手で起動した＝動かす意思なので、前回の「止める」宣言は捨てる
Remove-Item $StopFlag -Force -ErrorAction SilentlyContinue

# ハブが既に居る場合、Start-Hub は何もしない＝窓も開かない。
# （新しく起こす場合はハブ自身が窓を開くので、こちらは出さない）
$hubWasUp = Test-Hub
Start-Hub
if (-not $Silent -and $hubWasUp) { Open-Window }

$timer.Start()

try {
    [System.Windows.Forms.Application]::Run((New-Object System.Windows.Forms.ApplicationContext))
} finally {
    $timer.Stop()
    $ni.Visible = $false
    $ni.Dispose()
    $mutex.ReleaseMutex()
}
