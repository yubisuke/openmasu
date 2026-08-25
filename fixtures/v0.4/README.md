# Contract v0.4 fixture provenance

The JSON files in the 56 numbered directories are reviewed, immutable golden contract examples. They are committed as source artifacts; the validation command never creates, updates, or regenerates them.

Each fixture has one synthetic input and 13 independently asserted output classes:

- `expected_raw_records.json`
- `expected_deliveries.json`
- `expected_logical_events.json`
- `expected_corrections.json`
- `expected_privacy_requests.json`
- `expected_privacy_tombstones.json`
- `expected_attributions.json`
- `expected_metric_definitions.json`
- `expected_metric_runs.json`
- `expected_cost_records.json`
- `expected_fraud_decisions.json`
- `expected_rejections.json`
- `expected_reconciliation.json`

The validator checks every object against its Draft 2020-12 schema, checks registry references, runs scenario-specific semantic assertions and acceptance assertions, evaluates each input twice in TypeScript, evaluates it independently in Python, and compares RFC 8785 canonical bytes. Deliberate in-memory mutations prove that malformed timestamps, negative source money, unknown registry values, changed golden output, input reorder, paid reinstall evidence, record-ID collisions, ambiguous clicks, cross-scope references, protected provider-reference leakage, stale-policy provenance drift, cost-dimension drift, aggregate-installation misuse, invalid S2S anchors, refund-target absence/ambiguity/mismatch/temporal stability, extension bypass, and registry/schema drift fail validation or fail closed as specified.

The data is synthetic. It contains no external-source format, campaign data, user data, credential, live fraud rule, or operational threshold.

## Independent third-oracle calculations

These high-value calculations were checked without invoking either reference evaluator.

### Fixture 04: seven-day half-open boundary

The authoritative click time is `2026-08-01T00:00:00.000Z`. Seven days are `7 * 24 * 60 * 60 * 1000 = 604,800,000` milliseconds.

- `install-before` is at `2026-08-07T23:59:59.999Z`, a delta of `604,799,999` ms. It satisfies `click <= install < click + 604,800,000 ms`, so the result is `non_organic/valid_install_referrer`.
- `install-exact` is at `2026-08-08T00:00:00.000Z`, a delta of `604,800,000` ms. The upper bound is exclusive, so the result is `unattributed/window_expired`.
- `install-after` is at `2026-08-08T00:00:00.001Z`, a delta of `604,800,001` ms. It is outside the window, so the result is `unattributed/window_expired`.

### Fixture 08: integer FX and half-even rounding

The late revenue is EUR `123456789012345678 * 10^-18`. The synthetic EUR-to-USD rate is `125000000 * 10^-8`, and the target scale is 6. The integer conversion is:

`123456789012345678 * 125000000 * 10^6 / 10^(18 + 8) = 154320.9862654320975`

Half-even rounding therefore produces `154321` target units, or USD `0.154321`. The initial watermark ends before the revenue delivery and yields `0`; the recalculated watermark includes it and yields `154321`. Separate mutation vectors exercise exact quotient ties: `0.5` rounds to the even integer `0`, and `1.5` rounds to the even integer `2`.

### Fixture 16: explicit-target legacy compatibility

The reviewed fixture remains byte-identical: its purchase is received at `00:02:00.000Z`, after the explicit-target refund at `00:01:00.000Z`, and both payloads omit `installation_id`. Version 0.4.8 treats this as the v0.4.0 legacy correction path: the named record must exist in the same authenticated tenant/app scope, but the new financial status, ordering, identity, cap, business-canonicalization, refund-fact, and purchase-net semantics do not apply. Target-free refunds still require string installation IDs and point-in-time exactly-one resolution.

### Fixture 55: settled purchase/refund net revenue

