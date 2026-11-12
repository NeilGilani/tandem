# Builds dist\Tandem\ (Tandem.exe, app\, node\) and dist\Tandem-win.zip.
#   windows\build.ps1            build
#   windows\build.ps1 -Open      build and open the app
#   windows\build.ps1 -NoNode    don't bundle Node (the app then uses the Node on your PATH)
# Bundles the official Node binary, so the app doesn't need Node installed.
# Needs nothing extra: it uses the C# compiler that ships with Windows.
param([switch]$Open, [switch]$NoNode)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$NodeVersion = 'v26.11.1'
$Build = Join-Path $PSScriptRoot '.build'
$Dist = Join-Path $Root 'dist'
$App = Join-Path $Dist 'Tandem'
New-Item -ItemType Directory -Force $Build, $Dist | Out-Null
if (Test-Path $App) { Remove-Item -Recurse -Force $App }
New-Item -ItemType Directory -Force $App | Out-Null

Write-Host '-> Drawing the icon'
Add-Type -AssemblyName System.Drawing
function Draw-Png([int]$px) {
  $bmp = New-Object Drawing.Bitmap $px, $px
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $s = $px / 512.0
  $r = 224 * $s; $e = $px - 1
  $path = New-Object Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $r, $r, 180, 90); $path.AddArc($e - $r, 0, $r, $r, 270, 90)
  $path.AddArc($e - $r, $e - $r, $r, $r, 0, 90); $path.AddArc(0, $e - $r, $r, $r, 90, 90); $path.CloseFigure()
  $g.FillPath((New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(0x6d, 0x5d, 0xfc))), $path)
  $w = [Math]::Max(40 * $s, 1.4)
  $g.DrawEllipse((New-Object Drawing.Pen ([Drawing.Color]::White), $w), [single](104 * $s), [single](164 * $s), [single](184 * $s), [single](184 * $s))
  $g.DrawEllipse((New-Object Drawing.Pen ([Drawing.Color]::FromArgb(178, 255, 255, 255)), $w), [single](224 * $s), [single](164 * $s), [single](184 * $s), [single](184 * $s))
  $g.Dispose()
  $ms = New-Object IO.MemoryStream
  $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  return ,$ms.ToArray()
}
# An .ico is a small directory followed by PNG images.
$sizes = 16, 24, 32, 48, 64, 256
$pngs = $sizes | ForEach-Object { ,(Draw-Png $_) }
$ico = New-Object IO.MemoryStream
$w = New-Object IO.BinaryWriter $ico
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $b = [byte]($sizes[$i] % 256)
  $w.Write($b); $w.Write($b); $w.Write([byte]0); $w.Write([byte]0); $w.Write([uint16]1); $w.Write([uint16]32)
  $w.Write([uint32]$pngs[$i].Length); $w.Write([uint32]$offset)
  $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $w.Write($p) }
$IcoFile = Join-Path $Build 'Tandem.ico'
[IO.File]::WriteAllBytes($IcoFile, $ico.ToArray())

Write-Host '-> Compiling the app'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw 'The .NET Framework C# compiler (csc.exe) was not found.' }
& $csc /nologo /target:winexe /optimize+ /platform:anycpu "/win32icon:$IcoFile" "/out:$(Join-Path $App 'Tandem.exe')" `
  /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll (Join-Path $PSScriptRoot 'Tandem.cs')
if ($LASTEXITCODE) { throw 'Compile failed.' }

if (-not $NoNode) {
  Write-Host "-> Getting Node $NodeVersion"
  $zip = "node-$NodeVersion-win-x64.zip"
  $zipPath = Join-Path $Build $zip
  if (-not (Test-Path $zipPath)) {
    [Net.ServicePointManager]::SecurityProtocol = 'Tls12'
    Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/$zip" -OutFile "$zipPath.part" -UseBasicParsing
    $sums = (Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt" -UseBasicParsing).Content
    $expected = ($sums -split "`n" | Where-Object { $_ -match " $([regex]::Escape($zip))$" }) -replace '\s.*$', ''
    $actual = (Get-FileHash "$zipPath.part" -Algorithm SHA256).Hash.ToLower()
    if (-not $expected -or $expected -ne $actual) { Remove-Item "$zipPath.part"; throw 'Node checksum mismatch' }
    Move-Item "$zipPath.part" $zipPath
  }
  $unz = Join-Path $Build 'node'
  if (Test-Path $unz) { Remove-Item -Recurse -Force $unz }
  Expand-Archive $zipPath -DestinationPath $unz
  $src = Join-Path $unz "node-$NodeVersion-win-x64"
  New-Item -ItemType Directory -Force (Join-Path $App 'node') | Out-Null
  Copy-Item (Join-Path $src 'node.exe'), (Join-Path $src 'LICENSE') (Join-Path $App 'node')
  $npm = Join-Path $src 'npm.cmd'
  $env:PATH = "$src;$env:PATH"
} else {
  $npm = 'npm.cmd'
}

Write-Host '-> Assembling the app'
$dest = Join-Path $App 'app'
New-Item -ItemType Directory -Force $dest | Out-Null
foreach ($d in 'server', 'web', 'mcp', 'bin') { Copy-Item -Recurse (Join-Path $Root $d) (Join-Path $dest $d) }
Copy-Item (Join-Path $Root 'package.json'), (Join-Path $Root 'package-lock.json'), (Join-Path $Root 'LICENSE') $dest
Push-Location $dest
try { & $npm ci --omit=dev --no-audit --no-fund --silent } finally { Pop-Location }
if ($LASTEXITCODE) { throw 'npm ci failed.' }

Write-Host '-> Zipping'
$zipOut = Join-Path $Dist 'Tandem-win.zip'
if (Test-Path $zipOut) { Remove-Item $zipOut }
Compress-Archive -Path $App -DestinationPath $zipOut
$mb = { param($p) '{0:N0} MB' -f ((Get-ChildItem $p -Recurse -File | Measure-Object Length -Sum).Sum / 1MB) }
Write-Host "Built $App ($(& $mb $App)), zip $('{0:N0} MB' -f ((Get-Item $zipOut).Length / 1MB))"
if ($Open) { Start-Process (Join-Path $App 'Tandem.exe') }
