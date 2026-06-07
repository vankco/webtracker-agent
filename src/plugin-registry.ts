import type { SitePlugin } from './plugin-types.js';
import { getErrorMessage } from './utils.js';

export class PluginRegistry {
  private plugins: SitePlugin[] = [];

  register(plugin: SitePlugin): void {
    this.plugins.push(plugin);
  }

  findForUrl(url: string): SitePlugin | null {
    return this.plugins.find(p => p.matches(url)) ?? null;
  }
}

export async function loadPlugins(names: string[]): Promise<PluginRegistry> {
  const registry = new PluginRegistry();
  for (const name of names) {
    try {
      const mod = await import(name) as { default?: SitePlugin };
      if (mod.default) {
        registry.register(mod.default);
        console.log(`[plugins] Loaded: ${mod.default.name}`);
      } else {
        console.warn(`[plugins] "${name}" has no default export — skipped.`);
      }
    } catch (err) {
      console.warn(`[plugins] Failed to load "${name}": ${getErrorMessage(err)}`);
    }
  }
  return registry;
}
