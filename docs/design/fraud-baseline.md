# Fraud Detection Design Baseline

Status: **Decided (R-32, 2026-08-21).** All recommendations in this baseline are adopted; WO-14 implements the fixed design rather than redesigning it.

Repository location when adopted: `docs/design/fraud-baseline.md`.

Baseline: contract `0.4.0`; `main` at `ad22525` (PR #29 merged) includes M0.4 and M1a through M5. Working tree clean. `npm run validate` on this commit prints: `Validated 27 schemas, 8 registries, 47 reviewed fixtures, 611 golden output artifacts, 47 scenario assertions, 26 acceptance criteria, deterministic TypeScript, independent Python, and RFC 8785 conformance.` This document was written on 2026-08-21 against that commit.

Decision numbering is `F-D-01 … F-D-30` and is identical in this document and in `fraud-baseline-decisions.ja.md`. References of the form `M1 D-06` point at `docs/design/m1-baseline.md`; `M2-D-09` at `docs/design/m2-baseline.md`; `M4-D-19` at `docs/design/m4-baseline.md`.

Acceptance criteria are numbered `F-A-nn` (code gates) and `F-V-n` (operator procedures).

---

## Scope

### Who this is for

The requirement did not come from the roadmap. It came from an operator running hypercasual and hybrid-casual user acquisition, in these words: *ad fraud is severe enough that detection and response must be part of the plan.* That is the design's actual client, and it changes what "good" means here. A hypercasual UA buyer is not defending a brand budget against sophisticated invalid traffic on premium inventory. They are buying millions of cheap installs across long tails of sub-publishers, where the two things that actually happen are (i) somebody claims credit for organic installs, and (ii) somebody manufactures installs. Both destroy the same number — cohort ROAS by source — and that number is the only one this project has ever claimed to produce well.

So the goal of this milestone is not "catch fraud". It is: **make the ROAS-by-source number defensible, and produce evidence an operator can put in front of a network.**

### The honest headline, stated before the scope list

**OpenMasu can prove that a click and an install are temporally impossible. It cannot prove that a device is real, and it will not try to recognise devices.**

Every commercial MMP's fraud product rests on three pillars: server-time analysis, network-origin intelligence (data-centre IP lists, proxy/VPN classification, IP reputation), and device-level recognition (fingerprints, device graphs, cross-advertiser history). `docs/privacy-security.md` forbids the third outright — "Do not derive a device fingerprint from IP address, User-Agent, device configuration, network data, or similar signals" — and §F-P-3 below rejects the second. That leaves the first, plus platform attestation, plus behaviour.

That is a smaller product than AppsFlyer Protect360 or Adjust Fraud Prevention Suite. It is also, for the specific attacks that hurt a hypercasual buyer most, *not much smaller* — because the strongest click-injection signal in existence on Android is two timestamps written by Google's own servers, and we already collect both. The capability difference is concentrated in install-farm and emulator-farm detection, and §F-D-07 publishes exactly where.

There is a fourth pillar commercial MMPs have that no amount of engineering gives a self-hosted deployment: **an MMP sees many advertisers, and a self-hosted deployment sees one.** A network's fraudulent sub-publisher is visible across a hundred advertisers to an MMP and looks like noise inside one app. That is structural, it is not a policy choice, and stating it is the honest thing to do (§F-D-02).

### What "usable" means for this milestone

After it, an operator can:

1. see a per-source daily table of clicks, installs, CTIT distribution, CVR, and D1/D7 retention, and identify the sub-publisher that is claiming organic installs;
2. have every install whose Play referrer is temporally impossible marked, with a reproducible decision that names the rule bundle and the two timestamps that proved it;
3. choose, per rule, whether a detection *flags*, *quarantines*, or *excludes*, and see both the gross and the net number side by side rather than one silently adjusted number;
4. export a chargeback evidence report keyed on the network's own click references, containing no user data and no OpenMasu-internal identifiers;
5. optionally attach Play Integrity and App Attest verdicts as evidence, in observation mode, without any verdict ever being the sole cause of an exclusion.

### In scope

- A pure rule package `packages/fraud-rules` with deterministic, replayable detection rules over server-authoritative evidence.
- Real rule-bundle binding for fraud decisions (§F-D-26).
- Edge evidence the redirector currently discards: `network`, `site_id`, `remote_click_ref`, a prefetch bit, and a bounded source rate class (§F-D-06).
- Aggregate-scope fraud decisions for click flooding (§F-D-13).
- `exclude` and `quarantine` actions that actually act, at both the attribution and metric layers (§F-D-22, §F-D-24).
- A fraud audit read API, a CSV export, and a dashboard panel.
- Live Play Integrity and App Attest server verification, producing the `integrity_verdict` that contract v0.3.5 reserved and no runtime code has ever produced (§F-D-18, §F-D-19).
- Additive contract patches v0.4.1 … v0.4.5 under R-27, followed by the v0.4.6 WO-14R clock-diagnostic correction.
- `docs/validation/m6-fraud-checklist.md`.

### Explicitly out of scope

- **Device fingerprinting, probabilistic matching, deferred-deep-link matching, pasteboard matching.** Not deferred — excluded, and the same source-audit machinery that enforces it on `sdk/ios` (M4-D-10) is extended to enforce it on the server (§F-D-08).
- **Third-party IP, proxy, VPN, data-centre, or device-reputation feeds** (§F-D-07). This includes the TAG Data Center IP List and every commercial equivalent.
- **Machine-learned fraud scoring** (§F-D-03).
- **Fraud detection on the Apple aggregate series** (§F-D-17). A verified SKAdNetwork postback proves Apple sent it, not that the install was genuine, and the series carries no installation identity to attach a decision to.
- **Incentivized-traffic detection** (§F-D-16). It is not derivable from first-party evidence without engagement modelling, and the honest handle is the retention report that already exists.
- **Automatic chargeback submission.** The report is a deliverable; the negotiation is the operator's.
- **Blocking at the redirector.** The redirector already rate-limits (M2-S-5). Making it a fraud gate would put a detection decision on the user's critical path to the Play Store, which §F-D-22 rejects.

### M6a / M6b split (F-D-01)

- **M6a — deterministic first-party rules.** The rule package, edge evidence, actions, reporting, contract patches, default bundle. Every acceptance criterion is synthetic and **all of it runs on the existing Linux `runtime.yml` job.** No external account, no credential, no device.
- **M6b — platform integrity.** Play Integrity and App Attest server verification. Needs a Google Cloud project with the Play Integrity API enabled, a Play Console app, an Apple App ID with App Attest capability, and real devices to produce a token at all.

M6a depends on nothing in M6b. M6b's *rules* depend on M6a's engine. So **M6a is built and merged first**, for the same reason M4b preceded M4a: the half that needs no external setup delivers standalone operator value and keeps the toolchain off the critical path. An operator who never enables integrity still gets the injection and flooding rules, which are the ones that pay for the milestone.

### Prerequisite state — what already exists, and what is a placeholder

This matters more here than in any previous milestone, because the contract already contains a fraud vocabulary that **almost nothing produces**. Read at `ad22525`:

| Thing | State |
| --- | --- |
| `schemas/fraud-decision.schema.json` | Complete: `decision ∈ {clear, suspected, confirmed}`, `action ∈ {allow, flag, exclude, quarantine}`, evidence array with type/captured_at/digest/access_class, rule-bundle triple, `supersedes_fraud_decision_id`. |
| `registries/reason-codes-v0.4.json` → `fraud_public_categories` | Three values: `bot_prefetch`, `replay_suspected`, `click_injection_suspected`. |
| `ledger.fraud_decisions` | Exists, append-only, RLS-forced, persisted by `apps/worker/src/ingestion.ts` `persistFraud`. |
| `control.rule_bundle_revisions` + `rule_bundles_current` | Exists with single-root/single-successor unique indexes and an activation route `POST /v1/admin/apps/:app/rule-bundles`. |
| `evaluator.ts` fraud path | Produces `bot_prefetch`/`replay_suspected` **only from booleans a client or importer set on the click payload**, and `click_injection_suspected` from CTIT. |
| `common.schema.json#/$defs/integrityVerdict` | Complete and closed. **No runtime code produces one.** Fixture 46 is the only exercise. |
| `processing_purposes` | `fraud_prevention` is registered, `default_consent_required: false`, legitimate interests. |

Against that, seven defects and gaps were found by reading the shipped code. Each is a premise of this design and each is verifiable in one command.

**G-1 — the runtime's click-injection threshold is a dead field.** `apps/worker/src/sdk-worker.ts:44` sets `click_injection_threshold_ms: 2_000` on the server context. `packages/attribution-core/src/evaluator.ts:1399` reads `attempt.server.click_injection_policy?.threshold_seconds ?? 10`, and `tools/python_evaluator.py:1434` reads the same path. **The name does not match, so the runtime's intended 2-second threshold is never applied and every deployment silently runs the 10-second demonstration default.** `grep -rn "click_injection_threshold_ms" --include=*.ts .` returns exactly one hit, the write.

**G-2 — the click-injection policy digest is decorative.** `decide()` verifies `timestamp_stale_policy.policy_digest` against `sha256({before, authority, policy_version})` and throws if it disagrees. There is no equivalent check for `click_injection_policy.policy_digest`. Fixture 41 carries `"3333…3"`. A deployment can therefore record a policy digest that has nothing to do with the threshold it actually used, which defeats the entire point of recording it.

**G-3 — every decision claims rule-bundle hash zero.** `evaluator.ts:26` is `const HASH = "0".repeat(64)`, used for `attribution-default`, `apple-postback-default`, `metric-default`, and `fraud-public-envelope`. The committed golden `fixtures/v0.4/41-click-injection-suspected/expected_fraud_decisions.json` contains `"rule_bundle_hash": "0000000000000000000000000000000000000000000000000000000000000000"`. `control.rule_bundle_revisions` exists and enforces a real digest pattern, but **nothing connects a persisted decision to a registered revision.** "Past decisions are reproducible" is currently a claim about a placeholder.

**G-4 — `referrer_click_at_server` is collected and never read.** `sdk/android/installreferrer/.../GooglePlayReferrerReader.kt` calls `value.referrerClickTimestampServerSeconds` and `EventFactory.kt:31` puts it on the install payload. `grep -rn "referrer_click_at_server" --include=*.ts .` returns **no evaluator or runtime hit**. The single most decisive click-injection signal available on Android is being stored and ignored (§F-D-10).

**G-5 — the redirector discards the source dimension.** `docs/design/m2-baseline.md:404` states that the `click` artifact carries "`network`, `country`, `site_id` from the link row". `apps/redirector/src/handler.ts` `persistClick` writes `click_id`, `tracking_link_id`, `redirector_click_at`, `redirector_time_status`, and optionally `campaign_id`, `ad_group_id`, `creative_id` — **and nothing else**. `control.tracking_links.site_id` exists (`db/schema.sql:835`); `site_id` appears nowhere else in the schema. Sub-publisher-level detection — which is where hypercasual fraud lives — has no data today. This is the same documented-vs-shipped drift M4 found for `control.sdk_keys.platform`.

**G-6 — `bot_prefetch` and `replay_suspected` have no runtime producer.** Both are booleans on the click payload. The only writers are fixtures and `apps/worker/src/import/adapters.ts` (which writes `false`). The redirector never sets them, and a `nonce_reused` authentication failure produces a `ledger.audit_logs` row (`apps/api/src/sdk-routes.ts` `auditFailure`) that nothing reads.

**G-7 — `exclude` and `quarantine` have no consumer.** `metric-definition.schema.json` has `event_names` and `grouping_dimensions` and no fraud filter. `metric-run.schema.json` has `reproducibility_status ∈ {fully_reproducible, redaction_affected, retention_affected}` and no fraud state. `attribution-result.schema.json` has no reference to a fraud decision. There is no `/v1/audit/fraud` route and no dashboard panel. **A fraud decision with `action: "exclude"` today changes exactly one thing: a row in a table nobody reads.**

None of these blocks starting. All seven are named as work in §WO-14.

---

## Principles

These come before the rules because every rule below is a consequence of one of them, and because a rule set without a stated principle drifts into fingerprinting one convenient field at a time.

### F-P-1 (F-D-03). Every rule is a pure, deterministic function of recorded evidence

No model weights, no online learning, no scoring. A rule is a total function from `(evidence, thresholds)` to `(decision, action, reason, evidence refs)`, evaluated by the same pure package on the server and in the fixtures, in TypeScript and in Python, byte-identical after JCS.

**Options considered:** (a) rules only; (b) rules plus an anomaly model over aggregate features; (c) a scoring model.

**Recommendation: (a).** The argument is not that machine learning cannot find fraud — it can, and commercial MMPs use it well. The argument is that this project's entire value proposition is `docs/product-scope.md`'s "retaining enough evidence to audit the SDK, server, attribution rules, and reported totals." A score is unauditable by construction: an operator cannot take "0.87" to a network, and cannot reproduce it in eighteen months when the dispute is settled. Worse, a model trained on a deployment's own data is a *private* artifact that cannot be published, which would move the project's core decision logic behind the open-core boundary that `docs/privacy-security.md` deliberately draws around thresholds and watchlists only.

(b) is the tempting middle. It is rejected for a narrower reason: the aggregate rules in §F-D-13 already need a distribution, and a *stated percentile rule over a stated window* is an anomaly detector that a human can read. Add the model only if a stated rule provably cannot express what the operator needs, and record that as evidence, not as an assumption.

### F-P-2 (F-D-04). A signal is evidence only if the attacker does not control it

This is the principle that does the most work, and it is a generalisation of M4-D-09's argument for server-side AdServices lookup: "under (a) the attribution input is a device claim… that is the difference between evidence and an assertion, and it is the difference this whole project exists to insist on."

Applied to fraud:

| Signal | Controlled by | Verdict |
| --- | --- | --- |
| `redirector_click_at` | our server | evidence |
| `install_begin_at_server`, `referrer_click_at_server` | Google's servers | evidence |
| Play Integrity / App Attest verdict | Google / Apple, cryptographically bound | evidence |
| Apple postback signature | Apple | evidence |
| our own edge observation of a request | our server | evidence |
| `occurred_at`, `referrer_click_at_device`, `install_begin_at_device` | the device | diagnostic only |
| `Build.FINGERPRINT`, sensor presence, root checks, emulator heuristics read by the SDK | the attacker | **not evidence** |
| a `bot_prefetch` boolean asserted by a client | the attacker | **not evidence** — this is G-6 |

The last row is the uncomfortable one, because the contract already lets a client set `bot_prefetch`. §F-D-06 fixes it by making the redirector the only producer.

The row before it is why §F-D-21 refuses on-device emulator heuristics even though they would be cheap. An emulator check that runs inside the attacker's process is worth nothing, and a *fraud rule that is worth nothing is worse than no rule*, because it produces confident-looking decisions.

### F-P-3 (F-D-06). Edge signals may leave the edge only as a bounded classification

The precise line, proposed as replacement text for `docs/privacy-security.md`:

> Source IP address, User-Agent, and request headers may be observed at the redirector for the `fraud_prevention` purpose. They may leave the redirector process only as a **bounded classification of at most four values**, carrying no key and no digest, from which neither the input nor the identity of any other request sharing the classification can be recovered. The raw values are never written to the application database, the payload store, application logs, a hash, a salted hash, a truncation, or any derived identifier. No classification may be used to link two requests, two installations, or two devices.

Three classifications are permitted and no others:

1. **`source_rate_class ∈ {normal, elevated, saturated}`** — derived from the token bucket the redirector *already runs*. `apps/api/src/rate-limit.ts` `KeyedTokenBucket` keys on the raw remote address, holds at most 10,000 keys with a 15-minute idle TTL, and never persists a key. The proposal adds **no new input and no new storage**: it exposes the bucket's remaining fill at the moment of the request as an ordinal, where `saturated` is exactly today's 429 case.
2. **`prefetch_signal: boolean`** — set when the request carries a declared prefetch/preview intent header (`Sec-Purpose`, `Purpose`, `X-Purpose`, `X-Moz`). These headers declare the *request's intent*; they are not device characteristics, and reading them is closer to reading the HTTP method than to reading a device attribute.
3. **`client_class ∈ {mobile_app_eligible, bot, other}`** — one classification of the User-Agent against a **checked-in, public, fixed token list**. The redirector already does exactly this shape of thing: `handler.ts:98` tests `/Android/i` against the UA to decide the destination. The proposal makes the existing read produce evidence instead of only a branch.

**Why this is not fingerprinting, stated precisely.** A device fingerprint is a value that *recognises* a device across requests. All three outputs are low-cardinality classes with no key: two requests that both report `elevated` cannot be linked to each other, and neither can be traced back to an address. `client_class` distinguishes "a thing that looks like a browser or app" from "a thing that announces itself as a crawler" — one bit of a self-declared string.

**The residual, stated rather than implied.** `source_rate_class` is a function of *other requests*, so it leaks the aggregate existence of co-located traffic. It cannot say which requests, or how many, or from where. That is the cost, and §F-D-06 records it rather than pretending the classification is information-free.

**What this buys.** `bot_prefetch` gets a real producer for the first time since contract v0.2 — a link preview fetched by a messaging app currently produces a fully-formed click record indistinguishable from a human one, and in a hypercasual campaign run through chat channels that is not a rare case.

### F-P-4 (F-D-07). No third-party intelligence, and the gap is published

Data-centre IP lists, proxy/VPN classification, IP reputation, device graphs, and cross-advertiser fraud histories are all rejected. Two independent reasons, and the second is the decisive one:

1. Every such feed requires sending the deployment's traffic characteristics to a third party, or ingesting a list under a licence that a self-hosted Apache-2.0 project cannot redistribute.
2. **A classification produced by a party outside the deployment cannot be reproduced later.** A decision that says "excluded because IP 203.0.113.7 was in the data-centre list on 2026-09-14" is not replayable unless the list is versioned, retained, and published — at which point it is a watchlist, which `docs/privacy-security.md` already places on the private side of the open-core boundary. The project would then be shipping decisions nobody outside the deployment can audit, in the one subsystem where auditability is the product.

The honest consequence, which §F-D-07 publishes as a table in `docs/privacy-security.md`:

| Attack | Commercial MMP handle | OpenMasu handle |
| --- | --- | --- |
| Click injection (Android) | CTIT distribution + device signals | **Equal or better**: two Google server clocks, one threshold-free ordering rule (§F-D-10) |
| Click spam / flooding | CTIT distribution + IP clustering + cross-advertiser view | **Partial**: per-source CVR/CTIT/retention distribution; no IP clustering, no cross-advertiser view |
| Organic poaching | same as flooding | **Partial**, same |
| SDK spoofing | SDK signature + device attestation + traffic modelling | **Partial**: HMAC + nonce + permanent event-ID uniqueness + optional attestation; no traffic modelling |
| Emulator farms | device fingerprint + emulator heuristics + IP intelligence | **Attestation only** (`MEETS_VIRTUAL_INTEGRITY` class of verdict, M6b). No detection at all if the operator does not enable integrity. |
| Physical device farms | device graph + behavioural modelling + IP intelligence | **None.** Stated plainly. |
| Device-reset / reinstall fraud | fingerprint persistence across resets | **None, by design.** `installation_id` is resettable and never joined to a device identifier; that is a privacy promise, and detecting resets would break it. |
| Incentivized traffic | engagement modelling, publisher lists | **None** (§F-D-16); retention-by-source is the only honest diagnostic |
| Duplicate / replay | dedup + nonce | **Equal**: permanent `(tenant, app, producer, event_id)` uniqueness (M1 D-06) plus the nonce window (M2-S-3) |
| Bot / prefetch clicks | UA + behavioural | **Equal for declared prefetch**; weaker for undeclared bots |

Publishing that table is §F-D-07's actual recommendation, and it is an owner decision because it is a public statement about the product's limits.

### F-P-5. A measurement system must not change its own numbers by default

Every shipped rule defaults to `action: flag`. Nothing is excluded until the operator says so, per rule, in a bundle revision that is recorded with an actor and an activation time. This is not timidity: a fraud rule that silently removes 8% of installs from a deployment's ROAS on day one, before the operator has seen the CTIT distribution of their own traffic, produces a support incident and a permanently distrusted system. §F-D-29.

---

## Threat taxonomy and evidence mapping (F-D-05)

Eight types, each with the evidence OpenMasu holds, the rule that acts on it, and — the part usually omitted — what it cannot see.

### T-1. Click injection (Android)

**Mechanism.** An application on the device observes that an install is beginning — historically via the deprecated `INSTALL_REFERRER` broadcast, currently via `ACTION_PACKAGE_ADDED`-class broadcasts or Play Store activity — and fires a click on a tracking link so that the referrer recorded against the install is the fraudster's. The install was already going to happen; the click contributes nothing. It is the single most profitable Android attack because it converts at nearly 100%.

**Evidence held.** Four timestamps, two of them from Google's servers: `referrer_click_at_server`, `install_begin_at_server`, plus device copies and our own `redirector_click_at`. All four are already collected (`GooglePlayReferrerReader.kt`); one server one is unread (G-4).

**Rules.** §F-D-10 (ordering, threshold-free), §F-D-11 (CTIT lower bound), §F-D-12 (referrer/redirector agreement).

**Cannot see.** Injection that fires the click *before* the install begins by more than the CTIT threshold — i.e. a patient injector that predicts installs. That attack is much harder and much less profitable, and no timestamp rule catches it.

### T-2. Click spam / click flooding

**Mechanism.** Enormous volumes of clicks are reported for users who never saw an ad, so that organic installs falling inside the attribution window are claimed. Distinguished from injection by *volume and patience* rather than timing precision.

**Evidence held.** Click counts per tracking link and campaign. **Not** per sub-publisher — that is G-5.

**Rules.** §F-D-13, aggregate scope, over (campaign × network × site × day): click volume, CVR, CTIT distribution shape, and D1 retention of the resulting cohort.

**Cannot see.** Which individual install was stolen. Flooding is only visible in a distribution, which is why the decision must carry an aggregate subject and must not be attached to individual installs (§F-D-13).

### T-3. SDK spoofing / fabricated installs and events

**Mechanism.** The attacker extracts the app-level SDK key from the APK or IPA, enrols installations, and delivers manufactured installs, sessions, and purchases.

**Evidence held.** M2-S-1's HMAC over the raw body, the timestamp window, the nonce table (`ephemeral.request_nonces`), the permanent `(tenant, app, producer, event_id)` uniqueness constraint, and per-installation credentials. `docs/threat-model.md` already states the limit in bold: **M2 does not prevent an attacker who possesses the APK from enrolling installations and delivering fabricated installs or events.**

**Rules.** §F-D-14 (replay and enrolment-rate rules from existing audit rows), §F-D-18/§F-D-19 (attestation), and — the honest core — the fact that fabricated installs are anchored, counted, and visible in the same per-source reports as real ones, so §F-D-13's retention rule catches the ones that do not behave.

**Cannot see.** A patient attacker who enrols slowly, produces plausible sessions, and does not replay. Attestation is the only real answer and it is optional.

### T-4. Install farms, emulator farms, device farms

**Mechanism.** Real or emulated devices install repeatedly, often behind data-centre or residential-proxy networks.

**Evidence held.** Nothing, until Play Integrity or App Attest is enabled. Then: a platform-signed statement about the device's integrity class, including — per Google's documented verdict vocabulary, which §F-D-18 requires WO-14 stage 0 to re-verify — a distinct verdict for virtual/emulated environments.

**Rules.** §F-D-18 combined with at least one other signal, never alone (§F-D-20).

**Cannot see.** Physical device farms with genuine devices, genuine Play accounts, and residential connectivity. `MEETS_DEVICE_INTEGRITY` will be true for all of them. This is the largest single capability gap and §F-D-07 says so.

### T-5. Incentivized-traffic abuse

**Mechanism.** Users are paid to install and perform the tracked event. Contractually a network problem, not a technical one, but it shows up as installs with normal timing, real devices, and collapsed retention.

**Rules.** None (§F-D-16). The diagnostic is D1/D7 retention and cohort LTV by source, which M1b already computes.

### T-6. Duplicate delivery and replay

**Mechanism.** Retried deliveries (normal), and captured batches replayed later (attack).

**Evidence held.** The permanent uniqueness constraint distinguishes `duplicate_delivery` (same payload) from `event_id_conflict` (different payload under the same event ID) — the latter is a strong tamper signal, currently a rejection that produces no fraud decision. The nonce table rejects a replayed HMAC request with `nonce_reused`, recorded in `ledger.audit_logs`.

**Rules.** §F-D-14 gives `replay_suspected` its first real producer by aggregating existing audit rows.

### T-7. CTIT anomalies as a class

Separate from T-1 because the *distribution*, not the individual value, is the signal, and because it is the diagnostic that tells an operator whether their own clocks are sane (§F-D-11).

### T-8. Organic poaching

Not a separate mechanism. It is T-2 aimed at a specific victim: the app's own organic installs. Same rule, same evidence, and it is called out separately only because it is the one an operator notices first (organic share falls when a campaign starts) and the one they most want a number for. §F-D-13 emits that number as `organic_share_by_day` beside the per-source table.

---

## Rule design

Each rule is specified as: inputs (all server-authoritative), predicate, decision, action, evidence, and the failure mode of the rule itself. The last item is not decoration — §F-D-11 exists because the obvious CTIT rule silently inverts when our own clock drifts.

### F-R-1 / F-D-10. Referrer ordering — the decisive click-injection proof

**Inputs.** `install.referrer_click_at_server`, `install.install_begin_at_server`. Both come from the Play Install Referrer response; both are stamped by *the same party's* clock.

**Predicate.** `referrer_click_at_server > install_begin_at_server + 1 s`.

**Why this is the strongest rule in the document.** For a genuine referrer-driven install the causal order is: click → Play Store → install begins. The referrer click therefore cannot be later than the install beginning. Injection inverts it, because the injected referrer is delivered to Play *after* the install has already started. And crucially:

- it needs **no threshold** — it is an ordering, not a magnitude;
- it compares **two timestamps from one clock**, so skew between Google and us is irrelevant, unlike every CTIT rule;
- it does not depend on our redirector's clock at all, so it stays valid when our NTP is broken — which is exactly when the CTIT rule is producing garbage.

**Decision / action.** `decision: confirmed`, default `action: flag` (per F-P-5), reason `referrer_time_inconsistent`. This is the one rule where `confirmed` is defensible, because nothing was estimated.

**The 1-second guard is not cosmetic.** `GooglePlayReferrerReader.kt` converts both values with `Instant.ofEpochSecond(...)`: the Play Install Referrer bundle carries **seconds**, not milliseconds. Equal seconds is the common case for a fast install and must never fire. The predicate therefore requires a strictly greater value by at least one full second.

**Verified premise and remaining empirical gate.** Google's primary Install Referrer response-bundle documentation was re-read on 2026-08-21. It defines `referrer_click_timestamp_server_seconds` as the server-side time when the referrer click happened and `install_begin_timestamp_server_seconds` as the server-side time when app installation began. Those event meanings confirm the temporal invariant on a single server clock; seconds precision also explains why equal values are valid. **F-V-1 still requires the operator to observe the empirical sign distribution on real traffic before the rule may be promoted above `flag`.** If genuine traffic contradicts the documented ordering in practice, the rule degrades to a diagnostic and nothing is corrupted, because it never acted.

**Acceptance:** F-A-03, F-A-04; F-V-1.

### F-R-2 / F-D-11. CTIT, two-sided, with a clock-validity guard

**Inputs.** `install.install_begin_at_server` (Google's clock), `click.redirector_click_at` (our clock).

**Predicates.**
- *Lower bound:* `0 ≤ CTIT < threshold_low` → `click_injection_suspected`. This is the existing rule; the default stays 10 s.
- *Upper bound:* CTIT is bounded by the 7-day attribution window already. A long CTIT is not per-install evidence; it feeds §F-D-13's distribution instead. **No per-install upper-bound rule is proposed**, because a genuine install four days after a click is ordinary in a retargeting-free hypercasual funnel and flagging it would produce false positives at scale.
- *Clock guard:* `CTIT < 0` → **not fraud.** It is `ctit_clock_anomaly`, a diagnostic with `decision: clear, action: allow`, and if its rate over a day exceeds a bound the deployment's own clock is wrong and **every CTIT-derived decision that day is marked `provisional` rather than `final`.**

The implemented day rate is app-wide for the UTC click day: `sum(ctit_negative_count) / sum(installs)` across source cells, with zero installs producing no guard. This prevents a healthy source cell from retaining false finality while another cell proves the shared redirector clock unreliable.

**Why the guard is the important half.** The current code returns `[]` for `delta < 0` — it silently drops the case. But a persistent negative CTIT means our redirector's clock is ahead of Google's, which means *every* CTIT is understated, which means the injection rule is over-firing on genuine installs. The rule that detects fraud and the rule that detects the rule being broken are the same measurement, and the design must record both. This is the single most likely way a fraud deployment produces confidently wrong numbers.

**Also fixed here:** G-1 (the `click_injection_threshold_ms` dead field — the runtime must construct a real `click_injection_policy`) and G-2 (the policy digest must be verified against `sha256({threshold_seconds, authority, policy_version})` exactly as `timestamp_stale_policy` is, in `decide()`).

**Distribution reporting.** Per (app × network × site × day): CTIT p05, p25, p50, p75, p95, count, and the negative-CTIT count. This is what the operator reads before choosing a threshold, and it is what makes §F-D-29's "ship observing, not acting" default workable rather than useless.

**Acceptance:** F-A-01, F-A-02, F-A-05.

### F-R-3 / F-D-12. Referrer / redirector agreement

**Inputs.** `install.referrer_click_at_server`, `click.redirector_click_at`.

**Predicate.** `|referrer_click_at_server − redirector_click_at| > threshold_agreement` (default 300 s).

**What it catches.** Our redirect and Google's receipt of the referrer are two observations of one event separated by a browser redirect — seconds, not minutes. A large gap means the referrer string carrying our `click_id` was **constructed or replayed** rather than produced by a live redirect: click-ID harvesting, where an attacker collects valid `click_id` values and stuffs them into referrers for unrelated installs. Neither §F-R-1 nor §F-R-2 catches that, because a harvested click ID can be paired with a perfectly ordinary CTIT.

**Decision / action.** `suspected` / `flag`, reason `referrer_time_inconsistent` (shared with F-R-1 — the public category describes the class, not the rule).

**Failure mode.** This rule *does* depend on both clocks, so it inherits the skew problem F-R-2's guard measures. The default is deliberately loose (5 minutes) so that ordinary skew never fires it, and the rule is documented as a coarse instrument for a coarse attack.

### F-R-4 / F-D-13. Click flooding, at aggregate scope

**Inputs.** Per (tenant, app, campaign_id, network, site_id, UTC day): click count, install count, CVR, CTIT percentiles, and the D1 retention of the installs attributed to that cell.

**Predicate.** A conjunction, not a disjunction — every term must hold, because any one alone has ordinary explanations:
1. click volume ≥ `min_volume` (default 1,000/day — below this the statistics are noise);
2. CVR ≤ `cvr_floor` × (the app's own all-source median CVR for that day), default 0.2;
3. CTIT p50 ≥ `ctit_median_floor` (default 24 h) — flooding produces long, flat CTIT because the click bears no causal relation to the install;
4. the cell's CTIT distribution is closer to uniform than to the app's own decay shape, expressed as `p95/p50 ≤ uniformity_bound` (default 3.0).

Comparing the cell to **the app's own median for the same day** rather than to a fixed constant is what makes the rule portable across a hypercasual title with a 3% CVR and a hybrid title with 0.4%, and it makes the rule self-calibrating as the app's own traffic changes.

**Decision / action.** `suspected` / `flag`, reason `click_flooding_suspected`, **subject scope `source`**, `subject_ref` = `source:<campaign_id>:<network>:<site_id>:<date>`.

**The subject scope is the contract change this rule needs.** `fraud-decision.schema.json` has no `subject_scope`, so a decision about a sub-publisher-day is structurally indistinguishable from a decision about one install. That is exactly the mistake M4-D-19 spent a section preventing between the aggregate and deterministic attribution series, and the fix is the same shape: a closed `subject_scope ∈ {record, source}` selecting the `subject_ref` namespace, enforced by schema. §F-D-28 patch v0.4.1.

**Prerequisite.** G-5. Without `site_id` and `network` on the click record, this rule can only operate at campaign granularity, which is the granularity at which a network will tell you the problem is one of their sub-publishers and you cannot say which.

**Acceptance:** F-A-06, F-A-07.

### F-R-5 / F-D-14. Replay and enrolment anomalies from evidence that already exists

Three predicates, all over `ledger.audit_logs` and `ledger.rejections` rows the runtime already writes:

1. `nonce_reused` failures for one `actor_ref` exceeding `replay_rate_bound` in a window → `replay_suspected`, subject scope `record`, subject = the installation credential's opaque reference.
2. `event_id_conflict` rejections (the same event ID with a *different* payload) exceeding `conflict_bound` for one installation → `replay_suspected`. A retry produces `duplicate_delivery`; a conflict means the payload changed under a fixed identity, which a correct client cannot do.
3. Enrolment count for one `sdk_key_id` exceeding `enrolment_rate_bound` per hour → `suspected` / `flag`, subject scope `source`, subject = `source:sdk_key:<key_id>:<hour>`. M2's enrolment bucket already returns 429 on this; the rule turns a transport-layer refusal into recorded evidence.

**Why this is nearly free.** No new capture, no new field on any event, no device involvement. It is a query over rows the API already writes on the failure path. It also closes G-6's half about `replay_suspected` having no producer.

**Explicit non-goal.** None of these prove fraud. A broken client retries with a stale nonce; a QA rig enrols a thousand times. All three default to `flag` and none may reach `exclude` without §F-D-20's combination requirement.

### F-R-6 / F-D-06 (producer side). Prefetch and bot clicks

The redirector sets `bot_prefetch: true` when `prefetch_signal` is true or `client_class = bot`. The evaluator's existing path then yields `unattributed / bot_prefetch` with a `bot_prefetch` fraud decision — machinery that has existed since v0.2 and has never had a producer.

**One behaviour change worth naming.** Today `handler.ts:98` returns the fallback response for a non-Android UA on a `play_store` link **and writes no click at all**. So a prefetch by a link-preview bot currently produces silence, not evidence. The proposal keeps the fallback redirect (correct) but **records the click with `bot_prefetch: true` and no `click_id` issued**, so the operator can see how much of their click volume is preview traffic. A network billing for those clicks is a chargeback case, and today there is no record to make it with.

### F-R-7 / F-D-15. Behavioural detection: use what M1b already built

**Options:** (a) a new behavioural fraud rule (post-install engagement scoring, zero-session detection); (b) reuse the existing cohort retention and ROAS metrics grouped by source; (c) both.

**Recommendation: (b), and build nothing.** M1b already computes D1/D7 retention and cohort LTV/ROAS with immutable snapshots, supersession, and a difference audit. A sub-publisher whose installs have 2% D1 retention against the app's 35% is the clearest fraud signal that exists, and it needs **zero new rules, zero new fields, and zero new contract vocabulary** — only the `site_id` grouping dimension that G-5 blocks.

(a) is rejected specifically because a "zero-session install" rule cannot fire in this architecture: the SDK emits `install` on first launch, so every install in the ledger has a launch behind it. A rule written from the industry's usual framing would be dead code, and nobody would notice for a year.

This is the decision that most reduces the milestone's size, and it should be stated in the design rather than discovered: **the strongest behavioural fraud diagnostic this project can produce already shipped in M1b.**

### F-R-8 / F-D-16, F-D-17. What is deliberately not a rule

- **Incentivized traffic.** No rule. The retention report is the handle; the remedy is contractual.
- **Organic poaching.** Not a separate rule — it is F-R-4 — but the report adds an `organic_share_by_day` series, because the operator's first symptom is that organic fell when a campaign started, and a number for that is worth more than a verdict.
- **Apple aggregate series.** No rule. A verified SKAdNetwork or AdAttributionKit postback proves Apple's signature, not a genuine install (M4-S-12 already says this), the series carries no installation identity to attach a decision to, and the developer copy contains winners only so no rate can be derived. The only honest diagnostic is `skan_conversion_value_distribution`, which M4 already ships. Stating this prevents someone building an aggregate fraud rate three milestones from now.

### F-R-9 / F-D-18. Play Integrity

**What is being promoted.** Contract v0.3.5 reserved `integrity_verdict` and `docs/validation/m5-integrity-checklist.md` documents the operator procedure. No code produces one. M6b implements the server half.

**Shape.** Device requests an integrity token bound to the request; the token travels in the SDK batch as protected evidence, exactly like the AdServices token in M4-D-09; the **server** obtains the verdict. The device never sends a parsed verdict — that would be a device claim, and F-P-2 forbids it. This is M4-D-09 applied to a third provider, and it is the third time the same argument has decided the same way, which is a sign it is the right architecture rather than a coincidence.

**Options for binding:** (a) a server-issued one-time challenge consumed once (the classic-request shape); (b) a request hash over the sensitive request's own fields (the standard-request shape); (c) neither.

**Decided: (a) for the `install` event, (b) for high-frequency events, and never (c).** The install event happens once per installation, is the fraud-relevant one, and can afford a round trip to obtain a challenge — and a consumed challenge is the only construction that makes a captured token useless later. Standard requests with a request hash are the right instrument for anything repeated, because they are designed for volume. The current standard/classic request distinction, Google-hosted `decodeIntegrityToken` path, request binding, verdict vocabulary, and default quotas were re-verified from Google's primary documentation on 2026-08-21 and are recorded in `docs/references.md`.

**Normalisation.** The provider response maps to exactly the three closed values the contract already has: `verified`, `failed`, `unavailable`. Nothing else enters the ledger; the raw response is a protected object with an opaque `evidence_ref`, matching the schema's existing `^protected:` pattern.

**Acceptance:** F-A-14, F-A-15, F-A-16; F-V-4.

### F-R-10 / F-D-19. App Attest

Same architecture, different lifecycle: attest **once at enrolment**, binding the attestation to the per-installation credential the M2 scheme already issues, then assert on the `install` event and on on-device deletion requests. Key loss on reinstall or device transfer is a new registration, not a failure. `isSupported` is false on the Simulator, so the CI gate can only exercise the server's verification of generated vectors — which is the same boundary M4b already lives inside and the same reason M4b's tests are all synthetic.

The ordered challenge, attestation, certificate/nonce/App-ID/key checks, persisted public-key state, and monotonic assertion-counter verification were re-read from Apple's primary App Attest documentation on 2026-08-21 and are recorded in `docs/references.md`.

### F-R-11 / F-D-20. The rule that governs every integrity rule

`common.schema.json` says of `integrityVerdict`: *"It is evidence only and does not independently determine attribution, fraud, or metric eligibility."* Read that sentence exactly: **`independently` means alone.** So:

- **Permitted:** `integrity.verdict == failed` **AND** at least one independent rule fired on the same subject → `device_integrity_failed`, `suspected`, `flag`.
- **Forbidden:** any rule whose only input is an integrity verdict. Enforced by a test over the shipped bundle definitions, not by review (F-A-16).
- **Never:** `unavailable → failed`. Quota exhaustion, a provider outage, an offline device, and an unsupported OS version all produce `unavailable`, and treating them as failure would mass-exclude a real campaign during a Google incident — the highest-damage failure mode in this entire design, because it fires hardest exactly when traffic is highest.

The combination requirement also happens to be what the providers themselves advise, and it is why §F-D-20 is a decision rather than an implementation note.

### F-R-12 / F-D-21. No on-device environment heuristics

The SDK will not read `Build.FINGERPRINT`, `Build.HARDWARE`, `ro.kernel.qemu`, sensor inventories, root or jailbreak indicators, installed-package lists, or debugger state.

**Two reasons, and the second is decisive.** The first is that device configuration is named in the fingerprinting prohibition. The second is F-P-2: a check that runs inside the attacker's process is worth nothing against an attacker and produces false positives against honest users on unusual hardware. It would generate confident-looking decisions with no evidentiary basis — worse than no rule.

Enforced by extending the M4-D-10 symbol/source audit (`tools/check-ios-sdk.mjs` and the Android accessor gate) to the new symbol list, so a future contributor cannot add one quietly.

---

## Actions, and making `exclude` mean something

### F-D-22. The four actions and their consumers

`fraud-decision.action` is already closed to `allow | flag | exclude | quarantine`. Today none of them is consumed (G-7). The design binds each:

| Action | Attribution effect | Metric effect | Reversible |
| --- | --- | --- | --- |
| `allow` | none | none | n/a |
| `flag` | none — the attribution stands | counted in both `gross` and `net` | n/a |
| `quarantine` | attribution `finality: pending`, no `status` claimed until resolved | excluded from `net`, counted in `gross` | yes, automatically (§F-D-23) |
| `exclude` | attribution superseded to `unattributed / fraud_excluded` with `fraud_decision_ref` | excluded from `net`, counted in `gross` | yes, by a superseding decision |

**Where the attribution link goes — the one real design choice here.**

- (a) Add each fraud category to the attribution `reason_code` enum, following the existing `bot_prefetch` precedent.
- (b) Add one attribution reason `fraud_excluded` plus an optional `fraud_decision_ref`.
- (c) Do nothing at the attribution layer; exclude only in metrics.

**Recommendation: (b).** (a) is what the contract already did once for `bot_prefetch`, and it is the mistake not to repeat: it couples two vocabularies that will grow at different rates, so every future fraud category becomes an attribution-enum change, a compatibility-registry review, and a fixture pass. (c) leaves the attribution artifact lying — it would say `non_organic / valid_install_referrer` for an install the deployment does not count. (b) keeps the attribution artifact self-explanatory (*why is this unattributed? a fraud decision excluded it; here it is*) at the cost of two additive fields.

`bot_prefetch` stays in the attribution enum for compatibility and its existing behaviour is unchanged; new categories go through `fraud_excluded`. Say so in the spec so the asymmetry is a recorded decision rather than an inconsistency.

**Where exclusion does *not* happen: ingestion.** A fraud decision never causes a rejection. The evidence is received, stored, and counted; only the derived attribution and the net metric change. This follows M1's separation of ingestion classification from decision artifacts, and it is what makes a false positive recoverable: the ledger is append-only, the decision is supersedable, and re-running a corrected bundle re-derives the truth. **A design that refused ingestion on suspicion would destroy the evidence needed to prove the suspicion wrong.**

### F-D-23. `quarantine`, and why it needs a deadline

`quarantine` exists for the case where a rule needs evidence that has not arrived: the flooding rule needs a full day's aggregate; the retention diagnostic needs D1. Holding an attribution pending is correct — and an unbounded hold is a leak, because a pending attribution that nobody resolves is a number missing from every report forever with no error anywhere.

So quarantine carries a **resolution deadline** (default 72 h, bundle-configured). At the deadline the worker re-evaluates with whatever evidence exists and emits a superseding decision that is `allow` or `exclude` — never `quarantine` again. A quarantine that cannot be resolved resolves to `allow`, because the burden of proof is on the detection, not on the install.

### F-D-24. Metrics: `gross` and `net`, both computed

**Options:** (a) fraud-excluded records simply vanish from metric inputs; (b) a `fraud_policy` declared on the definition and recorded on the run, closed to `gross | net`, with both computed; (c) separate metric names per policy.

**Recommendation: (b).** (a) is unacceptable for the same reason silent adjustment is: the operator's most important question is *how much did fraud cost me*, and the answer is `gross − net`. If only the net number exists, the question is unanswerable and the system looks like it lost installs. (c) is what M4-D-19 chose for the Apple aggregate series and it is **wrong here**, for a reason worth stating because it looks like an inconsistency: M4 needed the two series to be *unmixable* because they measure different populations; M6 needs the two policies to be *directly comparable* because their difference is the product. Different requirement, different mechanism.

`fraud_policy` is **optional with a documented default of `gross`**, exactly as `metric-run.value_state` documents "Absence is semantically present for v0.2.0 compatibility." That keeps all 47 existing golden fixtures byte-identical and makes the patch non-breaking under R-27.

### F-D-25. The chargeback evidence report

`GET /v1/audit/fraud?app_id=…&from=…&to=…&format=json|csv`, tenant-scoped, `cache-control: no-store`, built on the M1b/M3 report-query machinery (allowlisted typed filters, bound parameters, keyset pagination, no `OFFSET`).

**What it contains**, per (campaign × network × site × day): gross installs, net installs, excluded installs by public category, quarantined count, the CTIT percentile row, CVR, D1 retention, and the `rule_bundle_id / version / hash` in force for that day.

**And one thing that makes it actionable:** the network's own click references. `click.remote_click_ref` exists in the schema and the redirector never populates it (G-5). Once it does, the report can list *the network's own identifiers* for the disputed clicks — which is the only form of per-click detail a network can act on, and which is **their** identifier, not a user's and not ours. That is a genuinely privacy-preserving way to make a dispute concrete, and it is available for the cost of one allowlisted query parameter.

**The parameter is an unauthenticated write surface and must be bounded like one:** a closed set of accepted parameter names, `^[A-Za-z0-9._~-]{1,128}$`, stored as protected evidence, subject to the existing redirector rate limit. The risk is accepting attacker-controlled bytes into the ledger; the mitigation is that they are pattern-bounded, length-bounded, never interpolated into SQL, and never rendered as HTML (`M3`'s CSP already forbids scripts). State the risk rather than omit the field.

**What it must never contain:** `installation_id`, `click_id`, `record_id`, raw referrer strings, IP addresses, User-Agents, or payload references. Same boundary as `/v1/reports/records`. The protected material needed for an escalated dispute leaves through the operator's protected export path, not this route.

### F-D-26. Rule-bundle binding — making reproducibility true

G-3 is the defect that most undermines the milestone: `rule_bundle_hash` is `"0"×64` in every artifact, so a fraud decision cannot actually be tied to the policy that produced it. A chargeback claim rests on being able to say *this is the rule that fired, this is its exact definition, here is its digest*.

**Design.** A rule bundle is a checked-in JSON document with layers:

```json
{
  "rule_bundle_id": "fraud-default",
  "rule_bundle_version": "1.0.0",
  "layers": [
    { "layer": "base",     "source": "bundled", "digest": "<sha256 of the shipped definition>" },
    { "layer": "operator", "source": "registered", "digest": "<sha256 of the operator overrides>" },
    { "layer": "private",  "source": "deployment_private", "digest": "<sha256 of a document not in this repository>" }
  ],
  "rules": [ { "rule_id": "referrer_ordering", "enabled": true, "action": "flag", "parameters": { "guard_seconds": 1 } } ]
}
```

`rule_bundle_hash = sha256(JCS(composite))`. The private layer contributes **only its digest**, so a deployment's live thresholds stay private (`docs/privacy-security.md`'s open-core boundary) while a decision remains reproducible by anyone holding the layer. The runtime resolves the active revision from `control.rule_bundles_current` and passes `{id, version, hash}` into the evaluator through the server context, exactly as `timestamp_stale_policy` is passed today; fixtures supply the same object explicitly.

**Scope, and this is the owner question.** Binding *all four* bundles (`attribution-default`, `metric-default`, `apple-postback-default`, `fraud-public-envelope`) changes `rule_bundle_hash` in **every one of the 611 committed golden artifacts**. Per `AGENTS.md` that is a contract-behaviour change, not a test update.

**Recommendation: bind the fraud bundle only in WO-14** — new artifacts, new fixtures, zero golden churn — and record the remaining three placeholders as a named handoff (F-H-3) to be taken in one dedicated change. That makes the statement true where a dispute depends on it, ships the milestone, and **names the remaining lie instead of leaving it undiscovered.** Whether to schedule the full binding is §F-D-26's owner decision.

**WO-14R correction.** Runtime ingestion and source-day evaluation resolve the active fraud definition from `control.rule_bundles_current`, verify its definition digest and composite JCS hash, pass that exact revision through the server context, and reject persistence when the recorded triple does not match the evaluated revision. The in-code definition remains only the fixture and initial-registration default. Transport, CTIT, referrer-order, and source-day decisions all use the same composite hash.

### F-D-27. Verify the fraud policy digest

Mirror `decide()`'s existing `timestamp_stale_policy` check for `click_injection_policy` and every new policy object: recompute `sha256(JCS(canonical policy fields))` and throw on mismatch. Six lines, and without them a recorded policy digest is a decoration (G-2).

---

## Contract touchpoints (F-D-28)

**All additive, all non-breaking, all inside contract v0.4 under R-27.** A v0.5 line is not proposed: every change below is an optional field, an enum extension, or a new closed object, and `docs/schema-versioning.md` already governs exactly this class. Introducing v0.5 would force a migration ledger, an evaluator identity change, and a fixture pass for no semantic gain.

| Patch | Change | Fixture |
| --- | --- | --- |
| **v0.4.1** | `fraud-decision` gains closed `subject_scope ∈ {record, source}` (optional, absent ⇒ `record`) selecting the `subject_ref` namespace (`^source:` when `source`); `fraud_public_categories` gains `click_flooding_suspected`, `referrer_time_inconsistent`, `device_integrity_failed`; `fraud-decision` gains optional `rule_id` (which rule inside the bundle fired) and optional `resolution_deadline_at` (required when `action = quarantine`) | 48 |
| **v0.4.2** | `attribution-result.reason_code` gains `fraud_excluded`; optional `fraud_decision_ref`; the compatibility registry needs **no new row** — `installation_level × none × none × [organic, unattributed]` already exists, exactly as it did for M4-H-2 | 49 |
| **v0.4.3** | `metric-definition` and `metric-run` gain optional `fraud_policy ∈ {gross, net}`, absent ⇒ `gross` | 50 |
| **v0.4.4** | `install` gains `referrer_click_at_server_status ∈ {available, missing, invalid}`, mirroring the existing `install_begin_at_server_status`, with the same conditional `required` shape. Without it, F-R-1 cannot distinguish "Play did not supply a server click time" from "the field is absent because the SDK is old" | 51 |
| **v0.4.5** | `click` gains `source_rate_class ∈ {normal, elevated, saturated}` and `client_class ∈ {mobile_app_eligible, bot, other}`, both optional and both **server-assigned** (the same "not client-authored" property `integrity_verdict` has). `site_id`, `network`, `remote_click_ref` already exist and need no change | 52 |
| **v0.4.6** | `fraud_public_categories` gains the non-fraud diagnostic `ctit_clock_anomaly`; negative CTIT rate is evaluated per tenant/app/UTC day from `ctit_negative_count / installs`, and affected CTIT-derived attributions become provisional | 53 |

**Three additions to `fraud_public_categories` and no more.** Each has a real producer in this milestone. `install_farm_suspected`, `emulator_detected`, `incentivized_suspected`, and similar are deliberately absent: a public category with no producer is exactly the state G-6 describes, and the contract already carries two of those.

**The one thing the contract must say in prose**, in `spec/event-metric-contract-v0.4.md` beside the existing CTIT paragraph:

> A fraud decision never rejects ingestion. Received evidence is stored and counted regardless of any decision; only derived attribution and `fraud_policy: net` metric runs are affected. A `source`-scoped decision describes a source-day and MUST NOT be interpreted as a decision about any individual record within it.

Two implementations reading only the schemas would both get the second sentence wrong.

---

## Data model additions

Same conventions as M1/M2/M4: `control.identifier`, `control.canonical_timestamp`, `FORCE`d RLS, append-only with `*_states` plus `*_current` where lifecycle exists.

```sql
-- The registered content of a bundle revision, so a decision is reproducible (F-D-26).
-- control.rule_bundle_revisions already exists; this adds the definition it points at.
ALTER TABLE control.rule_bundle_revisions
  ADD COLUMN definition jsonb,
  ADD COLUMN definition_digest text CHECK (definition_digest ~ '^[a-f0-9]{64}$');
-- Nullable and additive: existing revisions keep NULL and are readable; new
-- revisions require both, enforced at the route, not by a CHECK, so no backfill.

-- Daily source aggregates: the input to F-R-4 and to the chargeback report.
-- Derived, recomputable, and therefore not evidence -- but it is an input to a
-- recorded decision, so it lives in ledger with an immutable snapshot identity.
CREATE TABLE ledger.source_day_aggregates (
  tenant_id            control.identifier NOT NULL,
  app_id               control.identifier NOT NULL,
  metric_date          date NOT NULL,
  campaign_id          control.identifier NOT NULL,
  network              text NOT NULL,
  site_id              text NOT NULL,
  clicks               bigint NOT NULL,
  installs             bigint NOT NULL,
  ctit_p05_ms          bigint,
  ctit_p50_ms          bigint,
  ctit_p95_ms          bigint,
  ctit_negative_count  bigint NOT NULL DEFAULT 0,
  input_snapshot_id    text NOT NULL CHECK (input_snapshot_id ~ '^[a-f0-9]{64}$'),
  computed_at          control.canonical_timestamp NOT NULL,
  artifact             jsonb NOT NULL,
  PRIMARY KEY (tenant_id, app_id, metric_date, campaign_id, network, site_id, input_snapshot_id),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

-- Quarantine deadlines. Not evidence, needs DELETE, so: ephemeral (M2-S-3's rule).
CREATE TABLE ephemeral.fraud_quarantines (
  fraud_decision_id    text PRIMARY KEY,
  tenant_id            control.identifier NOT NULL,
  app_id               control.identifier NOT NULL,
  subject_ref          text NOT NULL,
  resolve_after        timestamptz NOT NULL
);
CREATE INDEX fraud_quarantines_due_idx ON ephemeral.fraud_quarantines (resolve_after);

-- Pending integrity verifications (M6b), mirroring ephemeral.adservices_lookups exactly.
CREATE TABLE ephemeral.integrity_verifications (
  verification_id      uuid PRIMARY KEY,
  tenant_id            control.identifier NOT NULL,
  app_id               control.identifier NOT NULL,
  provider             text NOT NULL CHECK (provider IN ('play_integrity','app_attest')),
  token_ref            text NOT NULL,   -- protected object; the token is never a column
  subject_record_id    control.identifier NOT NULL,
  attempts             integer NOT NULL DEFAULT 0,
  next_attempt_at      timestamptz NOT NULL,
  challenge_digest     text NOT NULL CHECK (challenge_digest ~ '^[a-f0-9]{64}$')
);

-- Click evidence the redirector currently discards (G-5).
ALTER TABLE ledger.click_facts
  ADD COLUMN site_id text,
  ADD COLUMN remote_click_ref text;
```

`ledger.source_day_aggregates` is keyed by `input_snapshot_id` so that a recomputation after a deletion produces a *new* row rather than mutating one — the same immutability discipline `ledger.metric_runs` uses, and the reason a fraud decision from six months ago can still name the aggregate it saw.

### Threat-model rows

`npm run check:threat-model` requires a row per `docs/architecture.md` component. M6 adds `fraud-engine` and `integrity-verifier`, and extends the existing `redirector` row to cover the three new edge classifications and the `remote_click_ref` parameter. The existing `integrity-evidence` M5 row is rewritten from "reserved, no live verifier" to the shipped controls.

---

## Local runtime and CI additions

No new Compose service. `worker` gains three steps (aggregate computation, rule evaluation, quarantine resolution); `api` gains one read route and extends one admin route; `redirector` gains three classifications and one query parameter.

New variables, all required in `.env.example` because `npm run test:env-coverage` fails otherwise:

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENMASU_FRAUD_ENABLED` | `1` | master switch; `0` produces no decisions at all |
| `OPENMASU_FRAUD_AGGREGATE_HOUR_UTC` | `2` | when the daily source aggregate runs |
| `OPENMASU_REDIRECTOR_CLIENT_CLASS` | `on` | UA classification; `off` emits nothing |
| `OPENMASU_REDIRECTOR_REMOTE_CLICK_PARAM` | `cid` | the single accepted network click-reference parameter name |
| `OPENMASU_INTEGRITY_PROVIDER` | `off` | `off \| play_integrity \| app_attest \| both` |
| `OPENMASU_INTEGRITY_MODE` | `observe` | `observe \| enforce`; `enforce` still requires §F-D-20's combination |
| `OPENMASU_INTEGRITY_RATE_RPS` / `_BURST` | `10` / `50` | outbound courtesy limit, a proposal not a measurement |

**CI.** All of M6a extends `runtime.yml` on the existing Linux job — the rule package is TypeScript, the aggregates are SQL, and every input is synthetic. M6b's server verification is also TypeScript against generated key material and synthetic tokens, so **it too runs on Linux**; only obtaining a *real* token needs a device, and that is F-V-4/F-V-5, an operator procedure. No new runner.

---

## Acceptance criteria

The M1 D-30 principle applies: **anything requiring a real device, a real Play/Apple project, a real campaign, or real traffic is an operator procedure, never a code gate.**

### Code gates (Linux, synthetic)

**F-A-01 — CTIT threshold plumbing is real.** A runtime batch evaluated with a bundle whose threshold is 2 s classifies a 3-second CTIT as clean and a 1-second CTIT as suspected. The test fails on the current code, because G-1 makes the runtime ignore the configured value. `grep -rn "click_injection_threshold_ms" --include=*.ts .` returns zero hits after the fix.

**F-A-02 — the policy digest is enforced.** A server context whose `click_injection_policy.policy_digest` disagrees with `sha256` of its canonical fields raises the same named error `timestamp_stale_policy` raises, in both the TypeScript and Python evaluators.

**F-A-03 — referrer ordering, both directions and the guard.** `referrer_click_at_server` one second after `install_begin_at_server` produces `referrer_time_inconsistent` with `decision: confirmed`. Equal second values produce nothing. `referrer_click_at_server` before `install_begin_at_server` produces nothing. `referrer_click_at_server_status = missing` produces nothing and is not an error.

**F-A-04 — the ordering rule does not depend on our clock.** The same fixture evaluated with `redirector_click_at` shifted by ±1 h produces a byte-identical fraud decision. This is the property that makes F-R-1 stronger than F-R-2 and it is asserted, not assumed.

**F-A-05 — negative CTIT is a clock diagnostic, never fraud.** A negative CTIT produces `ctit_clock_anomaly` with `decision: clear, action: allow` and no `click_injection_suspected`. When negative CTITs exceed the configured day rate, every CTIT-derived attribution that day carries `finality: provisional`.

**F-A-06 — flooding requires every term.** A table of source-days varying each of the four terms independently: only the all-terms-true row produces `click_flooding_suspected`. A high-volume, low-CVR source with a normal CTIT shape produces nothing — the false-positive case that matters most.

**F-A-07 — an aggregate decision cannot be read as a record decision.** A `source`-scoped decision whose `subject_ref` does not match `^source:` fails schema validation; a `record`-scoped decision with a `^source:` reference fails; and no attribution artifact anywhere carries a `fraud_decision_ref` pointing at a `source`-scoped decision.

**F-A-08 — `exclude` actually excludes.** An install with an `exclude` decision yields a superseding attribution `unattributed / fraud_excluded` carrying `fraud_decision_ref`; the same day's `fraud_policy: gross` run counts it and the `fraud_policy: net` run does not; `gross − net` equals the excluded count exactly.

**F-A-09 — `flag` changes no number.** With every rule at `flag`, all metric runs are byte-identical to a run with `OPENMASU_FRAUD_ENABLED=0`. This is F-P-5 as a test.

**F-A-10 — quarantine always resolves.** A quarantined decision past its deadline produces exactly one superseding decision that is `allow` or `exclude`, never `quarantine`; a quarantine whose evidence never arrives resolves to `allow`; the `ephemeral.fraud_quarantines` row is gone afterwards.

**F-A-11 — a fraud decision never rejects ingestion.** For every rule and every action, `ledger.rejections` is unchanged and `raw_records`/`deliveries`/`logical_events` are byte-identical to the no-fraud run. Only attributions, fraud decisions, and `net` metric runs differ.

**F-A-12 — the fraud bundle hash is real.** Every fraud decision's `rule_bundle_hash` equals `sha256(JCS(composite bundle))` for the revision active at `evaluated_at`, and differs from `"0"×64`. Changing one threshold in the bundle changes the hash and therefore the decision artifact. Re-running the same evidence against the recorded revision reproduces the decision byte-identically.

**F-A-13 — the private layer stays private.** A bundle carrying a `private` layer produces decisions whose public artifact contains the composite hash and the layer digest and **no threshold, no parameter, and no rule text from that layer.** A text scan over every emitted artifact asserts it, in the same shape as the existing "public artifacts expose operational defenses" check.

**F-A-14 — integrity is never a device claim.** A batch whose `install` payload carries a parsed verdict rather than a token is rejected; only the raw token is accepted; the token is a protected object and never a column. Byte-for-byte the M4-A-09 assertion for a third provider.

**F-A-15 — outage is not failure.** Provider timeout, HTTP 429, HTTP 5xx, and an unsupported client each produce `verdict: unavailable` with no `evidence_ref`, and none produces a fraud decision. A forced provider outage across a whole synthetic day changes no metric value.

**F-A-16 — no rule fires on integrity alone.** Every shipped and test bundle is scanned: any rule whose predicate references only an integrity verdict fails bundle validation with a named error at load time, not at evaluation time.

**F-A-17 — no raw edge signal is ever stored.** No column in any schema, no contract field, and no emitted artifact accepts a value matching an IPv4/IPv6 literal or a User-Agent-shaped string; the redirector writes at most the three bounded classifications; a source-IP grep over the payload store, the database, and application logs after a synthetic run returns nothing. Extends the existing M2-S-10 assertion from "not persisted" to "not derivable".

**F-A-18 — no fingerprint symbols.** The source audit finds no reference on the server or in either SDK to device configuration, build fingerprints, sensor inventories, root/jailbreak checks, installed-package enumeration, or any IP/UA hashing primitive. Same machinery as M4-A-25, extended to `apps/`.

**F-A-19 — `bot_prefetch` has a producer, and it is the server.** A redirect carrying a declared prefetch header records a click with `bot_prefetch: true`, no `click_id` issued, and the same byte-identical fallback response an ordinary rejected request receives; a client-supplied `bot_prefetch` in an SDK batch is refused.

**F-A-20 — the chargeback report leaks nothing.** The JSON and CSV forms of `/v1/audit/fraud` contain no `installation_id`, `click_id`, `record_id`, payload reference, IP, or User-Agent; they do contain `remote_click_ref` values; JSON and CSV agree row for row; the route rejects a bearer token on the dashboard namespace and a cookie on the `/v1` namespace, as M3 requires.

**F-A-21 — contract gate.** `npm run validate` prints its summary line with 53 fixtures and the new assertion count. Only the seven existing fraud-decision goldens listed in `docs/contract-v0.4-migration.md` change for the corrected bundle binding; other existing artifact classes remain unchanged.

**F-A-22 — configuration and threat-model coverage.** `npm run test:env-coverage` and `npm run check:threat-model` pass with `fraud-engine` and `integrity-verifier`.

### Operator-verified — `docs/validation/m6-fraud-checklist.md`

Recording a dated pass/fail summary and an opaque private reference is the deliverable; campaign identifiers, source names, volumes, and thresholds stay outside the public repository, exactly as `docs/validation/real-data-checklist.md` requires.

**F-V-1 — the referrer ordering invariant, observed.** Over one week of real Android installs, record the sign distribution of `referrer_click_at_server − install_begin_at_server`. **The rule may not be promoted above `flag` until this shows that the positive tail is rare and separable.** If genuine installs routinely show a positive difference, the invariant is wrong and F-R-1 becomes a diagnostic; record that outcome as a design finding, not a documentation fix.

**F-V-2 — the deployment's own clock.** Record the negative-CTIT rate over the same week and the redirector host's NTP offset. A negative rate above the configured bound invalidates every CTIT-derived decision in that period; confirm the `provisional` marking fires.

**F-V-3 — the CTIT distribution before any threshold is chosen.** Record p05/p25/p50/p75/p95 per network and per site for four weeks. Choose thresholds from this, not from the shipped defaults, and record the chosen values privately.

**F-V-4 — Play Integrity end to end.** With an operator-owned project, confirm a real token verifies server-side, that a replayed token is refused, that a quota-exhausted request produces `unavailable`, and that no verdict alone ever changes a number. Record the verdict distribution and the false-positive review.

**F-V-5 — App Attest end to end.** Confirm attestation at enrolment, assertion on `install`, refusal of a replayed assertion, and that reinstall produces a new registration rather than a failure.

**F-V-6 — a real chargeback cycle.** Take one report to one network. Record whether the evidence was actionable, what the network asked for that the report did not contain, and the outcome. **This is the only test of whether the milestone achieved its purpose**, and no synthetic gate substitutes for it.

**F-V-7 — false-positive review before enforcement.** Before promoting any rule to `exclude`, manually review a sample of flagged installs and record the false-positive rate. A rule may not be promoted on a sample with an unreviewed false positive.

**F-V-8 — the difference, over a quarter.** Record `gross − net` by source per month and whether the operator's spend decisions changed. A rule that flags steadily and never changes a decision is a rule to retire, not a rule to keep.

---

## Default rule set and the private-policy boundary (F-D-29)

The tension the prompt names is real: `docs/privacy-security.md` places "live thresholds and rule combinations" on the private side, and an OSS project that ships no rules at all ships nothing.

**Resolution: three layers, and only the middle one is a deployment secret.**

- **`base` — shipped, public, in `config/fraud-bundles/conservative-v1.json`.** All rules present, all `enabled: true`, all `action: flag`, thresholds set so that only the ordering-impossibility rule fires reliably. This is a *complete, working, auditable* rule set that changes no number.
- **`operator` — registered through the existing admin route, private to the deployment.** Threshold values and per-rule actions. Its digest is public; its content is not.
- **`private` — optional, never in the repository.** Additional rules a deployment does not wish to publish. Contributes only its digest to the composite hash.

The composite hash is what every artifact records, so a decision is reproducible by anyone holding the layers, and the public repository's fixtures exercise the base layer alone. This satisfies "live fraud policy is deployment-private" and "OpenMasu ships real rules" simultaneously, without either being a fiction.

**The shipped defaults are conservative by construction**, and that is the point: an operator who installs OpenMasu and enables nothing gets a fraud *report* on day one and no changed numbers, which is the only defensible default for a measurement system.

---

## WO-14 stage plan (F-D-30)

Eight stages, each a PR, under R-26 (all CI green plus evidence in the report ⇒ merge without waiting; the commander audits afterwards) and R-27 (non-breaking contract patches need no stop).

| Stage | Content | Gates |
| --- | --- | --- |
| **0** | **Primary-source verification, no code.** Re-read and record with URLs and dates: Play Install Referrer server-timestamp semantics (the F-R-1 invariant); Play Integrity verdict vocabulary, request types, decoding path, and quotas; App Attest verification steps. Report findings. **If the F-R-1 invariant is not confirmed, stop and report before stage 3.** | a written record appended to `docs/references.md` |
| **1** | Contract patches v0.4.1–v0.4.5 and fixtures 48–52; registry and prose updated in the same change per `AGENTS.md` | F-A-21 |
| **2** | Redirector edge evidence: `network`, `site_id`, `remote_click_ref`, `bot_prefetch` from intent headers and the bot token list, `source_rate_class` from the existing bucket. Fixes G-5, G-6 | F-A-17, F-A-19 |
| **3** | `packages/fraud-rules` (pure) + F-R-1, F-R-2, F-R-3, F-R-5. Fixes G-1, G-2 | F-A-01…F-A-05 |
| **4** | `ledger.source_day_aggregates`, the worker aggregate step, F-R-4 at `source` scope | F-A-06, F-A-07 |
| **5** | Actions: attribution supersession to `fraud_excluded`, `fraud_policy: gross\|net` in the metric engine, quarantine with deadline resolution | F-A-08…F-A-11 |
| **6** | Fraud bundle binding and the layered definition. Fixes G-3 for the fraud bundle; records F-H-3 for the rest | F-A-12, F-A-13 |
| **7** | `/v1/audit/fraud` JSON/CSV, dashboard panel, `docs/validation/m6-fraud-checklist.md`, threat-model rows, `docs/privacy-security.md` capability-gap table, roadmap/project-plan crosswalk | F-A-20, F-A-22 |
| **8** | **M6b:** Play Integrity and App Attest server verification, observation mode, the combination requirement | F-A-14…F-A-16 |

Stage 0 is not ceremony. Three rules in this document rest on external semantics, and F-R-1 — the strongest rule here — rests entirely on one of them.

---

## Decided design

| # | Decision | Recommendation |
| --- | --- | --- |
| F-D-01 | Milestone shape | New roadmap milestone M6, split M6a (deterministic, Linux-only) / M6b (platform integrity); M6a first |
| F-D-02 | The capability claim | Publish what OpenMasu can and cannot detect, including the structural single-advertiser limit **【owner】** |
| F-D-03 | No machine learning | Deterministic pure rules only; a score is unauditable and unpublishable |
| F-D-04 | Signal provenance | A signal is evidence only if the attacker does not control it (F-P-2) |
| F-D-05 | Threat taxonomy | Eight types, each mapped to evidence held and evidence absent |
| F-D-06 | The privacy line | IP/UA/headers observable at the edge, leaving only as one of three bounded classifications; no hash, no row, no link **【owner】** |
| F-D-07 | No third-party intelligence | No data-centre/proxy/reputation feeds; a decision must be reproducible inside the deployment; publish the gap table **【owner】** |
| F-D-08 | Mechanical enforcement | Field/column audit plus an extended symbol audit, not review |
| F-D-09 | Fraud evidence retention | `fraud_prevention` purpose, 90 days for aggregates, decisions retained with attribution |
| F-D-10 | Referrer ordering rule | Threshold-free, single-clock, `confirmed`; the decisive injection proof; premise verified in stage 0 and observed in F-V-1 |
| F-D-11 | CTIT rule | Lower bound only; negative CTIT is a clock diagnostic that invalidates the day; distribution reporting is the product |
| F-D-12 | Referrer/redirector agreement | Coarse rule for click-ID harvesting |
| F-D-13 | Click flooding | Aggregate `source` scope, four-term conjunction, self-calibrated against the app's own median |
| F-D-14 | Replay and enrolment | Rules over `ledger.audit_logs` and `ledger.rejections` rows that already exist |
| F-D-15 | Behavioural detection | Reuse M1b retention/LTV by source; build no new behavioural rule |
| F-D-16 | Incentivized abuse | Out of scope; retention is the honest handle |
| F-D-17 | Apple aggregate series | No fraud rule; state why so nobody builds one later |
| F-D-18 | Play Integrity | Server obtains the verdict from a device-supplied token; challenge for `install`, request hash for volume |
| F-D-19 | App Attest | Attest at enrolment bound to the installation credential; assert on `install` and deletion |
| F-D-20 | Integrity governance | Never the sole input; `unavailable` is never `failed`; enforced at bundle load |
| F-D-21 | No device heuristics | Attacker-controlled checks are not evidence; enforced by symbol audit |
| F-D-22 | Actions and consumers | `exclude` supersedes attribution to `fraud_excluded`; ingestion is never refused |
| F-D-23 | Quarantine | Always carries a deadline; always resolves; resolves to `allow` when evidence never arrives |
| F-D-24 | Metric exposure | Optional `fraud_policy: gross\|net`, absent ⇒ gross; the difference is the product |
| F-D-25 | Chargeback report | Aggregate plus the network's own `remote_click_ref`; never our identifiers or user data |
| F-D-26 | Rule-bundle binding | Bind the fraud bundle for real in WO-14; name the other three as a handoff **【owner】** |
| F-D-27 | Policy digest | Verify it the way `timestamp_stale_policy` is verified |
| F-D-28 | Contract version | Additive v0.4.1–v0.4.5 under R-27; no v0.5 |
| F-D-29 | Default bundle | Three layers; shipped base is complete and observe-only; only the middle layer is secret |
| F-D-30 | WO-14 | Eight stages, stage 0 is primary-source verification with a stop condition |

---

## Handoffs

### To the runtime (not contract changes)

| # | Target | Change |
| --- | --- | --- |
| F-H-1 | `apps/worker/src/sdk-worker.ts` | Replace the dead `click_injection_threshold_ms` with a real `click_injection_policy` object resolved from the active bundle (G-1) |
| F-H-2 | `packages/attribution-core/src/evaluator.ts` `decide()` | Verify `click_injection_policy.policy_digest` as `timestamp_stale_policy.policy_digest` is verified (G-2) |
| F-H-3 | `evaluator.ts` `HASH` constant | `attribution-default`, `metric-default`, and `apple-postback-default` still emit `"0"×64`. WO-14 fixes only `fraud`. **The remaining three are a scheduled, golden-changing repair, not a leftover** (G-3) |
| F-H-4 | `apps/redirector/src/handler.ts` | Populate `network`, `site_id`, `remote_click_ref`; the M2 baseline documents these as present and they are not (G-5) |
| F-H-5 | `docs/design/m2-baseline.md:404` | Correct the click-artifact table to describe what shipped, then correct the code — same treatment M4 gave the `sdk_keys.platform` drift |
| F-H-6 | M7 `deep_link_open` | Treat the device-declared open as forgeable evidence readable by later fraud rules. Inflated re-engagement from a forged open remains a documented residual until a deterministic combined rule is designed. |

### To the documents

`docs/architecture.md` (two component identifiers, the fraud route), `docs/threat-model.md` (two rows plus the rewritten `integrity-evidence` row), `docs/privacy-security.md` (the F-P-3 edge-signal paragraph, the F-D-07 capability table, fraud retention), `docs/roadmap.md` + `docs/project-plan.md` (M6 in the crosswalk, in one change), `docs/STATUS.md` (an M6 row with its residual boundary), `docs/references.md` (stage 0's records).

### To a later milestone

- Cross-deployment signal sharing between consenting operators — the only construction that recovers part of the multi-advertiser view without a central party. Hard, and a separate product.
- Aggregate-series anomaly detection over conversion-value distributions, if F-V-8 ever shows the deterministic rules leaving a visible gap on iOS.

---

## References

Primary sources recorded by the repository and relied on here. **Items marked (not re-fetched) were not verified in this pass; each names how it gets settled.**

| Topic | URL | Status |
| --- | --- | --- |
| Play Install Referrer library | `https://developer.android.com/google/play/installreferrer` | recorded in `docs/references.md`; (not re-fetched) |
| Install Referrer AIDL response bundle — the four timestamps | `https://developer.android.com/google/play/installreferrer/igetinstallreferrerservice` | Re-fetched 2026-08-21. Defines the server click as when the referrer click happened and server install begin as when app installation began, both in seconds; this confirms the F-R-1 event-order premise while F-V-1 remains an empirical promotion gate. |
| Play Integrity overview and request guides | `https://developer.android.com/google/play/integrity/overview` | Overview, standard/classic request guides, verdicts, decoding path, and setup/quota pages re-fetched 2026-08-21 and recorded in `docs/references.md`. |
| Apple DeviceCheck / App Attest | `https://developer.apple.com/documentation/devicecheck` | Re-fetched 2026-08-21; defines App Attest as app-integrity evidence and cautions that no single policy eliminates fraud. |
| Validating apps that connect to your server | `https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server` | Re-fetched 2026-08-21 together with the attestation validation guide; ordered challenge, attestation, and assertion verification is recorded in `docs/references.md`. |
| Google Play Data safety, IP-derived location | `https://support.google.com/googleplay/android-developer/answer/10787469?hl=en` | recorded as checked 2026-08-19; operators enabling country derivation must update their declaration. Directly relevant to F-P-3. |
| RFC 8785 JSON Canonicalization | `https://www.rfc-editor.org/rfc/rfc8785` | the bundle digest and every artifact digest use it |

**Industry fraud statistics are deliberately absent.** No figure from a vendor blog or an aggregated report appears in this document. The MRC invalid-traffic detection standards and the IAB mobile measurement guidelines are the relevant primary standards for GIVT/SIVT terminology; **neither was retrieved in this pass, and a paywalled or unretrieved standard is not a citation.** Where this document uses a term like "invalid traffic" it means what §F-D-05 defines it to mean, not what a standard defines it to mean, and it says so.

Repository facts used as premises, read on 2026-08-21 from `main` at `ad22525`:

- `packages/attribution-core/src/evaluator.ts` — `HASH = "0".repeat(64)` at line 26; the CTIT rule at 1380–1419 reading `click_injection_policy.threshold_seconds ?? 10`; the transport-fraud rule at 1357–1379 reading client-set booleans; `decide()`'s `timestamp_stale_policy` digest verification at 396–405 with no CTIT equivalent.
- `apps/worker/src/sdk-worker.ts:44` — `click_injection_threshold_ms: 2_000`, a field no reader consumes.
- `apps/redirector/src/handler.ts` — `persistClick` omits `network`, `site_id`, `remote_click_ref`; `handler.ts:98` reads the User-Agent for the destination gate and writes no click on the fallback path.
- `apps/api/src/rate-limit.ts` — `KeyedTokenBucket`, 10,000 keys, 15-minute idle TTL, keys held in memory only.
- `apps/api/src/sdk-auth.ts` / `sdk-routes.ts` — `nonce_reused` produces a 401 and an audit row through `auditFailure`.
- `sdk/android/installreferrer/.../GooglePlayReferrerReader.kt` — all four Play timestamps are read, converted with `Instant.ofEpochSecond` (**seconds resolution**), and delivered; `EventFactory.kt:31` carries `referrer_click_at_server`.
- `db/schema.sql` — `ledger.fraud_decisions` at 285; `control.rule_bundle_revisions` at 1569 with single-root/single-successor unique indexes; `site_id` present only at 835 on `control.tracking_links`.
- `schemas/metric-definition.schema.json`, `schemas/metric-run.schema.json`, `schemas/attribution-result.schema.json` — no fraud filter, no fraud state, no fraud reference.
- `fixtures/v0.4/41-click-injection-suspected/` — `policy_digest: "3333…3"`, `rule_bundle_hash: "0000…0"` in the committed golden.

## Not verified

Stated as unverified rather than assumed. None blocks starting; each names how it gets settled.

1. **Whether Play's server timestamps can be zero or absent in practice**, and how often. `GooglePlayReferrerReader.kt` already treats `<= 0` as absent, so the code is safe; the *rate* determines how much of the traffic F-R-1 can cover, and F-V-1 measures it.
2. **Every threshold in this document.** `threshold_low = 10 s`, `threshold_agreement = 300 s`, `min_volume = 1,000`, `cvr_floor = 0.2`, `ctit_median_floor = 24 h`, `uniformity_bound = 3.0`, `quarantine = 72 h`, and every rate bound are **proposed defaults, not measurements** — the same status as M2-S-5's and M4-S-5's tables. F-V-3 replaces them with observations.
3. **Whether a bot-token list in the User-Agent is stable enough to be useful.** Bot operators change strings freely. The rule is cheap and its failure mode is under-detection, but its hit rate is unknown until F-V-1's week of data.
4. **Whether `source_rate_class` carries useful signal at all.** It may be dominated by carrier NAT, in which case the classification is noise and should be removed rather than kept for appearances. Measured, not assumed.
5. **Whether a network will accept the F-D-25 report as chargeback evidence.** F-V-6 is the only test, and a rejection is a design finding, not a documentation fix.
