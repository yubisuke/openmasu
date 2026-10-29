# Single-host deployment boundary

Use the **one existing `compose.yaml`**: PostgreSQL 17, migration, API, worker and
redirector on one Docker host. Build from an exact annotated source release tag;
do not track a moving `main` checkout or describe a source candidate as deployed.
The published target is `v0.3.0-rc.3`; rc.2-to-current upgrades remain unsupported.
Existing deployments first follow [Safe upgrade](upgrade.md). This guide is an
operator configuration path, not evidence of a live or production installation.

## One layout

```text
Internet -> operator-owned CA-trusted HTTPS reverse proxy
                         | loopback only
                  API :8080 / redirector :8090
                         | Compose backend
                  PostgreSQL :5432 / worker
```

| Boundary | Existing storage or behavior |
| --- | --- |
| Database | `postgres-data` named volume; never ephemeral container storage |
| Payload | `payload-objects`, encrypted objects **and** wrapped keys |
| Secrets | `migration-secrets`, `app-secrets`, `seed-secrets`, `postgres-secrets` volumes, plus private checkout `.env`; preserve the complete matched set |
| Public endpoints | Operator HTTPS API and separate redirector origins; the host's API/redirector/PostgreSQL listeners stay `127.0.0.1` |
| Service network | Backend internal network; explicit service egress/host bridge remains part of existing Compose |
| Proxy trust | Configured public origin controls redirects, cookies and Origin checks; forwarded IP/proto headers do not grant identity or override it |
| Rate limits | Socket peer is used; behind the host proxy it may group clients together. Do not advertise per-user client-IP accuracy or add arbitrary trusted forwarding headers |

An edge/CDN may front the operator proxy, with caching disabled for authenticated
API/dashboard responses. PostgreSQL, protected payloads and durable worker jobs
remain on the host: an edge function alone is not this runtime. No extra DB,
Kubernetes stack, managed service or cloud account is required by repository tests.

## Configure before first bootstrap

1. Use a dedicated private directory and a stable project name such as
   `openmasu-service`. Keep it distinct from any synthetic/pilot project. Record
   the name, ports, release/tag commit and volume ownership privately. Do not use
   `COMPOSE_PROFILES=*` or a shared/moving checkout. Restrict filesystem/Docker
   access; bootstrap's repository bind mount writes private `.env` there.
2. Copy [the non-secret environment template](../../examples/deployment/single-host.env.example)
   and [configuration declaration](../../examples/deployment/single-host.json)
   **outside the public repository**. Set exact HTTPS origins and destinations in
   both. Keep optional providers/exports off. Do not reuse example identities for
   live data. `.env.example` is the development inventory, not production secrets.
3. Install pinned Node/npm/Python and Docker/Compose. Check out the published tag,
   use `npm ci`, and confirm a clean checkout. All commands below use the same
   explicit project/env file. Do not put secrets in those command arguments.
4. Generate secrets once, before exposing services. Bootstrap creates random
   secrets, never a default production key. Its first output contains an admin
   key and signed URL; capture it in a permission-restricted private log and do
   not attach it to CI, GitHub, tickets or public evidence:

   ```bash
   umask 077
   docker compose --project-name openmasu-service --env-file /private/deployment.env run --rm bootstrap > /private/bootstrap.log
   npm run deploy:preflight -- --config=/private/single-host.json --runtime-env=.env
   ```

   Preflight is read-only. It checks the exact clean annotated target, closed
   configuration, HTTPS origins, nonempty exact-origin allowlist, runtime URL/
   allowlist agreement and core secret presence/size. Refusals distinguish empty
   allowlists, development TLS, URL mismatch, missing/unsafe secrets and unknown
   release identity. No secret values, private paths or input URLs are printed.
   TLS mode/certificate kind are **operator declarations**: `tls_verified: false`
   and `production_verified: false` remain in every result. The command does not
   contact a domain, issue a certificate or verify a live certificate chain.
5. Terminate publicly trusted TLS in your operator reverse proxy and forward each
   configured origin unchanged to its loopback endpoint. Restrict direct host
   access and management ports. Confirm DNS, certificate chain/renewal, request
   body/HMAC preservation, CSRF Origin, secure cookies, no-store caching and
   intentional proxy rate-limit policy privately before any real traffic.
   **Do not use the repository `proxy` profile for public deployment**:
   `config/Caddyfile` uses `tls internal`, a development/local CA. Merely turning
   the profile on does not create trusted public TLS.

## Normal start, stop and restart

```bash
docker compose --project-name openmasu-service --env-file /private/deployment.env up -d --wait
docker compose --project-name openmasu-service --env-file /private/deployment.env restart api worker redirector
docker compose --project-name openmasu-service --env-file /private/deployment.env up -d --wait
```

Normal `up` applies only missing forward migrations, reuses existing secrets and
named volumes, and does not enable the `seed` profile. Do not edit generated
credentials independently of their secret volumes; an incomplete set refuses
bootstrap. Origins/allowlist and worker limits stay bound to the protected runtime
environment: changing a Compose env file alone does not update an existing
deployment. Use the explicit configuration operation below; do not edit generated
runtime files by hand.