The one settled purchase is EUR 8.000000 in D0; the synthetic EUR/USD rate is 1.25, so independent integer conversion produces USD `10000000` at scale 6. A target-free settled refund of EUR 3.200000 occurs in D1 and converts independently to USD `4000000`. Cumulative net target units are therefore D0 `10000000` and D1/D3/D7 `6000000`. A pending EUR 50 purchase, reversed EUR 30 purchase, and explicit-target pending EUR 99 refund contribute zero. EUR 5.600000 ad revenue independently converts to the unchanged USD `7000000`, proving the existing `revenue` numerator is separate. Refunds use their own occurrence-time windows; mutations prove a pre-purchase refund, an individual over-refund, a cumulative over-refund, and a later ambiguous purchase all fail closed or preserve the already resolved target as required.

All statuses in this fixture are synthetic, provider-neutral client reports; they do not demonstrate App Store, Google Play, or private-provider verification.

### Fixture 56: D30/D90 total-net revenue metrics

One synthetic imported install has USD 1 advertising revenue and USD 8 settled purchase-net revenue inside D30, so total-net revenue and one-install LTV are USD 9 and ROAS against USD 10 cost is 0.9. D31 revenue is excluded from D30 but included in D90; later D60 revenue and commerce bring D90 purchase net to USD 30 and total net/LTV to USD 37, with ROAS 3.7. A USD 100 purchase at the exact D91 boundary is excluded. These calculations use the half-open `[install, install + (day + 1 days))` rule and contain only synthetic values.

### Protected provider matching keys

Provider matching-key values were independently recomputed from the normative `SHA-256(JCS({provider,type,value}))` formula. Every row uses the synthetic provider namespace `synthetic-provider`; the source values below are synthetic fixture inputs, not external data. Fixtures 01, 03, 19, 21, and 23 expose the corresponding digest in an existing reconciliation golden. Fixture 22 uses its digest only in an unmatched candidate input. Fixtures 28 through 31 expose automatically derived digests in their new reconciliation goldens.

| Fixture | Type | Synthetic source value | Expected lowercase SHA-256 |
| --- | --- | --- | --- |
| 01 | `provider_install_id` | `synthetic-install-1` | `27622e88bcca94a096fd6690d4fb25d606e65ffe74418ea09f333bbcca877436` |
| 03 | `provider_click_id` | `unknown-click_0000000000000000` | `5ac84fec7741b63884b1fe8504653200adb370349ad7fcbca1f48bf2667d4b2b` |
| 19 | `provider_click_id` | `click-prefetch_0000000000000000` | `1352815ec02b9a8553d72598200066cc5f5ca95bef8ec29cb25447db9bb4561a` |
| 21 | `provider_install_id` | `synthetic-install-21` | `312a12c481e6624f835c74cc48eead5b5eb74dad8eaaea1655ae32ed3cdc6842` |
| 22 | `provider_install_id` | `synthetic-install-22` | `401de65d3444761bb478026c7b60da370d89f6bfc8920239c7187345b594126e` |
| 23 | `provider_install_id` | `synthetic-install-23` | `234a0645c8e0ece04db5b18d639af4757c8ca31834eb887a2e5d016589b70161` |
| 28 | `provider_click_id` | `provider-click-28` | `46b3de8a63c82cb88948799b7838979fb3032583ca5c336017312d562b819be2` |
| 28 | `provider_install_id` | `provider-install-28` | `c4644139ca120ce1ef262d85d8e89522e63a57d79d002843b12c062df7974478` |
| 29 | `provider_install_id` | `provider-install-29` | `4862d4ec3fc9716b858862a45d7a682208de9bebb441cb6b63306ce121d817f8` |
| 30 | `provider_install_id` | `provider-install-30` | `d8f60efac521150c9b4cda17845a89dd2cfa3953277d58c5107a2e855cf64843` |
| 31 | `provider_install_id` | `provider-install-modeled-31` | `a593e0f1a0fc48f9bb42a263189ea5f9c706d93771301b8d8898e65777abdecd` |

### Fixture 33: per-event FX, cost revision, and cohort metrics

Each of the three synthetic EUR revenue events has `amount_unscaled=100000001`, scale 6, and EUR-to-USD rate `5 * 10^-1`. At target scale 6, each event converts to the exact tie `50000000.5`; half-even rounds each event to `50000000` before aggregation. Cumulative D1, D3, and D7 revenue is therefore `50000000`, `100000000`, and `150000000` target units. The current cost revision is USD `100000000` scale 6, so the non-organic cohort ROAS at ratio scale 6 is `500000`, `1000000`, and `1500000`. One-install retention on D1 and D7 is `1000000`; D7 cohort LTV is `150000000`; cohort size is `1`. A second synthetic organic install forms a separate attribution-status cohort and yields `undefined/no_attributed_cost` rather than borrowing the paid cohort's denominator.

