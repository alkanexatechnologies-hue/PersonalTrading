# Starts the app on the Groww real-time feed.
#
# Two ways to use it:
#   1) After running ./generate-token.ps1 (which saves .groww_token):
#        ./run-groww.ps1
#   2) Paste a token directly:
#        ./run-groww.ps1 -Token "PASTE_YOUR_GROWW_ACCESS_TOKEN"
#
# The Groww access token expires daily (~6:00 AM IST) - regenerate each day.
param(
  [string]$Token,
  [int]$Port = 5173
)

if (-not $Token) {
  $tokenFile = "$PSScriptRoot\.groww_token"
  if (Test-Path $tokenFile) {
    $Token = (Get-Content $tokenFile -Raw).Trim()
    Write-Host "Using token from .groww_token" -ForegroundColor Cyan
  } else {
    Write-Host "No token provided and no .groww_token file found." -ForegroundColor Red
    Write-Host "Run:  ./generate-token.ps1 -ApiKey '...' -Secret '...'   (or pass -Token '...')" -ForegroundColor Yellow
    exit 1
  }
}

$env:DATA_PROVIDER = "groww"
$env:GROWW_ACCESS_TOKEN = $Token
$env:PORT = "$Port"
# Trust the Windows certificate store so Node accepts the antivirus/proxy self-signed
# root CA (fixes "fetch failed" / SSL errors when calling api.groww.in). Node 22+.
$env:NODE_OPTIONS = "--use-system-ca"

# --- Keep Windows awake while the app runs (so the scheduler / paper-trading ---
# --- never gets suspended by sleep). Auto-resets when this script exits. ---
$keepAwake = @'
using System;
using System.Runtime.InteropServices;
public static class KeepAwake {
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
'@
try { Add-Type -TypeDefinition $keepAwake -ErrorAction SilentlyContinue } catch {}
# ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x1) | ES_DISPLAY_REQUIRED (0x2)
try {
  [void][KeepAwake]::SetThreadExecutionState([uint32]"0x80000000" -bor 0x1 -bor 0x2)
  Write-Host "Keep-awake enabled: Windows will not sleep while the app runs." -ForegroundColor Cyan
} catch {
  Write-Host "Could not enable keep-awake (app will still run, but disable Windows sleep manually)." -ForegroundColor Yellow
}

try {
  Write-Host "Starting NSE Intraday Assistant on Groww feed (port $Port)..." -ForegroundColor Green
  & "C:\Program Files\nodejs\npm.cmd" start
} finally {
  # Release the keep-awake lock so normal power settings resume.
  try { [void][KeepAwake]::SetThreadExecutionState([uint32]"0x80000000") } catch {}
  Write-Host "Keep-awake released. Normal Windows power settings resumed." -ForegroundColor Cyan
}
