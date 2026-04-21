import { z } from "zod";
import type { Backend } from "../backends/types.js";

export const listRunsInputSchema = z.object({
  url: z.string().optional().describe("Exact URL to match"),
  url_contains: z.string().optional().describe("Substring to match against URL"),
  method: z.string().optional().describe("HTTP method (GET, POST, …)"),
  since: z.string().datetime().optional().describe("ISO-8601 lower bound for request time"),
  until: z.string().datetime().optional().describe("ISO-8601 upper bound for request time"),
  min_wall_ms: z.number().nonnegative().optional().describe("Minimum wall time in ms"),
  limit: z.number().int().positive().max(500).default(20).describe("Max rows (1–500, default 20)"),
});

export type ListRunsInput = z.infer<typeof listRunsInputSchema>;

export const listRunsDescription =
  "List recent xhgui profiling runs, optionally filtered by URL (exact or substring), method, time range, or minimum wall time.";

export async function runListRuns(
  backend: Backend,
  input: ListRunsInput
): Promise<{ runs: Array<Record<string, unknown>> }> {
  if (input.url !== undefined && input.url_contains !== undefined) {
    throw new Error("Pass either url or url_contains, not both");
  }
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
