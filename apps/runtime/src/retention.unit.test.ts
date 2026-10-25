import assert from "node:assert/strict";
import { it } from "node:test";
import type { Pool } from "pg";
import type { PayloadStore } from "./payload-store.js";
import { applyRetention,parseRetentionPolicy } from "./retention.js";
import { retentionMetricInvalidationSql } from "./retention-evidence.js";
import { parseRetentionCommand } from "../../api/src/retention-cli.js";

const policy = {version:1,enabled:false,as_of:"2026-08-10T00:00:00.000Z",layers:{protected_payload:{keep_days:7},expired_request_nonces:{grace_seconds:0}}};
it("retention_is_explicit_default_off_closed_and_never_chooses_a_legal_duration", async () => {
  const now = new Date("2026-08-11T00:00:00.000Z");
  assert.deepEqual(parseRetentionPolicy(policy,now),policy);
  await assert.rejects(applyRetention({pool:{} as Pool,payloadStore:{} as PayloadStore,
    scope:{tenantId:"synthetic-tenant",appId:"synthetic-app"},policy,receipt:"1".repeat(64),now:()=>now}),/retention_disabled/);
  for (const value of [undefined,{}, {...policy,enabled:undefined}, {...policy,layers:{}}, {...policy,as_of:"2026-02-30T00:00:00.000Z"},
    {...policy,as_of:"2027-08-10T00:00:00.000Z"}, {...policy,layers:{ledger:{keep_days:7}}}, {...policy,extra:true},
    {...policy,layers:{protected_payload:{keep_days:0}}}, {...policy,layers:{protected_payload:{keep_days:1,automatic:true}}},
    {...policy,layers:{expired_request_nonces:{grace_seconds:-1}}}]) assert.throws(()=>parseRetentionPolicy(value,now),/retention_policy_invalid/);
  assert.throws(()=>parseRetentionCommand(["apply","--tenant=synthetic","--app=synthetic","--policy=synthetic.json"]),/arguments_invalid/);
  assert.throws(()=>parseRetentionCommand(["preview","--tenant=synthetic","--app=synthetic","--policy=synthetic.json","--limit=5"]),/arguments_invalid/);
  assert.equal(parseRetentionCommand(["apply","--tenant=synthetic","--app=synthetic","--policy=synthetic.json",`--receipt=${"1".repeat(64)}`,"--limit=1"]).maximumItems,1);
});
it("retention_invalidation_is_evidence_bound_not_a_rewrite_of_historical_watermarks_or_privacy", () => {
  const sql = retentionMetricInvalidationSql("mr");
  assert.match(sql,/retention_state.tenant_id=mr.tenant_id/); assert.match(sql,/retention_state.app_id=mr.app_id/);
  assert.match(sql,/lifecycle_status='purged'/); assert.match(sql,/privacy_request_id IS NULL/);
  assert.doesNotMatch(sql,/UPDATE|DELETE|watermark|now\(/);
});
