export interface Backend {
  ping(): Promise<void>;
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
  url: string;        // Full URL including query string.
  simpleUrl: string;  // URL with query string stripped (xhgui's normalized form).
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
