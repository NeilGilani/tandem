# Tandem launcher for Windows (the same commands as bin/tandem on a Mac).
#   tandem start [--lan]    run in this window (Ctrl-C to stop)
#   tandem install [--lan]  run in the background, start when you sign in, restart if it crashes
#   tandem uninstall        stop the background service
#   tandem open             open the app in your browser
#   tandem status | logs
$ErrorActionPreference = 'Stop'
$Command = if ($args.Count) { [string]$args[0] } else { 'start' }
$Lan = $args -contains '--lan'
$Dir = Split-Path -Parent $PSScriptRoot
$Data = if ($env:TANDEM_DATA) { $env:TANDEM_DATA } else { Join-Path $Dir 'data' }
$Port = if ($env:PORT) { $env:PORT } else { '4747' }
$Url = "http://127.0.0.1:$Port"
$Entry = Join-Path $Dir 'server\index.js'
$Log = Join-Path $Data 'tandem.log'
$PidFile = Join-Path $Data 'tandem.pid'
$Shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'Tandem.lnk'

function Need($name, $hint) {
  if (Get-Command $name -ErrorAction SilentlyContinue) { return }
  if ($name -eq 'claude' -and (Test-Path (Join-Path $HOME '.local\bin\claude.exe'))) { return }
  Write-Host "Tandem needs '$name' on your PATH. $hint" -ForegroundColor Red
  exit 1
}
function Ready {
  Need node 'Install Node 22.13 or newer: https://nodejs.org (or: winget install OpenJS.NodeJS.LTS)'
  Need claude 'Install Claude Code and sign in: https://claude.com/claude-code'
  if (-not (Test-Path (Join-Path $Dir 'node_modules\@playwright\mcp'))) {
    Push-Location $Dir
    try { & npm install --silent --no-audit --no-fund } finally { Pop-Location }
  }
}
function IsUp {
  try { $null = Invoke-WebRequest "$Url/api/computer/status" -UseBasicParsing -TimeoutSec 2; return $true } catch { return $false }
}
function StopDaemon {
  if (-not (Test-Path $PidFile)) { return }
  $id = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($id -and (Get-Process -Id $id -ErrorAction SilentlyContinue)) { & taskkill.exe /PID $id /T /F *> $null }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}
function DaemonArgs {
  $a = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" daemon"
  if ($Lan) { $a += ' --lan' }
  return $a
}

switch ($Command) {
  'start' {
    Ready
    $rest = @($args | Select-Object -Skip 1)
    & node $Entry @rest
    exit $LASTEXITCODE
  }
  'daemon' {
    # The background service: keeps the server running and writes its output to the log.
    New-Item -ItemType Directory -Force $Data | Out-Null
    Set-Content -Path $PidFile -Value $PID -Encoding ascii
    $node = (Get-Command node).Source
    $lanArg = if ($Lan) { ' --lan' } else { '' }
    $quick = 0
    while ($true) {
      $began = Get-Date
      & cmd.exe /d /s /c "`"`"$node`" `"$Entry`"$lanArg >> `"$Log`" 2>&1`""
      if (((Get-Date) - $began).TotalSeconds -lt 10) { $quick++ } else { $quick = 0 }
      # Crashing straight away over and over: back off instead of spinning.
      Start-Sleep -Seconds $(if ($quick -ge 5) { 60 } else { 2 })
    }
  }
  'install' {
    Ready
    New-Item -ItemType Directory -Force $Data | Out-Null
    StopDaemon
    $ps = Join-Path $PSHOME 'powershell.exe'
    $link = (New-Object -ComObject WScript.Shell).CreateShortcut($Shortcut)
    $link.TargetPath = $ps
    $link.Arguments = DaemonArgs
    $link.WorkingDirectory = $Dir
    $link.WindowStyle = 7
    $link.Description = 'Tandem: AI coworkers on this PC'
    $link.Save()
    Start-Process -FilePath $ps -ArgumentList (DaemonArgs) -WorkingDirectory $Dir -WindowStyle Hidden
    Write-Host "Tandem is running in the background and starts when you sign in: $Url"
  }
  'uninstall' {
    StopDaemon
    Remove-Item $Shortcut -Force -ErrorAction SilentlyContinue
    Write-Host "Background service removed. Your Bots and data are kept in $Data."
  }
  'open' { Start-Process $Url }
  'status' { if (IsUp) { Write-Host "Running at $Url" } else { Write-Host 'Not running' } }
  'logs' { Get-Content -Path $Log -Tail 100 -Wait }
  default {
    Get-Content $PSCommandPath | Select-Object -Skip 1 -First 5 | ForEach-Object { $_ -replace '^# ?', '' }
    exit 1
  }
}
