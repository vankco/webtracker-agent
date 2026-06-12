import type { Page } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// Matches the SitePlugin / PluginDiff interfaces in src/plugin-types.ts.
// Defined inline so this package has no dependency on the main app's source tree.
interface PluginDiff {
  hasChanges: boolean;
  summary: string;
  alertBody: string;
  requestLlmFallback?: boolean;
}

interface HistoryEntry {
  timestamp: string;
  products: unknown[];
  availableCount: number;
  changeSummary: string;
}

interface SitePlugin {
  name: string;
  matches(url: string): boolean;
  extractProducts(page: Page): Promise<unknown[]>;
  productsToText(products: unknown[]): string;
  parseProductLine(line: string): unknown;
  filterAvailable(products: unknown[]): unknown[];
  diff(oldProducts: unknown[], newProducts: unknown[]): PluginDiff;
  formatBaselineMessage(available: unknown[]): string;
  formatHistoryForPrediction?(history: HistoryEntry[]): string;
}

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

async function saveDebugHtml(page: Page, reason: string): Promise<void> {
  try {
    const html = await page.content();
    mkdirSync(join(process.cwd(), 'debug'), { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(process.cwd(), 'debug', `failed-scrape-${reason}-${ts}.html`);
    writeFileSync(file, html, 'utf-8');
    console.warn(`[hermes] Empty scrape (${reason}) — DOM saved to ${file}`);
  } catch (err) {
    console.warn('[hermes] Could not save debug HTML:', err instanceof Error ? err.message : err);
  }
}

function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((r) => setTimeout(r, ms));
}

async function scrollNaturally(page: Page): Promise<void> {
  const height = await page.evaluate(() => document.body.scrollHeight);
  const steps = 6 + Math.floor(Math.random() * 4);
  for (let i = 1; i <= steps; i++) {
    await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'smooth' }), Math.floor((height / steps) * i));
    await randomDelay(300, 700);
  }
}

async function saveDebugScreenshot(page: Page, label: string): Promise<void> {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(process.cwd(), 'debug', `${label}-${ts}.png`);
    mkdirSync(join(process.cwd(), 'debug'), { recursive: true });
    await page.screenshot({ path, fullPage: false });
    console.log(`[hermes:filter] screenshot → ${path}`);
  } catch { /* non-fatal */ }
}

