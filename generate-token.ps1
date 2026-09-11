# =========================================================
# Standalone process: generate a Groww access token from your API key + secret.
# It mints the token (official Groww SDK), tests it, and saves it to .groww_token
# so run-groww.ps1 can start the app on the live feed without pasting anything.
#
# Usage:
#   ./generate-token.ps1 -ApiKey "your_api_key" -Secret "your_secret_key"
#
# Your key/secret are used only locally and are NOT written to disk.
# =========================================================
param(
  [Parameter(Mandatory = $true)][string]$ApiKey,
  [Parameter(Mandatory = $true)][string]$Secret
)

$py = "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"
if (-not (Test-Path $py)) {
  # Fall back to whatever "python" resolves to.
  $py = "python"
}

$env:GROWW_API_KEY = $ApiKey
$env:GROWW_API_SECRET = $Secret

Write-Host "Generating Groww access token..." -ForegroundColor Cyan
& $py "$PSScriptRoot\scripts\get_groww_token.py"

# Clear the secrets from this shell session.
Remove-Item Env:\GROWW_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:\GROWW_API_SECRET -ErrorAction SilentlyContinue

if (Test-Path "$PSScriptRoot\.groww_token") {
  Write-Host "`nDone. Now start the app on the live feed with:" -ForegroundColor Green
  Write-Host "   ./run-groww.ps1" -ForegroundColor Yellow
}
