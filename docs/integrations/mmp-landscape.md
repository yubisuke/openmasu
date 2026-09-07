# MMP landscape and implementation priorities

Checked: 2026-09-07. OpenMasu comparison baseline: `03a2d57`.

## Decision

The next product priority is a reproducible same-cohort comparison workflow.
OpenMasu already has event ingestion, metrics, export, and difference artifacts.
Connecting these into one usable comparison addresses the project's core
question: why do two measurement results differ?

The comparison below uses public documentation and repository inspection.
Features advertised by another project are not independently tested here.
Repository activity is not evidence of production reliability. This is a
bounded selection of relevant projects, not an exhaustive market survey or a
ranking of providers.

## Commercial reference capabilities

| Reference | Publicly documented capability | Implication for OpenMasu |
| --- | --- | --- |
| [AppsFlyer cohorts](https://support.appsflyer.com/hc/en-us/articles/207040496-Cohort-and-retention-dashboard) | Acquisition and retargeting cohort views, revenue, ROI, and campaign breakdowns | Comparison must record cohort and attribution-view definitions before calculating a difference |
| [Adjust cohorts](https://help.adjust.com/en/article/how-cohorts-work) | Cumulative and non-cumulative values, with a separate fully elapsed cohort calculation | Equal metric names do not establish equal denominators or maturity; expose mismatches explicitly |
| [Adjust ad spend](https://help.adjust.com/en/article/how-ad-spend-source-affects-your-data) | Network-reported and attribution-derived spend have different provenance; network reads support lookback | Preserve source grain and revision rather than treating every cost total as interchangeable |
| [Singular data connectors](https://support.singular.net/hc/en-us/articles/360032597931-Integrating-with-Singular-Analytics-FAQ-for-Partners) | Daily cost collection through API and selected file-based integrations | Durable cost refresh and backfill are useful after the comparison workflow |
| [Adjust raw exports](https://help.adjust.com/en/article/raw-data-exports) | Callbacks and cloud-storage delivery | OpenMasu already implements a narrower operator event subset; retain its explicit disclosure boundary |

These are technical reference features, not claims of account access, exact
wire compatibility, commercial entitlement, or partnership. No provider data
was imported or sent.

## Open-source repository references

| Repository | Scope and license observed | Activity observed | Useful design reference and boundary |
| --- | --- | --- | --- |
| [OpenAttribution/open-attribution](https://github.com/OpenAttribution/open-attribution) | Mobile measurement server and dashboard; Apache-2.0 | GitHub `pushed_at`: 2025-09-28 | Click/event ingestion, ClickHouse attribution SQL, and separate SDKs. README explicitly calls the project under construction and not ready for production |
| [grovs-io/backend](https://github.com/grovs-io/backend) and [self-host](https://github.com/grovs-io/self-host) | Links, attribution, analytics, and deployment stack; core MIT, `ee/` has separate enterprise terms | Backend `pushed_at`: 2026-09-07 | Connected setup and campaign workflows are worth studying. Revenue/IAP features are in the enterprise scope; the repository must not be treated as uniformly MIT |
| [LinkForty/core](https://github.com/LinkForty/core) | TypeScript/PostgreSQL deep-link engine; AGPL-3.0 | GitHub `pushed_at`: 2026-09-04 | Link routing, previews, and deployment ergonomics. Its documented probabilistic fingerprint matching conflicts with OpenMasu's identifier model |

Grovs publishes separate [dashboard](https://github.com/grovs-io/dashboard),
[iOS](https://github.com/grovs-io/grovs-iOS), and
[Android](https://github.com/grovs-io/grovs-Android) repositories. A public SDK
alone is not a self-hostable MMP server. Link-focused products also do not prove
the cost, cohort, and reconciliation coverage of a complete measurement system.
No external implementation was copied or executed for this comparison.

## Ordered implementation slices

1. **Same-cohort comparison.** Accept explicitly described aggregate snapshots
   from both sides. Bind the inputs and the cohort date range, time zone,
   maturity, cumulative/on-day convention, attribution view, currency/scale,
   metric definition, and source cutoff. Report incompatible definitions before
   comparing numbers. Preserve undefined values and missing rows, use exact
   integer arithmetic, and produce deterministic output. Never infer a causal
   difference reason from a numeric delta alone.
2. **Runtime integration.** Connect that comparison to saved OpenMasu metric
   runs and the existing report UI. Persist input provenance and a reproducible
   cutoff. Existing difference-page sequence boundaries only stabilize
   pagination; they are not a source watermark.
3. **Durable cost refresh.** Reuse the current cost adapters and scheduler to
   support bounded refresh, retry, and historical corrections. Keep incomplete
   provider reads from becoming partial cost snapshots.

The first slice can be validated entirely with synthetic files: equal values
at different scales, integers beyond JavaScript's safe-number range,
definition mismatches, missing and undefined rows, duplicate keys, reordered
inputs, and deterministic repeat output. It needs no database, provider
credentials, or device. Runtime integration is a subsequent slice, not a claim
made by an offline comparison.

## Why these priorities

Commercial documentation demonstrates the practical importance of definition,
cohort, revenue, and cost consistency. The reviewed OSS projects demonstrate
the importance of connected onboarding and usable link workflows. OpenMasu's
existing components cover much of the underlying machinery, while its
[reporting design](../design/m3-baseline.md) explicitly records the remaining
reconciliation-cutoff limitation. The proposed sequence joins those components
without adding another database or messaging service.

Physical devices, live provider connections, store approval, and private
same-cohort evidence remain optional operator validation. None is required to
implement or test these slices with synthetic inputs.
