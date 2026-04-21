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
  include_full_url: z.boolean().default(false)
    .describe("Include the raw URL with query string as `url_full`. Off by default: query strings can contain tokens/PII."),
});

const runEntrySchema = z.object({
  run_id: z.string(),
  url: z.string().describe("Normalized URL with query string stripped (xhgui `simple_url`)."),
  url_full: z.string().optional().describe("Raw URL with query string. Only present when include_full_url=true."),
  method: z.string(),
  wall_ms: z.number(),
  cpu_ms: z.number(),
  timestamp: z.string(),
});

export const listRunsOutputSchema = z.object({
  runs: z.array(runEntrySchema),
});

export type ListRunsInput = z.infer<typeof listRunsInputSchema>;
export type ListRunsOutput = z.infer<typeof listRunsOutputSchema>;

export const listRunsDescription =
  "List recent xhgui profiling runs, optionally filtered by URL (exact or substring), method, time range, or minimum wall time. " +
  "URLs are returned with the query string stripped by default; pass include_full_url=true to receive the raw URL as `url_full`.";

export async function runListRuns(
  backend: Backend,
  input: ListRunsInput
): Promise<ListRunsOutput> {
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
      url: r.simpleUrl,
      ...(input.include_full_url ? { url_full: r.url } : {}),
      method: r.method,
      wall_ms: Number((r.wallUs / 1000).toFixed(1)),
      cpu_ms: Number((r.cpuUs / 1000).toFixed(1)),
      timestamp: r.timestamp.toISOString(),
    })),
  };
}
