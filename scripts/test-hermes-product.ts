/**
 * Step 0 capture: navigate to one or more Hermès PRODUCT DETAIL pages and dump
 * the DOM + candidate availability signals so we can pin down the exact
 * "no longer available" marker used by `verifyProductAvailability`.
 *
 * Pass at least one known-available URL and one known-"no longer available" URL
 * so the differing signal is obvious in the logged report.
 *
 * Usage:
 *   tsx scripts/test-hermes-product.ts <productUrl> [<productUrl> ...]
 *   tsx scripts/test-hermes-product.ts --headless <productUrl> ...
 *
 * Output (per URL): debug/product-pages/<n>-<slug>.html + <n>-<slug>.png
 * and a console "signals" report.
 */
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

chromium.use(StealthPlugin());

const HEADLESS = process.argv.includes('--headless');
const urls = process.argv.slice(2).filter((a) => a.startsWith('http'));
const OUT_DIR = join(process.cwd(), 'debug', 'product-pages');

if (urls.length === 0) {
  console.error('Provide at least one product URL.\n  tsx scripts/test-hermes-product.ts <url> [<url> ...]');
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function slug(url: string): string {
  return url.split('?')[0].split('#')[0].replace(/https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').slice(0, 60);
}

(async () => {
  console.log(`\nLaunching browser (headless=${HEADLESS}) for ${urls.length} product page(s)...`);
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: HEADLESS,
    slowMo: HEADLESS ? 0 : 300,
  });

  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  let n = 0;
  for (const url of urls) {
    n++;
    console.log(`\n── [${n}/${urls.length}] ${url} ──`);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (err) {
      console.warn('  goto failed:', err instanceof Error ? err.message : err);
    }
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await sleep(2500);

    const base = `${String(n).padStart(2, '0')}-${slug(url)}`;
    const html = await page.content();
    writeFileSync(join(OUT_DIR, `${base}.html`), html, 'utf-8');
    await page.screenshot({ path: join(OUT_DIR, `${base}.png`), fullPage: true }).catch(() => {});

    // Probe a broad set of candidate availability signals. Whichever one
    // cleanly separates the available vs unavailable URLs is what we'll use.
    const signals = await page.evaluate(() => {
      const txt = (document.body.innerText || '').toLowerCase();
      const has = (sel: string) => !!document.querySelector(sel);
      const buttons = Array.from(document.querySelectorAll('button')).map((b) => ({
        text: (b.textContent || '').trim().slice(0, 50),
        testId: b.getAttribute('data-testid'),
        ariaLabel: b.getAttribute('aria-label'),
        disabled: (b as HTMLButtonElement).disabled,
      })).filter((b) => b.text || b.ariaLabel || b.testId);
      return {
        title: document.title,
        datadome: has('div[id^="ddChallengeContainer"]') || has('iframe[src*="datadome"]'),
        // text-based candidates
        text_noLongerAvailable: txt.includes('no longer available'),
        text_outOfStock: txt.includes('out of stock'),
        text_soldOut: txt.includes('sold out'),
        text_addToCart: txt.includes('add to cart') || txt.includes('add to shopping bag'),
        text_notifyMe: txt.includes('notify me') || txt.includes('email me'),
        // element-based candidates
        el_addToCartTestId: has('[data-testid="add-to-cart"]') || has('[data-testid="addToCart"]'),
        el_outOfStockLabel: has('h-out-of-stock-label'),
        el_addToCartComponent: has('h-add-to-cart') || has('h-cart-button'),
        buttons: buttons.slice(0, 25),
      };
    }).catch((e) => ({ error: String(e) }));

    console.log('  signals:', JSON.stringify(signals, null, 2));
    console.log(`  html → ${join(OUT_DIR, `${base}.html`)}`);
  }

  if (!HEADLESS) {
    console.log('\n(keeping browser open 5s)');
    await sleep(5000);
  }
  await browser.close();
  console.log(`\n✓ Done. Captures in ${OUT_DIR}`);
})().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
