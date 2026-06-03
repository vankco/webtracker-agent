# Plan: Interactive Discord Bot

## Context
The current Discord integration is a **send-only webhook** — it posts alerts but can't read or reply to messages. The user wants a two-way control surface: a Discord bot where users type commands (e.g. `!status`, `!status <item>`, `!predict`) and get replies. This requires a Discord **bot** (Gateway/WebSocket API), built as a separate process like the standalone `src/health-monitor.ts`. No paid Discord account is needed.

## Design decisions
- **Command style:** **slash commands** (`/status`, `/status item:<name>`, …). No Message Content Intent needed; commands are registered with Discord on startup. Typed argument fields with autocomplete UX.
- **Scope:** **read-only** — status, item lookup, recent changes, run prediction. No start/stop or config mutation.
- **Access:** **per-command**, based on **Discord server permissions**. `/status` (monitor health) requires the user to have the **Administrator** permission (or be the guild owner). All other commands are public. No user-ID allowlist needed — admin is derived from Discord roles.
- **Library:** `discord.js` (de-facto standard, well-typed).
- **Transport:** the bot talks to the agent via its existing REST API (same decoupling as health-monitor), not by importing app internals.

## Commands (v1) — all slash commands
| Command | Access | Action | Backed by |
|---|---|---|---|
| `/help` | public | List commands | (static) |
| `/status` | **admin only** | Monitor running?, last/next check, last result, target URL | `GET /api/monitor/status` |
| `/item query:<query>` | public | **Natural-language** product lookup (e.g. `looking for blue bag`) — hybrid match (see below) | `GET /api/products` + `POST /api/products/search` (new) |
| `/changes` | public | Most recent change events from history | `GET /api/products` (new, returns history) |
| `/predict [question]` | public | Forecast — general, or focused on a free-text question (e.g. `kelly next availability`) | `POST /api/predict` (extended) |

**Permission enforcement:** `/status` is admin-only — checked in the bot via `interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)` OR `interaction.guild?.ownerId === interaction.user.id`. Non-admins get an ephemeral "you don't have permission" reply. A per-command `requiresAdmin` map drives this (pure + unit-tested).

`/predict` and the LLM lookup fallback can take several seconds → use `interaction.deferReply()` then `editReply()`, to avoid Discord's 3-second ack timeout.

## Hybrid product lookup
`/item query:<query>` accepts **natural language** and resolves in two stages:
1. **Precise fast-path (no LLM)** — only when the query is an exact identifier: a SKU match, or the full query equals a product name (case-insensitive). This is deliberately strict — NOT loose substring — so common words like "bag" (in every product name) don't produce false hits. If it matches, reply instantly.
2. **LLM semantic search** — for everything else (the normal path for natural language like `looking for blue bag`, `the red one under 4k`): call a new `POST /api/products/search` endpoint that sends the query + the full product list to the LLM (reusing the provider/failover pattern from `src/predictor.ts`) and returns the matching SKUs, which the bot renders with availability/price/link.

Net effect: typing a SKU or exact name is instant; any natural-language phrasing goes to the LLM. Uses `interaction.deferReply()` since stage 2 takes a couple seconds.

## Focused predictions (`/predict [question]`)
`/predict` takes an **optional** free-text `question` argument:
- **No question** → general forecast over the whole history (current v3 behavior, unchanged).
- **With a question** (e.g. `kelly next availability`) → the LLM answers that specific question using the history data.

This extends the existing prediction path (added in v3):
- `src/predictor.ts` — `buildPredictionPrompt(url, historyText, question?)` adds a "Focus: answer this specific question — <question>" block when present; `predictAvailability(..., question?)` threads it through.
- `POST /api/predict` — accept optional `{ query?: string }` body (backward compatible; the existing Monitor-page button sends none).
- `src/api-types.ts` + client — add `PredictRequest { query?: string }`.
- Optional: add a small text input next to the Monitor page's "Run Prediction" button so the UI can use focused questions too (nice-to-have, not required for the bot).

## Slash command registration
On bot startup, register the command definitions with Discord via the REST API (`guild` commands for instant availability during dev; note global commands can take ~1h to propagate). Registration runs once per boot (idempotent upsert). Needs the **Application (Client) ID** and a **Guild ID** — both added to config.

## New / modified files

### `src/api.ts` (new endpoints)
- `GET /api/products` — returns the current product snapshot + recent history from `loadState()`:
  ```
  { targetUrl, available: unknown[], total: number, history: HistoryEntry[] }
  ```
  Stage-1 lookup and `/changes` both read from this. (No new extraction — exposes what `state.json` already holds via `loadState()` from `./state.js`.)
