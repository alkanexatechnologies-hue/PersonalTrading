# =====================================================================
#  NSE Intraday Assistant - ONE-COMMAND start
#  Usage (PowerShell, from the project folder d:\NSA):
#      .\start.ps1
#
#  What it does:
#    1) Loads the saved Groww access token from .groww_token.
#    2) Sets the environment and starts the server (backend\server.ts).
#    3) Keeps Windows awake while the app runs.
#
#  The ACCESS TOKEN is the only Groww credential. Generate it on
#  Groww -> Settings -> Trading APIs and save it either by pasting it into
#  the app's Admin Control Center -> Connections -> Groww -> Manage, or by
#  writing it to .groww_token (gitignored). Tokens expire daily ~6 AM IST.
# =====================================================================
param(
  [int]$Port = 5173
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$tokenFile = "$PSScriptRoot\.groww_token"

# ---- 2) Load the token -------------------------------------------------------
if (-not (Test-Path $tokenFile)) {
  Write-Host "ERROR: .groww_token not found." -ForegroundColor Red
  Write-Host "  Generate an access token on Groww -> Settings -> Trading APIs, then save it" -ForegroundColor Yellow
  Write-Host "  via the app (Admin Control Center -> Connections -> Groww) or into .groww_token" -ForegroundColor Yellow
  exit 1
}
$token = (Get-Content $tokenFile -Raw).Trim()
if (-not $token) { Write-Host "ERROR: .groww_token is empty." -ForegroundColor Red; exit 1 }

# ---- 3) Environment ----------------------------------------------------------
$env:DATA_PROVIDER      = "groww"
$env:GROWW_ACCESS_TOKEN = $token
$env:PORT               = "$Port"
$env:NODE_OPTIONS       = "--use-system-ca"

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

# ---- 4) Start the server -----------------------------------------------------
try {
  Write-Host "`n  Starting NSE Intraday Assistant (Groww feed) on http://localhost:$Port" -ForegroundColor Green
  Write-Host "  Press Ctrl+C to stop.`n" -ForegroundColor DarkGray
  & "C:\Program Files\nodejs\npm.cmd" start
} finally {
  try { [void][KeepAwake]::SetThreadExecutionState([uint32]"0x80000000") } catch {}
  Write-Host "`nStopped. Normal Windows power settings resumed." -ForegroundColor Cyan
}
