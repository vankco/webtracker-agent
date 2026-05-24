import 'dotenv/config';
import { closeScraperSession, scrapePageText } from './scraper.js';
import { analyzeChanges } from './analyzer.js';
import { sendDiscordAlert } from './notifier.js';
import { loadState, saveState } from './state.js';

let shuttingDown = false;

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Shutting down monitor (${reason})...`);
  await closeScraperSession();
}

process.on('SIGINT', () => {
  void shutdown('SIGINT').finally(() => process.exit(0));
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM').finally(() => process.exit(0));
});

function getEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env variable: ${key}`);
  return val;
}

function logNextCheckTime(intervalMs: number): void {
  const nextCheck = new Date(Date.now() + intervalMs);
  console.log(`Monitoring active — next check at ${nextCheck.toLocaleString()}`);
}

function chunkSummaryForAlerts(summary: string, maxChunkLen = 900, maxAlerts = 10): string[] {
  const normalized = summary.trim();
  if (normalized.length <= maxChunkLen) {
    return [normalized];
  }

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > 0 && chunks.length < maxAlerts) {
    if (remaining.length <= maxChunkLen) {
      chunks.push(remaining.trim());
      break;
    }

    let splitAt = remaining.lastIndexOf(' ', maxChunkLen);
    if (splitAt <= 0) {
      splitAt = maxChunkLen;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining.length > 0 && chunks.length > 0) {
    chunks[chunks.length - 1] = `${chunks[chunks.length - 1]} ...[truncated]`;
  }

  if (chunks.length === 1) {
    return chunks;
  }

  return chunks.map((chunk, index) => `Part ${index + 1}/${chunks.length}: ${chunk}`);
}

async function runCheck(): Promise<void> {
  const targetUrl = getEnv('TARGET_URL');
  const geminiKey = getEnv('GEMINI_API_KEY');
  const discordUrl = getEnv('DISCORD_WEBHOOK_URL');
  const selector = process.env['TARGET_SELECTOR'] ?? '';

  console.log(`[${new Date().toISOString()}] Checking: ${targetUrl}`);

  const currentContent = await scrapePageText(targetUrl, selector);
  const previousState = loadState();

  if (!previousState) {
    console.log('No previous state found — saving baseline. Will start alerting on next run.');
    saveState({ url: targetUrl, lastContent: currentContent, lastChecked: new Date().toISOString() });
    return;
  }

  const { changed, summary } = await analyzeChanges(
    targetUrl,
    previousState.lastContent,
    currentContent,
    geminiKey
  );

  if (changed) {
    console.log(`Change detected: ${summary}`);
    const alertSummaries = chunkSummaryForAlerts(summary);
    for (const alertSummary of alertSummaries) {
      await sendDiscordAlert(discordUrl, targetUrl, alertSummary);
    }
    console.log(`Discord alert sent ✓ (${alertSummaries.length} message${alertSummaries.length === 1 ? '' : 's'})`);
  } else {
    console.log(`No meaningful change: ${summary}`);
  }

  saveState({ url: targetUrl, lastContent: currentContent, lastChecked: new Date().toISOString() });
}

async function main(): Promise<void> {
  const intervalMs = parseInt(process.env['CHECK_INTERVAL_MS'] ?? '300000', 10);
  const runOnce = (process.env['RUN_ONCE'] ?? '').trim().toLowerCase() === 'true';

  // Run immediately on startup
  try {
    await runCheck();
  } catch (err) {
    console.error('Initial check failed:', err);
  }

  if (runOnce) {
    console.log('Run-once mode complete. Exiting.');
    return;
  }

  // Then repeat on the configured interval
  setInterval(async () => {
    try {
      await runCheck();
    } catch (err) {
      console.error('Check failed:', err);
    } finally {
      logNextCheckTime(intervalMs);
    }
  }, intervalMs);

  logNextCheckTime(intervalMs);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  void shutdown('fatal error');
  process.exitCode = 1;
});
