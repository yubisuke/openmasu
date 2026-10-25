# Preview a fraud policy change

An administrator can compare the active fraud definition with a candidate on
the same bounded, currently available evidence before explicitly activating it.
The preview reuses the reference evaluator's fraud and metric projections. It
does not insert decisions, metrics, audit records, capabilities or receipts.
No service, queue or external fraud feed is added.

## Prepare and review

1. Save at least one compatible pair of gross/net metric profiles for the app.
   Their definitions, grouping and FX policy must agree except for metric name
   and fraud policy. The preview uses saved private replay manifests, not a new
   calculation DSL or numbers copied from a previous run.
2. Open the app detail page as an administrator. In **Fraud rule bundle**,
   paste a complete candidate definition with the same bundle ID as the active
   definition and select an explicit past receipt cutoff. The cutoff must be a
   canonical millisecond UTC timestamp, such as `2026-08-22T00:00:00.000Z`.
3. Review baseline/candidate versions and composite hashes, decision/action
   counts, changed decisions, evidence coverage, and gross/net scaled values and
   deltas. Undefined or unavailable results are not rendered as zero.
4. If there are no blockers, confirm **Activate this reviewed candidate**.
   Activation rechecks the predecessor, definition, cutoff and evidence digest
   in one transaction before inserting the revision and its normal audit record.
   A changed definition, new evidence at/before the cutoff, privacy change or
   changed predecessor requires a fresh preview.

The comparison enables fraud actions in both counterfactual branches. It is
not a reproduction of a deployment's disabled-actions setting, a live forecast,
a measured detection rate, precision, or evidence of real fraud. Source-scoped
signals do not silently become installation exclusions. The existing kernel's
emitted rules are reused; reserved rule names do not invent new verdicts.

## Evidence and limits

The read-only transaction uses a repeatable-read snapshot and the existing
tenant privacy fence. It selects accepted, active, available app evidence at or
before the requested cutoff. It never decrypts discarded/redacted payloads or
resurrects expired evidence. Unavailable records are counted separately, so the
result describes the retained population rather than claiming complete history.

The hard bounds are 1,000 accepted records, 1,000 attribution subjects, 1,000
cost rows, 100 source-day grains and 20 saved metric profiles. Overflow refuses
the request rather than truncating. The request is limited to 65,536 UTF-8 bytes
and queries have a ten-second statement timeout. This is an app-scoped bounded
policy review, not an unbounded historical backtest.

New normalized click/install facts retain a versioned closed subset of existing
rule inputs: replay classification and authoritative click/install times and
statuses. No new device input, raw referrer, token, IP or User-Agent is retained.
Source-day artifacts also retain the actual cross-source median used by their
evaluation, rather than recomputing an old baseline from a changed population.
Older click/install facts or source aggregates without their input version cannot prove a faithful
comparison: the response reports `historical_fraud_inputs_missing`, omits impact
numbers, and blocks activation. There is no guessed backfill. No available
evidence, an in-progress privacy operation, missing projections/metric inputs or
a missing gross/net pair also blocks activation.

Each response has a stateless SHA-256/JCS receipt binding the tenant/app,
baseline revision, candidate definition/hash, cutoff and captured evidence.
It is a consistency token, not an authorization credential. The normal operator
role and optional single-app restriction still apply. Preview returns only
aggregate effects and hashes, not record IDs, installations or payload references.

## HTTP interface

`POST /v1/admin/apps/:app/rule-bundles/preview` requires an administrator bearer:

```json
{
  "definition": { "id": "fraud-conservative", "version": "candidate-version", "layers": {}, "rules": [] },
  "watermark_at_most": "2026-08-22T00:00:00.000Z"
}
```

The definition above shows the transport envelope only. Supply a valid full
definition using the existing registered bundle shape and rule inputs, not an
empty policy copied from this illustration. Unknown fields are refused.

Replacing an active fraud bundle through the public activation endpoint now
requires the following additional `preview` field alongside its existing full
definition, version/hash and `supersedes_rule_bundle_revision_id`:

```json
{
  "preview": {
    "receipt": "<64 lowercase hexadecimal characters from preview>",
    "watermark_at_most": "2026-08-22T00:00:00.000Z",
    "baseline_revision_id": "<baseline_revision_id from preview>"
  }
}
```

Missing/invalid proof returns 400. A stale receipt, blocked preview or changed
predecessor returns 409 with no activation write. First registration and trusted
internal bootstrap remain compatible; another fraud bundle ID cannot bypass an
existing active baseline through public routes. Non-fraud activation is unchanged.
Dashboard POSTs use the existing session, synchronizer CSRF and Origin checks;
API endpoints never accept a dashboard cookie instead of a bearer.

For a read-only comparison against a recorded revision, pass its ID as optional
`baseline_revision_id` to the preview endpoint. The same retained evidence and
recorded definition reproduce the same canonical fraud artifacts. A non-current
baseline is explicitly marked and cannot activate a candidate. Activation never
rewrites past fraud decisions, attribution or metric runs. Later evidence or
privacy/retention changes are a different replay population, not byte-identical
history.

This operator workflow changes no public event schema, wire version, registry
or reviewed golden fixture. Live policy effectiveness remains unverified.
