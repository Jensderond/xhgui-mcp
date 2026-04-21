#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import type { Backend } from "./backends/types.js";
import { PdoBackend } from "./backends/pdo.js";
import { listRunsToolDefinition, runListRuns } from "./tools/listRuns.js";
import { getRunSummaryToolDefinition, runGetRunSummary } from "./tools/getRunSummary.js";

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

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [listRunsToolDefinition, getRunSummaryToolDefinition],
  }));

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
