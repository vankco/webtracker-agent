/**
 * One-shot comparison: scrape base URL vs filtered URL and compare available/unavailable counts.
 * Usage: tsx scripts/test-url-compare.ts
 */
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { extractHermesProducts } from '../plugins/hermes/index.js';

chromium.use(StealthPlugin());

const FILTERED_URL = 'https://www.hermes.com/us/en/category/leather-goods/bags-and-clutches/womens-bags-and-clutches/#fh_view_size=48&country=us&fh_refpath=5d7a0351-0e21-412e-90bc-b43ff58cd60f&fh_refview=lister&fh_reffacet=display_state_us&fh_location=%252f%252fcatalog01%252fen_US%252fis_visible%253e%257bus%257d%252fis_searchable%253e%257bus%257d%252fis_sellable%253e%257bus%257d%252fhas_stock%253e%257bus%257d%252fitem_type%253dproduct%252fcategories%253c%257bcatalog01_leathergoods_leathergoodsbagsandclutches_womenbagsandclutches%257d%252fdisplay_state_us%253e%257becom%253becom_display%257d|';
const BASE_URL = FILTERED_URL.split('#')[0];

async function scrapeUrl(label: string, url: string) {
  console.log(`\n--- Scraping ${label} ---`);
  console.log(url);

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

  const products = await extractHermesProducts(page);
  await browser.close();

  const available = products.filter(p => p.available).length;
  const unavailable = products.filter(p => !p.available).length;
  console.log(`Total: ${products.length} | Available: ${available} | Unavailable: ${unavailable}`);
  return products;
}

(async () => {
  const [baseProducts, filteredProducts] = await Promise.all([
    scrapeUrl('BASE URL', BASE_URL),
    scrapeUrl('FILTERED URL', FILTERED_URL),
  ]);

  console.log('\n=== Summary ===');
  console.log(`Base URL     — total: ${baseProducts.length}, available: ${baseProducts.filter(p => p.available).length}, unavailable: ${baseProducts.filter(p => !p.available).length}`);
  console.log(`Filtered URL — total: ${filteredProducts.length}, available: ${filteredProducts.filter(p => p.available).length}, unavailable: ${filteredProducts.filter(p => !p.available).length}`);
})();
