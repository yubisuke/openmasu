# Platform and Provider Capability Matrix

Status date: 2026-08-31.

This matrix is the current index of external measurement surfaces in the public
source tree. **Implemented** means a typed code path exists. **Synthetically
verified** means checked-in synthetic inputs pass a repository gate. Neither
state proves live account access, provider approval, real-device delivery,
quota behavior, or production correctness.

| Surface | Current public path | Repository evidence | Open operator evidence |
| --- | --- | --- | --- |
| Google Play Install Referrer | Android/Unity reader, redirector click reference, authoritative server timestamps, deterministic install evaluation | Kotlin/JVM tests, Android emulator gate, contract fixtures, PostgreSQL parity | Physical devices, Play-track install/reinstall, long-running delivery, live app policy review |
| Meta Install Referrer | Optional Android/Unity reader, deployment-key decryption, typed normalization | Public synthetic crypto vectors and native/runtime tests | Live application configuration, field semantics, key rotation, campaign behavior |
| Apple AdServices | iOS token handoff and bounded server lookup with protected evidence | Swift source/simulator gates and synthetic worker responses | Real token acquisition, Apple response behavior, rate limits, reset/reinstall behavior |
| SKAdNetwork | Signed developer-copy receiver and separate aggregate reporting | Synthetic signature vectors, replay/conflict tests, contract and SQL parity | Real developer copies, Apple timing, second/third postbacks, production keys |
| AdAttributionKit | Signed developer-copy receiver; install and re-engagement aggregate series; iOS and Unity conversion-type/tag helpers | Synthetic JWS fixture, receiver/replay tests, TypeScript/Python/PostgreSQL parity, macOS SDK and Unity bridge gates | Real copies, Info.plist propagation, real consumer-project Unity export, device conversion windows, caller-owned conversion-tag lifecycle |
| AppLovin MAX | Android/iOS/Unity impression-revenue mapping, authenticated receiver, bounded aggregate-revenue import | Native compile probes, synthetic callbacks/imports, runtime tests | Live callbacks/reports, account permissions, completeness, restatements; no user-level install-attribution claim |
| Meta Insights cost | Bounded synchronous date-range/ad-set/country cost import | Synthetic HTTP responses, validation, atomic-import tests | Token/account permissions, timezone, pagination, live API behavior; default Graph version must be rechecked before deployment |
| Google Ads cost | Bounded v25 `SearchStream` import for closed campaign partitions and country resolution | Synthetic streamed responses, query/limit validation, atomic-import tests | OAuth/developer-token access, customer hierarchy, quotas, live fields and future API-version upgrades |
| Google Play verified commerce | Authenticated notification intake plus authoritative product, subscription, renewal, order, and refund read-back | Synthetic OIDC/provider responses, lifecycle tests, exact-money and correction gates | Live credentials, RTDN delivery, quotas, acknowledgement/entitlement policy, complete recovery |
| App Store verified commerce | Signed notification verification and bounded transaction/refund history read-back | Synthetic JWS/certificate vectors, cursor/revision and correction tests | Live App Store keys, notifications, sandbox/production behavior, entitlement, tax, payout |
| Google Data Manager conversion delivery | Explicitly enabled, bounded service-account delivery of eligible verified conversions with per-row durable claims, fenced completion, a stable transaction ID, destination-scoped database pacing, and reader-safe delivery-health API/dashboard output | Synthetic authentication, request, retry, active-claim exclusion, distinct-row pacing, bounded `Retry-After`, expired-claim recovery, stale-completion rejection, diagnostics, state-summary, and secret-column-denial tests | Provider access, acceptance, same-transaction-ID duplicate behavior, live quota allocation, diagnostics latency and retention, production policy |
| Provider-neutral event, cost, and aggregate-revenue imports | Closed mapping DSL, no-write compatibility preview, atomic append-only import | Mapping-schema tests, rejection/idempotency tests, cost-to-ROAS and revenue parity | Authorized export shape, permission, completeness, latency, source-dashboard reconciliation |
| Provider-neutral server-to-server events | Dedicated app-scoped keys for selected first-party backend events; raw-body HMAC, replay controls, durable evaluation, and ordinary contract rejection | Synthetic key rotation, signing, scope/authority, projection, rejection, idempotency, and deletion-race tests | Production TLS, backend integration, sustained load, secret custody, and operator acceptance |
| Provider-neutral operator event webhooks | Default-off delivery of selected accepted events to an allowlisted operator-owned HTTPS receiver; destination-scoped references, exact-body HMAC, and durable retry | Synthetic lifecycle, DNS/SSRF, envelope privacy, signature, retry, disable, and deletion-race tests | Production receiver, DNS/TLS, capacity, alerting, secret custody, downstream retention/deletion, and operator acceptance |
| Provider-neutral operator bulk event exports | Default-off deterministic gzip NDJSON to allowlisted operator-owned S3-compatible storage; destination-scoped references/deletion rows, SigV4, conditional create, digest replay, and durable cursors | Official SigV4 vectors plus synthetic PostgreSQL lifecycle, byte-identity retry, cursor, privacy, grant, and credential-exclusion tests | Live S3/R2 account, IAM, DNS/TLS, lifecycle/replication, throughput, cost, alerting, downstream deletion, and operator acceptance |

## Important separations

- MAX is advertising-revenue evidence, not user-level install attribution.
- Apple privacy-preserving postbacks are aggregate evidence and never become
  installation identity.
- Device-reported `deep_link_open` engagement is separate from Apple-signed
  aggregate AdAttributionKit re-engagement.
- Imported provider attribution remains provider judgment; it does not become
  first-party evidence.
- A provider row above does not imply coverage of every account, region,
  report, API version, campaign type, or permission tier.

Implementation details and operator commands are in the
[Import mapping DSL](../import-mappings.md),
[Server-to-server events](../server-to-server-events.md),
[Operator event webhooks](../operator-event-webhooks.md),
[operator bulk event exports](../operator-bulk-exports.md),
[Android SDK](../../sdk/android/README.md), [iOS SDK](../../sdk/ios/README.md),
[Unity SDK](../../sdk/unity/README.md), and
[validation checklists](../validation/README.md). Primary public sources and
their confirmation dates are in [Primary references](../references.md).
