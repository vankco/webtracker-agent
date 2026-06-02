#!/usr/bin/env bash
# health-monitor.sh
# Runs every 5 minutes via cron. Two checks:
#   1. Liveness — alert if the app is down (and again when it recovers).
#   2. Flapping — alert if availableProducts bounces across scrapes (≤1/hour).
#
# Note: warn/error alerts are handled in real-time by the app itself (logger.ts).
#
# State: /tmp/webtracker-health-state.json  { lastFlapAlert, appDown }

set -euo pipefail

API_URL="http://localhost:3001/api/logs"
HEALTH_URL="http://localhost:3001/api/config"
STATE_FILE="/tmp/webtracker-health-state.json"
CONFIG_FILE="$(cd "$(dirname "$0")/.." && pwd)/config.json"
FLAP_CHECK_INTERVAL=3600  # alert at most once per hour

DISCORD_WEBHOOK=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['discordWebhookUrl'])" 2>/dev/null || echo "")

if [ -z "$DISCORD_WEBHOOK" ]; then
  echo "[health-monitor] No Discord webhook configured — exiting."
  exit 0
fi

# ---------------------------------------------------------------------------
# Load prior state
# ---------------------------------------------------------------------------
LAST_FLAP_ALERT=0
APP_DOWN=0
if [ -f "$STATE_FILE" ]; then
  LAST_FLAP_ALERT=$(python3 -c "import json; print(json.load(open('$STATE_FILE')).get('lastFlapAlert', 0))" 2>/dev/null || echo 0)
  APP_DOWN=$(python3 -c "import json; print(int(json.load(open('$STATE_FILE')).get('appDown', False)))" 2>/dev/null || echo 0)
fi

notify() {
  curl -s -X POST "$DISCORD_WEBHOOK" -H "Content-Type: application/json" \
    -d "{\"content\": \"$1\"}" > /dev/null 2>&1 || true
}

write_state() {
  python3 -c "import json; json.dump({'lastFlapAlert': $1, 'appDown': bool($2)}, open('$STATE_FILE','w'))"
}

# ---------------------------------------------------------------------------
# 1. Liveness check
# ---------------------------------------------------------------------------
if ! curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
  if [ "$APP_DOWN" -eq 0 ]; then
    notify "🛑 **WebTracker is DOWN** — the app is not responding on :3001 (checked $(date '+%H:%M %Z')). Monitoring is paused until it restarts."
    echo "[health-monitor] App down — alert sent."
  else
    echo "[health-monitor] App still down — already alerted."
  fi
  write_state "$LAST_FLAP_ALERT" 1
  exit 0
fi

# App is up — if it was previously down, announce recovery
if [ "$APP_DOWN" -eq 1 ]; then
  notify "✅ **WebTracker is back UP** — responding again on :3001 (at $(date '+%H:%M %Z'))."
  echo "[health-monitor] App recovered — alert sent."
fi

NOW=$(date +%s)

# ---------------------------------------------------------------------------
# 2. Flapping check
# ---------------------------------------------------------------------------
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
    json.dump({"lastFlapAlert": last_flap_alert, "appDown": False}, open(state_file, "w"))
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
            notify(f"🔄 **WebTracker Flapping Detected** — availableProducts varies across recent scrapes: {counts}. Possible lazy-load timing issue.".replace('"', '\\"'))
            last_flap_alert = now
            print(f"[health-monitor] Flapping alert sent — counts: {counts}")
        else:
            print(f"[health-monitor] No flapping — counts stable: {counts}")
    else:
        print(f"[health-monitor] Not enough fetch entries to check flapping ({len(fetch_entries)})")
else:
    print(f"[health-monitor] Flap check skipped — last alert was {now - last_flap_alert}s ago")

json.dump({"lastFlapAlert": last_flap_alert, "appDown": False}, open(state_file, "w"))
PYEOF
