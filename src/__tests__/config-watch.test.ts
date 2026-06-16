import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildAppConfig,
  saveJsonConfig,
  readJsonConfig,
  ConfigStore,
  loadAppConfigLenient,
} from '../config.js';

const tmpFiles: string[] = [];
function tmpPath(): string {
  const p = path.join(os.tmpdir(), `wt-config-${Math.random().toString(36).slice(2)}.json`);
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

describe('productWatchUrls config round-trip', () => {
  it('buildAppConfig defaults to an empty list', () => {
    expect(buildAppConfig({}).productWatchUrls).toEqual([]);
  });

  it('buildAppConfig carries the list through from JsonConfig', () => {
    const cfg = buildAppConfig({ productWatchUrls: ['https://x/p-H1/'] });
    expect(cfg.productWatchUrls).toEqual(['https://x/p-H1/']);
  });

  it('saveJsonConfig persists the list and readJsonConfig restores it', () => {
    const file = tmpPath();
    const cfg = buildAppConfig({
      targetUrl: 'https://example.com',
      discordWebhookUrl: 'https://discord.com/api/webhooks/test',
      productWatchUrls: ['https://x/p-H1/', 'https://x/p-H2/'],
    });
    saveJsonConfig(cfg, file);
    expect(readJsonConfig(file)?.productWatchUrls).toEqual(['https://x/p-H1/', 'https://x/p-H2/']);
  });

  it('saveJsonConfig omits the key when the list is empty', () => {
    const file = tmpPath();
    saveJsonConfig(buildAppConfig({}), file);
    expect(readJsonConfig(file)?.productWatchUrls).toBeUndefined();
  });

  it('ConfigStore.update applies a new list', () => {
    const store = new ConfigStore(loadAppConfigLenient({}));
    store.update({ productWatchUrls: ['https://x/p-H9/'] });
    expect(store.get().productWatchUrls).toEqual(['https://x/p-H9/']);
  });
});
