import * as fs from 'fs';
import * as path from 'path';
import { generateSiteId } from './config.js';

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
  /** Time-series of change events for trend analysis and the Discord bot's Q&A. */
  history?: HistoryEntry[];
}

/** Returns a new history array with the entry appended, capped at MAX_HISTORY (FIFO). */
export function appendHistory(
  existing: HistoryEntry[] | undefined,
  entry: HistoryEntry
): HistoryEntry[] {
  return [...(existing ?? []), entry].slice(-MAX_HISTORY);
}

/** Map of siteId → per-site monitor state, the on-disk shape of state.json. */
export type StateMap = Record<string, MonitorState>;

/**
 * Reads state.json as a site-keyed map. Auto-migrates the legacy single-object
 * format (a bare MonitorState with a top-level `url`) into a one-element map.
 * Synchronous under the hood; the public API is async for the future Turso swap.
 */
function readMapSync(): StateMap {
  if (!fs.existsSync(STATE_FILE)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as unknown;
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      // Legacy single-object form → wrap as a one-element map.
      if (typeof obj.url === 'string') {
        return { [generateSiteId(obj.url)]: parsed as MonitorState };
      }
      return parsed as StateMap;
    }
    return {};
  } catch {
    return {};
  }
}

function writeMapSync(map: StateMap): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(map, null, 2), 'utf-8');
}

/** Loads the full site-keyed state map (migrating the legacy format on read). */
export async function loadAllState(): Promise<StateMap> {
  return readMapSync();
}

/** Persists the full site-keyed state map. */
export async function saveAllState(map: StateMap): Promise<void> {
  writeMapSync(map);
}

/**
 * Loads one site's state. Falls back to matching by `url` so state migrated
 * from the legacy format (keyed under a different id) is still found and then
 * re-keyed on the next save.
 */
export async function loadSiteState(siteId: string, url?: string): Promise<MonitorState | null> {
  const map = readMapSync();
  if (map[siteId]) return map[siteId];
  if (url) {
    const match = Object.values(map).find((st) => st.url === url);
    if (match) return match;
  }
  return null;
}

/** Persists one site's state, dropping any stale duplicate keyed by the same url. */
export async function saveSiteState(siteId: string, state: MonitorState): Promise<void> {
  const map = readMapSync();
  for (const key of Object.keys(map)) {
    if (key !== siteId && map[key].url === state.url) delete map[key];
  }
  map[siteId] = state;
  writeMapSync(map);
}

// ---------------------------------------------------------------------------
// Deprecated single-site shims (kept for the /ask path until it goes per-site).
// ---------------------------------------------------------------------------

/** @deprecated Returns the first site's state. Use loadSiteState. */
export function loadState(): MonitorState | null {
  return Object.values(readMapSync())[0] ?? null;
}

/** @deprecated Writes one site's state, matching by url. Use saveSiteState. */
export function saveState(state: MonitorState): void {
  const map = readMapSync();
  const id = Object.keys(map).find((k) => map[k].url === state.url) ?? generateSiteId(state.url);
  map[id] = state;
  writeMapSync(map);
}

/**
 * Last-modified time of state.json in ms, or null if it doesn't exist.
 * Cheap (a stat, not a full read) — lets callers cache derived data and
 * invalidate only when the file actually changes, including out-of-band edits.
 */
export function getStateMtimeMs(): number | null {
  try {
    return fs.statSync(STATE_FILE).mtimeMs;
  } catch {
    return null;
  }
}
