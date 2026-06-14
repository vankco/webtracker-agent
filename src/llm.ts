import Groq from 'groq-sdk';
import Anthropic from '@anthropic-ai/sdk';
import {
  analyzeChanges,
  localFallbackAnalysis,
  MONITOR_SYSTEM_PROMPT,
  buildMonitorUserPrompt,
  type AnalysisResult,
} from './analyzer.js';
import type { LlmProviderConfig } from './config.js';
import { parseLlmJson, tryEachProvider } from './utils.js';

/** Concatenates the text blocks of an Anthropic message response. */
export function claudeText(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

export interface AnalysisResultWithMeta extends AnalysisResult {
  /** Which provider produced this result (undefined = local fallback). */
  provider?: string;
  /** Which model was used. */
  model?: string;
  /** Elapsed time for this provider's call in milliseconds. */
  latencyMs?: number;
  /** True when all providers failed and local diff was used. */
  fallback?: boolean;
  /** Chain of provider failure reasons, populated when fallback = true. */
  failureChain?: Array<{ provider: string; reason: string }>;
}

export interface LlmAnalyzer {
  analyze(
    url: string,
    oldContent: string,
    newContent: string,
    provider: LlmProviderConfig
  ): Promise<AnalysisResult>;
}

// ---------------------------------------------------------------------------
// Groq adapter helpers
// ---------------------------------------------------------------------------

async function analyzeWithGroq(
  url: string,
  oldContent: string,
  newContent: string,
  provider: LlmProviderConfig
): Promise<AnalysisResult> {
  if (!provider.apiKey) {
    throw new Error('Groq provider is enabled but has no API key configured.');
  }

  const client = new Groq({
    apiKey: provider.apiKey,
    timeout: provider.timeoutMs,
    maxRetries: provider.maxRetries,
  });

  const completion = await client.chat.completions.create({
    model: provider.model,
    messages: [
      { role: 'system', content: MONITOR_SYSTEM_PROMPT },
      { role: 'user', content: buildMonitorUserPrompt(url, oldContent, newContent) },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
  });

  const raw = (completion.choices[0]?.message?.content ?? '').trim();
  if (!raw) {
    throw new Error('Empty Groq response.');
  }

  return parseLlmJson<AnalysisResult>(raw);
}

// ---------------------------------------------------------------------------
// Claude (Anthropic) adapter helpers
// ---------------------------------------------------------------------------

async function analyzeWithClaude(
  url: string,
  oldContent: string,
  newContent: string,
  provider: LlmProviderConfig
): Promise<AnalysisResult> {
  if (!provider.apiKey) {
    throw new Error('Claude provider is enabled but has no API key configured.');
  }

  const client = new Anthropic({
    apiKey: provider.apiKey,
    timeout: provider.timeoutMs,
    maxRetries: provider.maxRetries,
  });

  // No thinking/effort/sampling params: Haiku 4.5 rejects effort/thinking, and
  // omitting temperature/top_p keeps this forward-compatible with Opus models.
  const message = await client.messages.create({
    model: provider.model,
    max_tokens: 1024,
    system: MONITOR_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildMonitorUserPrompt(url, oldContent, newContent) }],
  });

  const raw = claudeText(message);
  if (!raw) {
    throw new Error('Empty Claude response.');
  }

  return parseLlmJson<AnalysisResult>(raw);
}

// ---------------------------------------------------------------------------
// Default multi-provider LLM analyzer
// ---------------------------------------------------------------------------

export const defaultLlmAnalyzer: LlmAnalyzer = {
  async analyze(url, oldContent, newContent, provider): Promise<AnalysisResult> {
    if (provider.id === 'gemini') {
      if (!provider.apiKey) {
        throw new Error('Gemini provider is enabled but has no API key configured.');
      }
      return analyzeChanges(url, oldContent, newContent, provider.apiKey, provider.model);
    }

    if (provider.id === 'groq') {
      return analyzeWithGroq(url, oldContent, newContent, provider);
    }

    if (provider.id === 'claude') {
      return analyzeWithClaude(url, oldContent, newContent, provider);
    }

    throw new Error(`Provider '${provider.id}' adapter is not implemented.`);
  },
};

// ---------------------------------------------------------------------------
// Orchestration: try each provider in priority order, fall back to local diff
// ---------------------------------------------------------------------------

export async function analyzeWithProviders(
  url: string,
  oldContent: string,
  newContent: string,
  providers: LlmProviderConfig[],
  analyzer: LlmAnalyzer = defaultLlmAnalyzer
): Promise<AnalysisResultWithMeta> {
  const failureChain: Array<{ provider: string; reason: string }> = [];

  const hit = await tryEachProvider(
    providers,
    (p) => analyzer.analyze(url, oldContent, newContent, p),
    ({ providerId, reason }) => {
      failureChain.push({ provider: providerId, reason });
      console.warn(`[llm] Provider '${providerId}' failed (${reason}). Trying next…`);
    },
  );

  if (hit) {
    return { ...hit.value, provider: hit.providerId, model: hit.model, latencyMs: hit.latencyMs, fallback: false };
  }

  // All providers exhausted — always return local analysis (never hard-fail the monitor loop)
  console.warn('[llm] All LLM providers failed. Using local diff fallback.');
  return { ...localFallbackAnalysis(oldContent, newContent), fallback: true, failureChain };
}
