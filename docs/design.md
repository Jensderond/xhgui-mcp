# xhgui-mcp — Design

**Status:** Draft for review
**Date:** 2026-04-21
**Author:** Jens de Rond (with Claude)
**Last updated:** 2026-04-21 (post-grill revisions)

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
| 4 | Agent-friendly tool surface (5 tools), not a thin mirror of the scripts | The MCP's value is pre-summarized answers; raw dumps waste context. `list_runs` covers both exact-URL and cross-URL querying (previously two tools). |
| 5 | PDO backend (MySQL) shipped first; MongoDB in a follow-up | MSN's ddev xhgui addon runs with `XHGUI_SAVE_HANDLER=pdo`, reusing the project's MariaDB instance against an `xhgui` database with a `results` table. Backend interface designed for both from day one. |
| 6 | Env-var config; optional `XHGUI_CONFIG_PATH` fallback later | Standard MCP UX; no filesystem coupling. |
| 7 | No caching | YAGNI. Local xhgui DBs are small; caching risks hiding fix/regression deltas. |
| 8 | Hotspot categories are opt-in via env, empty by default | Decision #1 says "generic, publishable"; shipping MSN/Craft-specific defaults (`ElementQuery::one`, `Container::build`, …) contradicts that. MSN configures its own list in the MCP client config. |
| 9 | Skip automated tests for M1–M4; rely on smoke testing against MSN's xhgui DB | Solo project, one real user, one real DB. Real-MySQL contract tests are heavy; SQLite-in-memory is a different engine and gives false confidence. Dogfooding during M2+ is stronger signal than contrived in-memory tests. Revisit if the project gets external users. |

## Architecture

Standalone npm package, stdio MCP server. Layered so each file has one purpose:

```
xhgui-mcp/
├── src/
│   ├── server.ts              # MCP server wiring, tool registration, stdio transport
│   ├── config.ts              # env-var parsing + validation (zod)
│   ├── backends/
│   │   ├── types.ts           # Backend interface + shared data types
│   │   ├── pdo.ts             # MySQL (primary) + SQLite implementation, shipped first
│   │   └── mongo.ts           # MongoDB implementation (follow-up)
│   ├── tools/
│   │   ├── listRuns.ts
│   │   ├── getRunSummary.ts
│   │   ├── diffRuns.ts
│   │   ├── getSymbolCallers.ts
│   │   └── findSlowEndpoints.ts
│   └── format/                # pure, backend-agnostic summarization
│       ├── hotspots.ts        # top-N + hotspot categorization, self-time derivation
│       └── diff.ts            # before/after comparison
└── package.json

# No test/ directory for M1–M4 — see Testing section.
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

- XHGui stores **per-edge inclusive** timings only (each key is `"parent==>child"`; `wt` is the time spent in `child` when called from `parent`). Derived quantities:
  - `incl(sym) = Σ wt["*==>sym"]` — inclusive time of `sym`, summed over all incoming edges.
  - `self(sym) = incl(sym) − Σ wt["sym==>*"]` — inclusive minus time spent in its children.

  This matches XHGui's own UI. Implement in `format/hotspots.ts` as two explicit passes (aggregate incoming edges → subtract outgoing), with a worked example in a comment because this is the kind of formula that silently goes wrong. If incoming edges are missing for a symbol, `self_ms` is returned as `null` with an entry in `warnings` — never guessed as zero.
- **Times:** stored as µs internally; converted to ms at the tool boundary in one place. **All `*_ms` fields in tool outputs are floats rounded to 1 decimal** for consistency — agents don't have to guess whether a field is int or float. All sizes in kilobytes (integer).
- **PDO schema:** database `xhgui`, table `results` (the ddev xhgui addon's default when `XHGUI_SAVE_HANDLER=pdo`). Row-per-run with metadata columns (url, method, request_ts, main_wt, etc.) and a JSON blob holding the full profile map. Exact column names are verified against the MSN xhgui DB during M1.
- **Mongo schema (follow-up):** `results` collection. Standard xhgui fields: `meta.url`, `meta.SERVER.REQUEST_METHOD`, `meta.request_date`, `profile.main().wt`, etc. Must produce identical `Run`/`RunMeta` output shapes.

## Tool surface

Five tools. All `*_ms` fields are floats to 1 decimal; all sizes are integer kilobytes.

### 1. `list_runs`

Single entry point for listing/searching runs. Covers both "recent runs for this exact URL" and "runs matching these filters across URLs." (Previously split into `list_runs` + `search_runs`; merged to avoid the agent having to pick between near-identical tools.)

- **Input:** `{ url?: string, url_contains?: string, method?: string, since?: string /* ISO-8601 */, until?: string, min_wall_ms?: number, limit?: number = 20 }`
- **Output:** `{ runs: [{ run_id, url, method, wall_ms, cpu_ms, timestamp }] }`
- `url` and `url_contains` are mutually exclusive; passing both is a validation error.
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
    hotspots?: [{ category, symbol, ct, incl_ms, self_ms }],
    truncated?: boolean,
    warnings?: string[]
  }
  ```
