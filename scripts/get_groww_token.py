"""
Mint a Groww access token from your API key + secret (official SDK method),
then print it so you can paste it into the app's "Connect data" panel.

Your key/secret are read from environment variables so they are never hard-coded
or shared. Set them locally, then run this script.

SETUP (one time):
    pip install growwapi

RUN (PowerShell):
    $env:GROWW_API_KEY="your_api_key"
    $env:GROWW_API_SECRET="your_secret_key"
    python scripts/get_groww_token.py

It prints the access token. Copy it into the dashboard -> "Connect data" -> paste -> Connect Groww.
The token is valid for the trading day (regenerate next day).
"""

import os
import sys

# Trust the OS (Windows) certificate store so corporate-proxy / antivirus
# self-signed root CAs are accepted (fixes SSL CERTIFICATE_VERIFY_FAILED).
try:
    import truststore
    truststore.inject_into_ssl()
except Exception:
    pass

try:
    from growwapi import GrowwAPI
except ImportError:
    print("growwapi is not installed. Run:  pip install growwapi")
    sys.exit(1)

api_key = os.environ.get("GROWW_API_KEY")
secret = os.environ.get("GROWW_API_SECRET")

if not api_key or not secret:
    print("Set GROWW_API_KEY and GROWW_API_SECRET environment variables first.")
    sys.exit(1)

try:
    access_token = GrowwAPI.get_access_token(api_key=api_key, secret=secret)
except Exception as e:
    print(f"Failed to get access token: {e}")
    print("Check: subscription active, key approved for today, and IP whitelisted.")
    sys.exit(1)

# Quick sanity check that the token can actually call the API.
try:
    groww = GrowwAPI(access_token)
    holdings = groww.get_holdings_for_user()
    print("Token works - holdings call succeeded.")
except Exception as e:
    print(f"WARNING: token generated but an API call failed: {e}")
    print("This usually means the subscription/entitlement is not active yet.")

# Save the token to a local file so the app runner can pick it up automatically.
token_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".groww_token")
try:
    with open(token_path, "w", encoding="utf-8") as f:
        f.write(access_token)
    print(f"\nToken saved to: {token_path}")
except Exception as e:
    print(f"(Could not save token file: {e})")

print("\n===== ACCESS TOKEN (also paste into Connect data panel if you like) =====")
print(access_token)
print("=========================================================================")
