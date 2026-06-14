# Add Cerebras + OpenRouter as free-tier LLM providers

## Context

The app analyzes web changes, predicts availability, and answers `/ask` questions
via a multi-provider LLM layer that tries providers in priority order, falling back
to a local diff (see [src/llm.ts](../src/llm.ts), [src/predictor.ts](../src/predictor.ts),
[src/bot-qa.ts](../src/bot-qa.ts)). Today **Gemini**, **Groq**, and **Claude** are wired up.
This adds two **genuinely free-tier** providers so users can run continuous monitoring at
no cost:

- **Cerebras** — 1M tokens/day, 30 RPM, no credit card. Very fast. Default model
  `gpt-oss-120b` (Llama 3.3 70B / Qwen3 32B were deprecated Feb 2026 — do not default to them).
- **OpenRouter** — one key unlocks ~28 `:free` models (DeepSeek R1, Llama 3.3, Qwen3, Gemma).
  Quota: 50 req/day at $0 spend (1000/day if ever bought $10 credit). Good low-priority fallback.

Built on the post-v4.0.0 typed-config architecture: config flows `CLI flags > config.json`,
the internal currency is the typed `JsonConfig` (`mergeConfig`/`buildAppConfig`), and
**secrets get no CLI flags**. So `cerebrasApiKey` / `openrouterApiKey` stay `config.json`/UI-only
secrets; the operational `--cerebras*` / `--openrouter*` knobs become flags.

### Key design decision: one shared OpenAI-compatible adapter

Both providers expose the **OpenAI Chat Completions** shape — identical to what the Groq
adapter already uses (Groq SDK is OpenAI-compatible). Rather than bespoke adapters, add the
`openai` npm package once and write a single `analyzeWithOpenAICompatible(...)` helper (and
matching `predictWith*` / `askWith*`) parameterized by `baseURL` + optional headers. Both
Cerebras and OpenRouter call it. This is less code than the Groq/Claude pattern and trivially
extensible to future OpenAI-compatible providers.

- Cerebras `baseURL`: `https://api.cerebras.ai/v1`
- OpenRouter `baseURL`: `https://openrouter.ai/api/v1` (optional `HTTP-Referer` / `X-Title`
  headers for their rankings — not required for function).

### API facts (do not deviate)
- SDK: `openai` — `new OpenAI({ apiKey, baseURL, timeout, maxRetries, defaultHeaders })`.
- Call: `client.chat.completions.create({ model, messages, response_format, temperature })`
  — same shape as `analyzeWithGroq` at [llm.ts:48](../src/llm.ts:48).
- **JSON mode caveat:** Cerebras honors `response_format: { type: 'json_object' }` cleanly.
  Not every OpenRouter free model does — some 400 on it. Since `MONITOR_SYSTEM_PROMPT` already
  demands JSON and `parseLlmJson` strips fences, make `response_format` **best-effort** for
  OpenRouter (the existing `tryEachProvider` failover + local fallback covers a model that rejects it).
- Cerebras does **not** support `frequency_penalty` / `presence_penalty` / `logit_bias` — don't send them.

## Pre-existing bug to fix in passing

[api.ts:228](../src/api.ts:228) has `const VALID_IDS: LlmProviderId[] = ['gemini', 'groq'];` —
it is **missing `'claude'`**. The recent Claude work wired config/UI/CLI but not this PUT-route
allowlist, so saving Claude provider edits via `PUT /api/llm/providers` currently returns
`PROVIDER_NOT_FOUND`. Fix it to `['gemini', 'groq', 'claude', 'cerebras', 'openrouter']` and add a
regression test.

## Implementation

### 1. Dependency
`npm install openai` (adds to `package.json` dependencies). Run from repo root.

### 2. `src/config.ts` — typed config wiring
- `LlmProviderId` → add `'cerebras' | 'openrouter'`.
- `JsonConfig.llm` → add `cerebras?` and `openrouter?` blocks (mirror the `claude` block at
  [config.ts:261](../src/config.ts:261); same 6 fields).