async function applyHermesFilter(page: Page): Promise<boolean> {
  await saveDebugScreenshot(page, 'filter-01-start');

  // Log bot challenge state so we can see what the page looks like on entry.
  const botCheck = await page.evaluate(() => {
    const dd = document.querySelector('div[id^="ddChallengeContainer"]') as HTMLElement | null;
    return {
      datadome: !!dd,
      datadomeIframe: !!document.querySelector('iframe[src*="datadome"]'),
      recaptcha: !!document.querySelector('iframe[src*="recaptcha"]'),
      title: document.title,
    };
  });
  console.log('[hermes:filter] bot-check:', JSON.stringify(botCheck));

  // If DataDome overlay is present, disable its pointer interception.
  if (botCheck.datadome) {
    await page.evaluate(() => {
      const el = document.querySelector('div[id^="ddChallengeContainer"]') as HTMLElement | null;
      if (el) el.style.setProperty('pointer-events', 'none', 'important');
    });
    console.log('[hermes:filter] DataDome overlay disabled');
  }

  console.log('[hermes:filter] Looking for filter button...');
  const filterBtn = page.locator('button[aria-controls="tray-grid-filters"]').first();
  const filterBtnVisible = await filterBtn.isVisible({ timeout: 5_000 }).catch(() => false);
  console.log(`[hermes:filter] Filter button visible: ${filterBtnVisible}`);

  if (!filterBtnVisible) {
    const allButtons = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button')).map(b => ({
        text: b.textContent?.trim().slice(0, 40),
        ariaControls: b.getAttribute('aria-controls'),
        ariaLabel: b.getAttribute('aria-label'),
      })).filter(b => b.text || b.ariaLabel)
    );
    console.warn('[hermes:filter] Filter button not found. Buttons on page:', JSON.stringify(allButtons.slice(0, 15)));
    await saveDebugHtml(page, 'filter-button-not-found');
    return false;
  }

  await randomDelay(500, 1000);
  await filterBtn.scrollIntoViewIfNeeded().catch(() => {});
  await randomDelay(300, 600);
  await filterBtn.click();
  console.log('[hermes:filter] Filter button clicked');
  await randomDelay(1500, 2500);
  await saveDebugScreenshot(page, 'filter-02-after-click');

  console.log('[hermes:filter] Waiting for filter tray to open...');
  const tray = page.locator('div.tray-slide').first();
  await tray.waitFor({ state: 'visible', timeout: 5_000 }).catch(async () => {
    console.warn('[hermes:filter] Tray did not become visible in 5s');
    await saveDebugHtml(page, 'filter-tray-not-visible');
  });
  const trayVisible = await tray.isVisible().catch(() => false);
  console.log(`[hermes:filter] Tray visible: ${trayVisible}`);
  await randomDelay(500, 1000);
  await saveDebugScreenshot(page, 'filter-03-tray');

  console.log('[hermes:filter] Looking for in-stock toggle...');
  const toggle = page.locator('h-switch-button label.label-container').first();
  const toggleVisible = await toggle.isVisible({ timeout: 3_000 }).catch(() => false);
  console.log(`[hermes:filter] Toggle visible: ${toggleVisible}`);

  if (!toggleVisible) {
    const trayHtml = await tray.innerHTML().catch(() => '(error)');
    console.warn('[hermes:filter] Toggle not visible. Tray HTML (500 chars):', trayHtml.slice(0, 500));
    await saveDebugHtml(page, 'filter-toggle-not-visible');
    return false;
  }

  await randomDelay(500, 1000);
  await toggle.click({ timeout: 5_000 }).catch(async (e: unknown) => {
    console.warn('[hermes:filter] Toggle click failed:', e instanceof Error ? e.message : e);
    await saveDebugHtml(page, 'filter-toggle-click-failed');
  });
  console.log('[hermes:filter] Toggle clicked');
  await randomDelay(1000, 1500);
  await saveDebugScreenshot(page, 'filter-04-after-toggle');

  console.log('[hermes:filter] Looking for Apply button...');
  const applyBtn = page.locator('button[data-testid="Apply"]').first();
  const applyVisible = await applyBtn.isVisible({ timeout: 3_000 }).catch(() => false);
  console.log(`[hermes:filter] Apply button visible: ${applyVisible}`);

  if (!applyVisible) {
    const trayButtons = await page.evaluate(() =>
      Array.from(document.querySelectorAll('div.tray-slide button')).map(b => ({
        text: b.textContent?.trim(),
        testId: b.getAttribute('data-testid'),
      }))
    );
    console.warn('[hermes:filter] Apply button not found. Tray buttons:', JSON.stringify(trayButtons));
    await saveDebugHtml(page, 'filter-apply-not-visible');
    return false;
  }

  await randomDelay(500, 1000);
  await applyBtn.click({ timeout: 5_000 }).catch(async (e: unknown) => {
    console.warn('[hermes:filter] Apply click failed:', e instanceof Error ? e.message : e);
    await saveDebugHtml(page, 'filter-apply-click-failed');
  });
  console.log('[hermes:filter] Apply clicked — waiting for results...');
  await randomDelay(1000, 2000);

  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {
    console.warn('[hermes:filter] networkidle timed out after Apply');
  });
  const countAfter = await page.$$eval('div.product-item', (els) => els.length).catch(() => 0);
  console.log(`[hermes:filter] Products visible after filter: ${countAfter}`);
  await saveDebugScreenshot(page, 'filter-05-done');

  return true;
}

