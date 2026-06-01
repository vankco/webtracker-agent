/**
 * logger.ts
 * In-memory circular log buffer for debug visibility.
 * Captures scrape, LLM, monitor, and config events.
 */

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

const MAX_ENTRIES = 500;
let nextId = 1;
const entries: LogEntry[] = [];

type AlertCallback = (entry: LogEntry) => void;
let alertCallback: AlertCallback | null = null;

/** Register a callback that fires on every warn/error log entry. */
export function setAlertCallback(cb: AlertCallback): void {
  alertCallback = cb;
}

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
  if (entries.length > MAX_ENTRIES) {
    entries.shift();
  }

  if ((level === 'warn' || level === 'error') && alertCallback) {
    alertCallback(entry);
  }
}

export function getLogs(): LogEntry[] {
  return [...entries].reverse(); // newest first
}

export function clearLogs(): void {
  entries.length = 0;
}