- `parseProviderConfig` → append two `LlmProviderConfig`s:
  - cerebras: `enabled: c.enabled ?? Boolean(apiKey)`, `priority ?? 4`, `model || 'gpt-oss-120b'`.
  - openrouter: `enabled: o.enabled ?? Boolean(apiKey)`, `priority ?? 5`,
    `model || 'deepseek/deepseek-r1:free'`.
  - both default `timeoutMs 30_000` / `maxRetries 1`. Return all five in the array.
- `KNOWN_PROVIDER_MODELS` → add catalogs, all `tier: 'free'`:
  - **cerebras**: `gpt-oss-120b`, `qwen-3-235b-a22b`, `llama-3.1-8b` (default `gpt-oss-120b`).
  - **openrouter**: `deepseek/deepseek-r1:free`, `meta-llama/llama-3.3-70b-instruct:free`,
    `qwen/qwen3-coder:free`, `google/gemma-3-27b-it:free` (default `deepseek/deepseek-r1:free`).
- `mergeConfig` → add two deep-merge `if` branches (mirror the claude branch at [config.ts:320](../src/config.ts:320)).
- `saveJsonConfig` → find providers `id === 'cerebras'` / `'openrouter'` and write their blocks back.

### 3. `src/cli-args.ts` — non-secret flags
- Add `'Cerebras'` and `'OpenRouter'` to `OptGroup` and to `groupsOrder` in `formatHelp`.
- Add `cerebras(cfg)` / `openrouter(cfg)` ensure-helpers (mirror `claude()` at [cli-args.ts:51](../src/cli-args.ts:51)).
- Add rows for each: `--cerebrasEnabled` (bool), `--cerebrasModel` (string), `--cerebrasPriority` (int),
  `--cerebrasTimeoutMs` (int), `--cerebrasMaxRetries` (int); same five for `--openrouter*`.
  **No `--*ApiKey`** flags (secrets).
- Update the secrets footer line ([cli-args.ts:268](../src/cli-args.ts:268)) to also name
  `cerebrasApiKey` and `openrouterApiKey`.

### 4. `src/llm.ts` — change-detection adapter
- `import OpenAI from 'openai';`
- Add `analyzeWithOpenAICompatible(url, oldContent, newContent, provider, baseURL, extraHeaders?)`
  mirroring `analyzeWithGroq` ([llm.ts:48](../src/llm.ts:48)): require `provider.apiKey`;
  `new OpenAI({ apiKey, baseURL, timeout: provider.timeoutMs, maxRetries: provider.maxRetries, defaultHeaders: extraHeaders })`;
  `chat.completions.create({ model, messages: [system, user], response_format: { type: 'json_object' }, temperature: 0.1 })`;
  trim, throw on empty, `return parseLlmJson<AnalysisResult>(raw)`.
  For OpenRouter, wrap the `response_format` in a best-effort try (retry without it if the model 400s).
- Dispatch in `defaultLlmAnalyzer.analyze`: add
  - `if (provider.id === 'cerebras') return analyzeWithOpenAICompatible(..., 'https://api.cerebras.ai/v1');`
  - `if (provider.id === 'openrouter') return analyzeWithOpenAICompatible(..., 'https://openrouter.ai/api/v1', { 'HTTP-Referer': ..., 'X-Title': 'webtracker-agent' });`

### 5. `src/predictor.ts` — prediction adapter
- `import OpenAI from 'openai';`
- Add `predictWithOpenAICompatible(url, historyText, provider, baseURL, extraHeaders?)` mirroring
  `predictWithGroq` ([predictor.ts:76](../src/predictor.ts:76)): `chat.completions.create({ model,
  max_tokens 2048, messages: [PREDICTION_SYSTEM_PROMPT, buildPredictionPrompt(...)] })`;
  `return parsePrediction(raw)`.
- Dispatch in `predictAvailability` ([predictor.ts:138](../src/predictor.ts:138)): add `cerebras` /
  `openrouter` branches.

### 6. `src/bot-qa.ts` — Q&A (`/ask`) adapter
- `import OpenAI from 'openai';`
- Add `askWithOpenAICompatible(prompt, provider, baseURL, extraHeaders?)` mirroring `askWithGroq`
  ([bot-qa.ts:52](../src/bot-qa.ts:52)).
