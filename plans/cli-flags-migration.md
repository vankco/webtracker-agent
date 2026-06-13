# Migrate from shell env vars to CLI flags (typed config, no env layer)

## Context

Today the app is configured through **shell environment variables + `config.json`**, where shell env wins. Every npm script needs `cross-env VAR=val` prefixes (cross-platform pain on Windows), config reads are scattered as `process.env['KEY']` / `env['KEY']` string lookups across files, and there is no discoverable help.

The user wants to **stop using shell environment variables entirely** — all operational settings passed as CLI flags (`tsx src/agent.ts --apiPort 3001`), with `tsx src/agent.ts --help` listing every flag.

**Important design constraint from the user:** do NOT keep an internal env-shaped object (`{ API_PORT: '3001' }`) as plumbing. That makes the code read as if it still uses env vars. The internal currency must be a **typed config object**, and the `env['KEY']` machinery (`resolveEnv`, `jsonToEnv`, `requireEnv`, env-string parsing) should be **removed**.

**New model:**
```
CLI flags (Partial<JsonConfig>) ─┐
                                 ├─► mergeConfig (CLI wins) ─► buildAppConfig() ─► AppConfig
config.json (JsonConfig) ────────┘                                                (typed, validated)
```
Precedence: **CLI flags > config.json**. No `process.env` for user config. `config.json` stays the REST-API/UI-persisted store (`saveJsonConfig`, unchanged).

**Secrets decision (user-confirmed):** credentials get **no flags** — `config.json`/UI only. Excluded: `geminiApiKey`, `groqApiKey`, `discordBotToken`, `discordWebhookUrl`, `discordSystemWebhookUrl`. Strict (CLI-mode) build still *requires* `targetUrl` + `discordWebhookUrl`, sourced from `config.json`.

## Internal representation

`JsonConfig` (src/config.ts ~214) is already the typed, camelCase file shape the REST API serializes to/from. Use it as the merge currency:
- CLI parser → `Partial<JsonConfig>`
- `readJsonConfig()` → `JsonConfig | null` (exists)
- `mergeConfig(json, cli)` → `JsonConfig` (deep-merge `llm.gemini`, `llm.groq`, `browser`; CLI wins)
- `buildAppConfig(merged, { strict })` → `AppConfig` (defaults + validation)

This deletes the env intermediary entirely; readers consume typed fields, not strings.

## Implementation steps

### 1. New module `src/cli-args.ts`
Declarative OPTIONS table drives parsing AND `--help`. Each option targets a typed `JsonConfig` field via a setter (handles nesting cleanly):
```ts
type OptType = 'bool' | 'int' | 'string';
interface CliOption {
  flag: string;            // '--apiPort'
  type: OptType;
  group: string;           // 'Core' | 'Schedule' | 'Discord' | 'Gemini' | 'Groq' | 'Browser'
  desc: string;
  valueHint?: string;
  apply: (cfg: Partial<JsonConfig>, v: string | number | boolean) => void; // typed setter
}
```
Rows (**non-secret only**, flag → JsonConfig path):
- **Core:** `--targetUrl`→targetUrl, `--targetSelector`→targetSelector, `--apiPort`→apiPort(int), `--plugins`→plugins(comma-split→string[])
- **Schedule:** `--checkIntervalMs`(int), `--runOnce`(bool)
- **Discord IDs:** `--discordBotClientId`, `--discordBotGuildId`
- **Gemini:** `--geminiEnabled`(bool), `--geminiModel`, `--geminiPriority`(int), `--geminiTimeoutMs`(int), `--geminiMaxRetries`(int) → `llm.gemini.*`
- **Groq:** same shape → `llm.groq.*`
- **Browser:** `--browserHeadless`(bool), `--browserPersistSession`(bool), `--browserUserDataDir`, `--browserGotoTimeoutMs`(int), `--browserSlowMoMs`(int), `--browserKeepOpenMs`(int), `--manualAssisted`(bool), `--manualAssistedInitialWaitMs`(int) → `browser.*`

