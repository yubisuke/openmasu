# Operator Real-Data Validation Checklist

This procedure is an operator-owned M1.5 input. Run it only in a private deployment with authorized data and credentials. Never commit exports, row samples, API responses, campaign identifiers, user/device values, secrets, screenshots, logs containing values, or completed results to this public repository.

## Preconditions

- Use a disposable private tenant/app and encrypted storage.
- Confirm retention, deletion, access control, backups, and incident ownership before loading data.
- Record tool versions, mapping version, source date range, timezone, currency, and input digests in a private validation record.
- Use the public mappings only as templates; keep provider-specific mappings and certification evidence private.

## Synthetic preflight

1. Run `npm run test:integration` against the disposable database before loading private data.
2. Confirm the test named `WO11 carries an attributed install, revenue, and cost through to non-zero D0 ROAS` passes.
3. Treat this as a pipeline preflight only. It does not prove live provider connectivity or certify private mappings.

## Execution and failure handling

1. Run the existing-MMP import, media-cost import, revenue ingestion or backfill, and metric calculation in that order.
2. Stop immediately if any step exits non-zero. Do not publish or compare a metric after an upstream failure.
3. Configure the private scheduler or orchestrator to notify the operator when a step exits non-zero. Use the authenticated `openmasu_job_runs_total` and `openmasu_job_last_completion_timestamp_seconds` series for the fixed `mmp_import`, `cost_import`, `max_revenue_import`, and `metric_run` jobs, but keep thresholds, receivers, contact details, and credentials outside this repository.
4. Confirm each operator CLI command produced exactly one terminal outcome at the intended tenant/app scope. The public metrics expose only fixed job/outcome labels; record input digest, date range, and output summary only in the private validation record.
5. Use a first end-to-end cohort with both non-zero revenue and non-zero cost. A zero result requires source evidence and is not, by itself, proof that the full pipeline worked.

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

1. Use the manual cost mapping with an authorized export, or one of the bounded Meta and Google Ads commands documented in `docs/import-mappings.md`. Both commands are executable and synthetically tested; live account connectivity remains unverified.
2. For Google Ads, configure the access token and developer token privately, use the optional login-customer ID only for the intended manager hierarchy, and request one exact inclusive date range. Record privately: requested range, customer and manager context, network/account currency, daily row counts, unmapped country criteria, schema errors, API or report behavior, and field omissions.
3. Import the same source snapshot twice, then one restatement. Confirm the first row remains, the repeated snapshot is idempotent, and `cost_records_current` selects the restatement.
4. Compare totals with the source dashboard privately. A mismatch is a finding, not a repository edit or a provider-quality claim.
5. For Meta, record any permission, timezone, pagination, or synchronous-report limitation privately. For Google Ads, confirm the allowlisted ad-group query retains ad groups; the three exact App subtypes, Performance Max, and Local Services omit them; all three queries use `LOCATION_OF_PRESENCE`; the reported customer currency matches the configured currency; and every country criterion resolves through the bounded lookup. Treat an unsupported residual campaign type as a failed run requiring an explicit adapter review, not as a row to skip.
6. For both providers, distinguish executable wiring from live connectivity evidence. Record permissions, quotas, account hierarchy, field compatibility, and other provider-specific limitations privately; do not treat synthetic coverage as certification of a live account.

## 4. MAX revenue

1. Configure the allowlisted postback template without IDFA, IDFV, or IP macros.
2. Send a controlled authorized postback and verify 204, durable inbox receipt, worker processing, duplicate delivery classification, and aggregate behavior when no user anchor is present.
3. Configure `OPENMASU_MAX_REPORT_KEY` or its `_FILE` variant privately and run `npm run import:revenue:max -- --tenant=<id> --app=<id> --start=<YYYY-MM-DD> --end=<YYYY-MM-DD>`. The inclusive UTC dates must remain within the provider's current 45-day request window. Record only the requested range, row count, report snapshot digest, and command outcome in the private validation record.
4. Import the same response twice, then a later restatement for the same retained dimension. Confirm the repeated snapshot inserts no row, history remains append-only, and `aggregate_revenue_snapshots_current` selects the later observation.
5. Compare the provider-reported aggregate series with S2S totals privately, but never sum the two as independent revenue: the same impressions may be present in both. Confirm the reporting rows contain no installation identifier and do not change installation-level cohort metrics.
6. The command and synthetic provider responses are tested; live MAX credentials, account access, response compatibility, recent-data completeness, and dashboard reconciliation remain unverified until this procedure is run privately.
7. Exercise a deletion request and confirm the encrypted object and wrapped key entry are gone and cannot be decrypted. Aggregate provider snapshots contain no installation subject and therefore are not a substitute for subject-level deletion evidence.

## 5. D0 reproducibility

1. Freeze the input watermark, metric definition, rule bundle, timezone, FX snapshot, and rounding policy.
2. Reproduce all three D0 definitions and record private totals and snapshot IDs.
3. Apply one lawful redaction and confirm immutable prior rows plus a `redaction_affected` superseding run.
4. Classify differences by candidates, exclusions, windows, joins, freshness, import limitations, or redaction. Do not label a provider as correct or incorrect.

## M1.5 handoff

The private record should summarize coverage, unexplained differences, operational effort, security gaps, platform limitations, and cost. The owner uses it to choose whether to continue as an audit layer, proceed toward first-party measurement, or stop expansion. Only that decision and non-sensitive aggregate conclusions may enter the public project; raw evidence and provider-confidential results stay outside it.
