# =====================================================================
#  NSE Intraday Assistant - ONE-COMMAND start  (DHAN feed)
#  Usage (PowerShell, from the project folder):
#      .\start.ps1
#
#  What it does:
#    1) Starts the server (backend\server.ts) on the DHAN market-data feed.
#    2) Keeps Windows awake while the app runs.
#
#  DHAN is the single market-data source (quotes, candles, option chain, OI,
#  India VIX). The Dhan access token is managed inside the app: paste it in the
#  Admin Control Center -> Connections -> Dhan, or set DHAN_ACCESS_TOKEN. The
#  server auto-connects the saved Dhan token on boot. Tokens expire daily ~6 AM
#  IST. Groww is NOT used.  (Optional: drop a token into .dhan_token to seed it.)
# =====================================================================
param(
  [int]$Port = 5173
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# ---- Environment: DHAN feed only ---------------------------------------------
$env:DATA_PROVIDER = "dhan"
$env:PORT          = "$Port"
$env:NODE_OPTIONS  = "--use-system-ca"

# Optional convenience: if a .dhan_token file exists, seed DHAN_ACCESS_TOKEN from
# it (the app still prefers a token saved via the Admin UI). No Groww token is set.
$dhanTokenFile = "$PSScriptRoot\.dhan_token"
if (Test-Path $dhanTokenFile) {
  $dtok = (Get-Content $dhanTokenFile -Raw).Trim()
  if ($dtok) { $env:DHAN_ACCESS_TOKEN = $dtok }
}

# ---- Keep Windows awake while the app runs -----------------------------------
$keepAwake = @'
using System;
using System.Runtime.InteropServices;
public static class KeepAwake {
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
'@
try { Add-Type -TypeDefinition $keepAwake -ErrorAction SilentlyContinue } catch {}
try { [void][KeepAwake]::SetThreadExecutionState([uint32]"0x80000000" -bor 0x1 -bor 0x2) } catch {}

# ---- Start the server --------------------------------------------------------
try {
  Write-Host "`n  Starting NSE Intraday Assistant (DHAN feed) on http://localhost:$Port" -ForegroundColor Green
  Write-Host "  Press Ctrl+C to stop.`n" -ForegroundColor DarkGray
  & "C:\Program Files\nodejs\npm.cmd" start
} finally {
  try { [void][KeepAwake]::SetThreadExecutionState([uint32]"0x80000000") } catch {}
  Write-Host "`nStopped. Normal Windows power settings resumed." -ForegroundColor Cyan
}
