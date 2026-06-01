import * as fs from 'fs';
import * as path from 'path';

const STATE_FILE = path.resolve('state.json');

export interface MonitorState {
  url: string;
  lastContent: string;
  lastChecked: string;
  /** Structured product data stored by site plugins. Shape is plugin-defined. */
  lastProducts?: unknown[];
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