The cost dimension object `{campaign_id:"provider-campaign-33",country:"JP",network:"synthetic-network"}` has independently checked JCS/SHA-256 digest `953315226bb75e01e5ed7f838cf9f044cbfe5fb899b5bfa5e42e300a87d2caff`. The later `as_of` row supersedes the earlier row only for current selection; both remain immutable inputs. The aggregate revenue uses the synthetic deployment default USD with `currency_source=default` and is excluded from installation-cohort metrics. The imported timestamp is already normalized by truncation to `2026-08-01T00:00:00.123Z`. The reviewed golden artifacts were checked against these formulas and the output schemas; the validator itself never writes them.

### Fixture 34: Apple and Meta attribution envelopes

The fixture contains fifteen synthetic records and no metric, cost, privacy, fraud, correction, or reconciliation input. Eight Android records cover a resolvable first-party click, Meta last-click, Meta view-through, decrypt failure, no campaign data, provider unavailable, unsupported app version, and authentication failure. Typed Meta fields use synthetic IDs only; free-form campaign names are absent. The two AdServices paths map to attributed and expired-token outcomes. The five aggregate postbacks cover verified SKAdNetwork, invalid SKAdNetwork signature, AdAttributionKit non-winner, source suppression, and null conversion value. Every output cites only its same-scope source record. Public producer suffixes are synthetic; the values are not provider or campaign exports.

### Fixture 43: M4 iOS contract handoffs

Four synthetic accepted records exercise only the additive v0.3.2 vocabulary. Two iOS first launches use `install_origin=ios_first_launch` and `referrer_status=not_applicable`; their explicit AdServices results produce distinct `adservices_not_attributed` and `adservices_lookup_unavailable` outcomes. One verified AdAttributionKit envelope records the development signing-key environment, and one verified SKAdNetwork envelope proves that version 4.1 retains the version-4 field rules. The fixture has no metric, cost, privacy, fraud, correction, or reconciliation input. Its thirteen golden classes were reviewed after the TypeScript and Python evaluators produced RFC 8785-identical outputs.

### Fixture 44: Apple aggregate metrics

Three accepted, deduplicated synthetic postbacks qualify because their aggregate attributions are `non_organic`: two SKAN records carry source identifiers plus fine 21 and coarse low conversion evidence, and one AAK record carries source identifier plus fine 7 evidence. Therefore the manually reviewed scalar counts are `skan_attributed_installs=2`, `aak_attributed_installs=1`, `skan_conversion_value_distribution[fine:21]=1`, and `skan_conversion_value_distribution[coarse:low]=1`. All three server `received_at` timestamps fall on `2026-08-20` UTC, which is the aggregate `metric_date`; changing device or synthetic `occurred_at` evidence cannot move these rows. The grouping digests are SHA-256 over the RFC 8785 canonical dimension objects, and the input snapshot digest is SHA-256 over the three ordered record snapshot rows.

### Fixture 45: iOS conversion-schema provenance

The synthetic iOS install fixes the bundled conversion policy to version `openmasu-default-v1` and SHA-256 `593b3db37b01680452064eacbc32c135832c977933c2a8ac7437fd9d2a50b4ed` inside the existing `extensions` evidence surface. Independently reviewed RFC 8785 payload digests are `3165088f0016e2d7745abfce00a76707c9fb812540dd6e999455e551a3079574` for the install and `b702b0728fbe7d6bf6155c711c515457c27c03e08a9fdd535cb657ed4bf98cba` for the reserved update. These digest changes are derived only from the OpenMasu identifier rename. The schema metadata is evidence only: the iOS install remains `unattributed/platform_referrer_not_available`, and the opt-in lifecycle event emits no metric run.

### Fixture 46: platform integrity evidence reservation

