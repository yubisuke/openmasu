import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
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
});
