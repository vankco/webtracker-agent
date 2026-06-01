import type { Page } from 'playwright';
import type { SitePlugin, PluginDiff } from '../../src/plugin-types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HermesProduct {
  name: string;
  color: string;
  price: string;
  sku: string;
  available: boolean;
  url: string;
}

export interface HermesDiff {
  added: HermesProduct[];
  removed: HermesProduct[];
  changed: Array<{ old: HermesProduct; new: HermesProduct }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HERMES_BASE = 'https://www.hermes.com';

function productLine(p: HermesProduct): string {
  const link = p.url ? `[${p.name}](${HERMES_BASE}${p.url})` : `**${p.name}**`;
  return `• ${link} — ${p.color} — ${p.price} — \`${p.sku}\``;
}

function toTyped(products: unknown[]): HermesProduct[] {
  return products as HermesProduct[];
}

// ---------------------------------------------------------------------------
// Core functions (exported for testing)
// ---------------------------------------------------------------------------

export function isHermesUrl(url: string): boolean {
  return url.includes('hermes.com');
}

export async function extractHermesProducts(page: Page): Promise<HermesProduct[]> {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('div.product-item')).map((item) => {
      const linkEl = item.querySelector('a.product-item-name');
      const name = item.querySelector('span.product-title')?.textContent?.trim() ?? '';
      const titleAttr = linkEl?.getAttribute('title') ?? '';
      const color = titleAttr.includes(',') ? titleAttr.split(',').slice(1).join(',').trim() : '';
      const priceEl = item.querySelector('span.price.notranslate');
      const price = priceEl ? (priceEl.textContent ?? '').replace(/\s+/g, ' ').trim() : '';
      const sku = ((item.querySelector('div.product-item-meta') as HTMLElement | null)
        ?.id ?? '').replace('product-item-meta-', '');
      const available = !item.querySelector('h-out-of-stock-label');
      const url = linkEl?.getAttribute('href') ?? '';
      return { name, color, price, sku, available, url };
    });
  });
}

export function hermesProductsToText(products: HermesProduct[]): string {
  return products
    .map(p => `${p.name} | ${p.color} | ${p.price} | SKU:${p.sku} | ${p.available ? 'Available' : 'Unavailable'} | ${p.url}`)
    .join('\n');
}

export function parseHermesLine(line: string): HermesProduct {
  const parts = line.split(' | ');
  return {
    name:      parts[0]?.trim() ?? '',
    color:     parts[1]?.trim() ?? '',
    price:     parts[2]?.trim() ?? '',
    sku:       (parts[3]?.trim() ?? '').replace('SKU:', ''),
    available: parts[4]?.trim() === 'Available',
    url:       parts[5]?.trim() ?? '',
  };
}

export function filterHermesAvailable(products: HermesProduct[]): HermesProduct[] {
  return products.filter(p => p.available);
}

export function filterHermesAvailableText(content: string): string {
  return content.split('\n').filter(l => l.includes('| Available')).join('\n');
}

export function diffHermesProducts(oldProducts: HermesProduct[], newProducts: HermesProduct[]): HermesDiff {
  const oldMap = new Map(oldProducts.map(p => [p.sku, p]));
  const newMap = new Map(newProducts.map(p => [p.sku, p]));

  return {
    added:   newProducts.filter(p => !oldMap.has(p.sku)),
    removed: oldProducts.filter(p => !newMap.has(p.sku)),
    changed: newProducts
      .filter(p => oldMap.has(p.sku))
      .map(p => ({ old: oldMap.get(p.sku)!, new: p }))
      .filter(({ old: o, new: n }) => o.price !== n.price || o.color !== n.color || o.name !== n.name),
  };
}

export function summarizeHermesDiff(diff: HermesDiff): string {
  const parts: string[] = [];
  if (diff.added.length > 0)   parts.push(`${diff.added.length} newly available`);
  if (diff.removed.length > 0) parts.push(`${diff.removed.length} no longer available`);
  if (diff.changed.length > 0) parts.push(`${diff.changed.length} updated`);
  return parts.join(', ') || 'No changes';
}

export function formatHermesDiscordMessage(diff: HermesDiff, totalCount: number): string {
  const sections: string[] = [];

  if (diff.added.length > 0) {
    sections.push(`➕ **Newly Available (${diff.added.length})**\n${diff.added.map(productLine).join('\n')}`);
  }
  if (diff.removed.length > 0) {
    sections.push(`➖ **No Longer Available (${diff.removed.length})**\n${diff.removed.map(productLine).join('\n')}`);
  }
  if (diff.changed.length > 0) {
    const changedLines = diff.changed.map(({ old: o, new: n }) => {
      const link = n.url ? `[${n.name}](${HERMES_BASE}${n.url})` : `**${n.name}**`;
      const priceDiff = o.price !== n.price ? ` ~~${o.price}~~ → **${n.price}**` : ` ${n.price}`;
      return `• ${link} — ${n.color}${priceDiff} — \`${n.sku}\``;
    });
    sections.push(`💰 **Updated (${diff.changed.length})**\n${changedLines.join('\n')}`);
  }

  return `${sections.join('\n\n')}\n\n📊 ${totalCount} available total`;
}

export function formatHermesBaselineMessage(available: HermesProduct[]): string {
  if (available.length === 0) {
    return `🟡 **Hermès baseline saved — no products currently available.**`;
  }
  const lines = available.map(productLine).join('\n');
  return `🟢 **Hermès baseline — ${available.length} currently available:**\n${lines}`;
}

// ---------------------------------------------------------------------------
// SitePlugin implementation
// ---------------------------------------------------------------------------

const hermesPlugin: SitePlugin = {
  name: 'Hermès',

  matches: isHermesUrl,

  extractProducts: extractHermesProducts,

  productsToText(products: unknown[]): string {
    return hermesProductsToText(toTyped(products));
  },

  parseProductLine: parseHermesLine,

  filterAvailable(products: unknown[]): unknown[] {
    return filterHermesAvailable(toTyped(products));
  },

  diff(oldProducts: unknown[], newProducts: unknown[]): PluginDiff {
    const d = diffHermesProducts(toTyped(oldProducts), toTyped(newProducts));
    return {
      hasChanges: d.added.length > 0 || d.removed.length > 0 || d.changed.length > 0,
      summary: summarizeHermesDiff(d),
      alertBody: formatHermesDiscordMessage(d, toTyped(newProducts).filter(p => p.available).length),
    };
  },

  formatBaselineMessage(available: unknown[]): string {
    return formatHermesBaselineMessage(toTyped(available));
  },
};

export default hermesPlugin;
