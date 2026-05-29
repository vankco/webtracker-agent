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
}

export interface AppConfig {
  target: TargetConfig;
  schedule: ScheduleConfig;
  browser: BrowserConfig;
  notifications: NotificationsConfig;
  llmProviders: LlmProviderConfig[];
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

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function parseIntEnv(value: string | undefined, defaultValue: number): number {
  if (value == null || value.trim() === '') return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

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

export const KNOWN_PROVIDER_MODELS: Record<LlmProviderId, { models: string[]; default: string }> = {
  gemini: {
    models: [
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-2.0-flash',
      'gemini-1.5-flash',
      'gemini-1.5-pro',
    ],
    default: 'gemini-2.5-flash',
  },
  groq: {
    models: [
      'llama-3.3-70b-versatile',
      'llama-3.1-70b-versatile',
      'llama-3.1-8b-instant',
      'mixtral-8x7b-32768',
      'gemma2-9b-it',
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
// Strict config loader (existing behaviour — throws on invalid)
// ---------------------------------------------------------------------------

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const manualAssisted = parseBooleanEnv(env['MANUAL_ASSISTED'], false);
  const persistSession = manualAssisted || parseBooleanEnv(env['BROWSER_PERSIST_SESSION'], true);

  const config: AppConfig = {
    target: {
      url: requireEnv('TARGET_URL', env),
      selector: env['TARGET_SELECTOR'] ?? '',
    },
    schedule: {
      intervalMs: Math.max(1_000, parseIntEnv(env['CHECK_INTERVAL_MS'], 300_000)),
      runOnce: parseBooleanEnv(env['RUN_ONCE'], false),
    },
    browser: {
      manualAssisted,
      manualAssistedInitialWaitMs: Math.max(0, parseIntEnv(env['MANUAL_ASSISTED_INITIAL_WAIT_MS'], 120_000)),
      persistSession,
      headless: manualAssisted ? false : parseBooleanEnv(env['BROWSER_HEADLESS'], true),
      slowMoMs: Math.max(0, parseIntEnv(env['BROWSER_SLOW_MO_MS'], 0)),
      keepOpenMs: Math.max(0, parseIntEnv(env['BROWSER_KEEP_OPEN_MS'], 0)),
      gotoTimeoutMs: Math.max(10_000, parseIntEnv(env['BROWSER_GOTO_TIMEOUT_MS'], 60_000)),
      userDataDir: env['BROWSER_USER_DATA_DIR'] || '.browser-profile',
    },
    notifications: {
      discordWebhookUrl: requireEnv('DISCORD_WEBHOOK_URL', env),
    },
    llmProviders: parseProviderConfig(env),
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
export function loadAppConfigLenient(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const manualAssisted = parseBooleanEnv(env['MANUAL_ASSISTED'], false);
  const persistSession = manualAssisted || parseBooleanEnv(env['BROWSER_PERSIST_SESSION'], true);

  return {
    target: {
      url: env['TARGET_URL'] ?? '',
      selector: env['TARGET_SELECTOR'] ?? '',
    },
    schedule: {
      intervalMs: Math.max(1_000, parseIntEnv(env['CHECK_INTERVAL_MS'], 300_000)),
      runOnce: parseBooleanEnv(env['RUN_ONCE'], false),
    },
    browser: {
      manualAssisted,
      manualAssistedInitialWaitMs: Math.max(0, parseIntEnv(env['MANUAL_ASSISTED_INITIAL_WAIT_MS'], 120_000)),
      persistSession,
      headless: manualAssisted ? false : parseBooleanEnv(env['BROWSER_HEADLESS'], true),
      slowMoMs: Math.max(0, parseIntEnv(env['BROWSER_SLOW_MO_MS'], 0)),
      keepOpenMs: Math.max(0, parseIntEnv(env['BROWSER_KEEP_OPEN_MS'], 0)),
      gotoTimeoutMs: Math.max(10_000, parseIntEnv(env['BROWSER_GOTO_TIMEOUT_MS'], 60_000)),
      userDataDir: env['BROWSER_USER_DATA_DIR'] || '.browser-profile',
    },
    notifications: {
      discordWebhookUrl: env['DISCORD_WEBHOOK_URL'] ?? '',
    },
    llmProviders: parseProviderConfig(env),
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
