import Groq from 'groq-sdk';
import { analyzeChanges, localFallbackAnalysis, type AnalysisResult } from './analyzer.js';
import type { LlmProviderConfig } from './config.js';

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

const MONITOR_SYSTEM_PROMPT = `You are a website change monitoring assistant. \
Analyze differences between two versions of webpage content and identify meaningful changes. \
Always respond with valid JSON only — no markdown fences, no extra text.`;

function buildMonitorUserPrompt(url: string, oldContent: string, newContent: string): string {
  return `Compare these two versions of a webpage and identify meaningful changes.

URL: ${url}

--- PREVIOUS CONTENT (truncated to 3000 chars) ---
${oldContent.slice(0, 3000)}

--- CURRENT CONTENT (truncated to 3000 chars) ---
${newContent.slice(0, 3000)}

Rules:
- Ignore trivial differences (whitespace, punctuation, minor wording).
- Focus on meaningful changes: new sections, price/availability changes, announcements, removed content.
- Respond with JSON in exactly one of these two formats:
  {"changed": true, "summary": "Short description of what changed"}
  {"changed": false, "summary": "No meaningful changes detected"}`;
}

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

  // Strip accidental markdown fences just in case
  const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  return JSON.parse(json) as AnalysisResult;
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

  for (const provider of providers) {
    const start = Date.now();
    try {
      const result = await analyzer.analyze(url, oldContent, newContent, provider);
      return {
        ...result,
        provider: provider.id,
        model: provider.model,
        latencyMs: Date.now() - start,
        fallback: false,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failureChain.push({ provider: provider.id, reason });
      console.warn(`[llm] Provider '${provider.id}' failed (${reason}). Trying next…`);
    }
  }

  // All providers exhausted — always return local analysis (never hard-fail the monitor loop)
  console.warn('[llm] All LLM providers failed. Using local diff fallback.');
  const fallbackResult = localFallbackAnalysis(oldContent, newContent);
  return {
    ...fallbackResult,
    fallback: true,
    failureChain,
  };
}
