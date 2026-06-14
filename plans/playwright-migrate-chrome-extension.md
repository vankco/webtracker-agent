# Plan: Replace Playwright with a Chrome Extension Scraper

## Context

The app uses Playwright + stealth plugin to scrape Hermès (DataDome-protected). Playwright injects detectable automation signals (CDP fingerprint, `--enable-automation`). The goal is to completely replace Playwright with a Chrome extension — the extension runs in the user's real Chrome with their actual fingerprint, profile, and cookies. No fallback to Playwright.

---

## Architecture

```
Node.js Agent
  └─ ExtensionBridge (WS server :8787)
       ⇄ ws://127.0.0.1:8787
Chrome Extension (loaded in user's real Chrome)
  └─ Background Service Worker (background.js)
       → chrome.scripting / chrome.tabs / chrome.alarms
       └─ Scrape tab (hermes.com, kept open between runs)
```

`SitePlugin.extractProducts(page)` contract is preserved — `page` becomes a `PageLike` abstraction instead of Playwright's `Page`. Only type imports and the `:has-text()` selector change in the Hermes plugin.

---

## PageLike / LocatorLike Interface (`src/page-adapter.ts`, NEW)

```ts
export interface GotoOptions { waitUntil?: 'domcontentloaded'|'load'|'networkidle'; timeout?: number; }
export interface WaitForOptions { state?: 'visible'|'hidden'|'attached'|'detached'; timeout?: number; }

export interface LocatorLike {
  first(): LocatorLike;
  locator(selector: string): LocatorLike;
  getByRole(role: string, opts?: { name?: RegExp | string }): LocatorLike;
  isVisible(opts?: { timeout?: number }): Promise<boolean>;
  click(opts?: { timeout?: number }): Promise<void>;
  waitFor(opts?: WaitForOptions): Promise<void>;
  scrollIntoViewIfNeeded(): Promise<void>;
}

export interface PageLike {
  url(): string;
  goto(url: string, opts?: GotoOptions): Promise<void>;
  waitForLoadState(state: 'networkidle'|'load'|'domcontentloaded', opts?: { timeout?: number }): Promise<void>;
  waitForSelector(selector: string, opts?: { timeout?: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;
  isClosed(): boolean;
  evaluate<R, A = undefined>(fn: (arg: A) => R, arg?: A): Promise<R>;
  $eval<R>(selector: string, fn: (el: Element) => R): Promise<R>;
  content(): Promise<string>;
  locator(selector: string): LocatorLike;
  getByRole(role: string, opts?: { name?: RegExp | string }): LocatorLike;
}
```

`LocatorLike` is a Node-side object holding a chain of refinement steps. Terminal ops serialize the chain in a WS message; the extension resolves it freshly via injected script. `RegExp` name serialized as `{source, flags}` and rebuilt extension-side.

---

## WebSocket Message Protocol (`src/extension-bridge.ts`, NEW)

**Envelope:**
- Request: `{ id: uuid, type: "op", op: string, params: object }`
- Response: `{ id, ok: true, result }` or `{ id, ok: false, error: { message, name } }`
- Unsolicited: `{ type: "hello", extVersion }` on connect; ping/pong heartbeat every 15s

**Op set:**

| op | params | result |
|----|--------|--------|
| `ensureTab` | `{}` | `{ tabId }` |
| `goto` | `{ url, waitUntil, timeout }` | `{ url }` |
| `waitForLoadState` | `{ state, timeout }` | `{}` |
| `waitForSelector` | `{ selector, timeout }` | `{ found }` |
| `evaluate` | `{ fnSource, arg }` | `{ value }` |
| `evalSelector` | `{ selector, fnSource }` | `{ value }` |
| `content` | `{}` | `{ html }` |
| `url` | `{}` | `{ url }` |
| `isClosed` | `{}` | `{ closed }` |
| `locatorIsVisible` | `{ resolver, timeout }` | `{ visible }` |
| `locatorClick` | `{ resolver, timeout }` | `{}` |
| `locatorWaitFor` | `{ resolver, state, timeout }` | `{}` |
| `locatorScrollIntoView` | `{ resolver }` | `{}` |
| `closeTab` | `{}` | `{}` |

