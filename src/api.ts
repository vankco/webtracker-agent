/**
 * api.ts
 * Express REST API — Week 2 backend contract.
 *
 * All responses are wrapped in ApiSuccessResponse / ApiErrorResponse.
 * Secrets are never echoed back (SafeAppConfig / SafeLlmProviderConfig only).
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import {
  getSafeConfig,
  getEnabledProvidersByPriority,
  saveJsonConfig,
  KNOWN_PROVIDER_MODELS,
  type ConfigStore,
  type AppConfig,
  type LlmProviderConfig,
  type LlmProviderId,
} from './config.js';
import { MonitorController } from './monitor-controller.js';
import { getLogs, clearLogs } from './logger.js';
import { defaultLlmAnalyzer } from './llm.js';
import { getErrorMessage, recentHistory } from './utils.js';
import { scrapePageText } from './scraper.js';
import { loadState } from './state.js';
import { answerQuestion, buildAskPrompt } from './bot-qa.js';
import type {
  ApiSuccessResponse,
  ApiErrorResponse,
  PutConfigRequest,
  PutProvidersRequest,
  TestProviderRequest,
  TestProviderResponse,
  ValidateScrapeRequest,
  ValidateScrapeResponse,
  StartMonitorRequest,
  AskRequest,
} from './api-types.js';

// ---------------------------------------------------------------------------
// Error normalisation helpers
// ---------------------------------------------------------------------------

type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_CONFIGURED'
  | 'ALREADY_RUNNING'
  | 'NOT_RUNNING'
  | 'PROVIDER_NOT_FOUND'
  | 'TEST_FAILED'
  | 'SCRAPE_FAILED'
  | 'INTERNAL_ERROR';

function ok<T>(res: Response, data: T, status = 200): void {
  const body: ApiSuccessResponse<T> = { success: true, data };
  res.status(status).json(body);
}

function fail(
  res: Response,
  code: ErrorCode,
  message: string,
  status = 400,
  details?: unknown
): void {
  const body: ApiErrorResponse = {
    success: false,
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  };
  res.status(status).json(body);
}

// ---------------------------------------------------------------------------
// Dynamic model catalog — fetched from provider APIs, cached for 5 minutes
// Falls back to KNOWN_PROVIDER_MODELS if the key is missing or the call fails
// ---------------------------------------------------------------------------

import type { ModelEntry } from './api-types.js';

// Populated once at startup — never re-fetched until the process restarts
const modelCache = new Map<LlmProviderId, ModelEntry[]>();

// Build a lookup of known tier annotations for a provider
function tierMap(providerId: LlmProviderId): Map<string, 'free' | 'paid'> {
  return new Map(KNOWN_PROVIDER_MODELS[providerId].models.map((m) => [m.id, m.tier]));
}

// Merge live model ids with tier annotations; unknown models default to 'paid'
function toModelEntries(ids: string[], providerId: LlmProviderId): ModelEntry[] {
  const tiers = tierMap(providerId);
  return ids.map((id) => ({ id, tier: tiers.get(id) ?? 'paid' }));
}

async function fetchGeminiModels(apiKey: string): Promise<string[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
    { signal: AbortSignal.timeout(8_000) }
  );
  if (!res.ok) throw new Error(`Gemini models API ${res.status}`);
  const data = await res.json() as {
    models: Array<{ name: string; supportedGenerationMethods?: string[] }>;
  };
  return data.models
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => m.name.replace('models/', ''))
    .filter((id) => id.startsWith('gemini'))
    .sort();
}

async function fetchGroqModels(apiKey: string): Promise<string[]> {
  const res = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Groq models API ${res.status}`);
  const data = await res.json() as { data: Array<{ id: string }> };
  return data.data.map((m) => m.id).sort();
}

async function warmModelCache(config: AppConfig): Promise<void> {
  await Promise.all(
    (Object.keys(KNOWN_PROVIDER_MODELS) as LlmProviderId[]).map(async (id) => {
      const provider = config.llmProviders.find((p) => p.id === id);
      try {
        const ids = !provider?.apiKey
          ? KNOWN_PROVIDER_MODELS[id].models.map((m) => m.id)
          : id === 'gemini'
            ? await fetchGeminiModels(provider.apiKey)
            : await fetchGroqModels(provider.apiKey);
        modelCache.set(id, toModelEntries(ids, id));
      } catch {
        modelCache.set(id, KNOWN_PROVIDER_MODELS[id].models);
      }
    })
  );
  console.log('[api] Model catalog ready.');
}

// ---------------------------------------------------------------------------
// Router factory — injectable for testing
// ---------------------------------------------------------------------------

export function createApiRouter(
  configStore: ConfigStore,
  monitorController: MonitorController,
  persistConfig: (config: AppConfig) => void = saveJsonConfig,
  qaAnswerer: typeof answerQuestion = answerQuestion
): express.Router {
  const router = express.Router();

  // -------------------------------------------------------------------------
  // GET /api/config
  // -------------------------------------------------------------------------
  router.get('/config', (_req: Request, res: Response) => {
    ok(res, configStore.getSafe());
  });

  // -------------------------------------------------------------------------
  // PUT /api/config
  // -------------------------------------------------------------------------
  router.put('/config', (req: Request, res: Response) => {
    const body = req.body as PutConfigRequest;

    if (typeof body !== 'object' || body === null) {
      return fail(res, 'VALIDATION_ERROR', 'Request body must be a JSON object.');
    }

    // Build a typed partial update, skipping unknown / wrong-type fields
    const update: Partial<AppConfig> = {};

    if (body.target && typeof body.target === 'object') {
      const t: AppConfig['target'] = { ...configStore.get().target };
      if (typeof body.target.url === 'string') t.url = body.target.url;
      if (typeof body.target.selector === 'string') t.selector = body.target.selector;
      update.target = t;
    }

    if (body.schedule && typeof body.schedule === 'object') {
      const s = { ...configStore.get().schedule };
      if (typeof body.schedule.intervalMs === 'number' && body.schedule.intervalMs >= 1_000) {
        s.intervalMs = body.schedule.intervalMs;
      }
      if (typeof body.schedule.runOnce === 'boolean') s.runOnce = body.schedule.runOnce;
      update.schedule = s;
    }

    if (body.browser && typeof body.browser === 'object') {
      update.browser = { ...configStore.get().browser, ...body.browser };
    }

    if (body.notifications && typeof body.notifications === 'object') {
      const n = { ...configStore.get().notifications };
      if (typeof body.notifications.discordWebhookUrl === 'string') {
        n.discordWebhookUrl = body.notifications.discordWebhookUrl;
      }
      if (typeof body.notifications.discordSystemWebhookUrl === 'string') {
        n.discordSystemWebhookUrl = body.notifications.discordSystemWebhookUrl;
      }
      update.notifications = n;
    }

    if (Array.isArray(body.productWatchUrls)) {
      update.productWatchUrls = body.productWatchUrls
        .map((u) => String(u).trim())
        .filter(Boolean);
    }

    configStore.update(update);
    persistConfig(configStore.get());
    ok(res, configStore.getSafe());
  });

  // -------------------------------------------------------------------------
  // GET /api/llm/providers
  // -------------------------------------------------------------------------
  router.get('/llm/providers', (_req: Request, res: Response) => {
    ok(res, configStore.getSafe().llmProviders);
  });

  // -------------------------------------------------------------------------
  // PUT /api/llm/providers
  // -------------------------------------------------------------------------
  router.put('/llm/providers', (req: Request, res: Response) => {
    const body = req.body as PutProvidersRequest;

    if (!Array.isArray(body?.providers)) {
      return fail(res, 'VALIDATION_ERROR', '`providers` must be an array.');
    }

    const VALID_IDS: LlmProviderId[] = ['gemini', 'groq'];

    for (const p of body.providers) {
      if (!VALID_IDS.includes(p.id as LlmProviderId)) {
        return fail(res, 'PROVIDER_NOT_FOUND', `Unknown provider id '${String(p.id)}'.`);
      }
    }

    // Build a provider-list update: merge each incoming entry into the store
    const currentProviders = configStore.get().llmProviders;
    const providerMap = new Map<LlmProviderId, LlmProviderConfig>(
      currentProviders.map((p) => [p.id, { ...p }])
    );

    for (const incoming of body.providers) {
      const id = incoming.id as LlmProviderId;
      const existing = providerMap.get(id);
      if (!existing) continue; // shouldn't happen after validation above

      if (typeof incoming.enabled === 'boolean') existing.enabled = incoming.enabled;
      if (typeof incoming.priority === 'number') existing.priority = Math.max(1, incoming.priority);
      if (typeof incoming.model === 'string' && incoming.model.trim()) {
        existing.model = incoming.model.trim();
      }
      if (typeof incoming.apiKey === 'string' && incoming.apiKey.trim()) {
        existing.apiKey = incoming.apiKey.trim();
      }
      if (typeof incoming.timeoutMs === 'number' && incoming.timeoutMs >= 1_000) {
        existing.timeoutMs = incoming.timeoutMs;
      }
      if (typeof incoming.maxRetries === 'number' && incoming.maxRetries >= 0) {
        existing.maxRetries = incoming.maxRetries;
      }
      providerMap.set(id, existing);
    }

    configStore.update({ llmProviders: Array.from(providerMap.values()) });
    persistConfig(configStore.get());
    ok(res, configStore.getSafe().llmProviders);
  });

  // -------------------------------------------------------------------------
  // POST /api/llm/providers/test
  // -------------------------------------------------------------------------
  router.post('/llm/providers/test', async (req: Request, res: Response) => {
    const body = req.body as TestProviderRequest;

    if (!body?.providerId) {
      return fail(res, 'VALIDATION_ERROR', '`providerId` is required.');
    }

    const provider = configStore
      .get()
      .llmProviders.find((p) => p.id === body.providerId);

    if (!provider) {
      return fail(res, 'PROVIDER_NOT_FOUND', `Provider '${body.providerId}' not found.`);
    }
    if (!provider.apiKey) {
      return fail(
        res,
        'VALIDATION_ERROR',
        `Provider '${body.providerId}' has no API key configured.`
      );
    }

    const url = body.url ?? 'https://example.com';
    const sampleOld = body.sampleOld ?? 'Hello world.';
    const sampleNew = body.sampleNew ?? 'Hello world! New paragraph added.';

    const start = Date.now();
    try {
      const result = await defaultLlmAnalyzer.analyze(url, sampleOld, sampleNew, provider);
      const response: TestProviderResponse = {
        providerId: body.providerId,
        model: provider.model,
        success: true,
        latencyMs: Date.now() - start,
        result,
      };
      ok(res, response);
    } catch (err) {
      const message = getErrorMessage(err);
      const response: TestProviderResponse = {
        providerId: body.providerId,
        model: provider.model,
        success: false,
        latencyMs: Date.now() - start,
        error: message,
      };
      // Return 200 with success:false so the UI can show the error inline
      ok(res, response);
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/llm/providers/models
  // -------------------------------------------------------------------------
  router.get('/llm/providers/models', (_req: Request, res: Response) => {
    const catalog = (Object.keys(KNOWN_PROVIDER_MODELS) as LlmProviderId[]).map((id) => ({
      providerId: id,
      models: modelCache.get(id) ?? KNOWN_PROVIDER_MODELS[id].models,
      defaultModel: KNOWN_PROVIDER_MODELS[id].default,
    }));
    ok(res, catalog);
  });

  // -------------------------------------------------------------------------
  // POST /api/monitor/start
  // -------------------------------------------------------------------------
  router.post('/monitor/start', async (req: Request, res: Response) => {
    const body = req.body as StartMonitorRequest | undefined;

    // Allow caller to override runOnce for this session
    if (typeof body?.runOnce === 'boolean') {
      configStore.update({ schedule: { ...configStore.get().schedule, runOnce: body.runOnce } });
    }

    const errors = configStore.validate();
    if (errors.length > 0) {
      return fail(res, 'NOT_CONFIGURED', 'Cannot start monitor — configuration is incomplete.', 422, errors);
    }

    if (monitorController.isRunning()) {
      return fail(res, 'ALREADY_RUNNING', 'Monitor is already running.', 409);
    }

    try {
      // start() is async but we return immediately; the loop runs in background
      void monitorController.start(configStore).catch((err: unknown) => {
        console.error('[api] Monitor loop error:', err);
      });
      ok(res, { started: true, message: 'Monitor started.' }, 202);
    } catch (err) {
      const message = getErrorMessage(err);
      fail(res, 'INTERNAL_ERROR', message, 500);
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/monitor/stop
  // -------------------------------------------------------------------------
  router.post('/monitor/stop', async (_req: Request, res: Response) => {
    if (!monitorController.isRunning()) {
      return fail(res, 'NOT_RUNNING', 'Monitor is not currently running.', 409);
    }

    try {
      await monitorController.stop();
      ok(res, { stopped: true, message: 'Monitor stopped.' });
    } catch (err) {
      const message = getErrorMessage(err);
      fail(res, 'INTERNAL_ERROR', message, 500);
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/monitor/status
  // -------------------------------------------------------------------------
  router.get('/monitor/status', (_req: Request, res: Response) => {
    ok(res, monitorController.getStatus(configStore));
  });

  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // GET /api/logs
  // -------------------------------------------------------------------------
  router.get('/logs', (_req: Request, res: Response) => {
    ok(res, getLogs());
  });

  // -------------------------------------------------------------------------
  // DELETE /api/logs
  // -------------------------------------------------------------------------
  router.delete('/logs', (_req: Request, res: Response) => {
    clearLogs();
    ok(res, { cleared: true });
  });

  // -------------------------------------------------------------------------
  // POST /api/ask
  // -------------------------------------------------------------------------
  router.post('/ask', async (req: Request, res: Response) => {
    const body = req.body as AskRequest;

    if (typeof body?.question !== 'string' || !body.question.trim()) {
      return fail(res, 'VALIDATION_ERROR', '`question` is required.');
    }

    const config = configStore.get();
    const url = config.target.url;

    if (!url) {
      return fail(res, 'NOT_CONFIGURED', 'No target URL configured.', 422);
    }

    const providers = getEnabledProvidersByPriority(config);
    if (providers.length === 0) {
      return fail(res, 'NOT_CONFIGURED', 'No LLM providers enabled.', 422);
    }

    const state = loadState();
    const plugin = monitorController.findPlugin(url);

    const currentProductsText =
      plugin && state?.lastProducts ? plugin.productsToText(state.lastProducts) : '';
    const historyText =
      plugin?.formatHistoryForPrediction && state?.history
        ? plugin.formatHistoryForPrediction(recentHistory(state.history))
        : '';

    try {
      const prompt = buildAskPrompt(url, currentProductsText, historyText, body.question.trim());
      const answer = await qaAnswerer(prompt, providers);
      ok(res, { answer });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      fail(res, 'INTERNAL_ERROR', message, 502);
    }
  });

  // POST /api/validate/scrape
  // -------------------------------------------------------------------------
  router.post('/validate/scrape', async (req: Request, res: Response) => {
    const body = req.body as ValidateScrapeRequest;

    if (typeof body?.url !== 'string' || !body.url.trim()) {
      return fail(res, 'VALIDATION_ERROR', '`url` is required.');
    }

    const start = Date.now();
    try {
      const text = await scrapePageText(
        body.url.trim(),
        body.selector?.trim(),
        configStore.get().browser
      );
      const response: ValidateScrapeResponse = {
        success: true,
        contentLength: text.length,
        snippet: text.slice(0, 500),
        latencyMs: Date.now() - start,
      };
      ok(res, response);
    } catch (err) {
      const message = getErrorMessage(err);
      const response: ValidateScrapeResponse = {
        success: false,
        error: message,
        latencyMs: Date.now() - start,
      };
      fail(res, 'SCRAPE_FAILED', message, 422, response);
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

export function createApiApp(
  configStore: ConfigStore,
  monitorController: MonitorController,
  persistConfig: (config: AppConfig) => void = saveJsonConfig,
  qaAnswerer: typeof answerQuestion = answerQuestion
): express.Application {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Fetch model lists from provider APIs once at startup (fire-and-forget)
  void warmModelCache(configStore.get());

  // Mount all routes under /api
  app.use('/api', createApiRouter(configStore, monitorController, persistConfig, qaAnswerer));

  // 404 handler for unmatched /api routes
  app.use('/api', (_req: Request, res: Response) => {
    fail(res, 'INTERNAL_ERROR', 'Route not found.', 404);
  });

  // Global error handler
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : 'Unexpected server error.';
    console.error('[api] Unhandled error:', err);
    fail(res, 'INTERNAL_ERROR', message, 500);
  });

  return app;
}

export function startApiServer(
  configStore: ConfigStore,
  monitorController: MonitorController,
  port: number
): void {
  const app = createApiApp(configStore, monitorController);
  app.listen(port, () => {
    console.log(`[api] Server listening on http://localhost:${port}/api`);
  });
}
