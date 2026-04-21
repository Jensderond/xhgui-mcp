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
