import { strict as assert } from "node:assert";
import { createAppPool, createMigrationPool, createReaderPool, uuidV7, withTenant } from "./index.js";

const timestamp = "2026-08-19T00:00:00.000Z";
const suffix = `${Date.now()}`;
const tenantA = `test-tenant-a-${suffix}`;
const tenantB = `test-tenant-b-${suffix}`;
const appA = `test-app-a-${suffix}`;
const appB = `test-app-b-${suffix}`;
const recordA = `test-record-a-${suffix}`;
const recordB = `test-record-b-${suffix}`;
const purchaseRecord = `test-purchase-record-${suffix}`;
const refundRecord = `test-refund-record-${suffix}`;
const legacyPurchaseRecord = `test-legacy-purchase-record-${suffix}`;
const futurePurchaseRecord = `test-purchase-future-received-${suffix}`;
const explicitFutureRefundRecord = `test-refund-explicit-future-${suffix}`;
const explicitFutureTargetRefundRecord = `test-refund-explicit-future-target-${suffix}`;
const explicitAmbiguousRefundRecord = `test-refund-explicit-ambiguous-${suffix}`;

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

  const jobHealthIndex = await migrationPool.query<{ indexdef: string; predicate: string; valid: boolean }>(`
    SELECT pg_get_indexdef(i.indexrelid) AS indexdef,
           pg_get_expr(i.indpred, i.indrelid) AS predicate,
           i.indisvalid AS valid
      FROM pg_index AS i
      JOIN pg_class AS index_class ON index_class.oid=i.indexrelid
      JOIN pg_class AS table_class ON table_class.oid=i.indrelid
      JOIN pg_namespace AS namespace ON namespace.oid=table_class.relnamespace
     WHERE namespace.nspname='ledger' AND table_class.relname='audit_logs'
       AND index_class.relname='audit_logs_job_health_idx'`);
  assert.equal(jobHealthIndex.rowCount, 1, "job-health partial index must exist exactly once");
  assert.equal(jobHealthIndex.rows[0].valid, true, "job-health partial index must be valid");
  assert.match(jobHealthIndex.rows[0].indexdef, /\(tenant_id, actor_ref, outcome, occurred_at DESC\)/);
  for (const fragment of [
    "system_job", "job_completed", "job-health-v1", "job:mmp_import", "job:cost_import", "job:max_revenue_import",
    "job:google_conversion_delivery",
    "job:operator_webhook_delivery",
    "job:metric_run", "succeeded", "failed", "target_scope", "app_id", "target_ref",
    "reason_code", "job_failed",
  ]) {
    assert.ok(jobHealthIndex.rows[0].predicate.includes(fragment), `job-health index predicate must include ${fragment}`);
  }

  const refundForeignKeys = await migrationPool.query<{ constraint_name: string; definition: string }>(`
    SELECT conname AS constraint_name, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE conrelid='ledger.refund_facts'::regclass AND contype='f'
       AND conname IN ('refund_facts_source_scope_fk', 'refund_facts_target_scope_fk')
     ORDER BY conname`);
  assert.equal(refundForeignKeys.rowCount, 2, "refund facts must have source and target scope foreign keys");
  const refundConstraints = new Map(refundForeignKeys.rows.map((row) => [row.constraint_name, row.definition]));
  assert.match(refundConstraints.get("refund_facts_source_scope_fk") ?? "",
    /FOREIGN KEY \(tenant_id, app_id, logical_event_id\) REFERENCES ledger\.logical_events\(tenant_id, app_id, logical_event_id\).*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(refundConstraints.get("refund_facts_target_scope_fk") ?? "",
    /FOREIGN KEY \(tenant_id, app_id, correction_target_record_id\) REFERENCES ledger\.purchase_facts\(tenant_id, app_id, record_id\).*DEFERRABLE INITIALLY DEFERRED/);

  const purchaseProvenanceConstraints = await migrationPool.query<{ constraint_name: string; definition: string }>(`
    SELECT conname AS constraint_name, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE (
       conrelid='ledger.logical_events'::regclass
       AND conname='logical_events_record_identity_unique'
     ) OR (
       conrelid='ledger.purchase_facts'::regclass
       AND conname IN ('purchase_facts_record_scope_unique', 'purchase_facts_source_scope_fk')
     )
     ORDER BY conname`);
  assert.equal(purchaseProvenanceConstraints.rowCount, 3,
    "logical-event and purchase provenance constraints must exist exactly once");
  const purchaseProvenance = new Map(
    purchaseProvenanceConstraints.rows.map((row) => [row.constraint_name, row.definition]),
  );
  assert.equal(purchaseProvenance.get("logical_events_record_identity_unique"),
    "UNIQUE (tenant_id, app_id, logical_event_id, record_id)");
  assert.equal(purchaseProvenance.get("purchase_facts_record_scope_unique"),
    "UNIQUE (tenant_id, app_id, record_id)");
  assert.match(purchaseProvenance.get("purchase_facts_source_scope_fk") ?? "",
    /FOREIGN KEY \(tenant_id, app_id, logical_event_id, record_id\) REFERENCES ledger\.logical_events\(tenant_id, app_id, logical_event_id, record_id\).*DEFERRABLE INITIALLY DEFERRED/);

  const refundInstallationColumn = await migrationPool.query<{ is_nullable: string }>(`
    SELECT is_nullable
      FROM information_schema.columns
     WHERE table_schema='ledger' AND table_name='refund_facts' AND column_name='installation_id'`);
  assert.equal(refundInstallationColumn.rowCount, 1);
  assert.equal(refundInstallationColumn.rows[0].is_nullable, "NO",
    "strict refund projections must retain their installation anchor");

  const refundTargetTrigger = await migrationPool.query<{
    definition: string;
    function_definition: string;
    deferrable: boolean;
    initially_deferred: boolean;
  }>(`
    SELECT pg_get_triggerdef(t.oid) AS definition,
           pg_get_functiondef(t.tgfoid) AS function_definition,
           t.tgdeferrable AS deferrable,
           t.tginitdeferred AS initially_deferred
      FROM pg_trigger AS t
     WHERE t.tgrelid='ledger.refund_facts'::regclass
       AND t.tgname='refund_facts_target_invariant'
       AND NOT t.tgisinternal`);
  assert.equal(refundTargetTrigger.rowCount, 1, "refund target invariant trigger must exist exactly once");
  assert.equal(refundTargetTrigger.rows[0].deferrable, true);
  assert.equal(refundTargetTrigger.rows[0].initially_deferred, true);
  assert.match(refundTargetTrigger.rows[0].definition,
    /CREATE CONSTRAINT TRIGGER refund_facts_target_invariant AFTER INSERT ON ledger\.refund_facts DEFERRABLE INITIALLY DEFERRED/);
  for (const fragment of [
    "purchase.financial_status", "'settled'", "purchase.installation_id",
    "COALESCE(purchase.original_transaction_id, purchase.transaction_id)",
    "purchase.currency", "purchase.occurred_at_ts", "raw.received_at_ts",
    "eligible_target_count", "23514",
  ]) {
    assert.ok(refundTargetTrigger.rows[0].function_definition.includes(fragment),
      `refund target invariant function must include ${fragment}`);
  }

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
    audit_log_rls_enabled: boolean;
    audit_log_rls_forced: boolean;
    reader_can_select_audit_logs: boolean;
    reader_can_insert_audit_logs: boolean;
    refund_fact_rls_enabled: boolean;
    refund_fact_rls_forced: boolean;
    app_can_select_refund_facts: boolean;
    app_can_insert_refund_facts: boolean;
    app_can_update_refund_facts: boolean;
    app_can_delete_refund_facts: boolean;
    reader_can_select_refund_facts: boolean;
    reader_can_insert_refund_facts: boolean;
    seed_can_truncate_refund_facts: boolean;
    app_can_execute_refund_target_invariant: boolean;
    reader_can_execute_refund_target_invariant: boolean;
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
      (SELECT relforcerowsecurity FROM pg_class WHERE oid='control.rule_bundle_revisions'::regclass) AS rule_bundle_rls_forced,
      (SELECT relrowsecurity FROM pg_class WHERE oid='ledger.audit_logs'::regclass) AS audit_log_rls_enabled,
      (SELECT relforcerowsecurity FROM pg_class WHERE oid='ledger.audit_logs'::regclass) AS audit_log_rls_forced,
      has_table_privilege('openmasu_reader', 'ledger.audit_logs', 'SELECT') AS reader_can_select_audit_logs,
      has_table_privilege('openmasu_reader', 'ledger.audit_logs', 'INSERT') AS reader_can_insert_audit_logs,
      (SELECT relrowsecurity FROM pg_class WHERE oid='ledger.refund_facts'::regclass) AS refund_fact_rls_enabled,
      (SELECT relforcerowsecurity FROM pg_class WHERE oid='ledger.refund_facts'::regclass) AS refund_fact_rls_forced,
      has_table_privilege('openmasu_app', 'ledger.refund_facts', 'SELECT') AS app_can_select_refund_facts,
      has_table_privilege('openmasu_app', 'ledger.refund_facts', 'INSERT') AS app_can_insert_refund_facts,
      has_table_privilege('openmasu_app', 'ledger.refund_facts', 'UPDATE') AS app_can_update_refund_facts,
      has_table_privilege('openmasu_app', 'ledger.refund_facts', 'DELETE') AS app_can_delete_refund_facts,
      has_table_privilege('openmasu_reader', 'ledger.refund_facts', 'SELECT') AS reader_can_select_refund_facts,
      has_table_privilege('openmasu_reader', 'ledger.refund_facts', 'INSERT') AS reader_can_insert_refund_facts,
      has_table_privilege('openmasu_seed', 'ledger.refund_facts', 'TRUNCATE') AS seed_can_truncate_refund_facts,
      has_function_privilege(
        'openmasu_app', 'ledger.enforce_refund_target_invariant()', 'EXECUTE'
      ) AS app_can_execute_refund_target_invariant,
      has_function_privilege(
        'openmasu_reader', 'ledger.enforce_refund_target_invariant()', 'EXECUTE'
      ) AS reader_can_execute_refund_target_invariant
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
  assert.equal(role.rows[0].audit_log_rls_enabled, true);
  assert.equal(role.rows[0].audit_log_rls_forced, true);
  assert.equal(role.rows[0].reader_can_select_audit_logs, true);
  assert.equal(role.rows[0].reader_can_insert_audit_logs, false);
  assert.equal(role.rows[0].refund_fact_rls_enabled, true);
  assert.equal(role.rows[0].refund_fact_rls_forced, true);
  assert.equal(role.rows[0].app_can_select_refund_facts, true);
  assert.equal(role.rows[0].app_can_insert_refund_facts, true);
  assert.equal(role.rows[0].app_can_update_refund_facts, false);
  assert.equal(role.rows[0].app_can_delete_refund_facts, false);
  assert.equal(role.rows[0].reader_can_select_refund_facts, true);
  assert.equal(role.rows[0].reader_can_insert_refund_facts, false);
  assert.equal(role.rows[0].seed_can_truncate_refund_facts, true);
  assert.equal(role.rows[0].app_can_execute_refund_target_invariant, false,
    "the app role must reach the refund invariant only through its trigger");
  assert.equal(role.rows[0].reader_can_execute_refund_target_invariant, false,
    "PUBLIC must not confer direct execution of the refund target invariant");

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
  for (const [recordId, eventName, eventKey, digestCharacter] of [
    [purchaseRecord, "purchase", "purchase", "c"],
    [refundRecord, "refund", "refund", "d"],
    [legacyPurchaseRecord, "purchase", "legacy-purchase", "e"],
  ] as const) {
    await appClient.query(
      `INSERT INTO ledger.raw_records (
        record_id, tenant_id, app_id, producer, producer_version, event_id, delivery_id,
        event_name, schema_version, payload_sha256, occurred_at, occurred_at_source,
        received_at, raw_payload_ref, processing_purpose_id,
        consent_evaluation_policy_version, consent_decision_reason_code, artifact
      ) VALUES ($1,$2,$3,'sdk-android','test-v1',$4,$5,$6,'0.4.0',repeat($7,64),
        $8,'client',$8,$9,'revenue_measurement','consent-v1','consent_not_required',$10::jsonb)`,
      [
        recordId,
        tenantA,
        appA,
        `event-${eventKey}-${suffix}`,
        `delivery-${eventKey}-${suffix}`,
        eventName,
        digestCharacter,
        timestamp,
        `protected:${recordId}`,
        JSON.stringify({ record_id: recordId, event_name: eventName }),
      ],
    );
  }

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

  const purchaseLogicalEventId = `logical-purchase-${suffix}`;
  await appClient.query(
    `INSERT INTO ledger.logical_events (
      logical_event_id, record_id, tenant_id, app_id, producer, event_id,
      event_name, record_lifecycle, timeliness, artifact
    ) VALUES ($1,$2,$3,$4,'sdk-android',$5,'purchase','active','on_time',$6::jsonb)`,
    [
      purchaseLogicalEventId,
      purchaseRecord,
      tenantA,
      appA,
      `event-purchase-${suffix}`,
      JSON.stringify({ record_id: purchaseRecord }),
    ],
  );
  await appClient.query("SAVEPOINT purchase_source_record_mismatch");
  try {
    await appClient.query(
      `INSERT INTO ledger.purchase_facts (
        logical_event_id, tenant_id, app_id, installation_id, transaction_id,
        amount_unscaled, amount_scale, currency, occurred_at, artifact,
        record_id, original_transaction_id, financial_status
      ) VALUES ($1,$2,$3,$4,$5,'100',2,'USD',$6,$7::jsonb,$8,$5,'settled')`,
      [
        purchaseLogicalEventId,
        tenantA,
        appA,
        `installation-${suffix}`,
        `transaction-${suffix}`,
        timestamp,
        JSON.stringify({ record_id: recordB }),
        recordB,
      ],
    );
    await appClient.query("SET CONSTRAINTS ledger.purchase_facts_source_scope_fk IMMEDIATE");
    throw new Error("purchase source record mismatch unexpectedly succeeded");
  } catch (error) {
    await appClient.query("ROLLBACK TO SAVEPOINT purchase_source_record_mismatch");
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    assert.equal(code, "23503", "purchase source scope/record mismatch must fail its composite foreign key");
  }

  const installationId = `installation-${suffix}`;
  const originalTransactionId = `transaction-${suffix}`;
  await appClient.query(
    `INSERT INTO ledger.purchase_facts (
      logical_event_id, tenant_id, app_id, installation_id, transaction_id,
      amount_unscaled, amount_scale, currency, occurred_at, artifact,
      record_id, original_transaction_id, financial_status
    ) VALUES ($1,$2,$3,$4,$5,'100',2,'USD',$6,$7::jsonb,$8,NULL,'settled')`,
    [
      purchaseLogicalEventId,
      tenantA,
      appA,
      installationId,
      originalTransactionId,
      timestamp,
      JSON.stringify({ record_id: purchaseRecord }),
      purchaseRecord,
    ],
  );

  const refundLogicalEventId = `logical-refund-${suffix}`;
  await appClient.query(
    `INSERT INTO ledger.logical_events (
      logical_event_id, record_id, tenant_id, app_id, producer, event_id,
      event_name, record_lifecycle, timeliness, artifact
    ) VALUES ($1,$2,$3,$4,'sdk-android',$5,'refund','active','on_time',$6::jsonb)`,
    [
      refundLogicalEventId,
      refundRecord,
      tenantA,
      appA,
      `event-refund-${suffix}`,
      JSON.stringify({ record_id: refundRecord }),
    ],
  );
  const insertRefundFact = (targetRecordId: string, refundInstallationId: string) => appClient.query(
    `INSERT INTO ledger.refund_facts (
      logical_event_id, tenant_id, app_id, installation_id, transaction_id,
      original_transaction_id, correction_target_record_id, amount_unscaled,
      amount_scale, currency, financial_status, occurred_at, artifact
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,'25',2,'USD','settled',$8,$9::jsonb)`,
    [
      refundLogicalEventId,
      tenantA,
      appA,
      refundInstallationId,
      `refund-transaction-${suffix}`,
      originalTransactionId,
      targetRecordId,
      timestamp,
      JSON.stringify({ correction_target_record_id: targetRecordId }),
    ],
  );

  await appClient.query("SAVEPOINT refund_target_invariant_mismatch");
  try {
    await insertRefundFact(purchaseRecord, `other-installation-${suffix}`);
    await appClient.query("SET CONSTRAINTS ledger.refund_facts_target_invariant IMMEDIATE");
    throw new Error("refund target invariant mismatch unexpectedly succeeded");
  } catch (error) {
    await appClient.query("ROLLBACK TO SAVEPOINT refund_target_invariant_mismatch");
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    assert.equal(code, "23514", "same-scope refund target mismatch must fail the target invariant");
  }

  await appClient.query("SAVEPOINT refund_target_scope_mismatch");
  try {
    await insertRefundFact(recordB, installationId);
    await appClient.query("SET CONSTRAINTS ledger.refund_facts_target_scope_fk IMMEDIATE");
    throw new Error("refund target scope mismatch unexpectedly succeeded");
  } catch (error) {
    await appClient.query("ROLLBACK TO SAVEPOINT refund_target_scope_mismatch");
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    assert.equal(code, "23503", "cross-scope refund target must fail its composite foreign key");
  }

  await insertRefundFact(purchaseRecord, installationId);
  await appClient.query("SET CONSTRAINTS ALL IMMEDIATE");
  assert.equal((await appClient.query(
    "SELECT logical_event_id FROM ledger.refund_facts WHERE logical_event_id=$1",
    [refundLogicalEventId],
  )).rowCount, 1, "matching settled purchase target must satisfy the deferred refund invariant");

  const insertStrictCommerceSource = async (
    recordId: string,
    eventName: "purchase" | "refund",
    occurredAt: string,
    receivedAt: string,
    digestCharacter: string,
  ): Promise<string> => {
    const logicalEventId = `logical-${recordId}`;
    await appClient.query(
      `INSERT INTO ledger.raw_records (
        record_id, tenant_id, app_id, producer, producer_version, event_id, delivery_id,
        event_name, schema_version, payload_sha256, occurred_at, occurred_at_source,
        received_at, raw_payload_ref, processing_purpose_id,
        consent_evaluation_policy_version, consent_decision_reason_code, artifact
      ) VALUES ($1,$2,$3,'sdk-android','test-v1',$4,$5,$6,'0.4.0',repeat($7,64),
        $8,'client',$9,$10,'revenue_measurement','consent-v1','consent_not_required',$11::jsonb)`,
      [
        recordId, tenantA, appA, `event-${recordId}`, `delivery-${recordId}`, eventName,
        digestCharacter, occurredAt, receivedAt, `protected:${recordId}`,
        JSON.stringify({ record_id: recordId, event_name: eventName }),
      ],
    );
    await appClient.query(
      `INSERT INTO ledger.logical_events (
        logical_event_id, record_id, tenant_id, app_id, producer, event_id,
        event_name, record_lifecycle, timeliness, artifact
      ) VALUES ($1,$2,$3,$4,'sdk-android',$5,$6,'active','on_time',$7::jsonb)`,
      [logicalEventId, recordId, tenantA, appA, `event-${recordId}`, eventName,
        JSON.stringify({ record_id: recordId, event_name: eventName })],
    );
    return logicalEventId;
  };
  const insertStrictRefundFact = (
    logicalEventId: string,
    transactionId: string,
    targetRecordId: string,
    occurredAt: string,
  ) => appClient.query(
    `INSERT INTO ledger.refund_facts (
      logical_event_id, tenant_id, app_id, installation_id, transaction_id,
      original_transaction_id, correction_target_record_id, amount_unscaled,
      amount_scale, currency, financial_status, occurred_at, artifact
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,'10',2,'USD','settled',$8,$9::jsonb)`,
    [logicalEventId, tenantA, appA, installationId, transactionId, originalTransactionId,
      targetRecordId, occurredAt, JSON.stringify({ correction_target_record_id: targetRecordId })],
  );

  const futurePurchaseOccurredAt = "2026-08-19T00:30:00.000Z";
  const futurePurchaseReceivedAt = "2026-08-19T03:00:00.000Z";
  const futurePurchaseLogicalEventId = await insertStrictCommerceSource(
    futurePurchaseRecord, "purchase", futurePurchaseOccurredAt, futurePurchaseReceivedAt, "f",
  );
  await appClient.query(
    `INSERT INTO ledger.purchase_facts (
      logical_event_id, tenant_id, app_id, installation_id, transaction_id,
      amount_unscaled, amount_scale, currency, occurred_at, artifact,
      record_id, original_transaction_id, financial_status
    ) VALUES ($1,$2,$3,$4,$5,'100',2,'USD',$6,$7::jsonb,$8,$9,'settled')`,
    [futurePurchaseLogicalEventId, tenantA, appA, installationId,
      `future-transaction-${suffix}`, futurePurchaseOccurredAt,
      JSON.stringify({ record_id: futurePurchaseRecord }), futurePurchaseRecord, originalTransactionId],
  );

  const explicitRefundOccurredAt = "2026-08-19T01:00:00.000Z";
  const explicitFutureRefundLogicalEventId = await insertStrictCommerceSource(
    explicitFutureRefundRecord, "refund", explicitRefundOccurredAt,
    "2026-08-19T02:00:00.000Z", "1",
  );
  await appClient.query("SET CONSTRAINTS ledger.refund_facts_target_invariant DEFERRED");
  await insertStrictRefundFact(
    explicitFutureRefundLogicalEventId, `refund-explicit-future-${suffix}`,
    purchaseRecord, explicitRefundOccurredAt,
  );
  await appClient.query("SET CONSTRAINTS ledger.refund_facts_target_invariant IMMEDIATE");
  assert.equal((await appClient.query(
    "SELECT correction_target_record_id FROM ledger.refund_facts WHERE logical_event_id=$1",
    [explicitFutureRefundLogicalEventId],
  )).rows[0].correction_target_record_id, purchaseRecord,
  "an explicit target must resolve when the only other match was received after the refund");

  const explicitFutureTargetRefundLogicalEventId = await insertStrictCommerceSource(
    explicitFutureTargetRefundRecord, "refund", explicitRefundOccurredAt,
    "2026-08-19T02:00:00.000Z", "3",
  );
  await appClient.query("SAVEPOINT refund_explicit_target_future_received");
  try {
    await appClient.query("SET CONSTRAINTS ledger.refund_facts_target_invariant DEFERRED");
    await insertStrictRefundFact(
      explicitFutureTargetRefundLogicalEventId, `refund-explicit-future-target-${suffix}`,
      futurePurchaseRecord, explicitRefundOccurredAt,
    );
    await appClient.query("SET CONSTRAINTS ledger.refund_facts_target_invariant IMMEDIATE");
    throw new Error("future-received explicit refund target unexpectedly succeeded");
  } catch (error) {
    await appClient.query("ROLLBACK TO SAVEPOINT refund_explicit_target_future_received");
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    assert.equal(code, "23514",
      "an explicit target received after the refund must fail the target invariant");
  }
  assert.equal((await appClient.query(
    "SELECT logical_event_id FROM ledger.refund_facts WHERE logical_event_id=$1",
    [explicitFutureTargetRefundLogicalEventId],
  )).rowCount, 0, "a future-received explicit target must not leave a refund projection");

  const explicitAmbiguousRefundLogicalEventId = await insertStrictCommerceSource(
    explicitAmbiguousRefundRecord, "refund", explicitRefundOccurredAt,
    "2026-08-19T04:00:00.000Z", "2",
  );
  await appClient.query("SAVEPOINT refund_explicit_target_ambiguous");
  try {
    await appClient.query("SET CONSTRAINTS ledger.refund_facts_target_invariant DEFERRED");
    await insertStrictRefundFact(
      explicitAmbiguousRefundLogicalEventId, `refund-explicit-ambiguous-${suffix}`,
      purchaseRecord, explicitRefundOccurredAt,
    );
    await appClient.query("SET CONSTRAINTS ledger.refund_facts_target_invariant IMMEDIATE");
    throw new Error("explicit ambiguous refund target unexpectedly succeeded");
  } catch (error) {
    await appClient.query("ROLLBACK TO SAVEPOINT refund_explicit_target_ambiguous");
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    assert.equal(code, "23514",
      "an explicit target must not bypass strict ambiguity after receipt precedence is applied");
  }

  const legacyPurchaseLogicalEventId = `logical-legacy-purchase-${suffix}`;
  await appClient.query(
    `INSERT INTO ledger.logical_events (
      logical_event_id, record_id, tenant_id, app_id, producer, event_id,
      event_name, record_lifecycle, timeliness, artifact
    ) VALUES ($1,$2,$3,$4,'sdk-android',$5,'purchase','active','on_time',$6::jsonb)`,
    [
      legacyPurchaseLogicalEventId,
      legacyPurchaseRecord,
      tenantA,
      appA,
      `event-legacy-purchase-${suffix}`,
      JSON.stringify({ record_id: legacyPurchaseRecord }),
    ],
  );
  const legacyPurchase = await appClient.query<{ record_id: string | null; financial_status: string | null }>(
    `INSERT INTO ledger.purchase_facts (
      logical_event_id, tenant_id, app_id, installation_id, transaction_id,
      amount_unscaled, amount_scale, currency, occurred_at, artifact
    ) VALUES ($1,$2,$3,NULL,$4,'100',2,'USD',$5,$6::jsonb)
    RETURNING record_id, financial_status`,
    [
      legacyPurchaseLogicalEventId,
      tenantA,
      appA,
      `legacy-transaction-${suffix}`,
      timestamp,
      JSON.stringify({ legacy_purchase: true }),
    ],
  );
  assert.deepEqual(legacyPurchase.rows[0], { record_id: null, financial_status: null },
    "pre-024 purchase projection columns must remain nullable after upgrade");
  assert.equal((await appClient.query(
    "SELECT logical_event_id FROM ledger.refund_facts WHERE logical_event_id=$1",
    [legacyPurchaseLogicalEventId],
  )).rowCount, 0, "legacy purchases must not create strict refund projections");

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

  await withTenant(appPool, tenantB, (client) => client.query(
    "INSERT INTO control.apps (tenant_id, app_id, created_at) VALUES ($1,$2,$3)",
    [tenantB, appB, timestamp],
  ));
  const auditA = uuidV7(Date.parse(timestamp));
  const auditB = uuidV7(Date.parse(timestamp) + 1);
  for (const [tenantId, appId, auditId] of [
    [tenantA, appA, auditA],
    [tenantB, appB, auditB],
  ] as const) {
    await withTenant(appPool, tenantId, (client) => client.query(
      `INSERT INTO ledger.audit_logs (
         audit_log_id, tenant_id, app_id, occurred_at, actor_type, actor_ref,
         action, target_scope, target_ref, policy_version, request_digest,
         outcome, reason_code
       ) VALUES ($1,$2,$3::text::control.identifier,$4,'system_job','job:mmp_import','job_completed',
         'app',$3::text,'job-health-v1',$5,'succeeded',NULL)`,
      [auditId, tenantId, appId, timestamp, "0".repeat(64)],
    ));
  }
  assert.equal(
    (await readerPool.query<{ count: number }>("SELECT count(*)::int AS count FROM ledger.audit_logs")).rows[0].count,
    0,
    "audit reader without a tenant GUC must see zero rows",
  );
  await withTenant(readerPool, tenantA, async (client) => {
    assert.equal(
      (await client.query("SELECT audit_log_id FROM ledger.audit_logs WHERE audit_log_id=$1", [auditA])).rowCount,
      1,
      "audit reader must select its own tenant row",
    );
    assert.equal(
      (await client.query("SELECT audit_log_id FROM ledger.audit_logs WHERE audit_log_id=$1", [auditB])).rowCount,
      0,
      "audit reader for tenant A must not select tenant B audit rows",
    );
  });
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
