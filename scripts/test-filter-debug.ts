/**
 * Step-by-step debug of the warm-up block to see where 30 items come from.
 */
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

const FILTERED_URL = 'https://www.hermes.com/us/en/category/leather-goods/bags-and-clutches/womens-bags-and-clutches/#fh_view_size=48&country=us&fh_refpath=5d7a0351-0e21-412e-90bc-b43ff58cd60f&fh_refview=lister&fh_reffacet=display_state_us&fh_location=%252f%252fcatalog01%252fen_US%252fis_visible%253e%257bus%257d%252fis_searchable%253e%257bus%257d%252fis_sellable%253e%257bus%257d%252fhas_stock%253e%257bus%257d%252fitem_type%253dproduct%252fcategories%253c%257bcatalog01_leathergoods_leathergoodsbagsandclutches_womenbagsandclutches%257d%252fdisplay_state_us%253e%257becom%253becom_display%257d|';
const BASE_URL = FILTERED_URL.split('#')[0];

const count = (page: any) => page.$$eval('div.product-item', (els: any[]) => els.length).catch(() => 0);

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  // Simulate navigateWithFallback(filteredUrl) from scraper.ts
  console.log('[1] goto about:blank');
  await page.goto('about:blank').catch(() => {});

  console.log('[2] goto filteredUrl');
  await page.goto(FILTERED_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  console.log(`    DOM count: ${await count(page)} | URL: ${page.url().slice(0, 60)}...`);

  // Now simulate extractHermesProducts warm-up
  console.log('\n[3] (warm-up) goto baseUrl');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  await page.waitForSelector('div.product-item', { timeout: 20_000 }).catch(() => {});
  console.log(`    DOM count: ${await count(page)} | URL: ${page.url().slice(0, 60)}...`);

  console.log('\n[4] (warm-up) hash navigate to filteredUrl, waiting for bck API response');
  const countBefore = await count(page);
  console.log(`    countBefore: ${countBefore}`);

  // Listen for the API call
  page.on('response', (r: any) => {
    if (r.url().includes('bck.hermes.com/products')) {
      console.log(`    ✅ bck.hermes.com/products responded: ${r.status()}`);
    }
  });

  await Promise.all([
    page.waitForResponse(
      (r: any) => r.url().includes('bck.hermes.com/products'),
      { timeout: 15_000 }
    ).catch(() => { console.log('    ⚠️  bck API response timed out'); }),
    page.evaluate((url: string) => { window.location.href = url; }, FILTERED_URL),
  ]);

  console.log(`    DOM count right after Promise.all: ${await count(page)}`);

  // Wait for DOM to change
  await page.waitForFunction(
    (before: number) => document.querySelectorAll('div.product-item').length !== before,
    countBefore,
    { timeout: 10_000 }
  ).catch(() => { console.log('    ⚠️  DOM count never changed from', countBefore); });

  console.log(`    DOM count after waitForFunction: ${await count(page)}`);
  console.log(`    URL: ${page.url().slice(0, 80)}...`);

  await browser.close();
})();
