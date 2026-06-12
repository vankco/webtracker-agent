/**
 * Simulates the exact flow scrapePageText uses before calling extractHermesProducts:
 * 1. page.goto(about:blank)
 * 2. page.goto(filteredUrl, domcontentloaded)
 * 3. page.waitForLoadState(networkidle)
 * Then calls extractHermesProducts and reports count.
 */
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { extractHermesProducts } from '../plugins/hermes/index.js';

chromium.use(StealthPlugin());

const FILTERED_URL = 'https://www.hermes.com/us/en/category/leather-goods/bags-and-clutches/womens-bags-and-clutches/#fh_view_size=48&country=us&fh_refpath=5d7a0351-0e21-412e-90bc-b43ff58cd60f&fh_refview=lister&fh_reffacet=display_state_us&fh_location=%252f%252fcatalog01%252fen_US%252fis_visible%253e%257bus%257d%252fis_searchable%253e%257bus%257d%252fis_sellable%253e%257bus%257d%252fhas_stock%253e%257bus%257d%252fitem_type%253dproduct%252fcategories%253c%257bcatalog01_leathergoods_leathergoodsbagsandclutches_womenbagsandclutches%257d%252fdisplay_state_us%253e%257becom%253becom_display%257d|';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  // Exact sequence from navigateWithFallback in scraper.ts
  console.log('Step 1: goto about:blank');
  await page.goto('about:blank').catch(() => {});

  console.log('Step 2: goto filteredUrl (domcontentloaded)');
  await page.goto(FILTERED_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  console.log('Step 3: waitForLoadState networkidle');
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

  const domCount = await page.$$eval('div.product-item', els => els.length).catch(() => 0);
  console.log(`DOM count before extractHermesProducts: ${domCount}`);
  console.log(`Current URL: ${page.url().slice(0, 80)}...`);

  console.log('\nCalling extractHermesProducts...');
  const products = await extractHermesProducts(page);
  console.log(`\nResult — total: ${products.length} | available: ${products.filter(p => p.available).length} | unavailable: ${products.filter(p => !p.available).length}`);

  await browser.close();
})();
