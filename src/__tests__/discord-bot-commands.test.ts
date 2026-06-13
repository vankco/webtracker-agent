import { describe, it, expect } from 'vitest';
import {
  requiresAdmin,
  formatHelpReply,
  formatStatusReply,
  truncateReply,
  slashCommandDefinitions,
  COMMANDS,
} from '../discord-bot-commands.js';
import type { MonitorStatus } from '../api-types.js';

const baseStatus: MonitorStatus = {
  running: true,
  lastCheck: '2026-06-03T01:00:00.000Z',
  nextCheck: '2026-06-03T01:05:00.000Z',
  targetUrl: 'https://example.com',
  lastResult: { changed: false, summary: 'No change.', provider: 'gemini', fallback: false },
  errors: [],
  recentSnapshots: [],
};

describe('requiresAdmin', () => {
  it('returns true only for /status', () => {
    expect(requiresAdmin(COMMANDS.status)).toBe(true);
    expect(requiresAdmin(COMMANDS.ask)).toBe(false);
    expect(requiresAdmin(COMMANDS.help)).toBe(false);
    expect(requiresAdmin('unknown')).toBe(false);
  });
});

describe('slashCommandDefinitions', () => {
  it('defines help, status, and ask commands', () => {
    const defs = slashCommandDefinitions();
    const names = defs.map((d) => d.name);
    expect(names).toContain('help');
    expect(names).toContain('status');
    expect(names).toContain('ask');
  });

  it('ask command has a required question option', () => {
    const defs = slashCommandDefinitions();
    const ask = defs.find((d) => d.name === 'ask');
    expect(ask).toBeDefined();
    const opt = (ask as { options?: Array<{ name: string; required?: boolean }> }).options?.[0];
    expect(opt?.name).toBe('question');
    expect(opt?.required).toBe(true);
  });
});

describe('formatHelpReply', () => {
  it('mentions all commands', () => {
    const reply = formatHelpReply();
    expect(reply).toContain('/ask');
    expect(reply).toContain('/status');
    expect(reply).toContain('/help');
  });
});

describe('formatStatusReply', () => {
  it('shows running indicator and target URL', () => {
    const reply = formatStatusReply(baseStatus);
    expect(reply).toContain('running');
    expect(reply).toContain('https://example.com');
  });

  it('shows stopped when not running', () => {
    const reply = formatStatusReply({ ...baseStatus, running: false });
    expect(reply).toContain('stopped');
  });

  it('shows error count when errors present', () => {
    const status = {
      ...baseStatus,
      errors: [{ timestamp: '2026-06-03T00:00:00Z', message: 'oops' }],
    };
    const reply = formatStatusReply(status);
    expect(reply).toContain('error');
  });

  it('omits optional fields when missing', () => {
    const minimal: MonitorStatus = { running: false, errors: [], recentSnapshots: [] };
    const reply = formatStatusReply(minimal);
    expect(reply).toContain('stopped');
    expect(reply).not.toContain('undefined');
  });
});

describe('truncateReply', () => {
  it('returns text unchanged when under limit', () => {
    expect(truncateReply('hello')).toBe('hello');
  });

  it('truncates and appends marker when over limit', () => {
    const long = 'x'.repeat(2000);
    const result = truncateReply(long, 1900);
    expect(result.length).toBeLessThan(2000);
    expect(result).toContain('truncated');
  });
});
