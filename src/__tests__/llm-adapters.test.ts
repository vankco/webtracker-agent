/**
 * Unit tests for the LLM adapter layer in llm.ts.
 * Both the Groq adapter and the Gemini adapter path are covered here.
 * External SDKs are mocked — no network calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles so they're available inside vi.mock factory (which is hoisted)
// ---------------------------------------------------------------------------
const { mockGroqCreate } = vi.hoisted(() => ({
  mockGroqCreate: vi.fn(),
}));

vi.mock('groq-sdk', () => ({
  default: class MockGroq {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_opts: any) {}
    chat = {
      completions: {
        create: mockGroqCreate,
      },
    };
  },
}));

// Mock analyzeChanges (the Gemini API call) to avoid real network calls
vi.mock('../analyzer.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../analyzer.js')>();
  return {
    ...original,
    analyzeChanges: vi.fn().mockResolvedValue({
      changed: false,
      summary: 'Mock Gemini: no change.',
    }),
  };
});

import { defaultLlmAnalyzer, analyzeWithProviders } from '../llm.js';
import { analyzeChanges } from '../analyzer.js';
import type { LlmProviderConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeProvider(
  id: 'gemini' | 'groq',
  overrides: Partial<LlmProviderConfig> = {}
): LlmProviderConfig {
  return {
    id,
    enabled: true,
    priority: 1,
    model: id === 'gemini' ? 'gemini-2.5-flash' : 'llama-3.3-70b-versatile',
    apiKey: 'test-key',
    timeoutMs: 5_000,
    maxRetries: 0,
    ...overrides,
  };
}

function groqResponse(content: string) {
  return { choices: [{ message: { content } }] };
}

// ---------------------------------------------------------------------------
// defaultLlmAnalyzer.analyze — Gemini path
// ---------------------------------------------------------------------------
describe('defaultLlmAnalyzer — Gemini path', () => {
  beforeEach(() => {
    vi.mocked(analyzeChanges).mockResolvedValue({
      changed: false,
      summary: 'Mock Gemini: no change.',
    });
  });

  it('calls analyzeChanges with correct args for gemini provider', async () => {
    const provider = makeProvider('gemini');
    await defaultLlmAnalyzer.analyze('https://site.com', 'old', 'new', provider);
    expect(analyzeChanges).toHaveBeenCalledWith(
      'https://site.com',
      'old',
      'new',
      'test-key',
      'gemini-2.5-flash'
    );
  });

  it('throws when gemini provider has no API key', async () => {
    const provider = makeProvider('gemini', { apiKey: undefined });
    await expect(
      defaultLlmAnalyzer.analyze('https://site.com', 'old', 'new', provider)
    ).rejects.toThrow('API key');
  });

  it('returns result from analyzeChanges', async () => {
    vi.mocked(analyzeChanges).mockResolvedValue({
      changed: true,
      summary: 'New product section added.',
    });
    const result = await defaultLlmAnalyzer.analyze(
      'https://site.com',
      'old',
      'new',
      makeProvider('gemini')
    );
    expect(result.changed).toBe(true);
    expect(result.summary).toBe('New product section added.');
  });
});

// ---------------------------------------------------------------------------
// defaultLlmAnalyzer.analyze — Groq path
// ---------------------------------------------------------------------------
describe('defaultLlmAnalyzer — Groq path', () => {
  beforeEach(() => {
    mockGroqCreate.mockReset();
  });

  it('returns parsed JSON from Groq response', async () => {
    mockGroqCreate.mockResolvedValue(
      groqResponse('{"changed": true, "summary": "Price dropped."}')
    );
    const result = await defaultLlmAnalyzer.analyze(
      'https://shop.com',
      'Price: $99',
      'Price: $79',
      makeProvider('groq')
    );
    expect(result.changed).toBe(true);
    expect(result.summary).toBe('Price dropped.');
  });

  it('strips markdown fences from Groq response', async () => {
    mockGroqCreate.mockResolvedValue(
      groqResponse('```json\n{"changed": false, "summary": "No change."}\n```')
    );
    const result = await defaultLlmAnalyzer.analyze(
      'https://site.com',
      'same',
      'same',
      makeProvider('groq')
    );
    expect(result.changed).toBe(false);
  });

  it('throws when Groq provider has no API key', async () => {
    const provider = makeProvider('groq', { apiKey: undefined });
    await expect(
      defaultLlmAnalyzer.analyze('https://site.com', 'old', 'new', provider)
    ).rejects.toThrow('API key');
  });

  it('throws when Groq returns empty content', async () => {
    mockGroqCreate.mockResolvedValue(groqResponse(''));
    await expect(
      defaultLlmAnalyzer.analyze('https://site.com', 'old', 'new', makeProvider('groq'))
    ).rejects.toThrow('Empty Groq response');
  });

  it('throws for unknown provider id', async () => {
    const unknownProvider = makeProvider('gemini');
    unknownProvider.id = 'openai' as 'gemini';
    await expect(
      defaultLlmAnalyzer.analyze('https://site.com', 'old', 'new', unknownProvider)
    ).rejects.toThrow('not implemented');
  });
});

// ---------------------------------------------------------------------------
// analyzeWithProviders — using the real defaultLlmAnalyzer (Groq path)
// ---------------------------------------------------------------------------
describe('analyzeWithProviders with real defaultLlmAnalyzer', () => {
  beforeEach(() => {
    mockGroqCreate.mockReset();
  });

  it('returns provider metadata when Groq succeeds', async () => {
    mockGroqCreate.mockResolvedValue(
      groqResponse('{"changed": false, "summary": "All quiet."}')
    );
    const result = await analyzeWithProviders(
      'https://site.com',
      'old content',
      'new content',
      [makeProvider('groq')]
    );
    expect(result.provider).toBe('groq');
    expect(result.fallback).toBe(false);
    expect(result.changed).toBe(false);
  });

  it('falls back to local diff when Groq returns unparseable JSON', async () => {
    mockGroqCreate.mockResolvedValue(groqResponse('NOT_VALID_JSON'));
    const result = await analyzeWithProviders(
      'https://site.com',
      'old content here today',
      'completely new content here today',
      [makeProvider('groq')]
    );
    expect(result.fallback).toBe(true);
    expect(result.failureChain).toHaveLength(1);
  });
});
