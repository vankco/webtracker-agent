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

interface ExtractOptions {
  productWatchUrls?: string[];
}

interface HistoryEntry {
  timestamp: string;
  products: unknown[];
  availableCount: number;
  changeSummary: string;
}

interface ScheduleWindow {
  startHour: number;
  endHour: number;
  intervalMs: number;
}

interface SiteSchedule {
  timezone?: string;
  windows?: ScheduleWindow[];
  intervalMs?: number;
}

interface SitePlugin {
  name: string;
  matches(url: string): boolean;
  extractProducts(page: Page, options?: ExtractOptions): Promise<unknown[]>;
  productsToText(products: unknown[]): string;
  parseProductLine(line: string): unknown;
  filterAvailable(products: unknown[]): unknown[];
  diff(oldProducts: unknown[], newProducts: unknown[]): PluginDiff;
  formatBaselineMessage(available: unknown[]): string;
  formatHistoryForPrediction?(history: HistoryEntry[]): string;
  suggestedSchedule?: SiteSchedule;
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

/** Result of re-checking a single product detail page (the source of truth). */
export interface ProductVerification {
  /** The product detail URL that was checked. */
  url: string;
  /** SKU derived from the URL (used to match against listing products). */
  sku: string;
  /** True availability read from the product page. Meaningful only when ok. */
  available: boolean;
  /** False when the page failed to load (timeout / bot challenge). */
  ok: boolean;
  /** Best-effort product built from the page — used when the URL isn't on the listing. */
  product?: HermesProduct;
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

/**
 * Extracts the SKU from a Hermès product URL. Product URLs end with the SKU as
 * the final '-' token, e.g.
 *   https://www.hermes.com/us/en/product/picotin-lock-18-bag-H056289CKAA/
 *     -> "H056289CKAA"
 * Returns '' when no token can be derived.
 */
export function skuFromUrl(url: string): string {
  const path = (url || '').split('?')[0].split('#')[0].replace(/\/+$/, '');
  const lastSeg = path.split('/').pop() ?? '';
  const token = lastSeg.split('-').pop() ?? '';
  return token.toUpperCase();
}

/** True when a listing product corresponds to the given SKU (by sku field or URL). */
function productMatchesSku(p: HermesProduct, sku: string): boolean {
  if (!sku) return false;
  const bySku = (p.sku || '').toUpperCase();
  if (bySku && bySku === sku) return true;
  return p.url ? skuFromUrl(`${HERMES_BASE}${p.url}`) === sku : false;
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

/**
 * Human-like browsing noise: scroll to the footer (present on every page) and
 * click a random *safe* footer link to vary the navigation pattern so the
 * watch-URL visits don't look like a fixed scripted sequence (anti-bot).
 *
 * Deliberately constrained for safety on a live retail site:
 *   - footer links only, same-origin relative paths — skips off-site/social
 *     links, new-tab links, and any account/cart/checkout area (side effects).
 *   - fully best-effort: never throws and never blocks the scrape. The next
 *     watch URL re-navigates with page.goto regardless of where this lands.
 */
async function clickRandomSafeLink(page: Page): Promise<void> {
  try {
    await scrollNaturally(page); // brings the footer into view
    const links = await page.$$('footer a[href]:visible');
    const candidates: typeof links = [];
    for (const a of links) {
      const href = (await a.getAttribute('href').catch(() => '')) || '';
      const target = (await a.getAttribute('target').catch(() => '')) || '';
      if (target === '_blank') continue;                 // no orphan tabs
      if (!href.startsWith('/')) continue;               // same-origin only (skips social/external, mailto, tel, #)
      if (/account|login|sign|wishlist|cart|checkout|logout/i.test(href)) continue; // no side-effect areas
      candidates.push(a);
    }
    if (candidates.length === 0) return;

    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    await pick.scrollIntoViewIfNeeded().catch(() => {});
    await randomDelay(400, 1200);
    await pick.click({ timeout: 4_000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => {});
    // Linger on the clicked page for a moment, as a human reading it would.
    await randomDelay(1500, 4000);
  } catch {
    // Best-effort noise — ignore every failure so it can't break a scrape.
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

/**
 * Re-checks a single product detail page and returns its TRUE availability.
 * The product page is the source of truth — the listing's `has_stock` facet
 * over-reports availability. On any navigation/load failure returns ok=false so
 * the caller can keep the listing value.
 */
export async function verifyProductAvailability(page: Page, url: string): Promise<ProductVerification> {
  const sku = skuFromUrl(url);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await randomDelay(1500, 3000);

    // Function passed to page.evaluate must not close over outer variables.
    const info = await page.evaluate(() => {
      // Hermès product pages embed a JSON-LD Product whose `offers.availability`
      // is the source of truth and is present even in server-rendered HTML
      // (e.g. "http://schema.org/InStock" vs ".../OutOfStock"). Parse that first.
      let ldAvailability = '';
      let ldName = '';
      let ldPrice = '';
      let ldSku = '';
      const ld = document.querySelector('script#microdata, script[type="application/ld+json"]');
      if (ld && ld.textContent) {
        try {
          const data = JSON.parse(ld.textContent);
          const node = Array.isArray(data) ? data.find((d) => d && d['@type'] === 'Product') : data;
          if (node) {
            ldName = String(node.name || '').trim();
            ldSku = String(node.sku || node.mpn || '').trim();
            const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers;
            if (offers) {
              ldAvailability = String(offers.availability || '');
              ldPrice = offers.price != null ? String(offers.price) : '';
            }
          }
        } catch {
          /* malformed JSON-LD — fall back to DOM heuristics below */
        }
      }
      const txt = (document.body.innerText || '').toLowerCase();
      return {
        ldAvailability,
        ldName,
        ldPrice,
        ldSku,
        // A removed product 404s: the SPA routes to its not-found page and
        // rewrites the URL to /404-error. Treat this as a definitive "gone".
        isNotFound:
          !!document.querySelector('h-not-found-page') ||
          /\b404\b/.test(document.title) ||
          location.href.includes('/404-error'),
        // Secondary DOM signals, used only when JSON-LD is absent.
        hasAddToCart: !!document.querySelector('[data-testid="Add to cart"], h-call-to-action-add-to-cart button'),
        noLongerAvailable: txt.includes('no longer available'),
        color: (document.querySelector('.product-selector .current-value')?.textContent || '').trim(),
      };
    });

    // Source of truth, in order: a 404/not-found page means the product is gone
    // (definitively unavailable); otherwise JSON-LD offers.availability
    // (InStock ⇒ available); otherwise fall back to the add-to-cart affordance.
    const available = info.isNotFound
      ? false
      : info.ldAvailability
        ? /InStock/i.test(info.ldAvailability)
        : info.hasAddToCart && !info.noLongerAvailable;

    const price = info.ldPrice ? `$${Number(info.ldPrice).toLocaleString('en-US')}` : '';
    const product: HermesProduct = {
      name: info.ldName,
      color: info.color,
      price,
      sku: info.ldSku || sku,
      available,
      url: url.replace(/^https?:\/\/[^/]+/, ''),
    };
    return { url, sku, available, ok: true, product };
  } catch (err) {
    await saveDebugHtml(page, `product-verify-${sku || 'unknown'}`).catch(() => {});
    console.warn(`[hermes:verify] ${url} failed:`, err instanceof Error ? err.message : err);
    return { url, sku, available: false, ok: false };
  }
}

/**
 * Visits each watch URL sequentially (random delays between — lowest detection)
 * and merges the product-page truth into the listing products.
 */
async function verifyAndMergeWatchProducts(
  page: Page,
  listing: HermesProduct[],
  watchUrls: string[]
): Promise<HermesProduct[]> {
  const verifications: ProductVerification[] = [];
  for (const url of watchUrls) {
    verifications.push(await verifyProductAvailability(page, url));
    // After reading each product page, do some human-like browsing noise —
    // click a random safe in-domain link — then pause, so the watch-URL visits
    // don't look like a fixed scripted burst (anti-bot).
    await clickRandomSafeLink(page);
    await randomDelay(1000, 3000);
  }
  return mergeWatchAvailability(listing, verifications);
}

export async function extractHermesProducts(page: Page, options?: ExtractOptions): Promise<HermesProduct[]> {
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

  let products = await extract();

  // If nothing came back the page likely didn't finish rendering (slow SPA or
  // transient bot challenge). Wait a bit and try once more before giving up.
  if (products.length === 0) {
    await page.waitForSelector('div.product-item', { timeout: 30_000 }).catch(() => {});
    await randomDelay(2000, 4000);
    products = await extract();

    if (products.length === 0) {
      await saveDebugHtml(page, 'retry-also-empty');
    }
  }

  // Re-verify availability against the product detail pages (source of truth).
  // Done last so the listing extraction above isn't disturbed by navigating away.
  const watchUrls = options?.productWatchUrls ?? [];
  if (watchUrls.length > 0) {
    products = await verifyAndMergeWatchProducts(page, products, watchUrls);
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

/**
 * Merges product-page truth (the source of truth) into the listing products.
 *
 *  - watch URL matches a listing product + ok  → override its `available`
 *  - watch URL matches a listing product + !ok → keep the listing value
 *  - watch URL not on the listing + ok          → append the product-page product
 *  - watch URL not on the listing + !ok         → skip (not added this cycle)
 *  - listing products with no watch URL          → passed through untouched
 *
 * Example: watch [E,F], listing shows A,B,C,D,E available; E's page says no,
 * F's page (not on the listing) says yes → result available set = A,B,C,D,F.
 */
export function mergeWatchAvailability(
  listing: HermesProduct[],
  verifications: ProductVerification[]
): HermesProduct[] {
  const result = listing.map((p) => ({ ...p }));
  for (const v of verifications) {
    const idx = result.findIndex((p) => productMatchesSku(p, v.sku));
    if (idx >= 0) {
      if (v.ok) result[idx] = { ...result[idx], available: v.available };
      // !ok → keep listing value (no-op)
    } else if (v.ok && v.product) {
      result.push(v.product);
    }
    // not on listing + !ok → skip
  }
  return result;
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

// Stored timestamps are UTC (ISO 8601). Render them in US Pacific time with an
// explicit zone label (PST/PDT, DST-aware) so the bot's answers are unambiguous.
const PACIFIC_TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  timeZoneName: 'short',
});

/** Format a UTC ISO timestamp as "YYYY-MM-DD HH:mm PDT" in US Pacific time. */
function toPacific(ts: string): string {
  const p = Object.fromEntries(
    PACIFIC_TIME_FORMAT.formatToParts(new Date(ts)).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

/**
 * Full-history representation for LLM Q&A, built as an explicit availability
 * event log. Starting from the oldest snapshot as a baseline, it walks forward
 * and, at each change-event, diffs the available set against the previous one:
 *   '+' a product became available, '-' it sold out / was removed,
 *   '~' its price changed.
 * This is the source-of-truth event stream — the model can reconstruct any
 * product's full history (when it appeared, how long it lasted, how many times
 * it restocked, current status) by scanning its SKU. Cost scales with the
 * number of *changes*, not snapshots, so the entire history fits cheaply and
 * nothing is dropped by a last-N cap. Timestamps are US Pacific (PST/PDT).
 */
export function formatHermesHistory(history: HistoryEntry[]): string {
  if (history.length === 0) return '(no history available)';

  const t = (ts: string): string => toPacific(ts);
  const price = (p: HermesProduct): string => (p.price || '').replace(/^Price\s*/i, '').trim();
  const lbl = (p: HermesProduct): string => {
    const pr = price(p);
    return `${p.name} (${p.color || 'n/a'})${pr ? ` ${pr}` : ''} [${p.sku}]`;
  };
  const keyOf = (p: HermesProduct): string => p.sku || `${p.name}|${p.color}`;
  const setOf = (entry: HistoryEntry): Map<string, HermesProduct> => {
    const m = new Map<string, HermesProduct>();
    for (const p of (entry.products as HermesProduct[]) ?? []) m.set(keyOf(p), p);
    return m;
  };

  const lines: string[] = [];
  let prev = new Map<string, HermesProduct>();

  history.forEach((entry, i) => {
    const cur = setOf(entry);
    if (i === 0) {
      const items = [...cur.values()].map(lbl).join(', ');
      lines.push(`[${t(entry.timestamp)}] BASELINE — ${cur.size} available: ${items || '(none)'}`);
    } else {
      const added = [...cur.keys()].filter((k) => !prev.has(k)).map((k) => cur.get(k)!);
      const removed = [...prev.keys()].filter((k) => !cur.has(k)).map((k) => prev.get(k)!);
      const repriced = [...cur.keys()]
        .filter((k) => prev.has(k))
        .map((k) => ({ o: prev.get(k)!, n: cur.get(k)! }))
        .filter(({ o, n }) => price(o) !== price(n));
      const parts: string[] = [];
      if (added.length) parts.push(`+ ${added.map(lbl).join(', ')}`);
      if (removed.length) parts.push(`- ${removed.map(lbl).join(', ')}`);
      if (repriced.length) {
        parts.push(`~ ${repriced.map(({ o, n }) => `${n.name} [${n.sku}] ${price(o)}→${price(n)}`).join(', ')}`);
      }
      lines.push(`[${t(entry.timestamp)}] ${parts.join('  ') || '(no net change)'}`);
    }
    prev = cur;
  });

  const span = `${t(history[0].timestamp)} → ${t(history[history.length - 1].timestamp)}`;
  return [
    `Availability event log (oldest→newest, ${history.length} events over ${span}; ${prev.size} currently available). ` +
      `Each line: '+' became available, '-' sold out/removed, '~' price change. ` +
      `Reconstruct any product by scanning its [SKU].`,
    lines.join('\n'),
  ].join('\n');
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

  // Hermès releases US inventory in the early-morning Pacific hours (history
  // shows ~70% of all changes 06:00–11:00 PT, a weaker bump ~14:00–15:00, and a
  // near-dead overnight). Scrape hard in the morning, easy the rest of the day.
  suggestedSchedule: {
    timezone: 'America/Los_Angeles',
    intervalMs: 30 * 60_000, // fallback when no window matches
    windows: [
      { startHour: 6, endHour: 11, intervalMs: 120_000 },   // peak morning drops — aggressive
      { startHour: 11, endHour: 16, intervalMs: 600_000 },  // afternoon bump — moderate
      { startHour: 16, endHour: 6, intervalMs: 45 * 60_000 }, // overnight — sparse (wraps midnight)
    ],
  },
};

export default hermesPlugin;
