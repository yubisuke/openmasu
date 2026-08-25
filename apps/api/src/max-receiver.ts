import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { uuidV7, withTenant, type PayloadStore } from "@openmasu/runtime";

const allowedParameters = new Set([
  "event_id", "event_token", "event_token_all", "revenue", "all_revenue", "ts",
  "ad_unit_id", "network", "format", "placement", "precision", "cc", "user_id",
]);
const deniedParameters = new Set(["idfa", "idfv", "ip"]);

export type MaxReceiverConfig = {
  tenantId: string;
  appId: string;
  pathSecret: string;
  eventKey: string;
  tokenMode: "all" | "event" | "all_with_event_fallback";
  maxParameters: number;
  maxQueryBytes: number;
};

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function digest(algorithm: "sha1" | "sha256", value: string): string {
  return createHash(algorithm).update(value).digest("hex");
}

export function expectedMaxTokenAll(parameters: URLSearchParams, eventKey: string): string {
  const values = [...parameters.entries()]
    .filter(([name]) => name !== "event_token_all" && name !== "event_token")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value)
    .join("");
  return digest("sha256", `${values}${eventKey}`);
}

export function assertSafeMaxTemplate(template: string): void {
  for (const macro of ["{IDFA}", "{IDFV}", "{IP}"]) {
    if (template.toUpperCase().includes(macro)) throw new Error(`MAX URL template contains denied macro ${macro}`);
  }
}

function verify(parameters: URLSearchParams, config: MaxReceiverConfig): { valid: boolean; mode: "all" | "event" } {
  const all = parameters.get("event_token_all") ?? "";
  if (config.tokenMode !== "event" && all && safeEqual(all, expectedMaxTokenAll(parameters, config.eventKey))) {
    return { valid: true, mode: "all" };
  }
  const eventId = parameters.get("event_id") ?? "";
  const event = parameters.get("event_token") ?? "";
  const eventAllowed = config.tokenMode === "event" || config.tokenMode === "all_with_event_fallback";
  return { valid: eventAllowed && !!eventId && safeEqual(event, digest("sha1", `${eventId}${config.eventKey}`)), mode: "event" };
}

async function auditFailure(pool: Pool, config: MaxReceiverConfig, action: string, reason: string, requestDigest: string): Promise<void> {
  await withTenant(pool, config.tenantId, async (client) => {
    await client.query(
      `INSERT INTO control.apps (tenant_id, app_id, created_at)
       VALUES ($1,$2,$3) ON CONFLICT (tenant_id, app_id) DO NOTHING`,
      [config.tenantId, config.appId, new Date().toISOString()],
    );
    await client.query(
      `INSERT INTO ledger.audit_logs (
        audit_log_id, tenant_id, app_id, occurred_at, actor_type, actor_ref,
        action, target_scope, target_ref, policy_version, request_digest,
        outcome, reason_code
      ) VALUES ($1,$2,$3,$4,'system_job','max_receiver',$5,'app',$8,'max-receiver-v1',$6,'failed',$7)`,
      [uuidV7(), config.tenantId, config.appId, new Date().toISOString(), action, requestDigest, reason, config.appId],
    );
  });
}

export async function receiveMax(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: { pool: Pool; payloadStore: PayloadStore; config: MaxReceiverConfig },
): Promise<void> {
  const rawUrl = request.url ?? "";
  const requestDigest = digest("sha256", rawUrl);
  const queryBytes = Buffer.byteLength(rawUrl.split("?", 2)[1] ?? "", "utf8");
  const url = new URL(rawUrl, "http://localhost");
  const parameters = url.searchParams;
  if (queryBytes > dependencies.config.maxQueryBytes || [...parameters].length > dependencies.config.maxParameters) {
    response.writeHead(400).end();
    return;
  }
  const names = [...parameters.keys()].map((name) => name.toLowerCase());
  if (names.some((name) => deniedParameters.has(name)) || names.some((name) => !allowedParameters.has(name))) {
    await auditFailure(dependencies.pool, dependencies.config, "max_postback_receive", "parameter_not_allowed", requestDigest);
    response.writeHead(400).end();
    return;
  }
  const checked = verify(parameters, dependencies.config);
  if (!checked.valid) {
    await auditFailure(dependencies.pool, dependencies.config, "max_postback_receive", "token_invalid", requestDigest);
    response.writeHead(401).end();
    return;
  }
  const eventId = parameters.get("event_id");
  if (!eventId || !/^[A-Za-z0-9._:-]{1,128}$/.test(eventId)) {
    response.writeHead(400).end();
    return;
  }
  const now = new Date().toISOString();
  const inboxId = uuidV7();
  const payloadReference = await dependencies.payloadStore.write(
    { tenantId: dependencies.config.tenantId, appId: dependencies.config.appId, objectId: inboxId },
    Buffer.from(parameters.toString(), "utf8"),
  );
  await withTenant(dependencies.pool, dependencies.config.tenantId, async (client) => {
    await client.query(
      `INSERT INTO control.apps (tenant_id, app_id, created_at)
       VALUES ($1,$2,$3) ON CONFLICT (tenant_id, app_id) DO NOTHING`,
      [dependencies.config.tenantId, dependencies.config.appId, now],
    );
    const artifact = {
      inbox_id: inboxId,
      tenant_id: dependencies.config.tenantId,
      app_id: dependencies.config.appId,
      producer: "import:applovin-max",
      event_id: eventId,
      token_mode: checked.mode,
      received_at: now,
      raw_query_ref: payloadReference,
      raw_query_digest: requestDigest,
    };
    await client.query(
      `INSERT INTO ledger.ingest_inbox (
        inbox_id, tenant_id, app_id, producer, event_id, token_mode,
        received_at, raw_query_ref, raw_query_digest, artifact
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [inboxId, dependencies.config.tenantId, dependencies.config.appId, artifact.producer, eventId, checked.mode, now, payloadReference, requestDigest, JSON.stringify(artifact)],
    );
    await client.query(
      `INSERT INTO ledger.ingest_inbox_states (
        inbox_id, tenant_id, app_id, status, changed_at, artifact
      ) VALUES ($1,$2,$3,'pending',$4,$5::jsonb)`,
      [inboxId, dependencies.config.tenantId, dependencies.config.appId, now, JSON.stringify({ inbox_id: inboxId, status: "pending", changed_at: now })],
    );
  });
  response.writeHead(204).end();
}
