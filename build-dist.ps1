param(
    [switch]$NoZip,
    [switch]$NoNode,
    [string]$NodeVersion = '22.16.0'
)

# CbC Tools の配布物を作る。
#
# ここが守るべきこと:
#  1. 受け取った人が「展開してダブルクリックするだけ」で動くこと。
#     → Node.js を同梱する（hub.js は Node の標準ライブラリだけで動くので npm install は不要）。
#  2. 作った本人の環境を混ぜないこと。
#     → registry.json（その人がどのツールを登録したか）と、本人専用のツールは入れない。
#       入るのは registry.sample.json（見本）だけ。
#  3. 絶対パスを残さないこと。
#     → 配布物の中に C:\Users\<名前> が1つでも残っていたら配布を中止する。

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$distName = 'CbC Tools'
$distDir  = Join-Path $PSScriptRoot (Join-Path 'dist' $distName)
$zipFile  = Join-Path $PSScriptRoot (Join-Path 'dist' 'CbC-Tools.zip')
$cacheDir = Join-Path $PSScriptRoot (Join-Path 'dist' '.cache')

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " CbC Tools dist build" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

if (Test-Path $distDir) { Write-Host "Cleaning previous build..."; Remove-Item $distDir -Recurse -Force }
if (Test-Path $zipFile) { Remove-Item $zipFile -Force }
New-Item -ItemType Directory -Path $distDir -Force | Out-Null

# ---- 入れるものを名指しする ----
# 「除外を並べる」のではなく「入れるものを並べる」。
# 除外方式だと、本人専用のものを新しく足したときに黙って混ざる。
Write-Host "Copying files..."
$files = @(
    'CbC起動.bat',
    'CbC停止.bat',
    'cbc.vbs',
    'CONNECT.md'
)
foreach ($f in $files) {
    $src = Join-Path $PSScriptRoot $f
    if (Test-Path $src) { Copy-Item $src $distDir } else { Write-Host ("  ! 見つからない: " + $f) -ForegroundColor Yellow }
}

# README は「買った人向け」の別ファイルを README.md という名前で入れる。
# リポジトリの README.md は作者自身の作業メモで、本人のツールとパスが載っている。
Copy-Item (Join-Path $PSScriptRoot 'README.dist.md') (Join-Path $distDir 'README.md')

# hub（registry.json は入れない。見本だけ入れる）
$hubDst = Join-Path $distDir 'hub'
New-Item -ItemType Directory -Path $hubDst -Force | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'hub\hub.js') $hubDst
Copy-Item (Join-Path $PSScriptRoot 'hub\registry.sample.json') $hubDst
Copy-Item (Join-Path $PSScriptRoot 'hub\public') $hubDst -Recurse

# tray / adapters
Copy-Item (Join-Path $PSScriptRoot 'tray') $distDir -Recurse
Copy-Item (Join-Path $PSScriptRoot 'adapters') $distDir -Recurse

# tools は「共通の部品」と「見本」だけ。本人専用のツールは入れない。
$toolsDst = Join-Path $distDir 'tools'
New-Item -ItemType Directory -Path $toolsDst -Force | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'tools\_shared') $toolsDst -Recurse
Copy-Item (Join-Path $PSScriptRoot 'tools\sample-daemon') $toolsDst -Recurse
Get-ChildItem $toolsDst -Recurse -Directory -Filter '__pycache__' | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

# docs は汎用のものだけ（本人のツールの手順書は入れない）
$docsSrc = Join-Path $PSScriptRoot 'docs'
$docsDst = Join-Path $distDir 'docs'
# docs は同梱しない。作者の作業メモには本人のツール名と個人のパスが混ざっていた。
# 一般に役立つ知見を切り出して書き直すまでは入れない。
$docsKeep = @()
# 入れるものが無いなら、空のフォルダも作らない（何が入るのか分からず迷わせるだけ）
if ($docsKeep.Count -gt 0) {
    New-Item -ItemType Directory -Path $docsDst -Force | Out-Null
    foreach ($d in $docsKeep) {
        $src = Join-Path $docsSrc $d
        if (Test-Path $src) { Copy-Item $src $docsDst }
    }
}

# logs は空で作っておく（無いと初回に迷う）
New-Item -ItemType Directory -Path (Join-Path $distDir 'logs') -Force | Out-Null
[System.IO.File]::WriteAllText(
    (Join-Path $distDir 'logs\README.txt'),
    "CbC と各ツールのログがここに出ます。`r`n最初は空です。`r`n",
    (New-Object System.Text.UTF8Encoding $true))

