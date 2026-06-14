# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Planned work

- **Replace Playwright with Chrome Extension scraper** — Full plan saved at `plans/playwright-migrate-chrome-extension.md`. Goal: eliminate Playwright automation fingerprints by running scrapes inside the user's real Chrome via a Manifest V3 extension + Node.js WebSocket bridge. Key files: `src/page-adapter.ts` (new), `src/extension-bridge.ts` (new), `chrome-extension/` (new), `src/scraper.ts` (major rewrite), `src/plugin-types.ts`, `plugins/hermes/index.ts`, `src/config.ts`. Remove `playwright`, `playwright-extra`, `puppeteer-extra-plugin-stealth` deps; add `ws`.

- **Multi-site tracking** — Full plan saved at `plans/multi-url-scraping.md`. Goal: let the app monitor many URLs at once (today it tracks a single `config.target.url`). Single machine, local JSON persistence — no database. Add `sites: SiteConfig[]` to config (keep `target` as a backward-compat alias to `sites[0]`), key `state.json` as a map per site, run the monitor loop per-site, add site CRUD API routes, and update the Monitor/Config UI for a site list + add form. Key files: `src/config.ts`, `src/state.ts`, `src/monitor-controller.ts`, `src/api.ts`, `src/api-types.ts`, `client/src/pages/MonitorPage.tsx`, `client/src/pages/ConfigPage.tsx`.

- **Turso DB support for multi-machine concurrency** — Full plan saved at `plans/turso-db-support-for-multiservers.md`. Builds on multi-site tracking. Goal: run the agent on multiple machines (Windows/Linux/macOS) concurrently against shared data. Move sites/state/history/config from local JSON files into Turso (libSQL, remote-only cloud mode) as the single source of truth; add a per-site claim/lease so concurrent machines share work without duplicate Discord alerts. Key files: `src/db.ts` (new), `src/state.ts` (async DB rewrite), `src/config.ts`, `src/monitor-controller.ts` (claim/lease), `src/agent.ts`. Add `@libsql/client` dep. No env vars (removed in v4.0.0): add `tursoDatabaseUrl` and `machineId` as `JsonConfig`/`config.json` keys with `--tursoDatabaseUrl` / `--machineId` CLI flags in `src/cli-args.ts`; keep `tursoAuthToken` a **config.json/UI-only secret** (no flag).

- **Cerebras + OpenRouter free-tier LLM providers** — Full plan saved at `plans/cerebras-openrouter-llm-providers.md`. Goal: add two genuinely free-tier providers (Cerebras: 1M tokens/day, default `gpt-oss-120b`; OpenRouter: ~28 `:free` models, low-priority fallback) alongside Gemini/Groq/Claude. Both are OpenAI-compatible, so add the `openai` dep once and use a shared `*WithOpenAICompatible` adapter parameterized by `baseURL` at all three dispatch sites. Also fixes a latent bug: `VALID_IDS` in `src/api.ts` omits `claude` (breaks `PUT /api/llm/providers` for Claude). Key files: `src/config.ts`, `src/cli-args.ts`, `src/llm.ts`, `src/predictor.ts`, `src/bot-qa.ts`, `src/api.ts`, `client/src/api/types.ts`, `client/src/pages/ProvidersPage.tsx`. Add `openai` dep.

- **Slickdeals plugin** — Build `@webtracker/plugin-slickdeals` to track deals on Slickdeals.net (community deals site; deals rated by "temperature" °). Could track deals matching keywords or high-temperature frontpage postings. Follow the plugin pattern in `plugins/hermes/index.ts` — implement the `SitePlugin` interface with Slickdeals-specific DOM parsing (inspect their deal-listing markup first). Register via `plugins` in `config.json`.

## Working conventions

- **Never switch git branches without explicit confirmation from the user.**
- **Changes to app code** (`src/`, `plugins/`, `client/src/`, `scripts/`) — show the diff and wait for user review before committing.
- **Non-app changes** (`CLAUDE.md`, `README.md`, `.gitignore`, config examples, docs) — can be committed automatically without review.

## Commands

```bash
# Install dependencies (root + client + plugins)
npm install

# Start full app (API + UI + health monitor + discord bot)
npm start

# Stop the app (cross-platform)
npm stop

# API only (with file watching)
npm run api:dev

# Run tests
npm test
npm run test:watch
npm run test:coverage

# Run a single test file
npx vitest run src/__tests__/api.test.ts

# Typecheck
npm run typecheck          # root
npm run ui:typecheck       # UI (client/)

# Debug modes (run in a real terminal, not background — require visible desktop)
npm run debug              # continuous headed browser + API on 3001, 250ms slow-mo
npm run debug:once         # run once with visible browser, then exit
npm run test:hermes        # standalone Hermes navigation test (scripts/test-hermes-simple.ts)
npm run browser_mode       # persistent visible browser (for manual login)

# See every CLI flag
npx tsx src/agent.ts --help
```

