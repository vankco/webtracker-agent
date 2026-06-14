# Multi-Site Tracking

## Context
The app currently tracks a **single** website: `AppConfig.target: { url, selector }`, one
`state.json` object, and a single recursive-`setTimeout` monitor loop. The goal is to track
**multiple URLs at once** on a single machine — each site with its own state, its own check
cadence, and its own Discord alerts — while existing single-site `config.json` files keep
booting unchanged. This is the standalone, JSON-persistence feature; the separate Turso plan
(`turso-db-support-for-multiservers.md`) later swaps storage for multi-machine use and assumes
this is done first.

This plan was rewritten against the current codebase (verified June 2026). Notably: there is
**no pre-work** — `npm run typecheck` is clean and `scraper.ts` is already plugin-agnostic
(all Hermes logic lives in `plugins/hermes/index.ts`). The old plan's "fix 3 TS errors in
scraper.ts" step is obsolete and removed.

## Design note: async-ready persistence
The Turso plan will make per-site persistence **async**. To avoid a sync→async ripple later,
the new per-site state helpers (Step 2) and their callers are introduced **async from the
start** (`Promise`-returning), even though the JSON bodies are synchronous under the hood.
Callers in `monitor-controller.ts` / `api.ts` already run inside async functions, so this is
cheap now and free later.

---

## Step 1 — Config: `src/config.ts`
Add `SiteConfig`:
```typescript
export interface SiteConfig {
  id: string;
  url: string;
  selector: string;
  enabled: boolean;
  label?: string;
  intervalMs?: number;   // per-site override; falls back to schedule.intervalMs
}
```
- `AppConfig` gains `sites: SiteConfig[]`. Keep `target: TargetConfig` as a **derived alias**
  for `sites[0]` (read) so the rest of the codebase and existing tests keep compiling.
- **Migration on load** (in `loadAppConfig` / `loadAppConfigLenient`): if no `sites` present,
  synthesize `[{ id: generateSiteId(url), url, selector, enabled: true }]` from the legacy
  `targetUrl`/`targetSelector`. Add `generateSiteId(url)` = URL-host slug + 6-char random suffix.
- Extend `ConfigStore` with: `getSites()`, `addSite(Omit<SiteConfig,'id'>)`,
  `updateSite(id, patch)`, `removeSite(id)` (reject removing the last site). Each mutator keeps
  `target` in sync with `sites[0]`.
- `validateAppConfig`: require ≥1 enabled site each with a non-empty `url` (replacing the single
  `target.url` check). Keep the Discord-webhook and enabled-LLM-provider checks as-is.
- `getSafeConfig` / `SafeAppConfig`: add `sites: SiteConfig[]`.
- `saveJsonConfig`: serialize `sites` back to `config.json` (add a `sites` field to `JsonConfig`).

## Step 2 — State: `src/state.ts`
Change `state.json` from one `MonitorState` to a **map keyed by site id**:
```jsonc
{ "hermes-bags-abc123": { "url": "...", "lastContent": "...", "lastChecked": "...", "lastProducts": [], "history": [] } }
```
Add (async-returning, see design note):
- `loadAllState(): Promise<Record<string, MonitorState>>` — auto-migrates an old single-object
  file: if the parsed JSON has a top-level `url`, wrap it as `{ [generateSiteId(url)]: old }`.
- `saveAllState(map)`, `loadSiteState(siteId)`, `saveSiteState(siteId, state)`.
- Keep `appendHistory()` as-is (pure helper, sync) and `MAX_HISTORY = 500`.
- Keep the old `loadState`/`saveState` as thin deprecated shims (used by the CLI/`/predict`
  path until those are updated in Steps 3–4).

## Step 3 — Monitor loop: `src/monitor-controller.ts`
- Replace the single status fields (`lastCheck`, `lastResult`, `nextCheck`, `recentErrors`,
  `recentSnapshots`, `emptyBackoff`) with a **per-site map**:
  `private siteStatus = new Map<string, SiteStatus>()` where `SiteStatus` holds those same
  fields per site.
- Rename `runCheck(config)` → `runCheckForSite(site, config)`; replace every `config.target`
  read with the passed `site`, and use `loadSiteState(site.id)` / `saveSiteState(site.id, …)`.
- Keep the **single recursive `setTimeout` tick** but make it a short scheduler tick: each
  enabled site carries its own `nextCheckAt`; on each tick, run `runCheckForSite` for any due
  site (sequentially, to keep one browser context at a time), then set
  `nextCheckAt = now + (site.intervalMs ?? schedule.intervalMs)`. Preserve the existing ±20%
  jitter and 2× empty-scrape backoff **per site** (move those into `SiteStatus`).
