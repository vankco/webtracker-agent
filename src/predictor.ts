/**
 * predictor.ts
 * LLM-powered availability & price prediction from historical product data.
 * Mirrors the provider-failover pattern in llm.ts, but with a prediction-specific
 * prompt and output shape. Unlike change-detection, there is no local fallback —
 * if all providers fail, the caller surfaces an error.
 */

import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import type { LlmProviderConfig } from './config.js';

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
  const json = raw.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  const parsed = JSON.parse(json) as RawPrediction;
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

  for (const provider of providers) {
    try {
      let raw: RawPrediction;
      if (provider.id === 'gemini') {
        raw = await predictWithGemini(url, historyText, provider);
      } else if (provider.id === 'groq') {
        raw = await predictWithGroq(url, historyText, provider);
      } else {
        throw new Error(`Provider '${provider.id}' not supported for prediction.`);
      }

      return {
        generatedAt: new Date().toISOString(),
        provider: provider.id,
        model: provider.model,
        summary: raw.summary,
        insights: raw.insights,
        historyEntryCount,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push(`${provider.id}: ${reason}`);
      console.warn(`[predictor] Provider '${provider.id}' failed (${reason}). Trying next…`);
    }
  }

  throw new Error(`All providers failed to generate a prediction. ${failures.join('; ')}`);
}