**Error/timeout handling:** Every `send()` has a `timeoutMs`. On timeout → `BridgeTimeoutError`. On socket close mid-scrape → reject all pending promises with `BridgeDisconnectedError`. `scrapePageText` checks `bridge.isConnected()` first and throws a clear "Chrome extension not connected" error if not. All errors flow into the monitor loop's existing try/catch.

**Security:** Bind to `127.0.0.1` only. Shared token (Node generates at startup, user pastes into popup, first frame authenticates). Token stored in `chrome.storage.local`.

---

## Chrome Extension Files (`chrome-extension/`, NEW)

### `manifest.json`
Manifest V3. `permissions: ["scripting","tabs","alarms","storage","webNavigation"]`. `host_permissions: ["<all_urls>"]`. `background.service_worker: "background.js"`. `action → popup.html`.

### `background.js`
- Connects to `ws://127.0.0.1:8787`, reconnects with backoff
- Authenticates with token on first frame
- Manages one scrape tab: `tabId` in module scope + `chrome.storage.session` (survives SW restart)
- `chrome.alarms` keepalive: `chrome.alarms.create('keepalive', { periodInMinutes: 0.4 })` (~24s) — documented MV3 technique to prevent SW termination
- Op handlers:
  - `goto` → `chrome.tabs.update(tabId, { url })` + await `webNavigation.onCompleted` (frameId 0)
  - `evaluate` → `chrome.scripting.executeScript({ tabId, world: 'MAIN', func: new Function(...), args: [arg] })`
  - `locator*` → inject `resolveLocator()` helper + action via `executeScript`
  - `waitForLoadState('networkidle')` → injected polling loop: resolve when no DOM mutations for 500ms, capped by timeout
  - `waitForSelector` → injected polling loop with timeout
  - `content` → `executeScript` returning `document.documentElement.outerHTML`
  - `ensureTab` → reuse via `chrome.tabs.get` or create `{ url: 'about:blank', active: false }`

### `popup.html` + `popup.js`
Shows: WS connection status, scrape tab ID, extension version, port + token fields (stored in `chrome.storage.local`), Reconnect button.

---

## Challenge Solutions

1. **SW lifecycle** — `chrome.alarms` keepalive every ~24s. SW re-reads `tabId` from `chrome.storage.session` on cold start (self-healing). Node tolerates transient disconnects.

2. **`networkidle`** — injected polling: resolve when no DOM mutations for 500ms AND minimum settle time elapsed, capped by timeout. Already wrapped in `.catch(()=>{})` in `scraper.ts` so acceptable heuristic.

3. **`evaluate(fn, arg)`** — `fn.toString()` over the wire, rebuilt via `new Function(...)`. Constraint: **function must not close over outer variables** — true for all current usages. Add a code comment near each `evaluate` call in the Hermes plugin.

4. **Complex return values** — `executeScript` results are structured-clone-serializable. `HermesProduct[]` of plain objects serializes fine.

5. **`:has-text()` (Playwright-specific selector)** — replace in `plugins/hermes/index.ts`: use an `evaluate` to find the load-more button by text and tag it (`el.setAttribute('data-wt-loadmore','1')`), then `page.locator('[data-wt-loadmore="1"]')` for existing click/scroll/visibility flow.

6. **Tab lifecycle** — ONE scrape tab kept open between scrapes (mimics persistent session; cookies persist in real profile). Created lazily, `active: false`. Closed only on explicit `closeTab`. Document: user must not navigate/close it.

7. **Communication** — WebSocket on loopback with shared token. Simple and sufficient. Native Messaging is more secure but complex — out of scope.

8. **Error propagation** — per-call timeouts + reject-all-on-disconnect + upfront connection guard.

---

## Files to Modify

### `src/scraper.ts` — major rewrite
- Remove: all `playwright-extra`, stealth plugin, `chromium`, `launchPersistentContext`, persistent session, profile lock, `killChromiumHoldingProfile`, `getOrCreateSessionPage`, `isPersistentSessionEnabled`
- Keep: `scrapePageText` signature unchanged, `navigateWithFallback`, `dismissNotificationBanner`, `waitForManualContinue`, pre-nav random delay
- Change: obtain `PageLike` from `extensionBridge.createPageAdapter()` instead of launching a browser
- `closeScraperSession()` → calls `bridge.send('closeTab')` (never closes Chrome itself)
- `setExtraHTTPHeaders` → no-op (real Chrome sends real headers)
- Type annotation: `Page` → `PageLike` in function bodies

