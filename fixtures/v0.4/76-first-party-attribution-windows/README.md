# First-party attribution window derivation

All inputs are synthetic. This fixture exercises a separate opt-in attribution
family, not a change to the historical seven-day default.

## Independent boundary arithmetic

One accepted redirector click occurs at `2026-08-01T00:00:00.000Z`.
Nine different native installations reference that exact scoped click. Each
1/7/30-day policy has an installation one millisecond before, exactly at and
one millisecond after its exclusive end. All records are received at
`2026-09-02T00:00:00.000Z`; this fixed receipt is also the decision/cutoff time.

| Policy days | Before delta (ms) | Exact delta (ms) | After delta (ms) |
| --- | ---: | ---: | ---: |
| 1 | 86399999 | 86400000 | 86400001 |
| 7 | 604799999 | 604800000 | 604800001 |
| 30 | 2591999999 | 2592000000 | 2592000001 |

The independently applied inequality is `0 <= delta < days * 86400000`.
Thus the three before cases are `non_organic/install_referrer/last_click`
with `valid_install_referrer`; the other six are
`unattributed/none/none` with `window_expired`. Only the before cases
include the click in their evidence references; all nine include their own
installation. Evidence remains protected and available, and all decisions
are final. Device time does not determine window membership.

## Definition and identity hashes

Each literal definition has id `attribution-first-party-window`, version
`0.4.29`, kind `attribution`, implementation
`first-party-install-referrer-v0.4.29`, its declared `lookback_days`,
and these ordered rules:

1. `accepted-unique-exact-click-reference`
2. `redirector-to-play-server-half-open-window`
3. `install-original-receipt-revision`
4. `never-reinterpret-imported-platform-or-engagement`

SHA-256 over its RFC 8785 canonical bytes is both `definition_digest`
and `rule_bundle_hash`:

| Days | Definition/bundle SHA-256 |
| --- | --- |
| 1 | `131a7690020c426b42ba91a9fc1b28e3c679da00b37ccd40146c66939a391cac` |
| 7 | `dbb3bd7349b259a7b9e5398c5309a4e1dcb9b060d8fbf52e9d5069b5b1254a36` |
| 30 | `ec391eeaae029ee2686eb8a2aeb22b0dd1d763a8435d3c9fad145c6b03a0d705` |

The attributed artifact ID is `attr:window:` followed by SHA-256 over
JCS `["tenant-a","app-a",install.record_id,rule_bundle_hash]`.
This binds every decision to the chosen policy without rewriting the historical
`attr:<record_id>` namespace. Attribution arrays are sorted by the resulting
ID in UTF-16 order, not by policy days or installation time. Revision identifiers
are server-context provenance; they are not an extra attribution output field.

The payload hashes were calculated independently from the literal input payload
objects with generic JCS and SHA-256, not either evaluator:

| Record | Payload SHA-256 |
| --- | --- |
| `window76-1-after` | `37cf893251130655bb526fe5e3ecbbb0d844aa8fce21656fd934afc9adb77e4a` |
| `window76-1-before` | `0915bc6cb2d2da90a83afebf33e43b2f1801b840795ad83c5a7294b1da7384f4` |
| `window76-1-exact` | `37c7c80e9ebd43f16224cdc05664a2ae2f8e235f0d5a0a260d718b87431a5c84` |
| `window76-30-after` | `32655384e446cb8f9cafec2d3df334cd17a5ab5cacac117dea5e5d7a19ed5312` |
| `window76-30-before` | `9576d80f6a942d035fe486445ef571e75bff9c5a994668136b655067929eb362` |
| `window76-30-exact` | `57da4468255d43e1e7564b5af73caaaafad4eb7d289732e1ccc42e99d61fd756` |
| `window76-7-after` | `41a8ef81296dbc782302fa3dd24927fbdab1936fae0e9a32452f5646f73b11b4` |
| `window76-7-before` | `d271e64b289a83d78243026a489d5400827002b63b507ecba4f027f8ec47285a` |
| `window76-7-exact` | `6b231b0de132cb5f94e29c4a5d21d0466481edf7567fc6592f50a30fb62aa13f` |
| `window76-click` | `5978eb94aef4c73ccffabf6f4642c8f9f3878e8f241e099545ea3393c14d9b28` |

## Derivation of all thirteen output families

- `raw_records`: ten accepted records. The reviewed fixture04 admission
  template is populated from each input's scope, producer, event, timestamps
  and independently computed payload digest. Each protected reference is
  `protected:<record_id>`. Analytics consent is not required under
  `consent-v0.1`; no withdrawal, redaction or purge is requested.
- `deliveries`: ten `accepted/unique` attempts, each canonical to its own
  globally distinct record ID. No late flag or future device clock is supplied:
  timeliness is `on_time` and clock-skew suspicion is false. Protected payload
  disposition and the same explicit consent provenance are preserved.
- `logical_events`: ten active events. Their scoped identity is
  `logical:tenant-a:app-a:<producer>:<event_id>`. All event IDs are distinct
  within producer scope. Each has on-time state.
- `attributions`: nine rows derived by the inequality, evidence and identity
  recipe above. Effective time is the corresponding install occurrence time;
  the fixed server receipt supplies decision and cutoff.
- `metric_definitions`: the three unchanged reviewed reference definitions
  from fixture04. This input selects no additional metric definition or run.
- `metric_runs`, `cost_records`, `corrections`, `privacy_requests`,
  `privacy_tombstones`, `fraud_decisions`, `rejections` and
  `reconciliation`: empty. There are no metric requests, costs, corrections,
  privacy requests, fraud-triggering transport/CTIT evidence, rejected records
  or external rows. A window-expired attribution is not an ingestion rejection.

Raw records sort by record ID; deliveries by delivery ID; logical events by
their scoped logical ID; the unchanged definitions by metric name. No locale
or wall clock enters ordering or hashing. All wire versions remain `0.4.0`.

These thirteen expected families were independently constructed from the
reviewed templates, stated field mapping, integer boundaries and canonical
hash inputs. Candidate TypeScript and Python outputs were then compared against
them; neither output populated an expected file. All thirteen matched.
The combined expected-object JCS SHA-256 is
`7d436dd90947f7af74277f01637ddbd99ad4a39c7ba17218f7c2d3cf0d0d7b9d`.

No earlier 75 input or 975 golden files change. Fixture04 continues to exercise
the unconfigured default seven-day rule. The scenario also compares these
same inputs with the optional binding removed, confirming historical IDs and
default outcomes; separate evaluator tests cover replay and original-receipt
revision retention. Operational previews/activation are covered by runtime
tests, not claimed from this contract fixture.
