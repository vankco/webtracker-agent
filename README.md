# WebTracker Agent

AI-powered website change monitor. Watches a page for meaningful changes and sends a Discord alert when something important happens.

---

## How it works

1. Playwright scrapes the target page on a schedule
2. If the content changed:
   - **Plugin URL** — if a site plugin matches the target URL, it runs a deterministic structured diff (no LLM needed). Added, removed, and changed items are identified and sent directly to Discord.
   - **All other URLs** — the old and new content are sent to an LLM (Gemini or Groq) for analysis. The LLM decides if the change is meaningful and writes a summary.
3. A Discord alert is sent with the result
4. If all LLM providers fail, a local text-diff fallback is used (generic sites only)
5. On first run with no prior state, plugins send a baseline alert listing all currently tracked items
6. For plugin URLs, each change event is appended to a time-series `history` in `state.json` (capped at 500 events) — this builds the dataset used for trend analysis and predictions

---

## Requirements

- Node.js 20+
- A [Gemini API key](https://aistudio.google.com/app/apikey) (free tier available)
- A [Groq API key](https://console.groq.com) (optional, used as failover)
- A Discord webhook URL

---

## Setup

### 1. Install dependencies

```bash
npm install
cd client && npm install && cd ..
```

### 2. Create your config file

Create `config.json` in the project root with your values:

```json
{
  "targetUrl": "https://example.com",
  "targetSelector": "",
  "checkIntervalMs": 300000,
  "runOnce": false,
  "discordWebhookUrl": "https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN",
  "apiPort": 3001,

  "llm": {
    "gemini": {
      "enabled": true,
      "apiKey": "YOUR_GEMINI_API_KEY",
      "model": "gemini-2.5-flash",
      "priority": 1,
      "timeoutMs": 30000,
      "maxRetries": 1
    },
    "groq": {
      "enabled": false,
      "apiKey": "",
      "model": "llama-3.3-70b-versatile",
      "priority": 2,
      "timeoutMs": 30000,
      "maxRetries": 1
    }
  },

  "browser": {
    "headless": true,
    "persistSession": true,
    "userDataDir": ".browser-profile",
    "gotoTimeoutMs": 60000
  },

  "plugins": ["@webtracker/plugin-hermes"]
}
```

> `config.json` is gitignored — your secrets never get committed.

---

## Starting the app

### API + UI together (recommended)

```bash
npm start
```

- API runs on `http://localhost:3001`
- UI runs on `http://localhost:5173`
- A standalone health-monitor process also starts (see below)
- If `config.json` is fully configured, the monitor starts automatically

### Health monitor

`npm start` also launches `src/health-monitor.ts` as a **separate process** (run it alone with `npm run monitor`). Because it runs independently of the agent, it can detect when the agent itself goes down. Every 5 minutes it sends Discord alerts for:

- **Liveness** — the agent is down (once) and when it recovers (once)
- **Flapping** — `availableProducts` bouncing across recent scrapes (at most once per hour)

Real-time `warn`/`error` alerts are handled by the agent itself; the health monitor covers the cases the agent can't report on its own.

### Discord bot

`npm start` also launches `src/discord-bot.ts` as a **separate process** (run it alone with `npm run bot`). It connects to Discord via the Gateway and registers slash commands so anyone in your server can query the tracker in plain English.

**Commands:**

| Command | Access | Description |
|---|---|---|
| `/ask question:<text>` | public | Ask anything — "what's in stock today?", "which bag sells out fastest?", "any bags under $4k?" |
| `/status` | admin only | Monitor health, last/next check time, and last result |
| `/help` | public | List all commands |

**Setup:**

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → New Application → copy the **Application (Client) ID**
2. Under **Bot** → Add Bot → copy the **token**. No privileged intents needed.
3. Invite the bot via OAuth2 URL (scopes: `bot` + `applications.commands`; permission: Send Messages)
4. Add to `config.json`:

```json
{
  "discordBotToken": "YOUR_BOT_TOKEN",
  "discordBotClientId": "YOUR_CLIENT_ID",
  "discordBotGuildId": "YOUR_SERVER_ID"
}
```

If no token is configured the bot process exits cleanly — `npm start` still works normally. The bot token is never exposed via `GET /api/config`.

### API only

```bash
npm run api:dev
```

### Accessible from other devices (phone/tablet)

```bash
npm run api:dev &
cd client && npm run dev -- --host
```

Then open `http://<your-ip>:5173` on any device on the same network.

---

## Using the UI

### Debug Log page

- **Live event log** — every scrape, LLM call, alert, and error is recorded with a timestamp and log level
- **Persistent across restarts** — logs are written to `logs.jsonl` and reloaded on startup; up to 2 weeks of history is retained
- **Real-time Discord alerts** — any `warn` or `error` entry immediately sends a Discord notification
- **Filter by level** — filter to `info`, `warn`, or `error` events
- **Auto-scroll** — newest events appear at the bottom; scrolls automatically unless you scroll up

### Monitor page

- **Start / Stop** — starts or stops the monitoring loop
- **Last Check / Next Check** — when the last check ran and when the next is scheduled (Next Check only shown while running)
- **Last Result** — the LLM's analysis from the most recent check, including provider, model, and latency
- **Recent Fetched Content** — last 2 scraped snapshots with timestamp, character count, and first 500 chars preview
- **Predictions** — for plugin URLs with collected history, click "Run Prediction" to have an LLM forecast likely restocks, sellouts, and price trends from the time-series data. Requires at least 3 recorded change events.
- **Recent Errors** — scrape failures, empty content warnings, etc.
- **Schedule Controls** — change the check interval or enable run-once mode without restarting
- **Scrape Validator** — test a URL + CSS selector before starting the monitor; shows a content preview and character count

### Providers page

- **Enable / Disable** each LLM provider with the toggle
- **Edit** — change the model, API key, priority, timeout, and retries
- **Test connection** — sends a real LLM request with sample content and shows the full model response (`changed` + `summary`)
- **Available models** — expandable list fetched live from the provider API on startup, with free/paid tier badges
- **Priority** — lower number = tried first. If priority 1 fails, priority 2 is tried automatically

### Config page

- **Target** — the URL to monitor and an optional CSS selector to focus on a specific part of the page
- **Schedule** — check interval in seconds and run-once mode
- **Notifications** — Discord webhook URL (write-only, never echoed back)
- **Browser** — read-only view of browser settings (set these in `config.json`)

---

## Configuration reference

| Field | Default | Description |
|---|---|---|
| `targetUrl` | — | The page to monitor (required) |
| `targetSelector` | `""` | CSS selector to focus on (e.g. `main`, `#prices`). Empty = full page |
| `checkIntervalMs` | `300000` | How often to check in ms (5 minutes) |
| `runOnce` | `false` | Run one check and exit |
| `discordWebhookUrl` | — | Discord webhook for alerts (required) |
| `apiPort` | `3001` | Port for the REST API server |
| `llm.gemini.priority` | `1` | Lower = tried first |
| `llm.groq.priority` | `2` | Used as failover when Gemini fails |
| `browser.headless` | `true` | Run browser without a visible window |
| `browser.persistSession` | `true` | Reuse cookies/login state between runs |
| `browser.userDataDir` | `.browser-profile` | Where browser session data is stored |
| `plugins` | `[]` | List of site plugin package names to load |
| `discordBotToken` | — | Discord bot token (optional; enables `/ask`, `/status`, `/help` slash commands) |
| `discordBotClientId` | — | Discord application client ID (required with `discordBotToken`) |
| `discordBotGuildId` | — | Discord server ID for slash command registration (required with `discordBotToken`) |

---

## Site plugins

Plugins add deterministic change detection for specific sites — no LLM needed. The Hermès plugin is included out of the box.

### Using the Hermès plugin

Add it to `config.json`:

```json
{
  "plugins": ["@webtracker/plugin-hermes"]
}
```

When the target URL contains `hermes.com`, the plugin:
- Extracts all products from the page by SKU
- Diffs available products between runs (added / removed / price changed)
- Sends a structured Discord alert — no LLM call required

### Writing your own plugin

1. Create `plugins/your-plugin/package.json`:
```json
{ "name": "@webtracker/plugin-your-plugin", "version": "1.0.0", "main": "index.ts" }
```

2. Create `plugins/your-plugin/index.ts` implementing the `SitePlugin` interface (copy `plugins/hermes/index.ts` as a template)

3. Run `npm install` — npm workspaces symlinks it automatically

4. Add `"@webtracker/plugin-your-plugin"` to the `plugins` array in `config.json`

If no plugin matches the target URL, the app falls back to LLM-based analysis automatically.

---

## LLM provider failover

Providers are tried in priority order (lowest number first):

1. Gemini is called
2. If Gemini fails (bad key, timeout, quota) → Groq is tried
3. If all providers fail → local text-diff fallback is used (no LLM call)

The fallback always produces a result — the monitor never crashes due to LLM failure.

## Content sent to the LLM

Each check sends up to **3000 chars of old content** and **3000 chars of new content** to the LLM. If your page is longer than 3000 chars, only the first 3000 are analyzed — changes lower on the page may be missed. Use a CSS selector to target a specific section and reduce noise.

## Empty scrape detection

If the scraper fetches a page but gets no content back (selector matched nothing, or the element was empty), the monitor:
- Logs a warning to the console
- Records it in the Recent Errors card
- Sends a Discord alert explaining whether it was likely a bad selector or a bot block
- Skips the LLM call for that cycle

---

## CSS selector tips

Use the browser DevTools inspector to find the right selector:

- `main` — main content area
- `#prices` — element with id="prices"
- `.product-grid` — elements with class="product-grid"
- `div.hero-product` — div with class="hero-product"

Leave blank to monitor the entire page body.

---

## For sites that require login

Set `browser.manualAssisted: true` in `config.json`. On first run a browser window opens and waits 2 minutes for you to log in manually. The session is saved to `.browser-profile` and reused automatically on all future runs.

---

## Running tests

```bash
npm test                # run once
npm run test:watch      # watch mode
npm run test:coverage   # with coverage report (≥80% required)
```

---

## Project structure

```
src/
  agent.ts              — entry point, starts API server or CLI loop
  api.ts                — Express REST API (11 endpoints, incl. POST /api/ask)
  config.ts             — config loading (config.json → env → defaults)
  monitor-controller.ts — monitor loop lifecycle (start/stop/status)
  plugin-types.ts       — SitePlugin / PluginDiff interfaces
  plugin-registry.ts    — plugin loader and registry
  llm.ts                — LLM provider orchestration and failover
  analyzer.ts           — Gemini adapter + local diff fallback
  scraper.ts            — Playwright browser automation
  notifier.ts           — Discord webhook alerts
  state.ts              — persist last scrape to state.json
  predictor.ts          — LLM-powered availability & price predictions
  bot-qa.ts             — LLM-powered Q&A for the Discord bot
  discord-bot.ts        — standalone Discord bot process
  discord-bot-commands.ts — slash command definitions and reply formatters
  api-types.ts          — shared TypeScript types for the API

plugins/
  hermes/               — @webtracker/plugin-hermes (Hermès product tracker)

client/
  src/pages/
    MonitorPage.tsx     — monitor controls and status
    ProvidersPage.tsx   — LLM provider management
    ConfigPage.tsx      — app configuration
    DebugLogPage.tsx    — live structured event log

config.json             — your local config (gitignored)
```