export async function extractHermesProducts(page: Page): Promise<HermesProduct[]> {
  // If the current URL has complex filter params (fh_location etc.), warm up the
  // SPA by loading the base URL first so the JS runtime is fully initialised,
  // then do a client-side hash navigation to the filtered view.
  const currentUrl = page.url();
  if (currentUrl.includes('fh_location') || currentUrl.includes('fh_view_size')) {
    const baseUrl = currentUrl.split('#')[0];
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await page.waitForSelector('div.product-item', { timeout: 20_000 }).catch(() => {});
    await randomDelay(1500, 2500);
    // Hash navigation — SPA handles it client-side without a full page reload
    await page.evaluate((url) => { window.location.href = url; }, currentUrl);
    await randomDelay(1000, 2000);
  }

  // Wait until at least one product is in the DOM before doing anything else.
  const appeared = await page.waitForSelector('div.product-item', { timeout: 45_000 })
    .then(() => true)
    .catch(() => false);

  if (!appeared) {
    await saveDebugHtml(page, 'no-products-after-45s');
    return [];
  }

  await randomDelay(1500, 3000);

  const filtered = await applyHermesFilter(page);
  if (!filtered) {
    console.warn('[hermes] Filter not applied — extracting all products (may include unavailable)');
  }

  // Click "Load more items" until it disappears, scrolling naturally between clicks
  const LOAD_MORE = 'button.button-secondary:has-text("Load more")';
  const MAX_CLICKS = 20;

  for (let i = 0; i < MAX_CLICKS; i++) {
    await scrollNaturally(page);
    await randomDelay(800, 1800);

    const btn = page.locator(LOAD_MORE).first();
    const visible = await btn.isVisible().catch(() => false);
    if (!visible) break;

    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await randomDelay(500, 1200);
    await btn.click();
    await randomDelay(1800, 3500);
  }

  // Final scroll + settle before extracting
  await scrollNaturally(page);
  await randomDelay(1000, 2000);

  const extract = () => page.evaluate(() => {
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

  const products = await extract();

  // If nothing came back the page likely didn't finish rendering (slow SPA or
  // transient bot challenge). Wait a bit and try once more before giving up.
  if (products.length === 0) {
    await page.waitForSelector('div.product-item', { timeout: 30_000 }).catch(() => {});
    await randomDelay(2000, 4000);
    const retry = await extract();

    if (retry.length === 0) {
      await saveDebugHtml(page, 'retry-also-empty');
    }

    return retry;
  }

  return products;
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
    sections.push(`✅ **Newly Available (${diff.added.length})**\n${diff.added.map(productLine).join('\n')}`);
  }
  if (diff.removed.length > 0) {
    sections.push(`❌ **No Longer Available (${diff.removed.length})**\n${diff.removed.map(productLine).join('\n')}`);
  }
  if (diff.changed.length > 0) {
    const changedLines = diff.changed.map(({ old: o, new: n }) => {
      const link = n.url ? `[${n.name}](${HERMES_BASE}${n.url})` : `**${n.name}**`;
      const priceDiff = o.price !== n.price ? ` ~~${o.price}~~ → **${n.price}**` : ` ${n.price}`;
      return `• ${link} — ${n.color}${priceDiff} — \`${n.sku}\``;
    });
    sections.push(`💰 **Updated (${diff.changed.length})**\n${changedLines.join('\n')}`);
  }

  return sections.join('\n\n');
}

export function formatHermesHistory(history: HistoryEntry[]): string {
  return history
    .map((entry) => {
      const products = (entry.products as HermesProduct[]) ?? [];
      const items = products
        .map((p) => `    - ${p.name} (${p.color || 'n/a'}) ${p.price} [${p.sku}]`)
        .join('\n');
      return `[${entry.timestamp}] ${entry.availableCount} available — ${entry.changeSummary}\n${items}`;
    })
    .join('\n\n');
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

  formatHistoryForPrediction(history: HistoryEntry[]): string {
    return formatHermesHistory(history);
  },
};

export default hermesPlugin;
