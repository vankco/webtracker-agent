/** Safely extracts a message string from an unknown caught value. */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

export function parseIntEnv(value: string | undefined, defaultValue: number): number {
  if (value == null || value.trim() === '') return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Strips accidental markdown code fences from an LLM response and parses it
 * as JSON. Throws SyntaxError on invalid JSON.
 */
export function parseLlmJson<T>(raw: string): T {
  const json = raw.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  return JSON.parse(json) as T;
}

export interface ProviderHit<T> {
  value: T;
  providerId: string;
  model: string;
  latencyMs: number;
}

/**
 * Tries each provider in order, returning the first success.
 * Returns null if every provider throws; callers decide how to handle that
 * (fall back to local logic, or throw their own error).
 */
export async function tryEachProvider<TProvider extends { id: string; model: string }, T>(
  providers: TProvider[],
  fn: (provider: TProvider) => Promise<T>,
  onFailure: (info: { providerId: string; reason: string }) => void,
): Promise<ProviderHit<T> | null> {
  for (const provider of providers) {
    const start = Date.now();
    try {
      const value = await fn(provider);
      return { value, providerId: provider.id, model: provider.model, latencyMs: Date.now() - start };
    } catch (err) {
      onFailure({ providerId: provider.id, reason: getErrorMessage(err) });
    }
  }
  return null;
}