> **No shell env vars.** Operational settings are passed as CLI flags
> (e.g. `tsx src/agent.ts --apiPort 3001 --browserHeadless=false`); secrets
> (API keys, Discord bot token, webhook URLs) live in `config.json` only.
> `npm stop` uses `scripts/stop.mjs` (cross-platform Node.js).

## Architecture

### Two runtime modes

`src/agent.ts` is the entry point and branches on the `--apiPort` flag:

- **API mode** (`--apiPort 3001`): starts Express API + auto-starts monitor if config is valid. This is the normal `npm start` path.
- **CLI mode** (no `--apiPort`): strict config load → immediate monitor loop. Used by `debug:once`, `watch-browser`, and `browser_mode`.

### Core pipeline

```
scraper.ts → monitor-controller.ts → analyzer.ts / plugin → notifier.ts → Discord
```

1. **`scraper.ts`** — Playwright scrapes the target URL. Uses a persistent Chrome session (`.browser-profile/`) with stealth plugin. A 5–20s random pre-navigation delay is applied on every scrape to avoid bot detection patterns.
2. **`monitor-controller.ts`** — orchestrates the loop: scrape → diff → analyze → notify. Handles scheduling, backoff on empty scrapes (2× interval), and error recording.
3. **`analyzer.ts`** — sends old/new content (up to 3000 chars each) to the LLM and returns `{ changed, summary }`.
4. **`llm.ts`** — provider abstraction. Tries providers in priority order; falls back to local text-diff if all fail.
5. **`notifier.ts`** — sends Discord webhook alerts.

### Plugin system

Plugins short-circuit the LLM for specific sites. If a plugin matches the target URL:
- Plugin runs `extractProducts()` → deterministic structured diff → Discord alert (no LLM call)
- Change history is written to `state.json` (capped at 500 events) for trend/prediction use

Plugin interface: `src/plugin-types.ts`. Example: `plugins/hermes/index.ts`.
Plugins are npm workspaces under `plugins/*` and loaded by `src/plugin-registry.ts`.

### Config

`src/config.ts` is the single source of truth. There is **no shell-env layer** — the internal currency is the typed `JsonConfig`:

```
CLI flags (Partial<JsonConfig>) ─┐
                                 ├─► mergeConfig (CLI wins) ─► buildAppConfig() ─► AppConfig
config.json (JsonConfig) ────────┘                                                (typed, validated)
```

**Precedence: CLI flags > config.json.** `config.json` (project root, gitignored) is the REST-API/UI-persisted store; `ConfigStore` holds live config and is mutated by API calls, and `saveJsonConfig` writes it back. CLI flags are parsed by `src/cli-args.ts` (a declarative OPTIONS table that drives both parsing and `--help`) into a `Partial<JsonConfig>`, then `mergeConfig()` deep-merges them over `config.json` (CLI wins), and `buildAppConfig()` produces the validated `AppConfig`. This is what makes `npm run debug` (`--browserHeadless=false`) override `config.json`.

**Secrets are never flags:** `geminiApiKey`, `groqApiKey`, `discordBotToken`, `discordWebhookUrl`, `discordSystemWebhookUrl` live in `config.json`/UI only.

### API + UI

- **`src/api.ts`** — Express REST API. All routes prefixed `/api/`. Vite proxies `/api/*` to `localhost:3001` in dev.
- **`client/`** — React + Fluent UI v9 SPA. Pages: Monitor, Config, Providers, Debug Log.
- **`src/logger.ts`** — structured log buffer, persisted to `logs.jsonl`. Up to 2 weeks retained.

### Health monitor

`src/health-monitor.ts` runs as a **separate process** (`[mon]` in concurrently output). It polls `GET /api/health` every 5 minutes and sends Discord alerts for liveness and flapping. It's independent of the agent so it can detect when the agent itself is down.

### Browser session

- Uses `launchPersistentContext` with `channel: 'chrome'` (system Chrome required).
- Profile stored in `.browser-profile/` (gitignored).
- On session start, any lingering Chrome process holding the same profile is killed first (`killChromiumHoldingProfile` in `scraper.ts`) — prevents exit code 21 when `tsx --watch` restarts.
- `--start-maximized` added for non-headless mode.

### Pre-push hooks

`.husky/pre-push` runs typecheck (root + client) and full test coverage before every push. All checks must pass.
