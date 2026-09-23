$ErrorActionPreference = 'Stop'
try {
  $health = Invoke-RestMethod -Uri 'http://127.0.0.1:4173/api/health' -TimeoutSec 8
  $ageSeconds = [math]::Round(((Get-Date).ToUniversalTime() - [DateTimeOffset]::FromUnixTimeMilliseconds($health.lastRefresh).UtcDateTime).TotalSeconds, 1)
  [pscustomobject]@{
    Status = if ($health.ok -and $ageSeconds -lt 20) { 'RUNNING' } else { 'STALE' }
    Mode = $health.mode
    LastRefreshSecondsAgo = $ageSeconds
    Tokens = $health.cachedTokens
    Histories = $health.histories
    Alerts = $health.alerts
    StrategyDatabase = if ($health.performanceDatabase) { 'READY' } else { 'NOT READY' }
    ChainIntel = if ($health.chainIntel.configured) { "$($health.chainIntel.status) · $($health.chainIntel.trackedTokens) tokens" } else { 'NOT CONFIGURED' }
    AutoTrading = if ($health.trading.enabled) { "PAPER ACTIVE · $($health.trading.managedPositions) positions" } else { 'PAPER PAUSED' }
    LiveTrading = if ($health.trading.liveExecution) { 'ENABLED' } else { 'LOCKED · CONFIRMATION REQUIRED' }
    Source = $health.source
    Error = $health.error
  } | Format-List
} catch {
  Write-Host 'Status : STOPPED' -ForegroundColor Red
  Write-Host $_.Exception.Message
  exit 1
}
