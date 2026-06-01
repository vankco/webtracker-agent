# Plan: Historical Data & LLM Predictions for Hermès

## Context
The monitor only keeps the latest snapshot — `saveState()` in `src/state.ts` overwrites `state.json` every cycle, so no history exists to analyze. The user wants to accumulate product data over time and use an LLM to predict future **availability** (restocks / sellouts) and **price** changes.

Phasing (per user):
- **Now:** history accumulation + manual, button-triggered prediction surfaced on the Monitor page.
- **Later:** scheduled (time-cycle) predictions + Discord push. This plan builds the foundation cleanly so "later" is a small addition.

---

## Key design decisions (refinements over the first draft)

1. **Log change events, not every cycle.** The first draft appended a snapshot on *every* `saveState` (incl. unchanged cycles). At a 5-min interval that's mostly duplicate noise and caps out at ~40h of history. Instead, append a history entry **only on the baseline run and when a change is detected**. This captures the actual restock/sellout/price-change *timeline* — exactly the signal predictions need — and 500 capped entries then represent 500 real events (much longer real-world span).

2. **Dedicated predictor, not a reuse of `analyzeWithProviders`.** `analyzeWithProviders` is hardwired to the change-detection prompt and returns `{changed, summary}`. Forcing predictions through it produces poor output. Add a parallel `src/predictor.ts` with a prediction prompt returning `{summary, insights[]}`, mirroring the existing Gemini/Groq + failover pattern. The well-tested change-detection path stays untouched.

3. **Injectable predictor** into the API router so the new endpoint is unit-testable (same pattern as `MonitorDependencies`).

---

## Files to modify

### `src/state.ts`
Add the history type, a cap, and a pure append helper:
```typescript
export interface HistoryEntry {
  timestamp: string;
  products: unknown[];      // full available-products snapshot at this event (plugin-shaped)
  availableCount: number;
  changeSummary: string;    // e.g. "2 newly available, 1 no longer available"
}

export const MAX_HISTORY = 500;

export function appendHistory(existing: HistoryEntry[] | undefined, entry: HistoryEntry): HistoryEntry[] {
  return [...(existing ?? []), entry].slice(-MAX_HISTORY);
}
```
Add `history?: HistoryEntry[]` to `MonitorState`.

### `src/monitor-controller.ts`
History is meaningful only for plugin URLs. Append at exactly two save sites:
- **Baseline branch (~line 222):** first entry, `changeSummary: 'baseline'`.
- **Plugin diff branch (~line 293):** on detected change, `changeSummary: pluginDiff.summary`.

Leave the unchanged branch (~244) and general LLM branch (~352) writing state **without** a new history entry, but they must **carry forward** `previousState?.history` so it isn't wiped. Implement a tiny helper to keep the four save sites consistent:
```typescript
// carries prior history forward; optionally appends a new event
private persist(base: MonitorState, prior: HistoryEntry[] | undefined, newEvent?: HistoryEntry) {
  const history = newEvent ? appendHistory(prior, newEvent) : prior;
  this.deps.saveState(history && history.length ? { ...base, history } : base);
}
```
`prior` comes from `previousState?.history` (null on baseline). Reuse `currentAvailable.length` for `availableCount`.

### `src/plugin-types.ts`
Add an optional method to `SitePlugin`:
```typescript
formatHistoryForPrediction?(history: HistoryEntry[]): string;
```
(Import `HistoryEntry` from `./state.js` — no circular dependency: `state.ts` imports only `fs`/`path`.)

### `plugins/hermes/index.ts`
This file defines the `SitePlugin` interface **inline** (it's a standalone package), so add the optional method to the inline interface too, with an inline-compatible history shape. Implement `formatHistoryForPrediction`: render one line per event — `timestamp — N available — changeSummary` followed by the available SKUs/prices — so the LLM can reason about per-SKU availability spans and price movement.

### `src/predictor.ts` (new)
```typescript
export interface PredictionResult {
  generatedAt: string;
  provider: string;      // 'gemini' | 'groq'
  model?: string;
  summary: string;
  insights: string[];
  historyEntryCount: number;
}

export async function predictAvailability(
  url: string, historyText: string, providers: LlmProviderConfig[]
): Promise<PredictionResult>;
```
- System prompt: "You are a product availability & pricing analyst… respond with valid JSON only."
- User prompt: the formatted history + asks for (1) likely restocks, (2) likely sellouts, (3) price trends → `{ "summary": "...", "insights": ["..."] }`.
- Same provider-priority + failover loop as `analyzeWithProviders`; reuse the Gemini (`GoogleGenAI` from `analyzer.ts`) and Groq (`groq-sdk`) call shapes incl. the markdown-fence stripping. If all providers fail, throw (the endpoint maps it to an error — no "local fallback" makes sense for prediction).

### `src/api-types.ts`
Re-export / define `PredictionResult` (mirror in client). Add error code `PREDICTION_FAILED` to the `ErrorCode` union in `src/api.ts`.

### `src/api.ts`
Add `POST /api/predict`:
- Add `findPlugin(url)` getter to `MonitorController` (registry is private) so the router can resolve the active plugin.
- Inject an optional `predictor = predictAvailability` param into `createApiRouter` / `createApiApp` for testing.
- Handler: `loadState()` → resolve plugin for `config.target.url` → guard (no plugin / no `formatHistoryForPrediction` / fewer than N history entries → `422 PREDICTION_FAILED` with a clear message) → `plugin.formatHistoryForPrediction(state.history)` → `predictor(url, text, enabledProviders)` → return `PredictionResult`.

### `client/src/api/types.ts` + `client/src/api/client.ts`
Add `PredictionResult` type and `api.predict(): Promise<PredictionResult>`.

### `client/src/pages/MonitorPage.tsx`
Add a **Predictions** card (Fluent `Card`/`CardHeader`/`Title3`, matching existing cards):
- "Run Prediction" button with a `Spinner` while loading.
- On success: render `summary` + bulleted `insights`, with `generatedAt` and provider/model.
- On error (no plugin, not enough history): show the API message inline via `MessageBar`. The card is always shown; the UI can't know plugin matches, so it relies on the endpoint's guard message.

---

## Tests (must keep ≥80% coverage)
- `src/__tests__/state.test.ts` (new): `appendHistory` appends and caps at `MAX_HISTORY`; carries undefined → single entry.
- `src/__tests__/predictor.test.ts` (new): with an injected fake provider call — parses `{summary, insights}`, fails over gemini→groq, throws when all fail.
- `src/__tests__/api.test.ts`: `POST /api/predict` with an injected fake predictor — 200 happy path, 422 when no history / no plugin.
- Extend the Hermès e2e or a plugin unit test to assert `formatHistoryForPrediction` output shape.

## Verification
1. `npm run typecheck` — clean.
2. `npm run test:coverage` — all pass, ≥80%.
3. Manual: run app through a baseline + at least one change → confirm `state.json` grows a `history` array of events (not every cycle).
4. Manual: click "Run Prediction" → Predictions card shows summary + insights; verify they're sane given the history.
5. Manual: fresh state (no/short history) → endpoint returns a clear 422 and the card shows the message.

## Out of scope (next phase)
Scheduled predictions on a time cycle + Discord push. Foundation (predictor + history) is built so this is a small follow-up: call `predictAvailability` from the monitor loop on an interval and route through `sendDiscordAlert`.
