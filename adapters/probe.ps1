# =============================================================
#  CbC probe  --  emits one compact JSON line per interval to stdout.
#  Long-lived on purpose: spawning PowerShell every few seconds is
#  expensive, so the hub keeps this process alive and reads lines.
#
#  ASCII-only by design. PS 5.1 mangles Japanese in files without a
#  UTF-8 BOM, so this file simply avoids Japanese entirely.
#  Runtime data (device names etc.) may still be Japanese -- that is
#  handled by forcing the console output encoding to UTF-8 below.
# =============================================================
param([int]$IntervalSec = 2, [int]$TaskEveryNth = 5, [string[]]$TaskNames = @('CbC-Hub'))

$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Only the hosts our tools actually run under. Keeps the CIM query cheap.
$ProcNames = @('powershell.exe','pwsh.exe','pythonw.exe','python.exe','node.exe','wscript.exe','cscript.exe')
# Scheduled tasks to watch. The hub passes the list from registry.json
# (-TaskNames), so it follows whatever the user actually registered.
# Only CbC-Hub is built in, because the hub itself always has it.
# Before this was a hard-coded list of one person's own tasks, which
# meant the file only made sense on that one machine.

$filter = ($ProcNames | ForEach-Object { "Name='$_'" }) -join ' OR '

# Scheduled-task queries cost ~1-2s for the whole set and their state
# barely ever changes, so they are refreshed only every Nth tick. The
# process list -- the part that must react the moment you press stop --
# stays on the fast loop.
$tick = 0
$tasksCache = @()

while ($true) {
    $procs = @()
    try {
        $procs = @(Get-CimInstance Win32_Process -Filter $filter -ErrorAction Stop |
            Select-Object @{n='pid';e={$_.ProcessId}},
                          @{n='name';e={$_.Name}},
                          @{n='cmd';e={$_.CommandLine}})
    } catch { $procs = @() }

    if (($tick % $TaskEveryNth) -ne 0 -and $tasksCache.Count -gt 0) {
        $payload = [pscustomobject]@{
            ts    = (Get-Date).ToString('o')
            procs = $procs
            tasks = $tasksCache
        }
        [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress -Depth 4))
        [Console]::Out.Flush()
        $tick++
        Start-Sleep -Seconds $IntervalSec
        continue
    }

    $tasks = @()
    foreach ($t in $TaskNames) {
        $st = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
        if ($null -eq $st) {
            $tasks += [pscustomobject]@{ name=$t; state='Missing'; lastRun=$null; lastResult=$null; nextRun=$null }
            continue
        }
        $info    = Get-ScheduledTaskInfo -TaskName $t -ErrorAction SilentlyContinue
        $lastRun = $null; $lastRes = $null; $nextRun = $null
        if ($info) {
            if ($info.LastRunTime)  { $lastRun = $info.LastRunTime.ToString('yyyy-MM-dd HH:mm:ss') }
            if ($info.NextRunTime)  { $nextRun = $info.NextRunTime.ToString('yyyy-MM-dd HH:mm:ss') }
            $lastRes = $info.LastTaskResult
        }
        $tasks += [pscustomobject]@{
            name       = $t
            state      = [string]$st.State
            lastRun    = $lastRun
            lastResult = $lastRes
            nextRun    = $nextRun
        }
    }

    $tasksCache = $tasks

    $payload = [pscustomobject]@{
        ts    = (Get-Date).ToString('o')
        procs = $procs
        tasks = $tasks
    }

    $json = $payload | ConvertTo-Json -Compress -Depth 4
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()

    $tick++
    Start-Sleep -Seconds $IntervalSec
}
