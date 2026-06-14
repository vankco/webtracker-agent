# Add Claude as a third LLM provider

## Context

The app analyzes web changes and predicts availability via a multi-provider LLM
layer that tries providers in priority order, falling back to a local diff
(see [src/llm.ts](../src/llm.ts), [src/predictor.ts](../src/predictor.ts)). Today only
**Gemini** and **Groq** are wired up. This adds **Claude (Anthropic)** as a third
provider so users can run continuous monitoring on Anthropic models — default
`claude-haiku-4-5` (fast/cheap), overridable to `claude-sonnet-4-6`.

Built on the post-v4.0.0 typed-config architecture: config flows `CLI flags > config.json`,
the internal currency is the typed `JsonConfig` (`mergeConfig`/`buildAppConfig`), and
**secrets get no CLI flags**. So `anthropicApiKey` stays a `config.json`/UI-only secret;
the operational `--claude*` knobs become flags.

Same pass: **cap history sent to any LLM to the last ~50 entries** (today the full
stored history — up to 500 — is serialized into prompts, which is expensive per-token).

### Claude API facts (from the claude-api skill — do not deviate)
- SDK: `@anthropic-ai/sdk`; `new Anthropic({ apiKey, timeout, maxRetries })` (same option
  shape as the Groq client already used).
- Call: `client.messages.create({ model, max_tokens, system, messages: [{ role: 'user', content }] })`.
  Read text via `response.content` blocks narrowed by `block.type === 'text'`.
- Model IDs `claude-haiku-4-5` and `claude-sonnet-4-6` are complete as-is — **no date suffixes**.
- **Haiku 4.5 does NOT support `effort` or adaptive `thinking`** (they 400). Send neither.
- **Omit `temperature`/`top_p`/`top_k`** — they 400 on Opus 4.7/4.8, so leaving them out keeps
  the adapter forward-compatible if a user overrides `model` to an Opus tier.
- Errors: catch via typed classes (`Anthropic.APIError`); the existing `tryEachProvider`
  failover already wraps each call, so just let errors propagate.

## Implementation

### 1. Dependency
`npm install @anthropic-ai/sdk` (adds to `package.json` dependencies). Run from repo root.

### 2. `src/config.ts` — typed config wiring
- `LlmProviderId` → `'gemini' | 'groq' | 'claude'`.
- `JsonConfig.llm` → add a `claude?: { enabled?, apiKey?, model?, priority?, timeoutMs?, maxRetries? }`
  block (mirror the `groq` block at [config.ts:233](../src/config.ts:233)).
- `parseProviderConfig` → append a `claude` `LlmProviderConfig`: `enabled: c.enabled ?? Boolean(claudeApiKey)`,
  `priority: Math.max(1, c.priority ?? 3)`, `model: (c.model || 'claude-haiku-4-5').trim()`,
  defaults `timeoutMs 30_000` / `maxRetries 1`. Return `[gemini, groq, claude]`.
- `KNOWN_PROVIDER_MODELS.claude` → `{ models: [{id:'claude-haiku-4-5',tier:'paid'},
  {id:'claude-sonnet-4-6',tier:'paid'},{id:'claude-opus-4-8',tier:'paid'}], default: 'claude-haiku-4-5' }`.
- `saveJsonConfig` → find provider `id === 'claude'` and write its block back (mirror the groq branch
  at [config.ts:327](../src/config.ts:327)).

### 3. `src/cli-args.ts` — non-secret flags
- Add `'Claude'` to `OptGroup` and to `groupsOrder` in `formatHelp`.
- Add a `claude(cfg)` ensure-helper (mirror `groq()` at [cli-args.ts:44](../src/cli-args.ts:44)).
- Add rows: `--claudeEnabled` (bool), `--claudeModel` (string), `--claudePriority` (int),
  `--claudeTimeoutMs` (int), `--claudeMaxRetries` (int). **No `--claudeApiKey`** (secret).
- Update the secrets footer line ([cli-args.ts:249](../src/cli-args.ts:249)) to also name `anthropicApiKey`.

### 4. `src/llm.ts` — change-detection adapter
- `import Anthropic from '@anthropic-ai/sdk';`
- Add `analyzeWithClaude(url, oldContent, newContent, provider)` mirroring `analyzeWithGroq`
  ([llm.ts:38](../src/llm.ts:38)): require `provider.apiKey`; `new Anthropic({ apiKey, timeout: provider.timeoutMs, maxRetries: provider.maxRetries })`;
  `messages.create({ model: provider.model, max_tokens: 1024, system: MONITOR_SYSTEM_PROMPT,
  messages: [{ role: 'user', content: buildMonitorUserPrompt(url, oldContent, newContent) }] })`;
  concatenate `text` blocks, trim, throw on empty, `return parseLlmJson<AnalysisResult>(raw)`.
