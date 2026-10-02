import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { groupingDimensionAllowlist, reportTransportKeys } from "../apps/api/src/report-query.js";
import { differenceColumns, metricColumns, recordCountColumns } from "../apps/api/src/reporting.js";
import { serverEventNames } from "../apps/api/src/server-routes.js";

type Json = Record<string, any>;
const schema = (name: string): Json => JSON.parse(readFileSync(`schemas/${name}.schema.json`, "utf8"));
const reference = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (value: Json) => ({ anyOf: [value, { type: "null" }] });
// Projection rules stay here; domain fields/enums and event payload schemas remain normative.
function commonReferences(value: Json): Json {
  return JSON.parse(JSON.stringify(value).replaceAll('common.schema.json#/', '#/components/schemas/Common/'));
}
function errorResponse(description: string) { return { description, content: { "application/json": { schema: reference("Error") } } }; }
export function buildHttpApiContract(): Json {
  const common = schema("common"); delete common.$id; delete common.$schema;
  const metric = schema("metric-run"), reconciliation = schema("reconciliation-result"), fixture = schema("fixture-input");
  const group = commonReferences(metric.properties.grouping.properties.dimensions);
  delete group.minProperties; // The HTTP projection also preserves an absent legacy grouping as {}.
  const metricProperties: Json = Object.fromEntries(metricColumns.map((name) => [name, commonReferences(metric.properties[name] ?? {})]));
  Object.assign(metricProperties, {
    policy_versions: { type: "array", items: { type: "string" } }, grouping: group,
    grouping_digest: metric.properties.grouping.properties.dimension_digest, superseded: { type: "boolean" },
    comparison_context: { type: ["object", "null"], description: "Saved aggregate-only meaning; null/unknown is not reconstructed." },
    cost_update_state: { type: "string", description: "Current persisted recalculation/input-revision state." },
    late_input_update_state: { type: "string", description: "Explicit late-input request state; not proof of upstream completeness." },
  });
  for (const name of ["currency", "amount_scale", "ratio_scale", "undefined_reason", "supersedes_metric_run_id"]) metricProperties[name] = nullable(metricProperties[name]);
  const schemas: Json = {
    Common: common,
    Error: { type: "object", required: ["error"], properties: { error: { type: "string" } }, additionalProperties: false },
    AcceptedBatch: { type: "object", required: ["ingest_batch_id", "status"], properties: { ingest_batch_id: { type: "string" }, status: { const: "pending" } }, additionalProperties: false },
    MetricRow: { type: "object", required: ["metric_run_id", "metric_name", "value_state"], properties: metricProperties, additionalProperties: false,
      allOf: [{ if: { properties: { value_state: { const: "present" } }, required: ["value_state"] }, then: { required: ["value_unscaled"] },
        else: { required: ["undefined_reason"], properties: { undefined_reason: metric.properties.undefined_reason }, not: { required: ["value_unscaled"] } } }] },
    DifferenceRow: { type: "object", properties: Object.fromEntries(differenceColumns.map((name) => [name, name === "superseded" ? { type: "boolean" } : commonReferences(reconciliation.properties[name] ?? {})])) },
    RecordCountRow: { type: "object", required: [...recordCountColumns], properties: { metric_name: metric.properties.metric_name, grouping: group, count: { type: "string", pattern: "^[0-9]+$" } }, additionalProperties: false },
    ServerRecord: { oneOf: serverEventNames.map((name) => ({
      type: "object", required: ["producer_version", "event_id", "event_name", "occurred_at", "processing_sequence", "payload"],
      properties: {
        producer_version: { ...fixture.$defs.record.properties.producer_version, maxLength: 128 },
        producer_variant: fixture.$defs.record.properties.producer_variant, wrapper_version: fixture.$defs.record.properties.wrapper_version,
        event_id: reference("CommonId"), event_name: { const: name }, occurred_at: fixture.$defs.ingressDateTimeSyntax,
        processing_sequence: fixture.$defs.record.properties.processing_sequence,
        payload: { $ref: `../../schemas/events/${name.replaceAll("_", "-")}.schema.json`, description: "Event-schema validation occurs asynchronously before ledger persistence; 202 is inbox admission, not validation completion." },
      },
      description: "Tenant/app/producer/receipt IDs and time are server-assigned. All records must share one installation anchor, or all omit it. Authority claims are forbidden.",
    })) },
    CommonId: { $ref: "#/components/schemas/Common/$defs/id" },
    ServerBatch: { type: "object", required: ["records"], properties: { records: { type: "array", minItems: 1, items: reference("ServerRecord") } } },
  };
  // Common's own local references must resolve inside the embedded component.
  schemas.Common = JSON.parse(JSON.stringify(common).replaceAll('"#/$defs/', '"#/components/schemas/Common/$defs/'));
  const queryParameter = (name: string, value: Json, description: string, required = false): Json => ({ name, in: "query", required, description, schema: value });
  const queryParameters: Json[] = [
    queryParameter("app_id", reference("CommonId"), "Registered app in the authenticated tenant; missing, unknown and cross-tenant apps return the same 404.", true),
    { ...queryParameter("metric_name", { type: "array", items: metric.properties.metric_name }, "Repeated values deduplicate and sort."), style: "form", explode: true },
    queryParameter("metric_definition_version", metric.properties.metric_definition_version, "Exact saved definition version."),
    queryParameter("date_from", { type: "string", format: "date" }, "Inclusive lower calendar-date bound."),
    queryParameter("date_to", { type: "string", format: "date" }, "Exclusive upper calendar-date bound; from must precede to."),
    queryParameter("watermark_at_most", { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?Z$" }, "UTC evidence cutoff, not a claim that every upstream event arrived. Required for records."),
    queryParameter("difference_reason_code", { type: "string", pattern: "^[a-z][a-z0-9_]{2,127}$" }, "Difference audit only: filter stored reason, never infer a cause. An unknown well-formed reason can return no rows."),
    queryParameter("supersession", { type: "string", enum: ["latest", "all"], default: "latest" }, "Exclude same-scope replaced runs, or include immutable history."),
    queryParameter("limit", { type: "integer", minimum: 1, default: 200 }, "Normal default 200/max OPENMASU_REPORT_MAX_ROWS (1000); CSV export default/max OPENMASU_REPORT_EXPORT_MAX_ROWS (200000)."),
    queryParameter("after", { type: "string", maxLength: 8192 }, "Opaque endpoint-specific keyset next_cursor; retain app, selection and watermark. No OFFSET or atomic multi-page snapshot claim."),
    queryParameter("format", { type: "string", enum: ["json", "csv"], default: "json" }, "Common stored-row projection; CSV has an empty value cell for undefined."),
    queryParameter("export", { type: "string", enum: ["false", "true"], default: "false" }, "true requires CSV; rejects export_limit_exceeded rather than truncating."),
    ...Object.keys(groupingDimensionAllowlist).map((name) => queryParameter(`grouping_${name}`, group.properties[name], "Declared non-identifying dimension; deterministic and Apple aggregate series stay distinct.")),
  ];
  const report = (operationId: string, row: string, columns: readonly string[], records = false): Json => ({
    operationId, summary: "Read persisted app-scoped aggregate results", security: [{ OperatorBearer: [] }],
    parameters: queryParameters.map((parameter) => records && parameter.name === "watermark_at_most" ? { ...parameter, required: true } : parameter),
    "x-unknown-query-keys": "rejected", "x-query-keys": [...reportTransportKeys],
    responses: {
      "200": { description: "Stored rows only; empty is not an inferred zero. No-store. CSV uses x-next-cursor; JSON uses next_cursor.",
        headers: { "x-next-cursor": { schema: { type: "string" }, description: "Next page when present." }, "Cache-Control": { schema: { const: "no-store" } } },
        content: { "application/json": { schema: { type: "object", required: ["data"], properties: { data: { type: "array", items: reference(row) }, next_cursor: { type: "string" } }, additionalProperties: false } },
          "text/csv": { schema: { type: "string" }, "x-columns": [...columns] } } },
      "400": errorResponse("Invalid/unknown/duplicate filter, invalid cursor, unsupported series/export or missing records watermark."),
      "401": errorResponse("Invalid/missing bearer; cookies are not authentication for /v1."), "403": errorResponse("Missing read capability."),
      "404": errorResponse("App missing, unknown or outside the authenticated tenant."), "500": errorResponse("Server failure; do not interpret as empty data."),
    },
  });
  const headerNames = ["app-id", "server-key-id", "timestamp-ms", "nonce", "signature"];
  const securitySchemes: Json = { OperatorBearer: { type: "http", scheme: "bearer", description: "Operator key with read capability; never send the backend signing secret here." } };
  for (const name of headerNames) securitySchemes[`Server_${name}`] = { type: "apiKey", in: "header", name: `x-openmasu-${name}`, description: "Required together; raw-body HMAC, not five independent static API keys." };
  return {
    openapi: "3.1.1", info: { title: "OpenMasu backend events and read reports", version: JSON.parse(readFileSync("sdk/unity/com.openmasu.sdk/package.json", "utf8")).version,
      description: "Limited HTTP surface, not all OpenMasu routes. No administration, SDK enrollment, privacy, dashboard, callback or outbound APIs. Contract wire 0.4.0 is independent. Admission is not calculation or exactly-once external delivery." },
    servers: [{ url: "https://metrics.example.invalid", description: "Non-routable synthetic placeholder; operator supplies the real origin separately." }],
    paths: {
      "/v1/events/server": { post: { operationId: "submitBackendEvents", summary: "Admit first-party backend events to the durable inbox", security: [Object.fromEntries(headerNames.map((name) => [`Server_${name}`, []]))],
        parameters: [
          { name: "x-openmasu-app-id", in: "header", required: true, schema: reference("CommonId") },
          { name: "x-openmasu-server-key-id", in: "header", required: true, schema: reference("CommonId") },
          { name: "x-openmasu-timestamp-ms", in: "header", required: true, schema: { type: "string", pattern: "^[0-9]+$" }, description: "Unix milliseconds within configured skew; safe integer required." },
          { name: "x-openmasu-nonce", in: "header", required: true, schema: { type: "string", pattern: "^[A-Za-z0-9_-]{22,128}$" } },
          { name: "x-openmasu-signature", in: "header", required: true, schema: { type: "string", pattern: "^[0-9a-f]{64}$" } },
        ],
        "x-signature-source": "apps/api/src/server-auth.ts:serverCanonicalString/signServerRequest",
        "x-body-limit": { default_bytes: 262144, environment: "OPENMASU_SERVER_INGEST_MAX_BYTES", default_events: 100, events_environment: "OPENMASU_SERVER_INGEST_MAX_EVENTS" },
        description: "SHA256/HMAC covers exact bytes. Timestamp Unix milliseconds, nonce 22-128 base64url characters, signature 64 lowercase hex. Fresh nonce/timestamp/signature on retry; keep producer-scoped event_id and payload stable across types. Identical digest duplicates, differing digest conflicts. Timeout/500 may be result-unknown: inspect receipt state; no automatic client retry or end-to-end exactly-once promise.",
        requestBody: { required: true, content: { "application/json": { schema: reference("ServerBatch"), example: { records: [{ producer_version: "synthetic-backend-1", event_id: "event:synthetic-http", event_name: "custom_event", occurred_at: "2026-08-20T00:00:00.000Z", processing_sequence: 1, payload: { event_name: "custom_event", installation_id: "installation:synthetic-http", event_key: "synthetic_http", attributes: {} } }] } } } },
        responses: { "202": { description: "Durable inbox admission; status pending. Worker may still reject event payload. Scheduling/report calculation is separate.", content: { "application/json": { schema: reference("AcceptedBatch") } } },
          "400": errorResponse("Malformed JSON, event count or envelope fields."), "401": errorResponse("unauthorized: invalid HMAC, inactive key, timestamp or reused nonce."),
          "403": errorResponse("Forbidden event/authority claim, mixed subject or inactive privacy scope."), "413": errorResponse("Body exceeds configured byte bound."),
          "429": errorResponse("Rate limited; back off before retry with a fresh signature/nonce."), "500": errorResponse("Result may be unknown; do not manufacture a new event_id."),
        } } },
      "/v1/reports/metrics": { get: report("readMetrics", "MetricRow", metricColumns) },
      "/v1/reports/records": { get: report("readRecordCounts", "RecordCountRow", recordCountColumns, true) },
      "/v1/audit/differences": { get: report("readDifferenceAudit", "DifferenceRow", differenceColumns) },
    }, components: { securitySchemes, schemas },
  };
}
export function serializedHttpApiContract(): string { return `${JSON.stringify(buildHttpApiContract(), null, 2)}\n`; }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).join(" ") !== "--write") throw new Error("only --write is supported");
  mkdirSync("docs/api", { recursive: true }); writeFileSync("docs/api/openapi.json", serializedHttpApiContract());
  console.log("Generated limited HTTP contract: backend events and three read-only report routes.");
}
