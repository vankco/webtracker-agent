# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working conventions

- **Never switch git branches without explicit confirmation from the user.**
- **Changes to app code** (`src/`, `plugins/`, `client/src/`, `scripts/`) — show the diff and wait for user review before committing.
- **Non-app changes** (`CLAUDE.md`, `README.md`, `.gitignore`, config examples, docs) — can be committed automatically without review.

## Commands

```bash
# Install dependencies (root + client + plugins)
npm install

# Start full app (API + UI + health monitor + discord bot)
npm start                  # Linux/Mac
# On Windows, npm start uses cross-env — works on both platforms

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
npm run client:typecheck   # client

# Debug modes (run in a real terminal, not background — require visible desktop)
npm run watch-browser      # run once with visible browser, 250ms slow-mo
npm run browser_mode       # persistent visible browser (for manual login)
```

> **Windows note:** `npm start` uses `cross-env`. The old `set VAR=val&&` syntax in some scripts is Windows-only and was replaced. `npm stop` uses `scripts/stop.mjs` (cross-platform Node.js).

## Architecture

### Two runtime modes

`src/agent.ts` is the entry point and branches on `API_PORT`:

- **API mode** (`API_PORT=3001` set): starts Express API + auto-starts monitor if config is valid. This is the normal `npm start` path.
- **CLI mode** (no `API_PORT`): strict config load → immediate monitor loop. Used by `watch-browser` and `browser_mode`.

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

`src/config.ts` is the single source of truth. `config.json` in the project root (gitignored) is loaded on startup. The `ConfigStore` class holds live config and is mutated by REST API calls. The API serializes config back to `config.json` on each save.

**Env var override precedence** (for browser settings): explicit env vars (`BROWSER_HEADLESS`, `BROWSER_SLOW_MO_MS`, `BROWSER_KEEP_OPEN_MS`) take priority over `config.json` values when explicitly set. This is what makes `npm run watch-browser` work.

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
