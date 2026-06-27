/**
 * E2E integration tests — full monitor lifecycle via the REST API.
 * All external I/O is mocked; tests run fully offline.
 *
 * Scenarios covered:
 *  1. Configure → start → baseline saved → stop
 *  2. Second run: same content → no LLM call → no alert
 *  3. Third run: changed content → LLM called → alert sent
 *  4. LLM failover: Gemini fails → Groq succeeds
 *  5. All LLM providers fail → local fallback used, monitor does NOT crash
 *  6. Long summary → chunked into multiple Discord alerts
 *  7. Monitor stop → isRunning=false → cannot stop again (409)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApiApp } from '../api.js';
import { ConfigStore, loadAppConfigLenient } from '../config.js';
import { MonitorController } from '../monitor-controller.js';
import type { MonitorDependencies } from '../monitor-controller.js';
import type { MonitorState } from '../state.js';
import type { AnalysisResult } from '../analyzer.js';

/** The multi-site status returns sites keyed by id; e2e configs have exactly one. */
function firstSite(body: { data: { sites: Record<string, unknown> } }): any {
  return Object.values(body.data.sites)[0];
}
import { PluginRegistry } from '../plugin-registry.js';
import hermesPlugin from '@webtracker/plugin-hermes';
import { setAlertCallback } from '../logger.js';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------
function makeFullConfig() {
  return loadAppConfigLenient({
    targetUrl: 'https://e2e.example.com',
    discordWebhookUrl: 'https://discord.com/api/webhooks/e2e',
    llm: {
      gemini: { apiKey: 'gemini-key', enabled: true },
      groq: { apiKey: 'groq-key', enabled: true, priority: 2 },
    },
  });
}

interface StateStore {
  state: MonitorState | null;
}

