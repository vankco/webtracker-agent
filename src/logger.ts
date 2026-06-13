/**
 * logger.ts
 * Persistent log buffer — entries survive restarts via logs.jsonl.
 * Keeps up to 3 days of history; trims older entries on startup and
 * on a recurring interval so long-running processes stay bounded.
 */

import * as fs from 'fs';
import * as path from 'path';

export type LogLevel = 'info' | 'warn' | 'error';
export type LogCategory = 'scrape' | 'llm' | 'monitor' | 'config' | 'system';

export interface LogEntry {
  id: number;
  timestamp: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
  details?: Record<string, unknown>;
}

const LOG_FILE = path.resolve('logs.jsonl');
const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const TRIM_INTERVAL_MS = 60 * 60 * 1000; // re-trim hourly while running

let nextId = 1;
const entries: LogEntry[] = [];

type AlertCallback = (entry: LogEntry) => void;
let alertCallback: AlertCallback | null = null;

/** Register a callback that fires on every warn/error log entry. */
export function setAlertCallback(cb: AlertCallback | null): void {
  alertCallback = cb;
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function appendToFile(entry: LogEntry): void {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // File write failure must never crash the monitor loop.
  }
}

function loadFromFile(): LogEntry[] {
  if (!fs.existsSync(LOG_FILE)) return [];
  try {
    const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
    const lines = fs.readFileSync(LOG_FILE, 'utf-8').split('\n').filter(Boolean);
    const recent = lines
      .map(l => { try { return JSON.parse(l) as LogEntry; } catch { return null; } })
      .filter((e): e is LogEntry => e !== null && e.timestamp >= cutoff);
    return recent;
  } catch {
    return [];
  }
}

function trimFile(): void {
  try {
    const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
    const lines = fs.readFileSync(LOG_FILE, 'utf-8').split('\n').filter(Boolean);
    const recent = lines.filter(l => {
      try { return (JSON.parse(l) as LogEntry).timestamp >= cutoff; } catch { return false; }
    });
    fs.writeFileSync(LOG_FILE, recent.join('\n') + (recent.length ? '\n' : ''), 'utf-8');
  } catch {
    // Non-fatal.
  }
}

/** Drop in-memory entries older than the retention window. */
function trimMemory(): void {
  const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
  let drop = 0;
  while (drop < entries.length && entries[drop].timestamp < cutoff) drop++;
  if (drop > 0) entries.splice(0, drop);
}

// ---------------------------------------------------------------------------
// Startup: load persisted entries
// ---------------------------------------------------------------------------

(function init() {
  trimFile();
  const loaded = loadFromFile();
  if (loaded.length > 0) {
    entries.push(...loaded);
    nextId = Math.max(...loaded.map(e => e.id)) + 1;
  }

  // Re-trim periodically so a long-running process stays bounded.
  // unref() keeps this timer from holding the process (or tests) open.
  setInterval(() => {
    trimMemory();
    trimFile();
  }, TRIM_INTERVAL_MS).unref();
})();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function log(
  level: LogLevel,
  category: LogCategory,
  message: string,
  details?: Record<string, unknown>
): void {
  const entry: LogEntry = {
    id: nextId++,
    timestamp: new Date().toISOString(),
    level,
    category,
    message,
    details,
  };

  entries.push(entry);
  appendToFile(entry);

  if ((level === 'warn' || level === 'error') && alertCallback) {
    alertCallback(entry);
  }
}

export function getLogs(): LogEntry[] {
  return [...entries].reverse(); // newest first
}

export function clearLogs(): void {
  entries.length = 0;
  try { fs.writeFileSync(LOG_FILE, '', 'utf-8'); } catch { /* non-fatal */ }
}
