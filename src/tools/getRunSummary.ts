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
  run_id: z.string().min(1).describe("xhgui run id"),
  top_n: z.number().int().positive().max(100).default(15)
    .describe("How many top functions to return per list (1–100, default 15)"),
});

export type GetRunSummaryInput = z.infer<typeof getRunSummaryInputSchema>;

export const getRunSummaryDescription =
  "Summarize a single xhgui run: request totals, top functions by inclusive and self time, and optional hotspot matches.";

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
