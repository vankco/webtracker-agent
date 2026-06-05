/**
 * bot-qa.ts
 * LLM-powered natural-language Q&A over product availability data.
 * Mirrors the provider-failover pattern in predictor.ts.
 * Called by POST /api/ask, which the Discord bot hits for /ask questions.
 */

import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import type { LlmProviderConfig } from './config.js';

export const QA_SYSTEM_PROMPT =
  `You are a helpful assistant for a product availability tracker. ` +
  `Answer questions about current stock, pricing, availability history, and patterns. ` +
  `Be concise and direct. Use bullet points when listing multiple items. ` +
  `Respond in plain text only — no markdown code fences.`;

export function buildAskPrompt(
  targetUrl: string,
  currentProductsText: string,
  historyText: string,
  question: string
): string {
  return `Data source: ${targetUrl}

--- CURRENT PRODUCTS ---
${currentProductsText || '(no current product data)'}

--- AVAILABILITY HISTORY (oldest to newest) ---
${historyText || '(no history available)'}

--- QUESTION ---
${question}`;
}

async function askWithGemini(prompt: string, provider: LlmProviderConfig): Promise<string> {
  if (!provider.apiKey) throw new Error('Gemini provider has no API key configured.');
  const genAI = new GoogleGenAI({ apiKey: provider.apiKey });
  const result = await genAI.models.generateContent({
    model: provider.model,
    contents: `${QA_SYSTEM_PROMPT}\n\n${prompt}`,
  });
  const raw = (result.text ?? '').trim();
  if (!raw) throw new Error('Empty Gemini response.');
  return raw;
}

async function askWithGroq(prompt: string, provider: LlmProviderConfig): Promise<string> {
  if (!provider.apiKey) throw new Error('Groq provider has no API key configured.');
  const client = new Groq({
    apiKey: provider.apiKey,
    timeout: provider.timeoutMs,
    maxRetries: provider.maxRetries,
  });
  const completion = await client.chat.completions.create({
    model: provider.model,
    messages: [
      { role: 'system', content: QA_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    temperature: 0.3,
  });
  const raw = (completion.choices[0]?.message?.content ?? '').trim();
  if (!raw) throw new Error('Empty Groq response.');
  return raw;
}

/** Runs the question through enabled providers in priority order. Throws if all fail. */
export async function answerQuestion(
  prompt: string,
  providers: LlmProviderConfig[]
): Promise<string> {
  const failures: string[] = [];
  for (const provider of providers) {
    try {
      if (provider.id === 'gemini') return await askWithGemini(prompt, provider);
      if (provider.id === 'groq') return await askWithGroq(prompt, provider);
      throw new Error(`Provider '${provider.id}' not supported.`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push(`${provider.id}: ${reason}`);
      console.warn(`[bot-qa] Provider '${provider.id}' failed (${reason}). Trying next…`);
    }
  }
  throw new Error(`All providers failed. ${failures.join('; ')}`);
}
