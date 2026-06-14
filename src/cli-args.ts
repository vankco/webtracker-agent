import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseBooleanEnv, parseIntEnv } from './utils.js';
import type { JsonConfig } from './config.js';

// ---------------------------------------------------------------------------
// CLI argument parsing — the typed replacement for shell env vars.
//
// Operational (non-secret) settings are passed as CLI flags and parsed into a
// Partial<JsonConfig>. Secrets (API keys, Discord bot token, webhook URLs) get
// NO flags — they live in config.json / the UI only.
// ---------------------------------------------------------------------------

/** Thrown on an unknown flag or an unparseable value. Callers print + exit(2). */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

type OptType = 'bool' | 'int' | 'string';

type OptGroup = 'Core' | 'Schedule' | 'Discord' | 'Gemini' | 'Groq' | 'Claude' | 'Browser';

interface CliOption {
  flag: string; // '--apiPort'
  type: OptType;
  group: OptGroup;
  desc: string;
  valueHint?: string;
  /** Typed setter that writes the parsed value into the partial config. */
  apply: (cfg: Partial<JsonConfig>, value: string | number | boolean) => void;
}

/** Ensures cfg.llm.gemini exists and returns it. */
function gemini(cfg: Partial<JsonConfig>): NonNullable<NonNullable<JsonConfig['llm']>['gemini']> {
  cfg.llm ??= {};
  cfg.llm.gemini ??= {};
  return cfg.llm.gemini;
}

/** Ensures cfg.llm.groq exists and returns it. */
function groq(cfg: Partial<JsonConfig>): NonNullable<NonNullable<JsonConfig['llm']>['groq']> {
  cfg.llm ??= {};
  cfg.llm.groq ??= {};
  return cfg.llm.groq;
}

/** Ensures cfg.llm.claude exists and returns it. */
function claude(cfg: Partial<JsonConfig>): NonNullable<NonNullable<JsonConfig['llm']>['claude']> {
  cfg.llm ??= {};
  cfg.llm.claude ??= {};
  return cfg.llm.claude;
}

/** Ensures cfg.browser exists and returns it. */
function browser(cfg: Partial<JsonConfig>): NonNullable<JsonConfig['browser']> {
  cfg.browser ??= {};
  return cfg.browser;
}

