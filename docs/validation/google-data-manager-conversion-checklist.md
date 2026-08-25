# Google Data Manager conversion-delivery checklist

Checked-in tests use synthetic responses only. Complete this checklist in an authorized deployment before enabling live delivery.

## Configuration

- [ ] Create a dedicated Google credential with Data Manager access; do not reuse the Play-verification credential.
- [ ] Mount the credential outside the repository and set `OPENMASU_GOOGLE_DATA_MANAGER_SERVICE_ACCOUNT_JSON_FILE`.
- [ ] Register the exact operating-account ID, conversion-action ID, and app audience through the administrator API.
- [ ] Set the redirector remote-click parameter to `gclid` and confirm only a source-qualified Google Ads value reaches `remote_click_ref`.
- [ ] Confirm child-directed apps remain disabled.

## Authorized synthetic-to-live boundary

- [ ] Verify one authorized test conversion is accepted and its request ID reaches a terminal diagnostic state.
- [ ] Confirm a retry preserves the transaction ID and does not create a second conversion.
- [ ] Exercise quota, 429, 5xx, malformed-response, and 24-hour diagnostic-expiry procedures.
- [ ] Submit a deletion before dispatch and confirm the encrypted request becomes unreadable and no provider request occurs.
- [ ] Document Google-side retention and any supported post-dispatch retraction procedure separately; OpenMasu does not claim it.

## Primary references

Checked 2026-08-24:

- https://developers.google.com/data-manager/api/reference/rest/v1/events/ingest
- https://developers.google.com/data-manager/api/devguides/events/send-events
- https://developers.google.com/data-manager/api/devguides/diagnostics
- https://developers.google.com/data-manager/api/devguides/quickstart/set-up-access
- https://developers.google.com/data-manager/api/reference/rest/v1/requestStatus/retrieve
- https://developers.google.com/google-ads/api/docs/deprecations
