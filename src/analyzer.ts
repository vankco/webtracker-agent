import { GoogleGenAI } from '@google/genai';
import { diffWordsWithSpace, type Change } from 'diff';

export interface AnalysisResult {
  changed: boolean;
  summary: string;
}

function compactSnippet(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 3))}...`;
}

function computeDiffMetrics(changes: Change[]): { changedChars: number; changedRatio: number } {
  const changedChars = changes
    .filter((part) => part.added || part.removed)
    .reduce((sum, part) => sum + part.value.length, 0);
  const baselineLen = Math.max(
    changes.reduce((sum, part) => sum + part.value.length, 0),
    1
  );

  return {
    changedChars,
    changedRatio: changedChars / baselineLen,
  };
}

function getChangedSnippetPairs(
  changes: Change[],
  maxPairs = 5,
  maxSnippetLen = 220
): Array<{ oldSnippet: string; newSnippet: string }> {
  const pairs: Array<{ oldSnippet: string; newSnippet: string }> = [];

  const getContextTail = (index: number, maxLen = 40): string => {
    if (index < 0 || index >= changes.length) return '';
    const part = changes[index];
    if (part.added || part.removed) return '';
    return part.value.slice(Math.max(0, part.value.length - maxLen));
  };

  const getContextHead = (index: number, maxLen = 40): string => {
    if (index < 0 || index >= changes.length) return '';
    const part = changes[index];
    if (part.added || part.removed) return '';
    return part.value.slice(0, maxLen);
  };

  for (let i = 0; i < changes.length && pairs.length < maxPairs; i += 1) {
    const part = changes[i];
    if (!part.added && !part.removed) {
      continue;
    }

    // Merge adjacent diff parts (and tiny unchanged separators like commas/spaces)
    // so token-level edits become readable phrase-level snippets.
    let j = i;
    let oldChunk = '';
    let newChunk = '';

    while (j < changes.length) {
      const current = changes[j];
      if (current.added) {
        newChunk += current.value;
        j += 1;
        continue;
      }
      if (current.removed) {
        oldChunk += current.value;
        j += 1;
        continue;
      }

      const compactUnchanged = compactSnippet(current.value);
      if (compactUnchanged.length === 0 || compactUnchanged.length <= 3) {
        oldChunk += current.value;
        newChunk += current.value;
        j += 1;
        continue;
      }

      break;
    }

    const contextBefore = getContextTail(i - 1);
    const contextAfter = getContextHead(j);

    const oldSnippet = truncateText(
      compactSnippet(`${contextBefore}${oldChunk}${contextAfter}`),
      maxSnippetLen
    );
    const newSnippet = truncateText(
      compactSnippet(`${contextBefore}${newChunk}${contextAfter}`),
      maxSnippetLen
    );
    if (!oldSnippet && !newSnippet) {
      continue;
    }

    pairs.push({ oldSnippet, newSnippet });
    i = j - 1;
  }

  return pairs;
}

export function localFallbackAnalysis(oldContent: string, newContent: string): AnalysisResult {
  if (oldContent === newContent) {
    return {
      changed: false,
      summary: 'No meaningful changes detected (local fallback: exact text match).',
    };
  }

  const changes = diffWordsWithSpace(oldContent, newContent);
  const { changedChars, changedRatio } = computeDiffMetrics(changes);

  if (changedChars < 12 && changedRatio < 0.0015) {
    return {
      changed: false,
      summary: 'Only very small text differences detected (local fallback).',
    };
  }

  const changedPairs = getChangedSnippetPairs(changes);
  if (changedPairs.length === 0) {
    return {
      changed: false,
      summary: 'Only very small text differences detected (local fallback).',
    };
  }

  const snippetsSummary = changedPairs
    .map(
      (pair, index) =>
        `[#${index + 1}] Old: ~~${pair.oldSnippet || '(empty)'}~~\n[#${index + 1}] New: **${pair.newSnippet || '(empty)'}**`
    )
    .join('\n\n');

  return {
    changed: true,
    summary: truncateText(
      `Meaningful content difference detected (local fallback, ~${Math.round(changedRatio * 100)}% changed tokens). ` +
        `Changed snippets:\n${snippetsSummary}`,
      1800
    ),
  };
}

export async function analyzeChanges(
  url: string,
  oldContent: string,
  newContent: string,
  apiKey: string,
  model = 'gemini-2.5-flash'
): Promise<AnalysisResult> {
  const genAI = new GoogleGenAI({ apiKey });

  const prompt = `You are monitoring a website for meaningful changes.

URL: ${url}

--- PREVIOUS CONTENT (truncated to 3000 chars) ---
${oldContent.slice(0, 3000)}

--- CURRENT CONTENT (truncated to 3000 chars) ---
${newContent.slice(0, 3000)}

Instructions:
- Ignore trivial differences like whitespace, punctuation, or minor wording tweaks.
- Focus on meaningful changes: new sections, price changes, availability updates, new announcements, removed content, etc.
- Reply with ONLY valid JSON in this exact format (no markdown, no extra text):
{"changed": true, "summary": "Short description of what changed"}
or
{"changed": false, "summary": "No meaningful changes detected"}`;

  try {
    const result = await genAI.models.generateContent({
      model,
      contents: prompt,
    });
    const raw = (result.text ?? '').trim();

    if (!raw) {
      throw new Error('Empty Gemini response text.');
    }

    // Strip accidental markdown code fences
    const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    return JSON.parse(json) as AnalysisResult;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Gemini analysis failed (${message}). Falling back to local text-diff analysis.`);
    return localFallbackAnalysis(oldContent, newContent);
  }
}
