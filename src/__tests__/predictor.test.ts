import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable mocks for the LLM SDKs
const { geminiGen, groqCreate } = vi.hoisted(() => ({
  geminiGen: vi.fn(),
  groqCreate: vi.fn(),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: geminiGen };
  },
}));

vi.mock('groq-sdk', () => ({
  default: class {
    chat = { completions: { create: groqCreate } };
  },
}));

import {
  buildPredictionPrompt,
  PREDICTION_SYSTEM_PROMPT,
  predictAvailability,
} from '../predictor.js';
import type { LlmProviderConfig } from '../config.js';

function provider(id: 'gemini' | 'groq', overrides: Partial<LlmProviderConfig> = {}): LlmProviderConfig {
  return {
    id,
    enabled: true,
    priority: 1,
    model: `${id}-model`,
    apiKey: 'test-key',
    timeoutMs: 30_000,
    maxRetries: 1,
    ...overrides,
  };
}

describe('buildPredictionPrompt', () => {
  it('includes the URL and history text', () => {
    const prompt = buildPredictionPrompt('https://example.com', 'snapshot A\nsnapshot B');
    expect(prompt).toContain('https://example.com');
    expect(prompt).toContain('snapshot A');
  });

  it('asks for restock, sellout, and price predictions', () => {
    const prompt = buildPredictionPrompt('https://example.com', 'history').toLowerCase();
    expect(prompt).toContain('restock');
    expect(prompt).toContain('sell out');
    expect(prompt).toContain('price');
  });
});

describe('PREDICTION_SYSTEM_PROMPT', () => {
  it('instructs the model to return JSON only', () => {
    expect(PREDICTION_SYSTEM_PROMPT.toLowerCase()).toContain('json');
  });
});

describe('predictAvailability', () => {
  beforeEach(() => {
    geminiGen.mockReset();
    groqCreate.mockReset();
  });

  it('returns a prediction from Gemini', async () => {
    geminiGen.mockResolvedValue({ text: '{"summary":"restock likely","insights":["a","b"]}' });
    const result = await predictAvailability('https://x.com', 'history', [provider('gemini')], 5);
    expect(result.provider).toBe('gemini');
    expect(result.summary).toBe('restock likely');
    expect(result.insights).toEqual(['a', 'b']);
    expect(result.historyEntryCount).toBe(5);
  });

  it('strips markdown fences from the response', async () => {
    geminiGen.mockResolvedValue({ text: '```json\n{"summary":"s","insights":[]}\n```' });
    const result = await predictAvailability('https://x.com', 'h', [provider('gemini')], 3);
    expect(result.summary).toBe('s');
  });

  it('fails over from Gemini to Groq', async () => {
    geminiGen.mockRejectedValue(new Error('gemini down'));
    groqCreate.mockResolvedValue({
      choices: [{ message: { content: '{"summary":"from groq","insights":["x"]}' } }],
    });
    const result = await predictAvailability('https://x.com', 'h', [provider('gemini'), provider('groq', { priority: 2 })], 4);
    expect(result.provider).toBe('groq');
    expect(result.summary).toBe('from groq');
  });

  it('throws when all providers fail', async () => {
    geminiGen.mockRejectedValue(new Error('gemini down'));
    groqCreate.mockRejectedValue(new Error('groq down'));
    await expect(
      predictAvailability('https://x.com', 'h', [provider('gemini'), provider('groq')], 3)
    ).rejects.toThrow(/All providers failed/);
  });

  it('throws on invalid JSON (missing insights), then fails over', async () => {
    geminiGen.mockResolvedValue({ text: '{"summary":"no insights field"}' });
    await expect(
      predictAvailability('https://x.com', 'h', [provider('gemini')], 3)
    ).rejects.toThrow(/All providers failed/);
  });
});
