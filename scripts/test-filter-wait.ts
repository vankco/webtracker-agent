/**
 * Tests whether waiting after hash navigation to the filtered URL produces 13 products.
 * Usage: tsx scripts/test-filter-wait.ts
 */
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

const FILTERED_URL = 'https://www.hermes.com/us/en/category/leather-goods/bags-and-clutches/womens-bags-and-clutches/#fh_view_size=48&country=us&fh_refpath=5d7a0351-0e21-412e-90bc-b43ff58cd60f&fh_refview=lister&fh_reffacet=display_state_us&fh_location=%252f%252fcatalog01%252fen_US%252fis_visible%253e%257bus%257d%252fis_searchable%253e%257bus%257d%252fis_sellable%253e%257bus%257d%252fhas_stock%253e%257bus%257d%252fitem_type%253dproduct%252fcategories%253c%257bcatalog01_leathergoods_leathergoodsbagsandclutches_womenbagsandclutches%257d%252fdisplay_state_us%253e%257becom%253becom_display%257d|';
const BASE_URL = FILTERED_URL.split('#')[0];

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  // Step 1: load base URL (warm-up)
  console.log('Step 1: Loading base URL...');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('div.product-item', { timeout: 30_000 });
  const baseCount = await page.$$eval('div.product-item', els => els.length);
  console.log(`  DOM count after base URL: ${baseCount}`);

  // Step 2: hash navigate to filtered URL
  console.log('\nStep 2: Hash navigating to filtered URL...');
  await page.evaluate((url) => { window.location.href = url; }, FILTERED_URL);

  // Poll DOM count every 2s for up to 20s to see when/if it drops to 13
  console.log('\nPolling DOM count every 2s for up to 20s:');
  for (let i = 1; i <= 10; i++) {
    await new Promise(r => setTimeout(r, 2_000));
    const count = await page.$$eval('div.product-item', els => els.length).catch(() => 0);
    const url = page.url();
    console.log(`  ${i * 2}s — DOM count: ${count} | URL: ${url.slice(0, 80)}...`);
    if (count === 13) {
      console.log('\n  ✅ Got 13! Filter applied correctly after hash navigation.');
      break;
    }
  }

  await browser.close();
})();
