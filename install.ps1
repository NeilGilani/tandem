# Tandem installer for Windows: https://github.com/NeilGilani/tandem
#   irm https://raw.githubusercontent.com/NeilGilani/tandem/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$Repo = 'https://github.com/NeilGilani/tandem.git'
$Dir = if ($env:TANDEM_DIR) { $env:TANDEM_DIR } else { Join-Path $HOME 'tandem' }
function Die($m) { Write-Host "Error: $m" -ForegroundColor Red; exit 1 }
function Has($n) { [bool](Get-Command $n -ErrorAction SilentlyContinue) }

Write-Host 'Installing Tandem'

if (-not (Has git)) { Die 'git is required. Install it with: winget install Git.Git' }
if (-not (Has node)) { Die 'Node 22.13 or newer is required: https://nodejs.org (or: winget install OpenJS.NodeJS.LTS)' }
$v = (& node -p 'process.versions.node').Split('.')
if ([int]$v[0] -lt 22 -or ([int]$v[0] -eq 22 -and [int]$v[1] -lt 13)) { Die "Node $(& node -v) is too old. Tandem needs 22.13 or newer." }
if (-not (Has claude) -and -not (Test-Path (Join-Path $HOME '.local\bin\claude.exe'))) {
  Die "Claude Code is required. Install it, run 'claude' once to sign in, then run this again:`n    irm https://claude.ai/install.ps1 | iex"
}
$browsers = 'Google\Chrome\Application\chrome.exe', 'Microsoft\Edge\Application\msedge.exe', 'BraveSoftware\Brave-Browser\Application\brave.exe'
$roots = $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA | Where-Object { $_ }
if (-not ($roots | ForEach-Object { $r = $_; $browsers | Where-Object { Test-Path (Join-Path $r $_) } })) {
  Write-Host 'No Chrome, Edge or Brave found. Bots need one of them to use websites.' -ForegroundColor Yellow
}

if (Test-Path (Join-Path $Dir '.git')) {
  Write-Host "Updating $Dir..."
  & git -C $Dir pull --ff-only --quiet
} else {
  if (Test-Path $Dir) { Die "$Dir already exists. Set TANDEM_DIR to install somewhere else." }
  Write-Host "Downloading to $Dir..."
  & git clone --quiet --depth 1 $Repo $Dir
}
if ($LASTEXITCODE) { Die 'Could not download Tandem.' }

Write-Host 'Installing dependencies...'
Push-Location $Dir
try { & npm install --silent --no-audit --no-fund } finally { Pop-Location }
if ($LASTEXITCODE) { Die 'npm install failed.' }

$tandem = Join-Path $Dir 'bin\tandem.cmd'
& $tandem install
foreach ($i in 1..40) {
  try { $null = Invoke-WebRequest 'http://127.0.0.1:4747/api/computer/status' -UseBasicParsing -TimeoutSec 2; break } catch { Start-Sleep -Milliseconds 500 }
}
Start-Process 'http://127.0.0.1:4747'

Write-Host ''
Write-Host 'Tandem is running at http://127.0.0.1:4747'
Write-Host 'It runs in the background and starts when you sign in to Windows.'
Write-Host "Commands: $tandem open | status | logs | uninstall"
