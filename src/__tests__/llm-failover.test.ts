/**
 * Unit + integration tests: LLM failover orchestration.
 *
 * All tests use injected mock analyzers — no real network calls.
 */

import { describe, it, expect, vi } from 'vitest';
import { analyzeWithProviders, type LlmAnalyzer } from '../llm.js';
import type { LlmProviderConfig } from '../config.js';
import type { AnalysisResult } from '../analyzer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(
  id: 'gemini' | 'groq',
  priority = 1,
  apiKey = 'key'
): LlmProviderConfig {
  return {
    id,
    enabled: true,
    priority,
    model: id === 'gemini' ? 'gemini-2.5-flash' : 'llama-3.3-70b-versatile',
    apiKey,
    timeoutMs: 5_000,
    maxRetries: 0,
  };
}

const SUCCESS_RESULT: AnalysisResult = {
  changed: true,
  summary: 'New section added.',
};

const NO_CHANGE_RESULT: AnalysisResult = {
  changed: false,
  summary: 'No meaningful changes.',
};

// ---------------------------------------------------------------------------
// Happy-path: first provider succeeds
// ---------------------------------------------------------------------------

describe('analyzeWithProviders — single provider succeeds', () => {
  it('returns result from the first provider with metadata', async () => {
    const mockAnalyzer: LlmAnalyzer = {
      analyze: vi.fn().mockResolvedValue(SUCCESS_RESULT),
    };

    const providers = [makeProvider('gemini', 1)];
    const result = await analyzeWithProviders('https://e.com', 'old', 'new content here', providers, mockAnalyzer);

    expect(result.changed).toBe(true);
    expect(result.summary).toBe('New section added.');
    expect(result.provider).toBe('gemini');
    expect(result.model).toBe('gemini-2.5-flash');
    expect(result.fallback).toBe(false);
    expect(typeof result.latencyMs).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Failover: first fails, second succeeds
// ---------------------------------------------------------------------------

describe('analyzeWithProviders — failover to second provider', () => {
  it('skips failed provider and uses the next one', async () => {
    const mockAnalyzer: LlmAnalyzer = {
      analyze: vi
        .fn()
        .mockRejectedValueOnce(new Error('Gemini quota exceeded'))
        .mockResolvedValueOnce(NO_CHANGE_RESULT),
    };

    const providers = [makeProvider('gemini', 1), makeProvider('groq', 2)];
    const result = await analyzeWithProviders('https://e.com', 'old', 'new', providers, mockAnalyzer);

    expect(result.changed).toBe(false);
    expect(result.provider).toBe('groq');
    expect(result.fallback).toBe(false);
    // First call should have been attempted
    expect(mockAnalyzer.analyze).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Full fallback: all providers fail → local diff
// ---------------------------------------------------------------------------

describe('analyzeWithProviders — all providers fail → local fallback', () => {
  it('never throws; always returns local diff analysis', async () => {
    const mockAnalyzer: LlmAnalyzer = {
      analyze: vi
        .fn()
        .mockRejectedValue(new Error('Network unavailable')),
    };

    const providers = [makeProvider('gemini', 1), makeProvider('groq', 2)];
    // Content with a meaningful difference so the local diff produces changed=true
    const oldContent = 'The product is in stock. Price: $10.';
    const newContent = 'The product is OUT OF STOCK. Price: $15.';

    const result = await analyzeWithProviders('https://e.com', oldContent, newContent, providers, mockAnalyzer);

    expect(result.fallback).toBe(true);
    expect(result.failureChain).toHaveLength(2);
    expect(result.failureChain?.[0]?.provider).toBe('gemini');
    expect(result.failureChain?.[1]?.provider).toBe('groq');
    // Local fallback should detect the meaningful change
    expect(result.changed).toBe(true);
    expect(result.provider).toBeUndefined();
  });

  it('returns changed=false via local fallback when content is identical', async () => {
    const mockAnalyzer: LlmAnalyzer = {
      analyze: vi.fn().mockRejectedValue(new Error('fail')),
    };

    const providers = [makeProvider('gemini', 1)];
    const same = 'Unchanged content.';

    const result = await analyzeWithProviders('https://e.com', same, same, providers, mockAnalyzer);

    expect(result.fallback).toBe(true);
    expect(result.changed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Empty provider list → immediate local fallback
// ---------------------------------------------------------------------------

describe('analyzeWithProviders — empty provider list', () => {
  it('goes straight to local diff without calling the analyzer', async () => {
    const mockAnalyzer: LlmAnalyzer = {
      analyze: vi.fn(),
    };

    const result = await analyzeWithProviders('https://e.com', 'a', 'b different', [], mockAnalyzer);

    expect(mockAnalyzer.analyze).not.toHaveBeenCalled();
    expect(result.fallback).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// E2E scenario: Gemini fails → Groq succeeds
// ---------------------------------------------------------------------------

describe('E2E scenario: Gemini fails, Groq succeeds', () => {
  it('delivers Groq result with correct provider metadata', async () => {
    const groqResult: AnalysisResult = {
      changed: true,
      summary: 'Price dropped from $99 to $79.',
    };

    const mockAnalyzer: LlmAnalyzer = {
      analyze: vi
        .fn()
        .mockImplementation(async (_url, _old, _new, provider: LlmProviderConfig) => {
          if (provider.id === 'gemini') throw new Error('503 Service Unavailable');
          return groqResult;
        }),
    };

    const providers = [makeProvider('gemini', 1), makeProvider('groq', 2)];
    const result = await analyzeWithProviders(
      'https://shop.example.com',
      'Price: $99',
      'Price: $79',
      providers,
      mockAnalyzer
    );

    expect(result.changed).toBe(true);
    expect(result.summary).toBe('Price dropped from $99 to $79.');
    expect(result.provider).toBe('groq');
    expect(result.model).toBe('llama-3.3-70b-versatile');
    expect(result.fallback).toBe(false);
    expect(result.failureChain).toBeUndefined();
  });
});
