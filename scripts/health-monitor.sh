#!/usr/bin/env bash
# health-monitor.sh
# Checks the WebTracker Agent debug log for:
#   1. New warn/error entries → immediate Discord alert
#   2. Product count flapping → Discord alert (checked hourly)
#
# Designed to run every 5 minutes via cron.
# State is stored in /tmp/webtracker-health-state.json

set -euo pipefail

API_URL="http://localhost:3001/api/logs"
STATE_FILE="/tmp/webtracker-health-state.json"
CONFIG_FILE="$(cd "$(dirname "$0")/.." && pwd)/config.json"
FLAP_CHECK_INTERVAL=3600  # only alert on flapping once per hour

# ---------------------------------------------------------------------------
# Read Discord webhook from config.json
# ---------------------------------------------------------------------------
DISCORD_WEBHOOK=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['discordWebhookUrl'])" 2>/dev/null || echo "")

if [ -z "$DISCORD_WEBHOOK" ]; then
  echo "[health-monitor] No Discord webhook configured — exiting."
  exit 0
fi

# ---------------------------------------------------------------------------
# Check if app is running
# ---------------------------------------------------------------------------
if ! curl -sf "$API_URL" > /dev/null 2>&1; then
  echo "[health-monitor] App not running — skipping check."
  exit 0
fi

# ---------------------------------------------------------------------------
# Discord notification helper
# ---------------------------------------------------------------------------
notify() {
  local message="$1"
  curl -s -X POST "$DISCORD_WEBHOOK" \
    -H "Content-Type: application/json" \
    -d "{\"content\": \"$message\"}" > /dev/null
}

# ---------------------------------------------------------------------------
# Load state
# ---------------------------------------------------------------------------
if [ -f "$STATE_FILE" ]; then
  LAST_SEEN_ID=$(python3 -c "import json; print(json.load(open('$STATE_FILE')).get('lastSeenId', 0))")
  LAST_FLAP_ALERT=$(python3 -c "import json; print(json.load(open('$STATE_FILE')).get('lastFlapAlert', 0))")
else
  LAST_SEEN_ID=0
  LAST_FLAP_ALERT=0
fi

NOW=$(date +%s)

# ---------------------------------------------------------------------------
# Fetch logs and run checks
# ---------------------------------------------------------------------------
python3 << PYEOF
import json, urllib.request, sys, os, time

api_url = "$API_URL"
discord_webhook = "$DISCORD_WEBHOOK"
last_seen_id = int("$LAST_SEEN_ID")
last_flap_alert = int("$LAST_FLAP_ALERT")
flap_interval = int("$FLAP_CHECK_INTERVAL")
now = int("$NOW")
state_file = "$STATE_FILE"

def notify(msg):
    import urllib.request
    payload = json.dumps({"content": msg}).encode()
    req = urllib.request.Request(discord_webhook, data=payload,
                                  headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=5)
    except Exception as e:
        print(f"[health-monitor] Discord notify failed: {e}")

# Fetch logs
try:
    with urllib.request.urlopen(api_url, timeout=5) as resp:
        logs = json.loads(resp.read())["data"]
except Exception as e:
    print(f"[health-monitor] Could not fetch logs: {e}")
    sys.exit(0)

if not logs:
    sys.exit(0)

max_id = max(l["id"] for l in logs)

# ---- 1. Warn/error alerts for new entries ----
new_issues = [
    l for l in logs
    if l["id"] > last_seen_id and l["level"] in ("warn", "error")
]

for entry in new_issues:
    level_emoji = "⚠️" if entry["level"] == "warn" else "🔴"
    details = entry.get("details", "")
    details_str = f" | {details}" if details else ""
    msg = (f"{level_emoji} **WebTracker {entry['level'].upper()}** "
           f"[{entry['category']}] {entry['message']}{details_str} "
           f"_(at {entry['timestamp']})_")
    # Escape for JSON string
    msg = msg.replace('"', '\\"').replace('\n', ' ')
    notify(msg)
    print(f"[health-monitor] Alerted: {entry['level']} — {entry['message']}")

# ---- 2. Flapping detection (once per hour) ----
if (now - last_flap_alert) >= flap_interval:
    fetch_entries = [
        l for l in logs
        if l.get("message") == "Fetch complete"
        and "availableProducts" in str(l.get("details", {}))
    ]
    if len(fetch_entries) >= 3:
        counts = [l["details"]["availableProducts"] for l in fetch_entries[:6]]
        unique_counts = set(counts)
        if len(unique_counts) > 1:
            msg = (f"🔄 **WebTracker Flapping Detected** — "
                   f"availableProducts varies across recent scrapes: {counts}. "
                   f"Possible lazy-load timing issue.")
            msg = msg.replace('"', '\\"')
            notify(msg)
            last_flap_alert = now
            print(f"[health-monitor] Flapping alert sent — counts: {counts}")

# ---- Save state ----
state = {"lastSeenId": max_id, "lastFlapAlert": last_flap_alert}
with open(state_file, "w") as f:
    json.dump(state, f)

print(f"[health-monitor] Checked. lastSeenId={max_id}, newIssues={len(new_issues)}")
PYEOF
