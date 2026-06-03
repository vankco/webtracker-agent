import * as fs from 'fs';
import * as path from 'path';

const STATE_FILE = path.resolve('state.json');

export interface HistoryEntry {
  timestamp: string;
  /** Full product snapshot at this event (plugin-shaped). */
  products: unknown[];
  availableCount: number;
  /** What changed at this event, e.g. "baseline" or "3 newly available". */
  changeSummary: string;
}

export const MAX_HISTORY = 500;

export interface MonitorState {
  url: string;
  lastContent: string;
  lastChecked: string;
  /** Structured product data stored by site plugins. Shape is plugin-defined. */
  lastProducts?: unknown[];
  /** Time-series of change events for trend analysis and predictions. */
  history?: HistoryEntry[];
}

/** Returns a new history array with the entry appended, capped at MAX_HISTORY (FIFO). */
export function appendHistory(
  existing: HistoryEntry[] | undefined,
  entry: HistoryEntry
): HistoryEntry[] {
  return [...(existing ?? []), entry].slice(-MAX_HISTORY);
}

export function loadState(): MonitorState | null {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as MonitorState;
  } catch {
    return null;
  }
}

export function saveState(state: MonitorState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}
