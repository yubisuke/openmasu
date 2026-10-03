# HTTP and Dashboard Boundaries

The API uses Node's HTTP server and server-rendered HTML. There is no browser
application framework, client-side state store, or dependency-injection container.
Keep the request controller, application operation, typed view model, and renderer
separate rather than adding a framework to enforce those roles.

## Request composition

`apps/api/src/server.ts` supplies the configured dependencies to
`createRequestHandler`. `routes.ts` declares each method, path, authentication
scheme, capability, mutation flag, and handler name. `router.ts` selects a route,
applies the shared authentication boundary, constructs its typed context, and
dispatches through `controllers/registry.ts`. It also owns the final error
response and operational timing/logging. It does not assemble feature HTML or
calculate report values.

The registry is a static, exhaustive `Record<RouteHandler, RegisteredController>`.
At startup it also checks that every declared handler exists and has the expected
security boundary. Aliased paths share one handler. Adding a route requires an
explicit registration; there is no discovery, plugin loader, or string-based
service lookup.

Feature controllers live in `apps/api/src/controllers/`:

| Module | Responsibility |
| --- | --- |
| `receivers.ts` | Health and the existing SDK, server-event, store, and provider receivers |
| `sessions.ts` | Dashboard login, logout, app selection, and the stylesheet |
| `apps.ts` | App registration, link domains, and app/provider configuration |
| `reports.ts` | Reports, comparisons, explanations, and dashboard report pages |
| `metric-jobs.ts` | Metric schedules and cost/privacy recalculation requests |
| `tracking.ts` | Tracking-link creation, listing, and state changes |
| `keys.ts` | SDK and server-key lifecycle |
| `operations.ts` | Delivery health, webhooks, bulk exports, and operational metrics |
| `privacy.ts` | The existing shared privacy operation |

Each factory accepts only the dependency fields it uses. Its context contains
the request, response, parsed URL, declared route, selected pool, start time, and
bounded JSON/form decoder. Administrator contexts add the authenticated identity;
dashboard contexts add the verified session and, for app routes, the registered
app identity. Controllers call existing application operations. They do not
create pools, read environment variables, or duplicate a worker lifecycle.

## Security and transport

- Administrator routes read bearer credentials, never dashboard cookies. Their
  verifier uses the app pool because its hashes are not readable by the reader
  role; read-only feature operations still use the reader pool.
- Dashboard routes read opaque session cookies, never bearer credentials. The
  configured tenant, not a request-supplied tenant, scopes session lookup. App
  routes resolve the registered app before dispatch.
- `route.mutates` selects the feature pool. Capability checks remain centralized
  for administrator and authenticated dashboard feature routes.
- Normal dashboard forms use `authorizeDashboardForm` in `http-security.ts` for
  the existing Origin and synchronizer-token checks and failed-CSRF audit.
- The ordinary JSON/form decoder retains the 32 KiB body limit. Constructing it
  does not consume the request. SDK/provider receivers retain their own raw-body
  limits and HMAC/signature authentication; bounded comparison multipart parsing
  retains its own reader and token check. Do not pre-parse those bodies in the
  dispatcher.

Login, logout, and specialized receivers retain their existing transport-specific
checks. A controller's boundary descriptor is checked against the declaration;
it is not permission to bypass that receiver's authentication.

## Typed presentation

Report selection and encoders remain shared between API and HTML routes. For the
dashboard, the path is:

```text
controller -> application/query result -> validated projection -> pure presenter -> HTML
```

`dashboard/view.ts` remains the public `buildDashboardView` application adapter.
It sorts the saved metric rows and calls `buildRetentionMatrices`, which still
validates saved definition contexts. This validation can load/compile checked-in
schemas and is deliberately outside the pure presentation layer.

`dashboard/presenter.ts` accepts that prepared projection and produces the typed
`DashboardView`. `dashboard/render.ts` consumes the view without accessing a
database, environment, filesystem, or schema compiler. Action/error pages live
in `dashboard/action-pages.ts`; HTML escaping lives in `dashboard/html.ts`.
Undefined values, chart gaps, attribution-series separation, ordering, escaping,
Content Security Policy, and zero-script HTML retain their existing meanings.

The same distinction applies to small projections:

- `measurement-notices.ts` projects health data; `measurement-health.ts` queries
  the database and preserves its public re-exports.
- `report-query-model.ts` defines/parses filters and cursors; `report-query.ts`
  retains the public API and SQL builders.
- `comparison-model.ts` projects assurance; `cohort-comparison.ts` validates
  snapshots and performs comparisons.
- `metric-recalculation-form.ts` decodes transport fields; the dashboard partial
  renders the typed result.
- Shared pure comparison functions use `@openmasu/runtime/metric-comparison`,
  not the IO-bearing runtime barrel.

`check:module-boundaries` checks the transitive value-import graph of the presenter
and render entrypoints. Type-only imports do not execute. The gate rejects
database/network/filesystem dependencies, environment access, and schema
validation/compiler imports reachable from those pure roots. It does not claim
that the application adapter itself is IO-free.

## Adding or changing a feature

1. Declare or review the route's path, authentication, capability, and mutation
   flag in `routes.ts`. Do not change a security declaration incidentally while
   moving implementation code.
2. Add the handler to its coherent feature factory and the exhaustive registry.
   Pass explicit, small dependency types and the appropriate authenticated
   context. Keep raw-body receiver authentication intact.
3. Reuse the application/query operation for JSON, CSV, and HTML. Prepare typed
   presentation data before rendering. Do not query PostgreSQL in a template.
4. Extend the relevant existing unit or integration test. Controller unit tests
   can call a handler with a synthetic context without starting an HTTP server;
   use the existing integration suite for database permissions, authentication,
   CSRF, and raw-body authentication rather than building duplicate mock suites.
5. Run `npm run typecheck`, `npm test`, and `npm run validate`. HTTP/report changes
   also require the existing runtime integration and `verify:consistency` gates.
   The checked-in HTTP API artifact must match route declarations; an
   implementation-only refactor must leave that artifact and the contract
   schemas, registries, spec, and golden fixtures unchanged.

The registry's exhaustive and security-boundary tests and the presentation import
gate run in the existing CI. No additional framework, dependency, or CI matrix is
needed to maintain this structure.
