$ErrorActionPreference = 'Continue'
$projectDir = Split-Path -Parent $PSScriptRoot
$nodePath = 'C:\Program Files\nodejs\node.exe'
$logDir = Join-Path $projectDir 'logs'
$logFile = Join-Path $logDir 'service.log'

New-Item -ItemType Directory -Path $logDir -Force | Out-Null
if ((Test-Path -LiteralPath $logFile) -and (Get-Item -LiteralPath $logFile).Length -gt 10MB) {
  Move-Item -LiteralPath $logFile -Destination (Join-Path $logDir 'service.previous.log') -Force
}

Set-Location -LiteralPath $projectDir
while ($true) {
  Add-Content -LiteralPath $logFile -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Starting AlphaPulse"
  & $nodePath --disable-warning=ExperimentalWarning (Join-Path $projectDir 'server.js') *>> $logFile
  Add-Content -LiteralPath $logFile -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] AlphaPulse stopped with exit code $LASTEXITCODE; restarting in 5 seconds"
  Start-Sleep -Seconds 5
}
