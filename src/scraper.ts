import { chromium } from 'playwright-extra';
import type { BrowserContext, Page } from 'playwright';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { resolve } from 'node:path';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { BrowserConfig } from './config.js';

chromium.use(StealthPlugin());

let persistentContext: BrowserContext | null = null;
let persistentPage: Page | null = null;

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function parseIntEnv(value: string | undefined, defaultValue: number): number {
  if (value == null || value.trim() === '') return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

async function navigateWithFallback(page: Page, url: string, timeoutMs: number): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  } catch {
    // Some anti-bot or slow pages can stall on first attempt; retry once with looser load criteria.
    await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
  }

  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {
    // Ignore pages with long-lived connections and continue with current DOM.
  });
}

function isPersistentSessionEnabled(): boolean {
  const manualAssisted = parseBooleanEnv(process.env['MANUAL_ASSISTED'], false);
  const persistentRequested = parseBooleanEnv(process.env['BROWSER_PERSIST_SESSION'], true);
  return manualAssisted || persistentRequested;
}

async function getOrCreateSessionPage(
  headless: boolean,
  slowMoMs: number,
  userDataDirOverride?: string
): Promise<Page> {
  if (persistentPage && !persistentPage.isClosed()) {
    return persistentPage;
  }

  const userDataDir = resolve(
    process.cwd(),
    userDataDirOverride || process.env['BROWSER_USER_DATA_DIR'] || '.browser-profile'
  );
  persistentContext = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless,
    slowMo: slowMoMs > 0 ? slowMoMs : undefined,
    viewport: null,
  });

  const existingPage = persistentContext.pages()[0];
  persistentPage = existingPage ?? (await persistentContext.newPage());

  // Mimic a real browser
  await persistentPage.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
  });

  return persistentPage;
}

// ---------------------------------------------------------------------------
// Hermès-specific product extractor
// ---------------------------------------------------------------------------

export function isHermesUrl(url: string): boolean {
  return url.includes('hermes.com');
}

export interface HermesProduct {
  name: string;
  color: string;
  price: string;
  sku: string;
  available: boolean;
  url: string; // relative path e.g. /us/en/product/balusoie-bag-H086920CKAB/
}

/**
 * Extracts all product items from a Hermès category page as structured data.
 */
async function extractHermesProducts(page: Page): Promise<HermesProduct[]> {
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

/** Serialize product array to one line per product for state storage and LLM comparison. */
export function hermesProductsToText(products: HermesProduct[]): string {
  return products
    .map(p => `${p.name} | ${p.color} | ${p.price} | SKU:${p.sku} | ${p.available ? 'Available' : 'Unavailable'} | ${p.url}`)
    .join('\n');
}

/** Parse a single serialized product line back into a structured object. */
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

/**
 * Filters a product array to available items only.
 * Used to scope LLM change detection to available products only.
 */
export function filterHermesAvailable(products: HermesProduct[]): HermesProduct[] {
  return products.filter((p) => p.available);
}

/**
 * Fallback: filter serialized string content to available lines only.
 * Used when loading legacy state.json entries that predate lastProducts.
 */
export function filterHermesAvailableText(content: string): string {
  return content.split('\n').filter((l) => l.includes('| Available')).join('\n');
}

const HERMES_BASE = 'https://www.hermes.com';

function productLine(p: HermesProduct): string {
  const link = p.url ? `[${p.name}](${HERMES_BASE}${p.url})` : `**${p.name}**`;
  return `• ${link} — ${p.color} — ${p.price} — \`${p.sku}\``;
}

/**
 * Builds a structured Discord markdown message by diffing two available-product arrays.
 */
export function formatHermesDiscordMessage(
  oldProducts: HermesProduct[],
  newProducts: HermesProduct[],
  llmSummary: string
): string {

  const oldMap = new Map(oldProducts.map(p => [p.sku, p]));
  const newMap = new Map(newProducts.map(p => [p.sku, p]));

  const added   = newProducts.filter(p => !oldMap.has(p.sku));
  const removed = oldProducts.filter(p => !newMap.has(p.sku));
  const changed = newProducts
    .filter(p => oldMap.has(p.sku))
    .map(p => ({ old: oldMap.get(p.sku)!, new: p }))
    .filter(({ old: o, new: n }) => o.price !== n.price || o.color !== n.color || o.name !== n.name);

  const sections: string[] = [];

  if (added.length > 0) {
    sections.push(`➕ **Newly Available (${added.length})**\n${added.map(productLine).join('\n')}`);
  }
  if (removed.length > 0) {
    sections.push(`➖ **No Longer Available (${removed.length})**\n${removed.map(productLine).join('\n')}`);
  }
  if (changed.length > 0) {
    const changedLines = changed.map(({ old: o, new: n }) => {
      const link = n.url ? `[${n.name}](${HERMES_BASE}${n.url})` : `**${n.name}**`;
      const priceDiff = o.price !== n.price ? ` ~~${o.price}~~ → **${n.price}**` : ` ${n.price}`;
      return `• ${link} — ${n.color}${priceDiff} — \`${n.sku}\``;
    });
    sections.push(`💰 **Updated (${changed.length})**\n${changedLines.join('\n')}`);
  }

  const stats = `📊 ${newProducts.length} available total`;
  const body = sections.join('\n\n');
  const summary = llmSummary ? `\n\n💬 *${llmSummary.slice(0, 300)}*` : '';

  return `${body}${summary}\n\n${stats}`;
}

export function formatHermesBaselineMessage(available: HermesProduct[]): string {
  if (available.length === 0) {
    return `🟡 **Hermès baseline saved — no products currently available.**`;
  }
  const lines = available.map(productLine).join('\n');
  return `🟢 **Hermès baseline — ${available.length} currently available:**\n${lines}`;
}

export async function closeScraperSession(): Promise<void> {
  if (persistentContext) {
    await persistentContext.close().catch(() => {
      // Ignore close errors during shutdown.
    });
  }
  persistentContext = null;
  persistentPage = null;
}

async function dismissNotificationBanner(page: any): Promise<void> {
  const deadline = Date.now() + 8_000;

  while (Date.now() < deadline) {
    try {
      const banner = page.locator('#notification-banner-modal').first();
      if (!(await banner.isVisible({ timeout: 700 }))) {
        await page.waitForTimeout(300);
        continue;
      }

      const closeCandidates = [
        banner.locator('button.close-icon').first(),
        banner.getByRole('button', { name: /close/i }).first(),
      ];

      for (const closeButton of closeCandidates) {
        if (await closeButton.isVisible({ timeout: 700 })) {
          await closeButton.click({ timeout: 2_000 });
          await banner.waitFor({ state: 'hidden', timeout: 4_000 }).catch(() => {
            // Some sites animate removal or keep detached overlays; continue regardless.
          });
          return;
        }
      }

      await page.waitForTimeout(300);
    } catch {
      // Banner is optional; continue when absent.
      return;
    }
  }
}

async function waitForManualContinue(fallbackWaitMs: number): Promise<void> {
  if (input.isTTY && output.isTTY) {
    const rl = createInterface({ input, output });
    try {
      await rl.question('Verification complete? Press Enter to continue scraping... ');
      return;
    } finally {
      rl.close();
    }
  }

  console.log(
    `Manual-assisted mode running in non-interactive terminal. Waiting ${Math.round(fallbackWaitMs / 1000)}s fallback.`
  );
  if (fallbackWaitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, fallbackWaitMs));
  }
}

