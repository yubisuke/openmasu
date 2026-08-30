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
  "control.metric_replay_manifests",
  "control.public_postback_audits",
  "ledger.adservices_lookup_results",
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
  console.log(`WO16 role grant matrix passed for ${(result.rowCount ?? 0) / 3} migrated tables and 3 runtime roles.`);
} finally {
  await pool.end();
}
