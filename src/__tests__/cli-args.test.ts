import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseCliArgs, formatHelp, getVersion, CliError } from '../cli-args.js';
import { mergeConfig } from '../config.js';

describe('parseCliArgs — flag forms', () => {
  it('parses --flag value (space-separated)', () => {
    const { config } = parseCliArgs(['--apiPort', '3001']);
    expect(config.apiPort).toBe(3001);
  });

  it('parses --flag=value', () => {
    const { config } = parseCliArgs(['--apiPort=8080']);
    expect(config.apiPort).toBe(8080);
  });

  it('parses string flags', () => {
    const { config } = parseCliArgs(['--targetUrl', 'https://example.com']);
    expect(config.targetUrl).toBe('https://example.com');
  });

  it('treats a bare boolean flag as true', () => {
    const { config } = parseCliArgs(['--runOnce']);
    expect(config.runOnce).toBe(true);
  });

  it('parses --flag=false', () => {
    const { config } = parseCliArgs(['--browserHeadless=false']);
    expect(config.browser?.headless).toBe(false);
  });

  it('parses --no-flag as false', () => {
    const { config } = parseCliArgs(['--no-browserHeadless']);
    expect(config.browser?.headless).toBe(false);
  });

  it('does not consume the next token as a value for bare bools', () => {
    const { config } = parseCliArgs(['--runOnce', '--apiPort', '3001']);
    expect(config.runOnce).toBe(true);
    expect(config.apiPort).toBe(3001);
  });

  it('splits --plugins into a string array', () => {
    const { config } = parseCliArgs(['--plugins', '@webtracker/plugin-hermes, foo ']);
    expect(config.plugins).toEqual(['@webtracker/plugin-hermes', 'foo']);
  });

  it('routes nested gemini/groq/browser flags into typed paths', () => {
    const { config } = parseCliArgs([
      '--geminiModel', 'gemini-2.5-pro',
      '--geminiPriority', '1',
      '--groqEnabled',
      '--browserSlowMoMs', '250',
    ]);
    expect(config.llm?.gemini?.model).toBe('gemini-2.5-pro');
    expect(config.llm?.gemini?.priority).toBe(1);
    expect(config.llm?.groq?.enabled).toBe(true);
    expect(config.browser?.slowMoMs).toBe(250);
  });

  it('sets help / version flags', () => {
    expect(parseCliArgs(['--help']).help).toBe(true);
    expect(parseCliArgs(['-h']).help).toBe(true);
    expect(parseCliArgs(['--version']).version).toBe(true);
    expect(parseCliArgs(['-v']).version).toBe(true);
  });

  it('parses every flag into its typed config path', () => {
    const { config } = parseCliArgs([
      // Core
      '--targetUrl', 'https://x.com',
      '--targetSelector', '.grid',
      '--apiPort', '3001',
      '--plugins', 'a,b',
      // Schedule
      '--checkIntervalMs', '60000',
      '--runOnce',
      // Discord
      '--discordBotClientId', 'cid',
      '--discordBotGuildId', 'gid',
      // Gemini
      '--geminiEnabled',
      '--geminiModel', 'gemini-2.5-pro',
      '--geminiPriority', '1',
      '--geminiTimeoutMs', '15000',
      '--geminiMaxRetries', '2',
      // Groq
      '--groqEnabled',
      '--groqModel', 'llama-3.3-70b-versatile',
      '--groqPriority', '2',
      '--groqTimeoutMs', '20000',
      '--groqMaxRetries', '3',
      // Browser
      '--browserHeadless=false',
      '--browserPersistSession',
      '--browserUserDataDir', '.profile',
      '--browserGotoTimeoutMs', '45000',
      '--browserSlowMoMs', '250',
      '--browserKeepOpenMs', '5000',
      '--manualAssisted',
      '--manualAssistedInitialWaitMs', '120000',
    ]);

    expect(config).toEqual({
      targetUrl: 'https://x.com',
      targetSelector: '.grid',
      apiPort: 3001,
      plugins: ['a', 'b'],
      checkIntervalMs: 60000,
      runOnce: true,
      discordBotClientId: 'cid',
      discordBotGuildId: 'gid',
      llm: {
        gemini: { enabled: true, model: 'gemini-2.5-pro', priority: 1, timeoutMs: 15000, maxRetries: 2 },
        groq: { enabled: true, model: 'llama-3.3-70b-versatile', priority: 2, timeoutMs: 20000, maxRetries: 3 },
      },
      browser: {
        headless: false,
        persistSession: true,
        userDataDir: '.profile',
        gotoTimeoutMs: 45000,
        slowMoMs: 250,
        keepOpenMs: 5000,
        manualAssisted: true,
        manualAssistedInitialWaitMs: 120000,
      },
    });
  });
});

