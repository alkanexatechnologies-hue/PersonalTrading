#!/bin/bash
# One-time setup (macOS): schedule the 1-minute OI log pull to this Mac.
#   Mon–Fri 08:40  wake the Render app (so it is up and recording from 09:15)
#   Mon–Fri 12:30  pull + merge (safety copy mid-day)
#   Mon–Fri 15:45  pull + merge (full day)
# Files land in ~/Desktop/NSA-OI-Logs/<date>/ ; run log in ~/Library/Logs/nsa-oi-pull.log
# Remove with:  scripts/install-oi-pull.sh --uninstall
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
AGENTS="$HOME/Library/LaunchAgents"
LOGF="$HOME/Library/Logs/nsa-oi-pull.log"
PULL=com.nsa.oi-pull
WAKE=com.nsa.oi-wake

if [ "$1" = "--uninstall" ]; then
  for L in $PULL $WAKE; do launchctl unload "$AGENTS/$L.plist" 2>/dev/null || true; rm -f "$AGENTS/$L.plist"; done
  echo "Removed the scheduled OI pull."; exit 0
fi
[ -n "$NODE" ] || { echo "node not found in PATH"; exit 1; }
mkdir -p "$AGENTS" "$HOME/Library/Logs"

if [ ! -f "$HOME/.nsa-pull.env" ]; then
  cat > "$HOME/.nsa-pull.env" <<EOF
# Settings for scripts/pull-oi-logs.mjs — fill in, keep private (never commit).
NSA_URL=https://YOUR-APP.onrender.com
NSA_USER=admin
NSA_PASS=
NSA_MODE=admin
OUT_DIR=~/Desktop/NSA-OI-Logs
LOCAL_DATA=$REPO/data/oi-minute
EOF
  chmod 600 "$HOME/.nsa-pull.env"
  echo "Created $HOME/.nsa-pull.env — open it and fill in NSA_URL and NSA_PASS."
fi

cal() { # $1 hour $2 minute → Mon..Fri entries
  for d in 1 2 3 4 5; do echo "<dict><key>Weekday</key><integer>$d</integer><key>Hour</key><integer>$1</integer><key>Minute</key><integer>$2</integer></dict>"; done
}
plist() { # $1 label, $2 extra arg, $3 calendar entries
  cat > "$AGENTS/$1.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$REPO/scripts/pull-oi-logs.mjs</string>$2</array>
  <key>StartCalendarInterval</key><array>$3</array>
  <key>StandardOutPath</key><string>$LOGF</string>
  <key>StandardErrorPath</key><string>$LOGF</string>
</dict></plist>
EOF
  launchctl unload "$AGENTS/$1.plist" 2>/dev/null || true
  launchctl load "$AGENTS/$1.plist"
}
plist $WAKE "<string>--wake</string>" "$(cal 8 40)"
plist $PULL "" "$(cal 12 30)$(cal 15 45)"
echo "Scheduled: wake 08:40, pull 12:30 and 15:45 (Mon–Fri). Files: ~/Desktop/NSA-OI-Logs  Log: $LOGF"
echo "Run a pull now with:  node \"$REPO/scripts/pull-oi-logs.mjs\""
