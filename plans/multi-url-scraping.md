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
export interface ScheduleWindow {
  startHour: number;     // 0–23, inclusive (in the site's timezone)
  endHour: number;       // 0–23, exclusive; may wrap past midnight (e.g. 22→6)
  intervalMs: number;    // scrape cadence while inside this window
}
export interface SiteSchedule {
  timezone?: string;     // IANA tz for the windows, e.g. 'America/Los_Angeles'. Default 'America/Los_Angeles'.
  windows?: ScheduleWindow[];  // time-of-day bands; the first match wins
  intervalMs?: number;   // cadence when no window matches (site-level default)
}
export interface SiteConfig {
  id: string;
  url: string;
  selector: string;
  enabled: boolean;
  label?: string;
  intervalMs?: number;   // per-site override; falls back to schedule.intervalMs
  schedule?: SiteSchedule;  // optional time-of-day-aware cadence; see resolution order below
}
```

**Why per-site schedules (not global):** scrape-cadence patterns are site-specific. Hermès releases
inventory in the early-morning Pacific hours (history shows ~70% of all product changes happen
06:00–11:00 PT, reliably across most days, with a weaker afternoon bump ~14:00–15:00 PT and a near-dead
16:00–06:00). A different site could drop on a different clock entirely — so each site's windows must
carry their **own `timezone`**; never assume a single global zone.

**Interval resolution order** (most specific wins), evaluated each scheduler tick:
1. The first `site.schedule.windows[]` entry whose `[startHour, endHour)` (in `site.schedule.timezone`)
   contains the current time → its `intervalMs`.
2. Else `site.schedule.intervalMs`.
3. Else the plugin's `suggestedSchedule` (see Step 3a) resolved the same way.
4. Else `site.intervalMs`.
5. Else the global `schedule.intervalMs`.

A site with no `schedule` and no plugin default behaves exactly as today (flat interval) — fully
backward-compatible.
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
  `nextCheckAt = now + resolveIntervalMs(site, plugin, schedule, Date.now())`. Preserve the
  existing ±20% jitter and 2× empty-scrape backoff **per site** (move those into `SiteStatus`).
- Add `resolveIntervalMs(site, plugin, globalSchedule, nowMs)` implementing the resolution order
  from Step 1. To evaluate a window, compute the current hour **in the schedule's `timezone`** via
  `Intl.DateTimeFormat(undefined, { timeZone, hour: '2-digit', hourCycle: 'h23' })` (same approach
  as `formatPacific`/`toPacific`), and handle windows that wrap past midnight
  (`startHour > endHour` ⇒ match if `hour >= startHour || hour < endHour`). Log the chosen
  band/interval at `debug` so the active tier is visible in `logs.jsonl`.

## Step 3a — Plugin-provided default schedule
- `src/plugin-types.ts`: add optional `suggestedSchedule?: SiteSchedule` to `SitePlugin` — lets a
  plugin ship sensible cadence defaults intrinsic to that site, used when the site's own config
  omits a schedule (resolution order step 3).
- `plugins/hermes/index.ts`: set `suggestedSchedule` from the observed pattern, e.g.
  `{ timezone: 'America/Los_Angeles', intervalMs: 30*60_000, windows: [
     { startHour: 6, endHour: 11, intervalMs: 120_000 },   // peak morning drops — aggressive
     { startHour: 11, endHour: 16, intervalMs: 600_000 },  // afternoon bump — moderate
     { startHour: 16, endHour: 6, intervalMs: 45*60_000 }, // overnight — sparse (wraps midnight)
   ] }`.
- `runCheckForSite` already resolves the plugin via `findPlugin(site.url)`; pass it to
  `resolveIntervalMs` so the plugin default is available without a separate lookup.
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
- Per-site **schedule editor** (collapsible, optional): timezone select + a list of
  `{ startHour, endHour, intervalMs }` window rows, with a "default cadence" field for
  out-of-window hours. Show the plugin's `suggestedSchedule` as a prefill/"Use suggested" button
  when the site matches a plugin and has none set. Empty = inherit (flat interval).
- Schedule (global), Notifications, and Browser cards are unchanged.

---

## Files NOT changing
- `src/scraper.ts` (already plugin-agnostic), `src/llm.ts`, `src/analyzer.ts`, `src/notifier.ts`
- `client/src/pages/ProvidersPage.tsx`, `DebugLogPage.tsx`, `App.tsx`
- `src/agent.ts` (already passes `configStore`; no change needed)

> **Note:** `plugins/hermes/index.ts` *does* change now (Step 3a adds `suggestedSchedule`).
> Also, this plan predates v4.2.0, which **removed the Predictions feature** (`/predict`,
> `src/predictor.ts`, the Monitor-page Predictions card). The `POST /api/predict` / `api.predict()` /
> Predictions-card references in Steps 4–6 are stale and should be dropped when implementing — the
> Discord `/ask` Q&A already reads per-site history. Resolve this before starting.

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
