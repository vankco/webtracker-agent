/**
 * monitor-controller.ts
 * Manages the monitor loop lifecycle: start, stop, one-shot run, status.
 * Designed to be injectable so the API server and CLI share the same instance.
 */

import { scrapePageText, closeScraperSession } from './scraper.js';
import type { SitePlugin } from './plugin-types.js';
import { PluginRegistry } from './plugin-registry.js';
import { sendDiscordAlert } from './notifier.js';
import { loadState, saveState, appendHistory, type HistoryEntry } from './state.js';
import { analyzeWithProviders, type AnalysisResultWithMeta } from './llm.js';
import {
  getEnabledProvidersByPriority,
  type AppConfig,
  type ConfigStore,
} from './config.js';
import { log } from './logger.js';
import type {
  MonitorStatus,
  LastCheckResult,
  MonitorError,
  ContentSnapshot,
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
  private recentSnapshots: ContentSnapshot[] = [];
  private readonly deps: MonitorDependencies;
  private readonly registry: PluginRegistry;

  constructor(deps: Partial<MonitorDependencies> = {}, registry: PluginRegistry = new PluginRegistry()) {
    this.deps = { ...DEFAULT_DEPS, ...deps };
    this.registry = registry;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  isRunning(): boolean {
    return this.running;
  }

  /** Resolve the site plugin matching a URL, if any. */
  findPlugin(url: string): SitePlugin | null {
    return this.registry.findForUrl(url);
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
      recentSnapshots: [...this.recentSnapshots],
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
    log('info', 'monitor', 'Monitor started', { url: config.target.url, intervalMs: config.schedule.intervalMs });

    // Run immediately
    try {
      await this.runCheck(config);
    } catch (err) {
      this.recordError(err);
      log('error', 'monitor', 'Initial check failed', { error: err instanceof Error ? err.message : String(err) });
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
    log('info', 'monitor', 'Monitor stopped');
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
    const plugin: SitePlugin | null = this.registry.findForUrl(target.url);

    log('info', 'scrape', `Fetching ${target.url}`, { selector: target.selector || '(none)', plugin: plugin?.name ?? 'none' });
    const scrapeStart = Date.now();

    const currentContent = await this.deps.scrapePageText(target.url, target.selector, browser, plugin ?? undefined);

    // For plugin URLs: parse structured products and derive available subset
    const currentProducts: unknown[] | null = plugin
      ? currentContent.split('\n').filter(Boolean).map(line => plugin.parseProductLine(line))
      : null;
    const currentAvailable: unknown[] = plugin
      ? plugin.filterAvailable(currentProducts!)
      : [];

    log('info', 'scrape', `Fetch complete`, {
      url: target.url,
      contentLength: currentContent.length,
      latencyMs: Date.now() - scrapeStart,
      ...(plugin ? { totalProducts: currentProducts!.length, availableProducts: currentAvailable.length } : {}),
    });

    // Record snapshot (newest first, keep last 2)
    this.recentSnapshots = [
      { fetchedAt: new Date().toISOString(), preview: currentContent.slice(0, 500), contentLength: currentContent.length },
      ...this.recentSnapshots,
    ].slice(0, 2);

    if (!currentContent.trim()) {
      const msg = target.selector
        ? `Scrape returned empty content — selector "${target.selector}" may not match anything on ${target.url}`
        : `Scrape returned empty content — ${target.url} may have blocked the request or failed to load`;
      log('warn', 'scrape', msg, { url: target.url, selector: target.selector });
      this.recordError(new Error(msg));
      if (config.notifications.discordWebhookUrl) {
        await this.deps.sendDiscordAlert(config.notifications.discordWebhookUrl, target.url, `⚠️ ${msg}`);
      }
      this.lastCheck = new Date().toISOString();
      return;
    }

    const previousState = this.deps.loadState();

    if (!previousState) {
      if (plugin && config.notifications.discordWebhookUrl) {
        const alertBody = plugin.formatBaselineMessage(currentAvailable);
        const chunks = chunkSummaryForAlerts(alertBody);
        for (const chunk of chunks) {
          await this.deps.sendDiscordAlert(config.notifications.discordWebhookUrl, target.url, chunk);
        }
        log('info', 'monitor', 'Baseline alert sent', { available: currentAvailable.length });
      } else {
        log('info', 'monitor', 'No previous state — saving baseline. Alerts start next run.');
      }
      this.deps.saveState({
        url: target.url,
        lastContent: currentContent,
        lastChecked: new Date().toISOString(),
        ...(plugin ? { lastProducts: currentProducts! } : {}),
        ...(plugin
          ? {
              history: appendHistory(undefined, {
                timestamp: new Date().toISOString(),
                products: currentAvailable,
                availableCount: currentAvailable.length,
                changeSummary: 'baseline',
              }),
            }
          : {}),
      });
      this.lastCheck = new Date().toISOString();
      return;
    }

    // Resolve previous available products from stored array or parse from text (legacy fallback)
    const previousAvailable: unknown[] = plugin
      ? previousState.lastProducts
        ? plugin.filterAvailable(previousState.lastProducts)
        : previousState.lastContent.split('\n').filter(Boolean).map(line => plugin.parseProductLine(line)).filter((p: unknown) => plugin.filterAvailable([p]).length > 0)
      : [];

    // Serialize available products to text for comparison
    const currentTrackable  = plugin ? plugin.productsToText(currentAvailable)  : currentContent;
    const previousTrackable = plugin ? plugin.productsToText(previousAvailable) : previousState.lastContent;

    if (currentTrackable === previousTrackable) {
      // No change — carry history forward unchanged (don't append a new event)
      this.deps.saveState({
        url: target.url,
        lastContent: currentContent,
        lastChecked: new Date().toISOString(),
        ...(plugin ? { lastProducts: currentProducts! } : {}),
        ...(previousState.history ? { history: previousState.history } : {}),
      });
      this.lastCheck = new Date().toISOString();
      this.lastResult = {
        changed: false,
        summary: plugin
          ? `No change in available products (${currentAvailable.length} available).`
          : 'No meaningful change: exact text match.',
        provider: 'none',
        fallback: false,
      };
      return;
    }

    // -----------------------------------------------------------------------
    // Plugin: deterministic diff (+ optional LLM fallback)
    // -----------------------------------------------------------------------
    if (plugin) {
      const pluginDiff = plugin.diff(previousAvailable, currentAvailable);

      log('info', 'monitor', 'Change detected (plugin)', { plugin: plugin.name, summary: pluginDiff.summary });

      let finalSummary = pluginDiff.summary;

      if (pluginDiff.requestLlmFallback && providers.length > 0) {
        const llmResult = await this.deps.analyzeWithProviders(target.url, previousTrackable, currentTrackable, providers);
        if (llmResult.summary) finalSummary += `\n\n${llmResult.summary}`;
      }

      this.lastCheck = new Date().toISOString();
      this.lastResult = {
        changed: pluginDiff.hasChanges,
        summary: finalSummary,
        provider: 'deterministic',
        fallback: false,
      };

      if (pluginDiff.hasChanges && config.notifications.discordWebhookUrl) {
        const chunks = chunkSummaryForAlerts(pluginDiff.alertBody);
        for (const chunk of chunks) {
          await this.deps.sendDiscordAlert(config.notifications.discordWebhookUrl, target.url, chunk);
        }
        log('info', 'monitor', `${chunks.length} alert(s) sent`, { summary: finalSummary });
      }

      const historyEntry: HistoryEntry = {
        timestamp: new Date().toISOString(),
        products: currentAvailable,
        availableCount: currentAvailable.length,
        changeSummary: pluginDiff.summary,
      };
      this.deps.saveState({
        url: target.url,
        lastContent: currentContent,
        lastChecked: new Date().toISOString(),
        lastProducts: currentProducts!,
        history: appendHistory(previousState.history, historyEntry),
      });
      return;
    }

    // -----------------------------------------------------------------------
    // General: LLM-based change detection
    // -----------------------------------------------------------------------
    log('info', 'llm', 'Sending to LLM providers', {
      providers: providers.map(p => `${p.id}:${p.model}`),
      oldLength: previousTrackable.length,
      newLength: currentTrackable.length,
    });
    const llmStart = Date.now();

    const analysisResult: AnalysisResultWithMeta = await this.deps.analyzeWithProviders(
      target.url,
      previousTrackable,
      currentTrackable,
      providers
    );

    log(analysisResult.fallback ? 'warn' : 'info', 'llm', `Analysis complete`, {
      provider: analysisResult.provider ?? 'local-fallback',
      model: analysisResult.model,
      changed: analysisResult.changed,
      fallback: analysisResult.fallback,
      latencyMs: Date.now() - llmStart,
      summary: analysisResult.summary.slice(0, 200),
    });

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

    this.deps.saveState({
      url: target.url,
      lastContent: currentContent,
      lastChecked: new Date().toISOString(),
    });
  }

  private recordError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.recentErrors.push({ timestamp: new Date().toISOString(), message });
    if (this.recentErrors.length > MAX_ERRORS) {
      this.recentErrors.shift();
    }
    log('error', 'monitor', message);
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
    // Prefer splitting at a newline to avoid breaking mid-word or mid-link
    let splitAt = remaining.lastIndexOf('\n', maxChunkLen);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', maxChunkLen);
    if (splitAt <= 0) splitAt = maxChunkLen;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining.length > 0 && chunks.length > 0) {
    chunks[chunks.length - 1] += ' …[truncated]';
  }

  return chunks.length === 1
    ? chunks
    : chunks.map((c, i) => `Part ${i + 1}/${chunks.length}:\n${c}`);
}