### `src/plugin-types.ts`
- `import type { Page } from 'playwright'` → `import type { PageLike } from './page-adapter.js'`
- `extractProducts(page: Page)` → `extractProducts(page: PageLike)`

### `plugins/hermes/index.ts`
- Remove `playwright` type import; inline `PageLike`/`LocatorLike` interface locally (plugin has no app-source deps by design)
- Apply Challenge 5 fix for `:has-text()`
- Add no-closure comments near each `evaluate` call
- All other code unchanged

### `src/config.ts`
- Remove from `BrowserConfig`: `headless`, `slowMoMs`, `keepOpenMs`, `userDataDir`, `persistSession`
- Keep: `gotoTimeoutMs`, `manualAssisted`, `manualAssistedInitialWaitMs`
- Add: `extensionBridge: { port: number, token: string, opTimeoutMs: number }` with env vars `EXTENSION_BRIDGE_PORT` (default 8787), `EXTENSION_BRIDGE_TOKEN` (auto-generated UUID if absent), `EXTENSION_OP_TIMEOUT_MS` (default 30000)
- Remove dead `BROWSER_HEADLESS`/`BROWSER_USER_DATA_DIR`/`BROWSER_SLOW_MO_MS`/`BROWSER_KEEP_OPEN_MS` mappings

### `src/agent.ts`
- Start bridge before monitor: `const bridge = startExtensionBridge(config.extensionBridge)`
- Bridge is a module-level singleton in `extension-bridge.ts` (matches existing `scraper.ts` style)
- Log bridge port + token on startup for the user to paste into popup
- `bridge.close()` in signal handlers

### `src/api.ts`
- Add `GET /api/extension/status` → `{ connected, tabId, extVersion }` for UI health card

### `package.json`
- Remove: `playwright`, `playwright-extra`, `puppeteer-extra-plugin-stealth`
- Add: `ws`, dev `@types/ws`
- Remove/repurpose `watch-browser` and `browser_mode` npm scripts (they set headless/slowMo vars that no longer apply)

### `config.json.example`
- Remove browser profile / headless settings
- Add `extensionBridge` example with port and opTimeoutMs

---

## Test Strategy

**Existing tests** (`api.test.ts`, `e2e-flow.test.ts`) already mock `scrapePageText` directly — pass unchanged.

**New unit tests:**
1. `page-adapter.ts` — locator chain serialization, RegExp → `{source,flags}`, `evaluate` fn.toString()
2. `extension-bridge.ts` — WS server + fake client: id round-trip, per-call timeout, socket-close rejects all pending, token enforcement, heartbeat
3. `ExtensionPageAdapter` integration — fake echoing WS client drives a mock plugin through `extractProducts`, asserts correct op sequence
4. Hermes plugin — assert no `:has-text()` remains; pure-function tests still pass
5. Extension JS helpers — extract `resolveLocator`/networkidle-quiet into testable pure functions

**Manual QA:**
1. Load unpacked extension in Chrome
2. Paste token into popup → shows "Connected"
3. `npm run api:dev` → POST `/api/monitor/start`
4. Observe Chrome tab open, navigate to Hermès, scroll, extract products
5. GET `/api/monitor/status` → `recentSnapshots` has data
6. Kill extension tab → confirm next scrape logs "extension not connected"
7. Reload extension → auto-reconnects → next scrape succeeds
8. `npm test` — all tests pass

---

## Risks

| Risk | Mitigation |
|------|-----------|
| SW keepalive flaky across Chrome versions | Self-healing reconnect; worst case = one skipped scrape |
| `world:'MAIN'` blocked by site CSP | Test early against real site; fallback to `ISOLATED` world for reads |
| DataDome detects injected scripts | Keep human-like delays/scrolling; real profile is still better than Playwright |
| User navigates scrape tab mid-scrape | Popup warning; document the dedicated tab |
| `evaluate` closures break for future plugins | Document constraint prominently in plugin-types.ts |
| Port 8787 conflict | Configurable; fail loudly on startup |
