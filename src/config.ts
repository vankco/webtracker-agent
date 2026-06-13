import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseBooleanEnv, parseIntEnv, getErrorMessage } from './utils.js';

export type LlmProviderId = 'gemini' | 'groq';

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

export interface ScheduleConfig {
  intervalMs: number;
  runOnce: boolean;
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
  target: TargetConfig;
  schedule: ScheduleConfig;
  browser: BrowserConfig;
  notifications: NotificationsConfig;
  llmProviders: LlmProviderConfig[];
  plugins: string[];
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
// Internal helpers
// ---------------------------------------------------------------------------

function requireEnv(key: string, env: NodeJS.ProcessEnv): string {
  const value = env[key];
  if (!value) {
    throw new Error(`Missing required env variable: ${key}`);
  }
  return value;
}

function parseProviderConfig(env: NodeJS.ProcessEnv): LlmProviderConfig[] {
  const geminiApiKey = env['GEMINI_API_KEY'];
  const geminiEnabledByDefault = Boolean(geminiApiKey);
  const gemini: LlmProviderConfig = {
    id: 'gemini',
    enabled: parseBooleanEnv(env['LLM_GEMINI_ENABLED'], geminiEnabledByDefault),
    priority: Math.max(1, parseIntEnv(env['LLM_GEMINI_PRIORITY'], 1)),
    model: (env['LLM_GEMINI_MODEL'] || 'gemini-2.5-flash').trim(),
    apiKey: geminiApiKey,
    timeoutMs: Math.max(1_000, parseIntEnv(env['LLM_GEMINI_TIMEOUT_MS'], 30_000)),
    maxRetries: Math.max(0, parseIntEnv(env['LLM_GEMINI_MAX_RETRIES'], 1)),
  };

  const groqApiKey = env['GROQ_API_KEY'];
  const groq: LlmProviderConfig = {
    id: 'groq',
    enabled: parseBooleanEnv(env['LLM_GROQ_ENABLED'], false),
    priority: Math.max(1, parseIntEnv(env['LLM_GROQ_PRIORITY'], 2)),
    model: (env['LLM_GROQ_MODEL'] || 'llama-3.3-70b-versatile').trim(),
    apiKey: groqApiKey,
    timeoutMs: Math.max(1_000, parseIntEnv(env['LLM_GROQ_TIMEOUT_MS'], 30_000)),
    maxRetries: Math.max(0, parseIntEnv(env['LLM_GROQ_MAX_RETRIES'], 1)),
  };

  return [gemini, groq];
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

  if (!config.target.url.trim()) {
    errors.push('target.url (TARGET_URL) is required');
  }
  if (!config.notifications.discordWebhookUrl.trim()) {
    errors.push('notifications.discordWebhookUrl (DISCORD_WEBHOOK_URL) is required');
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
  checkIntervalMs?: number;
  runOnce?: boolean;
  discordWebhookUrl?: string;
  apiPort?: number;
  plugins?: string[];

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
 * Merges a JsonConfig onto a NodeJS.ProcessEnv-shaped object so the existing
 * env-based loaders can consume it transparently.  config.json values act as
 * defaults — any env var already set in the shell takes precedence.
 */
function jsonToEnv(json: JsonConfig, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };

  // config.json values are defaults — env vars already set in the shell take precedence.
  const set = (key: string, value: string) => { if (env[key] === undefined) env[key] = value; };

  if (json.targetUrl !== undefined)         set('TARGET_URL',              json.targetUrl);
  if (json.targetSelector !== undefined)    set('TARGET_SELECTOR',         json.targetSelector);
  if (json.checkIntervalMs !== undefined)   set('CHECK_INTERVAL_MS',       String(json.checkIntervalMs));
  if (json.runOnce !== undefined)           set('RUN_ONCE',                String(json.runOnce));
  if (json.discordWebhookUrl !== undefined) set('DISCORD_WEBHOOK_URL',     json.discordWebhookUrl);
  if (json.apiPort !== undefined)           set('API_PORT',                String(json.apiPort));
  if (json.plugins !== undefined)           set('PLUGINS',                 json.plugins.join(','));
  if (json.discordSystemWebhookUrl !== undefined) set('DISCORD_SYSTEM_WEBHOOK_URL', json.discordSystemWebhookUrl);
  if (json.discordBotToken !== undefined)    set('DISCORD_BOT_TOKEN',       json.discordBotToken);
  if (json.discordBotClientId !== undefined) set('DISCORD_BOT_CLIENT_ID',   json.discordBotClientId);
  if (json.discordBotGuildId !== undefined)  set('DISCORD_BOT_GUILD_ID',    json.discordBotGuildId);

  const g = json.llm?.gemini;
  if (g) {
    if (g.enabled !== undefined)    set('LLM_GEMINI_ENABLED',     String(g.enabled));
    if (g.apiKey !== undefined)     set('GEMINI_API_KEY',          g.apiKey);
    if (g.model !== undefined)      set('LLM_GEMINI_MODEL',        g.model);
    if (g.priority !== undefined)   set('LLM_GEMINI_PRIORITY',     String(g.priority));
    if (g.timeoutMs !== undefined)  set('LLM_GEMINI_TIMEOUT_MS',   String(g.timeoutMs));
    if (g.maxRetries !== undefined) set('LLM_GEMINI_MAX_RETRIES',  String(g.maxRetries));
  }

  const gr = json.llm?.groq;
  if (gr) {
    if (gr.enabled !== undefined)    set('LLM_GROQ_ENABLED',     String(gr.enabled));
    if (gr.apiKey !== undefined)     set('GROQ_API_KEY',          gr.apiKey);
    if (gr.model !== undefined)      set('LLM_GROQ_MODEL',        gr.model);
    if (gr.priority !== undefined)   set('LLM_GROQ_PRIORITY',     String(gr.priority));
    if (gr.timeoutMs !== undefined)  set('LLM_GROQ_TIMEOUT_MS',   String(gr.timeoutMs));
    if (gr.maxRetries !== undefined) set('LLM_GROQ_MAX_RETRIES',  String(gr.maxRetries));
  }

  const b = json.browser;
  if (b) {
    if (b.headless !== undefined)                    set('BROWSER_HEADLESS',                      String(b.headless));
    if (b.persistSession !== undefined)              set('BROWSER_PERSIST_SESSION',               String(b.persistSession));
    if (b.userDataDir !== undefined)                 set('BROWSER_USER_DATA_DIR',                 b.userDataDir);
    if (b.gotoTimeoutMs !== undefined)               set('BROWSER_GOTO_TIMEOUT_MS',               String(b.gotoTimeoutMs));
    if (b.slowMoMs !== undefined)                    set('BROWSER_SLOW_MO_MS',                    String(b.slowMoMs));
    if (b.keepOpenMs !== undefined)                  set('BROWSER_KEEP_OPEN_MS',                  String(b.keepOpenMs));
    if (b.manualAssisted !== undefined)              set('MANUAL_ASSISTED',                       String(b.manualAssisted));
    if (b.manualAssistedInitialWaitMs !== undefined) set('MANUAL_ASSISTED_INITIAL_WAIT_MS',       String(b.manualAssistedInitialWaitMs));
  }

  return env;
}

/**
 * Converts a live AppConfig back into the JsonConfig shape and writes it to
 * config.json.  Called after every API mutation so the file stays in sync.
 * No-ops silently if the file doesn't exist yet (env-var-only setups).
 */
export function saveJsonConfig(config: AppConfig, filePath = resolveConfigPath()): void {
  const gemini = config.llmProviders.find((p) => p.id === 'gemini');
  const groq   = config.llmProviders.find((p) => p.id === 'groq');

  const json: JsonConfig = {
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
  };

  fs.writeFileSync(filePath, JSON.stringify(json, null, 2), 'utf-8');
}

/**
 * Resolves the effective env by layering config.json under process.env:
 * shell env vars take precedence, and config.json only supplies values for
 * keys the environment didn't set. Falls back to process.env if no
 * config.json is present.
 */
export function resolveEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  try {
    const json = readJsonConfig();
    if (json) {
      console.log(`[config] Loaded config.json`);
      return jsonToEnv(json, base);
    }
  } catch (err) {
    console.warn(`[config] Failed to parse config.json: ${getErrorMessage(err)}. Falling back to env.`);
  }
  return base;
}

// ---------------------------------------------------------------------------
// Shared env-to-config builders (used by both loaders below)
// ---------------------------------------------------------------------------

function buildBrowserConfig(env: NodeJS.ProcessEnv): BrowserConfig {
  const manualAssisted = parseBooleanEnv(env['MANUAL_ASSISTED'], false);
  const persistSession = manualAssisted || parseBooleanEnv(env['BROWSER_PERSIST_SESSION'], true);
  return {
    manualAssisted,
    manualAssistedInitialWaitMs: Math.max(0, parseIntEnv(env['MANUAL_ASSISTED_INITIAL_WAIT_MS'], 120_000)),
    persistSession,
    headless: manualAssisted ? false : parseBooleanEnv(env['BROWSER_HEADLESS'], true),
    slowMoMs: Math.max(0, parseIntEnv(env['BROWSER_SLOW_MO_MS'], 0)),
    keepOpenMs: Math.max(0, parseIntEnv(env['BROWSER_KEEP_OPEN_MS'], 0)),
    gotoTimeoutMs: Math.max(10_000, parseIntEnv(env['BROWSER_GOTO_TIMEOUT_MS'], 60_000)),
    userDataDir: env['BROWSER_USER_DATA_DIR'] || '.browser-profile',
  };
}

function buildScheduleConfig(env: NodeJS.ProcessEnv): ScheduleConfig {
  return {
    intervalMs: Math.max(1_000, parseIntEnv(env['CHECK_INTERVAL_MS'], 300_000)),
    runOnce: parseBooleanEnv(env['RUN_ONCE'], false),
  };
}

function buildPlugins(env: NodeJS.ProcessEnv): string[] {
  return env['PLUGINS'] ? env['PLUGINS'].split(',').map(s => s.trim()).filter(Boolean) : [];
}

// ---------------------------------------------------------------------------
// Strict config loader (existing behaviour — throws on invalid)
// ---------------------------------------------------------------------------

export function loadAppConfig(env: NodeJS.ProcessEnv = resolveEnv()): AppConfig {
  const config: AppConfig = {
    target: {
      url: requireEnv('TARGET_URL', env),
      selector: env['TARGET_SELECTOR'] ?? '',
    },
    schedule: buildScheduleConfig(env),
    browser: buildBrowserConfig(env),
    notifications: {
      discordWebhookUrl: requireEnv('DISCORD_WEBHOOK_URL', env),
      discordSystemWebhookUrl: env['DISCORD_SYSTEM_WEBHOOK_URL'] ?? '',
    },
    llmProviders: parseProviderConfig(env),
    plugins: buildPlugins(env),
  };

  const errors = validateAppConfig(config);
  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }

  return config;
}

// ---------------------------------------------------------------------------
// Lenient config loader (API-server mode — no throws for missing fields)
// ---------------------------------------------------------------------------

/**
 * Loads config from env without requiring TARGET_URL / DISCORD_WEBHOOK_URL.
 * Missing fields default to empty string.  Used when the API server is the
 * primary entry-point and the user will configure fields via the API.
 */
export function loadAppConfigLenient(env: NodeJS.ProcessEnv = resolveEnv()): AppConfig {
  return {
    target: {
      url: env['TARGET_URL'] ?? '',
      selector: env['TARGET_SELECTOR'] ?? '',
    },
    schedule: buildScheduleConfig(env),
    browser: buildBrowserConfig(env),
    notifications: {
      discordWebhookUrl: env['DISCORD_WEBHOOK_URL'] ?? '',
      discordSystemWebhookUrl: env['DISCORD_SYSTEM_WEBHOOK_URL'] ?? '',
    },
    llmProviders: parseProviderConfig(env),
    plugins: buildPlugins(env),
  };
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

  /** Merge a partial config update (shallow merge per section). */
  update(updates: Partial<AppConfig>): void {
    if (updates.target) {
      this.config.target = { ...this.config.target, ...updates.target };
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
