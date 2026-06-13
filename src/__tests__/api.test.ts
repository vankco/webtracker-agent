/**
 * API endpoint integration tests.
 * All external I/O is mocked — no real network, browser, or LLM calls.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApiApp } from '../api.js';
import { ConfigStore, loadAppConfigLenient } from '../config.js';
import { MonitorController } from '../monitor-controller.js';
import { PluginRegistry } from '../plugin-registry.js';
import { loadState } from '../state.js';
import type { SitePlugin } from '../plugin-types.js';

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
}));

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeFullConfig() {
  return {
    ...loadAppConfigLenient({
      TARGET_URL: 'https://example.com',
      DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/test',
      GEMINI_API_KEY: 'test-gemini-key',
      LLM_GEMINI_ENABLED: 'true',
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
    expect(Array.isArray(res.body.data.errors)).toBe(true);
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
// POST /api/predict
// ---------------------------------------------------------------------------

function makePredictionPlugin(): SitePlugin {
  return {
    name: 'Fake',
    matches: () => true,
    extractProducts: async () => [],
    productsToText: () => '',
    parseProductLine: () => ({}),
    filterAvailable: (p) => p,
    diff: () => ({ hasChanges: false, summary: '', alertBody: '' }),
    formatBaselineMessage: () => '',
    formatHistoryForPrediction: () => 'formatted history',
  };
}

function makePredictApp(opts: { withPlugin?: boolean; predictor?: any } = {}) {
  const configStore = new ConfigStore(makeFullConfig());
  const registry = new PluginRegistry();
  if (opts.withPlugin !== false) registry.register(makePredictionPlugin());
  const monitorController = new MonitorController({}, registry);
  const predictor =
    opts.predictor ??
    vi.fn().mockResolvedValue({
      generatedAt: '2026-06-01T00:00:00.000Z',
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      summary: 'Likely restock soon.',
      insights: ['Bag X restocks weekly'],
      historyEntryCount: 5,
    });
  const app = createApiApp(configStore, monitorController, () => {}, predictor);
  return { app, predictor };
}

describe('POST /api/predict', () => {
  beforeEach(() => {
    vi.mocked(loadState).mockReturnValue(null);
  });

  it('returns 200 with a prediction when history and plugin are present', async () => {
    vi.mocked(loadState).mockReturnValue({
      url: 'https://example.com',
      lastContent: '',
      lastChecked: '2026-06-01T00:00:00.000Z',
      history: [
        { timestamp: 't1', products: [], availableCount: 1, changeSummary: 'baseline' },
        { timestamp: 't2', products: [], availableCount: 2, changeSummary: '1 newly available' },
        { timestamp: 't3', products: [], availableCount: 1, changeSummary: '1 no longer available' },
      ],
    });
    const { app, predictor } = makePredictApp();
    const res = await request(app).post('/api/predict').send({});
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toBe('Likely restock soon.');
    expect(res.body.data.insights).toHaveLength(1);
    expect(predictor).toHaveBeenCalledOnce();
  });

  it('returns 422 when there is not enough history', async () => {
    vi.mocked(loadState).mockReturnValue({
      url: 'https://example.com',
      lastContent: '',
      lastChecked: '2026-06-01T00:00:00.000Z',
      history: [{ timestamp: 't1', products: [], availableCount: 1, changeSummary: 'baseline' }],
    });
    const { app } = makePredictApp();
    const res = await request(app).post('/api/predict').send({});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PREDICTION_FAILED');
  });

  it('returns 422 when no plugin matches the URL', async () => {
    vi.mocked(loadState).mockReturnValue({
      url: 'https://example.com',
      lastContent: '',
      lastChecked: '2026-06-01T00:00:00.000Z',
      history: [
        { timestamp: 't1', products: [], availableCount: 1, changeSummary: 'baseline' },
        { timestamp: 't2', products: [], availableCount: 2, changeSummary: 'x' },
        { timestamp: 't3', products: [], availableCount: 1, changeSummary: 'y' },
      ],
    });
    const { app } = makePredictApp({ withPlugin: false });
    const res = await request(app).post('/api/predict').send({});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PREDICTION_FAILED');
  });

  it('returns 502 when the predictor throws', async () => {
    vi.mocked(loadState).mockReturnValue({
      url: 'https://example.com',
      lastContent: '',
      lastChecked: '2026-06-01T00:00:00.000Z',
      history: [
        { timestamp: 't1', products: [], availableCount: 1, changeSummary: 'baseline' },
        { timestamp: 't2', products: [], availableCount: 2, changeSummary: 'x' },
        { timestamp: 't3', products: [], availableCount: 1, changeSummary: 'y' },
      ],
    });
    const failingPredictor = vi.fn().mockRejectedValue(new Error('all providers failed'));
    const { app } = makePredictApp({ predictor: failingPredictor });
    const res = await request(app).post('/api/predict').send({});
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PREDICTION_FAILED');
  });
});

// ---------------------------------------------------------------------------
// POST /api/ask
// ---------------------------------------------------------------------------

function makeAskApp(qaAnswerer = vi.fn().mockResolvedValue('Bag A is available.')) {
  const configStore = new ConfigStore(makeFullConfig());
  const monitorController = new MonitorController();
  const app = createApiApp(configStore, monitorController, () => {}, undefined, qaAnswerer);
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
