import {
  loadAppConfig,
  loadAppConfigLenient,
  mergeConfig,
  readJsonConfig,
  ConfigStore,
  getEnabledProvidersByPriority,
  type LlmProviderConfig,
} from './config.js';
import { parseCliArgs, formatHelp, getVersion, CliError } from './cli-args.js';
import { MonitorController } from './monitor-controller.js';
import { startApiServer } from './api.js';
import { loadPlugins } from './plugin-registry.js';
import { setAlertCallback } from './logger.js';
import { sendDiscordAlert } from './notifier.js';
import type { LogEntry } from './logger.js';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function registerDiscordAlerts(getWebhookUrl: () => string): void {
  setAlertCallback((entry: LogEntry) => {
    const url = getWebhookUrl();
    if (!url) return;
    const emoji = entry.level === 'error' ? '🔴' : '⚠️';
    const details = entry.details ? ` | ${JSON.stringify(entry.details)}` : '';
    const message = `${emoji} **[${entry.level.toUpperCase()}]** [${entry.category}] ${entry.message}${details}`;
    const title = entry.level === 'error' ? '🔴 System Error' : '⚠️ System Warning';
    sendDiscordAlert(url, '', message, title).catch(() => {});
  });
  console.log('[agent] Discord alerts enabled for warn/error log entries.');
}

async function main(): Promise<void> {
  const { config: cli, help, version } = parseCliArgs();
  if (help)    { console.log(formatHelp()); return; }
  if (version) { console.log(getVersion()); return; }

  const merged = mergeConfig(readJsonConfig(), cli);
  const apiPort = merged.apiPort ?? 0;
  const apiMode = apiPort > 0;

  if (apiMode) {
    // -------------------------------------------------------------------
    // API-server mode:
    //   1. Load config leniently (missing targetUrl / Discord URL are OK).
    //   2. Start the Express API server — UI/operator configures via REST.
    //   3. Do NOT auto-start the monitor loop; POST /api/monitor/start does it.
    // -------------------------------------------------------------------
    const initial = loadAppConfigLenient(merged);
    const configStore = new ConfigStore(initial);
    const registry = await loadPlugins(initial.plugins);
    const monitorController = new MonitorController({}, registry);

    const enabledProviders = getEnabledProvidersByPriority(initial);
    if (enabledProviders.length > 0) {
      console.log(
        `[agent] LLM providers: ${enabledProviders.map((p: LlmProviderConfig) => `${p.id}:${p.model}`).join(', ')}`
      );
    } else {
      console.log('[agent] No LLM providers configured — configure via config.json or the UI.');
    }

    startApiServer(configStore, monitorController, apiPort);
    registerSignalHandlers(monitorController);
    registerDiscordAlerts(() => configStore.get().notifications.discordSystemWebhookUrl);

    // Auto-start the monitor if config is already valid (target URL + credentials set)
    const validationErrors = configStore.validate();
    if (validationErrors.length === 0) {
      console.log('[agent] Config is valid — auto-starting monitor.');
      monitorController.start(configStore).catch((err: unknown) => {
        console.error('[agent] Auto-start failed:', err);
      });
    } else {
      console.log('[agent] Monitor not auto-started — configure via UI first.');
    }
  } else {
    // -------------------------------------------------------------------
    // CLI mode (no --apiPort): strict config load → immediate monitor loop.
    // -------------------------------------------------------------------
    const config = loadAppConfig(merged);
    const enabledProviders = getEnabledProvidersByPriority(config)
      .map((p: LlmProviderConfig) => `${p.id}:${p.model}`)
      .join(', ');
    console.log(`[agent] LLM providers by priority: ${enabledProviders}`);

    const configStore = new ConfigStore(config);
    const registry = await loadPlugins(config.plugins);
    const monitorController = new MonitorController({}, registry);

    registerSignalHandlers(monitorController);
    registerDiscordAlerts(() => configStore.get().notifications.discordSystemWebhookUrl);
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
  if (err instanceof CliError) {
    console.error(err.message);
    console.error('Run with --help to see available flags.');
    process.exit(2);
  }
  console.error('[agent] Fatal error:', err);
  process.exitCode = 1;
});