Three synthetic installation envelopes exercise the optional server-assigned integrity field. Play Integrity uses `verified` and `failed` with opaque protected references, while App Attest uses `unavailable` without an evidence reference. No raw provider assertion, token, account value, or device identifier appears. The installs retain their independent `organic/no_referrer`, `unattributed/install_referrer_unavailable`, and `unattributed/platform_referrer_not_available` results, proving that the reserved evidence alone does not determine attribution, fraud, or metric eligibility.

### Fixture 47: runtime payload-schema rejection

One synthetic pre-ingestion failure represents a normalized runtime row whose event payload failed the compiled contract event schema before any raw or logical evidence write. The delivery and rejection retain only non-identifying routing and consent-policy metadata, set `payload_disposition=discarded`, and use `payload_schema_invalid`. The remaining eleven derived artifact classes are empty because the rejected payload never enters the auditable event ledger. The fixture contains no source payload, source field values, credential, or provider data.

### Processing-purpose coverage

The public purpose catalog is exercised without adding real data: fixture 25 uses `fraud_prevention`, fixture 33 uses `analytics` and `revenue_measurement`, and fixture 34 uses `analytics` and `attribution`. The server contexts deliberately demonstrate deployment overrides of the illustrative registry defaults. Raw and delivery goldens preserve the selected purpose and policy version.

## v0.3 fixture derivations

Fixtures 01 through 38 migrate the reviewed v0.2.1 scenarios to the v0.3 contract. Their per-file changes are recorded in `docs/contract-v0.3-migration.md`; the earlier v0.1-to-v0.2 derivations remain in `docs/contract-v0.2-migration.md`.

Each fixture contains the same 13 `expected_*.json` artifacts listed above. Empty arrays are deliberate reviewed outputs, not missing assertions.

