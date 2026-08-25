# Operator Real-Data Validation Checklist

This procedure is an operator-owned M1.5 input. Run it only in a private deployment with authorized data and credentials. Never commit exports, row samples, API responses, campaign identifiers, user/device values, secrets, screenshots, logs containing values, or completed results to this public repository.

## Preconditions

- Use a disposable private tenant/app and encrypted storage.
- Confirm retention, deletion, access control, backups, and incident ownership before loading data.
- Record tool versions, mapping version, source date range, timezone, currency, and input digests in a private validation record.
- Use the public mappings only as templates; keep provider-specific mappings and certification evidence private.

## 1. D7 ROAS comparison

1. Select one authorized campaign cohort and freeze the OpenMasu watermark, metric-definition version, rule-bundle version, timezone, FX snapshot, and cost snapshot.
2. Compute D7 ROAS in OpenMasu and obtain the corresponding existing-MMP result through an authorized private export or dashboard.
3. Record both values, denominators, coverage limits, snapshot identifiers, and percentage difference only in the private validation record. Never paste values, campaign identifiers, screenshots, or exports into this repository.
4. Classify the difference using candidates, exclusions, windows, joins, freshness, import limits, redaction, currency policy, or modeled-conversion evidence. Do not describe either provider as correct or incorrect.
5. Treat an unexplained difference or a difference outside the owner-approved tolerance as an M1.5 decision input, not as evidence to silently change a public metric definition.

## 2. Existing-MMP export

1. Select one authorized day and make a private copy of the provider export.
2. Run the schema-validated import from a path outside the repository.
3. Record privately: source row count, accepted count, rejection counts by reason, fields not mapped, logical-event count, duplicate-delivery count, and exact-file skip result.
4. Confirm rejected rows did not reach the evaluator and no row values appeared in logs.
5. Re-run a byte-identical file, then an equivalent restated file, and confirm the documented idempotency behavior.

## 3. Media cost

1. Run the Meta and Google Ads adapters with least-privilege read credentials, or use the manual mapping for another authorized source.
2. Record privately: requested date range, network/account currency, daily row counts, unmapped country criteria, schema errors, asynchronous-report behavior, and field omissions.
3. Import the same source snapshot twice, then one restatement. Confirm the first row remains, the repeated snapshot is idempotent, and `cost_records_current` selects the restatement.
4. Compare totals with the source dashboard privately. A mismatch is a finding, not a repository edit or a provider-quality claim.

## 4. MAX revenue

1. Configure the allowlisted postback template without IDFA, IDFV, or IP macros.
2. Send a controlled authorized postback and verify 204, durable inbox receipt, worker processing, duplicate delivery classification, and aggregate behavior when no user anchor is present.
3. Run the Reporting API backfill for the same UTC day and record privately any S2S coverage gap and reporting freshness.
4. Exercise a deletion request and confirm the encrypted object and wrapped key entry are gone and cannot be decrypted.

## 5. D0 reproducibility

1. Freeze the input watermark, metric definition, rule bundle, timezone, FX snapshot, and rounding policy.
2. Reproduce all three D0 definitions and record private totals and snapshot IDs.
3. Apply one lawful redaction and confirm immutable prior rows plus a `redaction_affected` superseding run.
4. Classify differences by candidates, exclusions, windows, joins, freshness, import limitations, or redaction. Do not label a provider as correct or incorrect.

## M1.5 handoff

The private record should summarize coverage, unexplained differences, operational effort, security gaps, platform limitations, and cost. The owner uses it to choose whether to continue as an audit layer, proceed toward first-party measurement, or stop expansion. Only that decision and non-sensitive aggregate conclusions may enter the public project; raw evidence and provider-confidential results stay outside it.
