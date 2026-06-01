import { describe, it, expect } from 'vitest';
import { PluginRegistry, loadPlugins } from '../plugin-registry.js';
import type { SitePlugin } from '../plugin-types.js';

function makePlugin(name: string, pattern: string): SitePlugin {
  return {
    name,
    matches: (url) => url.includes(pattern),
    extractProducts: async () => [],
    productsToText: () => '',
    parseProductLine: () => ({}),
    filterAvailable: (p) => p,
    diff: () => ({ hasChanges: false, summary: 'no change', alertBody: '' }),
    formatBaselineMessage: () => '',
  };
}

describe('PluginRegistry', () => {
  it('returns null when no plugins are registered', () => {
    const registry = new PluginRegistry();
    expect(registry.findForUrl('https://example.com')).toBeNull();
  });

  it('finds a matching plugin by URL', () => {
    const registry = new PluginRegistry();
    const plugin = makePlugin('Test', 'example.com');
    registry.register(plugin);
    expect(registry.findForUrl('https://example.com/path')).toBe(plugin);
  });

  it('returns null when URL does not match any plugin', () => {
    const registry = new PluginRegistry();
    registry.register(makePlugin('Test', 'example.com'));
    expect(registry.findForUrl('https://other.com')).toBeNull();
  });

  it('returns the first matching plugin when multiple are registered', () => {
    const registry = new PluginRegistry();
    const first = makePlugin('First', 'example.com');
    const second = makePlugin('Second', 'example.com');
    registry.register(first);
    registry.register(second);
    expect(registry.findForUrl('https://example.com')).toBe(first);
  });
});

describe('loadPlugins', () => {
  it('loads a valid installed plugin by package name', async () => {
    const registry = await loadPlugins(['@webtracker/plugin-hermes']);
    expect(registry.findForUrl('https://www.hermes.com/products')).not.toBeNull();
  });

  it('skips plugins that fail to load and does not throw', async () => {
    const registry = await loadPlugins(['@webtracker/nonexistent-plugin-xyz']);
    expect(registry.findForUrl('https://example.com')).toBeNull();
  });
});
