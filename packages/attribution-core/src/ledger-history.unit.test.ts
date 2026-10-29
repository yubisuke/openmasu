import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { firstPartyWindowDefinition, firstPartyWindowHash } from "@openmasu/contracts/definitions";
import {
  evaluate,
  IndexedCandidateProvider,
  sha256,
  type CandidateAttempt,
} from "./evaluator.js";

type Any = Record<string, any>;

const fixture = JSON.parse(readFileSync(
  new URL("../../../fixtures/v0.4/01-valid-install-referrer/input.json", import.meta.url),
  "utf8",
)) as Any;
const legacyRefundFixture = JSON.parse(readFileSync(
  new URL("../../../fixtures/v0.4/16-correction-refund/input.json", import.meta.url),
  "utf8",
)) as Any;

function runtimeInput(records: Any[]): Any {
  return {
    ...structuredClone(fixture),
    records,
    batches: undefined,
    reconciliation_inputs: [],
  };
}

function historyAttempt(record: Any, semanticAvailable: boolean): CandidateAttempt {
  return {
    server: structuredClone(fixture.server_context),
    record: structuredClone(record),
    batch_id: `ledger:${record.record_id}`,
    history_state: {
      payload_sha256: sha256(record.payload),
      semantic_available: semanticAvailable,
      ledger_position: "42",
    },
  };
}

describe("ledger-backed evaluator candidates", () => {
  it("opts into 1/7/30-day half-open windows without changing default or platform decisions", () => {
    const context = (days:1|7|30) => {
      const definition=firstPartyWindowDefinition(days),hash=firstPartyWindowHash(definition);
      return {definition,rule_bundle_id:definition.id,rule_bundle_version:definition.version,rule_bundle_hash:hash,definition_digest:hash};
    };
    for (const days of [1,7,30] as const) for (const offset of [-1,0,1]) {
      const input=runtimeInput(structuredClone(fixture.records));
      input.server_context.first_party_attribution_bundle=context(days);
      const click=input.records[0], install=input.records[1];
      const end=new Date(Date.parse(click.payload.redirector_click_at)+days*86_400_000+offset).toISOString();
      install.payload.install_begin_at_server=end;
      const actual=evaluate(input).attributions[0];
      assert.equal(actual.reason_code,offset<0 ? "valid_install_referrer":"window_expired");
      assert.equal(actual.rule_bundle_hash,context(days).rule_bundle_hash);
      assert.match(actual.attribution_id,/^attr:window:[a-f0-9]{64}$/);
      assert.deepEqual(evaluate(input).attributions,[actual]);
    }
    const platform=JSON.parse(readFileSync(new URL("../../../fixtures/v0.4/34-stage-c-apple-meta-attribution/input.json",import.meta.url),"utf8"));
    const old=evaluate(platform).attributions.filter(row=>row.method!=="install_referrer");
    platform.server_context.first_party_attribution_bundle=context(1);
    const oldIds=new Set(old.map(row=>row.attribution_id));
    assert.deepEqual(evaluate(platform).attributions.filter(row=>oldIds.has(row.attribution_id)),old);
    const historical=historyAttempt(fixture.records[1],true);
    historical.server.first_party_attribution_bundle=context(1);
    const current=runtimeInput([structuredClone(fixture.records[0])]);
    current.server_context.first_party_attribution_bundle=context(30);
    const result=evaluate(current,values=>new IndexedCandidateProvider([historical,...values])).attributions[0];
    assert.equal(result.reason_code,"window_expired");
    assert.equal(result.rule_bundle_hash,context(1).rule_bundle_hash,"late click cannot adopt the current 30-day revision");
  });
  it("uses an available normalized click for a new install without emitting the historical event", () => {
    const click = historyAttempt(fixture.records[0], true);
    const install = structuredClone(fixture.records[1]);
    const output = evaluate(runtimeInput([install]), (values) =>
      new IndexedCandidateProvider([click, ...values]));
    assert.equal(output.attributions[0].reason_code, "valid_install_referrer");
    assert.deepEqual(output.logical_events.map((event) => event.record_id), [install.record_id]);
  });

  it("excludes purged semantics but retains the stored digest for duplicate classification", () => {
    const source = structuredClone(fixture.records[0]);
    const tombstone = historyAttempt({ ...source, payload: {} }, false);
    tombstone.history_state = {
      ...tombstone.history_state!,
      payload_sha256: sha256(source.payload),
    };
    const duplicate = {
      ...source,
      record_id: "click-ledger-duplicate",
      delivery_id: "delivery:click-ledger-duplicate",
    };
    const duplicateOutput = evaluate(runtimeInput([duplicate]), (values) =>
      new IndexedCandidateProvider([tombstone, ...values]));
    assert.equal(duplicateOutput.deliveries[0].duplicate_resolution, "duplicate_delivery");
    assert.equal(duplicateOutput.raw_records.length, 0);

    const install = structuredClone(fixture.records[1]);
    const installOutput = evaluate(runtimeInput([install]), (values) =>
      new IndexedCandidateProvider([tombstone, ...values]));
    assert.equal(installOutput.attributions[0].reason_code, "unknown_click_id");
  });

  it("re-evaluates a normalized historical install when its click arrives late", () => {
    const historicalInstall = historyAttempt(fixture.records[1], true);
    const lateClick = structuredClone(fixture.records[0]);
    lateClick.record_id = "click-late-ledger";
    lateClick.delivery_id = "delivery:click-late-ledger";
    lateClick.received_at = "2026-08-21T00:00:05.000Z";
    const output = evaluate(runtimeInput([lateClick]), (values) =>
      new IndexedCandidateProvider([historicalInstall, ...values]));
    assert.equal(output.attributions.length, 1);
    assert.equal(output.attributions[0].subject_ref, historicalInstall.record.payload.installation_id);
    assert.equal(output.attributions[0].reason_code, "valid_install_referrer");
    assert.deepEqual(output.logical_events.map((event) => event.record_id), [lateClick.record_id]);
  });

  it("validates an explicit refund reference against scoped ledger history", () => {
    const purchase = historyAttempt(legacyRefundFixture.records[0], true);
    const refund = structuredClone(legacyRefundFixture.records[1]);
    const output = evaluate(runtimeInput([refund]), (values) =>
      new IndexedCandidateProvider([purchase, ...values]));
    assert.deepEqual(output.corrections, [{
      contract_version: "0.4.0",
      tenant_id: refund.tenant_id,
      app_id: refund.app_id,
      correction_id: `correction:${refund.record_id}`,
      corrects_record_id: purchase.record.record_id,
      correction_type: "correction",
      correction_reason: "refund",
      effective_at: refund.occurred_at,
    }]);
  });
});