// Declarative table — drives both parsing and --help.
const OPTIONS: CliOption[] = [
  // Core
  { flag: '--targetUrl', type: 'string', group: 'Core', desc: 'URL to monitor', valueHint: '<url>',
    apply: (c, v) => { c.targetUrl = v as string; } },
  { flag: '--targetSelector', type: 'string', group: 'Core', desc: 'CSS selector to extract (optional)', valueHint: '<css>',
    apply: (c, v) => { c.targetSelector = v as string; } },
  { flag: '--apiPort', type: 'int', group: 'Core', desc: 'REST API port (>0 enables API mode)', valueHint: '<n>',
    apply: (c, v) => { c.apiPort = v as number; } },
  { flag: '--plugins', type: 'string', group: 'Core', desc: 'Comma-separated plugin package names', valueHint: '<a,b>',
    apply: (c, v) => { c.plugins = String(v).split(',').map(s => s.trim()).filter(Boolean); } },

  // Schedule
  { flag: '--checkIntervalMs', type: 'int', group: 'Schedule', desc: 'Milliseconds between checks', valueHint: '<ms>',
    apply: (c, v) => { c.checkIntervalMs = v as number; } },
  { flag: '--runOnce', type: 'bool', group: 'Schedule', desc: 'Run a single check and exit',
    apply: (c, v) => { c.runOnce = v as boolean; } },

  // Discord (IDs only — token is a secret, config.json only)
  { flag: '--discordBotClientId', type: 'string', group: 'Discord', desc: 'Discord application client ID', valueHint: '<id>',
    apply: (c, v) => { c.discordBotClientId = v as string; } },
  { flag: '--discordBotGuildId', type: 'string', group: 'Discord', desc: 'Discord server (guild) ID', valueHint: '<id>',
    apply: (c, v) => { c.discordBotGuildId = v as string; } },

  // Gemini (apiKey is a secret, config.json only)
  { flag: '--geminiEnabled', type: 'bool', group: 'Gemini', desc: 'Enable the Gemini provider',
    apply: (c, v) => { gemini(c).enabled = v as boolean; } },
  { flag: '--geminiModel', type: 'string', group: 'Gemini', desc: 'Gemini model id', valueHint: '<model>',
    apply: (c, v) => { gemini(c).model = v as string; } },
  { flag: '--geminiPriority', type: 'int', group: 'Gemini', desc: 'Provider priority (lower = first)', valueHint: '<n>',
    apply: (c, v) => { gemini(c).priority = v as number; } },
  { flag: '--geminiTimeoutMs', type: 'int', group: 'Gemini', desc: 'Request timeout (ms)', valueHint: '<ms>',
    apply: (c, v) => { gemini(c).timeoutMs = v as number; } },
  { flag: '--geminiMaxRetries', type: 'int', group: 'Gemini', desc: 'Max retries on failure', valueHint: '<n>',
    apply: (c, v) => { gemini(c).maxRetries = v as number; } },

  // Groq (apiKey is a secret, config.json only)
  { flag: '--groqEnabled', type: 'bool', group: 'Groq', desc: 'Enable the Groq provider',
    apply: (c, v) => { groq(c).enabled = v as boolean; } },
  { flag: '--groqModel', type: 'string', group: 'Groq', desc: 'Groq model id', valueHint: '<model>',
    apply: (c, v) => { groq(c).model = v as string; } },
  { flag: '--groqPriority', type: 'int', group: 'Groq', desc: 'Provider priority (lower = first)', valueHint: '<n>',
    apply: (c, v) => { groq(c).priority = v as number; } },
  { flag: '--groqTimeoutMs', type: 'int', group: 'Groq', desc: 'Request timeout (ms)', valueHint: '<ms>',
    apply: (c, v) => { groq(c).timeoutMs = v as number; } },
  { flag: '--groqMaxRetries', type: 'int', group: 'Groq', desc: 'Max retries on failure', valueHint: '<n>',
    apply: (c, v) => { groq(c).maxRetries = v as number; } },

  // Claude (apiKey is a secret, config.json only)
  { flag: '--claudeEnabled', type: 'bool', group: 'Claude', desc: 'Enable the Claude (Anthropic) provider',
    apply: (c, v) => { claude(c).enabled = v as boolean; } },
  { flag: '--claudeModel', type: 'string', group: 'Claude', desc: 'Claude model id', valueHint: '<model>',
    apply: (c, v) => { claude(c).model = v as string; } },
  { flag: '--claudePriority', type: 'int', group: 'Claude', desc: 'Provider priority (lower = first)', valueHint: '<n>',
    apply: (c, v) => { claude(c).priority = v as number; } },
  { flag: '--claudeTimeoutMs', type: 'int', group: 'Claude', desc: 'Request timeout (ms)', valueHint: '<ms>',
    apply: (c, v) => { claude(c).timeoutMs = v as number; } },
  { flag: '--claudeMaxRetries', type: 'int', group: 'Claude', desc: 'Max retries on failure', valueHint: '<n>',
    apply: (c, v) => { claude(c).maxRetries = v as number; } },

  // Browser
  { flag: '--browserHeadless', type: 'bool', group: 'Browser', desc: 'Run browser headless (use =false for headed)',
    apply: (c, v) => { browser(c).headless = v as boolean; } },
  { flag: '--browserPersistSession', type: 'bool', group: 'Browser', desc: 'Reuse cookies/login between runs',
    apply: (c, v) => { browser(c).persistSession = v as boolean; } },
  { flag: '--browserUserDataDir', type: 'string', group: 'Browser', desc: 'Browser profile directory', valueHint: '<dir>',
    apply: (c, v) => { browser(c).userDataDir = v as string; } },
  { flag: '--browserGotoTimeoutMs', type: 'int', group: 'Browser', desc: 'Navigation timeout (ms)', valueHint: '<ms>',
    apply: (c, v) => { browser(c).gotoTimeoutMs = v as number; } },
  { flag: '--browserSlowMoMs', type: 'int', group: 'Browser', desc: 'Slow-motion delay between actions (ms)', valueHint: '<ms>',
    apply: (c, v) => { browser(c).slowMoMs = v as number; } },
  { flag: '--browserKeepOpenMs', type: 'int', group: 'Browser', desc: 'Keep browser open after scrape (ms)', valueHint: '<ms>',
    apply: (c, v) => { browser(c).keepOpenMs = v as number; } },
  { flag: '--manualAssisted', type: 'bool', group: 'Browser', desc: 'Pause for manual verification (forces headed)',
    apply: (c, v) => { browser(c).manualAssisted = v as boolean; } },
  { flag: '--manualAssistedInitialWaitMs', type: 'int', group: 'Browser', desc: 'Manual-assist fallback wait (ms)', valueHint: '<ms>',
    apply: (c, v) => { browser(c).manualAssistedInitialWaitMs = v as number; } },
];

