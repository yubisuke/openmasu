import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCommerceBackfillOptions } from "./commerce-backfill.js";

describe("verified commerce protected backfill command", () => {
  const base = ["--tenant=tenant-synthetic", "--app=app-synthetic", "--provider=google_play",
    "--operation=google_order_refund", "--subject-file=synthetic-protected.json",
    "--window-start=2026-08-01T00:00:00.000Z", "--window-end=2026-08-25T00:00:00.000Z"];

  it("accepts one bounded provider operation and canonical half-open window", () => {
    const parsed = parseCommerceBackfillOptions(base);
    assert.equal(parsed.provider, "google_play");
    assert.equal(parsed.operation, "google_order_refund");
    assert.ok(parsed.subjectFile.endsWith("synthetic-protected.json"));
  });

  it("rejects provider mismatch, malformed windows, and incomplete protected input", () => {
    assert.throws(() => parseCommerceBackfillOptions(base.map((value) => value === "--provider=google_play" ? "--provider=app_store" : value)), /provider_operation_mismatch/);
    assert.throws(() => parseCommerceBackfillOptions(base.map((value) => value.startsWith("--window-end=") ? "--window-end=2026-07-01T00:00:00.000Z" : value)), /usage/);
    assert.throws(() => parseCommerceBackfillOptions(base.filter((value) => !value.startsWith("--subject-file="))), /usage/);
  });
});

