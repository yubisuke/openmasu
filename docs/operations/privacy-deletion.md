# Observe privacy deletion progress

Open an app in the dashboard and select **Privacy deletion progress**. This is
a read-only view of existing deletion work, not a new deletion or retry action.
Reload to observe worker progress. It does not reveal the deletion subject,
raw record IDs, protected references, credentials, or provider responses.

An authorized read-capable administrator key can use:

```text
GET /v1/admin/apps/:app/privacy-jobs
GET /v1/admin/apps/:app/privacy-jobs/:request
```

The API uses bearer authentication, never a dashboard cookie. The equivalent
dashboard paths use an opaque session, never bearer authentication. Tenant and
optional app restrictions come from that identity; query parameters cannot
override them. Unknown and foreign requests return 404. All responses are
`no-store`. The latest 50 requests are listed with `has_more`; open a known
request ID directly to inspect an older job. This is not a complete history
export. No query filters, pagination offsets or client-selected tenant exist.

## Interpret the two separate states

| Surface | State | Meaning |
| --- | --- | --- |
| Payload | `processing` | The durable worker has not completed every recorded protected-reference purge |
| Payload | `retry_pending` | A recorded reference failed purge or unreadability verification; the existing worker retries it |
| Payload | `completed` | The worker verified the recorded references absent and committed its completion artifact |
| Recalculation | `processing` | Recorded metric items remain queued, processing or retryable |
| Recalculation | `failed` | At least one recorded metric item failed |
| Recalculation | `unavailable` | An item was skipped, lacks supported replay evidence, or completion cannot be established |
| Recalculation | `not_recorded` | No metric items are recorded for this app/request; this does not prove no metric was affected |
| Recalculation | `completed` | Every recorded metric item completed |

The response includes only the opaque request ID, request/completion times,
and counts for these closed states. Payload `failed` counts references awaiting
retry after a failed attempt, not a permanent deletion decision. Recalculation
may remain unavailable after payload removal has completed. Pending, failed,
unavailable and missing replay must never be shown as a reproduced metric.
`all_recorded_steps_completed` is true only when both recorded stages completed;
it is not an assertion that every possible downstream copy was erased.

Tenant-wide requests appear under the app that registered the request. Payload
counts describe that request's recorded purge queue; metric counts remain scoped
to that app and do not claim completion in another app. Backups, external
recipients and live filesystem/storage guarantees are outside this receipt.

If progress stalls, inspect the worker deployment and protected-store availability
using the private operator runbook; do not place subject identifiers, object
references or secrets in URLs, logs, issues or the public repository. GET does
not start, retry or complete work. Existing recognition and purge semantics are
described in [privacy and security](../privacy-security.md#access-portability-correction-and-deletion).
Restoring a backup still requires the separate
[privacy reapplication and restore procedure](backup-restore.md).

## Evidence boundary

Synthetic tests exercise a failed verification read, idempotent worker recovery,
closed projections, missing replay, cross-app/tenant isolation, and API/HTML
reads with unchanged job/audit state. The reader executes an explicit projection
owned by the existing non-login migration owner; it receives no `SELECT` grant
on either private privacy table. No live deletion or real-data proof is implied.