# ---- Node.js 本体を同梱する ----
if (-not $NoNode) {
    $nodeZipName = "node-v$NodeVersion-win-x64.zip"
    $nodeUrl = "https://nodejs.org/dist/v$NodeVersion/$nodeZipName"
    $cachedZip = Join-Path $cacheDir $nodeZipName
    if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null }
    if (Test-Path $cachedZip) {
        Write-Host "Node.js v$NodeVersion (cached)"
    } else {
        Write-Host "Downloading Node.js v$NodeVersion ..."
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $wc = New-Object System.Net.WebClient
        $wc.DownloadFile($nodeUrl, $cachedZip)
        $wc.Dispose()
    }
    Write-Host "Extracting Node.js..."
    $tmpExtract = Join-Path $cacheDir 'node-extract'
    if (Test-Path $tmpExtract) { Remove-Item $tmpExtract -Recurse -Force }
    Expand-Archive -Path $cachedZip -DestinationPath $tmpExtract -Force
    $extractedDir = Get-ChildItem $tmpExtract -Directory | Select-Object -First 1
    $nodeDistDir = Join-Path $distDir 'node'
    New-Item -ItemType Directory -Path $nodeDistDir -Force | Out-Null
    Copy-Item (Join-Path $extractedDir.FullName 'node.exe') $nodeDistDir
    Remove-Item $tmpExtract -Recurse -Force
    Write-Host "  Bundled node.exe" -ForegroundColor Green
}

# ================= ここから検査 =================

# --- 本人専用のものが混ざっていないか ---
Write-Host "Checking for personal files..."
# tools\ の下は、許可したものだけを通す。
# 名前を並べて禁止する方式だと、新しく作ったツールが素通りする。
$allowedTools = @('_shared', 'sample-daemon', 'check-cmd-encoding.js', 'portable-registry.js')
$leaked = @()
foreach ($f in @('hubegistry.json', 'hub\state.json')) {
    if (Test-Path (Join-Path $distDir $f)) { $leaked += $f }
}
$toolsInDist = Join-Path $distDir 'tools'
if (Test-Path $toolsInDist) {
    foreach ($e in (Get-ChildItem $toolsInDist)) {
        if ($allowedTools -notcontains $e.Name) { $leaked += ('tools' + $e.Name) }
    }
}
if ($leaked.Count -gt 0) {
    $leaked | ForEach-Object { Write-Host ("  " + $_) -ForegroundColor Red }
    throw "配布物に、製品に含めないものが入っています。配布を中止します。"
}
Write-Host "  No personal files" -ForegroundColor Green

# --- 絶対パスが残っていないか ---
# 「他人のPCでは動かない」の主な原因。テキストの中身を全部見る。
Write-Host "Checking for absolute paths..."
$textExt = @('.js', '.json', '.ps1', '.vbs', '.bat', '.cmd', '.md', '.py', '.html', '.txt')
$pathHits = @()
foreach ($f in (Get-ChildItem $distDir -Recurse -File)) {
    if ($textExt -notcontains $f.Extension.ToLower()) { continue }
    $raw = Get-Content $f.FullName -Raw -ErrorAction SilentlyContinue
    if ($null -eq $raw) { continue }
    foreach ($m in [regex]::Matches($raw, '(?i)[A-Z]:\\\\?Users\\\\?[A-Za-z0-9_.-]+')) {
        $pathHits += ($f.FullName.Substring($distDir.Length + 1) + ': ' + $m.Value)
    }
}
if ($pathHits.Count -gt 0) {
    $pathHits | Select-Object -First 20 | ForEach-Object { Write-Host ("  " + $_) -ForegroundColor Red }
    throw "配布物に利用者名つきの絶対パスが残っています。目印（{CBC} など）に直してください。"
}
Write-Host "  No absolute user paths" -ForegroundColor Green

# --- .bat / .vbs が cmd に安全に読めるか ---
# 「ー」(83 5E -> ^) のように、2バイト目が演算子になる文字が入ると静かに壊れる。
Write-Host "Checking launcher encoding..."
$checker = Join-Path $PSScriptRoot 'tools\check-cmd-encoding.js'
if (Test-Path $checker) {
    $nodeForCheck = Join-Path (Join-Path $distDir 'node') 'node.exe'
    if (-not (Test-Path $nodeForCheck)) { $nodeForCheck = 'node' }
    $targets = Get-ChildItem $distDir -File | Where-Object { $_.Extension -in '.bat', '.vbs', '.cmd' } |
        ForEach-Object { $_.FullName }
    & $nodeForCheck $checker @targets | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "起動スクリプトが cmd.exe に安全に読めません。" }
} else {
    Write-Host "  (検査ツールが無いので飛ばした)" -ForegroundColor Yellow
}

$all = Get-ChildItem $distDir -Recurse -File
$sizeMB = [math]::Round((($all | Measure-Object -Property Length -Sum).Sum) / 1MB, 1)
Write-Host ""
Write-Host "Package: $($all.Count) files ($sizeMB MB)" -ForegroundColor Green

if (-not $NoZip) {
    Write-Host "Creating ZIP..."
    Compress-Archive -Path $distDir -DestinationPath $zipFile -Force
    Write-Host ("  " + $zipFile) -ForegroundColor Green
}

Write-Host ""
Write-Host "Done." -ForegroundColor Cyan
Write-Host ""