To stop, use `stop worker api redirector` before stopping PostgreSQL; keep volumes.
Keep the default `OPENMASU_DEPLOYMENT_PURPOSE=persistent` before first bootstrap.
It is recorded in protected bootstrap settings and the database; later profile or
env changes cannot promote this deployment to disposable. Bootstrap issues no seed
credentials, and migration removes the seed role's table-write/reset privileges.
Seed/reset rejects missing or non-disposable purpose before modifying the ledger.
This does not protect privileged SQL, volume removal, or backup deletion: never
run `down --volumes` against this project. Use `pilot:synthetic` only for its
separate disposable synthetic environment.
For upgrades, backup or failures use the [upgrade](upgrade.md) and
[backup](backup-restore.md) runbooks; do not automatically reopen traffic after an
incomplete migration or privacy reapplication.

## Change existing non-secret configuration

This command is in current source, not the frozen rc.3 release. Use a release
that contains it and build its existing Compose image before following this
procedure. It does not upgrade binaries or create a second deployment.

The closed setting list is API/redirector public origins, the redirect destination
allowlist, worker concurrency/shutdown timeout, SDK/MAX inbox batch limits, and
AdServices provider timeout/claim lease. Public origins must be exact HTTPS
origins; HTTP is accepted only for localhost/loopback synthetic use. Empty
destination allowlist means deny all custom HTTPS destinations. Shell syntax,
credentials in URLs, paths, query strings and fragments are rejected. Numeric
bounds are the same as initial bootstrap; provider timeout must remain below its
claim lease.

1. Save only the desired settings to a private JSON file, for example:

   ```json
   {
     "OPENMASU_PUBLIC_BASE_URL": "https://metrics.example.invalid",
     "OPENMASU_REDIRECTOR_BASE_URL": "https://links.example.invalid",
     "OPENMASU_REDIRECTOR_DESTINATION_ALLOWLIST": "https://app.example.invalid",
     "OPENMASU_WORKER_CONCURRENCY": "4"
   }
   ```

2. Obtain a read-only plan and inspect its changed values, unsupported key names,
   restart list and `receipt`. Secret/identity/provider-activation/host-port
   settings are unsupported; their submitted values are never printed. A `null`
   previous value means it was absent or an unsafe legacy value was withheld.

   ```bash
   npm run deploy:config -- plan --project=openmasu-service --env-file=/private/deployment.env --file=/private/settings.json
   ```

3. Stop incoming traffic and all writers. Ensure no other operator or automation
   starts services during the change. Apply the exact receipt from the plan:

   ```bash
   docker compose --project-name openmasu-service --env-file /private/deployment.env stop api worker redirector
   npm run deploy:config -- apply --project=openmasu-service --env-file=/private/deployment.env --file=/private/settings.json --receipt=<64-character-receipt>
   docker compose --project-name openmasu-service --env-file /private/deployment.env up -d --wait
   ```

   Apply refuses running, paused or restarting writers, a wrong project, stale
   files or invalid settings. It never stops/starts services itself. A fixed
   one-shot container name prevents concurrent configuration commands. Docker
   access is privileged; this is an operational guard, not protection against a
   host administrator deliberately bypassing it.

The operation replaces only `app/runtime.env` and the private checkout `.env`,
using fsynced temporary files and atomic rename for each file. Other entries,
tenant/app identities, admin/payload/SDK/database keys and the ledger are kept.
If a later replacement fails, both old files are restored. If the process is
interrupted, a permission-restricted recovery journal remains in the app secret
volume and normal bootstrap refuses to continue. Keep writers stopped and retry
the same apply with its original receipt: it restores both originals before
reapplying. If a stopped configuration container retained its name after a Docker
failure, remove only that exact `<project>-config-operation` container after
confirming it is no longer running; never remove its volumes. Do not publish the
journal: it contains the original private environment files. Filesystem/disk loss
that prevents rollback requires operator recovery from the preserved journal or
backup; never reopen traffic on a partial configuration.

Normal bootstrap does not revert applied worker controls or origins to inherited
Compose defaults. Keep the private deployment declaration and external env file
aligned with the new non-secret settings for future host recreation and repeat
`deploy:preflight`. Provider activation/secrets and host port changes are outside
this operation; existing provider-specific setup procedures still apply.

## Evidence and residual boundary

The existing disposable pilot now restarts API/worker/redirector and repeats
normal `up` without another seed. It compares seeded ledger counts and secret
identity, then runs the existing HTTP smoke gate; only pass/fail enters public
evidence, never secret values or their fingerprint. Isolation and cleanup remain
scoped to the unique synthetic project. This adds no second deployment stack or
duplicate fresh-install suite. The same pilot plans a synthetic origin/allowlist
change, refuses apply with running writers, applies while stopped, restarts and
checks allowed/denied links and the bound dashboard Origin, then restores the
original settings. Its ledger-count and secret-identity checks remain unchanged.
Unit tests cover invalid/stale plans, unsupported-value redaction, rollback and
interrupted-apply recovery; pure preflight tests cover unsuitable settings.

Actual domains, publicly trusted TLS, secret custody, host hardening, Docker
privileges, backups/restores, alerts, costs and representative capacity remain
unverified operator gates. A source candidate, valid static configuration or
green synthetic pilot does not make this a production-ready deployment.

Primary references checked on 2026-10-02:

- https://docs.docker.com/compose/how-tos/profiles/
- https://docs.docker.com/compose/how-tos/networking/
- https://caddyserver.com/docs/automatic-https
