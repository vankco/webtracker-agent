import { describe, it, expect } from 'vitest';
import { appendHistory, MAX_HISTORY, type HistoryEntry } from '../state.js';

function makeEntry(i: number): HistoryEntry {
  return {
    timestamp: new Date(2026, 0, 1, 0, i).toISOString(),
    products: [],
    availableCount: i,
    changeSummary: `event ${i}`,
  };
}

describe('appendHistory', () => {
  it('appends to an undefined history (first entry)', () => {
    const result = appendHistory(undefined, makeEntry(1));
    expect(result).toHaveLength(1);
    expect(result[0].changeSummary).toBe('event 1');
  });

  it('appends to an existing history', () => {
    const result = appendHistory([makeEntry(1)], makeEntry(2));
    expect(result).toHaveLength(2);
    expect(result[1].changeSummary).toBe('event 2');
  });

  it('caps history at MAX_HISTORY, dropping oldest (FIFO)', () => {
    const existing = Array.from({ length: MAX_HISTORY }, (_, i) => makeEntry(i));
    const result = appendHistory(existing, makeEntry(9999));
    expect(result).toHaveLength(MAX_HISTORY);
    // Oldest (event 0) dropped, newest present
    expect(result[result.length - 1].changeSummary).toBe('event 9999');
    expect(result.find((e) => e.changeSummary === 'event 0')).toBeUndefined();
  });

  it('does not mutate the input array', () => {
    const existing = [makeEntry(1)];
    appendHistory(existing, makeEntry(2));
    expect(existing).toHaveLength(1);
  });
});
