# Operator Event Webhook Checklist

This optional checklist covers a private receiver and deployment. It is not a
repository code gate and does not authorize real credentials, event payloads,
subjects, campaigns, or provider data to be committed.

Record the exact OpenMasu commit and deployment configuration outside this
repository, then verify:

- [ ] the destination origin is deliberately present in
  `OPENMASU_OPERATOR_WEBHOOK_DESTINATION_ALLOWLIST`;
- [ ] the receiver has a valid production TLS certificate and rejects HTTP;
- [ ] the one-time signing secret is stored in the receiver's secret manager
  and does not appear in URLs, logs, traces, support tickets, or shell history;
- [ ] the receiver verifies HMAC over exact bytes in constant time before JSON
  parsing;
- [ ] a changed body, wrong secret, and missing signature are rejected;
- [ ] repeated deliveries with one `delivery_id` cause one receiver-side
  effect;
- [ ] `429` and `5xx` responses recover and a redirect is not followed;
- [ ] the configured timeout and attempt ceiling meet the operator's incident
  and capacity policy;
- [ ] disabling the destination stops later attempts and secret use;
- [ ] a deletion recognized before dispatch suppresses the request, while a
  request already in flight is treated as preceding recognition;
- [ ] alerts cover backlog, retry exhaustion, receiver unavailability, and
  stale job completion;
- [ ] the receiver's own retention, access, deletion, and breach procedures
  cover the event fields it accepts.

Retain only aggregate pass/fail evidence appropriate for the private operator.
Do not copy request bodies, secrets, identifiers, DNS answers, or receiver logs
into this public repository.
