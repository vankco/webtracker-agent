#!/usr/bin/env bash
# health-monitor.sh
# Checks the WebTracker Agent debug log for product count flapping and sends
# a Discord alert if detected. Runs every 5 minutes via cron.
#
# Note: warn/error alerts are handled in real-time by the app itself (logger.ts).
# This script only covers flapping which requires looking back across cycles.
#
# State: /tmp/webtracker-health-state.json

set -euo pipefail

API_URL="http://localhost:3001/api/logs"
STATE_FILE="/tmp/webtracker-health-state.json"
CONFIG_FILE="$(cd "$(dirname "$0")/.." && pwd)/config.json"
FLAP_CHECK_INTERVAL=3600  # alert at most once per hour

DISCORD_WEBHOOK=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['discordWebhookUrl'])" 2>/dev/null || echo "")

if [ -z "$DISCORD_WEBHOOK" ]; then
  echo "[health-monitor] No Discord webhook configured — exiting."
  exit 0
fi

if ! curl -sf "$API_URL" > /dev/null 2>&1; then
  echo "[health-monitor] App not running — skipping check."
  exit 0
fi

LAST_FLAP_ALERT=0
if [ -f "$STATE_FILE" ]; then
  LAST_FLAP_ALERT=$(python3 -c "import json; print(json.load(open('$STATE_FILE')).get('lastFlapAlert', 0))")
fi

NOW=$(date +%s)

python3 << PYEOF
import json, urllib.request, sys

api_url = "$API_URL"
discord_webhook = "$DISCORD_WEBHOOK"
last_flap_alert = int("$LAST_FLAP_ALERT")
flap_interval = int("$FLAP_CHECK_INTERVAL")
now = int("$NOW")
state_file = "$STATE_FILE"

def notify(msg):
    payload = json.dumps({"content": msg}).encode()
    req = urllib.request.Request(discord_webhook, data=payload,
                                  headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=5)
    except Exception as e:
        print(f"[health-monitor] Discord notify failed: {e}")

try:
    with urllib.request.urlopen(api_url, timeout=5) as resp:
        logs = json.loads(resp.read())["data"]
except Exception as e:
    print(f"[health-monitor] Could not fetch logs: {e}")
    sys.exit(0)

if (now - last_flap_alert) >= flap_interval:
    fetch_entries = [
        l for l in logs
        if l.get("message") == "Fetch complete"
        and "availableProducts" in str(l.get("details", {}))
    ]
    if len(fetch_entries) >= 3:
        counts = [l["details"]["availableProducts"] for l in fetch_entries[:6]]
        if len(set(counts)) > 1:
            msg = (f"🔄 **WebTracker Flapping Detected** — "
                   f"availableProducts varies across recent scrapes: {counts}. "
                   f"Possible lazy-load timing issue.")
            notify(msg.replace('"', '\\"'))
            last_flap_alert = now
            print(f"[health-monitor] Flapping alert sent — counts: {counts}")
        else:
            print(f"[health-monitor] No flapping — counts stable: {counts}")
    else:
        print(f"[health-monitor] Not enough fetch entries to check flapping ({len(fetch_entries)})")
else:
    print(f"[health-monitor] Flap check skipped — last alert was {now - last_flap_alert}s ago")

with open(state_file, "w") as f:
    json.dump({"lastFlapAlert": last_flap_alert}, f)
PYEOF
