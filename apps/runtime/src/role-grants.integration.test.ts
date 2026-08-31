import assert from "node:assert/strict";
import { createMigrationPool } from "./index.js";

type Privilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "TRUNCATE";
type Role = "openmasu_app" | "openmasu_reader" | "openmasu_seed";
type Row = {
  schema_name: string;
  table_name: string;
  role_name: Role;
  select_privilege: boolean;
  insert_privilege: boolean;
  update_privilege: boolean;
  delete_privilege: boolean;
  truncate_privilege: boolean;
};

const privileges: Privilege[] = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"];
const readerNoTableSelect = new Set([
  "control.admin_keys",
  "control.admin_key_states",
  "control.google_play_purchase_tokens",
  "control.google_play_rtdn_messages",
  "control.google_play_order_digests",
  "control.commerce_provider_notifications",
  "control.commerce_purchase_bindings",
  "control.commerce_backfill_checkpoints",
  "control.google_data_manager_destinations",
  "control.operator_webhook_destinations",
  "control.operator_webhook_destination_states",
  "control.operator_bulk_export_destinations",
  "control.operator_bulk_export_destination_states",
  "control.operator_bulk_export_checkpoints",
  "control.metric_replay_manifests",
  "control.public_postback_audits",
  "control.privacy_deletion_jobs",
  "control.privacy_payload_purges",
  "ledger.adservices_lookup_results",
  "ledger.operator_webhook_delivery_results",
  "ledger.operator_bulk_export_deletions",
  "ledger.operator_bulk_export_results",
  "ephemeral.operator_webhook_deliveries",
  "ephemeral.operator_bulk_export_batches",
]);
const seedControlTruncate = new Set([
  "control.admin_keys",
  "control.admin_key_states",
  "control.google_play_purchase_tokens",
  "control.google_play_rtdn_messages",
  "control.google_play_order_digests",
  "control.commerce_provider_notifications",
  "control.commerce_purchase_bindings",
  "control.commerce_backfill_checkpoints",
  "control.google_data_manager_destinations",
  "control.app_link_identities",
  "control.link_domains",
  "control.metric_replay_manifests",
  "control.public_postback_audits",
  "control.server_keys",
  "control.server_key_states",
  "control.operator_webhook_destinations",
  "control.operator_webhook_destination_states",
  "control.operator_bulk_export_destinations",
  "control.operator_bulk_export_destination_states",
  "control.operator_bulk_export_checkpoints",
  "control.metric_schedules",
  "control.metric_schedule_states",
  "control.metric_schedule_checkpoints",
  "control.privacy_deletion_jobs",
  "control.privacy_payload_purges",
  "control.rule_bundle_revisions",
  "control.worker_job_schedules",
]);
const ephemeralExpected = new Map<string, Record<Role, Privilege[]>>([
  ["ephemeral.request_nonces", {
    openmasu_app: ["SELECT", "INSERT", "DELETE"], openmasu_reader: [], openmasu_seed: ["TRUNCATE"],
  }],
  ["ephemeral.dashboard_sessions", {
    openmasu_app: ["SELECT", "INSERT", "DELETE"], openmasu_reader: ["SELECT"], openmasu_seed: ["TRUNCATE"],
  }],
  ["ephemeral.adservices_lookups", {
    openmasu_app: ["SELECT", "INSERT", "UPDATE", "DELETE"], openmasu_reader: ["SELECT"], openmasu_seed: ["TRUNCATE"],
  }],
  ["ephemeral.fraud_quarantines", {
    openmasu_app: ["SELECT", "INSERT", "UPDATE", "DELETE"], openmasu_reader: [], openmasu_seed: ["TRUNCATE"],
  }],
  ["ephemeral.integrity_verifications", {
    openmasu_app: ["SELECT", "INSERT", "UPDATE", "DELETE"], openmasu_reader: [], openmasu_seed: ["TRUNCATE"],
  }],
  ["ephemeral.google_play_product_verifications", {
    openmasu_app: ["SELECT", "INSERT", "UPDATE", "DELETE"], openmasu_reader: [], openmasu_seed: ["TRUNCATE"],
  }],
  ["ephemeral.google_conversion_deliveries", {
    openmasu_app: ["SELECT", "INSERT", "UPDATE", "DELETE"], openmasu_reader: [], openmasu_seed: ["TRUNCATE"],
  }],
  ["ephemeral.commerce_provider_readbacks", {
    openmasu_app: ["SELECT", "INSERT", "UPDATE", "DELETE"], openmasu_reader: [], openmasu_seed: ["TRUNCATE"],
  }],
  ["ephemeral.operator_webhook_deliveries", {
    openmasu_app: ["SELECT", "INSERT", "UPDATE", "DELETE"], openmasu_reader: [], openmasu_seed: ["TRUNCATE"],
  }],
  ["ephemeral.operator_bulk_export_batches", {
    openmasu_app: ["SELECT", "INSERT", "UPDATE", "DELETE"], openmasu_reader: [], openmasu_seed: ["TRUNCATE"],
  }],
]);

