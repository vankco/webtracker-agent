/**
 * health-monitor.ts
 * Standalone monitoring process — runs separately from the main agent so it can
 * detect when the agent itself goes down (a dead app can't report on itself).
 *
 * Polls the agent's REST API every CHECK_INTERVAL and sends Discord alerts for:
 *   1. Liveness   — agent down (once) and recovered (once).
 *   2. Flapping   — availableProducts bouncing across recent scrapes (≤1/hour).
 *
 * Start with:  npm run monitor   (also launched alongside the app by `npm start`)
 */

import 'dotenv/config';
import { resolveEnv } from './config.js';

const env = resolveEnv();
const PORT = env['API_PORT'] || '3001';
const BASE = `http://localhost:${PORT}/api`;
const WEBHOOK = env['DISCORD_SYSTEM_WEBHOOK_URL'] || env['DISCORD_WEBHOOK_URL'] || '';

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
const FLAP_COOLDOWN_MS = 60 * 60 * 1000; // alert on flapping at most once/hour
const STARTUP_GRACE_MS = 30 * 1000;      // give the agent time to boot before first check
const DOWN_RETRIES = 2;                   // confirm down across retries before alerting

// In-memory state (this is a long-lived process, no state file needed)
let appDown = false;
let lastFlapAlert = 0;

interface LogEntry {
  level: string;
  message: string;
  details?: Record<string, unknown>;
}

async function notify(content: string): Promise<void> {
  if (!WEBHOOK) return;
  try {
    await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  } catch (err) {
    console.error('[health-monitor] Discord notify failed:', err instanceof Error ? err.message : err);
  }
}

function nowPacific(): string {
  return new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' });
}

async function isReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/config`, { signal: AbortSignal.timeout(8_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function checkLiveness(): Promise<boolean> {
  // Confirm "down" across a few retries so a transient blip or a slow boot
  // doesn't trigger a false alert.
  let reachable = await isReachable();
  for (let i = 0; !reachable && i < DOWN_RETRIES; i++) {
    await new Promise((r) => setTimeout(r, 3_000));
    reachable = await isReachable();
  }

  if (reachable) {
    if (appDown) {
      appDown = false;
      await notify(`✅ **WebTracker is back UP** — responding again on :${PORT} (at ${nowPacific()} PT).`);
      console.log('[health-monitor] App recovered — alert sent.');
    }
    return true;
  }

  if (!appDown) {
    appDown = true;
    await notify(`🛑 **WebTracker is DOWN** — not responding on :${PORT} (at ${nowPacific()} PT). Monitoring is paused until it restarts.`);
    console.log('[health-monitor] App down — alert sent.');
  } else {
    console.log('[health-monitor] App still down — already alerted.');
  }
  return false;
}

async function checkFlapping(): Promise<void> {
  if (Date.now() - lastFlapAlert < FLAP_COOLDOWN_MS) {
    console.log('[health-monitor] Flap check in cooldown.');
    return;
  }
  try {
    const res = await fetch(`${BASE}/logs`, { signal: AbortSignal.timeout(8_000) });
    const logs = (await res.json() as { data: LogEntry[] }).data;
    const fetches = logs.filter(
      (l) => l.message === 'Fetch complete' && l.details && 'availableProducts' in l.details
    );
    if (fetches.length < 3) {
      console.log(`[health-monitor] Not enough fetch entries to check flapping (${fetches.length}).`);
      return;
    }
    const counts = fetches.slice(0, 6)
      .map((l) => l.details!['availableProducts'] as number)
      .filter((n) => n > 0); // exclude empty-scrape results (0 = failed fetch, not real data)
    if (counts.length < 3) {
      console.log('[health-monitor] Not enough non-zero fetch entries to check flapping.');
      return;
    }
    // True flapping = count changes direction at least once (goes up then down, or down then up).
    // A monotonic drop/rise (e.g. 15→14→14→14) is a legitimate product change, not flapping.
    let directionChanges = 0;
    for (let i = 1; i < counts.length; i++) {
      const prev = counts[i - 1]!;
      const curr = counts[i]!;
      if (curr > prev) directionChanges++;
      else if (curr < prev) directionChanges++;
    }
    const isFlapping = directionChanges >= 2;

    if (isFlapping) {
      lastFlapAlert = Date.now();
      await notify(`🔄 **WebTracker Flapping Detected** — availableProducts bouncing across recent scrapes: [${counts.join(', ')}]. Possible lazy-load timing issue.`);
      console.log(`[health-monitor] Flapping alert sent — counts: ${counts.join(', ')}`);
    } else {
      console.log(`[health-monitor] No flapping — counts stable or trending: ${counts.join(', ')}`);
    }
  } catch (err) {
    console.error('[health-monitor] Flap check failed:', err instanceof Error ? err.message : err);
  }
}

async function tick(): Promise<void> {
  const alive = await checkLiveness();
  if (alive) await checkFlapping();
}

async function main(): Promise<void> {
  if (!WEBHOOK) {
    console.warn('[health-monitor] No DISCORD_WEBHOOK_URL configured — alerts disabled. Exiting.');
    return;
  }
  console.log(`[health-monitor] Watching ${BASE} every ${CHECK_INTERVAL_MS / 1000}s (after ${STARTUP_GRACE_MS / 1000}s grace).`);
  // Grace period so a co-started agent has time to boot before the first check.
  await new Promise((r) => setTimeout(r, STARTUP_GRACE_MS));
  await tick();
  setInterval(() => void tick(), CHECK_INTERVAL_MS);
}

void main();
