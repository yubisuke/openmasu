# Google conversion destination readiness

This adapter sends the existing narrow, source-qualified-click and verified-purchase
projection. It is **not** an App Campaign/MMP partner integration, a provider access
test, or an automatic refund/restatement sender. It collects no additional user
data or identifiers to make an unsupported destination work.

## Supported configuration

The supported destination is a Google Ads `UPLOAD_CLICKS` action owned by the
10-digit operating account, enabled, with the deployment credential having direct
write access to that account. Manager and partner access paths are not implemented
by this adapter. Google Play, Firebase, third-party app analytics and other action
types cannot be substituted merely because their IDs are numeric.

The administrator supplies a sanitized **operator review**, not raw provider
responses or credentials. Unknown action/status/access, denied permission, a
mismatched owner/action, unsupported purpose and child-directed audience block
activation. These are configuration checks. `live_access_verified` always remains
`false`: an operator assertion does not establish Google's acceptance or current
credential permissions. Private qualification remains an operator task outside
this public repository and outside synthetic CI.

## Preview, activate and inspect

On the app dashboard, select **Review destination readiness and revision history**.
Review the exact action and credential access, enter only the bounded metadata,
then preview. Preview performs no provider I/O, activation or outbox creation.
The second form activates the reviewed definition, or saves a disabled revision.
All configuration routes require an administrator; session forms retain CSRF and
Origin checks. API equivalents:

```text
GET  /v1/admin/apps/<app-id>/google-data-manager
POST /v1/admin/apps/<app-id>/google-data-manager/preview
POST /v1/admin/apps/<app-id>/google-data-manager
```

Synthetic preview body:

```json
{
  "operating_account_id": "1234567890",
  "conversion_action_id": "987654321",
  "app_audience": "general",
  "enabled": true,
  "readiness": {
    "source": "operator_review",
    "action_type": "UPLOAD_CLICKS",
    "action_status": "ENABLED",
    "action_owner_account_id": "1234567890",
    "conversion_action_id": "987654321",
    "access_model": "direct",
    "permission": "granted",
    "purpose": "click_import"
  }
}
```

Activation sends the returned `definition` fields plus `preview_digest` and
`expected_revision` (0 before the first configuration). The digest confirms the
definition, not human review. A stale revision returns 409. Each success appends
the definition, digest, readiness result, time and audit entry; no prior definition
is overwritten. History returns the latest 50; older revisions remain in PostgreSQL.
Disabling does not require a positive readiness result, but still requires the
current revision. Deployment-wide enable/credential configuration remains separate.

## Queue and migration behavior

- Discovery reads the immutable active definition, binds its revision and rechecks
  under the destination row lock before enqueueing. Activation uses that same lock.
- A successor stops old **queued** ingestion, including an old retry. The worker
  records `destination_revision_inactive` and purges its encrypted body; it never
  rewrites a request or moves it to the successor action. This favors no unexpected
  resend over silently continuing a retired target.
- Requests already started can complete. Accepted requests keep the original
  provider request ID and revision for diagnostics, even after replacement.
  Disabling prevents subsequent provider calls; it cannot recall a request that
  already started. Privacy/claim fencing remains in force.
- The logical verification/destination deduplication key does not include revision.
  Previously queued or sent conversions are not rediscovered for a new action.
- Delivery-result artifacts retain the destination ID and revision after payload
  removal. Existing encrypted bytes are never rebuilt during activation.
- On upgrade, old numeric settings are retained as revision 1 with readiness false,
  and delivery is disabled pending explicit review. Old queues have no trustworthy
  revision binding and are safely failed if the worker later processes them. They
  are not rebound to a newly activated configuration. Review this change before
  upgrading a deployment that previously enabled this adapter.

## Adjustments and external limits

No refund/restatement path is enabled. Google documents matching adjustments by
transaction ID within the same action; an unmatched event can become a new
conversion, and identifiers are still required. Local purchase/refund evidence or
HTTP acceptance alone does not prove those matching conditions. The adapter retains
its existing stable transaction ID, bounded retries and diagnostics, without an
end-to-end exactly-once claim.

## Primary references

Checked 2026-11-06; only synthetic data was used in repository verification.

- [Offline conversion destination requirements](https://developers.google.com/data-manager/api/devguides/events/google-ads/offline/send-events)
- [Advertiser direct and manager access paths](https://developers.google.com/data-manager/api/devguides/concepts/destinations)
- [Destination resource](https://developers.google.com/data-manager/api/reference/rest/v1/Destination)
- [Adjustment matching and unmatched-event behavior](https://developers.google.com/data-manager/api/devguides/events/google-ads/conversion-adjustments)

See the separate [private operator checklist](../validation/google-data-manager-conversion-checklist.md)
for live access, credential, duplicate, quota and retention evidence. Passing local
readiness or synthetic tests does not complete that checklist.