`parseCliArgs(argv = process.argv.slice(2)): { config: Partial<JsonConfig>; help: boolean; version: boolean }`:
- Accept `--flag value`, `--flag=value`, bare bool `--flag` (=true), `--flag=false`, `--no-flag`.
- Convert raw strings → typed: bool via `parseBooleanEnv`, int via `parseIntEnv` (reuse from `src/utils.ts`; these stay — they parse CLI strings now, not env). NaN / unknown flag → **throw `CliError`** (testable; caller prints + `process.exit(2)`).
- `--help`/`-h`, `--version`/`-v` set flags.
- `formatHelp()`: grouped, column-aligned, `Usage: tsx src/agent.ts [options]`, footer noting secrets (`geminiApiKey`, `groqApiKey`, `discordBotToken`, webhook URLs) are set in `config.json`. `getVersion()`: read `version` from `package.json`.

### 2. Rewrite `src/config.ts` core to typed (remove env layer)
- **Delete** `resolveEnv` (~398), `jsonToEnv` (~287), `requireEnv` (~73).
- **Rewrite** `parseProviderConfig`, `buildBrowserConfig`, `buildScheduleConfig` to take typed `JsonConfig` fields instead of `NodeJS.ProcessEnv` (e.g. `gemini.enabled ?? Boolean(gemini.apiKey)`, `Math.max(1, gemini.priority ?? 1)` — same defaults/clamps, no string parsing). Keep `KNOWN_PROVIDER_MODELS` defaults.
- **Add** `mergeConfig(json: JsonConfig | null, cli: Partial<JsonConfig>): JsonConfig` — shallow merge top-level, deep-merge `llm.gemini`/`llm.groq`/`browser`; CLI wins.
- **Replace** `loadAppConfig`/`loadAppConfigLenient(env)` with `buildAppConfig(input: JsonConfig, opts?: { strict?: boolean }): AppConfig` (strict throws on missing `targetUrl`/`discordWebhookUrl` via existing `validateAppConfig`; lenient defaults to empty strings). Keep thin named exports `loadAppConfig`/`loadAppConfigLenient` as typed wrappers if convenient for call sites/tests.
- Keep `validateAppConfig`, `getEnabledProvidersByPriority`, `getSafeConfig`, `saveJsonConfig`, `ConfigStore` — all already typed.

### 3. `src/agent.ts` — typed load + mode select
`main()`:
```ts
const { config: cli, help, version } = parseCliArgs();
if (help)    { console.log(formatHelp()); return; }
if (version) { console.log(getVersion()); return; }
const merged = mergeConfig(readJsonConfig(), cli);
const apiPort = merged.apiPort ?? 0;
const config = apiPort > 0 ? buildAppConfig(merged) /*lenient*/ : buildAppConfig(merged, { strict: true });
```
(API mode lenient, CLI mode strict — matching current behavior.) Remove `import 'dotenv/config'` and the `process.env['API_PORT']` read.

### 4. `src/scraper.ts` — thread `browserConfig`, delete `process.env` reads
Both callers ([monitor-controller.ts:198](src/monitor-controller.ts:198), [api.ts:460](src/api.ts:460)) always pass a `BrowserConfig`; tests fully mock `scrapePageText`. So:
- Make `browserConfig: BrowserConfig` **required** in `scrapePageText`.
- Replace the `process.env` override block (~179-196) with reads off `browserConfig` (`headless = manualAssisted ? false : browserConfig.headless`, etc.). Forced overrides already live in `buildBrowserConfig`.
- **Delete `isPersistentSessionEnabled()`** (~58-62) → use `browserConfig.persistSession`.
- `getOrCreateSessionPage` (~75): drop the `process.env['BROWSER_USER_DATA_DIR']` fallback.
- Remove now-unused imports.

### 5. `src/health-monitor.ts` & `src/discord-bot.ts` — typed load
Each: `const cfg = buildAppConfig(mergeConfig(readJsonConfig(), parseCliArgs().config));` then read typed fields (`cfg.notifications.discordSystemWebhookUrl`, etc.). For API_PORT they read `merged.apiPort ?? 3001`. Remove `import 'dotenv/config'`. `npm start` passes `--apiPort 3001` to each (Step 6). Secrets come from `config.json`.

### 6. `package.json` — scripts use flags; drop `cross-env` + `dotenv`
```jsonc
"start":   "concurrently -n api,ui,mon,bot -c cyan,magenta,yellow,blue \"tsx --watch src/agent.ts --apiPort 3001\" \"npm run ui:dev\" \"tsx src/health-monitor.ts --apiPort 3001\" \"tsx src/discord-bot.ts --apiPort 3001\"",
"api":     "tsx src/agent.ts --apiPort 3001",
"api:dev": "tsx --watch src/agent.ts --apiPort 3001",
"debug":   "tsx src/agent.ts --apiPort 3001 --browserHeadless=false --browserSlowMoMs 250",
"debug:once":    "tsx src/agent.ts --runOnce --browserHeadless=false --browserSlowMoMs 250",
"watch-browser": "tsx src/agent.ts --runOnce --browserHeadless=false --browserSlowMoMs 250 --browserKeepOpenMs 5000",
"browser_mode":  "tsx src/agent.ts --browserPersistSession --browserHeadless=false"
```
Remove `cross-env` (devDeps) and `dotenv` (deps, after the 3 imports are gone). Keep `concurrently`, `postinstall`.

