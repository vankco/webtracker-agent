/**
 * Unit tests for state.ts and notifier.ts.
 * fs and fetch are mocked — no disk/network access.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// state.ts
// ---------------------------------------------------------------------------
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import * as fs from 'fs';
import { loadState, saveState } from '../state.js';
import type { MonitorState } from '../state.js';

const VALID_STATE: MonitorState = {
  url: 'https://example.com',
  lastContent: 'page content',
  lastChecked: '2025-01-01T00:00:00.000Z',
};

describe('loadState', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns null when state file does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(loadState()).toBeNull();
  });

  it('returns parsed MonitorState when file is valid JSON', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(VALID_STATE));
    const result = loadState();
    expect(result).toEqual(VALID_STATE);
  });

  it('returns null when file contains invalid JSON', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('not-valid-json{{{');
    expect(loadState()).toBeNull();
  });

  it('returns null when readFileSync throws', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('Permission denied');
    });
    expect(loadState()).toBeNull();
  });
});

describe('saveState', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('calls writeFileSync with pretty-printed JSON', () => {
    saveState(VALID_STATE);
    expect(fs.writeFileSync).toHaveBeenCalledOnce();
    const [, content] = vi.mocked(fs.writeFileSync).mock.calls[0] as [string, string, string];
    const parsed = JSON.parse(content) as MonitorState;
    expect(parsed.url).toBe(VALID_STATE.url);
    expect(parsed.lastContent).toBe(VALID_STATE.lastContent);
  });

  it('writes to a .json file path', () => {
    saveState(VALID_STATE);
    const [filePath] = vi.mocked(fs.writeFileSync).mock.calls[0] as [string, string, string];
    expect(filePath).toMatch(/\.json$/);
  });
});

// ---------------------------------------------------------------------------
// notifier.ts
// ---------------------------------------------------------------------------
const mockFetch = vi.fn();
global.fetch = mockFetch;

import { sendDiscordAlert } from '../notifier.js';

describe('sendDiscordAlert', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends a POST request to the webhook URL', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 204, statusText: 'No Content' });
    await sendDiscordAlert('https://discord.com/api/webhooks/test', 'https://site.com', 'Price changed');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/test',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('sends JSON body with embed fields', async () => {
    mockFetch.mockResolvedValue({ ok: true });
    await sendDiscordAlert('https://webhook', 'https://site.com', 'Summary text');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      embeds: Array<{ description?: string; fields: Array<{ name: string; value: string }> }>;
    };
    const embed = body.embeds[0];
    const fields = embed?.fields ?? [];
    // Summary now rendered as embed description (supports markdown)
    expect(embed?.description).toBe('Summary text');
    expect(fields.some((f) => f.value.includes('Available Bags'))).toBe(true);
  });

  it('throws when response is not ok', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => 'Missing access',
    });
    await expect(
      sendDiscordAlert('https://webhook', 'https://site.com', 'msg')
    ).rejects.toThrow('403');
  });

  it('truncates URL and summary longer than 1024 chars', async () => {
    mockFetch.mockResolvedValue({ ok: true });
    const longUrl = 'https://example.com/' + 'x'.repeat(1100);
    const longSummary = 'y'.repeat(1100);
    await sendDiscordAlert('https://webhook', longUrl, longSummary);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      embeds: Array<{ fields: Array<{ name: string; value: string }> }>;
    };
    const fields = body.embeds[0]?.fields ?? [];
    for (const field of fields) {
      expect(field.value.length).toBeLessThanOrEqual(1027); // 1024 + '...'
    }
  });
});
