# Optional Private Shadow-Measurement Checklist

This checklist is for an operator who separately authorizes a private comparison
with real measurement data. It is not a repository completion gate, and public
development can continue without performing it.

Never copy real exports, credentials, campaign values, identifiers, screenshots,
logs, results, or derived numbers into this repository, an issue, a pull request,
or a commit message.

## Preconditions

- [ ] Record the exact OpenMasu source commit and Contract v0.4 patch level in a
      private evidence system.
- [ ] Confirm the operator is authorized to use each source and credential.
- [ ] Run `npm run pilot:preflight` and record its synthetic-only result.
- [ ] Run `npm run pilot:synthetic -- --disposable` from a clean worktree.
- [ ] Confirm the private target is disposable or backed up and is not the
      public fixture database.
- [ ] Freeze aggregation time zone, currency/FX source, metric definition,
      attribution rule bundle, cost revision, watermark, and cohort range.

Do not run repository integration tests against a database containing data you
need to preserve. Some integration tests truncate their isolated test tables.

## Import compatibility

1. Run the no-write compatibility report on the authorized artifact.
2. Review mapping warnings, field coverage, row selection, and exact-money
   readiness.
3. Keep source values and the detailed report in the private evidence system.
4. Treat the status as applying to that artifact and mapping only; it does not
   certify or score the provider.

## Cost and revenue

- [ ] Confirm every expected report partition and date is present.
- [ ] Confirm currency, time zone, precision, pagination, and restatement rules.
- [ ] Compare imported aggregate totals with the authorized source dashboard.
- [ ] Keep installation-level revenue separate from provider aggregate revenue.
- [ ] Record missing, late, duplicated, or revised rows with a closed difference
      classification.

## Metric comparison

- [ ] Recalculate the same cohort with the same frozen definitions and
      watermark.
- [ ] Compare D0/D1/D3/D7/D30/D90 values only when both systems define the same
      numerator, denominator, date authority, attribution status, and FX rule.
- [ ] Preserve undefined metrics as undefined with their reason.
- [ ] Classify each difference by candidate, exclusion, window, join, freshness,
      cost, revenue, FX, or definition rather than labeling a provider good or
      bad.

## Completion record

Record privately:

- source and destination snapshot identifiers;
- rule and metric versions;
- aggregate row counts and difference categories;
- incomplete checks and their owners;
- whether the result supports continued audit use.

Do not use this checklist to declare OpenMasu a replacement for the existing
provider. The product direction remains an auditable Shadow MMP.
