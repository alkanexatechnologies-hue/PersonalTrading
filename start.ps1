# =====================================================================
#  NSE Intraday Assistant - ONE-COMMAND start
#  Usage (PowerShell, from the project folder d:\NSA):
#      .\start.ps1
#
#  What it does:
#    1) Refreshes the Groww access token (if API key/secret are available),
#       otherwise uses the existing .groww_token.
#    2) Sets the environment and starts the server (backend\server.ts).
#    3) Keeps Windows awake while the app runs.
#
#  Provide credentials ANY of these ways (needed only to auto-refresh the
#  daily token - otherwise it reuses the last .groww_token):
#    a) Pass them:   .\start.ps1 -ApiKey "xxx" -Secret "yyy"
#    b) Env vars:    $env:GROWW_API_KEY / $env:GROWW_API_SECRET
#    c) Local file:  create .groww_creds.ps1 (gitignored) with:
#                       $env:GROWW_API_KEY="xxx"
#                       $env:GROWW_API_SECRET="yyy"
#
#  Skip the refresh and just reuse the saved token:
#      .\start.ps1 -SkipTokenRefresh
# =====================================================================
param(
  [string]$ApiKey,
  [string]$Secret,
  [int]$Port = 5173,
  [switch]$SkipTokenRefresh
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$tokenFile = "$PSScriptRoot\.groww_token"

# ---- 1) Refresh the Groww token (best-effort) --------------------------------
if (-not $SkipTokenRefresh) {
  if ($ApiKey) { $env:GROWW_API_KEY = $ApiKey }
  if ($Secret) { $env:GROWW_API_SECRET = $Secret }
  $credsFile = Join-Path $PSScriptRoot ".groww_creds.ps1"
  if ((-not $env:GROWW_API_KEY -or -not $env:GROWW_API_SECRET) -and (Test-Path $credsFile)) {
    Write-Host "Loading credentials from .groww_creds.ps1" -ForegroundColor Cyan
    . $credsFile
  }

  if ($env:GROWW_API_KEY -and $env:GROWW_API_SECRET) {
    $py = $null
    foreach ($c in @("python", "py")) {
      if (Get-Command $c -ErrorAction SilentlyContinue) { $py = $c; break }
    }
    if ($py) {
      Write-Host "Refreshing Groww token via $py scripts\get_groww_token.py ..." -ForegroundColor Green
      & $py "scripts\get_groww_token.py"
      if ($LASTEXITCODE -ne 0) {
        Write-Host "Token refresh failed (exit $LASTEXITCODE). Trying the existing .groww_token." -ForegroundColor Yellow
      }
    } else {
      Write-Host "Python not found - skipping token refresh, using existing .groww_token." -ForegroundColor Yellow
    }
  } else {
    Write-Host "No API key/secret - skipping refresh, using existing .groww_token." -ForegroundColor Yellow
    Write-Host "(Set them via -ApiKey/-Secret, env vars, or .groww_creds.ps1 to auto-refresh daily.)" -ForegroundColor DarkGray
  }
}

# ---- 2) Load the token -------------------------------------------------------
if (-not (Test-Path $tokenFile)) {
  Write-Host "ERROR: .groww_token not found. Generate it once:" -ForegroundColor Red
  Write-Host '  $env:GROWW_API_KEY="xxx"; $env:GROWW_API_SECRET="yyy"; python scripts\get_groww_token.py' -ForegroundColor Yellow
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
