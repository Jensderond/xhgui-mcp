# xhgui-mcp M1+M2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first shippable increment of `xhgui-mcp`: an MCP stdio server that exposes `list_runs` and `get_run_summary` against MSN's real xhgui MariaDB database.

**Architecture:** TypeScript/Node stdio MCP server. Layered package — `backends/` hides the storage engine behind a `Backend` interface, `format/` has pure summarization functions, `tools/` wires MCP tools to backend + formatters. PDO/MySQL is the only backend for this plan (Mongo follows in a later plan). Spec: `xhgui-mcp/docs/design.md`.

**Tech Stack:** TypeScript, Node 20+, `@modelcontextprotocol/sdk`, `zod` for config/input validation, `mysql2/promise` for PDO/MySQL. No automated test framework for this plan (Decision #9 in the spec — dogfood against MSN's real DB instead).

**Testing approach for this plan:** Smoke-testing only. Each milestone's last task is a manual smoke test against MSN's live xhgui database, cross-checked against the XHGui web UI numbers.

---

## Working directory assumption

All commands run from `/Users/jens/Sites/msn-website/xhgui-mcp/` unless otherwise noted. The repo was initialized with `git init` during brainstorming; the only commit so far is the design spec at `docs/design.md`.

## File map (what this plan creates)

| Path | Responsibility |
|---|---|
| `package.json` | npm manifest, deps, `build`/`start` scripts |
| `tsconfig.json` | TypeScript config, target ES2022, NodeNext modules |
| `.gitignore` | node_modules, dist, .env |
| `README.md` | Brief usage + env vars |
| `src/server.ts` | MCP server wiring, stdio transport, tool registration |
| `src/config.ts` | Env-var parsing + zod validation; single source of truth for config |
| `src/backends/types.ts` | `Backend` interface + shared data types (`Run`, `RunMeta`, `FunctionStats`, `UrlAggregate`, `RunFilter`) |
| `src/backends/pdo.ts` | MySQL implementation of `Backend` |
| `src/format/hotspots.ts` | Pure functions: top-N, self-time derivation, hotspot categorization |
| `src/tools/listRuns.ts` | `list_runs` MCP tool |
| `src/tools/getRunSummary.ts` | `get_run_summary` MCP tool |
| `docs/schema-notes.md` | What the MSN `xhgui.results` table actually looks like (filled during Task 6) |

---

## Task 1: Initialize package scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `README.md`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "xhgui-mcp",
  "version": "0.1.0",
  "description": "MCP server for querying XHGui profiling data",
  "type": "module",
  "bin": {
    "xhgui-mcp": "dist/server.js"
  },
  "scripts": {
    "build": "tsc",
    "start": "node dist/server.js",
    "dev": "tsc --watch"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "mysql2": "^3.11.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.5.0"
  },
  "engines": {
    "node": ">=20"
  },
  "license": "MIT"
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Write `.gitignore`**

```
node_modules/
dist/
.env
.env.local
*.log
```

- [ ] **Step 4: Write minimal `README.md`**

```markdown
# xhgui-mcp

MCP server for querying XHGui profiling data.

## Status

Pre-release. See `docs/design.md`.

## Environment variables

| Var | Required | Example |
|---|---|---|
| `XHGUI_BACKEND` | yes | `pdo` |
| `XHGUI_PDO_DSN` | if pdo | `mysql://db:db@127.0.0.1:32789/xhgui` |
| `XHGUI_HOTSPOT_PATTERNS` | no | `ElementQuery::one,Container::build` |

## Running

    npm install
    npm run build
    XHGUI_BACKEND=pdo XHGUI_PDO_DSN=... node dist/server.js
```

- [ ] **Step 5: Install deps**

Run: `npm install`
Expected: `node_modules/` created, lockfile written, no error.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore README.md
git commit -m "chore: initialize package scaffolding"
```

---

## Task 2: Config module

**Files:**
- Create: `src/config.ts`

Loads env vars, validates with zod, exits non-zero on invalid config. One source of truth for config, imported by `server.ts`.

- [ ] **Step 1: Write `src/config.ts`**

```ts
import { z } from "zod";

const BaseSchema = z.object({
  XHGUI_BACKEND: z.enum(["pdo", "mongodb"]),
  XHGUI_HOTSPOT_PATTERNS: z.string().optional(),
});

const PdoSchema = BaseSchema.extend({
  XHGUI_BACKEND: z.literal("pdo"),
  XHGUI_PDO_DSN: z.string().min(1, "XHGUI_PDO_DSN is required when XHGUI_BACKEND=pdo"),
});

const MongoSchema = BaseSchema.extend({
  XHGUI_BACKEND: z.literal("mongodb"),
  XHGUI_MONGO_URI: z.string().min(1),
  XHGUI_MONGO_DB: z.string().default("xhprof"),
});

const RawSchema = z.discriminatedUnion("XHGUI_BACKEND", [PdoSchema, MongoSchema]);

export interface Config {
  backend: "pdo" | "mongodb";
  pdo?: { dsn: string };
  mongo?: { uri: string; db: string };
  hotspotPatterns: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = RawSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.errors
      .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
      .join("\n");
    throw new Error(`Invalid xhgui-mcp configuration:\n${msg}`);
  }
  const data = parsed.data;

  const hotspotPatterns = (data.XHGUI_HOTSPOT_PATTERNS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (data.XHGUI_BACKEND === "pdo") {
    return {
      backend: "pdo",
      pdo: { dsn: data.XHGUI_PDO_DSN },
      hotspotPatterns,
    };
  }
  return {
    backend: "mongodb",
    mongo: { uri: data.XHGUI_MONGO_URI, db: data.XHGUI_MONGO_DB },
    hotspotPatterns,
  };
}
```

- [ ] **Step 2: Build check**

Run: `npm run build`
Expected: `dist/config.js` exists, no TS errors.

- [ ] **Step 3: Manual smoke test**

Run: `XHGUI_BACKEND=pdo XHGUI_PDO_DSN=mysql://x node -e "import('./dist/config.js').then(m => console.log(m.loadConfig()))"`
Expected output includes `{ backend: 'pdo', pdo: { dsn: 'mysql://x' }, hotspotPatterns: [] }`

Run: `node -e "import('./dist/config.js').then(m => m.loadConfig({}))" 2>&1 | head -5`
Expected: throws `Invalid xhgui-mcp configuration:` listing `XHGUI_BACKEND` as missing.

- [ ] **Step 4: Commit**

```bash
git add src/config.ts
git commit -m "feat: config loader with zod validation"
```

---

## Task 3: Backend interface & data types

**Files:**
- Create: `src/backends/types.ts`

Defines the contract every backend implementation satisfies. Kept in one file because the types are small and always read together.

- [ ] **Step 1: Write `src/backends/types.ts`**

```ts
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

export interface FunctionStats {
  ct: number;    // call count
  wt: number;    // inclusive wall time (µs)
  cpu: number;   // inclusive cpu time (µs)
  mu: number;    // inclusive memory (bytes)
  pmu: number;   // inclusive peak memory (bytes)
}

export interface Run {
  meta: RunMeta;
  totals: { wallUs: number; cpuUs: number; muBytes: number; pmuBytes: number };
  // Keys are "parent==>child" strings; "main()" is the root entry key.
  profile: Record<string, FunctionStats>;
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

- [ ] **Step 2: Build check**

Run: `npm run build`
Expected: no TS errors.

- [ ] **Step 3: Commit**

```bash
git add src/backends/types.ts
git commit -m "feat: backend interface and data types"
```

---

## Task 4: PDO backend stub (connect + close only)

**Files:**
- Create: `src/backends/pdo.ts`

Stub that opens a connection pool and throws on every query method. Lets Task 5 wire a real backend into the server without having the query logic block startup.

- [ ] **Step 1: Write `src/backends/pdo.ts`**

```ts
import mysql from "mysql2/promise";
import type { Backend, Run, RunFilter, RunMeta, UrlAggregate } from "./types.js";

export class PdoBackend implements Backend {
  private pool: mysql.Pool;

  constructor(dsn: string) {
    // mysql2 accepts a URL string directly via createPool(uri)
    this.pool = mysql.createPool(dsn);
  }

  async listRuns(_filter: RunFilter): Promise<RunMeta[]> {
    throw new Error("PdoBackend.listRuns not implemented yet");
  }

  async getRun(_runId: string): Promise<Run | null> {
    throw new Error("PdoBackend.getRun not implemented yet");
  }

  async aggregateByUrl(_filter: RunFilter): Promise<UrlAggregate[]> {
    throw new Error("PdoBackend.aggregateByUrl not implemented yet");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
```

- [ ] **Step 2: Build check**

Run: `npm run build`
Expected: no TS errors.

- [ ] **Step 3: Commit**

```bash
git add src/backends/pdo.ts
git commit -m "feat: PDO backend stub with connection pool"
```

---

## Task 5: Server skeleton with no tools

**Files:**
- Create: `src/server.ts`

Starts the MCP stdio server, registers zero tools, shuts down cleanly. Validates the scaffolding end-to-end.

- [ ] **Step 1: Write `src/server.ts`**

```ts
#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import type { Backend } from "./backends/types.js";
import { PdoBackend } from "./backends/pdo.js";

function log(obj: Record<string, unknown>): void {
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n");
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }

  let backend: Backend;
  if (config.backend === "pdo") {
    backend = new PdoBackend(config.pdo!.dsn);
  } else {
    throw new Error("MongoDB backend not implemented in this milestone");
  }

  const server = new Server(
    { name: "xhgui-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    throw new Error(`Unknown tool: ${req.params.name}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log({ event: "server_started", backend: config.backend, hotspot_patterns: config.hotspotPatterns.length });

  const shutdown = async () => {
    await backend.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: no TS errors; `dist/server.js` exists.

- [ ] **Step 3: Smoke-test startup with invalid config**

Run: `node dist/server.js 2>&1 | head -5`
Expected: prints `Invalid xhgui-mcp configuration:` listing missing `XHGUI_BACKEND`; exit code 1.

- [ ] **Step 4: Smoke-test startup with a dummy DSN (pool lazily connects, so this should run until SIGINT)**

Run: `XHGUI_BACKEND=pdo XHGUI_PDO_DSN=mysql://x:y@127.0.0.1:1/none node dist/server.js </dev/null >/dev/null 2>/tmp/xhgui-mcp.log & sleep 1; kill $!; cat /tmp/xhgui-mcp.log`
Expected: stderr contains a `server_started` JSON log line; process exits cleanly.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "feat: MCP stdio server skeleton with zero tools"
```

---

## Task 6: Inspect MSN xhgui DB & document schema

**Files:**
- Create: `docs/schema-notes.md`

This is the M1 verification step from the spec. Tasks 7+ assume the xhgui PDO schema; this task confirms it, and if anything differs, updates Task 7's SQL before execution.

- [ ] **Step 1: Identify MSN's mapped MariaDB port**

Run: `ddev describe -p /Users/jens/Sites/msn-website | grep -iE "mariadb|mysql|db:"`
Expected: a line naming the host-mapped port (e.g. `db:3306 -> 127.0.0.1:32789`).

- [ ] **Step 2: Identify xhgui DB credentials**

Run: `ddev exec -d /var/www/html --project /Users/jens/Sites/msn-website cat /etc/xhgui/config/config.php 2>/dev/null || ddev describe -p /Users/jens/Sites/msn-website | grep -iE "user|pass"`
Expected: credentials (ddev default is typically `db`/`db`). Record the working DSN.

If the config file path differs, locate it via: `ddev exec -d /var/www/html --project /Users/jens/Sites/msn-website find / -name "config.php" -path "*xhgui*" 2>/dev/null`

- [ ] **Step 3: Inspect the `results` table**

Run (adjust port/creds from steps 1–2): `ddev exec --project /Users/jens/Sites/msn-website mysql -u db -pdb xhgui -e "DESCRIBE results"`
Expected: column list with types.

Also capture: `ddev exec --project /Users/jens/Sites/msn-website mysql -u db -pdb xhgui -e "SELECT * FROM results ORDER BY id DESC LIMIT 1\\G"`
Expected: one full row.

- [ ] **Step 4: Record findings in `docs/schema-notes.md`**

Write the file with sections: **Connection DSN**, **`results` table columns** (name, type, what xhgui stores there), **Profile JSON shape** (paste a trimmed example), and **Divergences from spec** (if any). Example skeleton:

```markdown
# MSN xhgui schema notes

## Connection
- Host-mapped DSN: `mysql://db:db@127.0.0.1:<port>/xhgui`
- Verified against MSN ddev on <date>.

## `results` table
| Column | Type | Purpose |
|---|---|---|
| id | CHAR(24) | Run ID (primary key) |
| url | VARCHAR(...) | Request URL |
| ... | ... | ... |

## Profile JSON shape
Stored in column `...`. Example trimmed entry:

    {
      "main()": { "ct": 1, "wt": 123456, ... },
      "main()==>SomeClass::method": { ... }
    }

## Divergences from design spec
- None | <list>
```

- [ ] **Step 5: If schema diverges from Task 7's assumptions, annotate**

If the column names or JSON shape differ from what Task 7 below assumes (`id`, `url`, `SERVER` JSON, `profile` JSON, `request_ts`, `main_wt`, `main_cpu`, `main_mu`, `main_pmu`), annotate Task 7 inline with the actual names BEFORE starting Task 7. The goal is that Task 7 runs against the real schema, not an assumed one.

- [ ] **Step 6: Commit**

```bash
git add docs/schema-notes.md docs/plans/2026-04-21-m1-m2-skeleton-and-pdo.md
git commit -m "docs: MSN xhgui schema notes"
```

---

## Task 7: PDO `listRuns` implementation

**Files:**
- Modify: `src/backends/pdo.ts` (replace the `listRuns` stub)

Queries the `results` table with WHERE clauses built from the `RunFilter`. Uses parameterized queries — no string interpolation into SQL.

**Schema assumption (verify/adjust per Task 6):** Table `results`, columns at minimum: `id` (varchar, primary key, hex run id), `url` (varchar), `SERVER` (JSON or LONGTEXT containing the $_SERVER dump), `request_ts` (int/bigint, unix seconds), `main_wt` (int, wall µs), `main_cpu` (int, cpu µs). Method lives inside the `SERVER` JSON under key `REQUEST_METHOD`.

- [ ] **Step 1: Replace `listRuns` in `src/backends/pdo.ts`**

Replace the single `listRuns` method (keep the rest of the file unchanged). Final state of the method:

```ts
async listRuns(filter: RunFilter): Promise<RunMeta[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.url !== undefined && filter.urlContains !== undefined) {
    throw new Error("Provide either url or urlContains, not both");
  }
  if (filter.url !== undefined) {
    where.push("url = ?");
    params.push(filter.url);
  }
  if (filter.urlContains !== undefined) {
    where.push("url LIKE ?");
    params.push(`%${filter.urlContains}%`);
  }
  if (filter.since !== undefined) {
    where.push("request_ts >= ?");
    params.push(Math.floor(filter.since.getTime() / 1000));
  }
  if (filter.until !== undefined) {
    where.push("request_ts <= ?");
    params.push(Math.floor(filter.until.getTime() / 1000));
  }
  if (filter.minWallUs !== undefined) {
    where.push("main_wt >= ?");
    params.push(filter.minWallUs);
  }
  if (filter.method !== undefined) {
    // method is nested in the SERVER JSON blob; use JSON_EXTRACT
    where.push("JSON_UNQUOTE(JSON_EXTRACT(`SERVER`, '$.REQUEST_METHOD')) = ?");
    params.push(filter.method);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(filter.limit ?? 20, 500));
  const sql =
    `SELECT id, url, ` +
    `JSON_UNQUOTE(JSON_EXTRACT(\`SERVER\`, '$.REQUEST_METHOD')) AS method, ` +
    `main_wt AS wall_us, main_cpu AS cpu_us, request_ts ` +
    `FROM results ${whereSql} ORDER BY request_ts DESC LIMIT ${limit}`;

  const [rows] = await this.pool.query(sql, params);
  const list = rows as Array<{
    id: string;
    url: string;
    method: string | null;
    wall_us: number | string | null;
    cpu_us: number | string | null;
    request_ts: number | string;
  }>;

  return list.map((r) => ({
    runId: r.id,
    url: r.url,
    method: r.method ?? "",
    wallUs: Number(r.wall_us ?? 0),
    cpuUs: Number(r.cpu_us ?? 0),
    timestamp: new Date(Number(r.request_ts) * 1000),
  }));
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: no TS errors.

- [ ] **Step 3: Smoke-test against MSN xhgui (direct script)**

Create a throwaway: `node --input-type=module -e "
import('./dist/backends/pdo.js').then(async ({PdoBackend}) => {
  const b = new PdoBackend(process.env.XHGUI_PDO_DSN);
  console.log(await b.listRuns({ limit: 3 }));
  await b.close();
});" `

Run with `XHGUI_PDO_DSN` set from Task 6. Expected: array of 3 `RunMeta` objects with real URLs, timestamps, and wall-µs values.

Cross-check: `XHGUI_PDO_DSN=... <the curl/mysql equivalent>` — pick the same 3 most recent run ids in the XHGui web UI (`https://msn.nl.internal:8142/`) and confirm the URLs and wall times match.

- [ ] **Step 4: Commit**

```bash
git add src/backends/pdo.ts
git commit -m "feat: PDO listRuns with filter support"
```

---

## Task 8: `list_runs` MCP tool

**Files:**
- Create: `src/tools/listRuns.ts`
- Modify: `src/server.ts` (register the tool)

Wire the backend method into an MCP tool. The tool file owns input validation and formatting; the server file owns registration.

- [ ] **Step 1: Write `src/tools/listRuns.ts`**

```ts
import { z } from "zod";
import type { Backend } from "../backends/types.js";

export const listRunsInputSchema = z
  .object({
    url: z.string().optional(),
    url_contains: z.string().optional(),
    method: z.string().optional(),
    since: z.string().datetime().optional(),
    until: z.string().datetime().optional(),
    min_wall_ms: z.number().nonnegative().optional(),
    limit: z.number().int().positive().max(500).default(20),
  })
  .refine((v) => !(v.url !== undefined && v.url_contains !== undefined), {
    message: "Pass either url or url_contains, not both",
  });

export type ListRunsInput = z.infer<typeof listRunsInputSchema>;

export const listRunsToolDefinition = {
  name: "list_runs",
  description:
    "List recent xhgui profiling runs, optionally filtered by URL (exact or substring), method, time range, or minimum wall time.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Exact URL to match" },
      url_contains: { type: "string", description: "Substring to match against URL" },
      method: { type: "string", description: "HTTP method (GET, POST, …)" },
      since: { type: "string", description: "ISO-8601 lower bound for request time" },
      until: { type: "string", description: "ISO-8601 upper bound for request time" },
      min_wall_ms: { type: "number", description: "Minimum wall time in ms" },
      limit: { type: "number", description: "Max rows (1–500, default 20)" },
    },
  },
} as const;

export async function runListRuns(backend: Backend, rawInput: unknown): Promise<{ runs: Array<Record<string, unknown>> }> {
  const input = listRunsInputSchema.parse(rawInput);
  const runs = await backend.listRuns({
    url: input.url,
    urlContains: input.url_contains,
    method: input.method,
    since: input.since ? new Date(input.since) : undefined,
    until: input.until ? new Date(input.until) : undefined,
    minWallUs: input.min_wall_ms !== undefined ? Math.round(input.min_wall_ms * 1000) : undefined,
    limit: input.limit,
  });
  return {
    runs: runs.map((r) => ({
      run_id: r.runId,
      url: r.url,
      method: r.method,
      wall_ms: Number((r.wallUs / 1000).toFixed(1)),
      cpu_ms: Number((r.cpuUs / 1000).toFixed(1)),
      timestamp: r.timestamp.toISOString(),
    })),
  };
}
```

- [ ] **Step 2: Register tool in `src/server.ts`**

Modify `src/server.ts`: replace the two empty request handlers with versions that dispatch to `runListRuns`. Add imports at the top and change the handlers. Final state of those sections:

Imports (add near existing imports):

```ts
import { listRunsToolDefinition, runListRuns } from "./tools/listRuns.js";
```

Handler registration (replace the two empty handlers):

```ts
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [listRunsToolDefinition],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const started = Date.now();
  try {
    if (req.params.name === "list_runs") {
      const result = await runListRuns(backend, req.params.arguments ?? {});
      log({ event: "tool_ok", tool: req.params.name, duration_ms: Date.now() - started });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    throw new Error(`Unknown tool: ${req.params.name}`);
  } catch (err) {
    log({
      event: "tool_err",
      tool: req.params.name,
      duration_ms: Date.now() - started,
      error: (err as Error).message,
    });
    throw err;
  }
});
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: no TS errors.

- [ ] **Step 4: Smoke-test via MCP inspector or a throwaway client**

Use the MCP SDK's inspector, or a simple stdio client harness. Minimal harness (put in `/tmp/mcp-probe.mjs`):

```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["/Users/jens/Sites/msn-website/xhgui-mcp/dist/server.js"],
  env: {
    XHGUI_BACKEND: "pdo",
    XHGUI_PDO_DSN: process.env.XHGUI_PDO_DSN,
    PATH: process.env.PATH,
  },
});
const client = new Client({ name: "probe", version: "0" }, { capabilities: {} });
await client.connect(transport);
console.log(await client.listTools());
console.log(await client.callTool({ name: "list_runs", arguments: { limit: 3 } }));
await client.close();
```

Run: `XHGUI_PDO_DSN=... node /tmp/mcp-probe.mjs`
Expected: `listTools` returns one tool named `list_runs`; `callTool` returns content with 3 runs matching recent xhgui runs.

- [ ] **Step 5: Commit**

```bash
git add src/tools/listRuns.ts src/server.ts
git commit -m "feat: list_runs MCP tool"
```

---

## Task 9: PDO `getRun` implementation

**Files:**
- Modify: `src/backends/pdo.ts` (replace the `getRun` stub)

Fetches a single run by id, including the full profile JSON blob.

**Schema assumption (verify/adjust per Task 6):** column holding profile JSON is named `profile` (LONGTEXT containing JSON). Memory totals live in `main_mu` / `main_pmu` (int bytes).

- [ ] **Step 1: Replace `getRun` in `src/backends/pdo.ts`**

```ts
async getRun(runId: string): Promise<Run | null> {
  const sql =
    `SELECT id, url, ` +
    `JSON_UNQUOTE(JSON_EXTRACT(\`SERVER\`, '$.REQUEST_METHOD')) AS method, ` +
    `main_wt AS wall_us, main_cpu AS cpu_us, ` +
    `main_mu AS mu_bytes, main_pmu AS pmu_bytes, ` +
    `request_ts, profile ` +
    `FROM results WHERE id = ? LIMIT 1`;
  const [rows] = await this.pool.query(sql, [runId]);
  const row = (rows as Array<Record<string, unknown>>)[0];
  if (!row) return null;

  const profileRaw = row.profile;
  let profile: Record<string, FunctionStats>;
  try {
    profile = typeof profileRaw === "string" ? JSON.parse(profileRaw) : (profileRaw as Record<string, FunctionStats>);
  } catch (err) {
    throw new Error(`Run ${runId}: profile JSON parse failed — ${(err as Error).message}`);
  }

  return {
    meta: {
      runId: String(row.id),
      url: String(row.url),
      method: String(row.method ?? ""),
      wallUs: Number(row.wall_us ?? 0),
      cpuUs: Number(row.cpu_us ?? 0),
      timestamp: new Date(Number(row.request_ts) * 1000),
    },
    totals: {
      wallUs: Number(row.wall_us ?? 0),
      cpuUs: Number(row.cpu_us ?? 0),
      muBytes: Number(row.mu_bytes ?? 0),
      pmuBytes: Number(row.pmu_bytes ?? 0),
    },
    profile,
  };
}
```

Also add the `FunctionStats` import at the top of `pdo.ts` (alongside the existing type imports):

```ts
import type { Backend, FunctionStats, Run, RunFilter, RunMeta, UrlAggregate } from "./types.js";
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: no TS errors.

- [ ] **Step 3: Smoke-test**

Grab a run id from Task 7's output, then:

```
XHGUI_PDO_DSN=... node --input-type=module -e "
import('./dist/backends/pdo.js').then(async ({PdoBackend}) => {
  const b = new PdoBackend(process.env.XHGUI_PDO_DSN);
  const run = await b.getRun('<run_id>');
  console.log('meta:', run.meta);
  console.log('totals:', run.totals);
  console.log('profile keys:', Object.keys(run.profile).length);
  console.log('first key:', Object.keys(run.profile)[0], run.profile[Object.keys(run.profile)[0]]);
  await b.close();
});"
```

Expected: meta matches XHGui UI; `profile keys` is the number of edges (dozens to thousands); the first entry key is either `main()` or something of shape `"a==>b"`.

Also test the null path: pass a fake id, expect `null`.

- [ ] **Step 4: Commit**

```bash
git add src/backends/pdo.ts
git commit -m "feat: PDO getRun with profile JSON parsing"
```

---

## Task 10: `format/hotspots.ts` — self-time derivation + top-N

**Files:**
- Create: `src/format/hotspots.ts`

Pure functions, backend-agnostic. This is the module the spec calls out as load-bearing for correctness ("silently goes wrong if implemented wrong"). Keep the passes explicit and document them.

- [ ] **Step 1: Write `src/format/hotspots.ts`**

```ts
import type { FunctionStats, Run } from "../backends/types.js";

export interface SymbolStats {
  symbol: string;
  ct: number;
  wt: number;    // inclusive wall time (µs)
  selfWt: number | null; // null if derivation impossible
}

/**
 * XHGui stores per-edge stats keyed as "parent==>child" (plus a root entry
 * usually keyed "main()"). Given those edges, derive per-symbol stats:
 *
 *   incl(sym) = Σ edge.wt where edge endpoints in "*==>sym"
 *   self(sym) = incl(sym) − Σ edge.wt where edge endpoints in "sym==>*"
 *
 * The root entry ("main()") is its own key with no "==>" separator; we treat
 * its stats as its own inclusive numbers (no incoming edges to sum).
 */
export function deriveSymbolStats(run: Run): Map<string, SymbolStats> {
  const incl = new Map<string, { ct: number; wt: number }>();
  const outgoing = new Map<string, number>(); // sym → Σ wt of outgoing edges
  const hadIncoming = new Set<string>();

  for (const [key, stats] of Object.entries(run.profile)) {
    const arrow = key.indexOf("==>");
    if (arrow === -1) {
      // Root entry, e.g. "main()". No parent.
      const existing = incl.get(key) ?? { ct: 0, wt: 0 };
      incl.set(key, { ct: existing.ct + stats.ct, wt: existing.wt + stats.wt });
      continue;
    }
    const parent = key.slice(0, arrow);
    const child = key.slice(arrow + 3);

    const childIncl = incl.get(child) ?? { ct: 0, wt: 0 };
    incl.set(child, { ct: childIncl.ct + stats.ct, wt: childIncl.wt + stats.wt });
    hadIncoming.add(child);

    outgoing.set(parent, (outgoing.get(parent) ?? 0) + stats.wt);
  }

  const out = new Map<string, SymbolStats>();
  for (const [sym, { ct, wt }] of incl) {
    const outSum = outgoing.get(sym) ?? 0;
    // A symbol with no incoming edges that isn't the root can't have reliable
    // self-time. The root ("main()") is fine: we have its raw wt.
    const isRoot = !sym.includes("==>") && !hadIncoming.has(sym);
    const selfWt = isRoot || hadIncoming.has(sym) ? wt - outSum : null;
    out.set(sym, { symbol: sym, ct, wt, selfWt });
  }
  return out;
}

export interface TopEntry {
  symbol: string;
  ct: number;
  inclMs: number;
  selfMs: number | null;
}

export function topByInclusive(stats: Map<string, SymbolStats>, n: number): TopEntry[] {
  return Array.from(stats.values())
    .sort((a, b) => b.wt - a.wt)
    .slice(0, n)
    .map(toTopEntry);
}

export function topBySelf(stats: Map<string, SymbolStats>, n: number): TopEntry[] {
  return Array.from(stats.values())
    .filter((s) => s.selfWt !== null)
    .sort((a, b) => (b.selfWt ?? 0) - (a.selfWt ?? 0))
    .slice(0, n)
    .map(toTopEntry);
}

export interface HotspotEntry extends TopEntry {
  category: string;
}

export function matchHotspots(stats: Map<string, SymbolStats>, patterns: string[]): HotspotEntry[] {
  if (patterns.length === 0) return [];
  const out: HotspotEntry[] = [];
  for (const pattern of patterns) {
    // Take the heaviest (by inclusive wt) symbol whose name contains the pattern.
    let best: SymbolStats | null = null;
    for (const s of stats.values()) {
      if (!s.symbol.includes(pattern)) continue;
      if (!best || s.wt > best.wt) best = s;
    }
    if (best) {
      out.push({ category: pattern, ...toTopEntry(best) });
    }
  }
  return out;
}

function toTopEntry(s: SymbolStats): TopEntry {
  return {
    symbol: s.symbol,
    ct: s.ct,
    inclMs: Number((s.wt / 1000).toFixed(1)),
    selfMs: s.selfWt === null ? null : Number((s.selfWt / 1000).toFixed(1)),
  };
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: no TS errors.

- [ ] **Step 3: Sanity-check against a real run**

```
XHGUI_PDO_DSN=... node --input-type=module -e "
import('./dist/backends/pdo.js').then(async ({PdoBackend}) => {
  const { deriveSymbolStats, topByInclusive, topBySelf } = await import('./dist/format/hotspots.js');
  const b = new PdoBackend(process.env.XHGUI_PDO_DSN);
  const runs = await b.listRuns({ limit: 1 });
  const run = await b.getRun(runs[0].runId);
  const stats = deriveSymbolStats(run);
  console.log('top 5 inclusive:', topByInclusive(stats, 5));
  console.log('top 5 self:', topBySelf(stats, 5));
  await b.close();
});"
```

Expected: top-5-inclusive is dominated by `main()` or request-lifecycle functions; top-5-self lists leaf-ish functions (DB queries, string ops). Cross-check against the same run in the XHGui UI — the top symbols and ms numbers should match within rounding.

- [ ] **Step 4: Commit**

```bash
git add src/format/hotspots.ts
git commit -m "feat: self-time derivation and top-N formatters"
```

---

## Task 11: `get_run_summary` MCP tool

**Files:**
- Create: `src/tools/getRunSummary.ts`
- Modify: `src/server.ts` (register the tool)

Second tool. Pulls a run via `backend.getRun`, runs it through `format/hotspots.ts`, returns the summary shape from the spec.

- [ ] **Step 1: Write `src/tools/getRunSummary.ts`**

```ts
import { z } from "zod";
import type { Backend } from "../backends/types.js";
import {
  deriveSymbolStats,
  matchHotspots,
  topByInclusive,
  topBySelf,
  type HotspotEntry,
  type TopEntry,
} from "../format/hotspots.js";

export const getRunSummaryInputSchema = z.object({
  run_id: z.string().min(1),
  top_n: z.number().int().positive().max(100).default(15),
});

export type GetRunSummaryInput = z.infer<typeof getRunSummaryInputSchema>;

export const getRunSummaryToolDefinition = {
  name: "get_run_summary",
  description:
    "Summarize a single xhgui run: request totals, top functions by inclusive and self time, and optional hotspot matches.",
  inputSchema: {
    type: "object",
    required: ["run_id"],
    properties: {
      run_id: { type: "string", description: "xhgui run id" },
      top_n: { type: "number", description: "How many top functions to return per list (1–100, default 15)" },
    },
  },
} as const;

export interface GetRunSummaryOutput {
  url: string;
  method: string;
  timestamp: string;
  totals: { wall_ms: number; cpu_ms: number; memory_kb: number; peak_memory_kb: number };
  top_by_inclusive: TopEntry[];
  top_by_self: TopEntry[];
  hotspots?: HotspotEntry[];
  warnings?: string[];
}

export async function runGetRunSummary(
  backend: Backend,
  hotspotPatterns: string[],
  rawInput: unknown
): Promise<GetRunSummaryOutput> {
  const input = getRunSummaryInputSchema.parse(rawInput);
  const run = await backend.getRun(input.run_id);
  if (!run) {
    throw new Error(`run_id not found: ${input.run_id}`);
  }

  const stats = deriveSymbolStats(run);
  const warnings: string[] = [];
  let missingSelf = 0;
  for (const s of stats.values()) if (s.selfWt === null) missingSelf++;
  if (missingSelf > 0) {
    warnings.push(`${missingSelf} symbol(s) had no incoming edges; their self_ms is null.`);
  }

  const output: GetRunSummaryOutput = {
    url: run.meta.url,
    method: run.meta.method,
    timestamp: run.meta.timestamp.toISOString(),
    totals: {
      wall_ms: Number((run.totals.wallUs / 1000).toFixed(1)),
      cpu_ms: Number((run.totals.cpuUs / 1000).toFixed(1)),
      memory_kb: Math.round(run.totals.muBytes / 1024),
      peak_memory_kb: Math.round(run.totals.pmuBytes / 1024),
    },
    top_by_inclusive: topByInclusive(stats, input.top_n),
    top_by_self: topBySelf(stats, input.top_n),
  };
  const hotspots = matchHotspots(stats, hotspotPatterns);
  if (hotspots.length > 0) output.hotspots = hotspots;
  if (warnings.length > 0) output.warnings = warnings;
  return output;
}
```

- [ ] **Step 2: Register in `src/server.ts`**

Update imports:

```ts
import { listRunsToolDefinition, runListRuns } from "./tools/listRuns.js";
import { getRunSummaryToolDefinition, runGetRunSummary } from "./tools/getRunSummary.js";
```

Update the `ListToolsRequestSchema` handler:

```ts
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [listRunsToolDefinition, getRunSummaryToolDefinition],
}));
```

Update the `CallToolRequestSchema` handler's dispatch (add the new branch before the "Unknown tool" throw):

```ts
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const started = Date.now();
  try {
    let result: unknown;
    if (req.params.name === "list_runs") {
      result = await runListRuns(backend, req.params.arguments ?? {});
    } else if (req.params.name === "get_run_summary") {
      result = await runGetRunSummary(backend, config.hotspotPatterns, req.params.arguments ?? {});
    } else {
      throw new Error(`Unknown tool: ${req.params.name}`);
    }
    log({
      event: "tool_ok",
      tool: req.params.name,
      duration_ms: Date.now() - started,
      run_id:
        typeof req.params.arguments === "object" && req.params.arguments !== null
          ? (req.params.arguments as Record<string, unknown>).run_id
          : undefined,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    log({
      event: "tool_err",
      tool: req.params.name,
      duration_ms: Date.now() - started,
      error: (err as Error).message,
    });
    throw err;
  }
});
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: no TS errors.

- [ ] **Step 4: Smoke-test both tools end-to-end**

Reuse the `/tmp/mcp-probe.mjs` harness from Task 8, extended:

```js
const list = await client.callTool({ name: "list_runs", arguments: { limit: 1 } });
console.log(list);
const runId = JSON.parse(list.content[0].text).runs[0].run_id;
const summary = await client.callTool({ name: "get_run_summary", arguments: { run_id: runId, top_n: 5 } });
console.log(summary);
```

Run: `XHGUI_PDO_DSN=... XHGUI_HOTSPOT_PATTERNS='ElementQuery::one,Container::build,renderTemplate' node /tmp/mcp-probe.mjs`

Expected: `get_run_summary` returns the summary shape with populated `top_by_inclusive`, `top_by_self`, `hotspots` (given the MSN patterns), and totals that match the XHGui UI for that run.

Also test error paths:
- `callTool({ name: "get_run_summary", arguments: { run_id: "deadbeef" } })` → error `run_id not found: deadbeef`.
- `callTool({ name: "get_run_summary", arguments: { top_n: 5 } })` → zod validation error naming `run_id`.

- [ ] **Step 5: Commit**

```bash
git add src/tools/getRunSummary.ts src/server.ts
git commit -m "feat: get_run_summary MCP tool"
```

---

## Task 12: End-to-end smoke test & MSN MCP client config

**Files:**
- Modify: `README.md` (document MSN-specific invocation example)

Validate the full M2 slice against the MSN xhgui DB and document how to wire it into Claude Code.

- [ ] **Step 1: Choose a representative page**

Hit a page a few times to generate runs (pick one that's slow enough to have a rich call tree, e.g. an article listing):

```
curl -sk https://msn.nl.internal/ -o /dev/null
curl -sk https://msn.nl.internal/ -o /dev/null
curl -sk https://msn.nl.internal/ -o /dev/null
```

- [ ] **Step 2: Run the MCP against it and cross-check the UI**

Using the probe harness from Task 11, call `list_runs` then `get_run_summary` on the most recent run. Open the same run in the XHGui web UI. Confirm:
- `totals.wall_ms` matches the UI's "Wall Time" within 1ms rounding.
- `top_by_inclusive[0].symbol` matches the UI's top function.
- `top_by_self[0]` matches the UI's top-self function.
- If `XHGUI_HOTSPOT_PATTERNS` is set, `hotspots[]` contains the patterns that actually appear in the run.

If numbers diverge materially, open an issue — do not mark this task complete. Likely culprits: self-time formula edge cases (revisit `deriveSymbolStats`), or µs-vs-ms unit confusion in one of the tool outputs.

- [ ] **Step 3: Document MSN-specific MCP client config in `README.md`**

Append to `README.md`:

```markdown
## Using with Claude Code (MSN-specific example)

Add to your Claude Code MCP config:

    {
      "mcpServers": {
        "xhgui": {
          "command": "node",
          "args": ["/Users/jens/Sites/msn-website/xhgui-mcp/dist/server.js"],
          "env": {
            "XHGUI_BACKEND": "pdo",
            "XHGUI_PDO_DSN": "mysql://db:db@127.0.0.1:<ddev-mariadb-port>/xhgui",
            "XHGUI_HOTSPOT_PATTERNS": "ElementQuery::one,ElementQuery::all,internalExecute,getAttribute,Container::build,renderTemplate"
          }
        }
      }
    }

Find the mapped MariaDB port via `ddev describe` in the MSN project directory.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: MSN MCP client config example"
```

- [ ] **Step 5: Tag the M2 milestone**

```bash
git tag m2-smoke-passed
```

---

## Out of scope for this plan

- `diff_runs`, `get_symbol_callers`, `find_slow_endpoints` tools (M3–M4).
- MongoDB backend (M5).
- Publishing to npm (M6).
- Automated tests (Decision #9; revisit at M6 per spec).

These become follow-up plans once M2 is proven against real MSN xhgui data.
