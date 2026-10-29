# First-party attribution window

An administrator can select **1, 7 or 30 days** for native first-party Install
Referrer attribution. These are internal measurement policies, not claims about
an advertising provider's attribution rules. The historical seven-day policy
remains the default until an administrator explicitly activates the new family.

## Preview and confirm

1. Sign in to the dashboard with an app-authorized administrator key. Open the
   app's **First-party attribution window** setting.
2. Select a candidate window, at most 31 UTC install-occurrence days (inclusive
   start, exclusive end), and a fixed server receipt cutoff.
3. Inspect current/candidate reason counts, changed decisions, evidence counts,
   hashes and any unavailable-evidence warnings. This read-only counterfactual
   is before fraud exclusions; it does not recalculate saved metrics or forecast
   live performance. It is limited to 1,000 native first-party installations and
   2,000 exactly referenced clicks, without a seven-day candidate-fetch cutoff.
4. Confirm activation. The server rechecks the current predecessor, definition,
   evidence digest and scope under the existing privacy fence and app bundle
   lock. A changed receipt, another activation, missing evidence or active
   privacy deletion requires a new preview. Empty evidence is unavailable, not
   a zero-impact approval.

The settings page displays the effective window, exact hash and activation time.
No new service, environment setting, scheduler or automatic backfill is involved.

## API

`POST /v1/admin/apps/:app/rule-bundles/preview` accepts:

```json
{
  "definition": {
    "id": "attribution-first-party-window",
    "version": "0.4.29",
    "kind": "attribution",
    "implementation": "first-party-install-referrer-v0.4.29",
    "lookback_days": 30,
    "rules": [
      "accepted-unique-exact-click-reference",
      "redirector-to-play-server-half-open-window",
      "install-original-receipt-revision",
      "never-reinterpret-imported-platform-or-engagement"
    ]
  },
  "date_from": "2026-08-01",
  "date_to": "2026-08-08",
  "watermark_at_most": "2026-08-12T00:00:00.000Z"
}
```

Send the same definition to `POST /v1/admin/apps/:app/rule-bundles` with
`rule_bundle_id`, `rule_bundle_version`, the candidate `rule_bundle_hash`, and
`preview: {receipt, date_from, date_to, watermark_at_most}` from that response.
When `baseline_revision_id` is non-null, also include it in `preview` and as
`supersedes_rule_bundle_revision_id` on the activation body. A receipt is required
even for the first opt-in activation. Definitions are closed and cannot add
custom rule code, arbitrary days or platform settings. The stored activation
retains the receipt, evidence digest and date/cutoff bounds. Responses expose
aggregate counts and digests, not installation IDs, payloads or credentials.

## Meaning and history

The window is half-open: `0 <= install_begin_at_server - redirector_click_at <
lookback_days * 86,400,000`. Exact upper-bound equality is expired. Device clocks
never replace either authoritative time. Existing missing/invalid/ambiguous
click, bot/prefetch, fraud and privacy rules remain in force.

The independent bundle `attribution-first-party-window` version `0.4.29` binds
the complete definition with SHA-256 over RFC 8785 JSON canonical bytes. Each
new-family attribution ID includes a deterministic digest of tenant, app,
install record and bundle hash. Existing `attribution-default` definitions,
seven-day decisions and IDs are not changed, including when the new family
explicitly selects seven days.

Runtime resolves the immutable revision effective at each installation's
**original server receipt**, not the current worker clock. Late-click processing
also retains an already recorded attribution's bundle. Activating a different
window cannot rewrite past installations, stored attribution results, metrics
or snapshots. Newly received installations may use the new revision; late
receipts and occurrence dates therefore remain distinct. There is no automatic
historical recomputation. The current-policy preview is hypothetical and does
not promise its counts will become saved metrics after activation.

Imported/provider-reported attribution, platform evidence, organic/no-referrer
classification, Apple aggregate postbacks and engagement attribution are not
reinterpreted. Selected first-party metric profiles consume qualifying stored
installation attribution as before; their own definitions and hashes do not
change. This configuration is not a provider-equivalence, production-quality
or real-device validation claim. Validation uses synthetic evidence only.
