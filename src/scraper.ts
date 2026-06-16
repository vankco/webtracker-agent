import { chromium } from 'playwright-extra';
import type { BrowserContext, Page } from 'playwright';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { resolve, join } from 'node:path';
import { rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { BrowserConfig } from './config.js';
import type { SitePlugin } from './plugin-types.js';

chromium.use(StealthPlugin());

let persistentContext: BrowserContext | null = null;
let persistentPage: Page | null = null;

async function navigateWithFallback(page: Page, url: string, timeoutMs: number): Promise<void> {
  // Reset to about:blank first so the next goto is always a *real* navigation.
  // Without this, navigating to a URL that differs only by its hash fragment
  // (e.g. Hermès' "…/#|") is treated as a no-op and the SPA serves stale,
  // first-load inventory forever in a persistent session.
  await page.goto('about:blank').catch(() => {
    // Non-fatal — fall through to the real navigation.
  });

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

function killChromiumHoldingProfile(userDataDir: string): void {
  try {
    const resolved = resolve(userDataDir);
    if (process.platform === 'win32') {
      execSync(
        `powershell -NoProfile -Command "` +
        `Get-CimInstance Win32_Process -Filter \\"name='chrome.exe'\\" | ` +
        `Where-Object { $_.CommandLine -like '*${resolved.replace(/\\/g, '\\\\')}*' } | ` +
        `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
        { stdio: 'ignore', timeout: 5000 }
      );
    } else {
      execSync(`pkill -9 -f "${resolved}" 2>/dev/null || true`, { stdio: 'ignore', timeout: 5000 });
    }
  } catch {
    // Non-fatal — best-effort cleanup.
  }
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
    userDataDirOverride || '.browser-profile'
  );

  // Kill any lingering Chrome process still holding this user-data-dir, then
  // remove its singleton locks. tsx --watch kills Node but Chrome may outlive
  // the parent; a second launchPersistentContext into the same dir exits with
  // code 21 ("Failed to create a ProcessSingleton") unless we clean up first.
  killChromiumHoldingProfile(userDataDir);
  for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      rmSync(join(userDataDir, lock), { force: true });
    } catch {
      // Non-fatal — if removal fails, the launch below will surface the error.
    }
  }

  persistentContext = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless,
    slowMo: slowMoMs > 0 ? slowMoMs : undefined,
    viewport: null,
    args: headless ? [] : ['--start-maximized'],
  });

  const existingPage = persistentContext.pages()[0];
  persistentPage = existingPage ?? (await persistentContext.newPage());

  // Mimic a real browser
  await persistentPage.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
  });

  return persistentPage;
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
  selector: string | undefined,
  browserConfig: BrowserConfig,
  plugin?: SitePlugin,
  productWatchUrls?: string[]
): Promise<string> {
  // browserConfig is fully resolved by buildBrowserConfig — including the
  // manualAssisted forcing of headless=false and persistSession=true — so we
  // read its fields directly.
  const manualAssisted = browserConfig.manualAssisted;
  const persistentSession = browserConfig.persistSession;
  const headless = browserConfig.headless;
  const slowMoMs = browserConfig.slowMoMs;
  const keepOpenMs = browserConfig.keepOpenMs;
  const gotoTimeoutMs = browserConfig.gotoTimeoutMs;
  const initialManualWaitMs = browserConfig.manualAssistedInitialWaitMs;
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
      ? await getOrCreateSessionPage(headless, slowMoMs, browserConfig.userDataDir)
      : await browser!.newPage();

    if (!persistentSession) {
      // Mimic a real browser
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
      });
    }

    // Random pre-navigation delay (5–20 s) to avoid predictable request patterns
    const preNavDelay = 5_000 + Math.floor(Math.random() * 15_000);
    await new Promise((r) => setTimeout(r, preNavDelay));

    await navigateWithFallback(page, url, gotoTimeoutMs);
    await dismissNotificationBanner(page);

    if (shouldAwaitManualStep) {
      console.log('Manual-assisted mode active. Complete any verification in the open browser.');
      await waitForManualContinue(initialManualWaitMs);
      await navigateWithFallback(page, url, gotoTimeoutMs);
      await dismissNotificationBanner(page);
    }

    let text: string;

    if (plugin) {
      const products = await plugin.extractProducts(page, { productWatchUrls });
      text = plugin.productsToText(products);
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