function expected(row: Row): Privilege[] {
  const qualified = `${row.schema_name}.${row.table_name}`;
  if (row.schema_name === "ephemeral") {
    const matrix = ephemeralExpected.get(qualified);
    assert.ok(matrix, `new ephemeral table requires an explicit role matrix entry: ${qualified}`);
    return matrix[row.role_name];
  }
  if (row.schema_name === "testing") {
    return row.role_name === "openmasu_seed" ? ["SELECT", "INSERT", "UPDATE", "DELETE"] : [];
  }
  if (row.role_name === "openmasu_app") {
    if (qualified === "control.google_play_order_digests") return ["SELECT", "INSERT", "UPDATE"];
    if (qualified === "control.google_data_manager_destinations") return ["SELECT", "INSERT", "UPDATE"];
    if (qualified === "control.commerce_backfill_checkpoints") return ["SELECT", "INSERT", "UPDATE"];
    if (qualified === "control.worker_job_schedules") return ["SELECT", "INSERT", "UPDATE"];
    if (qualified === "control.operator_bulk_export_checkpoints") return ["SELECT", "INSERT", "UPDATE"];
    if (qualified === "control.metric_schedule_checkpoints") return ["SELECT", "INSERT", "UPDATE"];
    if (qualified === "control.privacy_deletion_jobs") return ["SELECT", "INSERT", "UPDATE"];
    if (qualified === "control.privacy_payload_purges") return ["SELECT", "INSERT", "UPDATE"];
    return qualified === "control.public_postback_audits" ? ["INSERT"] : ["SELECT", "INSERT"];
  }
  if (row.role_name === "openmasu_reader") {
    return readerNoTableSelect.has(qualified) ? [] : ["SELECT"];
  }
  if (row.schema_name === "ledger" || seedControlTruncate.has(qualified)) return ["TRUNCATE"];
  return [];
}

