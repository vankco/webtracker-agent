/**
 * monitor-controller.ts
 * Multi-site monitor loop: every enabled site is scraped independently on its
 * own cadence, with its own state, status, and Discord alerts. A single
 * recursive setTimeout drives a scheduler tick that runs whichever sites are due.
 * Designed to be injectable so the API server and CLI share the same instance.
 */

import { scrapePageText, closeScraperSession } from './scraper.js';

const PRODUCT_ALERT_AVATAR = 'https://raw.githubusercontent.com/vankco/webtracker-agent/main/assets/birkin-bag-avatar.png';
const PRODUCT_ALERT_USERNAME = 'Hermès Monitor';
import type { SitePlugin } from './plugin-types.js';
import { PluginRegistry } from './plugin-registry.js';
import { sendDiscordAlert } from './notifier.js';
import { loadSiteState, saveSiteState, appendHistory, type HistoryEntry } from './state.js';
import { analyzeWithProviders, type AnalysisResultWithMeta } from './llm.js';
import {
  getEnabledProvidersByPriority,
  type AppConfig,
  type ConfigStore,
  type SiteConfig,
  type SiteSchedule,
  type ScheduleConfig,
} from './config.js';
import { log } from './logger.js';
import { getErrorMessage } from './utils.js';
import type {
  LastCheckResult,
  MonitorError,
  ContentSnapshot,
  MultiSiteMonitorStatus,
  SiteStatusView,
} from './api-types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MonitorDependencies {
  scrapePageText: typeof scrapePageText;
  analyzeWithProviders: typeof analyzeWithProviders;
  sendDiscordAlert: typeof sendDiscordAlert;
  loadSiteState: typeof loadSiteState;
  saveSiteState: typeof saveSiteState;
  closeScraperSession: typeof closeScraperSession;
}

const DEFAULT_DEPS: MonitorDependencies = {
  scrapePageText,
  analyzeWithProviders,
  sendDiscordAlert,
  loadSiteState,
  saveSiteState,
  closeScraperSession,
};

// Maximum number of recent errors kept in memory, per site
const MAX_ERRORS = 20;
// Scheduler tick bounds — how soon/late we re-evaluate which sites are due
const MIN_TICK_MS = 500;
const MAX_TICK_MS = 60_000;

/** Per-site runtime status held in memory. */
interface SiteRuntime {
  lastCheck?: string;
  lastResult?: LastCheckResult;
  nextCheck?: string;
  /** Epoch ms when this site is next due. 0 = due immediately. */
  nextCheckAt: number;
  /** Apply 2× interval after an empty scrape (possible bot block). */
  emptyBackoff: boolean;
  errors: MonitorError[];
  recentSnapshots: ContentSnapshot[];
}

// ---------------------------------------------------------------------------
// Interval resolution (site schedule > plugin default > site interval > global)
// ---------------------------------------------------------------------------

/** Returns the matching interval from a schedule, or null if it doesn't decide. */
function pickFromSchedule(sched: SiteSchedule | undefined, nowMs: number): number | null {
  if (!sched) return null;
  if (sched.windows && sched.windows.length > 0) {
    const tz = sched.timezone ?? 'America/Los_Angeles';
    const hour = Number(
      new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' })
        .format(new Date(nowMs)),
    );
    for (const w of sched.windows) {
      const inWindow = w.startHour <= w.endHour
        ? hour >= w.startHour && hour < w.endHour          // normal band
        : hour >= w.startHour || hour < w.endHour;         // wraps past midnight
      if (inWindow) return w.intervalMs;
    }
  }
  return sched.intervalMs ?? null;
}

/**
 * Resolves a site's current scrape interval (ms), most-specific first:
 *   site.schedule (windows → default) > plugin.suggestedSchedule > site.intervalMs > global.
 */
export function resolveIntervalMs(
  site: SiteConfig,
  plugin: SitePlugin | null,
  globalSchedule: ScheduleConfig,
  nowMs: number,
): number {
  const fromSite = pickFromSchedule(site.schedule, nowMs);
  if (fromSite != null) return fromSite;
  const fromPlugin = pickFromSchedule(plugin?.suggestedSchedule, nowMs);
  if (fromPlugin != null) return fromPlugin;
  if (site.intervalMs != null) return site.intervalMs;
  return globalSchedule.intervalMs;
}

// ---------------------------------------------------------------------------
// MonitorController
// ---------------------------------------------------------------------------