describe('parseCliArgs — errors', () => {
  it('throws CliError on an unknown flag', () => {
    expect(() => parseCliArgs(['--nope'])).toThrow(CliError);
  });

  it('throws CliError on a non-numeric int', () => {
    expect(() => parseCliArgs(['--apiPort', 'abc'])).toThrow(CliError);
  });

  it('throws CliError on a missing value', () => {
    expect(() => parseCliArgs(['--targetUrl'])).toThrow(CliError);
  });

  it('throws CliError on a bare positional argument', () => {
    expect(() => parseCliArgs(['foo'])).toThrow(CliError);
  });

  it('throws when --no- is applied to a non-boolean flag', () => {
    expect(() => parseCliArgs(['--no-apiPort'])).toThrow(CliError);
  });
});

describe('formatHelp', () => {
  const help = formatHelp();

  it('lists every option group', () => {
    for (const group of ['Core:', 'Schedule:', 'Discord:', 'Gemini:', 'Groq:', 'Browser:']) {
      expect(help).toContain(group);
    }
  });

  it('includes representative flags', () => {
    for (const flag of ['--apiPort', '--runOnce', '--geminiModel', '--browserHeadless', '--manualAssisted']) {
      expect(help).toContain(flag);
    }
  });

  it('documents --help and --version', () => {
    expect(help).toContain('--help');
    expect(help).toContain('--version');
  });

  it('notes that secrets live in config.json', () => {
    expect(help).toContain('config.json');
    expect(help).toMatch(/geminiApiKey|discordBotToken/);
  });
});

describe('getVersion', () => {
  it('matches package.json version', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, '..', '..', 'package.json'), 'utf-8'),
    ) as { version: string };
    expect(getVersion()).toBe(pkg.version);
  });
});

describe('mergeConfig — precedence & deep-merge', () => {
  it('CLI flags win over config.json (top-level)', () => {
    const merged = mergeConfig({ apiPort: 3001 }, { apiPort: 9999 });
    expect(merged.apiPort).toBe(9999);
  });

  it('keeps config.json values the CLI did not override', () => {
    const merged = mergeConfig({ targetUrl: 'https://a.com', apiPort: 3001 }, { apiPort: 9999 });
    expect(merged.targetUrl).toBe('https://a.com');
    expect(merged.apiPort).toBe(9999);
  });

  it('deep-merges browser so one CLI flag does not wipe siblings', () => {
    const merged = mergeConfig(
      { browser: { headless: true, userDataDir: '.profile' } },
      { browser: { headless: false } },
    );
    expect(merged.browser?.headless).toBe(false);
    expect(merged.browser?.userDataDir).toBe('.profile');
  });

  it('deep-merges llm.gemini so --geminiModel keeps the persisted apiKey', () => {
    const merged = mergeConfig(
      { llm: { gemini: { apiKey: 'secret', enabled: true } } },
      { llm: { gemini: { model: 'gemini-2.5-pro' } } },
    );
    expect(merged.llm?.gemini?.apiKey).toBe('secret');
    expect(merged.llm?.gemini?.enabled).toBe(true);
    expect(merged.llm?.gemini?.model).toBe('gemini-2.5-pro');
  });

  it('handles a null config.json (CLI-only)', () => {
    const merged = mergeConfig(null, { apiPort: 3001 });
    expect(merged.apiPort).toBe(3001);
  });
});