| Fixture | Independent derivation of the meaningful golden result |
| --- | --- |
| `20-timestamp-invalid` | `2026-02-30T00:00:00.000Z` has the required lexical shape but no real UTC calendar instant. The delivery and rejection use `timestamp_invalid`, discard the payload, retain non-identifying metadata, and emit no raw, logical, attribution, metric, fraud, privacy, correction, or reconciliation result. |
| `21-reconciliation-window-mismatch` | A SHA-256 encoded, protected, one-to-one provider-install key joins to `install-21`, freshness is current, and the supplied window state is out of window. With key and candidate present, the first applicable neutral difference is `window_mismatch`. |
| `22-reconciliation-join-key-missing` | The reconciliation input has no typed matching key, candidate, or join. The deterministic neutral result is `join_key_missing`; no provider-quality conclusion is made. |
| `23-reconciliation-freshness-mismatch` | The SHA-256 encoded, protected one-to-one key joins to `install-23` and the window is in range, but freshness is `stale`. The remaining neutral difference is `freshness_mismatch`. |
| `24-attribution-supersession` | The original click and install yield paid last-click attribution. Redacting the click creates a tombstone and correction; the immutable replacement attribution names `supersedes_attribution_id=attr:install-24`, carries redacted click evidence, and is marked `finality=superseded`. |
| `25-replay-suspected` | The unique click remains an accepted delivery. Its synthetic replay marker separately produces one public `suspected/exclude/replay_suspected` fraud decision with protected categorical evidence; it is not classified as `duplicate_delivery`. |
| `26-retention-affected` | Before expiry, USD 2.000000 revenue is included in all three D0 series. Retention purges only the revenue evidence, produces a `retention_expiry` tombstone without a privacy request, and creates three replacement runs with value `0`, `retention_affected`, and explicit supersession links. |
| `27-ad-impression-revenue-link` | One install, one impression, and one USD 3.000000 revenue record share the synthetic impression ID. All three D0 outputs equal `3000000` at scale 6 and cite install, impression, and revenue evidence. |
| `28-imported-provider-attributed` | A synthetic provider reports an attributed install with confirmation evidence. The result is `non_organic/imported/provider_reported/provider_attributed`. Provider install and click references are independently checked as `SHA-256(JCS({provider,type,value}))`; only the protected digests reach reconciliation output. The normalized install is the sole same-scope candidate, and its non-first-party window is `not_applicable`, so reconciliation is `matched`. |
| `29-imported-provider-organic` | A synthetic provider reports the install as organic. The result is `organic/imported/provider_reported/provider_organic`; the provider install key produces `matched`. The same fixture accepts imported session context and an `sdk-ios` session, exercising both producer forms without altering attribution. |
| `30-imported-time-authority-unavailable` | A synthetic provider reports an attributed install but supplies no `provider_confirmed_at`. The result remains provider-reported non-organic and uses `provider_time_authority_unavailable`, rather than first-party `authoritative_time_missing`. Imported and `postback:synthetic-kind` revenue records exercise closed import context and the postback producer without a metric evaluation. |
| `31-imported-reconciliation-derived` | Both imported installs start with an empty fixture-authored `reconciliation_inputs` array. The modeled install has a provider install reference and deterministically yields `provider_modeled_conversion` plus `matched`; the provider-unattributed install has no provider install/click reference and yields `provider_unattributed` plus `join_key_missing`. An accepted `adapter:synthetic-network` click exercises the adapter producer independently. |
| `32-timestamp-stale` | `2026-07-31T23:59:59.999Z` is a real millisecond UTC instant but is one millisecond before `timestamp_stale_policy.before=2026-08-01T00:00:00.000Z`. The independently calculated policy digest is `c034a208b23264f380a2103e28d8f80375eae379ebabb805e1da9238876a05c3` for JCS `{authority:"server",before:"2026-08-01T00:00:00.000Z",policy_version:"retention-v0.2"}`. It is rejected as `timestamp_stale`; delivery and rejection retain that policy provenance, while the payload is discarded and no raw or logical evidence is emitted. Mutations prove equality is accepted, absence disables the policy, the old flat field is rejected, and a mismatched digest fails evaluation. |
| `33-stage-b-cohort-metrics` | Typed click/install dimensions and `ad_view` evidence are retained. Installation-level revenue joins one install, aggregate revenue does not. The later cost revision is current at the watermark. Per-event half-even FX produces the independently calculated D1/D3/D7 ROAS, D1/D7 retention, D7 cohort LTV, and cohort-size results described above. |
| `34-stage-c-apple-meta-attribution` | Fifteen accepted synthetic records yield fourteen same-scope attributions: the first-party click is evidence rather than an attribution subject. The attributions cover Meta last-click/view-through decrypted evidence with first-party precedence, four distinct Meta coverage/failure states, AdServices attributed/expired evidence, verified/invalid SKAdNetwork, and AdAttributionKit non-winner/source-suppressed/null-conversion branches. All 13 golden artifact classes were reviewed against the closed event/output schemas and TypeScript/Python parity. |
| `35-privacy-request-auth-scope` | A completed synthetic tenant-admin request purges one session record and yields one correction plus one tombstone. A separate received on-device request carries an opaque authentication-decision reference and targets only the installation ID in its own synthetic session record. Mutations prove that missing authentication provenance, unknown routes, app-wide on-device scope, and a different installation target fail closed in both evaluators. No credential or device identifier is stored in `requester_auth_ref`. |
| `36-child-directed-audience` | A synthetic child-directed app context accepts an ordinary session without any advertising identifier. Recursive schema mutations inject every reserved advertising-identifier field name into nested payload extensions and prove rejection; per-batch validation is exercised independently. The Apple Ads object field `ad_id` remains distinct from a device advertising identifier, while absent `audience` preserves the `general` default. |
| `37-undefined-organic-roas` | One synthetic no-referrer install is an organic cohort. No cost record is eligible at the metric watermark, so the ROAS denominator is absent. The run therefore preserves its ratio scale and evidence but omits `value_unscaled`, emitting `value_state=undefined` and `undefined_reason=no_attributed_cost`; zero and infinity are not substituted. |
| `38-provider-modeled-reconciliation` | One imported synthetic install is explicitly provider-attributed and modeled but carries no provider install or click reference. The evaluator derives no matching key or internal candidate and classifies the external row as `provider_modeled_conversion` at the v0.3 difference-reason version `0.3.0`, with empty candidate/join/window arrays. This is a neutral classification, not an unexplained or provider-quality claim. |
| `39-foreign-referrer-unresolved` | One accepted install has `referrer_status=third_party` and the normalized classification `foreign`. It cannot claim a first-party click or an organic marker, so it yields `unattributed/foreign_referrer_unresolved` with same-scope install evidence. |
| `40-custom-event-wrapper` | One accepted `custom_event` uses the synthetic key `level_complete`, four typed scalar attributes, optional USD money, `producer_variant=unity`, and a separate wrapper version. Its raw and logical outputs preserve the closed payload and wrapper provenance; no attribution or metric is inferred. Bounds and nested-value mutations fail schema validation. |
| `41-click-injection-suspected` | The redirector server time is `02:00:00.000Z` and the authoritative install time is `02:00:09.999Z`, so CTIT is 9.999 seconds. The 10-second fixture policy emits one public `suspected/flag/click_injection_suspected` decision while the valid paid attribution remains intact. The 10.000-second boundary does not emit the category. |
| `42-daily-metric-date` | One synthetic redirector click and one organic Android install occur on `2026-08-20` UTC. Human review fixes each daily `event_count` at one, with `metric_date` in both groupings and `attribution_status=organic` on the install series. The input snapshot is SHA-256 over the two ordered record rows, and each grouping digest is SHA-256 over its RFC 8785 canonical dimensions object. |
| `43-m4-ios-contract-handoffs` | Two iOS installs prove the platform-specific first-launch and neutral AdServices outcomes; one development-key AAK envelope and one SKAN 4.1 envelope prove the new optional/environment and minor-version surfaces. All values, identifiers, and signatures are synthetic. |
| `44-apple-aggregate-metrics` | Two qualified SKAN postbacks and one qualified AAK postback produce distinct receipt-date aggregate counts. Fine and coarse SKAN conversions remain separate scalar rows through the closed `apple_conversion_bucket` grouping. |
| `45-ios-conversion-schema` | One iOS install carries a synthetic bundled conversion-policy version and digest in `extensions`; one reserved custom event records an opt-in conversion-value update without changing attribution or metric meaning. |
| `46-integrity-verdict-reservation` | Three server-assigned synthetic integrity envelopes cover both supported platforms and every closed verdict while preserving platform-referrer attribution semantics. |
| `47-payload-schema-invalid` | One synthetic normalized runtime row fails the compiled event schema before ledger admission. It yields only a discarded delivery and non-identifying rejection; every raw, logical, and derived output remains empty. |
| `48-source-scoped-fraud` | One reviewed source-day has exactly 1,000 clicks, CVR 0.001 against median 0.01, CTIT p50 24 hours, and p95/p50 2. All four F-R-4 terms hold, so one `source`-scoped `click_flooding_suspected` decision names the aggregate snapshot and no individual record. |
| `49-fraud-excluded-attribution` | A synthetic server-classified prefetch click is excluded. Its same-click install keeps the original immutable attribution and adds one superseding `unattributed/fraud_excluded` result carrying the fraud-decision reference. Ingestion artifacts remain accepted and unchanged. |
| `50-gross-net-metrics` | The same excluded synthetic install is counted by the explicit gross daily definition and omitted by the explicit net daily definition. Both use the same snapshot and grouping digest; gross is 1 and net is 0. |
| `51-referrer-server-order` | The Play server click timestamp is exactly one second after the Play install-begin timestamp, so the threshold-free ordering rule emits a confirmed, flag-only `referrer_time_inconsistent` decision. No redirector timestamp is needed. |
| `52-bounded-edge-evidence` | One redirector click carries only the permitted server-assigned bounded evidence: saturated source rate, mobile-app-eligible client class, and a synthetic remote click reference. No IP, User-Agent, hash-derived identity, or device signal is stored. |
| `53-negative-ctit-clock-anomaly` | One negative-CTIT install emits the non-fraud `clear/allow` clock diagnostic. The day-wide ratio is 1/2, above the registered conservative 0.05 bound, so an independent valid Install Referrer attribution in another source cell on the same UTC day is superseded by a `provisional` result. TS and Python produce identical RFC 8785 bytes. |
| `54-deep-link-open-contract` | Four synthetic direct/deferred opens exercise active, unknown, inactive, and install-click-reused engagement outcomes. Daily deep-link metrics preserve campaign and attribution-status separation without changing installation attribution. |
| `55-purchase-refund-net-revenue` | One EUR 8 settled purchase and one D1 EUR 3.2 capped refund convert independently at 1.25 to reviewed D0/D1/D3/D7 net values of USD 10/6/6/6; pending/reversed rows are excluded, target-free and explicit target paths are exercised, and ad revenue stays USD 7. |
| `56-d30-d90-total-net-metrics` | D30 purchase net/total net/ROAS/LTV are USD 8/USD 9/0.9/USD 9; D90 values are USD 30/USD 37/3.7/USD 37. D31 is excluded only from D30 and exact D91 is excluded from D90. |

