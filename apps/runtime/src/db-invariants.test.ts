import { strict as assert } from "node:assert";
import { createAppPool, createMigrationPool, createReaderPool, withTenant } from "./index.js";

const timestamp = "2026-08-19T00:00:00.000Z";
const suffix = `${Date.now()}`;
const tenantA = `test-tenant-a-${suffix}`;
const tenantB = `test-tenant-b-${suffix}`;
const appA = `test-app-a-${suffix}`;
const appB = `test-app-b-${suffix}`;
const recordA = `test-record-a-${suffix}`;
const recordB = `test-record-b-${suffix}`;

const appPool = createAppPool();
const readerPool = createReaderPool();
const migrationPool = createMigrationPool();
const appClient = await appPool.connect();

async function setTenant(tenantId: string): Promise<void> {
  await appClient.query("SELECT set_config('openmasu.tenant_id', $1, true)", [tenantId]);
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
    app_can_delete_nonce: boolean;
    app_can_delete_ledger: boolean;
    reader_bypass: boolean;
    reader_owns_ledger: boolean;
    reader_can_create: boolean;
    reader_can_select_sessions: boolean;
    reader_can_insert_sessions: boolean;
    app_can_insert_public_postback_audit: boolean;
    app_can_select_public_postback_audit: boolean;
    reader_can_select_public_postback_audit: boolean;
    app_can_resolve_apple_adam: boolean;
    app_can_list_apple_tenants: boolean;
    apple_registration_rls_forced: boolean;
    conversion_schema_rls_forced: boolean;
    adservices_lookup_rls_forced: boolean;
    app_can_select_adservices_results: boolean;
    reader_can_select_adservices_results: boolean;
    adservices_result_rls_forced: boolean;
    app_can_list_m4_work_tenants: boolean;
    app_can_select_apple_postback_facts: boolean;
    reader_can_select_apple_postback_facts: boolean;
    apple_postback_fact_rls_forced: boolean;
    reader_can_select_admin_roles: boolean;
    reader_can_select_admin_digest: boolean;
    app_can_insert_rule_bundles: boolean;
    reader_can_select_rule_bundles: boolean;
    reader_can_insert_rule_bundles: boolean;
    rule_bundle_rls_forced: boolean;
  }>(`
    SELECT
      rolbypassrls AS bypass,
      EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'ledger' AND c.relowner = r.oid
      ) AS owns_ledger,
      has_database_privilege('openmasu_app', current_database(), 'CREATE') AS can_create,
      (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'openmasu_seed') AS seed_bypass,
      EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'ledger'
          AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = 'openmasu_seed')
      ) AS seed_owns_ledger,
      has_table_privilege('openmasu_seed', 'ledger.raw_records', 'SELECT') AS seed_can_select_raw,
      has_table_privilege('openmasu_seed', 'ledger.raw_records', 'TRUNCATE') AS seed_can_truncate_raw,
      has_table_privilege(
        'openmasu_seed',
        'testing.fixture_inputs',
        'SELECT,INSERT,UPDATE,DELETE'
      ) AS seed_can_manage_fixtures,
      has_table_privilege('openmasu_app', 'ephemeral.request_nonces', 'DELETE') AS app_can_delete_nonce,
      has_table_privilege('openmasu_app', 'ledger.ingest_batches', 'DELETE') AS app_can_delete_ledger,
      (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'openmasu_reader') AS reader_bypass,
      EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'ledger'
          AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = 'openmasu_reader')
      ) AS reader_owns_ledger,
      has_database_privilege('openmasu_reader', current_database(), 'CREATE') AS reader_can_create,
      has_table_privilege('openmasu_reader', 'ephemeral.dashboard_sessions', 'SELECT') AS reader_can_select_sessions,
      has_table_privilege('openmasu_reader', 'ephemeral.dashboard_sessions', 'INSERT') AS reader_can_insert_sessions,
      has_table_privilege('openmasu_app', 'control.public_postback_audits', 'INSERT') AS app_can_insert_public_postback_audit,
      has_table_privilege('openmasu_app', 'control.public_postback_audits', 'SELECT') AS app_can_select_public_postback_audit,
      has_table_privilege('openmasu_reader', 'control.public_postback_audits', 'SELECT') AS reader_can_select_public_postback_audit,
      has_function_privilege('openmasu_app', 'control.resolve_apple_app_adam_id(bigint)', 'EXECUTE') AS app_can_resolve_apple_adam,
      has_function_privilege('openmasu_app', 'control.list_apple_postback_tenants()', 'EXECUTE') AS app_can_list_apple_tenants,
      (SELECT relforcerowsecurity FROM pg_class WHERE oid='control.apple_app_registrations'::regclass) AS apple_registration_rls_forced,
      (SELECT relforcerowsecurity FROM pg_class WHERE oid='control.conversion_schemas'::regclass) AS conversion_schema_rls_forced,
      (SELECT relforcerowsecurity FROM pg_class WHERE oid='ephemeral.adservices_lookups'::regclass) AS adservices_lookup_rls_forced,
      has_table_privilege('openmasu_app', 'ledger.adservices_lookup_results', 'SELECT') AS app_can_select_adservices_results,
      has_table_privilege('openmasu_reader', 'ledger.adservices_lookup_results', 'SELECT') AS reader_can_select_adservices_results,
      (SELECT relforcerowsecurity FROM pg_class WHERE oid='ledger.adservices_lookup_results'::regclass) AS adservices_result_rls_forced,
      has_function_privilege('openmasu_app', 'control.list_m4_work_tenants()', 'EXECUTE') AS app_can_list_m4_work_tenants,
      has_table_privilege('openmasu_app', 'ledger.apple_postback_facts', 'SELECT') AS app_can_select_apple_postback_facts,
      has_table_privilege('openmasu_reader', 'ledger.apple_postback_facts', 'SELECT') AS reader_can_select_apple_postback_facts,
      (SELECT relforcerowsecurity FROM pg_class WHERE oid='ledger.apple_postback_facts'::regclass) AS apple_postback_fact_rls_forced,
      has_table_privilege('openmasu_reader', 'control.admin_key_roles_current', 'SELECT') AS reader_can_select_admin_roles,
      has_column_privilege('openmasu_reader', 'control.admin_keys', 'scrypt_digest', 'SELECT') AS reader_can_select_admin_digest,
      has_table_privilege('openmasu_app', 'control.rule_bundle_revisions', 'INSERT') AS app_can_insert_rule_bundles,
      has_table_privilege('openmasu_reader', 'control.rule_bundle_revisions', 'SELECT') AS reader_can_select_rule_bundles,
      has_table_privilege('openmasu_reader', 'control.rule_bundle_revisions', 'INSERT') AS reader_can_insert_rule_bundles,
      (SELECT relforcerowsecurity FROM pg_class WHERE oid='control.rule_bundle_revisions'::regclass) AS rule_bundle_rls_forced
    FROM pg_roles r
    WHERE rolname = 'openmasu_app'
  `);
  assert.equal(role.rows[0].bypass, false);
  assert.equal(role.rows[0].owns_ledger, false);
  assert.equal(role.rows[0].can_create, false);
  assert.equal(role.rows[0].seed_bypass, false);
  assert.equal(role.rows[0].seed_owns_ledger, false);
  assert.equal(role.rows[0].seed_can_select_raw, false);
  assert.equal(role.rows[0].seed_can_truncate_raw, true);
  assert.equal(role.rows[0].seed_can_manage_fixtures, true);
  assert.equal(role.rows[0].app_can_delete_nonce, true);
  assert.equal(role.rows[0].app_can_delete_ledger, false);
  assert.equal(role.rows[0].reader_bypass, false);
  assert.equal(role.rows[0].reader_owns_ledger, false);
  assert.equal(role.rows[0].reader_can_create, false);
  assert.equal(role.rows[0].reader_can_select_sessions, true);
  assert.equal(role.rows[0].reader_can_insert_sessions, false);
  assert.equal(role.rows[0].app_can_insert_public_postback_audit, true);
  assert.equal(role.rows[0].app_can_select_public_postback_audit, false);
  assert.equal(role.rows[0].reader_can_select_public_postback_audit, false);
  assert.equal(role.rows[0].app_can_resolve_apple_adam, true);
  assert.equal(role.rows[0].app_can_list_apple_tenants, true);
  assert.equal(role.rows[0].apple_registration_rls_forced, true);
  assert.equal(role.rows[0].conversion_schema_rls_forced, true);
  assert.equal(role.rows[0].adservices_lookup_rls_forced, true);
  assert.equal(role.rows[0].app_can_select_adservices_results, true);
  assert.equal(role.rows[0].reader_can_select_adservices_results, false);
  assert.equal(role.rows[0].adservices_result_rls_forced, true);
  assert.equal(role.rows[0].app_can_list_m4_work_tenants, true);
  assert.equal(role.rows[0].app_can_select_apple_postback_facts, true);
  assert.equal(role.rows[0].reader_can_select_apple_postback_facts, true);
  assert.equal(role.rows[0].apple_postback_fact_rls_forced, true);
  assert.equal(role.rows[0].reader_can_select_admin_roles, true);
  assert.equal(role.rows[0].reader_can_select_admin_digest, false);
  assert.equal(role.rows[0].app_can_insert_rule_bundles, true);
  assert.equal(role.rows[0].reader_can_select_rule_bundles, true);
  assert.equal(role.rows[0].reader_can_insert_rule_bundles, false);
  assert.equal(role.rows[0].rule_bundle_rls_forced, true);

  await withTenant(appPool, tenantA, (client) => client.query(
    "INSERT INTO control.apps (tenant_id, app_id, created_at) VALUES ($1,$2,$3)",
    [tenantA, appA, timestamp],
  ));
  assert.equal((await readerPool.query("SELECT app_id FROM control.apps WHERE tenant_id=$1", [tenantA])).rowCount, 0);
  assert.equal((await withTenant(readerPool, tenantA, (client) => client.query(
    "SELECT app_id FROM control.apps WHERE tenant_id=$1 AND app_id=$2",
    [tenantA, appA],
  ))).rowCount, 1);
  await assert.rejects(
    () => withTenant(readerPool, tenantA, (client) => client.query(
      "INSERT INTO control.apps (tenant_id, app_id, created_at) VALUES ($1,$2,$3)",
      [tenantA, `reader-write-${suffix}`, timestamp],
    )),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "42501",
  );

  await appClient.query("BEGIN");
  await setTenant(tenantA);
  await appClient.query(
    `INSERT INTO ephemeral.request_nonces (
      tenant_id, app_id, principal_type, principal_key_id, nonce,
      timestamp_ms, created_at, expires_at
    ) VALUES ($1,$2,'sdk_key',$3,$4,0,clock_timestamp(),clock_timestamp() + interval '15 minutes')`,
    [tenantA, appA, `sdk-key-${suffix}`, `Nonce_${"a".repeat(24)}`],
  );
  assert.equal((await appClient.query(
    "DELETE FROM ephemeral.request_nonces WHERE tenant_id=$1 AND app_id=$2 RETURNING nonce",
    [tenantA, appA],
  )).rowCount, 1, "only ephemeral replay state should be deletable by the app role");
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
  console.log("C03 reader RLS passed: unset tenant returned zero rows, tenant scope selected one row, and INSERT failed with 42501.");
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
  await readerPool.end();
  await migrationPool.end();
}
