# Explicit retention preview and bounded expiry

Current source can expire selected protected objects and expired request nonces.
It is **off by default**: the worker does not schedule it, no default duration
is chosen, and apply requires both an enabled explicit policy and its matching
preview receipt. The published rc.2 release does not contain this feature.

## Policy and preview

The checked-in [synthetic example](../../examples/operations/synthetic-retention-policy.json)
is disabled. In a private operator environment, copy it, choose a fixed past UTC
`as_of`, explicitly select layers/durations and set `enabled: true` only when the
intended policy is approved. Seven days is a synthetic example, not a legal or
operational retention recommendation.

```sh
npm run ops:retention -- preview --tenant=synthetic-tenant --app=synthetic-app --policy=/private/synthetic-retention-policy.json
npm run ops:retention -- apply --tenant=synthetic-tenant --app=synthetic-app --policy=/private/synthetic-retention-policy.json --receipt=<preview-digest> --limit=20
```

Use the existing private app database connection and `OPENMASU_ADMIN_KEY_FILE`
(or `OPENMASU_ADMIN_KEY`). Preview permits existing read roles; apply requires
admin capability. Both validate the registered app and optional key app scope.
Apply additionally needs the configured `OPENMASU_PAYLOAD_STORE_DIR` and
`OPENMASU_PAYLOAD_MASTER_KEY_FILE` (or the corresponding direct value). Never
put credentials in arguments, URLs or the public checkout. Preview does not
need the master key, decrypt objects, create a store, or write data/audit/jobs.

The closed preview returns only selected counts by layer, dependent/unbound run
counts, reproducibility impact, a digest receipt and `has_more_candidates`.
Record IDs, object references, nonce values and secrets are not returned. It uses
a consistent read after acquiring the existing tenant privacy fence. Unknown
legacy run dependencies block protected-object expiry rather than claiming no
impact. Unknown policy fields/layers, invalid durations and future/noncanonical
timestamps are rejected.

| Initial layer | Selection and boundary |
| --- | --- |
| `protected_payload` | Processed SDK/backend batch bodies, processed revenue inbox queries, and directly referenced encrypted raw objects, received **strictly before** `as_of - keep_days`; shared records must all be old enough |
| `expired_request_nonces` | Existing SDK/installation/server request nonces with expiry **strictly before** `as_of - grace_seconds`; equality is retained |

Pending/failed work, unfinished SDK post-processing, outstanding provider-token
work and cross-app shared objects are excluded. Credentials, provider response
objects, commerce anchors, outbound objects, privacy records, all raw/logical
ledger rows and rule/definition/run histories are not cleanup targets. Dashboard
sessions retain their existing expiry sweep. This is not a blanket object-store
or ledger purge, nor a policy for every protected object class.

## Fixed receipt and recovery

A preview selects at most 1,000 objects/nonces. `has_more_candidates` means only
this bounded page was reviewed, not the whole policy population. After completing
it, preview again for the next page. New eligible arrivals cannot expand an
already prepared receipt. Changing the policy or selected metadata before first
apply requires a new preview. Later source replacement is marked
`skipped_changed`, never deleted as the old target.

Apply seals immutable policy/target bindings in the existing PostgreSQL runtime;
only item progress can advance. Nonce bindings retain SHA-256 fingerprints, not
the nonce itself. Per-app session locks serialize concurrent applies. Each call
attempts at most `--limit` items (default 20, maximum 100); repeat the **same**
policy and receipt until `remaining` is zero. `completed` describes that receipt,
not the entire retention policy or physical bytes reclaimed.

For protected objects, apply commits `purged` lifecycle markers and an
`invalidated` item **before** touching the encrypted file/key. It then purges and
verifies that the object is unreadable before marking completion. A crash or
failed purge leaves a visible pending item; the next call retries that frozen
reference idempotently. It never generates a replacement reference or recopies
surviving facts into a supposedly reproduced run. Nonce compare-and-delete and
progress commit together. Issuance is audited with the authorizing key reference,
never its secret.

Privacy recognition can proceed while a physical purge is interrupted. It keeps
its tombstones/requests and overrides retention in report disclosure; resumption
does not append a later expiry marker over that recognized privacy state. API,
dashboard and CSV show current `retention_affected` provenance for affected saved
runs while retaining their historical artifact bytes/value. Privacy still
withdraws affected values. Ordinary correction replay and privacy restore refuse
expired evidence as `input_unavailable` instead of calculating a partial value
from whatever survives. Existing comparison evidence checks also refuse lost
inputs.

## Evidence and limits

Synthetic integration covers actual durable inbox → worker → SQL metrics,
operator CLI preview/apply, exact expiry boundaries, bounded interruption/retry,
immutable targets, nonce replacement, later arrivals, raw/revenue object expiry,
privacy concurrency, reader disclosure, retained history and foreign scopes.
Protected object/key counts are reconciled with the existing
[capacity observer](capacity.md); database allocation does not necessarily shrink
when rows are deleted. No new dependency, scheduler, service or event contract is
introduced.

No real data or live expiry is executed as repository evidence. Backup copies,
privileged filesystem replacement, credential custody and every other object
class need their own private operator policy. This command does not claim erasure
of backups or a general legal-retention guarantee.

PostgreSQL 17 [built-in binary hash functions](https://www.postgresql.org/docs/17/functions-binarystring.html)
were checked on 2026-10-25; nonce fingerprints use `sha256(bytea)` and `encode`
without an extension. SQL timestamps are fingerprinted in UTC.
