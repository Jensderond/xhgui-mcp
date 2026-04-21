import { z } from "zod";
import type { Backend } from "../backends/types.js";
import {
  deriveSymbolStats,
  matchHotspots,
  topByInclusive,
  topBySelf,
} from "../format/hotspots.js";

export const getRunSummaryInputSchema = z.object({
  run_id: z.string().min(1).describe("xhgui run id"),
  top_n: z.number().int().positive().max(100).default(15)
    .describe("How many top functions to return per list (1–100, default 15)"),
  include_full_url: z.boolean().default(false)
    .describe("Include the raw URL with query string as `url_full`. Off by default: query strings can contain tokens/PII."),
});

const topEntrySchema = z.object({
  symbol: z.string(),
  ct: z.number(),
  inclMs: z.number(),
  selfMs: z.number().nullable(),
});

const hotspotEntrySchema = topEntrySchema.extend({
  category: z.string(),
});

export const getRunSummaryOutputSchema = z.object({
  url: z.string().describe("Normalized URL with query string stripped."),
  url_full: z.string().optional().describe("Raw URL with query string. Only present when include_full_url=true."),
  method: z.string(),
  timestamp: z.string(),
  totals: z.object({
    wall_ms: z.number(),
    cpu_ms: z.number(),
    memory_kb: z.number(),
    peak_memory_kb: z.number(),
  }),
  top_by_inclusive: z.array(topEntrySchema),
  top_by_self: z.array(topEntrySchema),
  hotspots: z.array(hotspotEntrySchema).optional(),
  warnings: z.array(z.string()).optional(),
});

export type GetRunSummaryInput = z.infer<typeof getRunSummaryInputSchema>;
export type GetRunSummaryOutput = z.infer<typeof getRunSummaryOutputSchema>;

export const getRunSummaryDescription =
  "Summarize a single xhgui run: request totals, top functions by inclusive and self time, and optional hotspot matches. " +
  "URL is returned with the query string stripped by default; pass include_full_url=true to receive the raw URL as `url_full`.";

export async function runGetRunSummary(
  backend: Backend,
  hotspotPatterns: string[],
  input: GetRunSummaryInput
): Promise<GetRunSummaryOutput> {
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
    url: run.meta.simpleUrl,
    ...(input.include_full_url ? { url_full: run.meta.url } : {}),
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
