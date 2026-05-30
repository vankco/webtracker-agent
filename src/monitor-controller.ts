/**
 * monitor-controller.ts
 * Manages the monitor loop lifecycle: start, stop, one-shot run, status.
 * Designed to be injectable so the API server and CLI share the same instance.
 */

import { scrapePageText, closeScraperSession } from './scraper.js';
import { sendDiscordAlert } from './notifier.js';
import { loadState, saveState } from './state.js';
import { analyzeWithProviders, type AnalysisResultWithMeta } from './llm.js';
import {
  getEnabledProvidersByPriority,
  type AppConfig,
  type ConfigStore,
} from './config.js';
import type {
  MonitorStatus,
  LastCheckResult,
  MonitorError,
} from './api-types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MonitorDependencies {
  scrapePageText: typeof scrapePageText;
  analyzeWithProviders: typeof analyzeWithProviders;
  sendDiscordAlert: typeof sendDiscordAlert;
  loadState: typeof loadState;
  saveState: typeof saveState;
  closeScraperSession: typeof closeScraperSession;
}

const DEFAULT_DEPS: MonitorDependencies = {
  scrapePageText,
  analyzeWithProviders,
  sendDiscordAlert,
  loadState,
  saveState,
  closeScraperSession,
};

// Maximum number of recent errors kept in memory
const MAX_ERRORS = 20;

// ---------------------------------------------------------------------------
// MonitorController
// ---------------------------------------------------------------------------

export class MonitorController {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastCheck: string | undefined;
  private lastResult: LastCheckResult | undefined;
  private nextCheck: string | undefined;
  private recentErrors: MonitorError[] = [];
  private readonly deps: MonitorDependencies;

