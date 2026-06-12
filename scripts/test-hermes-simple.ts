/**
 * Simple headed test to see exactly what happens when navigating the Hermes site.
 * Runs visually with slow-mo + screenshots at every step.
 *
 * Usage:
 *   tsx scripts/test-hermes-simple.ts
 *   tsx scripts/test-hermes-simple.ts --headless   (headless mode)
 */
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

chromium.use(StealthPlugin());

const HEADLESS = process.argv.includes('--headless');
const BASE_URL = 'https://www.hermes.com/us/en/category/leather-goods/bags-and-clutches/womens-bags-and-clutches/';
const OUT_DIR = join(process.cwd(), 'debug', 'simple-test');

mkdirSync(OUT_DIR, { recursive: true });

let stepNum = 0;

async function step(page: any, label: string): Promise<void> {
  stepNum++;
  const filename = `${String(stepNum).padStart(2, '0')}-${label.replace(/\s+/g, '-')}.png`;
  const path = join(OUT_DIR, filename);
  await page.screenshot({ path, fullPage: false }).catch(() => {});
  const count = await page.$$eval('div.product-item', (els: any[]) => els.length).catch(() => 0);
  console.log(`[${stepNum}] ${label} | products in DOM: ${count} | url: ${page.url().slice(0, 80)}`);
  console.log(`     screenshot → ${path}`);
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  console.log(`\nLaunching browser (headless=${HEADLESS})...`);
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: HEADLESS,
    slowMo: HEADLESS ? 0 : 400,
  });

  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  // ── 1. Load page ──────────────────────────────────────────────────────────
  console.log('\n── 1. Loading Hermes bags page ──');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await step(page, 'after-goto');

  // ── 2. Wait for products ──────────────────────────────────────────────────
  console.log('\n── 2. Waiting for products ──');
  const appeared = await page.waitForSelector('div.product-item', { timeout: 30_000 })
    .then(() => true).catch(() => false);
  console.log(`   product-item appeared: ${appeared}`);
  await step(page, 'products-loaded');

  if (!appeared) {
    console.error('No products found. Saving HTML and exiting.');
    const html = await page.content();
    writeFileSync(join(OUT_DIR, 'no-products.html'), html, 'utf-8');
    await browser.close();
    process.exit(1);
  }

  // ── 3. Check for DataDome / bot challenge ──────────────────────────────────
  console.log('\n── 3. Checking for bot challenge ──');
  const ddChallenge = await page.evaluate(() => {
    const dd = document.querySelector('div[id^="ddChallengeContainer"]') as HTMLElement | null;
    const iframe = document.querySelector('iframe[src*="datadome"]') as HTMLElement | null;
    const recaptcha = document.querySelector('iframe[src*="recaptcha"]') as HTMLElement | null;
    return {
      datadome: !!dd,
      datadomeIframe: !!iframe,
      recaptcha: !!recaptcha,
      title: document.title,
    };
  });
  console.log('   bot challenge check:', JSON.stringify(ddChallenge));
  await step(page, 'bot-check');

  // ── 4. Find filter button ─────────────────────────────────────────────────
  console.log('\n── 4. Looking for filter button ──');
  const filterBtn = page.locator('button[aria-controls="tray-grid-filters"]').first();
  const filterVisible = await filterBtn.isVisible({ timeout: 5_000 }).catch(() => false);
  console.log(`   filter button visible: ${filterVisible}`);

  if (!filterVisible) {
    // Try to find any button that might be the filter
    const allButtons = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button')).map(b => ({
        text: b.textContent?.trim().slice(0, 40),
        ariaLabel: b.getAttribute('aria-label'),
        ariaControls: b.getAttribute('aria-controls'),
        id: b.id,
      })).filter(b => b.text || b.ariaLabel)
    );
    console.log('   visible buttons on page:');
    allButtons.slice(0, 15).forEach(b => console.log('    ', JSON.stringify(b)));
  }

  await step(page, 'filter-button-check');

  if (!filterVisible) {
    console.warn('Filter button not found. Exiting here for inspection.');
    const html = await page.content();
    writeFileSync(join(OUT_DIR, 'no-filter-button.html'), html, 'utf-8');
    await browser.close();
    process.exit(0);
  }

  // ── 5. Click filter button ────────────────────────────────────────────────
  console.log('\n── 5. Clicking filter button ──');
  await filterBtn.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(500);
  await filterBtn.click();
  await sleep(1500);
  await step(page, 'after-filter-click');

  // ── 6. Wait for filter tray ───────────────────────────────────────────────
  console.log('\n── 6. Waiting for filter tray ──');
  const tray = page.locator('div.tray-slide').first();
  const trayVisible = await tray.isVisible({ timeout: 5_000 }).catch(() => false);
  console.log(`   tray visible: ${trayVisible}`);
  await step(page, 'filter-tray');

  if (!trayVisible) {
    console.warn('Filter tray did not open.');
    const html = await page.content();
    writeFileSync(join(OUT_DIR, 'no-tray.html'), html, 'utf-8');
    await browser.close();
    process.exit(0);
  }

  // ── 7. Find in-stock toggle ───────────────────────────────────────────────
  console.log('\n── 7. Looking for in-stock toggle ──');
  const toggle = page.locator('h-switch-button label.label-container').first();
  const toggleVisible = await toggle.isVisible({ timeout: 3_000 }).catch(() => false);
  console.log(`   toggle visible: ${toggleVisible}`);

  if (!toggleVisible) {
    // Dump what's inside the tray
    const trayHtml = await tray.innerHTML().catch(() => '(error)');
    console.log('   tray inner HTML (first 500 chars):', trayHtml.slice(0, 500));
  }

  await step(page, 'toggle-check');

  if (!toggleVisible) {
    console.warn('Toggle not found. Exiting.');
    await browser.close();
    process.exit(0);
  }

  // ── 8. Click toggle ───────────────────────────────────────────────────────
  console.log('\n── 8. Clicking in-stock toggle ──');
  await toggle.click({ timeout: 5_000 }).catch((e: unknown) => {
    console.warn('   toggle click failed:', e instanceof Error ? e.message : e);
  });
  await sleep(1000);
  await step(page, 'after-toggle-click');

  // ── 9. Find Apply button ──────────────────────────────────────────────────
  console.log('\n── 9. Looking for Apply button ──');
  const applyBtn = page.locator('button[data-testid="Apply"]').first();
  const applyVisible = await applyBtn.isVisible({ timeout: 3_000 }).catch(() => false);
  console.log(`   Apply button visible: ${applyVisible}`);

  if (!applyVisible) {
    // Look for any button inside the tray
    const trayButtons = await page.evaluate(() =>
      Array.from(document.querySelectorAll('div.tray-slide button')).map(b => ({
        text: b.textContent?.trim(),
        testId: b.getAttribute('data-testid'),
      }))
    );
    console.log('   buttons inside tray:', JSON.stringify(trayButtons));
  }

  await step(page, 'apply-button-check');

  if (!applyVisible) {
    console.warn('Apply button not found. Exiting.');
    await browser.close();
    process.exit(0);
  }

  // ── 10. Click Apply ───────────────────────────────────────────────────────
  console.log('\n── 10. Clicking Apply ──');
  await applyBtn.click({ timeout: 5_000 }).catch((e: unknown) => {
    console.warn('   Apply click failed:', e instanceof Error ? e.message : e);
  });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {
    console.warn('   networkidle timed out');
  });
  await sleep(1000);
  await step(page, 'after-apply');

  // ── Done ──────────────────────────────────────────────────────────────────
  const finalCount = await page.$$eval('div.product-item', (els: any[]) => els.length).catch(() => 0);
  console.log(`\n✓ Done. Final product count: ${finalCount}`);
  console.log(`  Screenshots saved to: ${OUT_DIR}`);

  if (!HEADLESS) {
    console.log('  (keeping browser open for 5s)');
    await sleep(5000);
  }

  await browser.close();
})().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