const pool = createMigrationPool();
try {
  const schemaUsage = await pool.query<{ role_name: Role; schema_name: string; allowed: boolean }>(`
    SELECT role_name, schema_name,
           has_schema_privilege(role_name, schema_name, 'USAGE') AS allowed
      FROM unnest(ARRAY['openmasu_app','openmasu_reader','openmasu_seed']) AS role_name
      CROSS JOIN unnest(ARRAY['control','ledger']) AS schema_name
    UNION ALL
    SELECT role_name, 'ephemeral',
           has_schema_privilege(role_name, 'ephemeral', 'USAGE')
      FROM unnest(ARRAY['openmasu_app','openmasu_reader','openmasu_seed']) AS role_name
  `);
  for (const row of schemaUsage.rows) assert.equal(row.allowed, true, `${row.role_name} lacks USAGE on ${row.schema_name}`);

  const result = await pool.query<Row>(`
    SELECT n.nspname AS schema_name, c.relname AS table_name, role_name,
           has_table_privilege(role_name, c.oid, 'SELECT') AS select_privilege,
           has_table_privilege(role_name, c.oid, 'INSERT') AS insert_privilege,
           has_table_privilege(role_name, c.oid, 'UPDATE') AS update_privilege,
           has_table_privilege(role_name, c.oid, 'DELETE') AS delete_privilege,
           has_table_privilege(role_name, c.oid, 'TRUNCATE') AS truncate_privilege
      FROM pg_class AS c
      JOIN pg_namespace AS n ON n.oid=c.relnamespace
      CROSS JOIN unnest(ARRAY['openmasu_app','openmasu_reader','openmasu_seed']) AS role_name
     WHERE c.relkind IN ('r','p') AND n.nspname IN ('control','ledger','ephemeral','testing')
     ORDER BY n.nspname,c.relname,role_name
  `);
  assert.ok((result.rowCount ?? 0) > 0);
  for (const row of result.rows) {
    const actual = privileges.filter((privilege) => row[`${privilege.toLowerCase()}_privilege` as keyof Row] === true);
    assert.deepEqual(actual, expected(row), `${row.role_name} privilege drift on ${row.schema_name}.${row.table_name}`);
  }
  const readerGoogleColumns = await pool.query<{
    table_schema: string;
    table_name: string;
    column_name: string;
    allowed: boolean;
  }>(`
    SELECT table_schema, table_name, column_name,
           has_column_privilege(
             'openmasu_reader',
             format('%I.%I', table_schema, table_name),
             column_name,
             'SELECT'
           ) AS allowed
      FROM information_schema.columns
     WHERE (table_schema, table_name) IN (
       ('control', 'google_data_manager_destinations'),
       ('ephemeral', 'google_conversion_deliveries')
     )
     ORDER BY table_schema, table_name, ordinal_position
  `);
  const expectedReaderGoogleColumns = new Set([
    "control.google_data_manager_destinations.tenant_id",
    "control.google_data_manager_destinations.app_id",
    "control.google_data_manager_destinations.destination_id",
    "control.google_data_manager_destinations.enabled",
    "control.google_data_manager_destinations.next_request_at",
    "ephemeral.google_conversion_deliveries.delivery_id",
    "ephemeral.google_conversion_deliveries.tenant_id",
    "ephemeral.google_conversion_deliveries.app_id",
    "ephemeral.google_conversion_deliveries.destination_id",
    "ephemeral.google_conversion_deliveries.state",
    "ephemeral.google_conversion_deliveries.attempts",
    "ephemeral.google_conversion_deliveries.next_attempt_at",
    "ephemeral.google_conversion_deliveries.diagnostics_deadline_at",
    "ephemeral.google_conversion_deliveries.safe_reason",
    "ephemeral.google_conversion_deliveries.created_at",
    "ephemeral.google_conversion_deliveries.updated_at",
  ]);
  for (const row of readerGoogleColumns.rows) {
    const qualified = `${row.table_schema}.${row.table_name}.${row.column_name}`;
    assert.equal(row.allowed, expectedReaderGoogleColumns.has(qualified), `openmasu_reader column privilege drift on ${qualified}`);
  }
  assert.equal(
    readerGoogleColumns.rows.filter((row) => row.allowed).length,
    expectedReaderGoogleColumns.size,
    "Google delivery health reader column matrix is incomplete",
  );
  const readerOperatorColumns = await pool.query<{
    table_schema: string;
    table_name: string;
    column_name: string;
    allowed: boolean;
  }>(`
    SELECT table_schema, table_name, column_name,
           has_column_privilege(
             'openmasu_reader',
             format('%I.%I', table_schema, table_name),
             column_name,
             'SELECT'
           ) AS allowed
      FROM information_schema.columns
     WHERE (table_schema, table_name) IN (
       ('control', 'operator_webhook_destinations'),
       ('control', 'operator_webhook_destination_states'),
       ('ephemeral', 'operator_webhook_deliveries'),
       ('control', 'operator_bulk_export_destinations'),
       ('control', 'operator_bulk_export_destination_states'),
       ('ephemeral', 'operator_bulk_export_batches')
     )
     ORDER BY table_schema, table_name, ordinal_position
  `);
  const expectedReaderOperatorColumns = new Set([
    "control.operator_webhook_destinations.destination_id",
    "control.operator_webhook_destinations.tenant_id",
    "control.operator_webhook_destinations.app_id",
    "control.operator_webhook_destinations.endpoint_url",
    "control.operator_webhook_destinations.allowed_events",
    "control.operator_webhook_destinations.created_at",
    "control.operator_webhook_destination_states.destination_state_seq",
    "control.operator_webhook_destination_states.destination_id",
    "control.operator_webhook_destination_states.tenant_id",
    "control.operator_webhook_destination_states.app_id",
    "control.operator_webhook_destination_states.status",
    "control.operator_webhook_destination_states.changed_at",
    "ephemeral.operator_webhook_deliveries.delivery_id",
    "ephemeral.operator_webhook_deliveries.tenant_id",
    "ephemeral.operator_webhook_deliveries.app_id",
    "ephemeral.operator_webhook_deliveries.destination_id",
    "ephemeral.operator_webhook_deliveries.event_name",
    "ephemeral.operator_webhook_deliveries.state",
    "ephemeral.operator_webhook_deliveries.attempts",
    "ephemeral.operator_webhook_deliveries.next_attempt_at",
    "ephemeral.operator_webhook_deliveries.last_http_status",
    "ephemeral.operator_webhook_deliveries.safe_reason",
    "ephemeral.operator_webhook_deliveries.created_at",
    "ephemeral.operator_webhook_deliveries.updated_at",
    "control.operator_bulk_export_destinations.destination_id",
    "control.operator_bulk_export_destinations.tenant_id",
    "control.operator_bulk_export_destinations.app_id",
    "control.operator_bulk_export_destinations.endpoint_url",
    "control.operator_bulk_export_destinations.bucket_name",
    "control.operator_bulk_export_destinations.object_prefix",
    "control.operator_bulk_export_destinations.region",
    "control.operator_bulk_export_destinations.allowed_events",
    "control.operator_bulk_export_destinations.start_at",
    "control.operator_bulk_export_destinations.created_at",
    "control.operator_bulk_export_destination_states.destination_state_seq",
    "control.operator_bulk_export_destination_states.destination_id",
    "control.operator_bulk_export_destination_states.tenant_id",
    "control.operator_bulk_export_destination_states.app_id",
    "control.operator_bulk_export_destination_states.status",
    "control.operator_bulk_export_destination_states.changed_at",
    "ephemeral.operator_bulk_export_batches.batch_id",
    "ephemeral.operator_bulk_export_batches.tenant_id",
    "ephemeral.operator_bulk_export_batches.app_id",
    "ephemeral.operator_bulk_export_batches.destination_id",
    "ephemeral.operator_bulk_export_batches.row_count",
    "ephemeral.operator_bulk_export_batches.state",
    "ephemeral.operator_bulk_export_batches.attempts",
    "ephemeral.operator_bulk_export_batches.next_attempt_at",
    "ephemeral.operator_bulk_export_batches.last_http_status",
    "ephemeral.operator_bulk_export_batches.safe_reason",
    "ephemeral.operator_bulk_export_batches.created_at",
    "ephemeral.operator_bulk_export_batches.updated_at",
  ]);
  for (const row of readerOperatorColumns.rows) {
    const qualified = `${row.table_schema}.${row.table_name}.${row.column_name}`;
    assert.equal(row.allowed, expectedReaderOperatorColumns.has(qualified), `openmasu_reader column privilege drift on ${qualified}`);
  }
  assert.equal(
    readerOperatorColumns.rows.filter((row) => row.allowed).length,
    expectedReaderOperatorColumns.size,
    "operator delivery health reader column matrix is incomplete",
  );
  for (const view of [
    "control.operator_webhook_destinations_current",
    "control.operator_bulk_export_destinations_current",
  ]) {
    const allowed = await pool.query<{ allowed: boolean }>(
      "SELECT has_table_privilege('openmasu_reader', $1, 'SELECT') AS allowed",
      [view],
    );
    assert.equal(allowed.rows[0]?.allowed, false, `openmasu_reader retains broad access to ${view}`);
  }
  const scheduleView = await pool.query<{ role_name: Role; allowed: boolean }>(`
    SELECT role_name,
           has_table_privilege(role_name, 'control.metric_schedules_current', 'SELECT') AS allowed
      FROM unnest(ARRAY['openmasu_app','openmasu_reader','openmasu_seed']) AS role_name
     ORDER BY role_name
  `);
  assert.deepEqual(scheduleView.rows, [
    { role_name: "openmasu_app", allowed: true },
    { role_name: "openmasu_reader", allowed: true },
    { role_name: "openmasu_seed", allowed: false },
  ]);
  const privacyBacklog = await pool.query<{ role_name: Role; allowed: boolean }>(`
    SELECT role_name,
           has_function_privilege(role_name, 'control.privacy_deletion_backlog()', 'EXECUTE') AS allowed
      FROM unnest(ARRAY['openmasu_app','openmasu_reader','openmasu_seed']) AS role_name
     ORDER BY role_name
  `);
  assert.deepEqual(privacyBacklog.rows, [
    { role_name: "openmasu_app", allowed: true },
    { role_name: "openmasu_reader", allowed: true },
    { role_name: "openmasu_seed", allowed: false },
  ]);
  console.log(`WO16 role grant matrix passed for ${(result.rowCount ?? 0) / 3} migrated tables and 3 runtime roles.`);
} finally {
  await pool.end();
}