- Dispatch: in `defaultLlmAnalyzer.analyze`, add `if (provider.id === 'claude') return analyzeWithClaude(...)`.

### 5. `src/predictor.ts` — prediction adapter
- `import Anthropic from '@anthropic-ai/sdk';`
- Add `predictWithClaude(url, historyText, provider)` mirroring `predictWithGroq`
  ([predictor.ts:74](../src/predictor.ts:74)): `messages.create({ model, max_tokens: 2048,
  system: PREDICTION_SYSTEM_PROMPT, messages: [{ role: 'user', content: buildPredictionPrompt(url, historyText) }] })`;
  `return parsePrediction(raw)`.
- Dispatch in `predictAvailability` ([predictor.ts:114](../src/predictor.ts:114)): add the `claude` branch.

### 6. `src/bot-qa.ts` — Q&A (`/ask`) adapter
`/api/ask` ([api.ts:441](../src/api.ts:441)) routes through a `qaAnswerer` in
[src/bot-qa.ts](../src/bot-qa.ts) that also dispatches per provider. Add a Claude branch there
(same `messages.create` shape, with the bot-qa prompt) so `/ask` works on Claude too. **Verify the
exact dispatch shape in bot-qa.ts first** — it's the one provider path not yet read in detail.

### 7. Cap history before sending to any LLM
History is serialized via `plugin.formatHistoryForPrediction(history)` at two call sites:
[api.ts:434](../src/api.ts:434) (`/ask`) and [api.ts:516](../src/api.ts:516) (`/predict`). Slice to the
last 50 entries (`history.slice(-50)`) at both before formatting. (Storage cap `MAX_HISTORY` in
[state.ts:32](../src/state.ts:32) is unchanged — this is a send-time cap.) Consider a small shared
`recentHistory(history)` helper to avoid drift.

### 8. UI
The Providers page is driven by `GET /api/llm/providers/models` (backed by `KNOWN_PROVIDER_MODELS`),
so Claude should appear automatically. **Verify** `client/src/pages/` has no hardcoded `gemini`/`groq`
provider list, label map, or icon switch that needs a `claude` entry added.

### 9. Tests
- `src/__tests__/provider-selection.test.ts`: claude parsed with default `claude-haiku-4-5`,
  `enabled` true when apiKey present / false otherwise, default priority 3; `getEnabledProvidersByPriority`
  orders gemini→groq→claude.
- `src/__tests__/cli-args.test.ts`: `--claudeEnabled` / `--claudeModel` / `--claudePriority` etc. populate
  `config.llm.claude`; `formatHelp()` contains the `Claude:` group and `anthropicApiKey` in the footer;
  no `--claudeApiKey` flag exists.
- llm/predictor provider tests: **mock `@anthropic-ai/sdk`** (`vi.mock`) and assert the `claude`
  dispatch path calls `messages.create` and parses output — mirror the existing groq-mock tests.
- `saveJsonConfig` round-trip includes the claude block.

### 10. Docs / cleanup
- README: add Claude to the provider list + a `config.json` `llm.claude` example; note secrets are
  config.json/UI-only.
- CLAUDE.md: once shipped, **remove** the "Claude as a third LLM provider" item from Planned work
  (same as the CLI-flags cleanup).

## Verification
1. `npm run typecheck` + `npm run ui:typecheck` — clean.
2. `npm test` — existing suite green + new claude tests.
3. `npx tsx src/agent.ts --help` → shows a `Claude:` flag group; footer lists `anthropicApiKey`.
4. Live smoke (needs a real `anthropicApiKey` in `config.json`): set `llm.claude.enabled` true with
   high priority, run a scrape, confirm a change-analysis comes back tagged `provider: "claude"`; hit
   `/api/predict` and `/api/ask` and confirm Claude answers.
5. Confirm Gemini/Groq still work (no regression in `parseProviderConfig`/dispatch).

## Risks / notes
- **No sampling/effort/thinking params** on the Claude calls — required for Haiku and forward-compatible
  with Opus overrides.
- Claude is **paid** (no free tier) — keep default `claude-haiku-4-5` and leave the provider **disabled by
  default** unless an `anthropicApiKey` is present (the `enabled ?? Boolean(apiKey)` default handles this).
- Optional enhancement: Haiku 4.5 supports structured outputs (`output_config.format`) to guarantee JSON,
  but the existing `parseLlmJson` + "JSON only" system prompt is sufficient and keeps all three adapters uniform.
