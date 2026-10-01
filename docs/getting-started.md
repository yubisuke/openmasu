# Getting Started with Synthetic Data

This guide runs OpenMasu without real credentials, devices, campaigns, or
provider exports. It is the supported first experience for contributors.

Choose one path; provider settings are not a prerequisite:

| Your goal | Follow this path | What it establishes |
| --- | --- | --- |
| Understand values and comparison without Docker | [Offline comparison](#offline-shadow-comparison-without-docker) | Reference-evaluator results and explicit comparison states, not stored runtime evidence |
| Verify the full synthetic runtime and clean up automatically | [Recommended first run](#recommended-first-run) | Isolated PostgreSQL parity and HTTP smoke evidence; no persistent dashboard |
| Explore receipt, metrics and evidence in a local dashboard | [Persistent local stack](#persistent-local-stack), then [receipt to comparison](#from-receipt-to-comparison) | A disposable local instance; never seed a stack containing data you need |

These instructions describe current source. The published `v0.2.0` tag does not
contain later measurement-health, explanation, comparison-download or aggregate
CSV additions. Read [next release scope](releases/next.md) for that distinction.

## Requirements

- Node.js `22.18.0`
- npm `11.6.2`
- Docker with Compose using the local Docker context only for the disposable runtime pilot
- Python `3.13.5` only for the independent evaluator

The Node.js and npm versions must match exactly. `.npmrc` enables
`engine-strict`; `.nvmrc` and `.python-version` record the expected runtimes.

Install the Node.js dependencies required by the offline demo:

```bash
npm ci
```

Install the Python dependencies only when running the independent evaluator:

```bash
python -m pip install --require-hashes --requirement requirements-contract.txt
```

## Offline Shadow comparison without Docker

To see the core difference-explanation story before starting a database, run:

```bash
npm run --silent demo:shadow
```

The command evaluates existing reviewed fixtures and checks their selected
artifacts against the committed goldens. It reports `window_mismatch` and
`provider_modeled_conversion` as reconciliation reasons, and reports
`crowd_anonymity_suppressed` separately as an attribution reason. It uses no
real data, provider, credential, device, or production service.

This is offline evaluator evidence. It deliberately reports runtime persistence
and API evidence as `not_run`; there is no public attribution-report route for
the crowd-anonymity row. Use the disposable pilot below for the existing
PostgreSQL and runtime parity gates, but do not interpret that pilot as stored
API proof for all three demo rows.

For a complete offline value-to-comparison walkthrough, extend the **same** demo:

```bash
npm run --silent demo:shadow -- --comparison-dir=build/synthetic-comparison
```

It creates a fresh directory (including its parent) and refuses to overwrite an
existing one. Choose another directory for a second run. All outputs are synthetic:
four aggregate CSVs, their explicit mappings and snapshots, plus JSON/HTML reports.
No JSON editing, provider account or second setup tool is required.

Open these generated files locally:

| File | Result | Why |
| --- | --- | --- |
| `equal.html` | `equal`, declared comparison | The same fixture-derived D7 ROAS of 1.5 × on both sides |
| `different.html` | `different`, declared comparison | The evaluator recalculates after synthetic selected cost doubles: 1.5 × → 0.75 ×; right-minus-left is -0.75 × |
| `incomparable.html` | No numeric delta | The other evaluation uses a shorter window and its explicit declaration differs |
| `unknown.html` | No numeric delta | Ordinary comparison refuses the same inputs because saved implementation meaning is not established |

The baseline evaluator output is checked against fixture 33's reviewed golden.
The altered cost/window cases are derived at runtime without changing any golden.
All snapshots remain `operator_declared`; no database receipt or captured SQL
context is fabricated. The first two reports use explicit `--declared` mode,
not a claim of external calculation equivalence. The demo still reports
`stored_runtime_claim=not_run`. Missing, undefined and zero remain distinct.

To reproduce one generated report through the normal tools:

```bash
npm run --silent compare:cohorts -- --html --declared \
  build/synthetic-comparison/baseline.json \
  build/synthetic-comparison/different.json
```

This prints the same HTML as `different.html`. The corresponding CSV and mapping
can also be passed to `snapshot:report -- --csv` as described in
[cohort comparison](cohort-comparison.md#convert-an-aggregate-csv-offline).
Generated files under `build/` are ignored; do not commit tabular files or private
reports. A numeric difference by itself never proves its cause.

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
`OPENMASU_SDK_INBOX_BATCH_LIMIT` and `OPENMASU_MAX_INBOX_BATCH_LIMIT` control the
number of durable inbox rows processed per tenant cycle. Both default to 100,
accept 1 through 1000, preserve FIFO order, and can be changed in `.env` before
rerunning `npm run bootstrap`.

`demo:metrics` labels PostgreSQL ledger counts separately from the contract
fixture preview. The preview is not a database import or live-provider result.

## From receipt to comparison

For a dashboard walkthrough, use a **synthetic-only** persistent stack. Follow
[seed and parity](#seed-and-parity) first if you want reviewed sample values;
seeding resets that ledger, and normal writers must be stopped. Do not create
keys or send events just to see seeded results.

1. Sign in at `/dashboard` with the bootstrap admin key, select the seeded app,
   and open **Measurement health**. Its counts cover retained history, not the
   report filter. Check received batches/imports, rejections, logical events and
   metric runs. A configured key or HTTP 202 alone is not a calculated result.
2. Use **Analyze metrics** to select the date, metric, attribution status and
   cutoff. Read ratios as multipliers (1.5 × = 150%), money with currency/scale,
   and counts as exact integers. Undefined is not zero. See
   [units and filters](dashboard-analysis.md).
3. Follow **Saved run details** for the selected run. Newly computed supported
   ROAS runs show original numerator, denominator, FX and window evidence;
   legacy seeded runs can legitimately show `not_recorded`. Do not copy today's
   definition into an old run. See [calculation evidence](metric-explanations.md).
4. For one supported latest metric, an explicit cutoff and complete selection,
   use **Save comparison JSON**. The server downloads all pages within its fixed
   read-only bounds or refuses the file. Use the same declared scope for the
   second input and the [comparison tools](cohort-comparison.md). An old seeded
   run or neutral aggregate CSV can remain incomparable: do not remove unknown
   context or use `--declared` to bypass captured runtime evidence.

To observe a new synthetic input rather than seeded data, register a separate app
on the dashboard; **Register app and issue SDK key** displays the SDK secret once.
Use the existing [Android](../sdk/android/README.md), [iOS](../sdk/ios/README.md)
or [Unity](../sdk/unity/README.md) synthetic sample with that app's endpoint/key.
For a backend-only input, issue a server key in the app and follow the
[backend guide](server-to-server-events.md); do not reuse an SDK secret.
For file input, use [preview and confirm](#preview-and-confirm-an-import) instead:
an SDK key is not required. Keep all secrets out of source, logs and shell history.

| Observed state | Safe next operation |
| --- | --- |
| Configuration exists, no receipt | Check the selected app/endpoint and producer configuration; do not call it successful delivery |
| Batch pending | Check worker progress; repeated sends do not force calculation |
| Rejections recorded | Correct the explicit validation failure before retrying; do not upload private payloads for diagnosis |
| Logical events but no metric runs | Run the existing `metrics:run` with date/definition/cutoff or inspect the app's [metric schedule](scheduled-metrics.md) |
| Run exists but no comparable input | Check units, saved meaning, temporal maturity and complete selection; unknown is a valid result |

[Measurement health](measurement-health.md) describes what each observation can
and cannot establish. Metric scheduling exists; automatic cost refresh and
correction-driven recalculation are separate work, not first-run requirements.

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

## Preview and confirm an import

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

For an `mmp_raw` import, create a confirmation-bound session with the same
mapping and source file that will be committed:

```bash
npm run import:session -- \
  --source=examples/mappings/synthetic-provider-click.json \
  --file=examples/synthetic/mmp-raw-events.json
```

The command prints aggregate preview results, SHA-256 digests, and a
`confirmation_token` without opening a database pool. After reviewing the
preview, repeat the exact command with that token:

```bash
npm run import:session -- \
  --source=examples/mappings/synthetic-provider-click.json \
  --file=examples/synthetic/mmp-raw-events.json \
  --confirm=<confirmation_token>
```

The token binds the exact mapping and source bytes. A stale or invalid token is
rejected before the database pool is created. An exact repeated confirmed
import is recorded as skipped by the existing content-addressed import path.
When `OPENMASU_PUBLIC_BASE_URL` is a valid HTTP(S) URL, the committed result
also includes links to the app dashboard, stored differences, and aggregate
CSV export.

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

The first stored-difference page fixes an internal selection boundary. Later
rows and later superseding artifacts are excluded while that cursor chain is
continued. This is a database selection snapshot, not the source-event
`watermark_at_most`; start without `after` when a fresh difference view is
required. Legacy difference cursors remain readable and acquire a boundary when
they are next continued.

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
