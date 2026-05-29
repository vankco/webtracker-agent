import 'dotenv/config';
import {
  loadAppConfig,
  loadAppConfigLenient,
  ConfigStore,
  getEnabledProvidersByPriority,
  type LlmProviderConfig,
} from './config.js';
import { MonitorController } from './monitor-controller.js';
import { startApiServer } from './api.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseIntEnv(value: string | undefined, defaultValue: number): number {
  if (value == null || value.trim() === '') return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const apiPortRaw = process.env['API_PORT'];
  const apiPort = apiPortRaw ? parseIntEnv(apiPortRaw, 0) : 0;
  const apiMode = apiPort > 0;

  if (apiMode) {
    // -------------------------------------------------------------------
    // API-server mode:
    //   1. Load config leniently (missing TARGET_URL / Discord URL are OK).
    //   2. Start the Express API server — UI/operator configures via REST.
    //   3. Do NOT auto-start the monitor loop; POST /api/monitor/start does it.
    // -------------------------------------------------------------------
    const initial = loadAppConfigLenient(process.env);
    const configStore = new ConfigStore(initial);
    const monitorController = new MonitorController();

    const enabledProviders = getEnabledProvidersByPriority(initial);
    if (enabledProviders.length > 0) {
      console.log(
        `[agent] LLM providers (from env): ${enabledProviders.map((p: LlmProviderConfig) => `${p.id}:${p.model}`).join(', ')}`
      );
    } else {
      console.log('[agent] No LLM providers configured from env — configure via API.');
    }

    startApiServer(configStore, monitorController, apiPort);

    // Keep process alive — the API server's socket does this, but also
    // register graceful shutdown handlers.
    registerSignalHandlers(monitorController);
  } else {
    // -------------------------------------------------------------------
    // Classic CLI mode (backward-compatible):
    //   Strict config load → immediate monitor loop.
    // -------------------------------------------------------------------
    const config = loadAppConfig(process.env);
    const enabledProviders = getEnabledProvidersByPriority(config)
      .map((p: LlmProviderConfig) => `${p.id}:${p.model}`)
      .join(', ');
    console.log(`[agent] LLM providers by priority: ${enabledProviders}`);

    const configStore = new ConfigStore(config);
    const monitorController = new MonitorController();

    registerSignalHandlers(monitorController);
    await monitorController.start(configStore);
  }
}

function registerSignalHandlers(monitorController: MonitorController): void {
  let shuttingDown = false;

  const onSignal = (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[agent] Shutting down (${reason})…`);
    void monitorController.stop().finally(() => process.exit(0));
  };

  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('[agent] Fatal error:', err);
  process.exitCode = 1;
});
