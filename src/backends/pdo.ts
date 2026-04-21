import mysql from "mysql2/promise";
import type { Backend, Run, RunFilter, RunMeta, UrlAggregate } from "./types.js";

export class PdoBackend implements Backend {
  private pool: mysql.Pool;

  constructor(dsn: string) {
    // mysql2 accepts a URL string directly via createPool(uri)
    this.pool = mysql.createPool(dsn);
  }

  async listRuns(filter: RunFilter): Promise<RunMeta[]> {
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
      `SELECT id, url, ` +
      `JSON_UNQUOTE(JSON_EXTRACT(\`SERVER\`, '$.REQUEST_METHOD')) AS method, ` +
      `main_wt AS wall_us, main_cpu AS cpu_us, request_ts ` +
      `FROM results ${whereSql} ORDER BY request_ts DESC LIMIT ${limit}`;

    const [rows] = await this.pool.query(sql, params);
    const list = rows as Array<{
      id: string;
      url: string;
      method: string | null;
      wall_us: number | string | null;
      cpu_us: number | string | null;
      request_ts: number | string;
    }>;

    return list.map((r) => ({
      runId: r.id,
      url: r.url,
      method: r.method ?? "",
      wallUs: Number(r.wall_us ?? 0),
      cpuUs: Number(r.cpu_us ?? 0),
      timestamp: new Date(Number(r.request_ts) * 1000),
    }));
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