- **Hotspots are opt-in from day one** via `XHGUI_HOTSPOT_PATTERNS` (see Configuration). Default is empty → `hotspots` field is omitted entirely from the response. Keeps the package framework-neutral (Decision #1); users configure their own vocabulary in their MCP client config. MSN's patterns (`ElementQuery::one`, `ElementQuery::all`, `internalExecute`, `getAttribute`, `Container::build`, `renderTemplate`) live in the MSN MCP client config, not in the package defaults.

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
- **Variance guardrail:** xhprof runs have natural variance (Opcache state, GC, cache warmup). If `|before.wall_ms − after.wall_ms| / max(before, after) < 0.10`, the response includes a `warnings` entry: `"totals delta within ~10% — likely within run-to-run variance; consider comparing multiple runs per side."` Single-run-per-side is intentional for M3 (keeps the tool simple); multi-run aggregation is a candidate follow-up only if single-run diffs prove misleading in practice.

### 4. `get_symbol_callers`

Per-edge caller/callee breakdown for one symbol in one run.

- **Input:** `{ run_id: string, symbol: string }`
- **Output:**
  ```
  {
    symbol,
    self: { ct, incl_ms, self_ms },            // aggregated across all edges
    parents:  [{ symbol, ct, edge_ms }],       // per-edge: time in THIS symbol when called from parent
    children: [{ symbol, ct, edge_ms }]        // per-edge: time in child when called from THIS symbol
  }
  ```
- **Semantics:** numbers on `parents[]` / `children[]` are **per-edge**, taken directly from xhgui's edge-keyed data. `parents[i].edge_ms` is the wt of the edge `parents[i].symbol==>symbol` — i.e. how much time this particular caller contributed — *not* the parent's own inclusive total. The `self` block carries per-symbol aggregates (matches the formula in the data-notes section).
- Field is named `edge_ms` (not `incl_ms`) specifically so the agent doesn't mistake per-edge numbers for the parent/child's global stats.
- **Replaces:** `profile_symbol.py`.
- On symbol-not-found, error response includes up to 5 substring matches to reduce round-trips.

### 5. `find_slow_endpoints`

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
XHGUI_PDO_DSN=mysql://user:pass@host:3306/xhgui   (required if pdo; SQLite also supported: sqlite:/path/to.db)
XHGUI_MONGO_URI=mongodb://host:port   (required if mongodb; follow-up)
XHGUI_MONGO_DB=xhprof                 (default: 'xhprof'; follow-up)
XHGUI_HOTSPOT_PATTERNS=               (optional CSV of symbol substrings; empty → hotspots field omitted from get_run_summary output)
XHGUI_CONFIG_PATH=/path/config.php    (optional, v2 — parse xhgui config for connection details)
```

The primary target is MySQL/MariaDB (matches MSN's ddev setup); SQLite support falls out naturally from PDO and costs nothing to keep.

## Deployment & ddev integration

The MCP is deliberately generic — it knows nothing about ddev. To connect from the host to MSN's dockerized XHGui:

- **Primary (PDO/MySQL):** `ddev describe` reports the host-mapped MariaDB port. Point `XHGUI_PDO_DSN` at `mysql://<user>:<pass>@127.0.0.1:<mapped_port>/xhgui`. Table is `results` inside the `xhgui` database. Credentials match ddev's default `db/db` (or whatever `ddev describe` shows).
- **Alternative (PDO/SQLite):** supported but not MSN's setup. Mount the SQLite file to the host and point the DSN at it, or run the MCP inside the ddev web container.
- **Follow-up (out of scope for this spec):** a dedicated `ddev-xhgui-mcp` addon that automates port exposure and drops in an MCP client config snippet. Packaging concern, not MCP concern.
- **Invocation during dogfooding (pre-publish):** Claude Code MCP client config points at `node /abs/path/to/xhgui-mcp/dist/server.js`. Post-publish, `npx xhgui-mcp`.

## Error handling

**Philosophy:** fail loudly at the right boundary; never fabricate numbers.

- **Startup errors** (bad config, DB unreachable) → print error, exit non-zero. Server does not start.
- **Tool errors** (returned as structured MCP errors):
  - `run_id not found` → error echoes the id back. For `diff_runs`, error names *which* id (`before_id` vs `after_id`) was not found.
  - `symbol not found in run` → error includes up to 5 substring matches. Matching is case-insensitive and normalizes namespace separators (xhgui stores `\`; user may pass `\\` or `/`).
  - Bad input → zod validation error naming the offending field.
  - Mid-call driver failure → surfaced with context, not swallowed.
- **No silent fallbacks:** missing self-time → `self_ms: null` with a warning; truncated runs → `truncated: true` in output.
- **Logging:** one JSON line per tool call to stderr (stdout reserved for MCP). Shape: `{ts, tool, duration_ms, backend_queries, run_id?, error?}`.

## Testing

**No automated tests for M1–M4.** Rationale (Decision #9): solo project, single real user, single real DB. A SQLite-in-memory "contract test" for a MySQL-backed production target is a different engine and gives false confidence. A real-MySQL testcontainer is heavy for the payoff. Smoke-testing against MSN's xhgui DB during M2 and M3 is stronger signal than either.

**Smoke test protocol during M2+:**

1. Hit an MSN page a handful of times to generate runs.
2. Invoke each tool via the MCP inspector (or a throwaway Claude Code session) against the real DB.
3. Cross-check a representative run against the XHGui web UI — totals, top symbols, self-times should match the UI's numbers within rounding.
4. For `diff_runs`, do a known-good change (e.g. add `sleep(0.1)` to a template filter, profile before/after) and verify the delta lands where expected.

**Directory layout** keeps `test/` out of the tree for now. Re-introduce testing if/when the project grows external users or the formatters get complex enough that manual checking stops being enough. First thing to add back would be pure-function tests for `format/hotspots.ts` and `format/diff.ts` — that's where the bulk of the logic lives and where real-DB fixtures buy the least.

## Milestones

1. **M1 — Skeleton & config.** `server.ts`, `config.ts`, `Backend` interface, empty tool stubs. Runnable as `node dist/server.js` with a clear "no tools yet" response. Inspect the MSN ddev xhgui DB to confirm `xhgui.results` column names and the shape of the profile JSON blob (update data-notes section if anything differs). Confirm connection via `ddev describe`-reported port.
2. **M2 — PDO backend + list/get.** `pdo.ts` + `list_runs` + `get_run_summary` + `format/hotspots.ts`. Smoke-test against MSN xhgui DB: numbers match the XHGui UI for a representative run.
3. **M3 — Diff & symbol navigation.** `diff_runs`, `get_symbol_callers`, `format/diff.ts`. Smoke-test: profile a page, add an obvious perf regression, profile again, verify diff surfaces it.
4. **M4 — Cross-run queries.** `find_slow_endpoints`. Smoke-test against ~1 week of MSN xhgui data.
5. **M5 — MongoDB backend.** `mongo.ts`. Verify identical output shapes against a seeded Mongo instance (either by switching the ddev xhgui addon to mongo temporarily, or a one-off `docker run mongo` with imported fixture data).
6. **M6 — Publish.** README, MCP client config examples (MSN's `XHGUI_HOTSPOT_PATTERNS` value shown as example, not as default), re-add pure-function tests for `format/*` if the code has grown complex enough to warrant them, `npm publish`.

## Open questions

- None blocking. `XHGUI_CONFIG_PATH` fallback and the ddev addon are deliberately deferred.
