# OpenMasu iOS sample

`OpenMasuSampleApp.swift` shows the first-party initialization, AdServices token
handoff, custom-event, conversion-value, collection-disablement, and
installation-reset surfaces with synthetic configuration values.

For App Store measurement, call `initialize()` first, persist a request UUID in
host-owned protected retry state, and pass it to `prepareAppStoreMeasurement`.
Use `appStorePurchaseOptions(prepared:)` with the same product's StoreKit
`purchase(options:)` call. Pass a verified result to
`submitAppStoreMeasurement(result:prepared:revenueMeasurementConsent:)`.
The sample checks product and echoed token before submitting the signed JWS;
the server repeats the authoritative signature and scope checks.

The sample deliberately does not start a payment, grant content or finish the
transaction for the host. `pending` describes measurement admission only. The
host owns entitlement delivery, `Transaction.finish()`, cancelled/pending
payments, and protected measurement retries without repurchasing. Do not also
emit a client-reported purchase for the same transaction. Never log the
preparation/token/JWS. A reset or withdrawal invalidates the old measurement
context; it does not change entitlement ownership.

The sample contains no live endpoint, SDK key, Apple credential, advertising
identifier, or campaign value. Real-device and live-provider checks remain in
`docs/validation/m4-device-checklist.md`.
