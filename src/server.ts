#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import type { Backend } from "./backends/types.js";
import { PdoBackend } from "./backends/pdo.js";
import {
  listRunsDescription,
  listRunsInputSchema,
  runListRuns,
} from "./tools/listRuns.js";
import {
  getRunSummaryDescription,
  getRunSummaryInputSchema,
  runGetRunSummary,
} from "./tools/getRunSummary.js";

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

  const server = new McpServer({ name: "xhgui-mcp", version: "0.1.0" });

  server.registerTool(
    "list_runs",
    {
      description: listRunsDescription,
      inputSchema: listRunsInputSchema.shape,
    },
    async (args) => {
      const started = Date.now();
      try {
        const result = await runListRuns(backend, args);
        log({ event: "tool_ok", tool: "list_runs", duration_ms: Date.now() - started });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        log({
          event: "tool_err",
          tool: "list_runs",
          duration_ms: Date.now() - started,
          error: (err as Error).message,
        });
        throw err;
      }
    }
  );

  server.registerTool(
    "get_run_summary",
    {
      description: getRunSummaryDescription,
      inputSchema: getRunSummaryInputSchema.shape,
    },
    async (args) => {
      const started = Date.now();
      try {
        const result = await runGetRunSummary(backend, config.hotspotPatterns, args);
        log({
          event: "tool_ok",
          tool: "get_run_summary",
          duration_ms: Date.now() - started,
          run_id: args.run_id,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        log({
          event: "tool_err",
          tool: "get_run_summary",
          duration_ms: Date.now() - started,
          error: (err as Error).message,
        });
        throw err;
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log({
    event: "server_started",
    backend: config.backend,
    hotspot_patterns: config.hotspotPatterns.length,
  });

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