export class MonitorController {
  private tickHandle: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private shuttingDown = false;
  private readonly siteStatus = new Map<string, SiteRuntime>();
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

  getStatus(configStore: ConfigStore): MultiSiteMonitorStatus {
    const config = configStore.get();
    const sites: Record<string, SiteStatusView> = {};
    for (const s of config.sites) {
      const st = this.siteStatus.get(s.id);
      sites[s.id] = {
        id: s.id,
        url: s.url,
        ...(s.label !== undefined ? { label: s.label } : {}),
        enabled: s.enabled,
        ...(st?.lastCheck !== undefined ? { lastCheck: st.lastCheck } : {}),
        ...(st?.lastResult !== undefined ? { lastResult: st.lastResult } : {}),
        ...(st?.nextCheck !== undefined ? { nextCheck: st.nextCheck } : {}),
        errors: st ? [...st.errors] : [],
        recentSnapshots: st ? [...st.recentSnapshots] : [],
      };
    }
    const upcoming = config.sites
      .filter((s) => s.enabled)
      .map((s) => this.siteStatus.get(s.id)?.nextCheckAt)
      .filter((n): n is number => typeof n === 'number' && n > Date.now());
    const nextCheck = this.running && upcoming.length > 0
      ? new Date(Math.min(...upcoming)).toISOString()
      : undefined;
    return { running: this.running, ...(nextCheck ? { nextCheck } : {}), sites };
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
    this.shuttingDown = false;
    const config = configStore.get();
    const enabledCount = config.sites.filter((s) => s.enabled).length;
    log('info', 'monitor', 'Monitor started', { sites: enabledCount, intervalMs: config.schedule.intervalMs });

    // Run every enabled site once immediately (each runtime defaults to due).
    await this.runDueSites(configStore);

    if (config.schedule.runOnce) {
      this.running = false;
      return;
    }
    this.scheduleTick(configStore);
  }

