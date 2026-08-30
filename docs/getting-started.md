# Getting Started with Synthetic Data

This guide runs OpenMasu without real credentials, devices, campaigns, or
provider exports. It is the supported first experience for contributors.

## Requirements

- Docker with Compose using the local Docker context
- Node.js `22.18.0`
- npm `11.6.2`
- Python `3.13.5` for the independent evaluator

The Node.js and npm versions must match exactly. `.npmrc` enables
`engine-strict`; `.nvmrc` and `.python-version` record the expected runtimes.

Install dependencies:

```bash
npm ci
python -m pip install --require-hashes --requirement requirements-contract.txt
```

## Recommended first run

From a clean worktree with no `.env` file or `.openmasu` directory, run:

```bash
npm run pilot:synthetic -- --disposable
```

The command creates an isolated temporary checkout and Compose project. It:

- refuses a remote Docker context;
- generates temporary local secrets and random loopback ports;
- disables live provider integrations;
- verifies the empty ledger;
- seeds all reviewed synthetic fixtures while normal writers are stopped;
- compares PostgreSQL output with committed canonical goldens;
- exercises the health, dashboard, redirector, and SDK ingest surfaces;
- removes its containers, networks, volumes, secrets, and staging directory.

The result proves that the checked-out source reproduces its synthetic contract
and runtime evidence. It does not prove provider connectivity, device delivery,
campaign accuracy, or production readiness.

## Persistent local stack

Use a persistent stack when developing or exploring the dashboard:

```bash
docker compose up -d --wait
npm run demo:metrics
```

Bootstrap generates `.env` and local secret files. The API listens on
`http://localhost:8080`, the dashboard begins at
`http://localhost:8080/dashboard`, and the redirector listens on
`http://localhost:8090` unless the generated environment selects different
host ports. `npm run bootstrap` prints the local admin key once.

`.env.example` is the complete development variable inventory, not a promise
that the bundled Compose stack forwards every production setting. The local
Compose bootstrap accepts only variables explicitly listed under its
`bootstrap.environment` block and fixes other values to safe development
defaults. At minimum, keep `OPENMASU_PUBLIC_BASE_URL` and
`OPENMASU_REDIRECTOR_BASE_URL` aligned with any host-port overrides. A custom
deployment must build and validate its own runtime environment rather than
treating this reference Compose file as a production template.

The worker runs up to four independent tenant cycles by default. Set
`OPENMASU_WORKER_CONCURRENCY` from 1 through 16 and rerun `npm run bootstrap` to
change that limit in an existing local runtime; `1` restores globally serial
processing. Every tenant still keeps its privacy, ingestion, provider, metric,
and fraud jobs in their established order within one worker process. The
reference deployment uses one worker replica because tenant/job leases do not
provide tenant-wide ordering across replicas. Raising the limit changes
database and provider load and requires deployment-specific monitoring.
`OPENMASU_WORKER_SHUTDOWN_TIMEOUT_MS` controls the bounded graceful-drain window
from 1000 through 300000 milliseconds and defaults to 30000.

`demo:metrics` labels PostgreSQL ledger counts separately from the contract
fixture preview. The preview is not a database import or live-provider result.

To submit a selected synthetic event from an app backend, issue a dedicated
server key in the dashboard and follow the
[server-to-server event guide](server-to-server-events.md). The server secret
is displayed once. Do not put it in `.env.example`, shell history, source code,
or logs.

To deliver accepted events to an operator-owned receiver, first set
`OPENMASU_OPERATOR_WEBHOOKS_ENABLED=on` and list the exact synthetic or private
HTTPS origin in `OPENMASU_OPERATOR_WEBHOOK_DESTINATION_ALLOWLIST`. Open the app
dashboard, register an operator webhook, and copy its signing secret once. The
empty allowlist and the default `off` flag both fail closed. See
[Operator event webhooks](operator-event-webhooks.md) for the closed event
vocabulary, exact-body signature, retry behavior, and deletion boundary.

For larger asynchronous delivery, enable and allowlist an operator-owned
S3-compatible origin, then register an app-scoped destination from the same
dashboard. The [operator bulk export guide](operator-bulk-exports.md) describes
the deterministic gzip NDJSON format, SigV4 credentials, immutable write and
retry behavior, cursor semantics, and downstream deletion responsibility.

To calculate a stable metric set every day, register an app-scoped durable
schedule through the admin API. The worker fixes the UTC target date and
watermark, persists crash-recovery state, and writes through the ordinary
cohort engine. Start with the checked-in synthetic configuration and the
[scheduled metric guide](scheduled-metrics.md). Keep `npm run metrics:run` for
explicit one-off or historical operator runs.

To remove only this repository's local Compose stack and its data:

```bash
docker compose down --volumes --remove-orphans
```

This is a destructive reset. Do not run it if the stack contains data you need
to keep.

The optional `proxy` profile binds only to loopback and uses Caddy's internal
development certificate authority:

```bash
docker compose --profile proxy up -d --wait
```

It is a local TLS aid, not public certificate, DNS, ingress, or production TLS
evidence. Do not expose it by changing the bind address without a deployment-
specific security review and trusted certificate plan.

## Seed and parity

The fixture seed resets the synthetic ledger. Stop all normal writers first:

```bash
docker compose stop worker api redirector
docker compose --profile seed run --rm seed
npm run verify:parity
docker compose up -d --wait
```

Use this sequence only on a disposable synthetic instance. Parity requires the
database artifacts to match the committed JSON goldens byte for byte after RFC
8785 canonicalization.

## Preview an import without writing

Use the provider-neutral compatibility report before running an import:

```bash
npm run import:compatibility -- \
  --source=examples/mappings/synthetic-provider-click.json \
  --file=examples/synthetic/mmp-raw-events.json \
  --lint-directory=examples/mappings
```

The report does not open a database connection. It evaluates mapping shape,
field coverage, row selection, and exact-money compatibility. It does not
certify a provider or compare against existing ledger state. See
[Import mapping DSL](import-mappings.md).

## Dashboard and tracking links

The local dashboard uses the generated admin key. Before creating a tracking
link, configure `OPENMASU_REDIRECTOR_DESTINATION_ALLOWLIST` with the exact HTTPS
origins the redirector may use. An empty allowlist rejects every destination.

1. Open `/dashboard` and sign in with the local admin key.
2. Register or select an application.
3. Open the application detail page.
4. Choose **Create a tracking link**.
5. Supply a destination whose origin is present in the allowlist.

Stored destinations are authoritative. Request headers and query parameters
cannot replace them.

## Paginated reports

Metric rows, aggregate record counts, and stored difference-audit rows are
bounded. JSON responses include `next_cursor` only when another page exists;
send that value back as `after` to continue the same route. Cursors are specific
to their route and a mismatched cursor is rejected. Dashboard report pages show
an explicit **Next** link rather than silently hiding additional rows.

Use `format=csv&export=true` only when the result fits within the configured
export maximum. OpenMasu returns `export_limit_exceeded` instead of a partial
CSV. A non-export CSV page exposes its continuation in `X-Next-Cursor`.

## Stop and troubleshoot

Inspect the stack without exposing generated secrets:

```bash
docker compose ps
docker compose logs --tail=100 api worker redirector
```

If the first run fails, keep the distinction between setup and product claims:

- dependency or engine failures indicate a local toolchain mismatch;
- unhealthy containers indicate a runtime setup failure;
- parity failures indicate a contract or persistence mismatch;
- a successful synthetic run still leaves all real-provider and real-device
  checks unverified.
