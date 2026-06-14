/**
 * predictor.ts
 * LLM-powered availability & price prediction from historical product data.
 * Mirrors the provider-failover pattern in llm.ts, but with a prediction-specific
 * prompt and output shape. Unlike change-detection, there is no local fallback —
 * if all providers fail, the caller surfaces an error.
 */

import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import Anthropic from '@anthropic-ai/sdk';
import type { LlmProviderConfig } from './config.js';
import { claudeText } from './llm.js';
import { log } from './logger.js';
import { parseLlmJson, tryEachProvider } from './utils.js';

export interface PredictionResult {
  generatedAt: string;
  provider: string;
  model?: string;
  summary: string;
  insights: string[];
  historyEntryCount: number;
}

/** Raw LLM output shape (before we attach metadata). */
interface RawPrediction {
  summary: string;
  insights: string[];
}

export const PREDICTION_SYSTEM_PROMPT =
  `You are a product availability and pricing analyst. ` +
  `Given a chronological history of product snapshots, identify trends and predict future changes. ` +
  `Always respond with valid JSON only — no markdown fences, no extra text.`;

export function buildPredictionPrompt(url: string, historyText: string): string {
  return `Analyze this product availability & price history and predict near-future changes.

URL: ${url}

--- HISTORY (oldest to newest) ---
${historyText}

Based on the patterns above, predict:
1. Which products are likely to restock or become available in the next 1–2 weeks?
2. Which currently-available products might sell out soon?
3. Any notable price trends or movements?

Respond with JSON in exactly this format:
{"summary": "2-3 sentence overview of the key prediction", "insights": ["specific insight 1", "specific insight 2", "..."]}`;
}

function parsePrediction(raw: string): RawPrediction {
  const parsed = parseLlmJson<RawPrediction>(raw);
  if (typeof parsed.summary !== 'string' || !Array.isArray(parsed.insights)) {
    throw new Error('Prediction response missing summary or insights.');
  }
  return parsed;
}

async function predictWithGemini(
  url: string,
  historyText: string,
  provider: LlmProviderConfig
): Promise<RawPrediction> {
  if (!provider.apiKey) throw new Error('Gemini provider has no API key configured.');
  const genAI = new GoogleGenAI({ apiKey: provider.apiKey });
  const prompt = `${PREDICTION_SYSTEM_PROMPT}\n\n${buildPredictionPrompt(url, historyText)}`;
  const result = await genAI.models.generateContent({ model: provider.model, contents: prompt });
  const raw = (result.text ?? '').trim();
  if (!raw) throw new Error('Empty Gemini response.');
  return parsePrediction(raw);
}

async function predictWithGroq(
  url: string,
  historyText: string,
  provider: LlmProviderConfig
): Promise<RawPrediction> {
  if (!provider.apiKey) throw new Error('Groq provider has no API key configured.');
  const client = new Groq({
    apiKey: provider.apiKey,
    timeout: provider.timeoutMs,
    maxRetries: provider.maxRetries,
  });
  const completion = await client.chat.completions.create({
    model: provider.model,
    messages: [
      { role: 'system', content: PREDICTION_SYSTEM_PROMPT },
      { role: 'user', content: buildPredictionPrompt(url, historyText) },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.2,
  });
  const raw = (completion.choices[0]?.message?.content ?? '').trim();
  if (!raw) throw new Error('Empty Groq response.');
  return parsePrediction(raw);
}

async function predictWithClaude(
  url: string,
  historyText: string,
  provider: LlmProviderConfig
): Promise<RawPrediction> {
  if (!provider.apiKey) throw new Error('Claude provider has no API key configured.');
  const client = new Anthropic({
    apiKey: provider.apiKey,
    timeout: provider.timeoutMs,
    maxRetries: provider.maxRetries,
  });
  const message = await client.messages.create({
    model: provider.model,
    max_tokens: 2048,
    system: PREDICTION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildPredictionPrompt(url, historyText) }],
  });
  const raw = claudeText(message);
  if (!raw) throw new Error('Empty Claude response.');
  return parsePrediction(raw);
}

/**
 * Runs prediction through enabled providers in priority order.
 * Throws if every provider fails (no local fallback for predictions).
 */
export async function predictAvailability(
  url: string,
  historyText: string,
  providers: LlmProviderConfig[],
  historyEntryCount: number
): Promise<PredictionResult> {
  const failures: string[] = [];

  const hit = await tryEachProvider(
    providers,
    (p) => {
      if (p.id === 'gemini') return predictWithGemini(url, historyText, p);
      if (p.id === 'groq') return predictWithGroq(url, historyText, p);
      if (p.id === 'claude') return predictWithClaude(url, historyText, p);
      throw new Error(`Provider '${p.id}' not supported for prediction.`);
    },
    ({ providerId, reason }) => {
      failures.push(`${providerId}: ${reason}`);
      log('warn', 'llm', `[predictor] Provider '${providerId}' failed — trying next`, { provider: providerId, reason });
    },
  );

  if (!hit) {
    throw new Error(`All providers failed to generate a prediction. ${failures.join('; ')}`);
  }

  return {
    generatedAt: new Date().toISOString(),
    provider: hit.providerId,
    model: hit.model,
    summary: hit.value.summary,
    insights: hit.value.insights,
    historyEntryCount,
  };
}
