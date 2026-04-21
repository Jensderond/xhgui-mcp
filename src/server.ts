#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import type { Backend } from "./backends/types.js";
import { PdoBackend } from "./backends/pdo.js";
import {
  listRunsDescription,
  listRunsInputSchema,
  listRunsOutputSchema,
  runListRuns,
} from "./tools/listRuns.js";
import {
  getRunSummaryDescription,
  getRunSummaryInputSchema,
  getRunSummaryOutputSchema,
  runGetRunSummary,
} from "./tools/getRunSummary.js";

function scrubDsn(msg: string): string {
  return msg.replace(/(\/\/[^:@/\s]+):[^@/\s]+@/g, "$1:***@");
}

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

  try {
    await backend.ping();
  } catch (err) {
    process.stderr.write(`Startup failed: cannot reach backend — ${scrubDsn((err as Error).message)}\n`);
    await backend.close().catch(() => {});
    process.exit(1);
  }

  const server = new McpServer({ name: "xhgui-mcp", version: "0.1.0" });

  server.registerTool(
    "list_runs",
    {
      description: listRunsDescription,
      inputSchema: listRunsInputSchema.shape,
      outputSchema: listRunsOutputSchema.shape,
    },
    async (args) => {
      const started = Date.now();
      try {
        const result = await runListRuns(backend, args);
        log({ event: "tool_ok", tool: "list_runs", duration_ms: Date.now() - started });
        return {
          structuredContent: result,
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
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
      outputSchema: getRunSummaryOutputSchema.shape,
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
        return {
          structuredContent: result,
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
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
    try {
      await server.close();
    } catch {
      // ignore
    }
    await backend.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${scrubDsn((err as Error).stack ?? String(err))}\n`);
  process.exit(1);
});