- `getStatus(configStore)` returns `MultiSiteMonitorStatus`:
  `{ running, nextCheck?, sites: Record<id, SiteStatus & { url; label? }> }`.
- `findPlugin(url)` stays per-URL (already URL-based) — called inside `runCheckForSite`.

## Step 4 — API: `src/api.ts` + `src/api-types.ts`
- New site CRUD (mirror the existing `ok()`/error envelope style):
  `GET /api/sites`, `POST /api/sites`, `GET /api/sites/:id`, `PUT /api/sites/:id`,
  `DELETE /api/sites/:id` (404 on unknown id, 422 when deleting the last site). Each writes
  through `ConfigStore` then `persistConfig()`.
- `GET /api/monitor/status` → `MultiSiteMonitorStatus`.
- `POST /api/predict` takes a `{ siteId }` body and reads that site's history via
  `loadSiteState(siteId)` (replacing the current global `loadState()`).
- `PUT /api/config` keeps working for schedule/browser/notifications; its optional `target`
  patch maps onto `sites[0]` for single-site backward compat.
- `POST /api/validate/scrape` is unchanged (stateless).
- `api-types.ts`: add `SiteConfig`, `SiteStatus`, `MultiSiteMonitorStatus`, and the site CRUD
  request/response types; change `GetMonitorStatusResponse` to `MultiSiteMonitorStatus`; add
  `siteId` to the predict request type.

## Step 5 — Client types + API client: `client/src/api/types.ts`, `client/src/api/client.ts`
- Mirror the new types in `client/src/api/types.ts` (`SiteConfig`, `SiteStatus`,
  `MultiSiteMonitorStatus`, CRUD shapes). Add `sites` to `SafeAppConfig`.
- Add an `api.sites` group (`list`, `add`, `get`, `update`, `remove`) to the existing `api`
  object; change `api.monitor.status()` return type to `MultiSiteMonitorStatus`; add `siteId`
  to `api.predict()`.

## Step 6 — UI: `client/src/pages/MonitorPage.tsx`
- Add a **site list panel** (per-site badge: changed / no-change / error, plus interval).
  Selecting a site drives the existing detail cards (Last Check, Next Check, Last Result,
  Predictions, Errors, Snapshots, Scrape Validator) from `status.sites[selectedId]`. Auto-select
  the first site; persist selection in component state.
- Start/Stop and the polling cadence (5s running / 15s stopped) stay global.
- Predictions call `api.predict({ siteId: selectedId })`.

## Step 7 — UI: `client/src/pages/ConfigPage.tsx`
- Replace the single **Target** card with a **Tracked Sites** section: a row per site (URL,
  selector, label, per-site interval with global-default hint, enabled toggle, Remove — disabled
  when only one site), plus an **Add Site** form (URL + optional selector/label). Rows call
  `api.sites.update/add/remove`; refresh the list after each.
- Schedule, Notifications, and Browser cards are unchanged.

---

## Files NOT changing
- `src/scraper.ts` (already plugin-agnostic), `src/llm.ts`, `src/analyzer.ts`, `src/notifier.ts`,
  `plugins/hermes/index.ts`, `src/predictor.ts`
- `client/src/pages/ProvidersPage.tsx`, `DebugLogPage.tsx`, `App.tsx`
- `src/agent.ts` (already passes `configStore`; no change needed)

## Tests
- `src/__tests__/state.test.ts`: cover the old→map migration and per-site load/save (now async).
- `src/__tests__/api.test.ts`: add site CRUD route tests (add, update, delete-last-rejected,
  unknown-id-404) and assert `monitor/status` returns the multi-site shape. Update the existing
  config/predict tests for the `sites` field and `siteId` predict body.
- Keep using the in-test mocks already present (`scraper.js`, `llm.js`, `notifier.js`, `state.js`).

## Verification
1. `npm run typecheck` (root + client) and `npm test` — green.
2. `npm start`, open the UI. Existing single-site `config.json` boots unchanged (migrated to a
   one-element `sites`).
3. Add a second site in ConfigPage → it appears in the Monitor site list.
4. Start the monitor → both sites check on their own cadence; per-site status updates.
5. Disable a site → skipped in the loop. Delete a site → removed; the last site can't be deleted.
6. Run a prediction for a selected site → uses that site's history only.
