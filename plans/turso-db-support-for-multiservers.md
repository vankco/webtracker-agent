# Plan: Turso DB Support for Multi-Machine Concurrency

## Context

This plan **builds on the Multi-Site Tracking work** (`~/.claude/plans/multi-url-scraping.md`),
which makes the app track many URLs from a `sites[]` config with per-site state and history.
That work is single-machine and uses local JSON files (`state.json` as a per-site map,
`config.json`, `logs.jsonl`).

The goal here is narrower: **let the agent run on multiple machines (Windows/Linux/macOS) at
the same time, all sharing one dataset.** Local JSON files cannot do this — two machines would
diverge and double-alert. The fix is to replace the JSON persistence layer with a shared
**Turso (libSQL) database** in **remote-only cloud mode** (single authoritative primary, always
fresh reads), plus a **per-site claim/lease** so concurrent machines cooperatively split the
work instead of all scraping the same site and firing duplicate Discord alerts.

This plan does **not** add the multi-URL feature itself — it assumes `sites[]`, per-site state,
and per-site history already exist. It only swaps where that data lives and adds coordination.

**Decisions locked with the user:**
- **Turso mode:** remote-only cloud. Embedded replicas rejected — stale local reads between
  syncs would let two machines both alert on the same change.
- **DB scope:** `sites`, per-site `state`, `history`, and global app `config` move into Turso.
  Logs stay as per-machine `logs.jsonl` files (high write volume, machine-local).
- **Cross-platform:** `@libsql/client` ships prebuilt binaries for all three OSes; no native
  build, no per-machine DB setup beyond env vars.

## Concurrency model

Each running agent gets a stable `MACHINE_ID` (env var, fallback to hostname). A site row
carries a lease (`locked_by`, `locked_until`). Per cycle, a machine atomically claims due sites:

```sql
UPDATE sites
   SET locked_by = :machine, locked_until = :now + :lease_ms
 WHERE id = :id
   AND enabled = 1
   AND (locked_until IS NULL OR locked_until < :now);
```

Only the machine whose `UPDATE` affected a row runs the scrape + diff + alert for that site,
then writes results and clears the lease in a `finally`. A crashed machine's lease simply
expires, so another machine picks the site up next cycle. Net effect: N machines become
cooperative load-sharing with no duplicate work or alerts.

## Schema (Turso)

```sql
CREATE TABLE IF NOT EXISTS sites (
  id            TEXT PRIMARY KEY,
  url           TEXT NOT NULL UNIQUE,
  selector      TEXT DEFAULT '',
  label         TEXT DEFAULT '',
  interval_ms   INTEGER,            -- null => global schedule
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_content  TEXT DEFAULT '',
  last_products TEXT,               -- JSON
  last_checked  TEXT,
  locked_by     TEXT,
  locked_until  INTEGER,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id         TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  timestamp       TEXT NOT NULL,
  products        TEXT,             -- JSON snapshot
  available_count INTEGER,
  change_summary  TEXT,
  machine_id      TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_site ON history(site_id, id);

CREATE TABLE IF NOT EXISTS app_config (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL                -- JSON: schedule, browser, notifications, llmProviders, plugins
);
```

History cap (`MAX_HISTORY = 500`) becomes per-site pruning after each insert:
`DELETE FROM history WHERE site_id = ? AND id NOT IN (SELECT id FROM history WHERE site_id = ? ORDER BY id DESC LIMIT 500)`.

## Implementation steps

### 1. DB layer — new `src/db.ts`
- Add dep `@libsql/client`. Singleton client from `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`;
  allow a `file:webtracker.db` fallback for local dev/tests.
- `initSchema()` runs the `CREATE TABLE IF NOT EXISTS` statements on boot.
- Keep all SQL isolated in this module.

### 2. Persistence swap — `src/state.ts`, `src/config.ts`
- Reimplement the per-site state/history helpers from the multi-site work to read/write the
  `sites`/`history` tables instead of the JSON map. Keep the same function signatures and
  `MonitorState`/`HistoryEntry` shapes; only the bodies change (now async DB calls).
- `ConfigStore` loads `sites` from the `sites` table and global config from the `app_config`
  row instead of `config.json`; site CRUD and config saves write to Turso.
- **One-time migration:** on boot, if Turso is empty but local `config.json`/`state.json`
  exist, import them, then leave the files as a backup.

### 3. Claim/lease — `src/monitor-controller.ts`
- The per-site loop from multi-site work already iterates sites. Wrap each due-site check with
  the atomic claim `UPDATE`; skip sites this machine didn't win. Release the lease in `finally`.
- Tag history writes with `MACHINE_ID`.
- Per-site in-memory status (lastCheck/lastResult/errors) stays machine-local — it already
  reflects only the sites this machine handled.

### 4. Entry point — `src/agent.ts`
- Resolve `MACHINE_ID` (env or hostname) once at boot.
- Call `initSchema()` and run the file→Turso migration before constructing `ConfigStore`.

### 5. Tests + docs
- Update state/config/api tests to run against a `file:` libSQL test DB (fresh per test);
  the suites become async.
- Add a lease test: two `MACHINE_ID`s contending for one site — exactly one wins per cycle.
- `CLAUDE.md`: document the new persistence layer and env vars
  (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `MACHINE_ID`); `.gitignore` `webtracker.db*`.

## Files touched
- New: `src/db.ts`
- Edits: `src/state.ts` (async DB bodies), `src/config.ts` (load/save via Turso + migration),
  `src/monitor-controller.ts` (claim/lease), `src/agent.ts` (MACHINE_ID, initSchema, migration)
- Tests: `src/__tests__/state.test.ts`, `src/__tests__/api.test.ts`, new lease test
- Deps: add `@libsql/client`
- Docs: `CLAUDE.md`, `.gitignore`

> No client/UI changes — the multi-site plan already delivered the site list + per-site status
> UI. This layer is transparent to the frontend (same API shapes, different storage).

## Verification
1. `npm run typecheck` (root + client) and `npm test` green against a `file:` libSQL test DB.
2. Create a Turso DB (`turso db create`), set `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`,
   `npm start`. First boot migrates existing `config.json`/`state.json` into Turso; verify rows
   with `turso db shell`.
3. **Concurrency test:** run two agents (two machines, or two local processes with distinct
   `MACHINE_ID`) against the same Turso DB. Confirm each site is checked by only one machine per
   cycle (lease works) and no duplicate Discord alerts fire. Kill one machine mid-cycle and
   confirm the other picks up its sites after the lease expires.
