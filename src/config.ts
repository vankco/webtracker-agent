import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export type LlmProviderId = 'gemini' | 'groq' | 'claude';

export interface LlmProviderConfig {
  id: LlmProviderId;
  enabled: boolean;
  priority: number;
  model: string;
  apiKey?: string;
  timeoutMs: number;
  maxRetries: number;
}

export interface TargetConfig {
  url: string;
  selector: string;
}

/** A single time-of-day cadence band, evaluated in a site's timezone. */
export interface ScheduleWindow {
  startHour: number;   // 0–23, inclusive
  endHour: number;     // 0–23, exclusive; may wrap past midnight (e.g. 22→6)
  intervalMs: number;  // scrape cadence while inside this window
}

/** Optional per-site time-of-day-aware cadence. */
export interface SiteSchedule {
  timezone?: string;            // IANA tz for the windows; default 'America/Los_Angeles'
  windows?: ScheduleWindow[];   // first matching window wins
  intervalMs?: number;          // cadence when no window matches
}

/** One tracked site. The app monitors every enabled site independently. */
export interface SiteConfig {
  id: string;
  url: string;
  selector: string;
  enabled: boolean;
  label?: string;
  intervalMs?: number;       // per-site override; falls back to schedule.intervalMs
  schedule?: SiteSchedule;   // optional time-of-day-aware cadence
}

export interface ScheduleConfig {
  intervalMs: number;
  runOnce: boolean;
}