  constructor(deps: Partial<MonitorDependencies> = {}) {
    this.deps = { ...DEFAULT_DEPS, ...deps };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  isRunning(): boolean {
    return this.running;
  }

  getStatus(configStore: ConfigStore): MonitorStatus {
    const config = configStore.get();
    return {
      running: this.running,
      lastCheck: this.lastCheck,
      lastResult: this.lastResult,
      nextCheck: this.nextCheck,
      targetUrl: config.target.url || undefined,
      errors: [...this.recentErrors],
    };
  }

  /** Start the monitor loop. Throws if already running or config is invalid. */
  async start(configStore: ConfigStore): Promise<void> {
    if (this.running) {
      throw new Error('Monitor is already running.');
    }

    const validationErrors = configStore.validate();
    if (validationErrors.length > 0) {
      throw new Error(`Cannot start monitor — configuration is incomplete: ${validationErrors.join('; ')}`);
    }

    this.running = true;
    const config = configStore.get();

    // Run immediately
    try {
      await this.runCheck(config);
    } catch (err) {
      this.recordError(err);
      console.error('[monitor] Initial check failed:', err);
    }

    if (config.schedule.runOnce) {
      this.running = false;
      return;
    }

    const intervalMs = config.schedule.intervalMs;
    this.scheduleNext(intervalMs);

    this.intervalHandle = setInterval(async () => {
      // Re-read config from store so runtime updates take effect between checks
      const currentConfig = configStore.get();
      try {
        await this.runCheck(currentConfig);
      } catch (err) {
        this.recordError(err);
        console.error('[monitor] Check failed:', err);
      }
      this.scheduleNext(currentConfig.schedule.intervalMs);
    }, intervalMs);
  }

  /** Stop the monitor loop and close the browser session. */
  async stop(): Promise<void> {
    if (this.intervalHandle != null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.running = false;
    this.nextCheck = undefined;
    await this.deps.closeScraperSession();
  }

  /**
   * Run a single check cycle without starting the loop.
   * Used by POST /api/monitor/start with runOnce=true and POST /api/validate/scrape.
   */
  async runOnce(config: AppConfig): Promise<LastCheckResult | undefined> {
    await this.runCheck(config);
    return this.lastResult;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private scheduleNext(intervalMs: number): void {
    this.nextCheck = new Date(Date.now() + intervalMs).toISOString();
  }

  private async runCheck(config: AppConfig): Promise<void> {
    const { target, browser } = config;
    const providers = getEnabledProvidersByPriority(config);

    console.log(`[monitor] Checking: ${target.url}`);

    const currentContent = await this.deps.scrapePageText(target.url, target.selector, browser);

    if (!currentContent.trim()) {
      const msg = target.selector
        ? `Scrape returned empty content — selector "${target.selector}" may not match anything on ${target.url}`
        : `Scrape returned empty content — ${target.url} may have blocked the request or failed to load`;
      console.warn(`[monitor] ⚠ ${msg}`);
      this.recordError(new Error(msg));
      if (config.notifications.discordWebhookUrl) {
        await this.deps.sendDiscordAlert(config.notifications.discordWebhookUrl, target.url, `⚠️ ${msg}`);
      }
      this.lastCheck = new Date().toISOString();
      return;
    }

    const previousState = this.deps.loadState();

    if (!previousState) {
      console.log('[monitor] No previous state — saving baseline. Alerts start next run.');
      this.deps.saveState({
        url: target.url,
        lastContent: currentContent,
        lastChecked: new Date().toISOString(),
      });
      this.lastCheck = new Date().toISOString();
      return;
    }

    if (currentContent === previousState.lastContent) {
      console.log('[monitor] No change (exact text match — skipped LLM analysis).');
      this.deps.saveState({ url: target.url, lastContent: currentContent, lastChecked: new Date().toISOString() });
      this.lastCheck = new Date().toISOString();
      this.lastResult = {
        changed: false,
        summary: 'No meaningful change: exact text match.',
        provider: 'none',
        fallback: false,
      };
      return;
    }

    const analysisResult: AnalysisResultWithMeta = await this.deps.analyzeWithProviders(
      target.url,
      previousState.lastContent,
      currentContent,
      providers
    );

    this.lastCheck = new Date().toISOString();
    this.lastResult = {
      changed: analysisResult.changed,
      summary: analysisResult.summary,
      provider: analysisResult.provider ?? 'local',
      model: analysisResult.model,
      latencyMs: analysisResult.latencyMs,
      fallback: analysisResult.fallback ?? false,
    };

    if (analysisResult.changed) {
      const chunks = chunkSummaryForAlerts(analysisResult.summary);
      for (const chunk of chunks) {
        await this.deps.sendDiscordAlert(config.notifications.discordWebhookUrl, target.url, chunk);
      }
      console.log(`[monitor] Change detected — ${chunks.length} alert(s) sent ✓`);
    } else {
      console.log(`[monitor] No meaningful change: ${analysisResult.summary}`);
    }

    this.deps.saveState({ url: target.url, lastContent: currentContent, lastChecked: new Date().toISOString() });
  }

  private recordError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.recentErrors.push({ timestamp: new Date().toISOString(), message });
    if (this.recentErrors.length > MAX_ERRORS) {
      this.recentErrors.shift();
    }
  }
}

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

function chunkSummaryForAlerts(summary: string, maxChunkLen = 900, maxAlerts = 10): string[] {
  const normalized = summary.trim();
  if (normalized.length <= maxChunkLen) return [normalized];

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > 0 && chunks.length < maxAlerts) {
    if (remaining.length <= maxChunkLen) {
      chunks.push(remaining.trim());
      break;
    }
    let splitAt = remaining.lastIndexOf(' ', maxChunkLen);
    if (splitAt <= 0) splitAt = maxChunkLen;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining.length > 0 && chunks.length > 0) {
    chunks[chunks.length - 1] += ' …[truncated]';
  }

  return chunks.length === 1
    ? chunks
    : chunks.map((c, i) => `Part ${i + 1}/${chunks.length}: ${c}`);
}
