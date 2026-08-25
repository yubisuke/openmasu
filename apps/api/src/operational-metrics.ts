import type { Pool } from "pg";
import { withTenant } from "@openmasu/runtime";
import type { RouteHandler } from "./routes.js";

type RouteLabel = RouteHandler | "unmatched";
type MethodLabel = "GET" | "POST" | "OTHER";
type StatusClass = "2xx" | "3xx" | "4xx" | "5xx";

const durationBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] as const;

function methodLabel(method: string | undefined): MethodLabel {
  return method === "GET" || method === "POST" ? method : "OTHER";
}

function statusClass(status: number): StatusClass {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  return "2xx";
}

function labels(values: Readonly<Record<string, string>>): string {
  return `{${Object.entries(values).map(([key, value]) => `${key}="${value}"`).join(",")}}`;
}

export class OperationalMetrics {
  private readonly requests = new Map<string, number>();
  private readonly durationCounts = new Map<string, number[]>();
  private readonly durationSums = new Map<string, number>();

  observe(route: RouteLabel, method: string | undefined, status: number, durationMs: number): void {
    const boundedMethod = methodLabel(method);
    const key = `${route}\u0000${boundedMethod}\u0000${statusClass(status)}`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
    const durationKey = `${route}\u0000${boundedMethod}`;
    const counts = this.durationCounts.get(durationKey) ?? durationBuckets.map(() => 0);
    const seconds = Math.max(0, durationMs) / 1000;
    durationBuckets.forEach((bucket, index) => {
      if (seconds <= bucket) counts[index] += 1;
    });
    this.durationCounts.set(durationKey, counts);
    this.durationSums.set(durationKey, (this.durationSums.get(durationKey) ?? 0) + seconds);
  }

  renderProcessMetrics(): string[] {
    const lines = [
      "# HELP openmasu_http_requests_total Bounded API requests by route, method, and status class.",
      "# TYPE openmasu_http_requests_total counter",
    ];
    for (const [key, count] of [...this.requests].sort(([left], [right]) => left.localeCompare(right))) {
      const [route, method, status] = key.split("\u0000");
      lines.push(`openmasu_http_requests_total${labels({ route, method, status_class: status })} ${count}`);
    }
    lines.push(
      "# HELP openmasu_http_request_duration_seconds API request processing duration.",
      "# TYPE openmasu_http_request_duration_seconds histogram",
    );
    for (const [key, counts] of [...this.durationCounts].sort(([left], [right]) => left.localeCompare(right))) {
      const [route, method] = key.split("\u0000");
      durationBuckets.forEach((bucket, index) => {
        lines.push(`openmasu_http_request_duration_seconds_bucket${labels({ route, method, le: String(bucket) })} ${counts[index]}`);
      });
      const count = this.requestsForRouteMethod(route as RouteLabel, method as MethodLabel);
      lines.push(`openmasu_http_request_duration_seconds_bucket${labels({ route, method, le: "+Inf" })} ${count}`);
      lines.push(`openmasu_http_request_duration_seconds_sum${labels({ route, method })} ${this.durationSums.get(key) ?? 0}`);
      lines.push(`openmasu_http_request_duration_seconds_count${labels({ route, method })} ${count}`);
    }
    return lines;
  }

  private requestsForRouteMethod(route: RouteLabel, method: MethodLabel): number {
    return (["2xx", "3xx", "4xx", "5xx"] as const)
      .reduce((sum, status) => sum + (this.requests.get(`${route}\u0000${method}\u0000${status}`) ?? 0), 0);
  }
}

export async function renderOperationalMetrics(
  pool: Pool,
  tenantId: string,
  metrics: OperationalMetrics,
): Promise<string> {
  const backlog = await withTenant(pool, tenantId, async (client) => {
    const inbox = await client.query<{ count: string; oldest: string }>(
      `SELECT count(*)::text AS count,
              COALESCE(EXTRACT(EPOCH FROM (clock_timestamp()-min(received_at::timestamptz))),0)::text AS oldest
         FROM ledger.ingest_inbox_current
        WHERE tenant_id=$1 AND status='pending'`,
      [tenantId],
    );
    const batches = await client.query<{ count: string; oldest: string }>(
      `SELECT count(*)::text AS count,
              COALESCE(EXTRACT(EPOCH FROM (clock_timestamp()-min(received_at::timestamptz))),0)::text AS oldest
         FROM ledger.ingest_batches_current
        WHERE tenant_id=$1 AND status='pending'`,
      [tenantId],
    );
    const adservices = await client.query<{ count: string; oldest: string }>(
      `SELECT count(*)::text AS count,
              COALESCE(EXTRACT(EPOCH FROM (clock_timestamp()-min(created_at))),0)::text AS oldest
         FROM ephemeral.adservices_lookups
        WHERE tenant_id=$1`,
      [tenantId],
    );
    return {
      inbox: inbox.rows[0],
      batches: batches.rows[0],
      adservices: adservices.rows[0],
    };
  });
  const lines = metrics.renderProcessMetrics();
  lines.push(
    "# HELP openmasu_ingest_backlog Pending durable ingest work by bounded queue.",
    "# TYPE openmasu_ingest_backlog gauge",
    `openmasu_ingest_backlog${labels({ queue: "max_inbox" })} ${backlog.inbox.count}`,
    `openmasu_ingest_backlog${labels({ queue: "sdk_batches" })} ${backlog.batches.count}`,
    `openmasu_ingest_backlog${labels({ queue: "adservices" })} ${backlog.adservices.count}`,
    "# HELP openmasu_ingest_oldest_pending_seconds Age of the oldest pending item in a bounded queue.",
    "# TYPE openmasu_ingest_oldest_pending_seconds gauge",
    `openmasu_ingest_oldest_pending_seconds${labels({ queue: "max_inbox" })} ${backlog.inbox.oldest}`,
    `openmasu_ingest_oldest_pending_seconds${labels({ queue: "sdk_batches" })} ${backlog.batches.oldest}`,
    `openmasu_ingest_oldest_pending_seconds${labels({ queue: "adservices" })} ${backlog.adservices.oldest}`,
  );
  return `${lines.join("\n")}\n`;
}
