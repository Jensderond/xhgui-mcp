# xhgui-mcp — Design

**Status:** Draft for review
**Date:** 2026-04-21
**Author:** Jens de Rond (with Claude)

## Goal

Build `xhgui-mcp`, a standalone, reusable MCP (Model Context Protocol) server that gives AI agents structured, pre-summarized access to XHGui profiling data. Replace ad-hoc HTML scraping (today: Python scripts in `dev/xhgui/`) with a typed, backend-aware interface so agents can answer performance questions ("why is this page slow?", "did my fix help?") in a couple of tool calls without flooding the context window with raw call trees.

## Non-goals

- Replacing the XHGui web UI.
- Collecting profile data (xhprof's job).
- Writing/mutating profile data; the MCP is read-only.
- Triggering profiling runs from the MCP.
- Reading raw `.xhprof` files from disk (that would be a different `xhprof-mcp`).

## Context

- **Stack today:** MSN runs xhprof + xhgui via the ddev `xhgui` add-on. XHGui UI at `https://msn.nl.internal:8142/`, MongoDB backend (ddev default).
- **Existing tooling:** `dev/xhgui/{profile_runs,profile_top,profile_symbol}.py` scrape the XHGui HTML UI. They work but are brittle (regex HTML parsing) and CLI-shaped, not agent-shaped.
- **Motivating question:** an agent should be able to answer "is this page slower after my change?" with one or two MCP calls, without loading 20k-row call trees into its context.

## Decisions (from brainstorm)

| # | Decision | Rationale |
|---|---|---|
| 1 | Standalone, reusable package (`xhgui-mcp`) — not tied to MSN | Generic MCP has more leverage; publishable to npm. |
| 2 | Direct DB access (Mongo / PDO), not HTML scraping | Robust, fast, gives richer data. HTML UI changes would silently break scrapers. |
| 3 | TypeScript / Node | Most mature MCP SDK; `npx xhgui-mcp` install story. |
| 4 | Agent-friendly tool surface (6 tools), not a thin mirror of the scripts | The MCP's value is pre-summarized answers; raw dumps waste context. |
| 5 | PDO backend shipped first; MongoDB in a follow-up | Matches the MSN ddev xhprof/xhgui setup (PDO). Backend interface designed for both from day one. |
| 6 | Env-var config; optional `XHGUI_CONFIG_PATH` fallback later | Standard MCP UX; no filesystem coupling. |
| 7 | No caching | YAGNI. Local xhgui DBs are small; caching risks hiding fix/regression deltas. |

## Architecture

Standalone npm package, stdio MCP server. Layered so each file has one purpose:

```
xhgui-mcp/
├── src/
│   ├── server.ts              # MCP server wiring, tool registration, stdio transport
│   ├── config.ts              # env-var parsing + validation (zod)
│   ├── backends/
│   │   ├── types.ts           # Backend interface + shared data types
│   │   ├── pdo.ts             # SQLite/MySQL implementation (shipped first)
│   │   └── mongo.ts           # MongoDB implementation (follow-up)
│   ├── tools/
│   │   ├── listRuns.ts
│   │   ├── getRunSummary.ts
│   │   ├── diffRuns.ts
│   │   ├── getSymbolCallers.ts
│   │   ├── searchRuns.ts
│   │   └── findSlowEndpoints.ts
│   └── format/                # pure, backend-agnostic summarization
│       ├── hotspots.ts        # top-N + hotspot categorization, self-time derivation
│       └── diff.ts            # before/after comparison
├── test/
│   ├── fixtures/              # anonymized xhgui run JSON dumps
│   ├── format/                # pure-function tests
│   ├── backends/              # describe.each contract tests (mongo + pdo)
│   └── tools/                 # fake-backend integration tests
└── package.json
```

**Seam:** the `Backend` interface. Tools and formatters never touch drivers directly, so a new backend is one file plus a switch in `config.ts`.

**Isolation:** `format/` is pure functions operating on typed data; easy to unit-test without a DB and where most of the logic value lives.

The existing Python scripts in `dev/xhgui/` stay where they are as a fallback / reference for the HTML-scraping approach. They are not deleted or migrated.

## Backend interface & data model

```ts
// src/backends/types.ts
export interface Backend {
  listRuns(filter: RunFilter): Promise<RunMeta[]>;
  getRun(runId: string): Promise<Run | null>;
  aggregateByUrl(filter: RunFilter): Promise<UrlAggregate[]>;
  close(): Promise<void>;
}

export interface RunFilter {
  url?: string;
  urlContains?: string;
  method?: string;
  since?: Date;
  until?: Date;
  minWallUs?: number;
  limit?: number;
}

export interface RunMeta {
  runId: string;
  url: string;
  method: string;
  wallUs: number;
  cpuUs: number;
  timestamp: Date;
}

export interface Run {
  meta: RunMeta;
  totals: { wallUs: number; cpuUs: number; muBytes: number; pmuBytes: number };
  profile: Record<string, FunctionStats>;   // keyed by "parent==>child" or "main()"
}

export interface FunctionStats {
  ct: number;    // call count
  wt: number;    // inclusive wall time (µs)
  cpu: number;   // inclusive cpu time (µs)
  mu: number;    // inclusive memory (bytes)
  pmu: number;   // inclusive peak memory (bytes)
}

export interface UrlAggregate {
  url: string;
  method: string;
  runCount: number;
  p50WallUs: number;
  p95WallUs: number;
  maxWallUs: number;
  slowestRunId: string;
}
```

**Important data notes:**

- XHGui stores **inclusive** timings only. Self-time is derived in `format/hotspots.ts` as `self_wt(sym) = sum(wt of edges "sym==>*") − sum(wt of edges "*==>children of sym")`, matching how the XHGui UI computes it. If derivation fails (missing edges), `self_ms` is returned as `null` with a `warnings` field — never guessed as zero.
- **Times:** stored as µs internally; converted to ms at the tool boundary in one place.
- **PDO schema:** xhgui's `profiles` table. Row-per-run with metadata columns (url, method, request_ts, main_wt, etc.) and a JSON blob in `data` holding the full profile map. Exact column names are verified against xhgui's migrations during M1.
- **Mongo schema (follow-up):** `results` collection. Standard xhgui fields: `meta.url`, `meta.SERVER.REQUEST_METHOD`, `meta.request_date`, `profile.main().wt`, etc. Must produce identical `Run`/`RunMeta` output shapes.

## Tool surface

All times in tool outputs are milliseconds (integers where natural, floats to 1 decimal where useful). All sizes in kilobytes.

### 1. `list_runs`

Recent runs for a URL.

- **Input:** `{ url?: string, limit?: number = 20, since?: string /* ISO-8601 */ }`
- **Output:** `{ runs: [{ run_id, url, method, wall_ms, cpu_ms, timestamp }] }`
- **Replaces:** `profile_runs.py`.

### 2. `get_run_summary`

Headline tool. One call returns everything an agent needs to reason about a single run.

- **Input:** `{ run_id: string, top_n?: number = 15 }`
- **Output:**
  ```
  {
    url, method, timestamp,
    totals: { wall_ms, cpu_ms, memory_kb, peak_memory_kb },
    top_by_inclusive: [{ symbol, ct, incl_ms, self_ms }],
    top_by_self: [{ symbol, ct, incl_ms, self_ms }],
    hotspots: [{ category, symbol, ct, incl_ms, self_ms }],
    truncated?: boolean,
    warnings?: string[]
  }
  ```
- **Hotspot categories (default list, configurable in a later version):** `ElementQuery::one`, `ElementQuery::all`, `internalExecute`, `getAttribute`, `Container::build`, `renderTemplate`. Same defaults as today's `profile_top.py`.

### 3. `diff_runs`

Before/after comparison — the high-value addition over today's tooling.

- **Input:** `{ before_id: string, after_id: string, limit?: number = 20 }`
- **Output:**
  ```
  {
    before: { run_id, url, wall_ms },
    after:  { run_id, url, wall_ms },
    totals_delta: { wall_ms, cpu_ms, memory_kb },
    biggest_wins: [{ symbol, before_incl_ms, after_incl_ms, delta_ms, delta_pct }],
    biggest_regressions: [...],
    new_symbols: [{ symbol, incl_ms }],
    gone_symbols: [{ symbol, incl_ms }]
  }
  ```
- Answers "did my fix help?" without the agent loading two full runs.

### 4. `get_symbol_callers`

Parent/child callers for one symbol in one run.

- **Input:** `{ run_id: string, symbol: string }`
- **Output:**
  ```
  {
    symbol,
    self: { ct, incl_ms, self_ms },
    parents: [{ symbol, ct, incl_ms }],
    children: [{ symbol, ct, incl_ms }]
  }
  ```
- **Replaces:** `profile_symbol.py`.
- On symbol-not-found, error response includes up to 5 substring matches to reduce round-trips.

### 5. `search_runs`

Broader cross-URL querying.

- **Input:** `{ url_contains?: string, method?: string, since?: string, until?: string, min_wall_ms?: number, limit?: number = 50 }`
- **Output:** same row shape as `list_runs`.

### 6. `find_slow_endpoints`

Aggregated across runs, grouped by URL.

- **Input:** `{ since?: string, min_wall_ms?: number, limit?: number = 20 }`
- **Output:** `{ endpoints: [{ url, method, run_count, p50_ms, p95_ms, max_ms, slowest_run_id }] }`

### Explicitly excluded (YAGNI)

- Raw call-tree export. Agents don't benefit; context cost is huge. Use `get_symbol_callers` to navigate.
- Write/mutation tools.
- Live profiling triggers (start/stop xhprof).

## Configuration

Env vars parsed and validated by `src/config.ts` using zod. Invalid config fails startup with a clear message — tools never start up in a broken state.

```
XHGUI_BACKEND=pdo|mongodb             (required)
XHGUI_PDO_DSN=sqlite:/path/to.db      (required if pdo; e.g. mysql://user:pass@host:3306/xhgui)
XHGUI_MONGO_URI=mongodb://host:port   (required if mongodb; follow-up)
XHGUI_MONGO_DB=xhprof                 (default: 'xhprof'; follow-up)
XHGUI_CONFIG_PATH=/path/config.php    (optional, v2 — parse xhgui config for connection details)
```

## Deployment & ddev integration

The MCP is deliberately generic — it knows nothing about ddev. To connect from the host to a dockerized XHGui:

- **Immediate (PDO/SQLite):** the SQLite file lives inside the ddev container. Either mount it onto the host via ddev's standard volume config, or run the MCP inside the ddev web container. Point `XHGUI_PDO_DSN` at the resulting path.
- **Immediate (PDO/MySQL):** expose the MySQL port from ddev (or use ddev's existing host-mapped port) and point `XHGUI_PDO_DSN` at `localhost:<port>`.
- **Follow-up (out of scope for this spec):** a dedicated `ddev-xhgui-mcp` addon that automates path/port exposure and drops in an MCP client config snippet. Packaging concern, not MCP concern.

## Error handling

**Philosophy:** fail loudly at the right boundary; never fabricate numbers.

- **Startup errors** (bad config, DB unreachable) → print error, exit non-zero. Server does not start.
- **Tool errors** (returned as structured MCP errors):
  - `run_id not found` → error with the id echoed back.
  - `symbol not found in run` → error includes up to 5 substring matches.
  - Bad input → zod validation error naming the offending field.
  - Mid-call driver failure → surfaced with context, not swallowed.
- **No silent fallbacks:** missing self-time → `self_ms: null` with a warning; truncated runs → `truncated: true` in output.
- **Logging:** structured JSON to stderr (stdout reserved for MCP). One line per tool call: tool name, duration, backend query count.

## Testing

Stack: vitest. ~80% of test value lives in the pure formatters.

- **Formatter tests** (`format/hotspots.ts`, `format/diff.ts`): canned `Run` objects in, assert shape and numbers out.
- **Backend contract tests:** one `describe.each` over `[pdo, mongo]` against identical fixtures, using `better-sqlite3 :memory:` and (later) `mongodb-memory-server`. Guards the "add the second backend safely" promise.
- **Tool integration tests:** fake `Backend` returning canned data, invoke tools via the server handler, assert output. No real DB, no transport layer.
- **Fixtures:** 2–3 anonymized xhgui run JSON dumps in `test/fixtures/`, shared by formatter and backend tests.

**Not tested:** MCP SDK transport, driver behavior, zod itself.

## Milestones

1. **M1 — Skeleton & config.** `server.ts`, `config.ts`, `Backend` interface, empty tool stubs. Runnable via `npx` with clear "no tools yet" output. Also: inspect the MSN ddev xhgui DB to confirm the PDO schema column names.
2. **M2 — PDO backend + list/get.** `pdo.ts` + `list_runs` + `get_run_summary` + formatters + tests. Usable against the MSN xhgui DB for read-only inspection.
3. **M3 — Diff & symbol navigation.** `diff_runs`, `get_symbol_callers`. Unblocks the "did my fix help?" workflow.
4. **M4 — Cross-run queries.** `search_runs`, `find_slow_endpoints`.
5. **M5 — MongoDB backend.** `mongo.ts` + contract tests pass for both backends.
6. **M6 — Publish.** README, MCP client config examples, `npm publish`.

## Open questions

- None blocking. `XHGUI_CONFIG_PATH` fallback and the ddev addon are deliberately deferred.