### 7. Tests
Existing config tests pass env-shaped objects; rewrite them to typed `JsonConfig` (clearer):
- `api.test.ts` (~55), `e2e-flow.test.ts` (~29, ~379), `provider-selection.test.ts` (~207-221): `loadAppConfigLenient({ TARGET_URL:'x', GEMINI_API_KEY:'k', LLM_GEMINI_ENABLED:'true' })` → `buildAppConfig({ targetUrl:'x', llm:{ gemini:{ apiKey:'k', enabled:true } } })`. Mechanical.
- New `src/__tests__/cli-args.test.ts` (pure): `--flag value` / `--flag=value` / bare bool / `--flag=false` / `--no-flag` → assert typed `Partial<JsonConfig>`; unknown flag + bad int → `CliError`; `--help` contains every flag + groups + secrets footer; `--version` matches `package.json`; **precedence** via `mergeConfig({ apiPort:3001 }, { apiPort:9999 })` → 9999, and nested deep-merge of `browser`/`llm`.

### 8. Docs
- **CLAUDE.md:** rewrite the config/precedence section → `CLI flags > config.json`, no shell env, no env-shaped plumbing; update Commands to new flags; drop the Windows `set VAR=val&&` note.
- **README:** replace env setup with `--flag` usage + `--help`.
- Remove `.env`/dotenv references.

## Files to modify
- `src/cli-args.ts` (new)
- `src/config.ts` — remove env layer; add `mergeConfig`/`buildAppConfig`; typed builder helpers
- `src/agent.ts` — typed load, mode select, drop dotenv
- `src/scraper.ts` — thread `browserConfig`, remove `process.env`
- `src/health-monitor.ts`, `src/discord-bot.ts` — typed load, drop dotenv
- `package.json` — scripts → flags; remove `cross-env`, `dotenv`
- `src/__tests__/{api,e2e-flow,provider-selection}.test.ts` — typed inputs
- `src/__tests__/cli-args.test.ts` (new)
- `CLAUDE.md`, `README.md`

## Verification
1. `npm run typecheck` + `npm run ui:typecheck` — clean.
2. `npm test` — rewritten config tests + new cli-args tests pass (no `process.env`/`env[]` left in `src/`, verify by grep).
3. Manual:
   - `tsx src/agent.ts --help` → grouped flags + secrets-in-config.json footer.
   - `tsx src/agent.ts --version` → matches `package.json`.
   - `tsx src/agent.ts --badflag` → error + exit 2.
   - `tsx src/agent.ts --runOnce --browserHeadless=false --browserSlowMoMs 250` → one headed scrape then exit.
   - `npm start` → all 4 processes up; API on `:3001`; monitor/bot read `config.json` secrets; omitting `--apiPort` correctly flips agent to CLI mode.

## Risks & edge cases
- **`npm start` MUST pass `--apiPort 3001` to agent** — without it `apiPort` defaults to 0 (CLI mode), silently flipping the whole app. The single most important script edit.
- **Bigger blast radius than the env-plumbing shortcut:** rewrites `config.ts` core + 3 test files. Mitigated by keeping `validateAppConfig`/`AppConfig`/`saveJsonConfig`/`ConfigStore` intact and doing mechanical test conversions.
- **`manualAssisted` forced overrides** stay in `buildBrowserConfig`; scraper only reads `browserConfig.headless`/`.persistSession`.
- **Boolean ergonomics:** bare `--browserHeadless` = true; headed needs `--browserHeadless=false` / `--no-browserHeadless`. Documented in `--help`.
- **Deep-merge correctness:** `mergeConfig` must merge nested `llm.gemini`/`llm.groq`/`browser` (not replace whole objects) so a single `--geminiModel` flag doesn't wipe `config.json`'s `geminiApiKey`. Covered by a cli-args test.
- **Unknown-flag fail-fast** (exit 2) catches typos; consider case-insensitive flag lookup.