## WO-20 non-fraud rule-bundle provenance review

WO-20 replaces the undocumented placeholder hashes on attribution, Apple postback, and metric artifacts with SHA-256 digests of RFC 8785 canonical rule-bundle definitions. A structural comparison against the pre-WO-20 fixture tree found 335 changed fields in 110 JSON files. Every changed path ends in `rule_bundle_hash`; no metric value, attribution decision, identifier, timestamp, grouping, or other artifact field changed.

| Rule bundle | Version | Reviewed SHA-256 digest | Changed fields |
| --- | --- | --- | ---: |
| `attribution-default` | `0.3.0` | `2a6acdf35b3c649dc1e56d14cbc7436065118e4bb0ed1e7bd7b4604e834dce50` | 65 |
| `apple-postback-default` | `0.3.0` | `91181289d7e6604c8a73b7e83d6950334db9bc1067b78ab25216ecaa24bcb896` | 10 |
| `metric-default` | `0.3.0` | `f765891ef3ac0337da9811cfb00f3883e3eece5a0ef3ec4ac23a6b2d0a24e443` | 193 |
| `metric-stage-b` | `0.3.0` | `f2a282f9b089d2da4505954e871ab48c162a81aa497ccf0aaf811a9e50091499` | 25 |
| `metric-stage-m3` | `0.3.1` | `7239025186e4e679b4ab044aa34b02e4df52b3698641ef1e47f4d49f918e902f` | 6 |
| `metric-purchase-net` | `0.4.8` | `01b66078d11af8ace103a5d2cf594ffe79c19bd59a4dc1f20757339a8a7f4f5f` | 12 |
| `metric-purchase-net` | `0.4.9` | `709f6688c7bb8537b7af3aa3b5a3aa879036a866fe13a21b83244baec6389712` | 6 |
| `metric-total-net` | `0.4.9` | `fc95798477e664215aa213ab59402b5ad348db3d59c1b886d713ab11490b8fd3` | 18 |

