import assert from "node:assert/strict";
import { it } from "node:test";
import { CONSENT_PURPOSES, purposeConsentAt, purposeConsentAdmission, type PurposeConsentControl } from "./purpose-consent.js";

const control = (consent_state: PurposeConsentControl["consent_state"], consent_revision: number | undefined,
  recognized_sequence: number, processing_purpose_id?: PurposeConsentControl["processing_purpose_id"]): PurposeConsentControl => ({
  consent_state, consent_revision, recognized_sequence, recognized_at: new Date(Date.UTC(2026, 10, 1, 0, 0, recognized_sequence)).toISOString(),
  ...(processing_purpose_id ? { processing_purpose_id } : {}),
});

it("purpose consent separates three declarations and preserves global scope and unknown barriers", () => {
  const controls = [control("granted", 1, 1), control("withdrawn", 2, 2, "analytics"),
    control("not_required", 3, 3, "revenue_measurement"), control("unknown", 4, 4, "analytics")];
  const snapshots = purposeConsentAt(controls, 4);
  assert.deepEqual(snapshots.map(row => row.processing_purpose_id), CONSENT_PURPOSES);
  assert.deepEqual(snapshots.map(row => row.consent_revision), [1, 2, 3]);
  assert.deepEqual(snapshots.map(row => purposeConsentAdmission(row, row.consent_revision)), ["allowed", "withdrawn", "not_required"]);
  const global = purposeConsentAt([...controls, control("denied", 5, 5)], 5);
  assert.deepEqual(global.map(row => purposeConsentAdmission(row, 5)), ["withdrawn", "withdrawn", "withdrawn"]);
});

it("purpose consent ignores stale reordered controls and never resurrects a pre-withdrawal event after regrant", () => {
  const controls = [control("granted", 1, 1, "analytics"), control("withdrawn", 2, 3, "analytics"),
    control("granted", 1, 4, "analytics"), control("granted", 3, 6, "analytics"), control("denied", 2, 7, "analytics")];
  const at = (sequence: number) => purposeConsentAt(controls, sequence)[0];
  assert.equal(purposeConsentAdmission(at(2), 1), "allowed", "completed receipt before withdrawal is not reinterpreted");
  assert.equal(purposeConsentAdmission(at(4), 1), "withdrawn", "late old grant does not reopen collection");
  assert.equal(purposeConsentAdmission(at(5), 3), "withdrawn", "future grant is not recognized yet");
  assert.equal(purposeConsentAdmission(at(7), 1), "revision_unconfirmed", "old queued revision cannot revive");
  assert.equal(purposeConsentAdmission(at(7), 3), "allowed", "late old denial does not overwrite fresh regrant");
  assert.deepEqual(purposeConsentAt([...controls].reverse(), 7), purposeConsentAt(controls, 7));
  assert.deepEqual(purposeConsentAt([...controls, controls[3]], 7), purposeConsentAt(controls, 7), "replay is idempotent");
});

it("purpose consent fails closed on same-revision conflicts and unacknowledged generations", () => {
  const granted = control("granted", 1, 1, "analytics"), denied = control("withdrawn", 1, 3, "analytics");
  assert.equal(purposeConsentAdmission(purposeConsentAt([granted, denied], 2)[0], 1), "allowed");
  for (const controls of [[granted, denied], [denied, granted]])
    assert.equal(purposeConsentAdmission(purposeConsentAt(controls, 3)[0], 1), "revision_unconfirmed");
  assert.equal(purposeConsentAdmission(undefined, 1), "revision_unconfirmed");
  assert.equal(purposeConsentAdmission(undefined, undefined), "legacy");
  assert.equal(purposeConsentAdmission(undefined, 0), "legacy");
  assert.equal(purposeConsentAdmission(purposeConsentAt([granted], 1)[0], undefined), "revision_unconfirmed");
  for (const revision of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(purposeConsentAdmission(undefined, revision), "revision_unconfirmed");
});

it("purpose consent retains legacy withdrawals until a fresh higher revision, not a duplicate grant", () => {
  const controls = [control("granted", undefined, 1), control("withdrawn", undefined, 2),
    control("granted", 1, 3), control("denied", undefined, 4), control("granted", 1, 5), control("granted", 2, 6)];
  assert.deepEqual(purposeConsentAt(controls, 1), [], "unversioned grant does not weaken historical policy");
  assert.equal(purposeConsentAdmission(purposeConsentAt(controls, 2)[0], 0), "withdrawn");
  assert.equal(purposeConsentAdmission(purposeConsentAt(controls, 3)[0], 1), "allowed");
  assert.equal(purposeConsentAdmission(purposeConsentAt(controls, 5)[0], 1), "withdrawn");
  assert.equal(purposeConsentAdmission(purposeConsentAt(controls, 6)[0], 2), "allowed");
});

it("purpose consent rejects malformed controls before they can alter any projection", () => {
  const valid = control("granted", 1, 1, "analytics");
  for (const changes of [{ consent_revision: 0 }, { consent_revision: undefined }, { consent_revision: Number.MAX_SAFE_INTEGER + 1 },
    { processing_purpose_id: "fraud_prevention" }, { recognized_sequence: -1 }, { recognized_at: "2026-02-30T00:00:00.000Z" },
    { consent_state: "synthetic-unrecognized" }]) {
    assert.throws(() => purposeConsentAt([{ ...valid, ...changes } as PurposeConsentControl], 10), /control_invalid/);
  }
  assert.throws(() => purposeConsentAt([], -1), /sequence_invalid/);
});
