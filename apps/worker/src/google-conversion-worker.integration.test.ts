import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createAppPool, EncryptedFilePayloadStore, withTenant } from "@openmasu/runtime";
import { discoverGoogleConversionDeliveries } from "./google-conversion-worker.js";

const suffix = randomBytes(5).toString("hex");
const tenantId = `tenant-gdm-${suffix}`;
const appId = `app-gdm-${suffix}`;
const installationId = `installation:gdm-${suffix}`;
const pool = createAppPool();
const root = mkdtempSync(join(tmpdir(), "openmasu-gdm-"));
const payloadStore = new EncryptedFilePayloadStore(root, `synthetic-${randomBytes(32).toString("base64url")}`);
const at = "2026-08-24T00:00:00.000Z";

after(async () => { await pool.end(); rmSync(root, { recursive: true, force: true }); });

describe("Google Data Manager verified-conversion integration", () => {
  it("discovers one eligible synthetic purchase, encrypts one minimal request, and is idempotent", async () => {
    const clickRecord = `gdm-click-${suffix}`;
    const installRecord = `gdm-install-${suffix}`;
    const purchaseRecord = `gdm-purchase-${suffix}`;
    const clickLogical = `logical:${clickRecord}`;
    const installLogical = `logical:${installRecord}`;
    const purchaseLogical = `logical:${purchaseRecord}`;
    const verificationResultId = randomUUID();
    await withTenant(pool, tenantId, async (client) => {
      await client.query("INSERT INTO control.apps (tenant_id,app_id,created_at) VALUES ($1,$2,$3)", [tenantId, appId, at]);
      for (const [recordId, eventName] of [[clickRecord, "click"], [installRecord, "install"], [purchaseRecord, "purchase"]]) {
        await client.query(`INSERT INTO ledger.raw_records (
          record_id,tenant_id,app_id,producer,producer_version,event_id,delivery_id,event_name,
          schema_version,payload_sha256,occurred_at,occurred_at_source,received_at,raw_payload_ref,
          processing_purpose_id,consent_evaluation_policy_version,consent_decision_reason_code,artifact
        ) VALUES ($1,$2,$3,'synthetic-gdm','1',$4,$5,$6,'0.4','${"a".repeat(64)}',$7,
          'server',$7,$8,'measurement','synthetic-consent-v1','consent_not_required',$9::jsonb)`,
        [recordId, tenantId, appId, `event:${recordId}`, `delivery:${recordId}`, eventName, at,
          `encrypted:synthetic-${recordId}`, JSON.stringify({ synthetic: true })]);
      }
      for (const [logicalId, recordId, eventName] of [[clickLogical, clickRecord, "click"],
        [installLogical, installRecord, "install"], [purchaseLogical, purchaseRecord, "purchase"]]) {
        await client.query(`INSERT INTO ledger.logical_events (
          logical_event_id,record_id,tenant_id,app_id,producer,event_id,event_name,timeliness,artifact
        ) VALUES ($1,$2,$3,$4,'synthetic-gdm',$5,$6,'on_time',$7::jsonb)`,
        [logicalId, recordId, tenantId, appId, `event:${recordId}`, eventName, JSON.stringify({ synthetic: true })]);
      }
      await client.query(`INSERT INTO ledger.click_facts (
        logical_event_id,tenant_id,app_id,click_id,redirector_click_at,network,remote_click_ref,artifact
      ) VALUES ($1,$2,$3,$4,$5,'google_ads',$6,$7::jsonb)`,
      [clickLogical, tenantId, appId, `click:${suffix}`, at, `syntheticGclid_${suffix}`, JSON.stringify({ synthetic: true })]);
      await client.query(`INSERT INTO ledger.install_facts (
        logical_event_id,tenant_id,app_id,installation_id,install_type,click_id,occurred_at,artifact
      ) VALUES ($1,$2,$3,$4,'first_install',$5,$6,$7::jsonb)`,
      [installLogical, tenantId, appId, installationId, `click:${suffix}`, at, JSON.stringify({ synthetic: true })]);
      await client.query(`INSERT INTO ledger.purchase_facts (
        logical_event_id,record_id,tenant_id,app_id,installation_id,transaction_id,amount_unscaled,
        amount_scale,currency,financial_status,occurred_at,artifact
      ) VALUES ($1,$2,$3,$4,$5,$6,'1230000',6,'USD','settled',$7,$8::jsonb)`,
      [purchaseLogical, purchaseRecord, tenantId, appId, installationId, `transaction:${suffix}`, at, JSON.stringify({ synthetic: true })]);
      await client.query(`INSERT INTO ledger.attribution_results (
        attribution_id,tenant_id,app_id,subject_scope,subject_ref,effective_at,decided_at,
        status,method,model,reason_code,artifact
      ) VALUES ($1,$2,$3,'installation_level',$4,$5,$5,'non_organic','last_click','deterministic',
        'valid_install_referrer',$6::jsonb)`,
      [`attribution:${suffix}`, tenantId, appId, installationId, at,
        JSON.stringify({ attribution_id: `attribution:${suffix}`, finality: "final" })]);
      await client.query(`INSERT INTO ledger.google_play_purchase_verification_results (
        verification_result_id,verification_id,tenant_id,app_id,subject_record_id,verified_record_id,
        token_digest,verdict,provider_purchase_state,product_matched,evidence_ref,response_digest,
        decided_at,artifact,purchase_kind
      ) VALUES ($1,$2,$3,$4,$5,$5,$6,'verified','PURCHASED',true,$7,$8,$9,$10::jsonb,'one_time_product')`,
      [verificationResultId, randomUUID(), tenantId, appId, purchaseRecord, "b".repeat(64),
        `encrypted:synthetic-play-${suffix}`, "c".repeat(64), at, JSON.stringify({ synthetic: true })]);
      await client.query(`INSERT INTO control.google_data_manager_destinations (
        destination_id,tenant_id,app_id,operating_account_id,conversion_action_id,app_audience,
        enabled,registered_at,artifact
      ) VALUES ($1,$2,$3,'123456789','987654321','general',true,$4,$5::jsonb)`,
      [randomUUID(), tenantId, appId, at, JSON.stringify({ synthetic: true })]);
    });
    assert.equal(await discoverGoogleConversionDeliveries(pool, payloadStore, tenantId, new Date(at)), 1);
    assert.equal(await discoverGoogleConversionDeliveries(pool, payloadStore, tenantId, new Date(at)), 0);
    const row = await withTenant(pool, tenantId, (client) => client.query<{ request_ref: string }>(
      "SELECT request_ref FROM ephemeral.google_conversion_deliveries WHERE tenant_id=$1 AND app_id=$2", [tenantId, appId]));
    assert.equal(row.rowCount, 1);
    const body = (await payloadStore.read(row.rows[0]!.request_ref)).toString("utf8");
    assert.match(body, /"gclid":"syntheticGclid_/);
    for (const forbidden of [tenantId, appId, installationId, purchaseRecord, "transaction:"]) assert.equal(body.includes(forbidden), false);
  });
});
