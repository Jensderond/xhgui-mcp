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
