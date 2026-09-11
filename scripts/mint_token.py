"""Mint a Groww access token from GROWW_API_KEY/GROWW_API_SECRET env vars.
Prints ONLY the token to stdout (for the server to capture). Exit non-zero on error."""
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
    sys.stderr.write("growwapi not installed")
    sys.exit(3)

api_key = os.environ.get("GROWW_API_KEY")
secret = os.environ.get("GROWW_API_SECRET")
if not api_key or not secret:
    sys.stderr.write("missing api key/secret")
    sys.exit(2)

try:
    token = GrowwAPI.get_access_token(api_key=api_key, secret=secret)
    sys.stdout.write(token or "")
except Exception as e:  # noqa
    sys.stderr.write(str(e))
    sys.exit(1)
