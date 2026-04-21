import mysql from "mysql2/promise";
import type { Backend, FunctionStats, Run, RunFilter, RunMeta, UrlAggregate } from "./types.js";

// Redact `user:password@host` → `user:***@host` in any string that might echo a DSN.
function scrubDsn(msg: string): string {
  return msg.replace(/(\/\/[^:@/\s]+):[^@/\s]+@/g, "$1:***@");
}

function wrap<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err: unknown) => {
    const e = err as Error;
    const scrubbed = new Error(scrubDsn(e.message));
    scrubbed.stack = e.stack ? scrubDsn(e.stack) : undefined;
    throw scrubbed;
  });
}

export class PdoBackend implements Backend {
  private pool: mysql.Pool;

  constructor(dsn: string) {
    try {
      // mysql2 accepts a URL string directly via createPool(uri)
      this.pool = mysql.createPool(dsn);
    } catch (err) {
      throw new Error(scrubDsn((err as Error).message));
    }
  }

  async ping(): Promise<void> {
    return wrap(async () => {
      const [rows] = await this.pool.query("SELECT 1 AS ok");
      const row = (rows as Array<{ ok: number }>)[0];
      if (!row || row.ok !== 1) throw new Error("SELECT 1 returned unexpected result");
    });
  }

  async listRuns(filter: RunFilter): Promise<RunMeta[]> {
    return wrap(async () => {
      const where: string[] = [];
      const params: unknown[] = [];

      if (filter.url !== undefined && filter.urlContains !== undefined) {
        throw new Error("Provide either url or urlContains, not both");
      }
      if (filter.url !== undefined) {
        where.push("url = ?");
        params.push(filter.url);
      }
      if (filter.urlContains !== undefined) {
        where.push("url LIKE ?");
        params.push(`%${filter.urlContains}%`);
      }
      if (filter.since !== undefined) {
        where.push("request_ts >= ?");
        params.push(Math.floor(filter.since.getTime() / 1000));
      }
      if (filter.until !== undefined) {
        where.push("request_ts <= ?");
        params.push(Math.floor(filter.until.getTime() / 1000));
      }
      if (filter.minWallUs !== undefined) {
        where.push("main_wt >= ?");
        params.push(filter.minWallUs);
      }
      if (filter.method !== undefined) {
        where.push("JSON_UNQUOTE(JSON_EXTRACT(`SERVER`, '$.REQUEST_METHOD')) = ?");
        params.push(filter.method);
      }

      const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      const limit = Math.max(1, Math.min(filter.limit ?? 20, 500));
      const sql =
        `SELECT id, url, simple_url, ` +
        `JSON_UNQUOTE(JSON_EXTRACT(\`SERVER\`, '$.REQUEST_METHOD')) AS method, ` +
        `main_wt AS wall_us, main_cpu AS cpu_us, request_ts ` +
        `FROM results ${whereSql} ORDER BY request_ts DESC LIMIT ${limit}`;

      const [rows] = await this.pool.query(sql, params);
      const list = rows as Array<{
        id: string;
        url: string;
        simple_url: string | null;
        method: string | null;
        wall_us: number | string | null;
        cpu_us: number | string | null;
        request_ts: number | string;
      }>;

      return list.map((r) => ({
        runId: r.id,
        url: r.url,
        simpleUrl: r.simple_url ?? r.url,
        method: r.method ?? "",
        wallUs: Number(r.wall_us ?? 0),
        cpuUs: Number(r.cpu_us ?? 0),
        timestamp: new Date(Number(r.request_ts) * 1000),
      }));
    });
  }

  async getRun(runId: string): Promise<Run | null> {
    return wrap(async () => {
      const sql =
        `SELECT id, url, simple_url, ` +
        `JSON_UNQUOTE(JSON_EXTRACT(\`SERVER\`, '$.REQUEST_METHOD')) AS method, ` +
        `main_wt AS wall_us, main_cpu AS cpu_us, ` +
        `main_mu AS mu_bytes, main_pmu AS pmu_bytes, ` +
        `request_ts, profile ` +
        `FROM results WHERE id = ? LIMIT 1`;
      const [rows] = await this.pool.query(sql, [runId]);
      const row = (rows as Array<Record<string, unknown>>)[0];
      if (!row) return null;

      const profileRaw = row.profile;
      let profile: Record<string, FunctionStats>;
      try {
        profile = typeof profileRaw === "string" ? JSON.parse(profileRaw) : (profileRaw as Record<string, FunctionStats>);
      } catch (err) {
        throw new Error(`Run ${runId}: profile JSON parse failed — ${(err as Error).message}`);
      }

      return {
        meta: {
          runId: String(row.id),
          url: String(row.url),
          simpleUrl: row.simple_url == null ? String(row.url) : String(row.simple_url),
          method: String(row.method ?? ""),
          wallUs: Number(row.wall_us ?? 0),
          cpuUs: Number(row.cpu_us ?? 0),
          timestamp: new Date(Number(row.request_ts) * 1000),
        },
        totals: {
          wallUs: Number(row.wall_us ?? 0),
          cpuUs: Number(row.cpu_us ?? 0),
          muBytes: Number(row.mu_bytes ?? 0),
          pmuBytes: Number(row.pmu_bytes ?? 0),
        },
        profile,
      };
    });
  }

  async aggregateByUrl(_filter: RunFilter): Promise<UrlAggregate[]> {
    throw new Error("PdoBackend.aggregateByUrl not implemented yet");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
