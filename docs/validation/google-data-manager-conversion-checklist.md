# Google Data Manager conversion-delivery checklist

Checked-in tests use synthetic responses only. They prove that one active local
claim owns a delivery, an expired claim can be recovered, a stale worker cannot
append or overwrite the recovered result, and retries retain one digest-checked
transaction ID. They do not prove exactly-once provider delivery. Complete this
checklist in an authorized deployment before enabling live delivery.

## Configuration

- [ ] Create a dedicated Google credential with Data Manager access; do not reuse the Play-verification credential.
- [ ] Mount the credential outside the repository and set `OPENMASU_GOOGLE_DATA_MANAGER_SERVICE_ACCOUNT_JSON_FILE`.
- [ ] Register the exact operating-account ID, conversion-action ID, and app audience through the administrator API.
- [ ] Set the redirector remote-click parameter to `gclid` and confirm only a source-qualified Google Ads value reaches `remote_click_ref`.
- [ ] Confirm child-directed apps remain disabled.

## Authorized synthetic-to-live boundary

- [ ] Verify one authorized test conversion is accepted and its request ID reaches a terminal diagnostic state.
- [ ] Record whether a same-transaction-ID retry after a timeout or lost response creates, updates, or suppresses a second conversion in the authorized destination; do not infer this from the local claim.
- [ ] Confirm the server-generated request ID is used only to retrieve diagnostics and is not treated as a client idempotency key.
- [ ] Exercise quota, 429, 5xx, malformed-response, and 24-hour diagnostic-expiry procedures.
- [ ] Submit a deletion before dispatch and confirm the encrypted request becomes unreadable and no provider request occurs.
- [ ] Document Google-side retention and any supported post-dispatch retraction procedure separately; OpenMasu does not claim it.

## Primary references

Checked 2026-08-30:

- https://developers.google.com/data-manager/api/reference/rest/v1/events/ingest
- https://developers.google.com/data-manager/api/devguides/events/send-events
- https://developers.google.com/data-manager/api/devguides/diagnostics
- https://developers.google.com/data-manager/api/devguides/concepts/understand-errors
- https://developers.google.com/data-manager/api/devguides/concepts/best-practices
- https://developers.google.com/data-manager/api/devguides/quickstart/set-up-access
- https://developers.google.com/data-manager/api/reference/rest/v1/requestStatus/retrieve
- https://developers.google.com/google-ads/api/docs/deprecations

The official event guide documents transaction-ID deduplication for a Google
Ads conversion action, a Google Analytics event/property, and a Floodlight
activity. The ingest response documents `requestId` as auto-generated. The
official material does not define deterministic results for concurrent or
repeated Data Manager POST requests carrying the same transaction ID, so this
repository does not claim end-to-end exactly-once delivery.
