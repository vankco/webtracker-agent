#!/usr/bin/env node
// Cross-platform stop script — kills app processes and frees ports.
import { execSync, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const isWindows = process.platform === 'win32';
const PORTS = [3001, 5173, 5174, 5175];
const PROCESS_PATTERNS = ['src/agent.ts', 'src/health-monitor.ts', 'src/discord-bot.ts', 'concurrently', 'vite'];

function killByPattern(pattern) {
  if (isWindows) {
    spawnSync('powershell', [
      '-NoProfile', '-Command',
      `Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like '*${pattern}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ], { stdio: 'ignore' });
  } else {
    spawnSync('pkill', ['-9', '-f', pattern], { stdio: 'ignore' });
  }
}

function killByPort(port) {
  if (isWindows) {
    spawnSync('powershell', [
      '-NoProfile', '-Command',
      `$pid = (Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess; if ($pid) { Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue }`,
    ], { stdio: 'ignore' });
  } else {
    try {
      const pids = execSync(`lsof -ti:${port} 2>/dev/null`, { encoding: 'utf8' }).trim();
      if (pids) execSync(`kill -9 ${pids}`, { stdio: 'ignore' });
    } catch { /* port not in use */ }
  }
}

function countRemaining() {
  try {
    if (isWindows) {
      const result = spawnSync('powershell', [
        '-NoProfile', '-Command',
        `(Get-WmiObject Win32_Process | Where-Object { ${PROCESS_PATTERNS.map(p => `$_.CommandLine -like '*${p}*'`).join(' -or ')} }).Count`,
      ], { encoding: 'utf8' });
      return parseInt(result.stdout.trim()) || 0;
    } else {
      const result = execSync(`ps aux | grep -E "${PROCESS_PATTERNS.join('|')}" | grep -v grep | wc -l`, { encoding: 'utf8' });
      return parseInt(result.trim()) || 0;
    }
  } catch { return 0; }
}

console.log('Stopping app processes...');
for (const pattern of PROCESS_PATTERNS) killByPattern(pattern);

console.log('Freeing ports...');
for (const port of PORTS) killByPort(port);

// Remove stale browser singleton locks
for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
  try { rmSync(join('.browser-profile', lock), { force: true }); } catch { /* ignore */ }
}

await new Promise(r => setTimeout(r, 1500));
console.log(`Stopped. Remaining app processes: ${countRemaining()}`);
