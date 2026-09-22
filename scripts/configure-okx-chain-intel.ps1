$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectDir '.env'

if (Test-Path -LiteralPath $envPath) {
  $answer = Read-Host '.env already exists. Type YES to replace the OKX configuration'
  if ($answer -ne 'YES') { Write-Host 'Cancelled. Existing configuration was not changed.'; exit 0 }
}

function ConvertTo-PlainText([Security.SecureString]$value) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($value)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

$apiKey = ConvertTo-PlainText (Read-Host 'OKX Developer Portal API Key (hidden input)' -AsSecureString)
$secretKey = ConvertTo-PlainText (Read-Host 'Secret Key (hidden input)' -AsSecureString)
$passphrase = ConvertTo-PlainText (Read-Host 'Passphrase (hidden input)' -AsSecureString)

if (-not $apiKey -or -not $secretKey -or -not $passphrase) { throw 'All three values are required.' }
if ($apiKey -match "[`r`n]" -or $secretKey -match "[`r`n]" -or $passphrase -match "[`r`n]") { throw 'Configuration values cannot contain a line break.' }

$content = @(
  "OKX_CHAIN_INTEL_ENABLED=true"
  "OKX_DEX_API_KEY=$apiKey"
  "OKX_DEX_SECRET_KEY=$secretKey"
  "OKX_DEX_PASSPHRASE=$passphrase"
) -join [Environment]::NewLine

Set-Content -LiteralPath $envPath -Value $content -Encoding utf8 -NoNewline
Write-Host "Configuration saved to $envPath" -ForegroundColor Green

$taskName = 'AlphaPulse Monitor'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Host 'AlphaPulse Monitor scheduled task was not found. Start the service manually.' -ForegroundColor Yellow
  exit 0
}

if ($task.State -eq 'Running') {
  Stop-ScheduledTask -TaskName $taskName
  Start-Sleep -Milliseconds 800
}
Start-ScheduledTask -TaskName $taskName
Write-Host 'AlphaPulse Monitor restarted. Verifying the OKX connection...' -ForegroundColor Cyan

for ($attempt = 0; $attempt -lt 20; $attempt++) {
  Start-Sleep -Seconds 1
  try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:4173/api/health' -TimeoutSec 3
    if ($health.chainIntel.configured) {
      Write-Host "OKX status: $($health.chainIntel.status); subscriptions: $($health.chainIntel.subscriptions)" -ForegroundColor Green
      if ($health.chainIntel.error) { Write-Host "Connection message: $($health.chainIntel.error)" -ForegroundColor Yellow }
      exit 0
    }
  } catch {}
}

Write-Host 'The service is running, but OKX is not ready yet. Run status-alphapulse.ps1 later.' -ForegroundColor Yellow