/** Derives a stable-ish site id: URL-host slug + short random suffix. */
export function generateSiteId(url: string): string {
  let host = 'site';
  try {
    host = new URL(url).hostname.replace(/^www\./, '').split('.')[0] || 'site';
  } catch {
    // non-URL input — fall back to the default slug
  }
  const slug = host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'site';
  return `${slug}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface BrowserConfig {
  manualAssisted: boolean;
  manualAssistedInitialWaitMs: number;
  persistSession: boolean;
  headless: boolean;
  slowMoMs: number;
  keepOpenMs: number;
  gotoTimeoutMs: number;
  userDataDir: string;
}

export interface NotificationsConfig {
  discordWebhookUrl: string;
  discordSystemWebhookUrl: string;
}

export interface AppConfig {
  /** All tracked sites. The monitor checks every enabled site independently. */
  sites: SiteConfig[];
  /** Backward-compat alias for sites[0] (kept in sync by ConfigStore). */
  target: TargetConfig;
  schedule: ScheduleConfig;
  browser: BrowserConfig;
  notifications: NotificationsConfig;
  llmProviders: LlmProviderConfig[];
  plugins: string[];
  /**
   * Product detail URLs to treat as the source of truth for availability.
   * The active site plugin re-checks each per scrape and overrides the
   * (less reliable) listing-page availability. Empty = listing-only behaviour.
   */
  productWatchUrls: string[];
}

/** API-safe provider config — never exposes raw API keys. */
export interface SafeLlmProviderConfig {
  id: LlmProviderId;
  enabled: boolean;
  priority: number;
  model: string;
  apiKeyConfigured: boolean;
  timeoutMs: number;
  maxRetries: number;
}

/** API-safe app config — never exposes raw API keys. */
export interface SafeAppConfig extends Omit<AppConfig, 'llmProviders'> {
  llmProviders: SafeLlmProviderConfig[];
}

// ---------------------------------------------------------------------------
// Internal helpers — build typed AppConfig sections from a typed JsonConfig.
// ---------------------------------------------------------------------------

function parseProviderConfig(json: JsonConfig): LlmProviderConfig[] {
  const g = json.llm?.gemini ?? {};
  const geminiApiKey = g.apiKey;
  const gemini: LlmProviderConfig = {
    id: 'gemini',
    enabled: g.enabled ?? Boolean(geminiApiKey),
    priority: Math.max(1, g.priority ?? 1),
    model: (g.model || 'gemini-2.5-flash').trim(),
    apiKey: geminiApiKey,
    timeoutMs: Math.max(1_000, g.timeoutMs ?? 30_000),
    maxRetries: Math.max(0, g.maxRetries ?? 1),
  };

  const gr = json.llm?.groq ?? {};
  const groqApiKey = gr.apiKey;
  const groq: LlmProviderConfig = {
    id: 'groq',
    enabled: gr.enabled ?? false,
    priority: Math.max(1, gr.priority ?? 2),
    model: (gr.model || 'llama-3.3-70b-versatile').trim(),
    apiKey: groqApiKey,
    timeoutMs: Math.max(1_000, gr.timeoutMs ?? 30_000),
    maxRetries: Math.max(0, gr.maxRetries ?? 1),
  };

  const c = json.llm?.claude ?? {};
  const claudeApiKey = c.apiKey;
  const claude: LlmProviderConfig = {
    id: 'claude',
    enabled: c.enabled ?? Boolean(claudeApiKey),
    priority: Math.max(1, c.priority ?? 3),
    model: (c.model || 'claude-haiku-4-5').trim(),
    apiKey: claudeApiKey,
    timeoutMs: Math.max(1_000, c.timeoutMs ?? 30_000),
    maxRetries: Math.max(0, c.maxRetries ?? 1),
  };

  return [gemini, groq, claude];
}

// ---------------------------------------------------------------------------
// Known models catalog (used by GET /api/llm/providers/models)
// ---------------------------------------------------------------------------

export type ModelTier = 'free' | 'paid';

export interface ModelInfo {
  id: string;
  tier: ModelTier;
}

export const KNOWN_PROVIDER_MODELS: Record<
  LlmProviderId,
  { models: ModelInfo[]; default: string }
> = {
  gemini: {
    models: [
      { id: 'gemini-2.5-flash',       tier: 'free' },
      { id: 'gemini-2.5-flash-lite',  tier: 'free' },
      { id: 'gemini-2.0-flash',       tier: 'free' },
      { id: 'gemini-2.0-flash-lite',  tier: 'free' },
      { id: 'gemini-2.5-pro',         tier: 'paid' },
      { id: 'gemini-3-flash-preview',  tier: 'free' },
      { id: 'gemini-3.1-flash-lite',  tier: 'free' },
      { id: 'gemini-3.5-flash',       tier: 'free' },
      { id: 'gemini-3.1-pro-preview', tier: 'paid' },
    ],
    default: 'gemini-2.5-flash',
  },
  groq: {
    models: [
      { id: 'llama-3.1-8b-instant',                        tier: 'free' },
      { id: 'llama-3.3-70b-versatile',                     tier: 'free' },
      { id: 'meta-llama/llama-4-scout-17b-16e-instruct',   tier: 'free' },
      { id: 'qwen/qwen3-32b',                              tier: 'free' },
      { id: 'openai/gpt-oss-20b',                          tier: 'free' },
      { id: 'openai/gpt-oss-120b',                         tier: 'free' },
      { id: 'groq/compound',                               tier: 'free' },
      { id: 'groq/compound-mini',                          tier: 'free' },
      { id: 'allam-2-7b',                                  tier: 'free' },
    ],
    default: 'llama-3.3-70b-versatile',
  },
  claude: {
    models: [
      { id: 'claude-haiku-4-5',  tier: 'paid' },
      { id: 'claude-sonnet-4-6', tier: 'paid' },
      { id: 'claude-opus-4-8',   tier: 'paid' },
    ],
    default: 'claude-haiku-4-5',
  },
};

// ---------------------------------------------------------------------------
// Public query helpers
// ---------------------------------------------------------------------------

export function getEnabledProvidersByPriority(config: AppConfig): LlmProviderConfig[] {
  return config.llmProviders
    .filter((provider) => provider.enabled)
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

export function getSafeConfig(config: AppConfig): SafeAppConfig {
  return {
    ...config,
    llmProviders: config.llmProviders.map((provider) => ({
      id: provider.id,
      enabled: provider.enabled,
      priority: provider.priority,
      model: provider.model,
      apiKeyConfigured: Boolean(provider.apiKey),
      timeoutMs: provider.timeoutMs,
      maxRetries: provider.maxRetries,
    })),
  };
}

// ---------------------------------------------------------------------------
// Validation (separated so both strict loader + ConfigStore can use it)
// ---------------------------------------------------------------------------

/** Returns an array of human-readable error strings; empty = valid. */
export function validateAppConfig(config: AppConfig): string[] {
  const errors: string[] = [];

  const enabledSites = config.sites.filter((s) => s.enabled);
  if (enabledSites.length === 0) {
    errors.push('At least one enabled site is required (add a site / set targetUrl)');
  }
  for (const s of enabledSites) {
    if (!s.url.trim()) {
      errors.push(`Site '${s.label || s.id}' is enabled but has no URL`);
    }
  }
  if (!config.notifications.discordWebhookUrl.trim()) {
    errors.push('discordWebhookUrl is required (set it in config.json)');
  }

  const enabled = getEnabledProvidersByPriority(config);
  if (enabled.length === 0) {
    errors.push('At least one LLM provider must be enabled');
  }
  for (const p of enabled) {
    if (!p.apiKey) {
      errors.push(`Provider '${p.id}' is enabled but has no API key configured`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// JSON config file loader
// ---------------------------------------------------------------------------

/**
 * Shape of config.json — all fields optional so partial files work fine.
 * Secrets live here instead of env vars when this file is present.
 */
export interface JsonConfig {
  targetUrl?: string;
  targetSelector?: string;
  /** Multi-site list. When present, supersedes targetUrl/targetSelector. */
  sites?: SiteConfig[];
  checkIntervalMs?: number;
  runOnce?: boolean;
  discordWebhookUrl?: string;
  apiPort?: number;
  plugins?: string[];
  productWatchUrls?: string[];

  // System/debug channel — health monitor and warn/error log alerts go here.
  // Falls back to discordWebhookUrl if not set.
  discordSystemWebhookUrl?: string;

  // Discord bot — read by discord-bot.ts only, never exposed via GET /api/config
  discordBotToken?: string;
  discordBotClientId?: string;
  discordBotGuildId?: string;

  llm?: {
    gemini?: {
      enabled?: boolean;
      apiKey?: string;
      model?: string;
      priority?: number;
      timeoutMs?: number;
      maxRetries?: number;
    };
    groq?: {
      enabled?: boolean;
      apiKey?: string;
      model?: string;
      priority?: number;
      timeoutMs?: number;
      maxRetries?: number;
    };
    claude?: {
      enabled?: boolean;
      apiKey?: string;
      model?: string;
      priority?: number;
      timeoutMs?: number;
      maxRetries?: number;
    };
  };

  browser?: {
    headless?: boolean;
    persistSession?: boolean;
    userDataDir?: string;
    gotoTimeoutMs?: number;
    slowMoMs?: number;
    keepOpenMs?: number;
    manualAssisted?: boolean;
    manualAssistedInitialWaitMs?: number;
  };
}

const CONFIG_FILE_NAME = 'config.json';

function resolveConfigPath(): string {
  // Walk up from the compiled file location to find the project root
  const dir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(dir, '..', CONFIG_FILE_NAME);
}

/**
 * Reads config.json from the project root.
 * Returns null if the file doesn't exist (not an error — fall back to env).
 * Throws on malformed JSON.
 */
export function readJsonConfig(filePath = resolveConfigPath()): JsonConfig | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as JsonConfig;
}

/**
 * Merges CLI flags onto config.json. CLI flags win. Top-level fields are
 * overwritten; the nested `llm.gemini`, `llm.groq` and `browser` objects are
 * deep-merged so a single CLI flag (e.g. --geminiModel) doesn't wipe sibling
 * fields persisted in config.json (e.g. geminiApiKey).
 */
export function mergeConfig(json: JsonConfig | null, cli: Partial<JsonConfig>): JsonConfig {
  const base: JsonConfig = json ?? {};
  const merged: JsonConfig = { ...base, ...cli };

  if (base.llm || cli.llm) {
    merged.llm = { ...base.llm, ...cli.llm };
    if (base.llm?.gemini || cli.llm?.gemini) {
      merged.llm.gemini = { ...base.llm?.gemini, ...cli.llm?.gemini };
    }
    if (base.llm?.groq || cli.llm?.groq) {
      merged.llm.groq = { ...base.llm?.groq, ...cli.llm?.groq };
    }
    if (base.llm?.claude || cli.llm?.claude) {
      merged.llm.claude = { ...base.llm?.claude, ...cli.llm?.claude };
    }
  }

  if (base.browser || cli.browser) {
    merged.browser = { ...base.browser, ...cli.browser };
  }

  return merged;
}

/**
 * Converts a live AppConfig back into the JsonConfig shape and writes it to
 * config.json.  Called after every API mutation so the file stays in sync.
 * Always writes the file (creating it if absent).
 */
export function saveJsonConfig(config: AppConfig, filePath = resolveConfigPath()): void {
  const gemini = config.llmProviders.find((p) => p.id === 'gemini');
  const groq   = config.llmProviders.find((p) => p.id === 'groq');
  const claude = config.llmProviders.find((p) => p.id === 'claude');

  const json: JsonConfig = {
    // sites is the source of truth; targetUrl/targetSelector are kept as a
    // sites[0] alias for backward compatibility with older single-site readers.
    sites:              config.sites.length > 0 ? config.sites : undefined,
    targetUrl:          config.target.url,
    targetSelector:     config.target.selector,
    checkIntervalMs:    config.schedule.intervalMs,
    runOnce:            config.schedule.runOnce,
    discordWebhookUrl:  config.notifications.discordWebhookUrl,
    discordSystemWebhookUrl: config.notifications.discordSystemWebhookUrl || undefined,

    llm: {
      gemini: gemini ? {
        enabled:    gemini.enabled,
        apiKey:     gemini.apiKey,
        model:      gemini.model,
        priority:   gemini.priority,
        timeoutMs:  gemini.timeoutMs,
        maxRetries: gemini.maxRetries,
      } : undefined,
      groq: groq ? {
        enabled:    groq.enabled,
        apiKey:     groq.apiKey,
        model:      groq.model,
        priority:   groq.priority,
        timeoutMs:  groq.timeoutMs,
        maxRetries: groq.maxRetries,
      } : undefined,
      claude: claude ? {
        enabled:    claude.enabled,
        apiKey:     claude.apiKey,
        model:      claude.model,
        priority:   claude.priority,
        timeoutMs:  claude.timeoutMs,
        maxRetries: claude.maxRetries,
      } : undefined,
    },

    browser: {
      headless:                    config.browser.headless,
      persistSession:              config.browser.persistSession,
      userDataDir:                 config.browser.userDataDir,
      gotoTimeoutMs:               config.browser.gotoTimeoutMs,
      slowMoMs:                    config.browser.slowMoMs,
      keepOpenMs:                  config.browser.keepOpenMs,
      manualAssisted:              config.browser.manualAssisted,
      manualAssistedInitialWaitMs: config.browser.manualAssistedInitialWaitMs,
    },
    plugins: config.plugins.length > 0 ? config.plugins : undefined,
    productWatchUrls: config.productWatchUrls.length > 0 ? config.productWatchUrls : undefined,
  };

  fs.writeFileSync(filePath, JSON.stringify(json, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Typed config builders (consume a JsonConfig, no env layer)
// ---------------------------------------------------------------------------

function buildBrowserConfig(b: NonNullable<JsonConfig['browser']> = {}): BrowserConfig {
  const manualAssisted = b.manualAssisted ?? false;
  const persistSession = manualAssisted || (b.persistSession ?? true);
  return {
    manualAssisted,
    manualAssistedInitialWaitMs: Math.max(0, b.manualAssistedInitialWaitMs ?? 120_000),
    persistSession,
    headless: manualAssisted ? false : (b.headless ?? true),
    slowMoMs: Math.max(0, b.slowMoMs ?? 0),
    keepOpenMs: Math.max(0, b.keepOpenMs ?? 0),
    gotoTimeoutMs: Math.max(10_000, b.gotoTimeoutMs ?? 60_000),
    userDataDir: b.userDataDir || '.browser-profile',
  };
}

function buildScheduleConfig(json: JsonConfig): ScheduleConfig {
  return {
    intervalMs: Math.max(1_000, json.checkIntervalMs ?? 300_000),
    runOnce: json.runOnce ?? false,
  };
}

/**
 * Resolves the tracked-site list. Prefers an explicit `sites` array; otherwise
 * migrates the legacy single `targetUrl`/`targetSelector` into a one-element
 * list. Returns [] when nothing is configured (lenient/fresh config).
 */
function buildSites(input: JsonConfig): SiteConfig[] {
  if (input.sites && input.sites.length > 0) {
    return input.sites.map((s) => ({
      id: s.id || generateSiteId(s.url ?? ''),
      url: s.url ?? '',
      selector: s.selector ?? '',
      enabled: s.enabled ?? true,
      ...(s.label !== undefined ? { label: s.label } : {}),
      ...(s.intervalMs !== undefined ? { intervalMs: s.intervalMs } : {}),
      ...(s.schedule !== undefined ? { schedule: s.schedule } : {}),
    }));
  }
  if ((input.targetUrl ?? '').trim()) {
    return [{
      id: generateSiteId(input.targetUrl as string),
      url: input.targetUrl as string,
      selector: input.targetSelector ?? '',
      enabled: true,
    }];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Typed AppConfig builder
// ---------------------------------------------------------------------------

/**
 * Builds a validated AppConfig from a typed JsonConfig (already merged from
 * config.json + CLI flags). In strict mode (CLI entry-point) it throws when
 * required fields (targetUrl, discordWebhookUrl) are missing; lenient mode
 * (API-server entry-point) defaults missing fields to empty strings so the
 * user can finish configuration via the UI.
 */
export function buildAppConfig(input: JsonConfig, opts: { strict?: boolean } = {}): AppConfig {
  const sites = buildSites(input);
  const first = sites[0];
  const config: AppConfig = {
    sites,
    target: {
      url: first?.url ?? '',
      selector: first?.selector ?? '',
    },
    schedule: buildScheduleConfig(input),
    browser: buildBrowserConfig(input.browser),
    notifications: {
      discordWebhookUrl: input.discordWebhookUrl ?? '',
      discordSystemWebhookUrl: input.discordSystemWebhookUrl ?? '',
    },
    llmProviders: parseProviderConfig(input),
    plugins: input.plugins ?? [],
    productWatchUrls: input.productWatchUrls ?? [],
  };

  if (opts.strict) {
    const errors = validateAppConfig(config);
    if (errors.length > 0) {
      throw new Error(errors.join('; '));
    }
  }

  return config;
}

/** Strict load — throws on missing required fields. Used by CLI mode. */
export function loadAppConfig(input: JsonConfig): AppConfig {
  return buildAppConfig(input, { strict: true });
}

/** Lenient load — never throws; missing fields default to empty. Used by API mode. */
export function loadAppConfigLenient(input: JsonConfig = {}): AppConfig {
  return buildAppConfig(input);
}

// ---------------------------------------------------------------------------
// Runtime mutable config store
// ---------------------------------------------------------------------------

/**
 * Holds a mutable copy of AppConfig for runtime updates via the REST API.
 * API keys in provider configs are preserved across safe-view projections.
 */
export class ConfigStore {
  private config: AppConfig;

  constructor(initial: AppConfig) {
    this.config = structuredClone(initial);
  }

  /** Returns the live config (with API keys). */
  get(): AppConfig {
    return this.config;
  }

  /** Returns the API-safe view (no raw API keys). */
  getSafe(): SafeAppConfig {
    return getSafeConfig(this.config);
  }

  /** Replace the full config. */
  set(config: AppConfig): void {
    this.config = structuredClone(config);
  }

  /** Keeps the target alias mirrored to sites[0]. */
  private syncTarget(): void {
    const first = this.config.sites[0];
    this.config.target = first
      ? { url: first.url, selector: first.selector }
      : { url: '', selector: '' };
  }

  /** Returns the tracked sites. */
  getSites(): SiteConfig[] {
    return this.config.sites;
  }

  /** Adds a site (generating its id) and returns the created record. */
  addSite(site: Omit<SiteConfig, 'id'>): SiteConfig {
    const created: SiteConfig = { id: generateSiteId(site.url), ...site };
    this.config.sites = [...this.config.sites, created];
    this.syncTarget();
    return created;
  }

  /** Patches an existing site by id; returns the updated record or null if unknown. */
  updateSite(id: string, patch: Partial<Omit<SiteConfig, 'id'>>): SiteConfig | null {
    const idx = this.config.sites.findIndex((s) => s.id === id);
    if (idx < 0) return null;
    this.config.sites[idx] = { ...this.config.sites[idx], ...patch };
    this.syncTarget();
    return this.config.sites[idx];
  }

  /** Removes a site by id. Refuses to remove the last site. */
  removeSite(id: string): { ok: boolean; reason?: string } {
    if (this.config.sites.length <= 1) {
      return { ok: false, reason: 'Cannot remove the last site' };
    }
    const next = this.config.sites.filter((s) => s.id !== id);
    if (next.length === this.config.sites.length) {
      return { ok: false, reason: 'Unknown site id' };
    }
    this.config.sites = next;
    this.syncTarget();
    return { ok: true };
  }

  /** Merge a partial config update (shallow merge per section). */
  update(updates: Partial<AppConfig>): void {
    if (updates.sites) {
      this.config.sites = updates.sites.map((s) => ({ ...s }));
      this.syncTarget();
    }
    if (updates.target) {
      this.config.target = { ...this.config.target, ...updates.target };
      // Mirror the single-site target patch onto sites[0] (backward compat).
      if (this.config.sites[0]) {
        this.config.sites[0] = {
          ...this.config.sites[0],
          url: this.config.target.url,
          selector: this.config.target.selector,
        };
      } else {
        this.config.sites = [{
          id: generateSiteId(this.config.target.url),
          url: this.config.target.url,
          selector: this.config.target.selector,
          enabled: true,
        }];
      }
    }
    if (updates.schedule) {
      this.config.schedule = { ...this.config.schedule, ...updates.schedule };
    }
    if (updates.browser) {
      this.config.browser = { ...this.config.browser, ...updates.browser };
    }
    if (updates.notifications) {
      this.config.notifications = { ...this.config.notifications, ...updates.notifications };
    }
    if (updates.productWatchUrls) {
      this.config.productWatchUrls = [...updates.productWatchUrls];
    }
    if (updates.llmProviders) {
      // Merge by provider id — preserves existing API keys unless explicitly overwritten
      const current = new Map(this.config.llmProviders.map((p) => [p.id, p]));
      for (const incoming of updates.llmProviders) {
        const existing = current.get(incoming.id);
        current.set(incoming.id, existing ? { ...existing, ...incoming } : incoming);
      }
      this.config.llmProviders = Array.from(current.values());
    }
  }

  /** Returns validation errors; empty array = ready to monitor. */
  validate(): string[] {
    return validateAppConfig(this.config);
  }
}