function makeDeps(overrides: Partial<MonitorDependencies> = {}): {
  deps: MonitorDependencies;
  stateStore: StateStore;
  alertsSent: Array<{ url: string; summary: string }>;
  scrapeContent: { value: string };
  analyzeResult: { value: AnalysisResult };
} {
  const stateStore: StateStore = { state: null };
  const alertsSent: Array<{ url: string; summary: string }> = [];
  const scrapeContent = { value: 'initial page content' };
  const analyzeResult: { value: AnalysisResult } = {
    value: { changed: false, summary: 'No change (mock).' },
  };

  const deps: MonitorDependencies = {
    scrapePageText: vi.fn().mockImplementation(() => Promise.resolve(scrapeContent.value)),
    analyzeWithProviders: vi.fn().mockImplementation(() => Promise.resolve(analyzeResult.value)),
    sendDiscordAlert: vi.fn().mockImplementation((_wh: string, url: string, summary: string) => {
      alertsSent.push({ url, summary });
      return Promise.resolve();
    }),
    loadSiteState: vi.fn().mockImplementation(() => Promise.resolve(stateStore.state)),
    saveSiteState: vi.fn().mockImplementation((_id: string, s: MonitorState) => {
      stateStore.state = s;
      return Promise.resolve();
    }),
    closeScraperSession: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { deps, stateStore, alertsSent, scrapeContent, analyzeResult };
}

// ---------------------------------------------------------------------------
// 1. Baseline scenario: first run saves state, no alert
// ---------------------------------------------------------------------------
describe('E2E: first run saves baseline', () => {
  it('saves baseline and does not send an alert on first run', async () => {
    const config = makeFullConfig();
    const configStore = new ConfigStore(config);
    const { deps, stateStore, alertsSent } = makeDeps();
    const controller = new MonitorController(deps);
    const app = createApiApp(configStore, controller, () => {});

    const startRes = await request(app).post('/api/monitor/start').send({});
    expect(startRes.status).toBe(202);

    await new Promise((r) => setTimeout(r, 20));

    expect(stateStore.state).not.toBeNull();
    expect(stateStore.state?.url).toBe('https://e2e.example.com');
    expect(alertsSent).toHaveLength(0);

    await controller.stop();
  });
});

// ---------------------------------------------------------------------------
// 2. Same content → no LLM, no alert
// ---------------------------------------------------------------------------
describe('E2E: same content skips LLM', () => {
  it('does not call analyzeWithProviders when content is unchanged', async () => {
    const config = makeFullConfig();
    const configStore = new ConfigStore(config);
    const { deps, stateStore } = makeDeps();
    const controller = new MonitorController(deps);
    const app = createApiApp(configStore, controller, () => {});

    // Prime with existing state (same content as scrape will return)
    stateStore.state = {
      url: 'https://e2e.example.com',
      lastContent: 'initial page content',
      lastChecked: new Date().toISOString(),
    };

    await request(app).post('/api/monitor/start').send({});
    await new Promise((r) => setTimeout(r, 20));

    expect(deps.analyzeWithProviders).not.toHaveBeenCalled();
    await controller.stop();
  });
});

// ---------------------------------------------------------------------------
// 3. Changed content → LLM called → alert sent
// ---------------------------------------------------------------------------
describe('E2E: changed content triggers LLM and alert', () => {
  it('calls analyzeWithProviders and sends alert when content changes', async () => {
    const config = makeFullConfig();
    const configStore = new ConfigStore(config);
    const { deps, stateStore, alertsSent, scrapeContent, analyzeResult } = makeDeps();
    const controller = new MonitorController(deps);
    const app = createApiApp(configStore, controller, () => {});

    stateStore.state = {
      url: 'https://e2e.example.com',
      lastContent: 'old content',
      lastChecked: new Date().toISOString(),
    };
    scrapeContent.value = 'new content — product now in stock!';
    analyzeResult.value = { changed: true, summary: 'Product is now in stock.' };

    await request(app).post('/api/monitor/start').send({});
    await new Promise((r) => setTimeout(r, 20));

    expect(deps.analyzeWithProviders).toHaveBeenCalled();
    expect(alertsSent).toHaveLength(1);
    expect(alertsSent[0]?.summary).toBe('Product is now in stock.');

    await controller.stop();
  });

  it('status reflects the last result after a change', async () => {
    const config = makeFullConfig();
    const configStore = new ConfigStore(config);
    const { deps, stateStore, scrapeContent, analyzeResult } = makeDeps();
    const controller = new MonitorController(deps);
    const app = createApiApp(configStore, controller, () => {});

    stateStore.state = {
      url: 'https://e2e.example.com',
      lastContent: 'old content',
      lastChecked: new Date().toISOString(),
    };
    scrapeContent.value = 'new content';
    analyzeResult.value = { changed: true, summary: 'Big change detected.' };

    await request(app).post('/api/monitor/start').send({});
    await new Promise((r) => setTimeout(r, 20));

    const statusRes = await request(app).get('/api/monitor/status');
    expect(firstSite(statusRes.body).lastResult.changed).toBe(true);
    expect(firstSite(statusRes.body).lastResult.summary).toBe('Big change detected.');

    await controller.stop();
  });
});

// ---------------------------------------------------------------------------
// 4. LLM failover: Gemini fails → Groq succeeds
// ---------------------------------------------------------------------------
describe('E2E: Gemini fails, Groq takes over', () => {
  it('uses Groq result when Gemini throws', async () => {
    const config = makeFullConfig();
    const configStore = new ConfigStore(config);
    const { deps, stateStore, scrapeContent } = makeDeps();

    // Simulate Gemini fail / Groq succeed by overriding analyzeWithProviders
    vi.mocked(deps.analyzeWithProviders).mockResolvedValue({
      changed: true,
      summary: 'Groq detected the change.',
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      latencyMs: 800,
      fallback: false,
    });

    const controller = new MonitorController(deps);
    const app = createApiApp(configStore, controller, () => {});

    stateStore.state = {
      url: 'https://e2e.example.com',
      lastContent: 'old',
      lastChecked: new Date().toISOString(),
    };
    scrapeContent.value = 'changed content';

    await request(app).post('/api/monitor/start').send({});
    await new Promise((r) => setTimeout(r, 20));

    const statusRes = await request(app).get('/api/monitor/status');
    expect(firstSite(statusRes.body).lastResult.provider).toBe('groq');

    await controller.stop();
  });
});

// ---------------------------------------------------------------------------
// 5. All providers fail → local fallback, no crash
// ---------------------------------------------------------------------------
describe('E2E: all LLM providers fail → local fallback', () => {
  it('does not crash and marks fallback in status', async () => {
    const config = makeFullConfig();
    const configStore = new ConfigStore(config);
    const { deps, stateStore, scrapeContent } = makeDeps();

    vi.mocked(deps.analyzeWithProviders).mockResolvedValue({
      changed: true,
      summary: 'Local diff fallback result.',
      fallback: true,
      failureChain: [
        { provider: 'gemini', reason: 'quota' },
        { provider: 'groq', reason: 'timeout' },
      ],
    });

    const controller = new MonitorController(deps);
    const app = createApiApp(configStore, controller, () => {});

    stateStore.state = {
      url: 'https://e2e.example.com',
      lastContent: 'old',
      lastChecked: new Date().toISOString(),
    };
    scrapeContent.value = 'different content now';

    await request(app).post('/api/monitor/start').send({});
    await new Promise((r) => setTimeout(r, 20));

    const statusRes = await request(app).get('/api/monitor/status');
    expect(statusRes.status).toBe(200);
    expect(firstSite(statusRes.body).lastResult.fallback).toBe(true);

    await controller.stop();
  });
});

// ---------------------------------------------------------------------------
// 6. Long summary → chunked alerts
// ---------------------------------------------------------------------------
describe('E2E: long summary is chunked into multiple alerts', () => {
  it('sends multiple alert messages for summaries over 900 chars', async () => {
    const config = makeFullConfig();
    const configStore = new ConfigStore(config);
    const { deps, stateStore, alertsSent, scrapeContent } = makeDeps();

    const longSummary = 'X'.repeat(2500);
    vi.mocked(deps.analyzeWithProviders).mockResolvedValue({
      changed: true,
      summary: longSummary,
      fallback: false,
    });

    const controller = new MonitorController(deps);
    const app = createApiApp(configStore, controller, () => {});

    stateStore.state = {
      url: 'https://e2e.example.com',
      lastContent: 'old',
      lastChecked: new Date().toISOString(),
    };
    scrapeContent.value = 'changed';

    await request(app).post('/api/monitor/start').send({});
    await new Promise((r) => setTimeout(r, 30));

    // Should be split into 3+ chunks (2500 chars / 900 per chunk)
    expect(alertsSent.length).toBeGreaterThanOrEqual(3);

    await controller.stop();
  });
});

// ---------------------------------------------------------------------------
// 7. Stop idempotency
// ---------------------------------------------------------------------------
describe('E2E: stop is idempotent / double-stop returns 409', () => {
  it('returns 409 when stopping a monitor that is not running', async () => {
    const config = makeFullConfig();
    const configStore = new ConfigStore(config);
    const controller = new MonitorController(makeDeps().deps);
    const app = createApiApp(configStore, controller, () => {});

    const res = await request(app).post('/api/monitor/stop').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_RUNNING');
  });

  it('status shows running=false after stop', async () => {
    const config = makeFullConfig();
    const configStore = new ConfigStore(config);
    const controller = new MonitorController(makeDeps().deps);
    const app = createApiApp(configStore, controller, () => {});

    await request(app).post('/api/monitor/start').send({});
    await new Promise((r) => setTimeout(r, 10));
    await request(app).post('/api/monitor/stop').send({});

    const res = await request(app).get('/api/monitor/status');
    expect(res.body.data.running).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. Runtime config change takes effect (PUT /api/config)
// ---------------------------------------------------------------------------
describe('E2E: runtime config update', () => {
  it('reflects new target URL in status after PUT /api/config', async () => {
    const config = makeFullConfig();
    const configStore = new ConfigStore(config);
    const controller = new MonitorController(makeDeps().deps);
    const app = createApiApp(configStore, controller, () => {});

    await request(app)
      .put('/api/config')
      .send({ target: { url: 'https://updated.example.com' } });

    const statusRes = await request(app).get('/api/monitor/status');
    expect(firstSite(statusRes.body).url).toBe('https://updated.example.com');
  });
});

// ---------------------------------------------------------------------------
// 9. Error accumulation in status
// ---------------------------------------------------------------------------
describe('E2E: scrape errors appear in status.errors', () => {
  it('records scrape failure in status errors', async () => {
    const config = makeFullConfig();
    const configStore = new ConfigStore(config);
    const { deps } = makeDeps();

    // Make scrapePageText throw
    vi.mocked(deps.scrapePageText).mockRejectedValue(new Error('Navigation timeout'));

    const controller = new MonitorController(deps);
    const app = createApiApp(configStore, controller, () => {});

    await request(app).post('/api/monitor/start').send({});
    await new Promise((r) => setTimeout(r, 30));
    await controller.stop();

    const statusRes = await request(app).get('/api/monitor/status');
    expect(firstSite(statusRes.body).errors.length).toBeGreaterThan(0);
    const messages = (firstSite(statusRes.body).errors as Array<{ message: string }>).map((e) => e.message);
    expect(messages.some((m) => m.includes('Navigation timeout'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. Hermès deterministic diff path
// ---------------------------------------------------------------------------
describe('E2E: Hermès deterministic change detection', () => {
  const HERMES_URL = 'https://www.hermes.com/us/en/category/bags/';

  function makeHermesConfig() {
    return loadAppConfigLenient({
      targetUrl: HERMES_URL,
      discordWebhookUrl: 'https://discord.com/api/webhooks/hermes-test',
      llm: { gemini: { apiKey: 'gemini-key', enabled: true } },
    });
  }

  const oldProduct = 'Bag A | Black | Price $5,000 | SKU:H001 | Available | /us/en/product/bag-a/';
  const newProduct = 'Bag B | White | Price $6,000 | SKU:H002 | Available | /us/en/product/bag-b/';

  it('sends deterministic alert and does not call LLM when Hermès products change', async () => {
    const config = makeHermesConfig();
    const configStore = new ConfigStore(config);
    const { deps, stateStore, alertsSent, scrapeContent } = makeDeps();
    const registry = new PluginRegistry();
    registry.register(hermesPlugin);
    const controller = new MonitorController(deps, registry);
    const app = createApiApp(configStore, controller, () => {});

    stateStore.state = {
      url: HERMES_URL,
      lastContent: oldProduct,
      lastChecked: new Date().toISOString(),
      lastProducts: [{ name: 'Bag A', color: 'Black', price: 'Price $5,000', sku: 'H001', available: true, url: '/us/en/product/bag-a/' }],
    } as MonitorState;

    scrapeContent.value = newProduct;

    await request(app).post('/api/monitor/start').send({});
    await new Promise((r) => setTimeout(r, 30));
    await controller.stop();

    expect(deps.analyzeWithProviders).not.toHaveBeenCalled();
    expect(alertsSent.length).toBeGreaterThan(0);

    const statusRes = await request(app).get('/api/monitor/status');
    expect(firstSite(statusRes.body).lastResult.changed).toBe(true);
    expect(firstSite(statusRes.body).lastResult.provider).toBe('deterministic');
  });
});

// ---------------------------------------------------------------------------
// 11. Shutdown suppresses scrape-error alerts
// ---------------------------------------------------------------------------
describe('E2E: shutdown suppresses error alerts', () => {
  it('does not fire an error alert when a scrape is interrupted by stop()', async () => {
    const configStore = new ConfigStore(makeFullConfig());
    configStore.update({ schedule: { ...configStore.get().schedule, runOnce: true } });
    const { deps } = makeDeps();

    let rejectScrape: (e: Error) => void = () => {};
    deps.scrapePageText = vi.fn().mockReturnValue(
      new Promise<string>((_, reject) => { rejectScrape = reject; })
    );

    const errorAlerts: string[] = [];
    setAlertCallback((entry) => { if (entry.level === 'error') errorAlerts.push(entry.message); });

    const controller = new MonitorController(deps);
    const startPromise = controller.start(configStore); // awaits the hanging scrape

    await new Promise((r) => setTimeout(r, 20));
    await controller.stop();                            // shuttingDown = true
    rejectScrape(new Error('browser killed during shutdown'));
    await startPromise;

    setAlertCallback(null);
    expect(errorAlerts).toHaveLength(0);
  });

  it('still fires an error alert for a normal scrape failure', async () => {
    const configStore = new ConfigStore(makeFullConfig());
    configStore.update({ schedule: { ...configStore.get().schedule, runOnce: true } });
    const { deps } = makeDeps();
    deps.scrapePageText = vi.fn().mockRejectedValue(new Error('network down'));

    const errorAlerts: string[] = [];
    setAlertCallback((entry) => { if (entry.level === 'error') errorAlerts.push(entry.message); });

    const controller = new MonitorController(deps);
    await controller.start(configStore);

    setAlertCallback(null);
    expect(errorAlerts.some((m) => m.includes('network down'))).toBe(true);
  });
});