export async function scrapePageText(
  url: string,
  selector?: string,
  browserConfig?: BrowserConfig
): Promise<string> {
  const manualAssisted = browserConfig?.manualAssisted ?? parseBooleanEnv(process.env['MANUAL_ASSISTED'], false);
  const persistentSession = browserConfig?.persistSession ?? isPersistentSessionEnabled();
  const headless = browserConfig?.headless ?? (manualAssisted ? false : parseBooleanEnv(process.env['BROWSER_HEADLESS'], true));
  const slowMoMs = browserConfig?.slowMoMs ?? Math.max(0, parseIntEnv(process.env['BROWSER_SLOW_MO_MS'], 0));
  const keepOpenMs = browserConfig?.keepOpenMs ?? Math.max(0, parseIntEnv(process.env['BROWSER_KEEP_OPEN_MS'], 0));
  const gotoTimeoutMs = browserConfig?.gotoTimeoutMs ?? Math.max(10_000, parseIntEnv(process.env['BROWSER_GOTO_TIMEOUT_MS'], 60_000));
  const initialManualWaitMs =
    browserConfig?.manualAssistedInitialWaitMs ??
    Math.max(0, parseIntEnv(process.env['MANUAL_ASSISTED_INITIAL_WAIT_MS'], 120_000));
  const shouldAwaitManualStep = manualAssisted && !persistentPage;

  const browser = persistentSession
    ? null
    : await chromium.launch({
        channel: 'chrome',
        headless,
        slowMo: slowMoMs > 0 ? slowMoMs : undefined,
      });

  try {
    const page = persistentSession
      ? await getOrCreateSessionPage(headless, slowMoMs, browserConfig?.userDataDir)
      : await browser!.newPage();

    if (!persistentSession) {
      // Mimic a real browser
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
      });
    }

    await navigateWithFallback(page, url, gotoTimeoutMs);
    await dismissNotificationBanner(page);

    if (shouldAwaitManualStep) {
      console.log('Manual-assisted mode active. Complete any verification in the open browser.');
      await waitForManualContinue(initialManualWaitMs);
      await navigateWithFallback(page, url, gotoTimeoutMs);
      await dismissNotificationBanner(page);
    }

    let text: string;

    if (isHermesUrl(url)) {
      // Extract structured product data, then serialize to text for storage/comparison
      const products = await extractHermesProducts(page);
      text = hermesProductsToText(products);
    } else {
      const target = selector && selector.trim() ? selector.trim() : 'body';
      text = await page.$eval(target, (el) => (el as HTMLElement).innerText);
      // Normalize whitespace so minor formatting changes don't trigger false positives
      text = text.replace(/\s+/g, ' ').trim();
    }

    // Optional debug pause so you can visually inspect the page in headed mode.
    if (!headless && keepOpenMs > 0 && !persistentSession) {
      await page.waitForTimeout(keepOpenMs);
    }

    return text;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