- Dispatch ([bot-qa.ts:96](../src/bot-qa.ts:96)): add `cerebras` / `openrouter` branches.

> Consider hoisting the three near-identical `*WithOpenAICompatible` helpers into a small shared
> module (e.g. `src/openai-compat.ts` exporting a configured client factory) to avoid drift —
> optional, but cleaner than three copies of the `new OpenAI({...})` construction.

### 7. `src/api.ts`
- **Fix `VALID_IDS`** ([api.ts:228](../src/api.ts:228)) → `['gemini', 'groq', 'claude', 'cerebras', 'openrouter']`.
- `warmModelCache` ([api.ts:123](../src/api.ts:123)): falls back to the static catalog for both new
  providers (no live model fetch initially). Both are OpenAI-compatible so a `GET /v1/models` fetch
  could be added later like `fetchGroqModels`, but is out of scope for v1.

### 8. Client UI
- [client/src/api/types.ts:6](../client/src/api/types.ts:6) — extend `LlmProviderId` union.
- [ProvidersPage.tsx:127](../client/src/pages/ProvidersPage.tsx:127) — add to `PROVIDER_DISPLAY`:
  `cerebras: 'Cerebras'`, `openrouter: 'OpenRouter'`. The page is otherwise data-driven (no other change).

### 9. Tests (extend the Claude-pattern suites)
- `provider-selection`: both parsed with correct defaults; `enabled` true/false on apiKey presence;
  priorities 4 / 5; `getEnabledProvidersByPriority` ordering.
- `cli-args`: `--cerebras*` / `--openrouter*` flags populate config; `formatHelp()` contains both
  groups and both keys in the footer; no `--*ApiKey` flags exist.
- llm/predictor/bot-qa: **mock `openai`** (`vi.mock`) and assert the `cerebras` + `openrouter`
  dispatch paths call `chat.completions.create` and parse output.
- api: regression test that `PUT /api/llm/providers` accepts `claude`, `cerebras`, `openrouter`
  (guards the `VALID_IDS` fix).
- `saveJsonConfig` round-trip includes both new blocks.

### 10. Docs / cleanup
- README: add both providers to the list + `config.json` `llm.cerebras` / `llm.openrouter` examples;
  note free-tier quotas and that secrets are config.json/UI-only.
- CLAUDE.md: once shipped, remove the "free-tier LLM providers" item from Planned work.

## Verification
1. `npm run typecheck` + `npm run ui:typecheck` — clean.
2. `npm test` — existing suite green + new tests.
3. `npx tsx src/agent.ts --help` → shows `Cerebras:` and `OpenRouter:` flag groups; footer lists both keys.
4. Live smoke (needs real keys in `config.json`): enable each with high priority, run a scrape,
   confirm change-analysis comes back tagged `provider: "cerebras"` / `"openrouter"`; hit
   `/api/predict` and `/api/ask`.
5. Confirm Gemini/Groq/Claude still work (no dispatch regression); confirm Claude is now editable
   via `PUT /api/llm/providers` (the `VALID_IDS` fix).

## Risks / notes
- **Secrets stay config.json/UI-only** — no `--*ApiKey` flags (matches convention).
- **OpenRouter JSON mode** is per-model — keep `response_format` best-effort and lean on `parseLlmJson`
  + the local-fallback chain.
- **OpenRouter free quota** (50/day at $0) makes it a low-priority fallback, not a primary.
- New top-level dep `openai` — well-maintained; one install covers both providers and any future
  OpenAI-compatible additions.
- Both default **disabled unless an apiKey is present** (`enabled ?? Boolean(apiKey)`), so adding them
  is inert until the user configures a key.

## Suggested commit breakdown (matches the Claude history)
1. `feat(llm): add Cerebras + OpenRouter via shared OpenAI-compatible adapter`
2. `fix(api): include claude/cerebras/openrouter in provider allowlist`
3. `feat(ui): show Cerebras and OpenRouter on the Providers page`
4. `test: cover the new providers' parsing, flags, and dispatch`
5. `docs: document Cerebras and OpenRouter providers`
