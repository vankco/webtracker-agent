/**
 * API endpoint integration tests.
 * All external I/O is mocked — no real network, browser, or LLM calls.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApiApp } from '../api.js';
import { ConfigStore, loadAppConfigLenient } from '../config.js';
import { MonitorController } from '../monitor-controller.js';
import { PluginRegistry } from '../plugin-registry.js';
import { loadState, getStateMtimeMs } from '../state.js';

// ---------------------------------------------------------------------------
// Mock heavy dependencies so tests run fast & offline
// ---------------------------------------------------------------------------

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

vi.mock('../scraper.js', () => ({
  scrapePageText: vi.fn().mockResolvedValue('scraped content'),
  closeScraperSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../llm.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../llm.js')>();
  return {
    ...original,
    defaultLlmAnalyzer: {
      analyze: vi.fn().mockResolvedValue({ changed: false, summary: 'No change (mock).' }),
    },
  };
});

vi.mock('../notifier.js', () => ({
  sendDiscordAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../state.js', () => ({
  loadState: vi.fn().mockReturnValue(null),
  saveState: vi.fn(),
  getStateMtimeMs: vi.fn().mockReturnValue(null),
  loadSiteState: vi.fn().mockResolvedValue(null),
  saveSiteState: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeFullConfig() {
  return {
    ...loadAppConfigLenient({
      targetUrl: 'https://example.com',
      discordWebhookUrl: 'https://discord.com/api/webhooks/test',
      llm: { gemini: { apiKey: 'test-gemini-key', enabled: true } },
    }),
  };
}

function makeApp() {
  const configStore = new ConfigStore(makeFullConfig());
  const monitorController = new MonitorController();
  return { app: createApiApp(configStore, monitorController, () => {}), configStore, monitorController };
}

// ---------------------------------------------------------------------------
// GET /api/config
// ---------------------------------------------------------------------------

describe('GET /api/config', () => {
  it('returns 200 with SafeAppConfig', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.target.url).toBe('https://example.com');
  });

  it('never exposes raw API keys', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/config');
    const gemini = (res.body.data.llmProviders as Array<{ id: string; apiKey?: string; apiKeyConfigured: boolean }>).find((p) => p.id === 'gemini');
    expect(gemini?.apiKey).toBeUndefined();
    expect(gemini?.apiKeyConfigured).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/config
// ---------------------------------------------------------------------------

describe('PUT /api/config', () => {
  it('updates target URL and returns updated SafeAppConfig', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .put('/api/config')
      .send({ target: { url: 'https://updated.example.com' } });

    expect(res.status).toBe(200);
    expect(res.body.data.target.url).toBe('https://updated.example.com');
  });

  it('returns 400 for non-object body', async () => {
    const { app } = makeApp();
    const res = await request(app).put('/api/config').send('not-an-object').set('Content-Type', 'text/plain');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('persists productWatchUrls, trimming and dropping empty entries', async () => {
    const { app, configStore } = makeApp();
    const res = await request(app)
      .put('/api/config')
      .send({ productWatchUrls: ['  https://www.hermes.com/p/a-H1/  ', '', 'https://www.hermes.com/p/b-H2/'] });

    expect(res.status).toBe(200);
    expect(res.body.data.productWatchUrls).toEqual([
      'https://www.hermes.com/p/a-H1/',
      'https://www.hermes.com/p/b-H2/',
    ]);
    expect(configStore.get().productWatchUrls).toEqual([
      'https://www.hermes.com/p/a-H1/',
      'https://www.hermes.com/p/b-H2/',
    ]);
  });
});

// ---------------------------------------------------------------------------
// GET /api/llm/providers
// ---------------------------------------------------------------------------

describe('GET /api/llm/providers', () => {
  it('returns provider list without API keys', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/llm/providers');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    for (const p of res.body.data as Array<Record<string, unknown>>) {
      expect(p['apiKey']).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// PUT /api/llm/providers
// ---------------------------------------------------------------------------

describe('PUT /api/llm/providers', () => {
  it('enables Groq and sets priority', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .put('/api/llm/providers')
      .send({ providers: [{ id: 'groq', enabled: true, priority: 2, apiKey: 'new-groq-key' }] });

    expect(res.status).toBe(200);
    const groq = (res.body.data as Array<{ id: string; enabled: boolean; priority: number }>).find((p) => p.id === 'groq');
    expect(groq?.enabled).toBe(true);
    expect(groq?.priority).toBe(2);
  });

  it('rejects unknown provider id', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .put('/api/llm/providers')
      .send({ providers: [{ id: 'openai', enabled: true }] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PROVIDER_NOT_FOUND');
  });

  it('rejects missing providers array', async () => {
    const { app } = makeApp();
    const res = await request(app).put('/api/llm/providers').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
// GET /api/llm/providers/models
// ---------------------------------------------------------------------------

describe('GET /api/llm/providers/models', () => {
  it('returns model catalog for all providers', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/llm/providers/models');
    expect(res.status).toBe(200);
    const ids = (res.body.data as Array<{ providerId: string }>).map((m) => m.providerId);
    expect(ids).toContain('gemini');
    expect(ids).toContain('groq');
  });
});

// ---------------------------------------------------------------------------
// POST /api/llm/providers/test
// ---------------------------------------------------------------------------

describe('POST /api/llm/providers/test', () => {
  it('returns test result for configured provider', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/llm/providers/test')
      .send({ providerId: 'gemini' });

    expect(res.status).toBe(200);
    expect(res.body.data.providerId).toBe('gemini');
    expect(typeof res.body.data.latencyMs).toBe('number');
  });

  it('returns 400 when no providerId given', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/llm/providers/test').send({});
    expect(res.status).toBe(400);
  });

  it('returns 400 when provider has no API key', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/llm/providers/test')
      .send({ providerId: 'groq' }); // groq has no key in test fixture

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
// POST /api/monitor/start
// ---------------------------------------------------------------------------

describe('POST /api/monitor/start', () => {
  it('returns 422 when config is incomplete', async () => {
    const configStore = new ConfigStore(loadAppConfigLenient({})); // no URL etc.
    const monitorController = new MonitorController();
    const app = createApiApp(configStore, monitorController, () => {});

    const res = await request(app).post('/api/monitor/start').send({});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NOT_CONFIGURED');
  });

  it('returns 202 when config is valid', async () => {
    const { app, monitorController } = makeApp();
    // Make sure monitor isn't already running
    expect(monitorController.isRunning()).toBe(false);

    const res = await request(app).post('/api/monitor/start').send({});
    expect(res.status).toBe(202);
    expect(res.body.data.started).toBe(true);

    // Clean up
    await monitorController.stop();
  });

  it('returns 409 when monitor is already running', async () => {
    const { app, monitorController } = makeApp();
    await request(app).post('/api/monitor/start').send({});
    // Give a tiny tick for the async start to register isRunning = true
    await new Promise((r) => setTimeout(r, 10));

    const res = await request(app).post('/api/monitor/start').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_RUNNING');

    await monitorController.stop();
  });
});

// ---------------------------------------------------------------------------
// POST /api/monitor/stop
// ---------------------------------------------------------------------------

describe('POST /api/monitor/stop', () => {
  it('returns 409 when monitor is not running', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/monitor/stop').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_RUNNING');
  });
});

// ---------------------------------------------------------------------------
// GET /api/monitor/status
// ---------------------------------------------------------------------------

describe('GET /api/monitor/status', () => {
  it('returns status with running=false initially', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/monitor/status');
    expect(res.status).toBe(200);
    expect(res.body.data.running).toBe(false);
    expect(typeof res.body.data.sites).toBe('object');
  });
});

// ---------------------------------------------------------------------------
// Site CRUD — /api/sites
// ---------------------------------------------------------------------------

describe('Site CRUD /api/sites', () => {
  it('lists sites (migrated from targetUrl)', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/sites');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('adds a site and returns it with a generated id', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/sites').send({ url: 'https://second.example.com', label: 'Second' });
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBeTruthy();
    expect(res.body.data.url).toBe('https://second.example.com');
    const list = await request(app).get('/api/sites');
    expect(list.body.data.length).toBe(2);
  });

  it('rejects adding a site without a url', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/sites').send({ label: 'No URL' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('updates a site', async () => {
    const { app, configStore } = makeApp();
    const id = configStore.getSites()[0].id;
    const res = await request(app).put(`/api/sites/${id}`).send({ label: 'Renamed', enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.data.label).toBe('Renamed');
    expect(res.body.data.enabled).toBe(false);
  });

  it('404s updating an unknown site', async () => {
    const { app } = makeApp();
    const res = await request(app).put('/api/sites/does-not-exist').send({ label: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('refuses to delete the last site (422)', async () => {
    const { app, configStore } = makeApp();
    const id = configStore.getSites()[0].id;
    const res = await request(app).delete(`/api/sites/${id}`);
    expect(res.status).toBe(422);
  });

  it('deletes a site when more than one exists', async () => {
    const { app, configStore } = makeApp();
    await request(app).post('/api/sites').send({ url: 'https://second.example.com' });
    const id = configStore.getSites()[0].id;
    const res = await request(app).delete(`/api/sites/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.removed).toBe(true);
    expect(configStore.getSites().length).toBe(1);
  });

  it('404s deleting an unknown site when more than one exists', async () => {
    const { app } = makeApp();
    await request(app).post('/api/sites').send({ url: 'https://second.example.com' });
    const res = await request(app).delete('/api/sites/nope');
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/validate/scrape
// ---------------------------------------------------------------------------

describe('POST /api/validate/scrape', () => {
  it('returns scraped content info', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/validate/scrape')
      .send({ url: 'https://example.com' });

    expect(res.status).toBe(200);
    expect(res.body.data.success).toBe(true);
    expect(res.body.data.snippet).toBe('scraped content');
  });

  it('returns 400 when URL is missing', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/validate/scrape').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
// POST /api/ask
// ---------------------------------------------------------------------------

function makeAskApp(qaAnswerer = vi.fn().mockResolvedValue('Bag A is available.')) {
  const configStore = new ConfigStore(makeFullConfig());
  const monitorController = new MonitorController();
  const app = createApiApp(configStore, monitorController, () => {}, qaAnswerer);
  return { app, configStore, monitorController, qaAnswerer };
}

describe('POST /api/ask', () => {
  it('returns 400 when question is missing', async () => {
    const { app } = makeAskApp();
    const res = await request(app).post('/api/ask').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 422 when no target URL is configured', async () => {
    const configStore = new ConfigStore({ ...makeFullConfig(), target: { url: '', selector: '' } });
    const monitorController = new MonitorController();
    const app = createApiApp(configStore, monitorController, () => {});
    const res = await request(app).post('/api/ask').send({ question: 'what is in stock?' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NOT_CONFIGURED');
  });

  it('returns 200 with answer on success', async () => {
    const { app } = makeAskApp();
    const res = await request(app).post('/api/ask').send({ question: 'what is in stock?' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.answer).toBe('Bag A is available.');
  });

  it('returns 502 when all providers fail', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('all providers failed'));
    const { app } = makeAskApp(failing);
    const res = await request(app).post('/api/ask').send({ question: 'what is in stock?' });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('caches prompt context, rebuilding only when state.json mtime changes', async () => {
    const mockedLoad = vi.mocked(loadState);
    const mockedMtime = vi.mocked(getStateMtimeMs);
    mockedLoad.mockClear();
    mockedLoad.mockReturnValue({ url: 'https://example.com', lastContent: '', lastChecked: '' });
    const { app } = makeAskApp();

    // Stable mtime → second request reuses the cache (loadState not called again).
    mockedMtime.mockReturnValue(111);
    await request(app).post('/api/ask').send({ question: 'q1' });
    await request(app).post('/api/ask').send({ question: 'q2' });
    expect(mockedLoad).toHaveBeenCalledTimes(1);

    // Changed mtime → cache invalidated, rebuilds once.
    mockedMtime.mockReturnValue(222);
    await request(app).post('/api/ask').send({ question: 'q3' });
    expect(mockedLoad).toHaveBeenCalledTimes(2);

    mockedMtime.mockReturnValue(null); // restore default for later tests
  });
});

// ---------------------------------------------------------------------------
// 404 for unknown routes
// ---------------------------------------------------------------------------

describe('Unknown API routes', () => {
  it('returns 404 for /api/nonexistent', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