- `POST /api/products/search` `{ query }` — stage-2 LLM semantic search. Resolves the active plugin via `monitorController.findPlugin(url)` to serialize products, sends query + products to the LLM (new `src/product-search.ts`, same provider/failover shape as `predictor.ts`), returns `{ matches: { sku, reason }[] }`. 422 if no plugin / no products / no providers; 502 if all providers fail.

### `src/product-search.ts` (new)
`searchProducts(query, productsText, providers)` — LLM call returning matching SKUs. Mirrors `predictor.ts`: Gemini→Groq failover, JSON-only prompt ("given this product list and a query, return matching SKUs"), throws if all fail. Excluded from coverage like `predictor.ts`'s SDK paths are covered — add a prompt-builder unit test.

### `src/api-types.ts` + `client/src/api/types.ts`
Add `GetProductsResponse` and `ProductSearchResponse` types (mirror).

### `src/config.ts`
Add to `JsonConfig` + env mapping (`jsonToEnv`, `saveJsonConfig`):
- `discordBotToken?: string` → `DISCORD_BOT_TOKEN`
- `discordBotClientId?: string` → `DISCORD_BOT_CLIENT_ID` (for command registration)
- `discordBotGuildId?: string` → `DISCORD_BOT_GUILD_ID` (register guild commands for instant availability)

No user-ID allowlist needed — admin access is derived from Discord server permissions at command time. Keep these bot-process-only (read via `resolveEnv()`), NOT added to `AppConfig`/`SafeAppConfig` — the token must never be exposed via `GET /api/config`.

### `src/discord-bot.ts` (new — standalone process)
Mirrors `src/health-monitor.ts` structure:
- Reads `DISCORD_BOT_TOKEN`, client/guild IDs, and `API_PORT` via `resolveEnv()`.
- If no token → log a notice and exit cleanly (so `npm start` doesn't break for users without a bot).
- Connect with `discord.js` Client (intent: **Guilds** only — no MessageContent needed for slash commands).
- On `ready`: register the slash commands (guild-scoped) via the REST API.
- On `interactionCreate` (chat input commands): if the command `requiresAdmin`, verify the member has Administrator permission / is guild owner — else reply ephemerally with a permission denial. Then route by command name, call the relevant REST endpoint, reply via `interaction.reply()` / `deferReply()`+`editReply()`.
- Reuse the truncation idea from `notifier.ts` for long replies (embed limits).

### `package.json`
- `"bot": "tsx src/discord-bot.ts"`
- Add to `start` concurrently as a 4th process (`bot`), and to the `stop` pkill list.

### `vitest.config.ts`
Exclude `src/discord-bot.ts` from coverage (entry-point process, like `agent.ts`/`health-monitor.ts`). Pure helpers (command parsing, allowlist check, reply formatting) should be factored into a testable module — see below.

### Tests
Factor the testable logic into `src/discord-bot-commands.ts` (pure functions: `requiresAdmin(commandName)`, `formatStatusReply(status)`, `preciseMatch(products, query)` for the strict stage-1 fast-path — exact SKU or full-name only, `formatPrediction(result)`, `slashCommandDefinitions()`). Add `src/__tests__/discord-bot-commands.test.ts` covering these — including that `/status` requires admin and the others don't. Keeps the 80% coverage gate green without mocking the Discord gateway.

## Setup the user must do (documented in README)
1. Discord Developer Portal → New Application → copy the **Application (Client) ID**.
2. Add a **Bot** → copy the **token**. (No privileged intents needed for slash commands.)
3. Invite the bot via OAuth2 URL (scopes: `bot` + `applications.commands`; permission: Send Messages).
4. Put `discordBotToken`, `discordBotClientId`, and `discordBotGuildId` (your server's ID) in `config.json`.
5. To use `/status`, your Discord account needs the **Administrator** permission in that server (you will, as owner).

## Verification
1. `npm run typecheck` + `npm run test:coverage` (≥80%, all pass).
2. `npm run bot` with a real token → in Discord: `/help`, `/status` (admin), `/item query:H086920CKAB` (instant SKU), `/item query:looking for blue bag` (LLM natural language), `/predict` (general), and `/predict question:kelly next availability` (focused) all return correct replies.
3. Permission test: a non-admin user running `/status` gets an ephemeral permission-denied reply; the public commands still work for them.
4. No-token case: `npm start` still launches api/ui/monitor; bot logs "no token, exiting" without crashing the others.
5. Confirm bot token never appears in `GET /api/config`.
