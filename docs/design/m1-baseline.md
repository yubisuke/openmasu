# M1 Design Baseline

Status: **decided by R-22.** Each option set records the selected recommendation as `Decided (R-22)` so that WO-4 (M1a) and WO-5 (M1b) implement a fixed design rather than redesigning it.

Repository location: `docs/design/m1-baseline.md`.

Baseline commit: `main` = `1b6fa44`. Contract gate re-run on 2026-08-19: `516` `node --test` assertions pass and the summary line reads

```
Validated 26 schemas, 8 registries, 38 reviewed fixtures, 494 golden output artifacts, 38 scenario assertions, 26 acceptance criteria, deterministic TypeScript, independent Python, and RFC 8785 conformance.
```

Contract v0.2 (WO-2 consistency + WO-3 extension) is landed. The original contract handoffs are recorded as resolved under [Handoffs to contract v0.2](#handoffs-to-contract-v02).

---

## Scope

### Who M1 is for

Open MMP is self-hosted open-source software. The users are the ones already named in `docs/product-scope.md`:

- developers operating their own mobile apps,
- growth operators validating campaign-level installs,
- data teams reconciling an existing MMP, media reports, and first-party raw data.

A single M1 deployment serves **one organization with several apps**. The contract is multi-tenant and the schema keeps `tenant_id` on every row, but the deployment that M1 must make pleasant is one organization, one PostgreSQL instance, several `app_id` values. Multi-organization hosting is a later concern; the data model must not make it impossible, and nothing in M1 may assume it.

Default data scale for design purposes: a small team, **DAU 10,000 to 300,000**. Everything scale-dependent in this document is expressed as a threshold, not as a fixed choice.

### What "usable" means for M1

For an OSS deployment, usability starts before the first metric:

1. `docker compose up` on a clean clone brings up a working system with no hand-written configuration.
2. Every secret has a generator command and an entry in `.env.example`; nothing is discovered by reading source.
3. Provider mappings and processing purposes are files an operator edits, with a schema that rejects mistakes loudly.
4. The runtime reproduces the contract's own golden fixtures. That is the project's central claim and it must be mechanically checked, not asserted.

### In scope for M1

- PostgreSQL append-only ledger for the contract's artifacts plus `cost_records`.
- Three import families: existing-MMP raw export, media cost, AppLovin MAX ad revenue.
- Cohort metric engine: D0/D1/D3/D7 ROAS, retention, cohort LTV.
- Difference-audit read API.
- Admin API with authentication and an audit log.
- Docker Compose local runtime and CI with a live PostgreSQL.

### Explicitly out of scope for M1

- Any SDK. Therefore: no device ingestion endpoint, no on-device privacy-request path, no redirector, no `click_id` issuance.
- Dashboard and login (M3).
- RBAC and role granularity (M5).
- SKAN/AdAttributionKit receipt (M4b).
- Meta Install Referrer decryption (M2).
- Media postbacks to networks (out of project scope for non-SAN networks; M5 for Meta/Apple).

### Repository prerequisite satisfied before WO-4

Review decision R-17 was applied before WO-4: `json-canonicalize` is pinned to `2.0.0`, the local repair script and `postinstall` hook are absent, and Dependabot ignores the broken `2.0.1` release. M1 can therefore describe the installed dependency without a locally rebuilt substitute in its SBOM.

---

## Security baseline

The following items implement the recommendations selected by R-22.

### S-1. Authenticated surfaces in M1 (Lane F: "Ingestion API authentication")

M1 has no SDK, so the Lane F recommendation (SDK key + HMAC) has no subject yet. The surfaces that actually exist in M1 are:

| Surface | Caller | Reachable from | M1 status |
| --- | --- | --- | --- |
| Existing-MMP raw import | operator / scheduler | inside the deployment | needs an operator credential or no network surface at all |
| Media cost import | scheduler | outbound only (the deployment calls Meta/Google) | needs stored provider credentials, not inbound auth |
| MAX S2S impression postback receiver | AppLovin servers | **public internet** | needs inbound authentication |
| Admin/management API | operator | private network or public, operator's choice | needs inbound authentication |
| SDK ingestion | — | — | **M2**; designed then, not now |

**Options**

- (a) One uniform bearer-token scheme for every surface.
- (b) Per-surface schemes: no inbound surface for imports, shared-secret verification for the MAX receiver, bearer admin key for the admin API.
- (c) mTLS everywhere.

**Decided (R-22): (b).** The three surfaces have genuinely different callers. A uniform scheme forces the MAX receiver to accept a bearer header AppLovin cannot send (its postback is a plain GET with macro substitution), so (a) collapses into (b) in practice while pretending otherwise. (c) is unavailable for the MAX receiver for the same reason and raises the cost of `docker compose up` from zero to "generate and install a client certificate".

**Contract/schema impact:** none. `producer` in v0.1 already accepts `import:<provider>` (`^(sdk-android|redirector|import:[a-z0-9-]+)$`), which covers every M1 producer.

**Acceptance:** each surface has an integration test proving an unauthenticated call is refused and produces an audit row.

**M2 handoff (not decided here):** SDK key as public identifier + HMAC-SHA256 over `(method, path, sdk_key_id, body_sha256, timestamp_ms, nonce)` with the shared secret provisioned at SDK build time; replay window; key rotation with two live keys. Recorded so M1 does not preclude it: the ledger's `producer`/`event_id` idempotency already carries the replay-suppression role.

### S-2. MAX S2S impression postback: authentication, no-retry handling, idempotency

Verified from AppLovin's documentation (2026-08-18, see [References](#references)):

- Postbacks are **HTTP or HTTPS `GET`** requests to a publisher-defined URL with macro substitution.
- The feature is enabled by the AppLovin account team, not self-serve.
- **`{EVENT_ID}`** — "Unique event ID, 40 hex characters".
- **`{EVENT_TOKEN}`** — `sha1( «event-ID» + «your-event-key» )`.
- **`{EVENT_TOKEN_ALL}`** — `sha256( «All macros alphabetically as-is, _not_ URL-decoded» + «your-event-key» )`.
- "The postback request times-out if five seconds pass without a response from your endpoint. **There are no retries for postback requests.**"
- Latency: soon after the impression, possibly delayed by a few minutes.

There is **no IP allowlist and no request signature header** documented. The only available authentication primitive is the shared event key expressed through the token macros.

**Options**

- (a) Unguessable secret path segment only.
- (b) `{EVENT_TOKEN}` verification (covers the event ID only).
- (c) `{EVENT_TOKEN_ALL}` verification (covers every macro sent) + secret path segment.

**Decided (R-22): (c).** `{EVENT_TOKEN}` authenticates the event ID and nothing else, so revenue and country can be altered by anyone who observes one postback. `{EVENT_TOKEN_ALL}` is a MAC over the whole macro set, which is what a revenue feed needs. Keep (b) as a configurable fallback (`OPENMMP_MAX_TOKEN_MODE=all|event`) because token availability is an account-team setting the operator may not control, and record the mode on every accepted record so an audit can tell which guarantee applied. Compare in constant time.

**No-retry consequence — this drives the receiver architecture.** The receiver must:

1. verify the token,
2. append the raw query string to a durable inbox (`ingest_inbox`) in one INSERT,
3. return `204` — target p99 well under 1 s against the documented 5 s timeout,

and do normalization, schema validation, and ledger writes in the worker. Any design that validates against the contract synchronously risks dropping revenue permanently, because a timeout is a lost impression with no second chance.

**Idempotency.** `{EVENT_ID}` maps to the contract's `event_id`; `producer` is `import:applovin-max`. The contract's logical idempotency key `(tenant_id, app_id, producer, event_id)` therefore already suppresses duplicates, and the DB enforces it with a unique constraint (see [D-17](#data-model-ddl-sketch)). A repeated postback yields a second `event_delivery` with `duplicate_resolution = duplicate_delivery` and no second logical event — which is exactly the observable behaviour the acceptance test asserts.

**Contract/schema impact:** none required. WO-3 resolved H-4 by retaining `import:<provider>` for imported events and `adapter:<network>` for media cost.

### S-3. Advertising-identifier macros: policy enforced in code, not in prose

The MAX macro set includes `{IDFA}` ("iOS IDFA or Google Advertising ID"), `{IDFV}`, and `{IP}`. Project policy (`docs/privacy-security.md`, `AGENTS.md`) is that advertising identifiers are not collected and IP is not persisted in the application database.

**Options**

- (a) Document "do not put those macros in your URL" and trust the operator.
- (b) Parameter allowlist in the receiver: unknown or denied parameters cause the postback to be recorded as a rejection with a non-identifying reason, and the value is never written anywhere.
- (c) Allowlist plus a startup self-check that refuses to boot if the configured URL template contains a denied macro.

**Decided (R-22): (c).** The operator pastes the URL template into AppLovin's console, so the template is the actual control point and the software knows what it told the operator to paste. (a) makes an auditable claim depend on a human not making a mistake; (b) catches the mistake only after real identifiers have crossed the network boundary.

**Acceptance:** a postback carrying `idfa=` is rejected; a full-text scan of the database and the payload object store after the test finds no occurrence of the submitted value.

### S-4. Import trigger shape

**Options**

- (a) Authenticated HTTP import endpoint that accepts uploads.
- (b) Worker-driven: importers read from a configured local directory or S3-compatible bucket on a schedule and on demand via CLI.
- (c) Both.

**Decided (R-22): (b).** It removes a public write surface entirely, it matches how raw exports actually arrive (Adjust writes hourly CSV to S3; AppsFlyer Data Locker writes to cloud storage), and it makes the first-run experience "drop a file in `./import/inbox` and run `npm run import`". (a) adds authentication, upload size handling, virus/format defence, and resumability for no benefit in M1; it can be added in M3 alongside the dashboard, where a browser upload has an obvious home.

**Acceptance:** there is no route in `apps/api` that accepts a file body in M1; the route table test asserts it.

### S-5. Admin API authentication

**Options**

- (a) No authentication; bind to loopback and tell operators to use a reverse proxy.
- (b) Single admin API key, opaque 32-byte random, stored as an Argon2id/scrypt verifier, sent as `Authorization: Bearer`.
- (c) User accounts with passwords and sessions.

**Decided (R-22): (b).** (a) is the option that quietly becomes a breach the first time someone runs this on a VPS with the default Compose port mapping, and it makes the audit log actorless. (c) is M3's problem — a login UI without a dashboard to log into is wasted work, and the review already flags "dashboard before authentication" as a risk to avoid (F-15), which is satisfied by having authentication first.

Details: two keys may be active at once for rotation; the key ID (not the key) is recorded on every audit row; verification is constant-time; keys are generated by `npm run bootstrap` and printed once.

**Acceptance:** every admin route returns 401 without a key and records an audit row with `outcome=failed`; a rotation test proves both keys work during overlap and the retired key stops working.

### S-6. Duplicate and replay defence

Lane F §4 proposes a 24–72 hour `event_id + received_at` cache. That is the right instrument for a device SDK; for M1's importers it is the wrong one, because a re-imported file from three months ago must still deduplicate.

**Options**

- (a) Time-window in-memory/Redis cache of recent `event_id`s.
- (b) Permanent uniqueness enforced by a database constraint on `(tenant_id, app_id, producer, event_id)`.
- (c) Both.

**Decided (R-22): (b) for M1, with (a) reserved for M2's SDK surface.** (b) is exactly the contract's stated idempotency key, it needs no extra service in Compose, and it converts "duplicate suppression" from an application behaviour into a schema invariant. Its cost is one B-tree per ledger; at the design scale that is acceptable.

Separately, records whose authoritative time is far outside the retention horizon are classified as `timestamp_stale`, as completed for H-9 in WO-3.

### S-7. Deletion-request paths

WO-3 item 11 adds `requested_via = on_device_sdk | tenant_admin_api` and `requester_auth_ref` to `privacy-request`.

**Options**

- (a) Implement both paths in M1.
- (b) Implement `tenant_admin_api` only; accept `on_device_sdk` values from imports but do not offer a route.
- (c) Implement `tenant_admin_api` only and **reject** `on_device_sdk` at the API boundary with an explicit "not implemented in this milestone" error.

**Decided (R-22): (c).** (a) is impossible — there is no device to authenticate. (b) is worse than it looks: a contract value whose entire meaning is "the device that owns this installation_id asked" would be accepted while nothing checks that claim, which reproduces F-02 (anyone who knows an `installation_id` can delete someone's data) inside a milestone that was supposed to fix it. (c) keeps the contract field, keeps the schema honest, and makes the missing capability visible.

`requester_auth_ref` in M1 is `admin_key:<key_id>`, and the corresponding `audit_logs` row carries the full context.

**Acceptance:** a request with `requested_via=on_device_sdk` returns `501` with reason `on_device_path_not_implemented`; the admin path produces tombstones, corrections, a superseding metric run, and an audit row.

### S-8. Tenant and app isolation

The deployment is one organization, but the ledger is app-scoped and the contract's uniqueness rules are all tenant/app-scoped.

**Options**

- (a) Application-level scoping only: every query carries `WHERE tenant_id = $1 AND app_id = $2`.
- (b) PostgreSQL Row-Level Security with a per-transaction GUC: `SET LOCAL open_mmp.tenant_id = $1`, policies `USING (tenant_id = current_setting('open_mmp.tenant_id', true))`.
- (c) A database role or schema per tenant.

**Decided (R-22): (b), from the first migration.** The cost on day one is a transaction wrapper, one `ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY` and one policy per table, and one test — roughly a day. The cost of retrofitting is auditing every query written in the meantime, and the failure it prevents is silent cross-scope leakage in a product whose entire value proposition is that you can trust its numbers. (a)'s failure mode is a missing `WHERE` clause in one of a hundred queries and no signal. (c) multiplies migration and connection management by tenant count for a deployment that has one tenant.

Notes that must be in the implementation order, not discovered later:

- The application role must not own the tables and must not have `BYPASSRLS`; use `FORCE ROW LEVEL SECURITY` so the owner is also constrained when it connects as the app.
- `current_setting(name, true)` returns NULL when unset, and `tenant_id = NULL` is NULL, so an unset GUC yields zero rows. That is the fail-closed property, and it is directly testable.
- With transaction-pooling poolers, `SET LOCAL` inside the transaction is the only correct form. The connection wrapper must make it impossible to run a query outside a scoped transaction.
- `app_id` is enforced by constraints and by the repository layer rather than by a second policy, so that cross-app reporting inside one organization stays a normal query.

**Acceptance:** see M1a criterion A7.

### S-9. Audit log

`audit_logs` exists as a logical entity in `docs/architecture.md` with no schema anywhere.

**Options**

- (a) Add `audit-log.schema.json` to the contract as a twelfth artifact.
- (b) Runtime-only table, documented in `docs/architecture.md`, not part of the contract.
- (c) Runtime table now, promote to the contract if a second implementation ever needs to interoperate on it.

**Decided (R-22): (c), which is (b) in M1.** Every contract artifact today is a pure function of a fixture input, produced by both reference evaluators. An audit log is a side effect of an operator action; making it a contract artifact would force the fixture format to model operators and admin credentials, which is scope the contract does not want and WO-3 was explicitly told not to add. Documenting a fixed column set gets the auditability without the contract cost.

Columns: `audit_log_id`, `tenant_id`, `app_id` (nullable for tenant-scope actions), `occurred_at`, `actor_type` (`admin_key | system_job`), `actor_ref` (`admin_key:<key_id>` or `job:<name>`), `action` (closed vocabulary), `target_scope` (`tenant | app | record | privacy_request | metric_run | import_source | admin_key`), `target_ref`, `policy_version`, `request_digest` (SHA-256 over JCS of the normalized request, with request bodies redacted to field names), `outcome` (`succeeded | failed`), `reason_code`.

Relationship to the contract: `target_ref` uses `common#/$defs/id`; `occurred_at` uses the contract's timestamp serialization; `reason_code` reuses contract registry values where one applies and a runtime-local vocabulary otherwise. The table is append-only under the same mechanism as the ledger.

### S-10. Encryption

`docs/privacy-security.md` currently says nothing about encryption (F-14).

**At rest.** A correction to Lane F §4 first: community PostgreSQL has **no** transparent full-database encryption. At-rest encryption is a property of the storage layer (LUKS/dm-crypt, cloud disk encryption, or a managed provider's setting), not something this project can enable.

**Options**

- (a) Document at-rest as a deployment responsibility and stop there.
- (b) (a) plus application-level envelope encryption of the protected raw payload objects: AES-256-GCM, key from the secret port, key ID stored per object so rotation is possible.
- (c) Column-level encryption inside PostgreSQL.

**Decided (R-22): (b).** It is roughly a hundred lines, and it converts a promise into a demonstrable property: a PostgreSQL dump contains digests, references, and non-identifying projections, but not raw payloads. It also makes purge meaningful — destroying the object and its key entry removes the plaintext rather than relying on filesystem deletion semantics. (c) makes every query path key-aware and makes indexing hard, for evidence that is not queried by content.

**In transit.** TLS 1.2 minimum on anything reachable off-host. The default Compose topology keeps `api`/`worker`/`postgres` on a private Compose network, so intra-stack TLS is off by default with `PGSSLMODE` configurable and `.env.example` documenting `require` for a remote database. The MAX receiver must be HTTPS in production; ship an **optional** Compose profile (`--profile proxy`) with a Caddy service that terminates TLS, and document that `docker compose up` without the profile is a local-development topology.

**Acceptance:** a test writes a payload, then asserts the bytes on disk do not contain the plaintext; the purge test asserts the object cannot be decrypted afterwards.

### S-11. Rate and size limits

`docs/architecture.md` says "Validates payload size, event count" with no numbers.

**Units**

| Surface | Unit | Proposed default | Env variable |
| --- | --- | --- | --- |
| MAX receiver | token bucket per app key | 200 req/s, burst 500 | `OPENMMP_MAX_RATE_RPS`, `_BURST` |
| MAX receiver | query string size / param count | 8 KiB / 40 params | `OPENMMP_MAX_QUERY_BYTES`, `_PARAMS` |
| Admin API | token bucket per admin key | 10 req/s, burst 30 | `OPENMMP_ADMIN_RATE_RPS` |
| Import | rows per file | 20,000,000 | `OPENMMP_IMPORT_MAX_ROWS` |
| Import | bytes per file | 4 GiB | `OPENMMP_IMPORT_MAX_BYTES` |
| Import | bytes per row | 64 KiB | `OPENMMP_IMPORT_MAX_ROW_BYTES` |
| Import | commit batch | 5,000 rows | `OPENMMP_IMPORT_BATCH_ROWS` |

**Decided (R-22):** in-process token buckets, no Redis. A single-instance Compose deployment does not need distributed rate limiting, and adding Redis to Compose for this is a real cost against the self-host goal. Document that horizontally scaled deployments must move the limiter to the proxy.

Limits are refused **before** any row is inserted, so a rejected import leaves the ledger untouched.

### S-12. Secret management

**Options**

- (a) Environment variables only.
- (b) Environment variables plus a `*_FILE` convention (Docker/Kubernetes secrets) behind a `SecretStore` port; external managers documented as unimplemented adapters.
- (c) Ship a Vault/cloud-secret-manager adapter in M1.

**Decided (R-22): (b).** `.env` keeps `docker compose up` trivial; `*_FILE` is the zero-dependency path to real secret management and is what Docker and Kubernetes already speak. (c) adds a dependency and a credential-to-get-credentials problem for a milestone with one operator.

Requirements: `.env.example` lists **every** variable the code reads, with a generator command for each secret; `npm run bootstrap` writes a `.env` with fresh random secrets if none exists; a mechanical test enumerates `process.env` reads in the source and fails if any is missing from `.env.example`.

Initial variable set: `OPENMMP_DATABASE_URL` (app role), `OPENMMP_MIGRATION_DATABASE_URL` (owner role), `OPENMMP_ADMIN_KEY` / `OPENMMP_ADMIN_KEY_PREVIOUS`, `OPENMMP_MAX_EVENT_KEY`, `OPENMMP_MAX_TOKEN_MODE`, `OPENMMP_MAX_PATH_SECRET`, `OPENMMP_PAYLOAD_KEY`, `OPENMMP_PAYLOAD_KEY_ID`, `OPENMMP_PAYLOAD_STORE_URI`, `OPENMMP_IMPORT_INBOX_URI`, `OPENMMP_MAPPINGS_DIR`, `META_APP_ID` / `META_APP_SECRET` / `META_ACCESS_TOKEN` / `META_AD_ACCOUNT_ID`, `GOOGLE_ADS_DEVELOPER_TOKEN` / `GOOGLE_ADS_CLIENT_ID` / `GOOGLE_ADS_CLIENT_SECRET` / `GOOGLE_ADS_REFRESH_TOKEN` / `GOOGLE_ADS_CUSTOMER_ID`, plus the limit variables above.

### S-13. Threat-model update rule

**Options**

- (a) Prose instruction: "update the threat model at each milestone gate".
- (b) (a) plus a mechanical CI check that every component named in `docs/architecture.md` has a row in the `docs/threat-model.md` threat table.
- (c) Review-only.

**Decided (R-22): (b).** The repository already prefers mechanical cross-checks over prose promises (`AGENTS.md` requires registry enumerations to match prose, and `spec` counts to match `validate.ts` output). A twenty-line script that extracts component headings and asserts coverage costs nothing and prevents exactly the drift that produced the M0.1 documentation defects.

The M1 gate adds rows for: import worker, MAX receiver, payload object store, admin API, metric engine, PostgreSQL ledger with RLS.

### S-14. Dashboard authentication

Out of M1. What M1 owes M3 is that authentication exists *before* the dashboard: the admin API key model in S-5 is the thing M3's login sits on top of, so no milestone ships an unauthenticated surface. RBAC granularity stays M5.

---

## Architecture

### Repository layout

Target layout for M1, aligned with the README "Planned layout" without inventing directories M1 does not fill:

```text
apps/
  api/                  # admin API, MAX postback receiver, difference-audit and metric read API
  worker/               # importers, normalization, attribution, metric runs, recalculation
packages/
  contracts/            # generated types, schema + registry loading, canonical serialization helpers
  attribution-core/     # pure evaluator (moved from tools/evaluator.ts)
db/
  migrations/           # forward-only numbered .sql
  schema.sql            # committed snapshot, drift-checked in CI
  seed/
docker/
  compose.yaml, compose.proxy.yaml, Caddyfile
tools/                  # contract validation gate (validate.ts, python_evaluator.py) — unchanged
```

### D-14. Move the evaluator and generated types into `packages/`

**Options**

- (a) Leave `tools/evaluator.ts` and `tools/generated/contract-types.ts` where they are; `apps/worker` imports `../../tools/evaluator.js`.
- (b) Move `tools/evaluator.ts` → `packages/attribution-core/src/evaluator.ts` and `tools/generated/contract-types.ts` → `packages/contracts/src/generated/contract-types.ts` at the start of WO-4, as a pure move with no logic change; `tools/validate.ts` imports from the packages.
- (c) Copy into `packages/` and leave `tools/` as the contract's own copy.

**Decided (R-22): (b), as WO-4 step 0.** The evaluator is about to get a second caller; a two-caller module living in a directory documented as "validation tooling" drifts. `packages/contracts` is already the home the README promises for generated types, and the type-generation script (`npm run generate:types`) writes there instead. The move is provable: `npm run validate` stays green and `git diff -- fixtures/` is empty, because a move that changes behaviour would change goldens.

(c) guarantees divergence between the tested evaluator and the shipped one, which destroys the project's core claim. (a) is cheapest today and leaves `packages/` fictional while `apps/` reaches into `tools/`.

### D-15. npm workspaces

**Options**

- (a) npm workspaces: root `package.json` with `workspaces: ["apps/*", "packages/*"]`.
- (b) Single root package with TypeScript path aliases.
- (c) A separate monorepo tool (pnpm, Turborepo, Nx).

**Decided (R-22): (a).** One lockfile, one `npm ci`, engine pins (`.npmrc` `engine-strict=true`, Node 22.18.0, npm 11.6.2) keep working unchanged, and `npm sbom` produces per-workspace SBOMs for free. Crucially it lets `packages/contracts` and `packages/attribution-core` keep the tiny dependency surface the contract gate depends on (`ajv`, `ajv-formats`, `json-canonicalize`, `tsx`, `typescript`) while `apps/api` pulls in an HTTP server and a PostgreSQL driver. Under (b) the contract gate would install the whole runtime dependency tree, weakening the reproducibility claim and enlarging the contract's own SBOM. (c) adds a tool to learn for a four-package repository.

`npm run validate` stays a root script and keeps its exact current summary line.

### Runtime shape

Modular monolith, two processes:

- **`apps/api`** — stateless HTTP. Routes: `GET /v1/ingest/max/:pathSecret` (receiver), `POST /v1/admin/*` (apps, import sources, privacy requests, metric-run triggers, key rotation), `GET /v1/reports/*` and `GET /v1/audit/differences` (read). Writes only to `ingest_inbox` and `audit_logs`.
- **`apps/worker`** — scheduler plus job runner. Jobs: `import:mmp-raw`, `import:cost:<adapter>`, `ingest:max-inbox`, `normalize`, `attribute`, `metric-run`, `recalculate`, `retention-sweep`. Single-instance in M1, with jobs made idempotent so a crash mid-job is safe; concurrency control by PostgreSQL advisory locks, not a queue service.

No queue broker, no Redis, no object-storage service in the default Compose file. The payload store defaults to a local directory and speaks an S3-compatible interface behind a port.

---

## Data model (DDL sketch)

Not final DDL — the shape and the invariants that WO-4 must implement. All identifier columns are `text` with the contract's `^[A-Za-z0-9._:-]{1,128}$` check; all contract timestamps are `text` in the contract's exact serialization with a pattern check (see D-18).

### Roles and append-only enforcement (D-16)

```sql
CREATE ROLE openmmp_owner  NOLOGIN;              -- owns the schema; used only by migrations
CREATE ROLE openmmp_app    LOGIN NOINHERIT;      -- api + worker
CREATE ROLE openmmp_reader LOGIN NOINHERIT;      -- read-only reporting

GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA ledger TO openmmp_app;
REVOKE UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA ledger FROM openmmp_app;
GRANT SELECT ON ALL TABLES IN SCHEMA ledger TO openmmp_reader;
```

**Options for append-only**

- (a) Role grants only.
- (b) `BEFORE UPDATE OR DELETE` triggers raising an exception.
- (c) Grants as primary, triggers on the highest-value tables as defence in depth.

**Decided (R-22): (c).** Grants are the real boundary; triggers catch a future migration that accidentally grants too much, and they document the intent inside the schema where a reader of `db/schema.sql` sees it.

**Redaction under strict append-only.** Redaction is the one operation that appears to require mutation. Rather than carve out an UPDATE exception, payload availability is itself append-only:

```sql
CREATE TABLE ledger.raw_payload_states (
  state_seq        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        text NOT NULL,
  app_id           text NOT NULL,
  record_id        text NOT NULL REFERENCES ledger.raw_records (record_id),
  lifecycle_status text NOT NULL CHECK (lifecycle_status IN ('available','redacted','purged')),
  changed_at       text NOT NULL,
  privacy_request_id text,
  privacy_tombstone_id text,
  UNIQUE (record_id, lifecycle_status)          -- each transition happens at most once
);

CREATE VIEW ledger.raw_records_current AS
SELECT r.*, s.lifecycle_status AS payload_lifecycle_status
FROM ledger.raw_records r
JOIN LATERAL (
  SELECT lifecycle_status FROM ledger.raw_payload_states s
  WHERE s.record_id = r.record_id ORDER BY s.state_seq DESC LIMIT 1
) s ON true;
```

`raw_records` therefore has **no** `payload_lifecycle_status` column; the contract artifact's field is materialized by the view. The actual plaintext removal happens in the payload object store (delete the object and its key entry). This keeps every ledger table strictly INSERT-only with no exception to explain, and it matches how the evaluator already derives lifecycle from a privacy index rather than from stored state.

### Ledger tables

```sql
CREATE TABLE ledger.raw_records (
  ledger_seq       bigint GENERATED ALWAYS AS IDENTITY,
  record_id        text PRIMARY KEY,                    -- globally unique per spec §Tenant scope
  tenant_id        text NOT NULL,
  app_id           text NOT NULL,
  producer         text NOT NULL,
  producer_version text NOT NULL,
  event_id         text NOT NULL,
  delivery_id      text NOT NULL,                       -- evidence, NOT an identity (see D-17)
  event_name       text NOT NULL,
  schema_version   text NOT NULL,
  payload_sha256   char(64) NOT NULL,
  occurred_at      text NOT NULL,
  occurred_at_source text NOT NULL,
  received_at      text NOT NULL,
  received_at_ts   timestamptz GENERATED ALWAYS AS (received_at::timestamptz) STORED,
  raw_payload_ref  text NOT NULL,
  processing_purpose_id text,
  consent_evaluation_policy_version text NOT NULL,
  consent_decision_reason_code      text NOT NULL,
  withdrawal_recognized_at text,
  alternative_legal_basis_id text,
  alternative_legal_basis_policy_version text,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);
CREATE INDEX raw_records_snapshot_idx ON ledger.raw_records (tenant_id, app_id, received_at, record_id);
```

`record_id PRIMARY KEY` *is* the `record_id_collision` rule: a colliding insert fails, the delivery is rejected, and no winner is chosen — the database enforces the contract instead of the application remembering to.

```sql
CREATE TABLE ledger.event_deliveries (
  delivery_attempt_id uuid PRIMARY KEY,                 -- server-assigned (UUIDv7)
  ledger_seq          bigint GENERATED ALWAYS AS IDENTITY,
  delivery_id         text NOT NULL,                    -- producer-supplied, NOT unique
  record_id           text NOT NULL,
  canonical_record_id text NOT NULL,
  tenant_id text NOT NULL, app_id text NOT NULL,
  received_at text NOT NULL,
  ingestion_status     text NOT NULL,
  duplicate_resolution text NOT NULL,
  timeliness           text NOT NULL,
  clock_skew_suspected boolean NOT NULL,
  payload_disposition  text NOT NULL,
  reason_code text,
  processing_purpose_id text,
  consent_evaluation_policy_version text NOT NULL,
  consent_decision_reason_code text NOT NULL,
  withdrawal_recognized_at text,
  alternative_legal_basis_id text,
  alternative_legal_basis_policy_version text
);
CREATE INDEX ON ledger.event_deliveries (tenant_id, app_id, delivery_id);
```

**D-17. `delivery_id` is not a ledger identity.** Lane B B-11 established by experiment that two byte-identical deliveries produce two output rows carrying the same `delivery_id` (both `record_id_collision`). Any design that makes `delivery_id` a primary key or a unique constraint will fail on real duplicate traffic.

- (a) PK `delivery_id` — refuted by B-11.
- (b) PK `(delivery_id, record_id, received_at)` — still collides on a byte-identical retry within the same millisecond.
- (c) Server-assigned `delivery_attempt_id` PK, `delivery_id` a non-unique indexed attribute.

**Decided (R-22): (c).** It is the only option that survives byte-identical retries, and it states the semantic clearly: `delivery_id` is producer-supplied evidence. WO-3 completed H-2 by recording this rule in the contract specification.

```sql
CREATE TABLE ledger.logical_events (
  logical_event_id text PRIMARY KEY,
  record_id        text NOT NULL REFERENCES ledger.raw_records (record_id),
  tenant_id text NOT NULL, app_id text NOT NULL,
  producer text NOT NULL,
  event_id text NOT NULL,
  event_name text NOT NULL,
  record_lifecycle text NOT NULL DEFAULT 'active',      -- v0.2 two-axis lifecycle (R-2)
  timeliness text NOT NULL,
  occurred_at text NOT NULL,
  received_at text NOT NULL,
  CONSTRAINT logical_events_idempotency
    UNIQUE (tenant_id, app_id, producer, event_id)      -- the contract's logical idempotency key
);
```

That single unique constraint is what makes all three importers idempotent. It is the invariant the M1a acceptance test observes.

**Typed payload projections.** Raw payload JSON stays encrypted in the object store. Only the non-identifying, query-necessary fields are projected into narrow tables — `install_facts`, `click_facts`, `ad_revenue_facts`, `session_facts`, `purchase_facts` — each with `logical_event_id` as PK and `(tenant_id, app_id)` carried for RLS. This is where the cohort SQL runs, and it is also a privacy property worth stating: a database dump contains projections and digests, not payloads. `installation_id` lives in the projections; it is app-scoped and resettable by design, and it participates in redaction like everything else.

```sql
CREATE TABLE ledger.ad_revenue_facts (
  logical_event_id text PRIMARY KEY REFERENCES ledger.logical_events,
  tenant_id text NOT NULL, app_id text NOT NULL,
  installation_id text,                 -- NULL when the import path has no anchor (I-3; H-3 resolved in WO-3 B3)
  anchor_source text,                   -- v0.2: sdk | import_anchor
  impression_id text NOT NULL,
  ad_unit_id text, ad_network text,
  amount_unscaled text NOT NULL CHECK (amount_unscaled ~ '^[0-9]+$'),
  amount_scale int NOT NULL,
  currency char(3) NOT NULL,
  revenue_source text NOT NULL,
  country char(2),
  occurred_at text NOT NULL,
  occurred_at_ts timestamptz GENERATED ALWAYS AS (occurred_at::timestamptz) STORED
) PARTITION BY RANGE (occurred_at_ts);
```

Monthly partitions, created ahead by the worker.

### Cost records (D-19)

Media cost is restated by the networks after the fact, so it is versioned, not overwritten.

```sql
CREATE TABLE ledger.cost_records (
  cost_record_id text PRIMARY KEY,
  tenant_id text NOT NULL, app_id text NOT NULL,
  network      text NOT NULL,
  campaign_id  text,
  ad_group_id  text,                              -- NULL for Google App campaigns
  country      char(2),
  cost_date    date NOT NULL,                     -- UTC day, per the adapter's documented convention
  spend_unscaled text NOT NULL CHECK (spend_unscaled ~ '^[0-9]+$'),
  spend_scale  int NOT NULL,
  currency     char(3) NOT NULL,
  source       text NOT NULL,                     -- imported_reported | manual_csv
  as_of        text NOT NULL,
  report_snapshot_digest char(64) NOT NULL,
  cost_key_digest char(64) NOT NULL,              -- sha256(JCS({network,campaign_id,ad_group_id,country,cost_date}))
  import_run_id uuid NOT NULL REFERENCES control.import_runs,
  UNIQUE (tenant_id, app_id, cost_key_digest, as_of)
);

CREATE VIEW ledger.cost_records_current AS
SELECT DISTINCT ON (tenant_id, app_id, cost_key_digest) *
FROM ledger.cost_records
ORDER BY tenant_id, app_id, cost_key_digest, as_of DESC;
```

**Options for the dimension key**

- (a) A composite unique constraint over the nullable dimension columns.
- (b) A stored `cost_key_digest` generated from the JCS of the dimension object.

**Decided (R-22): (b).** NULLs are not equal in a PostgreSQL unique index, so (a) silently permits duplicate rows whenever `ad_group_id` or `country` is absent — which is the normal case for Google App campaigns (see I-2). (b) also matches the contract's existing digest idiom and makes the dimension set an explicit, versionable object.

Re-running an import that produces the same numbers yields the same `report_snapshot_digest`; the importer skips writing when the digest equals the latest for that key, so a repeated run inserts nothing. A genuine restatement inserts exactly one new row and leaves the old one visible.

### Metric runs

```sql
CREATE TABLE ledger.metric_runs (
  metric_run_id text PRIMARY KEY,
  tenant_id text NOT NULL, app_id text NOT NULL,
  metric_name text NOT NULL,
  metric_definition_version text NOT NULL,
  grouping jsonb NOT NULL,                        -- {campaign_id, country, cohort_date}; H-1 resolved in WO-3
  grouping_digest char(64) NOT NULL,
  input_snapshot_id char(64) NOT NULL,
  input_received_at_watermark text NOT NULL,
  input_ledger_position text NOT NULL,
  computed_at text NOT NULL,
  data_freshness text NOT NULL,
  aggregation_time_zone text NOT NULL,
  rule_bundle_id text NOT NULL, rule_bundle_version text NOT NULL, rule_bundle_hash char(64) NOT NULL,
  fx_rate text, fx_rate_source text, fx_rate_as_of text, fx_rate_snapshot_id char(64),
  fx_policy_version text, rounding_mode text NOT NULL,
  reproducibility_status text NOT NULL,
  value_type text NOT NULL,                       -- money | ratio | count; H-5 resolved in WO-3
  value_unscaled text NOT NULL,
  amount_scale int NOT NULL,
  currency char(3),                               -- NULL for ratio/count; H-5 resolved in WO-3
  supersedes_metric_run_id text,
  UNIQUE (tenant_id, app_id, metric_name, metric_definition_version, grouping_digest, input_snapshot_id)
);
```

WO-3 resolved H-1 and H-5 by adding `grouping` and `value_type` to contract v0.2, so cohort ROAS and retention can be emitted as contract artifacts.

### D-18. Timestamp storage

**Options**

- (a) Store contract timestamps as `timestamptz`, render back to the contract format on read.
- (b) Store the canonical text as authoritative, with a generated `timestamptz` column for range queries and indexes.

**Decided (R-22): (b).** Every digest in the contract — `input_snapshot_id`, `payload_sha256`, `provenance_digest` — is taken over the exact serialized string. Round-tripping through a driver's timestamp type introduces rendering differences (microsecond padding, offset formatting, session `TimeZone`) that produce a different digest for the same evidence, and the failure is silent and version-dependent. Storing the string as authoritative makes the digest reproducible by construction; the generated column gives the query performance without a second source of truth. A `CHECK` on the contract's pattern keeps garbage out.

### RLS

Applied to every table in `ledger` and `control`:

```sql
ALTER TABLE ledger.raw_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.raw_records FORCE  ROW LEVEL SECURITY;
CREATE POLICY raw_records_tenant ON ledger.raw_records
  USING      (tenant_id = current_setting('open_mmp.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('open_mmp.tenant_id', true));
```

The repository layer exposes only `withTenant(tenantId, fn)`, which opens a transaction, issues `SET LOCAL open_mmp.tenant_id`, and runs `fn`. There is no code path to a pooled connection outside that wrapper.

---

## Importers

All three share one contract-facing shape: read source rows → map to contract envelopes → run the same `packages/attribution-core` ingestion decision the fixtures test → write deliveries, raw records, logical events, rejections. No importer writes ledger rows directly.

### I-1. Existing-MMP raw export

Source: CSV or newline-JSON from a local directory or an S3-compatible bucket (`OPENMMP_IMPORT_INBOX_URI`). Adjust writes hourly CSV to S3; AppsFlyer Data Locker writes to cloud storage on Enterprise plans, and lower plans export CSV by hand — the file-based shape serves all of them.

The **public** Shadow Import Profile is the neutral column contract already promised in `spec` §Shadow reconciliation. The **deployment-private** provider mapping translates a provider's actual columns into it.

**D-20. Where the provider mapping lives**

- (a) A `provider_mappings` table, edited through the admin API.
- (b) JSON/YAML files under `OPENMMP_MAPPINGS_DIR` (default `./config/mappings`, gitignored), validated against a published JSON Schema, with worked examples committed under `examples/mappings/`.
- (c) Both.

**Decided (R-22): (b).** A mapping is a configuration artifact an operator wants in their own private git repository, diffable and reviewable; a database row without an editor is not usable until M3 builds one. Publishing a JSON Schema for the mapping file means a typo fails at load with a pointer instead of producing silently wrong attribution. (a) additionally needs admin CRUD, audit entries per field, and a migration path — real work with no M1 payoff.

**Idempotency.** Two layers:

1. Content addressing — `control.import_files` is unique on `(tenant_id, source_id, file_digest)`; re-reading an identical file is a no-op recorded as a skipped import run.
2. The contract's key — each source row's stable external identifier becomes `event_id` under `producer = import:<provider>`, so a changed file re-imported produces `duplicate_delivery` for unchanged rows and `event_id_conflict` for changed ones. That is the contract behaving as designed, not special-case importer logic.

### I-2. Media cost

**D-21. Which adapters ship in M1**

Selection criteria: what a small self-hosting team actually spends on, and how obtainable the API access is.

- (a) Meta + Google only.
- (b) Meta + Google + a generic `manual-csv` adapter.
- (c) All six from Lane D (Meta, Google, TikTok, AppLovin, Unity, Mintegral).

**Decided (R-22): (b).** Meta and Google are the two networks nearly every small app team buys from, and both expose read access to one's own account without partner status:

- **Meta Marketing API Insights** — requires the `ads_read` permission and an app; insights are available at `account`, `campaign`, `adset`, and `ad` level; `time_increment` accepts an integer of 1–90 days, so `time_increment=1` gives daily rows; `country` is a supported breakdown; large pulls use the asynchronous flow (POST returns a `report_run_id` to poll). Verified 2026-08-19 against the current `v26.0` documentation.
- **Google Ads API** — requires a developer token. A **test-account** token cannot read production accounts; **Basic Access** covers production at 15,000 operations/day; daily campaign cost comes from a GAQL query with `metrics.cost_micros` and `segments.date`, and country segmentation uses `geographic_view.country_criterion_id`. The importer resolves that criterion through `geo_target_constant.country_code`, which is ISO-3166-1 alpha-2. Verified 2026-08-19 against `v25`. Setting App campaign `ad_group_id` to null is an Open MMP normalization decision, not a verified Google guarantee.

Two integration facts that must be in the WO, not discovered during implementation:

- Google returns cost in **micros of the account currency** (scale 6), and `country_criterion_id` is a Google geo target ID, **not** an ISO-3166 code — mapping requires the geo target constants. Budget for it.
- App campaigns report at campaign and asset level; ad-group breakdown is not generally available, so `cost_records.ad_group_id` will be NULL for them. This is why the dimension digest (D-19) matters.

The `manual-csv` adapter is the highest-value third item: it unblocks TikTok, AppLovin, Unity, Mintegral, and anything else on day one by letting an operator drop an exported CSV in the inbox. Shipping it costs a fraction of one API integration.

(c) triples the M1 surface for networks whose reporting APIs each have their own auth dance, for a milestone whose purpose is to prove the ledger and the metric engine. For the remaining networks, define the `CostSource` port (`fetch(range, dimensions) → CostRow[]`, `credentials`, `snapshotDigest()`) and document it; do not implement.

**Idempotency:** see D-19. Acceptance is "run twice for the same range, row count unchanged".

### I-3. AppLovin MAX ad revenue

Two paths, both required:

**Receiver** — `GET /v1/ingest/max/:pathSecret`. Verify `EVENT_TOKEN_ALL` (or `EVENT_TOKEN` in fallback mode), reject denied parameters (S-3), append to `ingest_inbox`, return `204`. Requested macro set: `{EVENT_ID}`, `{EVENT_TOKEN_ALL}`, `{TS}`, `{REVENUE}` or `{ALL_REVENUE}`, `{PRECISION}`, `{AD_UNIT_ID}`, `{NETWORK}`, `{FORMAT}`, `{PLACEMENT}`, `{CC}`, `{PACKAGE_NAME}`, `{PLATFORM}`, `{USER_ID}`. Deliberately **excluded**: `{IDFA}`, `{IDFV}`, `{IP}`.

`{USER_ID}` is publisher-defined. With no SDK in M1, it is populated only if the operator's app already sets it in the MAX SDK. So the receiver must handle both cases: with `{USER_ID}` present, synthesize an installation anchor per WO-3's `anchor_source = import_anchor` rule; without it, the revenue is real but unanchored.

**Reporting-API fallback** — because AppLovin performs **no retries** and times out at five seconds, any receiver downtime is permanent data loss on the S2S path. A nightly MAX Reporting API pull reconciles day × ad unit × country totals and backfills the gap. Backfilled revenue is inherently aggregate.

**D-22. How unanchored and aggregate revenue is represented**

- (a) Force an anchor by synthesizing one from `{EVENT_ID}` — creates a fake installation per impression; poisons every cohort metric.
- (b) Store unanchored revenue in the ledger with `installation_id` NULL and exclude it from installation-anchored metrics while reporting it in an app-level revenue series.
- (c) Keep it out of the ledger entirely until an SDK exists.

**Decided (R-22): (b).** (a) is the failure mode this project exists to avoid — presenting a synthesized join as if it were evidence. (c) throws away the revenue total, which is most of what a hybrid-casual operator needs, and makes the MAX integration pointless in M1. (b) is honest: the app-level ARPDAU and total revenue are correct, the cohort ROAS covers only the anchored subset, and the difference is reported rather than hidden.

WO-3 Stage B3 resolved H-3: `ad_revenue` now distinguishes installation-level and aggregate subjects, and aggregate revenue forbids `installation_id`.

---

## Metric engine

### M-1. Snapshot fixation and recalculation

The contract's mechanism: an inclusive `input_received_at_watermark`; the input set is accepted, unique records with `received_at <= watermark`; snapshot rows `(received_at, record_id, lifecycle_status, policy_digest)` sorted by `(received_at, record_id)`; `input_snapshot_id` is the SHA-256 over the JCS of those rows; `input_ledger_position` is the final `received_at|record_id`.

**Options**

- (a) Recompute the snapshot from the ledger whenever needed; persist only the digest and the ledger position.
- (b) Materialize every snapshot's row list in a `metric_run_inputs` table.
- (c) Materialize only for runs explicitly flagged for audit.

**Decided (R-22): (a), with (c) available behind a flag.** The ledger is append-only and payload lifecycle transitions are monotonic and themselves append-only, so `(watermark, scope, policy_digest)` determines the row set — recomputation is exact. (b) duplicates the ledger for every metric run and every grouping, which at the design scale is the largest table in the system by a wide margin.

The honest limit, which the contract already states: after a redaction, the pre-redaction row set cannot be reconstructed. The digest of the earlier run remains, the earlier run row remains immutable, and the replacement run carries `reproducibility_status = redaction_affected` with `supersedes_metric_run_id`. The promise is explainable recalculation, not bit-identical replay.

Implementation detail worth pinning: compute inside a `REPEATABLE READ` transaction and stream the digest over an ordered index scan on `(tenant_id, app_id, received_at, record_id)`, so the digest never requires loading the snapshot into memory. And: `ledger_seq` must **never** enter the snapshot or the digest — it is a local operational counter, and including it would make the same evidence produce different digests in two deployments.

### M-2. SQL or TypeScript

Measured facts about the current evaluator, from reading `tools/evaluator.ts`:

- `evaluate()` takes the entire input in memory and calls `decide(attempt, all)` for each attempt — quadratic in record count.
- `metricRuns()` calls `installs.find(...)` inside a loop over revenue events — quadratic again.
- FX conversion is applied **per revenue event** (`value += convertMoney(item.record.payload, fxPolicy)`), so half-even rounding happens once per event and the results are summed exactly.

At fixture scale (tens of records) this is correct and fast. At 2.5 M ad-revenue rows per day it is not runnable at all. So the answer is a split, not a choice.

**Options**

- (a) Everything in the TypeScript evaluator.
- (b) Everything in SQL, with the evaluator kept only as a contract test oracle.
- (c) Split: per-record decisions in the evaluator driven by bounded candidate sets from the DB; cohort aggregation in SQL, with a mechanical parity gate against the evaluator.

**Decided (R-22): (c).**

- **Per-record decisions stay in `packages/attribution-core`.** Ingestion status, duplicate resolution, consent evaluation, click matching, and attribution all need only a bounded neighbourhood: the duplicate key `(tenant, app, producer, event_id)`, the click candidates for one `click_id` in one scope, the installation anchor for one `installation_id`. Refactor `decide()` to take a `CandidateProvider` instead of the full `all` array; the DB implementation does indexed lookups, and the fixture implementation returns the in-memory array. This preserves the project's central claim — the shipped decision code is the code the goldens test. The refactor is provable: goldens must not move.
- **Cohort aggregation goes to SQL.** D0/D1/D3/D7 revenue windows, retention, and LTV over partitioned fact tables are set operations; pulling them into Node means pulling the facts into Node.

(b) would leave the contract's evaluator as a document nobody executes in production, which is the drift the project was built to prevent. (a) does not run.

**Parity gate.** The same pattern the repo already uses for TypeScript ↔ Python: seed the synthetic fixtures into PostgreSQL through the real ingestion path, run the SQL aggregation, run the evaluator on the same fixture input, and require the two `metric_runs` sets to be **byte-identical after JCS**. A prose promise that "the SQL implements the same definition" is worth nothing; this is checkable and it fails loudly when someone edits one side.

### M-3. Half-even rounding in SQL

PostgreSQL's `round(numeric, int)` rounds half **away from zero**, not half to even. The contract mandates `rounding_mode: half_even` and the TypeScript reference implements it in `roundHalfEven(numerator, denominator)` over `BigInt`.

**Options**

- (a) Use `round()` and accept the difference.
- (b) Aggregate exact integer sums per currency in SQL and do a single conversion + rounding in TypeScript.
- (c) Implement an `IMMUTABLE` SQL function `half_even_div(numerator numeric, denominator numeric) → numeric` mirroring the TypeScript, and apply it per row exactly as the evaluator does.

**Decided (R-22): (c).** (a) produces different money for the same evidence — a defect in a system that sells reproducibility. (b) is tempting and *wrong for parity*: the reference converts and rounds **per event**, so summing first and rounding once yields different totals whenever multiple events round in the same direction. Matching the reference means matching where the rounding happens, and (c) does. The function is about ten lines of integer arithmetic (truncating quotient, remainder, compare `2r` against `d`, break the tie toward even) and it gets the existing numeric conformance vector as its test.

**Acceptance:** flipping the SQL function to half-up must fail the parity test. That is the check that the check works.

### M-4. Cohort definitions

- **Executable definitions**: `packages/contracts/src/m1b-metric-definitions.ts` is the M1b definition set. It uses the same contract objects and rule-bundle values exercised by synthetic fixture 33. The set contains D0/D1/D3/D7 ROAS, D1/D7 retention, D0/D1/D3/D7 cohort LTV in USD, and cohort install count.
- **Cohort key**: `(app_id, campaign_id, country, cohort_date)` where `cohort_date` is the install day in the metric's `aggregation_time_zone`.
- **DN revenue**: revenue events with `occurred_at ∈ [install.occurred_at, install.occurred_at + (N+1)·24h)`, converted and half-even rounded per event before exact summation — matching the existing D0 semantics rather than inventing a second convention.
- **DN ROAS**: DN revenue ÷ cost for the cohort's `(campaign_id, country, cohort_date)` from `cost_records_current`.
- **Retention DN**: distinct installations from the cohort with an event named by `activity_events` in day N ÷ cohort size. The default activity set is `["session_start"]`.
- **Cohort LTV DN**: DN revenue ÷ cohort size.

Three consequences that must be visible in the design, not discovered in the data:

1. **Organic and unattributed cohorts have no attributed cost.** ROAS for them is undefined. It is emitted with `value_state=undefined` and `undefined_reason=no_attributed_cost`, never as `0`, infinity, or part of a blended number. Acceptance criterion B8 tests this.
2. **Retention needs activity events, and M1 has no SDK.** The only source is the imported provider export, and not every provider exports sessions. Retention is computed only when the import profile carries at least one configured activity event; otherwise it is emitted with `value_state=undefined` and `undefined_reason=no_activity_events`.
3. **Cost is a spend-day fact; a cohort is an install-day fact.** `cost_records_current` supplies cost on the cohort acquisition date for the same campaign and country. This convention is part of every ROAS definition through `cost_basis: cohort_acquisition_day_current_snapshot`; alternative spend allocation must use another versioned definition.

**Implemented evidence (2026-08-19).** `ledger.half_even_div` applies conversion and half-even rounding per event before exact summation. `npm run test:metric-parity` compares SQL artifacts to the evaluator after JCS, fixes snapshot identity inside `REPEATABLE READ`, exercises late-input supersession and privacy redaction, and independently asserts the fixture-33 hand calculations: D7 ROAS `1500000` at scale 6 and D1 retention `1000000` at scale 6. The reporting API persists explicit undefined values and neutral reconciliation artifacts rather than manufacturing numeric fallbacks.

---

## Storage tiers

Lane D §4-4 and owner decision 6-6 recommended splitting the impression-revenue store into Parquet + DuckDB from day one, on an assumed scale of 10–20 M impression rows per day. Under the corrected premise — small self-hosting teams, DAU 10k–300k, and ease of standing the system up as the primary usability goal — that recommendation should be revisited.

At DAU 300,000 and 25 impressions per DAU: 7.5 M rows/day, ~2.7 B rows/year. At DAU 50,000: 1.25 M rows/day. Narrow projected rows are roughly 100–150 bytes; a monthly-partitioned PostgreSQL table with a daily pre-aggregation handles the lower half of that range comfortably.

**Options**

- (a) PostgreSQL only.
- (b) PostgreSQL ledger + Parquet/DuckDB impression tier from day one.
- (c) PostgreSQL only, behind an `ImpressionRevenueStore` port whose second adapter (DuckDB over daily Parquet) is designed and documented but not implemented.

**Decided (R-22): (c).** Two storage engines on day one doubles the parity surface (the same cohort definition implemented twice), adds a second failure mode to the first-run experience, and contradicts the "one command, no configuration" goal — for a scale most target deployments will not reach. Keeping the port costs approximately nothing and preserves the option. (a) without the port is what forces a painful migration later; (b) pays that cost immediately for benefit that is speculative at the design scale.

**Documented trigger to build the second adapter** — any one of:

- sustained impression rows above **5,000,000 per day**, or
- `ad_revenue_facts` (including indexes) above **500 GB**, or
- the daily cohort aggregation exceeding **30 minutes**, or p95 above one quarter of its scheduling interval.

The worker records rows/day, table size, and aggregation duration so the trigger is a query, not a hunch. Mitigations to apply first, in order, before adding a tier: monthly partitioning (from day one), daily pre-aggregation into `ad_revenue_daily` (from day one), then dropping raw impression rows past a retention horizon while keeping the daily aggregate.

### Recorded M1b performance floor

On 2026-08-19, `OPENMMP_BENCHMARK_ROWS=10000000 npm run benchmark:metric-floor` inserted 10,000,000 synthetic one-day revenue rows in **4,703.702 ms** and ran the per-event half-even aggregate in **5,028.475 ms**. The unlogged benchmark relation occupied **521,953,280 bytes** and produced the independently checked integer result `10000010000000`. The script rolls the table back after recording the measurement.

Environment: Node.js 22.18.0; PostgreSQL 17.11 (`x86_64-pc-linux-musl`); Windows host with 24 logical CPUs and 33,413,771,264 bytes RAM; PostgreSQL cgroup CPU and memory limits were `max`; the benchmark session allowed at most three parallel workers plus the leader and used `work_mem=64MB`. Observed container memory after aggregation was 854,376,448 bytes. This proves the arithmetic floor is far below the ten-minute trigger on the measured machine, but it is **not** an exact 4-vCPU/8-GB cgroup run. That exact capacity run remains an operator/environment verification item; no performance claim is made for real data or the full production join path. CI runs the same instrument with 100,000 synthetic rows to catch functional regressions without turning pull requests into capacity tests.

---

## Local runtime

### Compose topology (D-28)

Default `docker compose up`:

| Service | Image | Role |
| --- | --- | --- |
| `postgres` | `postgres:17-alpine` | ledger, with healthcheck |
| `migrate` | app image | one-shot, `depends_on: postgres (service_healthy)`, runs as the owner role, exits 0 |
| `api` | app image | HTTP, `depends_on: migrate (service_completed_successfully)` |
| `worker` | app image | scheduler and jobs |

Optional profiles: `proxy` (Caddy, TLS for the MAX receiver), `s3` (MinIO, to exercise S3 imports locally), `seed` (loads fixtures). DuckDB, if the second storage adapter is ever built, is in-process and needs no service.

**First-run experience — this is the acceptance target, not a nicety.** `docker compose up` on a clean clone with no `.env` must: generate `.env` with fresh random secrets, apply migrations, start `api` and `worker`, and print the admin API key once plus the MAX postback URL template to paste into AppLovin. No manual step between `git clone` and a working system.

### Migrations (D-27)

**Options**

- (a) `node-pg-migrate`.
- (b) Drizzle Kit or another ORM-owned schema.
- (c) Forward-only numbered `.sql` files applied by a small in-repo runner with a PostgreSQL advisory lock and a `schema_migrations` table.

**Decided (R-22): (c).** The DDL is part of what an auditor of this project reads; a schema generated from TypeScript models hides the RLS policies, the role grants, and the append-only triggers that are the actual security properties. The runner is roughly 120 lines, adds no dependency, and behaves identically in CI and in Compose. (a) is a reasonable second choice and cheaper to write; (b) couples the schema to an ORM this project has not chosen.

Migrations run as `openmmp_owner` via `OPENMMP_MIGRATION_DATABASE_URL`; the application never has DDL rights. `db/schema.sql` is a committed snapshot, regenerated by `npm run db:schema:dump` and drift-checked in CI.

### Seed

`npm run seed` loads the contract's synthetic fixture inputs **through the real ingestion and import code paths**, not through hand-written SQL. That way the demo data is produced by the code under test, and the seed doubles as the strongest M1a acceptance test (A3). `npm run demo:metrics` then produces a metric run and prints it, so a new user sees a number within five minutes of cloning.

---

## CI

**Keep** `contract.yml` exactly as it is — matrix `ubuntu-24.04` / `windows-2025`, `npm ci`, hash-pinned pip install, `npm run validate`, all actions pinned by full commit SHA. Its dependency surface must not grow; that is part of what makes the contract reproducible.

**Add** `runtime.yml`:

- `ubuntu-24.04` only. Windows development is supported through Docker Desktop, but Docker-in-CI on Windows runners is slow and flaky; verifying Linux and documenting the Windows path is the honest trade. State this in the workflow rather than leaving it implicit.
- `services: postgres:17` with a healthcheck.
- Steps: `npm ci` (workspaces) → `npm run db:migrate` → `npm run db:schema:check` (drift) → `npm run test` (`node --test` across workspaces) → `npm run test:integration` (importer idempotency, RLS isolation, append-only, MAX receiver, privacy path) → `npm run test:metric-parity` → `docker compose up -d --wait` smoke test (health endpoint, one valid postback, one tampered postback) → `npm run sbom`.
- All actions pinned by full commit SHA, matching the repository convention.

**SBOM (M1 release gate).**

- (a) `npm sbom --sbom-format cyclonedx` per workspace.
- (b) `anchore/syft` over the built container images.
- (c) Both.

**Decided (R-22): (a) for M1.** npm 11 ships `npm sbom`, so there is no new action to pin and no new supply-chain surface added by the tool that documents the supply chain. M1 publishes no container images, so (b) has no artifact to describe yet; add it when images are published. CI writes `sbom/<workspace>.cdx.json`, uploads them as artifacts, and **fails if any workspace lacks one** — otherwise the gate silently becomes optional.

**One more mechanical check, in the style the repo already uses:** a test that enumerates every `process.env.*` read in `apps/` and `packages/` and asserts each name appears in `.env.example`. It is the cheapest possible defence of the self-host promise.

---

## Acceptance criteria for M1a and M1b

Written as commands and observable outcomes. "Verify" means the command's output is pasted into the completion report.

### M1a — ledger and three import families (WO-4)

**A1 — one-command start.** From a clean clone with no `.env`:
`docker compose up -d --wait` exits 0; `docker compose logs api` contains the admin key line and the MAX postback URL template; `curl -fsS localhost:8080/health` returns 200.

**A2 — migrations.** `npm run db:migrate` twice in a row both exit 0 and the second is a no-op; `npm run db:schema:check` reports no diff against `db/schema.sql`.

**A3 — the runtime reproduces the contract goldens (headline criterion).** `npm run seed && npm run verify:parity` exits 0. It loads every fixture input through the real ingestion path and asserts that the DB-derived artifacts are byte-identical after JCS to the committed goldens for `raw_records`, `deliveries`, `logical_events`, `corrections`, `rejections`, `privacy_requests`, `privacy_tombstones`, `attributions`, and `fraud_decisions`. `metric_runs` is compared for the three D0 definitions with empty grouping. Any mismatch is a failure, not a note.

**A4 — MMP raw import idempotency.** Run `npm run import -- --source=<example> --file=<f>` twice.
`SELECT count(*) FROM ledger.logical_events` is unchanged between runs;
`SELECT count(*) FROM ledger.event_deliveries` doubles;
`SELECT duplicate_resolution, count(*) FROM ledger.event_deliveries GROUP BY 1` shows the second run entirely `duplicate_delivery`.
Re-running with the byte-identical file additionally records a skipped import run (content addressing).

**A5 — cost idempotency and restatement.** Run a cost importer twice for the same date range: `SELECT count(*) FROM ledger.cost_records` unchanged. Then feed a restated figure: exactly one new row; `cost_records_current` shows the new value; the prior row is still present with its earlier `as_of`.

**A6 — MAX receiver.**
(i) A postback with a valid `EVENT_TOKEN_ALL` returns 204 and `curl -w '%{time_total}'` is below 1.0 s.
(ii) A postback with one tampered parameter returns 401 and writes an audit row with `outcome=failed`.
(iii) The same `EVENT_ID` sent twice yields one logical event and two deliveries, the second `duplicate_delivery`.
(iv) A postback carrying `idfa=<value>` is rejected, and a full scan of the database and the payload store finds no occurrence of `<value>`.
(v) Boot fails with a clear error when the configured URL template contains `{IDFA}`, `{IDFV}`, or `{IP}`.

**A7 — tenant isolation.** As `openmmp_app` without setting the GUC: `SELECT count(*) FROM ledger.raw_records` returns `0`. With tenant A set, selecting a known tenant-B `record_id` returns 0 rows. Inserting a row whose `tenant_id` differs from the GUC raises a policy violation.

**A8 — append-only.** As `openmmp_app`, `UPDATE` and `DELETE` on each ledger table raise insufficient privilege. The redaction path inserts a new `raw_payload_states` row plus a tombstone and leaves the `raw_records` row byte-identical (compared by row digest before and after); the payload object no longer decrypts.

**A9 — deletion, admin path.** `POST /v1/admin/privacy-requests` with the admin key produces tombstones, corrections, a superseding metric run, and an audit row naming the actor. The same request with `requested_via=on_device_sdk` returns 501 with `on_device_path_not_implemented`.

**A10 — limits.** A file above `OPENMMP_IMPORT_MAX_ROWS` is refused before any INSERT (`SELECT count(*)` unchanged). A postback above the parameter limit returns 400. Exceeding the token bucket returns 429.

**A11 — SBOM.** `npm run sbom` produces `sbom/<workspace>.cdx.json` for every workspace; CI fails when one is missing.

**A12 — the contract gate is untouched.** `npm run validate` prints the unchanged summary line and `git diff --stat -- fixtures/` is empty.

**A13 — configuration completeness.** `npm run test:env-coverage` passes: every `process.env` name read in `apps/` and `packages/` appears in `.env.example`.

**A14 — threat model coverage.** `npm run check:threat-model` passes: every component in `docs/architecture.md` has a row in the `docs/threat-model.md` threat table.

**Explicitly not an M1a gate:** "cost totals match each network's dashboard for a real week". That requires real spend and real credentials, which an OSS milestone cannot gate on. It belongs in a documented operator procedure (`docs/validation/real-data-checklist.md`) whose results are recorded when someone with real data runs it.

### M1b — cohort metric engine and difference audit (WO-5)

**B1 — determinism and supersession.** The same watermark and policy versions produce identical `input_snapshot_id` and identical values on two runs. A later watermark that admits a new record produces a different snapshot ID and a run carrying `supersedes_metric_run_id`; the earlier run row is unchanged.

**B2 — SQL ↔ evaluator parity.** `npm run test:metric-parity` exits 0: for the seeded synthetic dataset, the SQL cohort engine's `metric_runs` are byte-identical after JCS to `packages/attribution-core`'s output for the same definitions and watermark.

**B3 — rounding conformance.** The half-even vector (including ties `0.5 → 0`, `1.5 → 2`, `2.5 → 2`) evaluated by `half_even_div` in SQL matches the TypeScript `roundHalfEven`. Changing the SQL function to half-up makes B2 and B3 fail — demonstrate it and revert.

**B4 — third oracle.** One D7 ROAS cohort and one retention D1 value are computed by hand, the working recorded in the fixture README per decision R-11, and the engine reproduces both.

**B5 — difference audit.** A reconciliation input with a withheld candidate yields `candidate_missing`; out-of-window yields `window_mismatch`; stale yields `freshness_mismatch`. Every response carries `input_snapshot_id`, `external_snapshot_id`, matching keys, candidates, exclusions, windows, joins, and freshness.

**B6 — redaction recalculation.** A deletion request after a metric run produces a replacement with `reproducibility_status = redaction_affected` and `supersedes_metric_run_id`; the prior run's row digest is unchanged.

**B7 — export consistency.** `format=csv` and `format=json` return the same numbers, and both carry metric definition version, policy versions, watermark, snapshot ID, and freshness.

**B8 — undefined ROAS is undefined.** A cohort with no attributed cost returns an absent ROAS with an explicit reason, never `0`, never infinity, and is never folded into a blended figure. Organic and unattributed cohorts are reported as separate rows.

**B9 — measured performance floor.** Seed 10,000,000 synthetic ad-revenue rows; run one day's cohort aggregation on 4 vCPU / 8 GB and **record the wall-clock time**. Proposed budget: ≤ 10 minutes. If exceeded, that is the storage-tier trigger firing, and it is a finding rather than a failure.

**B10 — unexplained differences are classified.** When an external row has no candidate and the provider marks the conversion as modeled, the reason is `provider_modeled_conversion`, not an unexplained gap. WO-3 completed H-8 by adding that reason code.

**Not an M1b gate:** "D7 ROAS within ±3% of an existing MMP on a real campaign". Same reasoning as A-final: it needs real data and a real MMP contract. It is the first item in the operator validation checklist and the natural content of the M1.5 decision gate.

---

## Open decisions

Resolved by R-22. The table records the selected recommendation for each decision.

| # | Decision | Recommendation |
| --- | --- | --- |
| D-01 | Which surfaces need inbound authentication in M1 | Per-surface, SDK deferred to M2 (S-1) |
| D-02 | MAX receiver authentication and no-retry handling | `EVENT_TOKEN_ALL` + secret path; verify-append-204, normalize async (S-2) |
| D-03 | Advertising-identifier macro handling | Allowlist + boot-time template self-check (S-3) |
| D-04 | Import trigger shape | Worker/file-driven; no public import endpoint in M1 (S-4) |
| D-05 | Admin API authentication | Single admin key, hashed verifier, two-key rotation (S-5) |
| D-06 | Duplicate/replay defence | Permanent DB unique constraint; time window is an M2 concern (S-6) |
| D-07 | Deletion-request paths in M1 | Admin path only; reject `on_device_sdk` with 501 (S-7) |
| D-08 | Tenant isolation | RLS with `SET LOCAL` from the first migration (S-8) |
| D-09 | Audit log placement | Runtime table, not a contract artifact (S-9) |
| D-10 | Encryption | At rest = deployment + envelope-encrypted payload objects; TLS 1.2+ off-host (S-10) |
| D-11 | Rate and size limits | In-process buckets, defaults tabled, refuse before insert (S-11) |
| D-12 | Secret management | env + `*_FILE` behind a port; complete `.env.example` (S-12) |
| D-13 | Threat-model update rule | Gate item + mechanical component-coverage check (S-13) |
| D-14 | Move evaluator and generated types into `packages/` | Yes, as WO-4 step 0, pure move |
| D-15 | npm workspaces | Yes |
| D-16 | Append-only enforcement | Role grants + triggers; availability as an append-only state table |
| D-17 | `delivery_id` as a key | Server-assigned `delivery_attempt_id` PK; `delivery_id` non-unique |
| D-18 | Timestamp storage | Canonical text authoritative + generated `timestamptz` |
| D-19 | Cost versioning and dimension key | Append-only with `as_of` + `cost_key_digest` |
| D-20 | Provider mapping location | Schema-validated files under `OPENMMP_MAPPINGS_DIR` |
| D-21 | Cost adapters in M1 | Meta + Google + `manual-csv`; port only for the rest |
| D-22 | Unanchored / aggregate MAX revenue | Store with NULL anchor, exclude from cohort metrics, report separately |
| D-23 | Metric engine split | Decisions in the evaluator with a candidate provider; cohorts in SQL; parity gate |
| D-24 | Half-even in SQL | `half_even_div` mirroring the reference, applied per event |
| D-25 | Snapshot fixation | Recompute from the ledger; digest + position persisted |
| D-26 | Storage tiers | PostgreSQL only behind a port; documented numeric trigger for DuckDB |
| D-27 | Migration tooling | Plain forward-only SQL + small runner |
| D-28 | Compose topology and bootstrap | 4 services + optional profiles; `.env` generated on first run |
| D-29 | CI runtime job and SBOM | New Linux-only workflow with a PostgreSQL service; `npm sbom` per workspace |
| D-30 | M1a/M1b split and non-goals | As scoped above; real-data validation is a documented procedure, not a code gate |

---

## Handoffs to contract v0.2

R-22 adopts this baseline after the contract and repository prerequisites were resolved:

- H-1 through H-12 were completed by WO-3. H-3 was completed specifically in WO-3 Stage B3.
- H-13 was completed by WO-2 follow-up A-1 before WO-4.
- No unresolved contract handoff remains for WO-4 Stage 0. Any later runtime discovery that requires a contract change must be reported as unmet work and handled by a separate work order.

---

## References

All URLs fetched and checked on **2026-08-19** unless noted.

| Topic | URL | What was confirmed |
| --- | --- | --- |
| AppLovin MAX S2S impression-level API | `https://support.applovin.com/en/max/advanced-features/s2s-impression-level-api/` | Enabled by the account team; HTTP/HTTPS `GET`; `{EVENT_ID}` = 40 hex chars; `{EVENT_TOKEN}` = `sha1(event-ID + event-key)`; `{EVENT_TOKEN_ALL}` = `sha256(all macros alphabetically as-is + event-key)`; **no retries**; 5 s timeout; macros include `{IDFA}`, `{IDFV}`, `{IP}`, `{CC}`, `{REVENUE}`, `{ALL_REVENUE}`, `{PRECISION}`, `{NETWORK}`, `{AD_UNIT_ID}`, `{USER_ID}`, `{TS}`. No IP allowlist or signature header documented. (Note: this URL resolves, unlike the `developers.applovin.com` URL Lane D found unreachable on 2026-08-17.) |
| AppLovin MAX Revenue Reporting API | `https://support.applovin.com/en/max/reporting-apis/revenue-reporting-api` | `GET https://r.applovin.com/maxReport`; UTC; JSON/CSV; 45-day maximum range; daily, country, ad-unit, network, and estimated-revenue dimensions support aggregate backfill. |
| Meta Marketing API — Insights | `https://developers.facebook.com/documentation/ads-commerce/marketing-api/insights` | `ads_read` permission required; levels `account`/`campaign`/`adset`/`ad`; asynchronous report runs exist; current examples use Graph API `v26.0`. |
| Meta Marketing API — breakdowns | `https://developers.facebook.com/documentation/ads-commerce/marketing-api/insights/breakdowns` | `country` is a supported breakdown; combination restrictions apply. |
| Meta Marketing API — ad account insights reference | `https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account/insights` | `time_increment` accepts an integer 1–90; level accepts ad/adset/campaign/account; async POST returns a report run. |
| Meta Marketing API — asynchronous best practices | `https://developers.facebook.com/documentation/ads-commerce/marketing-api/insights/best-practices` | Large reports use the asynchronous report-run polling flow. |
| Google Ads API — access levels | `https://developers.google.com/google-ads/api/docs/api-policy/access-levels` | Test-account access cannot reach production; production access is separately reviewed and quota-limited. |
| Google Ads API — Search and SearchStream | `https://developers.google.com/google-ads/api/rest/common/search` | `GoogleAdsService.SearchStream` uses GAQL and returns the complete result as a stream. |
| Google Ads API — reporting overview | `https://developers.google.com/google-ads/api/docs/reporting/overview` | GAQL through `GoogleAdsService.SearchStream`; `metrics.cost_micros`, `segments.date`, `campaign.id`, `campaign.advertising_channel_type` |
| Google Ads API — metrics v25 | `https://developers.google.com/google-ads/api/fields/v25/metrics` | `metrics.cost_micros` is an INT64 in one-millionth units of the account currency. |
| Google Ads API — `geographic_view` v25 | `https://developers.google.com/google-ads/api/fields/v25/geographic_view` | `geographic_view.country_criterion_id`, `segments.date`, `metrics.cost_micros`, and `campaign.id`. |
| Google Ads API — geo target constants v25 | `https://developers.google.com/google-ads/api/fields/v25/geo_target_constant` | `geo_target_constant.country_code` is ISO-3166-1 alpha-2 and resolves the geographic criterion ID. |
| Google Ads API — App campaign reporting | `https://developers.google.com/google-ads/api/docs/app-campaigns/reporting` | Campaign-level and asset-level (`ad_group_ad_asset_view`) reporting; no general ad-group cost breakdown documented |

**Not verified.** Stated as unverified rather than assumed:

- Whether AppLovin exposes an IP range or any second authentication factor for S2S postbacks — the documentation describes only the event-key tokens.
- Whether `{EVENT_TOKEN_ALL}` is available on every MAX account or requires a specific account-team setting.
- Whether `{USER_ID}` is populated by default for a publisher that has not set it — assumed absent.
- Whether a live Google Ads v25 `geographic_view` query accepts every selected Stage 3 field combination; credentials and real account data were intentionally not used.
- Whether App campaign ad-group cost is always absent. Open MMP normalizes this dimension to null; the official documentation did not establish that as a platform guarantee.
- Meta Insights rate limits and the row-count threshold above which the asynchronous flow becomes mandatory.
- Whether any provider's Shadow Import Profile export contains activity/session events, which decides whether retention is computable in M1 (see H-11).
- Actual row volumes for any target deployment. Every scale statement here is a threshold, not a measurement.
