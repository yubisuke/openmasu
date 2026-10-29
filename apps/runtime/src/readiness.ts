import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";
import { readMigrations } from "./migration-engine.js";

export type ReadinessProbe = () => Promise<boolean>;
export const READINESS_TIMEOUT_MS = 1500;

/** Coalesces public probes; timeout and errors reveal no internal details. */
export function boundedReadiness(check: ReadinessProbe, timeoutMs = READINESS_TIMEOUT_MS): ReadinessProbe {
  let pending: Promise<boolean> | undefined;
  let expires = 0;
  let result = false;
  return () => {
    if (pending) return pending;
    if (Date.now() < expires) return Promise.resolve(result);
    pending = new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      Promise.resolve().then(check).then(resolve, () => resolve(false)).finally(() => clearTimeout(timer));
    }).then(value => {
      result = value;
      expires = Date.now() + 1000;
      pending = undefined;
      return value;
    });
    return pending;
  };
}

export async function payloadDirectoryReady(root: string): Promise<boolean> {
  for (const name of ["objects", "keys"]) {
    const path = join(root, name);
    if (!(await stat(path)).isDirectory()) return false;
    await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
  }
  return true;
}

export function createRuntimeReadiness(options: {
  databaseUrl: string;
  tenantId: string;
  payloadDirectory: string;
  localWorkerHealthy?: () => boolean;
}): { check: ReadinessProbe; close: () => Promise<void> } {
  const expected = readMigrations().map(({ version, name, checksum }) => ({ version, name, checksum }));
  // Independent, bounded reader connection: probes cannot starve business pools.
  const pool = new Pool({ connectionString: options.databaseUrl, max: 1,
    connectionTimeoutMillis: 500, statement_timeout: 500, query_timeout: 750 });
  pool.on("error", () => undefined);
  const check = boundedReadiness(async () => {
    if (options.localWorkerHealthy && !options.localWorkerHealthy()) return false;
    let client: PoolClient | undefined;
    let released = false;
    const release = (error?: Error): void => {
      if (client && !released) { released = true; client.release(error); }
    };
    const deadline = setTimeout(() => release(new Error("readiness_timeout")), 1200);
    try {
      client = await pool.connect();
      await client.query("BEGIN READ ONLY");
      await client.query("SELECT set_config('openmasu.tenant_id',$1,true)", [options.tenantId]);
      const inventory = await client.query("SELECT version,name,checksum FROM control.runtime_schema_inventory ORDER BY version");
      if (JSON.stringify(inventory.rows) !== JSON.stringify(expected)) return false;
      const heartbeat = await client.query(
        "SELECT 1 FROM control.worker_heartbeats WHERE tenant_id=$1 AND expires_at > clock_timestamp()", [options.tenantId]);
      return heartbeat.rowCount === 1 && await payloadDirectoryReady(options.payloadDirectory);
    } finally {
      clearTimeout(deadline);
      // Destroy the short read transaction even on a timeout; never leak a lock.
      release(new Error("readiness_probe_finished"));
    }
  });
  return { check, close: () => pool.end() };
}

export function serveRuntimeHealth(request: IncomingMessage, response: ServerResponse, check?: ReadinessProbe): boolean {
  const path = request.url?.split("?", 1)[0];
  if (request.method !== "GET" || (path !== "/health" && path !== "/ready")) return false;
  const reply = (ready: boolean): void => {
    response.writeHead(ready ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ status: path === "/health" ? "ok" : ready ? "ready" : "not_ready" }));
  };
  if (path === "/health") reply(true);
  else Promise.resolve().then(() => check?.() ?? false).then(reply, () => reply(false));
  return true;
}