The reviewed field locations are 75 in `expected_attributions.json`, 190 in `expected_metric_definitions.json`, 48 in `expected_metric_runs.json`, and 22 in `input.json`. The inputs changed only where they embed expected definition or run artifacts for parity assertions.

## Adding a fixture

`fixtures/.candidates/` is a gitignored working area for proposed synthetic inputs. It is outside `fixtures/v0.4/` and is not discovered by `npm run validate`.

1. Create `fixtures/.candidates/<NN-name>/input.json`. Use only synthetic data and keep the proposed number and name stable during review.
2. Run `evaluate()` from `tools/evaluator.ts` manually and run `python tools/python_evaluator.py fixtures/.candidates/<NN-name>/input.json` independently. Save neither command's output as an approved golden automatically.
3. Compare the two outputs, review every field by hand against the schemas and contract, and record the derivation of each meaningful expected value in the pull-request description. Resolve any disagreement before promotion.
4. Promote the reviewed input to `fixtures/v0.4/<NN-name>/`, hand-create the 13 `expected_*.json` output files, and update the named scenario assertions and inventory checks in `tools/validate.ts`. Run `npm run validate` before requesting review.

Golden changes must be reviewed in a commit separate from evaluator or schema behavior changes. The validation command remains read-only and must never promote a candidate or regenerate an expected file.
