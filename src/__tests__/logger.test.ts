import { describe, it, expect, beforeEach } from 'vitest';
import { log, getLogs, clearLogs } from '../logger.js';

describe('logger', () => {
  beforeEach(() => {
    clearLogs();
  });

  it('stores a log entry and returns it via getLogs', () => {
    log('info', 'monitor', 'test message');
    const logs = getLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe('info');
    expect(logs[0].category).toBe('monitor');
    expect(logs[0].message).toBe('test message');
  });

  it('returns logs newest-first', () => {
    log('info', 'monitor', 'first');
    log('warn', 'llm', 'second');
    const logs = getLogs();
    expect(logs[0].message).toBe('second');
    expect(logs[1].message).toBe('first');
  });

  it('stores optional details', () => {
    log('error', 'scrape', 'failed', { url: 'https://example.com' });
    const logs = getLogs();
    expect(logs[0].details).toEqual({ url: 'https://example.com' });
  });

  it('assigns incrementing ids', () => {
    log('info', 'system', 'a');
    log('info', 'system', 'b');
    const logs = getLogs();
    expect(logs[0].id).toBeGreaterThan(logs[1].id);
  });

  it('clearLogs empties the buffer', () => {
    log('info', 'monitor', 'test');
    clearLogs();
    expect(getLogs()).toHaveLength(0);
  });
});
