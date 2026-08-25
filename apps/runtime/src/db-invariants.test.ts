import { strict as assert } from "node:assert";
import { createAppPool, createMigrationPool } from "./index.js";

const timestamp = "2026-08-19T00:00:00.000Z";
const suffix = `${Date.now()}`;
const tenantA = `test-tenant-a-${suffix}`;
const tenantB = `test-tenant-b-${suffix}`;
const appA = `test-app-a-${suffix}`;
const appB = `test-app-b-${suffix}`;
const recordA = `test-record-a-${suffix}`;
const recordB = `test-record-b-${suffix}`;

const appPool = createAppPool();
const migrationPool = createMigrationPool();
const appClient = await appPool.connect();

async function setTenant(tenantId: string): Promise<void> {
  await appClient.query("SELECT set_config('open_mmp.tenant_id', $1, true)", [tenantId]);
}

async function savepointFailure(name: string, operation: () => Promise<unknown>): Promise<string> {
  await appClient.query(`SAVEPOINT ${name}`);
  try {
    await operation();
    throw new Error(`${name} unexpectedly succeeded`);
  } catch (error) {
    await appClient.query(`ROLLBACK TO SAVEPOINT ${name}`);
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (code !== "42501") throw error;
    return code;
  }
}

try {
  const unset = await appClient.query<{ count: string }>("SELECT count(*)::text AS count FROM ledger.raw_records");
  assert.equal(unset.rows[0].count, "0", "RLS must return zero rows without a tenant GUC");

  const role = await migrationPool.query<{
    bypass: boolean;
    owns_ledger: boolean;
    can_create: boolean;
    seed_bypass: boolean;
    seed_owns_ledger: boolean;
    seed_can_select_raw: boolean;
    seed_can_truncate_raw: boolean;
    seed_can_manage_fixtures: boolean;
  }>(`
    SELECT
      rolbypassrls AS bypass,
      EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'ledger' AND c.relowner = r.oid
      ) AS owns_ledger,
      has_database_privilege('openmmp_app', current_database(), 'CREATE') AS can_create,
      (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'openmmp_seed') AS seed_bypass,
      EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'ledger'
          AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = 'openmmp_seed')
      ) AS seed_owns_ledger,
      has_table_privilege('openmmp_seed', 'ledger.raw_records', 'SELECT') AS seed_can_select_raw,
      has_table_privilege('openmmp_seed', 'ledger.raw_records', 'TRUNCATE') AS seed_can_truncate_raw,
      has_table_privilege(
        'openmmp_seed',
        'testing.fixture_inputs',
        'SELECT,INSERT,UPDATE,DELETE'
      ) AS seed_can_manage_fixtures
    FROM pg_roles r
    WHERE rolname = 'openmmp_app'
  `);
  assert.equal(role.rows[0].bypass, false);
  assert.equal(role.rows[0].owns_ledger, false);
  assert.equal(role.rows[0].can_create, false);
  assert.equal(role.rows[0].seed_bypass, false);
  assert.equal(role.rows[0].seed_owns_ledger, false);
  assert.equal(role.rows[0].seed_can_select_raw, false);
  assert.equal(role.rows[0].seed_can_truncate_raw, true);
  assert.equal(role.rows[0].seed_can_manage_fixtures, true);

  await appClient.query("BEGIN");
  await setTenant(tenantA);
  await appClient.query(
    "INSERT INTO control.apps (tenant_id, app_id, created_at) VALUES ($1, $2, $3)",
    [tenantA, appA, timestamp],
  );
  await appClient.query(
    `INSERT INTO ledger.raw_records (
      record_id, tenant_id, app_id, producer, producer_version, event_id, delivery_id,
      event_name, schema_version, payload_sha256, occurred_at, occurred_at_source,
      received_at, raw_payload_ref, processing_purpose_id,
      consent_evaluation_policy_version, consent_decision_reason_code, artifact
    ) VALUES ($1, $2, $3, 'sdk-android', 'test-v1', $4, $5, 'install', '0.2.0',
      repeat('a', 64), $6, 'server', $6, $7, 'analytics', 'consent-v1',
      'consent_not_required', $8::jsonb)`,
    [recordA, tenantA, appA, `event-${suffix}-a`, `delivery-${suffix}-a`, timestamp, `protected:${recordA}`, JSON.stringify({ record_id: recordA })],
  );
  await appClient.query(
    "INSERT INTO ledger.raw_payload_states (tenant_id, app_id, record_id, lifecycle_status, changed_at) VALUES ($1, $2, $3, 'available', $4)",
    [tenantA, appA, recordA, timestamp],
  );

  await setTenant(tenantB);
  await appClient.query(
    "INSERT INTO control.apps (tenant_id, app_id, created_at) VALUES ($1, $2, $3)",
    [tenantB, appB, timestamp],
  );
  await appClient.query(
    `INSERT INTO ledger.raw_records (
      record_id, tenant_id, app_id, producer, producer_version, event_id, delivery_id,
      event_name, schema_version, payload_sha256, occurred_at, occurred_at_source,
      received_at, raw_payload_ref, processing_purpose_id,
      consent_evaluation_policy_version, consent_decision_reason_code, artifact
    ) VALUES ($1, $2, $3, 'sdk-android', 'test-v1', $4, $5, 'install', '0.2.0',
      repeat('b', 64), $6, 'server', $6, $7, 'analytics', 'consent-v1',
      'consent_not_required', $8::jsonb)`,
    [recordB, tenantB, appB, `event-${suffix}-b`, `delivery-${suffix}-b`, timestamp, `protected:${recordB}`, JSON.stringify({ record_id: recordB })],
  );

  await setTenant(tenantA);
  const hidden = await appClient.query("SELECT record_id FROM ledger.raw_records WHERE record_id = $1", [recordB]);
  assert.equal(hidden.rowCount, 0, "tenant A must not read tenant B");
  await savepointFailure("mismatched_insert", () => appClient.query(
    "INSERT INTO control.apps (tenant_id, app_id, created_at) VALUES ($1, $2, $3)",
    [tenantB, `mismatch-${suffix}`, timestamp],
  ));
  await appClient.query("SAVEPOINT cross_scope_reference");
  try {
    await appClient.query(
      `INSERT INTO ledger.logical_events (
        logical_event_id, record_id, tenant_id, app_id, producer, event_id,
        event_name, record_lifecycle, timeliness, artifact
      ) VALUES ($1,$2,$3,$4,'sdk-android',$5,'install','active','on_time',$6::jsonb)`,
      [`logical-cross-scope-${suffix}`, recordB, tenantA, appA, `event-cross-scope-${suffix}`, JSON.stringify({ record_id: recordB })],
    );
    throw new Error("cross-scope logical-event reference unexpectedly succeeded");
  } catch (error) {
    await appClient.query("ROLLBACK TO SAVEPOINT cross_scope_reference");
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    assert.equal(code, "23503", "cross-scope logical-event reference must fail its composite foreign key");
  }

  const before = await appClient.query<{ row_value: string }>(
    "SELECT row_to_json(r)::text AS row_value FROM ledger.raw_records r WHERE record_id = $1",
    [recordA],
  );
  await appClient.query(
    `INSERT INTO ledger.privacy_tombstones (
      tenant_id, app_id, privacy_request_id, record_id, lifecycle_status, created_at, artifact
    ) VALUES ($1, $2, $3, $4, 'redacted', $5, $6::jsonb)`,
    [tenantA, appA, `privacy-${suffix}`, recordA, timestamp, JSON.stringify({ record_id: recordA, lifecycle_status: "redacted" })],
  );
  await appClient.query(
    `INSERT INTO ledger.raw_payload_states (
      tenant_id, app_id, record_id, lifecycle_status, changed_at, privacy_request_id, privacy_tombstone_id
    ) VALUES ($1, $2, $3, 'redacted', $4, $5, $6)`,
    [tenantA, appA, recordA, timestamp, `privacy-${suffix}`, `tombstone-${suffix}`],
  );
  const after = await appClient.query<{ row_value: string }>(
    "SELECT row_to_json(r)::text AS row_value FROM ledger.raw_records r WHERE record_id = $1",
    [recordA],
  );
  assert.equal(after.rows[0].row_value, before.rows[0].row_value, "redaction must not mutate raw_records");

  const ledgerTables = await migrationPool.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'ledger' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  for (const [index, table] of ledgerTables.rows.entries()) {
    const quoted = `"${table.table_name.replaceAll('"', '""')}"`;
    await savepointFailure(`append_update_${index}`, () => appClient.query(`UPDATE ledger.${quoted} SET tenant_id = tenant_id WHERE false`));
    await savepointFailure(`append_delete_${index}`, () => appClient.query(`DELETE FROM ledger.${quoted} WHERE false`));
  }
  await appClient.query("ROLLBACK");
  console.log("A7 tenant isolation passed: unset=0, cross-tenant=0, mismatched INSERT and cross-scope reference rejected.");
  console.log(`A8 append-only database controls passed for ${ledgerTables.rowCount} ledger tables; raw row remained byte-identical.`);
  console.log("A8 payload encryption, decryption, and purge behavior is covered by the Stage 5 integration suite.");
} catch (error) {
  try {
    await appClient.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
  throw error;
} finally {
  appClient.release();
  await appPool.end();
  await migrationPool.end();
}