// Fast lookup by flag name (e.g. '--apiPort').
const OPTION_BY_FLAG = new Map(OPTIONS.map(o => [o.flag, o]));

/** Coerces a raw CLI string into the option's typed value. Throws on bad ints. */
function coerce(opt: CliOption, raw: string): string | number | boolean {
  switch (opt.type) {
    case 'bool':
      return parseBooleanEnv(raw, true);
    case 'int': {
      const trimmed = raw.trim();
      if (trimmed === '' || Number.isNaN(Number(trimmed))) {
        throw new CliError(`Invalid integer for ${opt.flag}: "${raw}"`);
      }
      return parseIntEnv(raw, 0);
    }
    case 'string':
      return raw;
  }
}

export interface ParsedCli {
  config: Partial<JsonConfig>;
  help: boolean;
  version: boolean;
}

/**
 * Parses CLI arguments into a Partial<JsonConfig>.
 * Accepts: `--flag value`, `--flag=value`, bare bool `--flag` (=true),
 * `--flag=false`, and `--no-flag` (=false). Unknown flags or bad ints throw
 * CliError.
 */
export function parseCliArgs(argv: string[] = process.argv.slice(2)): ParsedCli {
  const config: Partial<JsonConfig> = {};
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === '--help' || arg === '-h') { help = true; continue; }
    if (arg === '--version' || arg === '-v') { version = true; continue; }

    if (!arg.startsWith('--')) {
      throw new CliError(`Unexpected argument: "${arg}"`);
    }

    // --no-flag form → boolean false
    if (arg.startsWith('--no-')) {
      const flag = `--${arg.slice('--no-'.length)}`;
      const opt = OPTION_BY_FLAG.get(flag);
      if (!opt) throw new CliError(`Unknown flag: ${arg}`);
      if (opt.type !== 'bool') throw new CliError(`${flag} is not a boolean flag`);
      opt.apply(config, false);
      continue;
    }

    // Split --flag=value
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);

    const opt = OPTION_BY_FLAG.get(flag);
    if (!opt) throw new CliError(`Unknown flag: ${flag}`);

    let raw: string;
    if (inlineValue !== undefined) {
      raw = inlineValue;
    } else if (opt.type === 'bool') {
      // bare bool → true (next token is NOT consumed as a value)
      raw = 'true';
    } else {
      // consume next token as the value
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new CliError(`Missing value for ${flag}`);
      }
      raw = next;
      i++;
    }

    opt.apply(config, coerce(opt, raw));
  }

  return { config, help, version };
}

/** Reads the app version from package.json (for --version). */
export function getVersion(): string {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(dir, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Builds the grouped, column-aligned --help text. */
export function formatHelp(): string {
  const lines: string[] = [];
  lines.push('Usage: tsx src/agent.ts [options]');
  lines.push('');

  const groupsOrder: OptGroup[] = ['Core', 'Schedule', 'Discord', 'Gemini', 'Groq', 'Claude', 'Browser'];

  // Column width across all flags (with value hints) for alignment.
  const flagCol = (o: CliOption) => `${o.flag}${o.valueHint ? ` ${o.valueHint}` : ''}`;
  const width = Math.max(...OPTIONS.map(o => flagCol(o).length));

  for (const group of groupsOrder) {
    const opts = OPTIONS.filter(o => o.group === group);
    if (opts.length === 0) continue;
    lines.push(`${group}:`);
    for (const o of opts) {
      lines.push(`  ${flagCol(o).padEnd(width)}  ${o.desc}`);
    }
    lines.push('');
  }

  lines.push('  --help, -h               Show this help');
  lines.push('  --version, -v            Show version');
  lines.push('');
  lines.push('Secrets are NOT flags — set geminiApiKey, groqApiKey, anthropicApiKey,');
  lines.push('discordBotToken, discordWebhookUrl and discordSystemWebhookUrl in config.json');
  lines.push('(or via the UI).');

  return lines.join('\n');
}
