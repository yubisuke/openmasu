# Operator bulk export checklist

This checklist separates public synthetic evidence from optional checks that
require an operator-owned storage account. Never place credentials, object
contents, bucket names, account IDs, or provider data in this repository.

## Repository-controlled gates

- [ ] `npm test` passes the official AWS SigV4 vectors and deterministic gzip
      NDJSON tests.
- [ ] Runtime CI applies all migrations and passes the role-grant matrix.
- [ ] The synthetic PostgreSQL integration registers and lists a destination
      without exposing credentials.
- [ ] A retry sends byte-identical gzip content and advances its checkpoint
      only after confirmed storage.
- [ ] Privacy recognition suppresses the pending object, purges its protected
      bytes, and produces a destination-scoped deletion row.
- [ ] `npm run validate`, threat-model coverage, environment coverage, and the
      operational-log check pass.

## Optional private operator checks

- [ ] Create a dedicated bucket/prefix and a least-privilege credential with
      object write plus metadata-read permission and no bucket deletion power.
- [ ] Configure the exact HTTPS origin allowlist and enable the worker only in
      the intended deployment.
- [ ] Verify one synthetic object in the operator-owned account, its content
      type/encoding, metadata digest, lifecycle policy, encryption, and access
      logs.
- [ ] Verify repeated delivery does not overwrite an existing object and a
      mismatched object becomes an alertable conflict.
- [ ] Exercise credential rotation by registering a new destination and then
      disabling the old destination.
- [ ] Exercise a synthetic deletion notice and verify the downstream deletion
      procedure, replicas, archives, and backups.
- [ ] Record throughput, object-size distribution, retry alerts, retention,
      cost, incident response, and recovery evidence outside this public repo.

An unchecked private item is an open operator gate, not a failed repository
test. No live storage integration or production-readiness claim follows from
the synthetic gates.
