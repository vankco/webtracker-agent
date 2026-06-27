/**
 * Unit tests: provider selection ordering + ConfigStore behaviour.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getEnabledProvidersByPriority,
  ConfigStore,
  validateAppConfig,
  loadAppConfigLenient,
  type AppConfig,
  type LlmProviderConfig,
} from '../config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_MODEL: Record<LlmProviderConfig['id'], string> = {
  gemini: 'gemini-2.5-flash',
  groq: 'llama-3.3-70b-versatile',
  claude: 'claude-haiku-4-5',
};

function makeProvider(
  id: LlmProviderConfig['id'],
  overrides: Partial<LlmProviderConfig> = {}
): LlmProviderConfig {
  return {
    id,
    enabled: true,
    priority: 1,
    model: DEFAULT_MODEL[id],
    apiKey: 'test-key',
    timeoutMs: 30_000,
    maxRetries: 1,
    ...overrides,
  };
}

function makeConfig(providers: LlmProviderConfig[]): AppConfig {
  return {
    sites: [{ id: 'example-test01', url: 'https://example.com', selector: '', enabled: true }],
    target: { url: 'https://example.com', selector: '' },
    schedule: { intervalMs: 300_000, runOnce: false },
    browser: {
      manualAssisted: false,
      manualAssistedInitialWaitMs: 0,
      persistSession: false,
      headless: true,
      slowMoMs: 0,
      keepOpenMs: 0,
      gotoTimeoutMs: 60_000,
      userDataDir: '.browser-profile',
    },
    notifications: { discordWebhookUrl: 'https://discord.com/api/webhooks/test', discordSystemWebhookUrl: '' },
    plugins: [],
    productWatchUrls: [],
    llmProviders: providers,
  };
}

// ---------------------------------------------------------------------------
// getEnabledProvidersByPriority
// ---------------------------------------------------------------------------

describe('getEnabledProvidersByPriority', () => {
  it('returns only enabled providers', () => {
    const config = makeConfig([
      makeProvider('gemini', { enabled: true, priority: 1 }),
      makeProvider('groq', { enabled: false, priority: 2 }),
    ]);
    const result = getEnabledProvidersByPriority(config);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('gemini');
  });

  it('sorts by ascending priority', () => {
    const config = makeConfig([
      makeProvider('groq', { enabled: true, priority: 1 }),
      makeProvider('gemini', { enabled: true, priority: 2 }),
    ]);
    const result = getEnabledProvidersByPriority(config);
    expect(result[0]?.id).toBe('groq');
    expect(result[1]?.id).toBe('gemini');
  });

  it('breaks priority ties alphabetically by id', () => {
    const config = makeConfig([
      makeProvider('groq', { enabled: true, priority: 1 }),
      makeProvider('gemini', { enabled: true, priority: 1 }),
    ]);
    const result = getEnabledProvidersByPriority(config);
    // 'gemini' < 'groq' alphabetically
    expect(result[0]?.id).toBe('gemini');
    expect(result[1]?.id).toBe('groq');
  });

  it('returns empty array when no providers are enabled', () => {
    const config = makeConfig([
      makeProvider('gemini', { enabled: false }),
      makeProvider('groq', { enabled: false }),
    ]);
    expect(getEnabledProvidersByPriority(config)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validateAppConfig
// ---------------------------------------------------------------------------

describe('validateAppConfig', () => {
  it('returns empty array for a fully valid config', () => {
    const config = makeConfig([makeProvider('gemini')]);
    expect(validateAppConfig(config)).toHaveLength(0);
  });

  it('reports missing site / target URL', () => {
    const config = makeConfig([makeProvider('gemini')]);
    config.sites = [];
    config.target.url = '';
    const errors = validateAppConfig(config);
    expect(errors.some((e) => e.includes('site') || e.includes('targetUrl'))).toBe(true);
  });

  it('reports missing Discord webhook URL', () => {
    const config = makeConfig([makeProvider('gemini')]);
    config.notifications.discordWebhookUrl = '';
    const errors = validateAppConfig(config);
    expect(errors.some((e) => e.includes('discordWebhookUrl'))).toBe(true);
  });

  it('reports no enabled providers', () => {
    const config = makeConfig([
      makeProvider('gemini', { enabled: false }),
      makeProvider('groq', { enabled: false }),
    ]);
    const errors = validateAppConfig(config);
    expect(errors.some((e) => e.includes('At least one LLM provider'))).toBe(true);
  });

  it('reports enabled provider with missing API key', () => {
    const config = makeConfig([makeProvider('gemini', { apiKey: undefined })]);
    const errors = validateAppConfig(config);
    expect(errors.some((e) => e.includes("'gemini'") && e.includes('API key'))).toBe(true);
  });

  it('can return multiple errors at once', () => {
    const config = makeConfig([makeProvider('gemini', { apiKey: undefined })]);
    config.sites = [];
    config.target.url = '';
    config.notifications.discordWebhookUrl = '';
    const errors = validateAppConfig(config);
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// ConfigStore
// ---------------------------------------------------------------------------

describe('ConfigStore', () => {
  let store: ConfigStore;
  const base = makeConfig([makeProvider('gemini'), makeProvider('groq', { enabled: false })]);

  beforeEach(() => {
    store = new ConfigStore(base);
  });

  it('get() returns the initial config', () => {
    expect(store.get().target.url).toBe('https://example.com');
  });

  it('getSafe() masks API keys', () => {
    const safe = store.getSafe();
    const gemini = safe.llmProviders.find((p) => p.id === 'gemini');
    expect(gemini?.apiKeyConfigured).toBe(true);
    // SafeLlmProviderConfig never carries apiKey — verify via key enumeration
    expect('apiKey' in (gemini ?? {})).toBe(false);
  });

  it('update() merges target fields', () => {
    store.update({ target: { url: 'https://new.example.com', selector: '' } });
    expect(store.get().target.url).toBe('https://new.example.com');
  });

  it('update() merges provider fields without overwriting existing keys', () => {
    store.update({
      llmProviders: [{ id: 'gemini', enabled: false, priority: 1, model: 'gemini-2.5-flash', timeoutMs: 30000, maxRetries: 1 }],
    });
    const gemini = store.get().llmProviders.find((p) => p.id === 'gemini');
    expect(gemini?.enabled).toBe(false);
    // API key should still be there from the original
    expect(gemini?.apiKey).toBe('test-key');
  });

  it('validate() returns errors for incomplete config', () => {
    store.update({ target: { url: '', selector: '' } });
    expect(store.validate().length).toBeGreaterThan(0);
  });

  it('set() fully replaces the config', () => {
    const newConfig = makeConfig([makeProvider('groq')]);
    newConfig.target.url = 'https://replaced.example.com';
    store.set(newConfig);
    expect(store.get().target.url).toBe('https://replaced.example.com');
    expect(store.get().llmProviders[0]?.id).toBe('groq');
  });
});

// ---------------------------------------------------------------------------
// loadAppConfigLenient
// ---------------------------------------------------------------------------

describe('loadAppConfigLenient', () => {
  it('does not throw when required fields are missing', () => {
    expect(() => loadAppConfigLenient({})).not.toThrow();
  });

  it('uses empty string for missing targetUrl', () => {
    const config = loadAppConfigLenient({});
    expect(config.target.url).toBe('');
  });

  it('reads targetUrl when present', () => {
    const config = loadAppConfigLenient({ targetUrl: 'https://foo.com' });
    expect(config.target.url).toBe('https://foo.com');
  });

  it('enables Gemini when an API key is present', () => {
    const config = loadAppConfigLenient({ llm: { gemini: { apiKey: 'my-key' } } });
    const gemini = config.llmProviders.find((p) => p.id === 'gemini');
    expect(gemini?.enabled).toBe(true);
    expect(gemini?.apiKey).toBe('my-key');
  });

  it('parses all three providers in gemini→groq→claude order', () => {
    const ids = loadAppConfigLenient({}).llmProviders.map((p) => p.id);
    expect(ids).toEqual(['gemini', 'groq', 'claude']);
  });

  it('defaults Claude to claude-haiku-4-5, priority 3, disabled without a key', () => {
    const claude = loadAppConfigLenient({}).llmProviders.find((p) => p.id === 'claude');
    expect(claude?.model).toBe('claude-haiku-4-5');
    expect(claude?.priority).toBe(3);
    expect(claude?.enabled).toBe(false);
  });

  it('enables Claude when an API key is present and respects a model override', () => {
    const config = loadAppConfigLenient({ llm: { claude: { apiKey: 'sk-ant', model: 'claude-sonnet-4-6' } } });
    const claude = config.llmProviders.find((p) => p.id === 'claude');
    expect(claude?.enabled).toBe(true);
    expect(claude?.apiKey).toBe('sk-ant');
    expect(claude?.model).toBe('claude-sonnet-4-6');
  });
});