  /** Stop the monitor loop and close the browser session. */
  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.tickHandle != null) {
      clearTimeout(this.tickHandle);
      this.tickHandle = null;
    }
    this.running = false;
    for (const st of this.siteStatus.values()) st.nextCheck = undefined;
    log('info', 'monitor', 'Monitor stopped');
    await this.deps.closeScraperSession();
  }

  /**
   * Run a single check cycle for every enabled site without starting the loop.
   * Returns the first site's result (used by runOnce-mode start).
   */
  async runOnce(config: AppConfig): Promise<LastCheckResult | undefined> {
    for (const site of config.sites.filter((s) => s.enabled)) {
      try {
        await this.runCheckForSite(site, config);
      } catch (err) {
        this.recordError(site.id, err);
      }
    }
    const first = config.sites.find((s) => s.enabled);
    return first ? this.siteStatus.get(first.id)?.lastResult : undefined;
  }

  // -------------------------------------------------------------------------
  // Internal — scheduling
  // -------------------------------------------------------------------------

  private ensureRuntime(siteId: string): SiteRuntime {
    let st = this.siteStatus.get(siteId);
    if (!st) {
      st = { nextCheckAt: 0, emptyBackoff: false, errors: [], recentSnapshots: [] };
      this.siteStatus.set(siteId, st);
    }
    return st;
  }

  private scheduleTick(configStore: ConfigStore): void {
    if (!this.running) return;
    const config = configStore.get();
    const now = Date.now();
    const dueTimes = config.sites
      .filter((s) => s.enabled)
      .map((s) => this.ensureRuntime(s.id).nextCheckAt);
    const soonest = dueTimes.length > 0 ? Math.min(...dueTimes) : now + MAX_TICK_MS;
    const delay = Math.min(MAX_TICK_MS, Math.max(MIN_TICK_MS, soonest - now));
    this.tickHandle = setTimeout(() => {
      void (async () => {
        if (!this.running) return;
        await this.runDueSites(configStore);
        if (this.running) this.scheduleTick(configStore);
      })();
    }, delay);
  }

  private async runDueSites(configStore: ConfigStore): Promise<void> {
    const config = configStore.get();
    // Drop runtime for sites that no longer exist.
    const liveIds = new Set(config.sites.map((s) => s.id));
    for (const id of [...this.siteStatus.keys()]) {
      if (!liveIds.has(id)) this.siteStatus.delete(id);
    }
    // Run each due, enabled site sequentially (one browser context at a time).
    for (const site of config.sites.filter((s) => s.enabled)) {
      if (!this.running) return;
      const st = this.ensureRuntime(site.id);
      if (st.nextCheckAt > Date.now()) continue;
      try {
        await this.runCheckForSite(site, config);
      } catch (err) {
        this.recordError(site.id, err);
        if (!this.shuttingDown) {
          console.error(`[monitor] Check failed for ${site.url}:`, err);
        }
      }
      this.scheduleNextForSite(site, config);
    }
  }

  private scheduleNextForSite(site: SiteConfig, config: AppConfig): void {
    const st = this.ensureRuntime(site.id);
    const plugin = this.registry.findForUrl(site.url);
    const base = resolveIntervalMs(site, plugin, config.schedule, Date.now());
    const multiplier = st.emptyBackoff ? 2 : 1;
    st.emptyBackoff = false;
    const jitter = base * 0.2;
    const interval = Math.max(1_000, Math.round(base * multiplier + (Math.random() * 2 - 1) * jitter));
    if (multiplier > 1) {
      log('warn', 'monitor', `Empty scrape backoff — next check in ${Math.round(interval / 1000)}s`, { url: site.url });
    }
    st.nextCheckAt = Date.now() + interval;
    st.nextCheck = new Date(st.nextCheckAt).toISOString();
  }

  // -------------------------------------------------------------------------
  // Internal — per-site check
  // -------------------------------------------------------------------------

  private async runCheckForSite(site: SiteConfig, config: AppConfig): Promise<void> {
    const { browser } = config;
    const st = this.ensureRuntime(site.id);
    const providers = getEnabledProvidersByPriority(config);
    const plugin: SitePlugin | null = this.registry.findForUrl(site.url);

    const intervalMs = resolveIntervalMs(site, plugin, config.schedule, Date.now());
    log('info', 'scrape', `Fetching`, { url: site.url, selector: site.selector || '(none)', plugin: plugin?.name ?? 'none', intervalMs });
    const scrapeStart = Date.now();

    const currentContent = await this.deps.scrapePageText(site.url, site.selector, browser, plugin ?? undefined, config.productWatchUrls);

    const currentProducts: unknown[] | null = plugin
      ? currentContent.split('\n').filter(Boolean).map((line) => plugin.parseProductLine(line))
      : null;
    const currentAvailable: unknown[] = plugin ? plugin.filterAvailable(currentProducts!) : [];

    log('info', 'scrape', `Fetch complete`, {
      url: site.url,
      contentLength: currentContent.length,
      latencyMs: Date.now() - scrapeStart,
      ...(plugin ? { totalProducts: currentProducts!.length, availableProducts: currentAvailable.length } : {}),
    });

    st.recentSnapshots = [
      { fetchedAt: new Date().toISOString(), preview: currentContent.slice(0, 500), contentLength: currentContent.length },
    ];

    if (!currentContent.trim()) {
      const msg = site.selector
        ? `Scrape returned empty content — selector "${site.selector}" may not match anything on ${site.url}`
        : `Scrape returned empty content — ${site.url} may have blocked the request or failed to load`;
      log('warn', 'scrape', msg, { url: site.url, selector: site.selector });
      this.recordError(site.id, new Error(msg));
      st.emptyBackoff = true;
      st.lastCheck = new Date().toISOString();
      return;
    }

    const previousState = await this.deps.loadSiteState(site.id, site.url);

    if (!previousState) {
      if (plugin && config.notifications.discordWebhookUrl) {
        const alertBody = plugin.formatBaselineMessage(currentAvailable);
        const chunks = chunkSummaryForAlerts(alertBody);
        for (const chunk of chunks) {
          await this.deps.sendDiscordAlert(config.notifications.discordWebhookUrl, site.url, chunk, undefined, undefined, PRODUCT_ALERT_USERNAME, PRODUCT_ALERT_AVATAR);
        }
        log('info', 'monitor', 'Baseline alert sent', { url: site.url, available: currentAvailable.length });
      } else {
        log('info', 'monitor', 'No previous state — saving baseline. Alerts start next run.', { url: site.url });
      }
      await this.deps.saveSiteState(site.id, {
        url: site.url,
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
      st.lastCheck = new Date().toISOString();
      return;
    }

    const previousAvailable: unknown[] = plugin
      ? previousState.lastProducts
        ? plugin.filterAvailable(previousState.lastProducts)
        : previousState.lastContent.split('\n').filter(Boolean).map((line) => plugin.parseProductLine(line)).filter((p: unknown) => plugin.filterAvailable([p]).length > 0)
      : [];

    const currentTrackable = plugin ? plugin.productsToText(currentAvailable) : currentContent;
    const previousTrackable = plugin ? plugin.productsToText(previousAvailable) : previousState.lastContent;

    if (currentTrackable === previousTrackable) {
      await this.deps.saveSiteState(site.id, {
        url: site.url,
        lastContent: currentContent,
        lastChecked: new Date().toISOString(),
        ...(plugin ? { lastProducts: currentProducts! } : {}),
        ...(previousState.history ? { history: previousState.history } : {}),
      });
      st.lastCheck = new Date().toISOString();
      st.lastResult = {
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
      log('info', 'monitor', 'Change detected (plugin)', { url: site.url, plugin: plugin.name, summary: pluginDiff.summary });

      let finalSummary = pluginDiff.summary;
      if (pluginDiff.requestLlmFallback && providers.length > 0) {
        const llmResult = await this.deps.analyzeWithProviders(site.url, previousTrackable, currentTrackable, providers);
        if (llmResult.summary) finalSummary += `\n\n${llmResult.summary}`;
      }

      st.lastCheck = new Date().toISOString();
      st.lastResult = { changed: pluginDiff.hasChanges, summary: finalSummary, provider: 'deterministic', fallback: false };

      if (pluginDiff.hasChanges && config.notifications.discordWebhookUrl) {
        const chunks = chunkSummaryForAlerts(pluginDiff.alertBody);
        const linkLabel = `📊 ${currentAvailable.length} available total`;
        for (const chunk of chunks) {
          await this.deps.sendDiscordAlert(config.notifications.discordWebhookUrl, site.url, chunk, undefined, linkLabel, PRODUCT_ALERT_USERNAME, PRODUCT_ALERT_AVATAR);
        }
        log('info', 'monitor', `${chunks.length} alert(s) sent`, { url: site.url, summary: finalSummary });
      }

      const historyEntry: HistoryEntry = {
        timestamp: new Date().toISOString(),
        products: currentAvailable,
        availableCount: currentAvailable.length,
        changeSummary: pluginDiff.summary,
      };
      await this.deps.saveSiteState(site.id, {
        url: site.url,
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
      url: site.url,
      providers: providers.map((p) => `${p.id}:${p.model}`),
      oldLength: previousTrackable.length,
      newLength: currentTrackable.length,
    });
    const llmStart = Date.now();

    const analysisResult: AnalysisResultWithMeta = await this.deps.analyzeWithProviders(
      site.url,
      previousTrackable,
      currentTrackable,
      providers,
    );

    log(analysisResult.fallback ? 'warn' : 'info', 'llm', `Analysis complete`, {
      url: site.url,
      provider: analysisResult.provider ?? 'local-fallback',
      model: analysisResult.model,
      changed: analysisResult.changed,
      fallback: analysisResult.fallback,
      latencyMs: Date.now() - llmStart,
      summary: analysisResult.summary.slice(0, 200),
    });

    st.lastCheck = new Date().toISOString();
    st.lastResult = {
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
        await this.deps.sendDiscordAlert(config.notifications.discordWebhookUrl, site.url, chunk, undefined, undefined, PRODUCT_ALERT_USERNAME, PRODUCT_ALERT_AVATAR);
      }
      console.log(`[monitor] Change detected (${site.url}) — ${chunks.length} alert(s) sent ✓`);
    } else {
      console.log(`[monitor] No meaningful change (${site.url}): ${analysisResult.summary}`);
    }

    await this.deps.saveSiteState(site.id, {
      url: site.url,
      lastContent: currentContent,
      lastChecked: new Date().toISOString(),
    });
  }

  private recordError(siteId: string, err: unknown): void {
    const message = getErrorMessage(err);
    // A check interrupted by a deliberate shutdown isn't a real failure —
    // log it quietly (info) so it doesn't fire a Discord error alert.
    if (this.shuttingDown) {
      log('info', 'monitor', `Check interrupted during shutdown: ${message}`);
      return;
    }
    const st = this.ensureRuntime(siteId);
    st.errors.push({ timestamp: new Date().toISOString(), message });
    if (st.errors.length > MAX_ERRORS) st.errors.shift();
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
