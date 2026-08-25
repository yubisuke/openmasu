# M3 Design Baseline

Status: **decided (R-25).** Every recommended option in M3-D-01 through M3-D-30 is adopted. WO-7 implements this fixed design rather than redesigning it.

Repository location when adopted: `docs/design/m3-baseline.md`.

Baseline: contract `0.3.0`; `main` includes M0.3, M1a, M1b, and the accepted M2 Android/Unity implementation. This document was adopted on 2026-08-20 after M2 merged.

Decision numbering is `M3-D-01 … M3-D-30` and is identical in this document and in `m3-baseline-decisions.ja.md`. References of the form `M1 D-06` point at `docs/design/m1-baseline.md`; `M2-D-14` points at `docs/design/m2-baseline.md`.

---

## Scope

### Who M3 is for

Unchanged from `docs/product-scope.md`: developers operating their own mobile apps, growth operators validating campaign-level installs, and data teams reconciling an existing MMP against first-party data. One organization, several apps, one PostgreSQL instance (M1 Scope).

M1 produced numbers that only exist as JSON and CSV behind a bearer token. M2 produced first-party evidence. **M3 is the first milestone whose output a human looks at without a terminal.** That is the sentence the scope should be judged against, and it is also the discipline: everything M3 adds must be something an operator opens in a browser and acts on, or something that makes those numbers checkable.

### What "usable" means for M3 — one screen, every morning

The review is explicit about the subject matter (`docs/review/2026-08-17-review.md` §7): *"the leading role is ROAS / retention / cohort; clicks and installs are supporting."* M1 built exactly those. So the M3 target is not "a reporting tool"; it is **one page an operator opens every morning and can act on**, plus the three surfaces that make that page trustworthy and operable.

The morning screen shows, for one app and one date range:

1. a **header strip** with the app, the aggregation time zone, `input_received_at_watermark`, a short form of `input_snapshot_id`, `data_freshness`, `metric_definition_version`, the rule-bundle id/version, and a count of undefined cells;
2. a **cohort table**: rows are the grouping (cohort date × campaign × country as configured), columns are installs, cost, D0/D1/D3/D7 ROAS, D1/D7 retention, D0/D7 cohort LTV;
3. an **attribution breakdown**: installs split into `organic` / `non_organic` / `unattributed`, from the contract's own `attribution_status` grouping dimension;
4. a **clicks and installs series** for the same range;
5. links to the **difference-audit viewer** and to **CSV** carrying the identical filter.

And three operating surfaces: **app registration**, **measurement-link creation and listing**, and **login/logout**.

Two things that are *not* the definition of usable here, and must not creep in: real-time refresh, and per-user customisation. Both cost far more than they return for a self-hosted operator tool, and both pull toward a client-side application (M3-D-11).

### In scope for M3

- Human authentication: a login that converts the existing admin key into a server-side browser session, with logout and expiry.
- App registration through the API and the dashboard, and the identity change that makes a second app reachable at all (M3-D-16).
- Measurement-link creation (already implemented headlessly by M2a) plus listing, exposed in the dashboard.
- Reporting API extensions: a typed filter contract, supersession handling, keyset pagination, a widened row model, a watermark-parameterized raw-record count surface.
- Metric definitions for daily clicks and installs, and installs by attribution status.
- Server-rendered dashboard pages, CSS, and server-generated inline SVG. No client-side JavaScript.
- CSV export from the dashboard using the same row model and the same filter.
- The three-way consistency gate the roadmap names as M3's evidence gate.

### Explicitly out of scope for M3

- RBAC, roles, multiple human users, per-app permissions — M5. M3 has exactly one authority level (M3-D-09).
- Subject-facing DSAR access/portability. `docs/privacy-security.md:87` currently promises it through "the M3 reporting API"; M3-D-10 recommends correcting that sentence rather than quietly shipping an aggregate CSV export and calling it DSAR.
- Any change to the ingestion, redirector, or SDK paths.
- Alerting, scheduling, email, or anything that sends a message out of the deployment.
- Cohort visualisation beyond one sparkline/bar primitive; no charting library.
- iOS (M4a/M4b), SKAN/AAK views (M4b), fraud dashboards (M5).
- SDK key rotation UI. M3 mints one SDK key when an app is registered (M3-D-17) and rotation stays a restart, as in M1/M2.

### M3a / M3b split (M3-D-01)

**Options**

- (a) One work order.
- (b) **M3a — headless**: identity and session, app registration, reporting-API extensions, filter contract, new metric definitions, migrations. Everything drivable by `node:test` and an HTTP client with no HTML. **M3b — the surface**: pages, CSS, SVG, CSV links, and the three-way consistency gate.
- (c) Split by feature area (reporting vs control plane).

**Decided (R-25): (b).** M3a carries all of the risk — it changes what an admin identity means (M3-D-16), adds a filter contract that two consumers must share (M3-D-18), and touches migrations. M3b is mostly rendering over an already-verified model. Landing and verifying M3a first means a rendering bug and an identity bug can never be confused, which is the same reason M1a/M1b and M2a/M2b were split. (c) cuts across the identity change and would put half of it in each work order.

The consistency gate belongs to M3b, because it is the criterion that binds the rendered page to the API.

### Prerequisites

- **M2a must be merged before WO-7 starts.** M3's route table (M3-D-13) rewrites the dispatcher that M2a just extended; doing it on an unmerged branch guarantees a conflict in the one file where a merge mistake silently removes an authentication check.
- **The narrow M3-H-1 contract patch landed first** as contract v0.3.1. It adds `metric_date` and the reviewed daily event-count semantics before the dashboard consumes them.

---

## Security baseline

### M3-S-1 (M3-D-03). Turning the admin key into a human session

The constraint is recorded and satisfied: M1 D-05 chose a single admin API key with a scrypt verifier explicitly so that "authentication exists *before* the dashboard" (M1 S-14), which is what Lane F F-15 asked for — *decide and document a baseline authentication model before M3 ships; do not create a period with an unauthenticated dashboard*. M3's job is to convert that credential into something a browser can carry, and nothing more.

**Options**

- (a) No login: the dashboard requires `Authorization: Bearer` on every request. A browser cannot send that without an extension or client JavaScript, so this is not an option in practice.
- (b) A login form where the operator pastes the admin key. The server verifies it through the **existing** `verifyAdminKey` path and issues an opaque session cookie.
- (c) User accounts with usernames and passwords, a `control.users` table, and password reset.
- (d) OIDC / an external identity provider.

**Decided (R-25): (b).** It adds no new credential type, no new secret to `.env.example`, and no new verifier: the thing being checked is the same key, checked by the same scrypt comparison, recorded under the same audit actor vocabulary (`actor_type=admin_key`, `actor_ref=admin_key:<key_id>`). (c) invents a second credential that grants exactly the same authority as the first — a password is then just another spelling of the admin key — and it drags in password reset, which needs an email path this deployment does not have and should not acquire. (d) puts an identity provider between `git clone` and a working system, which is the opposite of the project's first-run promise.

Consequences to state plainly rather than discover:

- The key travels in a POST body. Over the default `http://localhost` topology that is fine; over a network it requires TLS, which is already the documented `--profile proxy` path (M1 S-10). M3-D-05's boot check makes the unsafe configuration fail at startup instead of at login.
- Two humans sharing a deployment are distinguishable only by which of the two active keys they pasted. That is the whole of M3's identity model (M3-D-09).

### M3-S-2 (M3-D-04). Session storage, lifetime, and why GET never writes

**Storage options**

- (a) In-process map.
- (b) A row in the existing `ephemeral` schema: `ephemeral.dashboard_sessions`.
- (c) A stateless signed cookie carrying the identity (JWT-shaped).

**Decided (R-25): (b).** M2-D-03 created `ephemeral` for exactly this class of data — state that is not evidence, is outside the append-only guarantee, and must be deletable — and it already grants `SELECT, INSERT, DELETE` on that schema to `openmmp_app`. A session is the same shape as a nonce: not evidence, must expire, must be revocable. (a) loses every session on restart, which turns `docker compose restart api` into a logout, and it stops working the moment an operator runs two API replicas. (c) cannot be revoked, so logout becomes a claim rather than an action, and "the operator pressed log out" is precisely the kind of statement this project should be able to demonstrate.

```sql
CREATE TABLE ephemeral.dashboard_sessions (
  session_id   control.identifier PRIMARY KEY,      -- opaque, server-assigned
  tenant_id    control.identifier NOT NULL,
  admin_key_id control.identifier NOT NULL,
  token_digest text NOT NULL CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  CHECK (expires_at > created_at),
  UNIQUE (token_digest)
);
CREATE INDEX dashboard_sessions_expiry_idx ON ephemeral.dashboard_sessions (expires_at);
GRANT SELECT, INSERT, DELETE ON ephemeral.dashboard_sessions TO openmmp_app;
GRANT USAGE ON SCHEMA ephemeral TO openmmp_reader;
GRANT SELECT ON ephemeral.dashboard_sessions TO openmmp_reader;
```

RLS applies exactly as on `ephemeral.request_nonces`. Note that the table is **tenant-scoped and not app-scoped**, and therefore carries no foreign key to `control.apps` — which is a direct consequence of M3-D-16.

**Token.** 32 CSPRNG bytes, base64url. The server stores **only `sha256(token)`**, unsalted. This is deliberately *not* the mistake Lane F F-05 identified: F-05 was an unsalted hash over a four-value enumeration, where a dictionary attack is trivial. A 256-bit uniformly random token has no dictionary, so a plain SHA-256 is the correct and standard construction, and a KDF here would buy nothing while adding per-request cost. Say this in the code comment, because a reviewer who remembers F-05 will otherwise flag it.

**Lifetime — absolute only, no sliding idle window.**

- Absolute expiry: **12 hours** (`OPENMMP_DASHBOARD_SESSION_TTL_SECONDS`, default `43200`).
- No idle-timeout refresh, and therefore no write on any read.
- A sweep deletes expired rows; it runs in the worker alongside the existing nonce sweep, not on the request path.

The reason for refusing a sliding window is structural, not laziness. M3-D-13 makes every dashboard `GET` run on the `openmmp_reader` role, so that "a read path cannot write" is enforced by PostgreSQL rather than by discipline. A sliding session would require touching the session row on every page view — a write on a GET — and the invariant would have to be abandoned to buy an operator convenience worth a few seconds a day. The trade is stated in the documentation: **you log in once each morning.** For a morning screen that is not a cost worth a weaker guarantee.

Logout deletes the row and clears the cookie. Login always creates a fresh `session_id`; there is no pre-authentication session, so fixation is impossible by construction — but state it, because "we issue a new session on login" is the sentence a reader looks for.

### M3-S-3 (M3-D-05). Cookie attributes, the `__Host-` prefix, and the boot check

Verified 2026-08-20 from MDN (see [References](#references)):

- "Insecure sites (`http:`) cannot set cookies with the `Secure` attribute. The `https:` requirements are ignored when the `Secure` attribute is set by localhost."
- `__Host-` requires the `Secure` attribute set "by a secure page (HTTPS)", no `Domain`, and `Path=/`.
- `HttpOnly` forbids `document.cookie` access but the cookie is still sent by `fetch`/XHR.
- Some browsers default `SameSite` to `Lax` when it is omitted.

**Recommended cookie:**

```
Set-Cookie: <name>=<token>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200
```

with `<name>` = `__Host-openmmp_dashboard` when `OPENMMP_PUBLIC_BASE_URL` uses `https:`, and `openmmp_dashboard` otherwise.

Two decisions inside that.

**Why the conditional name.** MDN states the prefix requirement in terms of HTTPS, and does **not** say whether the localhost exemption that applies to `Secure` also applies to the prefixes. That is an unverified fact (see [Not verified](#not-verified)). Rather than measure it, remove the dependency on it — the same move M2-S-8 made with the Play referrer length. The prefix is used exactly where the documentation guarantees it works, and the default local topology, which is the one every new user runs, does not depend on an unconfirmed browser behaviour.

**Why `SameSite=Strict` rather than `Lax`.**

- (a) `Lax` — the cookie rides along on top-level cross-site GET navigations.
- (b) `Strict` — never sent on a cross-site request of any kind.

**Decided (R-25): (b).** This is an internal operator tool; there is no legitimate cross-site entry point into it, and there is no sign-in-with-redirect flow to break. `Strict` costs one papercut — following a link from a chat client shows the login page, and the second click works — and in exchange it removes the entire class of "was this GET safe?" reasoning. Under `Lax` we would still need the synchronizer token (M3-D-06) *and* an argument that no GET mutates; under `Strict` the token is defence in depth rather than the only line. No environment variable is offered: one more knob means one more `.env.example` row and one more branch to test, for a preference nobody has expressed.

**Boot self-check (this is the part that prevents a silent first-run failure).** `Secure` cookies are dropped by the browser on a plain-HTTP non-localhost origin. An operator who binds the API to a LAN address over HTTP would see a login form that accepts the key and then behaves as if it did not — the worst possible failure shape, because it looks like a wrong password. Therefore, at startup:

> If the dashboard is enabled and `OPENMMP_PUBLIC_BASE_URL` has scheme `http:` with a host other than `localhost` / `127.0.0.1` / `[::1]`, refuse to start with a named error naming the `proxy` Compose profile.

This is the M1 S-3 pattern (boot-time template self-check) applied to the one configuration that turns a security control into an outage.

### M3-S-4 (M3-D-06). CSRF, and the rule that makes it small

The structural decision comes first, because it decides how much CSRF surface exists at all.

**Cookies are host-scoped, not port-scoped.** Putting the dashboard on a second port would *not* give it a separate cookie jar; the browser would attach the session cookie to `/v1/*` requests on the same host. So the isolation has to be built in the server, and it should be stated as an invariant a test can iterate:

> **No route under `/v1/` reads a cookie. No route under `/dashboard/` accepts `Authorization: Bearer`.**

With that, the `/v1` API has no ambient credential and CSRF against it is impossible by construction, which also means M1's and M2a's existing routes need no CSRF work. What remains is the small set of `/dashboard/` POSTs.

**Options for those**

- (a) `SameSite=Strict` only.
- (b) A synchronizer token in a hidden form field, derived per session, compared in constant time.
- (c) Double-submit cookie.
- (d) `Origin` / `Sec-Fetch-Site` header check.

**Decided (R-25): (b) as the asserted control, with (a) already in place and (d) as a cheap second gate.** (a) alone makes the project's safety depend on a browser behaviour the server cannot demonstrate; (b) is a server-side invariant an acceptance test can assert directly ("POST without the token → 403 and an audit row"), which is what this repository consistently prefers over a prose promise. (c) is strictly weaker than (b) here because we already have server-side session state to bind to. (d) is one line and catches non-browser clients, but `Origin` is absent on some legitimate requests, so it must reject only on a *mismatch*, never on absence.

Token construction: `HMAC-SHA256(session_token, "open-mmp-dashboard-csrf-v1")`, rendered base64url into the form. It needs no storage, rotates with the session, and is unavailable to an attacker who cannot read the page — which `HttpOnly` plus `script-src 'none'` (M3-D-07) already guarantees.

Every `/dashboard` mutation is `POST` and answers `303 See Other`, so a refresh never repeats it.

### M3-S-5 (M3-D-07). Content Security Policy and the zero-JavaScript rule

M3-D-11 recommends server-rendered HTML with **no client-side JavaScript at all**. That is a security decision as much as an architecture one, because it makes the strongest possible CSP honest rather than aspirational:

```
Content-Security-Policy: default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'
```

`script-src` is not listed because `default-src 'none'` already covers it; listing it changes nothing and invites the reader to think scripts are merely restricted rather than absent. MDN confirms that `'self'` does not permit inline code and that a nonce or hash would be required for any inline `<script>` or `<style>` — which is precisely why the stylesheet is a separate file served from the same origin and there is no inline style attribute anywhere.

Accompanying headers on every `/dashboard` response: `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `X-Frame-Options` omitted in favour of `frame-ancestors 'none'`.

**Acceptance:** the header is asserted directive-for-directive as a parsed set, not as a string; and every rendered dashboard body is scanned for `<script`, `javascript:`, and `on…=` attributes. That is a behavioural assertion about what the page can execute, not a test that fixes wording.

### M3-S-6 (M3-D-08). Login abuse and audit, in the right order

`POST /dashboard/session` is the one unauthenticated write surface M3 adds.

- Per-source-IP token bucket, in memory only, never persisted, never logged — the M2-S-10 rule. Proposed default 5 attempts/minute, burst 10 (`OPENMMP_DASHBOARD_LOGIN_RATE_RPM`, `_BURST`).
- A global bucket as a backstop against a distributed attempt: 60/minute.
- Constant-time verification, already true of `verifyAdminKey`.
- The response for a wrong key and for a well-formed-but-unknown key is byte-identical.

**Audit, and the ordering that matters.** Every login attempt writes an `ledger.audit_logs` row (`action=dashboard_login`, `outcome=succeeded|failed`). An audit row per failed attempt is itself an unauthenticated write, so it is an amplification vector — unless the rate limiter refuses **before** the insert. That is the M1 S-11 rule ("limits are refused before any row is inserted") applied to a surface M1 did not have. A flood therefore produces `429` responses and no rows.

Two vocabulary consequences in `ledger.audit_logs`, which is a runtime table and explicitly **not** a contract artifact (M1 D-09), so extending it is a migration and not a contract change:

- `target_scope` gains `session`; the current `CHECK` list has no value that fits.
- `actor_ref` is `NOT NULL`, and a failed login has no key. Use `admin_key:unrecognized`, which is non-identifying and honest, rather than inventing a nullable column.

New `action` values: `dashboard_login`, `dashboard_logout`, `dashboard_session_expired_sweep`, `app_registered`, `sdk_key_issued`, `tracking_link_created` (the last already occurs headlessly in M2a and should be audited in the same change, since M3 puts a button on it).

### M3-S-7 (M3-D-09). What M3 does *not* claim

Stated once, plainly, in `docs/threat-model.md` under a new `dashboard` component:

> **M3 has exactly one authority level.** A dashboard session confers every capability the admin key confers, including registering apps, issuing SDK keys, creating measurement links, and submitting deletion requests. There are no roles, no read-only accounts, and no per-app authorisation beyond the tenant the key belongs to. Two operators sharing a deployment are distinguishable in the audit log only by which of the two active keys they used. Role granularity is M5.

This is the M2-D-13 pattern. F-15's complaint was never "M3 needs RBAC"; it was "do not ship a dashboard whose authentication model was never decided". Writing the model down, including its ceiling, is what closes it. Writing "the dashboard is authenticated" and stopping would reproduce exactly the failure F-15 named.

### M3-S-8 (M3-D-10). The DSAR promise in `docs/privacy-security.md:87`

The file currently says: data access and export (DSAR access/portability) "will be provided through the M3 reporting API; the request contract is not yet defined and is tracked as an open design item."

**Options**

- (a) Implement subject access/portability in M3.
- (b) Ship operator-facing export only, and rewrite that sentence in the same change to say what M3 does and does not provide, naming the missing contract element and moving it to a numbered handoff.
- (c) Ship CSV export and leave the sentence, letting a reader conclude the promise was met.

**Decided (R-25): (b).** (a) requires a contract element that does not exist: `privacy-request` models deletion, and there is no request type, no response artifact, and no authorisation story for an access request — the same authorisation problem M2-S-2 had to solve for deletion would have to be solved again for disclosure, where the failure mode is worse (disclosing someone's data to the wrong requester, rather than deleting it). That is a contract work order of its own, not a line item inside a dashboard milestone. (c) is the drift `AGENTS.md` forbids and would be the single most damaging sentence in the repository, because it converts a documented gap into a false claim of compliance capability.

**The distinction M3 must make explicit, in the UI text and in the docs: a CSV export of aggregate reports is not a DSAR export.** They are different subjects (the operator's campaign aggregates versus one person's records), different authorisation, and different obligations. Conflating them is exactly the category error this project exists to avoid.

This is an **owner-check** item, because it edits a published promise.

---

## Architecture

### Repository layout additions

```text
apps/
  api/
    src/
      routes.ts            # NEW: route table + auth modes (replaces the if-chain)
      dashboard/           # NEW: handlers, view models, renderer, CSS, SVG
      report-query.ts      # NEW: the MetricQuery type, parser, and SQL builder
      session.ts           # NEW: login, session issue/verify/revoke, CSRF token
      apps-admin.ts        # NEW: app registration and listing
packages/
  contracts/
    src/m3-metric-definitions.ts   # NEW: daily click/install definitions
docs/
  design/m3-baseline.md    # this document
```

No new npm workspace, no new Compose service, no new port, no new runtime dependency.

### M3-D-11. Rendering model — server-rendered HTML, no framework, no build chain

This is the decision the whole milestone hangs on, and the constraint is stated in the brief: self-host ease is the priority, and build steps are a cost.

**Options**

- (a) A framework (Next.js / Remix / SvelteKit / similar): SSR, routing, and a component model out of the box.
- (b) A single-page application built with a bundler (Vite + a small view library), served as static assets, talking to the JSON API.
- (c) Static HTML plus hand-written browser ES modules, no bundler, no transpile, served from `apps/api/public/`, talking to the JSON API.
- (d) **Server-rendered HTML produced by TypeScript functions in `apps/api`, with zero client-side JavaScript**; forms and links carry state; one static CSS file.

**Decided (R-25): (d).**

The comparison that decides it is not "which is nicer to write" but "what does each add to a `git clone && docker compose up`".

- (a) adds a build step to the Docker image, a framework's transitive dependency tree to the runtime SBOM (`npm run sbom` per workspace is an M1 release gate, and the SBOM is a document this project asks people to read), and a second set of upgrade obligations for the one artifact that must keep working for years without attention. It also brings its own routing and its own auth conventions, which will not match the ones M1 and M2 established.
- (b) has the same build-step and dependency costs plus a genuine architectural cost: a SPA needs the browser to hold a credential, which means either the session cookie is read by JavaScript (it must not be — `HttpOnly`) or the fetches ride the cookie, which reintroduces CSRF onto every read.
- (c) removes the bundler but introduces the one thing this repository has been systematically removing: untyped code. Browser modules cannot go through `tsx`, so the client logic would be plain JavaScript outside `npm run typecheck` — the same complaint Lane B raised as B-06 (`Any` everywhere) and R-10 resolved. Adding a new untyped layer right after paying to remove one is a regression in the project's own terms.
- (d) keeps **every line of dashboard logic inside TypeScript**, checked by the existing `npm run typecheck`, unit-testable with `node:test` as pure functions from data to strings. It adds zero dependencies, zero build steps, and zero services. And it makes M3-D-07's `default-src 'none'` a fact rather than a policy.

What (d) gives up: no client-side sorting, no live refresh, a full page load per filter change. For a table an operator reads once a morning and occasionally re-filters, that is not a real loss; page loads over a local network are faster than the equivalent SPA hydration.

The honest limit, to be recorded: **if M5 or later wants interactive drill-down, this decision will need revisiting, and the way to revisit it is to add a client layer over the same JSON API — not to rewrite the pages.** The API is the durable artifact; the HTML is a second consumer of it. That is why M3-D-18 insists both consumers share one query type.

### M3-D-12. Placement — routes in `apps/api`, not a new service

**Options**

- (a) Routes under `/dashboard` inside `apps/api`.
- (b) A new `apps/dashboard` Compose service on its own port.
- (c) A separate service on a separate **hostname**.

**Decided (R-25): (a).** M2-D-14 made the redirector its own process for a specific reason — it is hammered by the open internet and sits on the user's critical path to the Play Store. None of that applies here: the dashboard is low-traffic, internal, and needs the same database access and the same admin-key store the API already has.

The tempting security argument for (b) — isolate the cookie surface from the token surface — **does not work**, because cookies ignore the port. Only (c) achieves it, and it costs an operator a second hostname and a second TLS certificate in a project whose first-run promise is "one command, no configuration". So the isolation is built in the server instead (M3-D-06), where it is one rule and one test.

Record (c) as a documented hardening for operators who want it: run a second API process with `OPENMMP_DASHBOARD_ENABLED=false` on the public hostname and the dashboard on an internal one. That is a deployment topology, not a code change, and it is worth one paragraph in the docs.

### M3-D-13. A route table with declared authentication, replacing the if-chain

`apps/api/src/router.ts` is today a 180-line chain of `if` statements in which the admin-key verification block appears **three times, copy-pasted**. M3 adds roughly ten routes and a second authentication mode.

**Options**

- (a) Keep extending the chain.
- (b) A small in-repo route table: `{ method, pattern, auth, mutates, handler }`, dispatched by a 60-line matcher.
- (c) Express or Fastify.

**Decided (R-25): (b).** Two reasons, and the second is the important one.

First, the triplicated auth block is exactly the shape of code where a future route gets added below the block and silently skips it. A table makes the auth mode a declared property of a route rather than a line someone remembered to write.

Second — and this is what makes it worth doing in M3 rather than later — **the table turns the milestone's security invariants into iterations instead of code review**:

- every route with `auth: "admin_bearer"` or `"sdk_hmac"` has a path starting `/v1/`, and its handler is constructed without access to the cookie parser;
- every route with `auth: "dashboard_session"` has a path starting `/dashboard/`;
- every `GET` route has `mutates: false`, and **every `mutates: false` handler is constructed with the reader pool** (below);
- M1 S-4's existing requirement — no route in `apps/api` accepts a file body — becomes a property of the table rather than a claim about the file.

(c) adds a dependency tree to the runtime SBOM for routing that fits in one file, and neither framework would give the declared-auth property for free.

**The reader pool.** `db/schema.sql` already defines `openmmp_reader` with `SELECT`-only grants across `control` and `ledger`, `bootstrap.ts` already generates a reader password, and `.env.example` already carries `OPENMMP_READER_DATABASE_URL` — but the container runtime environment does not export it. Adding `createReaderPool()` to `@open-mmp/runtime` and exporting that variable to the `api` service is a few lines, and it converts "read endpoints do not write" from a review comment into a database permission. A `mutates: false` handler that attempts an INSERT fails with insufficient privilege, in a test, loudly.

This is also why M3-D-04 refuses a sliding session window: it is the one design choice that would have forced a write onto a read path.

### M3-D-14. Charts — server-rendered inline SVG from a pure function

**Options**

- (a) Numbers and tables only.
- (b) One server-generated inline SVG primitive (sparkline / small bar series).
- (c) A charting library plus client JavaScript.

**Decided (R-25): (b).** (c) is incompatible with M3-D-07 and M3-D-11 and adds a dependency. (a) is defensible and would be the right answer if the SVG were expensive — but the generator is a pure function `(series: readonly (number | undefined)[], options) → string`, about sixty lines, deterministic, and unit-testable without a browser. A morning screen without a trend line makes "yesterday was broken" a thing you compute instead of a thing you see, which is most of the value of looking at a screen at all.

One rule, and it is not cosmetic: **a value whose `value_state` is `undefined` renders as a gap in the series, never as zero.** M1 B8 established that an undefined ROAS is never coerced to `0` or infinity in the data; a chart that plots it at zero re-introduces the same lie in pixels, and it is the most persuasive form of the lie because a reader sees a line touching the axis and concludes the campaign returned nothing.

### M3-D-15. Styling and assets

One hand-written stylesheet at `/dashboard/app.css`, served from disk with a long-lived `ETag` and `Cache-Control: no-cache` (revalidate, do not store stale credentials-adjacent HTML). System font stack only — **no web fonts and no external requests of any kind**, which is what allows `default-src 'none'` to hold without a single exception. Light and dark through `prefers-color-scheme`. Tables carry `<caption>` and `<th scope>`; the page is readable with CSS disabled, because the operator debugging a broken deployment is exactly the person whose CSS did not load.

English only, per `AGENTS.md`.

---

## Reporting API and control-plane extensions

### M3-D-16. Admin identity becomes tenant-scoped; the app becomes a validated parameter

This is the largest structural finding in M3, and it is a prerequisite for the roadmap's own first M3 bullet ("App registration").

**What is true today.** `createRequestHandler` calls `verifyAdminKey(pool, { tenantId: dependencies.maxConfig.tenantId, appId: dependencies.maxConfig.appId }, header)` — the scope comes from **environment variables** (`OPENMMP_MAX_TENANT_ID`, `OPENMMP_MAX_APP_ID`), not from the key. `control.admin_keys` carries `app_id NOT NULL` with a composite foreign key to `control.apps`, and the only code that inserts into `control.apps` is `ensureAdminKeys` at boot. **There is no route that registers an app, and a second app would be unreachable if there were one.**

**Options**

- (a) Keep the environment-fixed single app; "app registration" means editing `.env` and restarting.
- (b) Make the admin key **tenant-scoped**. `verifyAdminKey` returns `{ keyId, tenantId }`. Every reporting and control route takes an explicit `app_id`, validated against `control.apps` for that tenant. `POST /v1/admin/apps` registers one.
- (c) One admin key per app: registering an app mints a new key.

**Decided (R-25): (b).** (a) fails the milestone item outright, and an app-registration screen that cannot produce a usable app is the kind of fake feature that erodes trust in everything next to it. (c) means the operator pastes a different key to look at a different app, which makes "one screen every morning" impossible and multiplies the credential surface by the app count.

**Why (b) does not weaken isolation, and what documentation it corrects.** `docs/architecture.md:158` currently says: *"The authenticated scope, not request parameters, fixes the tenant and app."* Read strictly, (b) contradicts it. But M1 S-8 already established the real design: RLS enforces the **tenant** boundary through `SET LOCAL open_mmp.tenant_id`, while *"`app_id` is enforced by constraints and by the repository layer rather than by a second policy, so that cross-app reporting inside one organization stays a normal query."* So the app boundary was never an RLS boundary. The sentence in `architecture.md` is stronger than the design it describes, and M3 should correct it to: **the authenticated scope fixes the tenant; the app is a request parameter validated against that tenant's registered apps.** That is a documentation correction, not a security relaxation — and leaving the old sentence while shipping (b) would be the drift `AGENTS.md` forbids.

**Migration.** Forward-only SQL, in M1 D-27's style:

- `control.admin_keys.app_id` and `control.admin_key_states.app_id` become nullable; the composite foreign key to `control.apps` is dropped; existing rows are left as they are and new rows are written with `NULL`. The column stays as recorded provenance and its meaning is documented as "the app this key was bootstrapped alongside", never as a scope.
- RLS policies on both tables already key on `tenant_id` and need no change.

**Validation and error shape.** An `app_id` that is not registered for the authenticated tenant, and an `app_id` that belongs to another tenant, return the **same** `404` with the same body — the M2-S-6 indistinguishability rule, so that the API does not become an app-name oracle.

**Blast radius, stated honestly.** This touches `admin-auth.ts`, `router.ts`, `reporting.ts`, `tracking-links.ts`, `privacy.ts`, the M2a SDK route wiring, and their integration tests. It is the single biggest reason M3a exists as a separate work order. The alternative — keeping one app and amending `docs/roadmap.md` to drop "App registration" from M3 — is a legitimate choice, but it must be made explicitly and written down, not achieved by not doing the work.

### M3-D-17. What app registration actually creates

Registering an app that cannot receive events is a half-feature. `control.sdk_keys` are provisioned at boot from `OPENMMP_SDK_KEY` for the single configured app; a newly registered app would have no SDK key and no way to get one without editing `.env` and restarting.

**Options**

- (a) Register the app row only; SDK keys stay environment-provisioned.
- (b) Registration also mints one SDK key, displays the secret **exactly once**, and shows the app's MAX postback template and redirector base URL.
- (c) (b) plus rotation and revocation UI.

**Decided (R-25): (b).** It reuses `ensureSdkKeys`, which already writes the secret envelope-encrypted through the payload store, so no new key-management mechanism is invented (the M2-S-1 rule). The "shown once" page mirrors what `npm run bootstrap` already prints to the console for the first app, so the model is consistent rather than novel. (c) is M5's rotation story and needs a two-active-key UI that has an app-release-adoption window attached to it (M2-S-1), which is more than a dashboard milestone should take on.

Response and page rules for the secret: `Cache-Control: no-store`, no secret in any URL, no secret in the audit log (the audit row records `sdk_key_issued` and the **key id** only), and an explicit warning that it cannot be retrieved again.

This is an **owner-check** item only in the sense that it is the one place where deferring to (a) is defensible if the commander wants M3 narrower; the cost of (a) is that the second app is reporting-only.

### M3-D-18. One typed filter contract, one parser, one SQL builder

**What is true today.** `metricReport(pool, identity)` runs `SELECT artifact FROM ledger.metric_runs WHERE tenant_id=$1 AND app_id=$2 ORDER BY metric_run_id` — no filters, no date range, no metric selection, no pagination, no supersession handling. `differenceAudit` is the same shape. The only request parameter the router reads is `format`.

The roadmap's M3 evidence gate is *"Raw records, reporting API, and dashboard match under identical filters and definitions."* That sentence is only mechanically checkable if **"identical filters" is one value**, not two implementations that are believed to agree.

**Options**

- (a) The dashboard builds its own SQL; the JSON API keeps its own.
- (b) One typed `MetricQuery`, one parser from query string to `MetricQuery`, one SQL builder from `MetricQuery` to a parameterized statement; the JSON API and the dashboard both call the same function in-process.
- (c) The dashboard calls the JSON API over HTTP with a manufactured internal bearer token.

**Decided (R-25): (b).** This is M2-D-15's principle ("reuse `ingestRuntimeBatch` unmodified") applied to reads: the shipped read path is the read path the gate tests. (a) guarantees eventual divergence in exactly the comparison the milestone exists to prove. (c) is worse than it looks — it creates an internal credential that must be stored, rotated, and protected, it doubles the request cost, and a self-call through the loopback interface is a new failure mode in the one process that must stay simple.

```ts
type Cursor = { readonly metricName: string; readonly groupingDigest: string; readonly metricRunId: string };

type MetricQuery = {
  readonly tenantId: string;
  readonly appId: string;
  readonly metricNames?: readonly string[];
  readonly metricDefinitionVersion?: string;
  readonly grouping?: Readonly<Partial<Record<GroupingDimension, string>>>;
  readonly dateFrom?: CanonicalDate;          // inclusive, in the run's aggregation_time_zone
  readonly dateTo?: CanonicalDate;            // exclusive — half-open, matching the contract's window convention
  readonly watermarkAtMost?: CanonicalTimestamp;
  readonly supersession: "latest" | "all";
  readonly limit: number;
  readonly after?: Cursor;
};
```

`GroupingDimension` is generated from the contract, not hand-typed: `metric-run.schema.json` closes `grouping.dimensions` to `campaign_id`, `network`, `country`, `cohort_date`, `attribution_status` with `additionalProperties: false`, so the type must come from `packages/contracts` and a new dimension must appear in the filter automatically. That is the "typed contract, not a string pipe" standard applied to the query surface.

Rules the parser enforces:

- An **unknown filter key is a `400`**, never ignored. A silently dropped filter is the failure that makes a dashboard number wrong and confident at the same time.
- Date range is **half-open** `[from, to)`, matching the contract's seven-day window convention, so nobody has to remember two conventions.
- Every value reaching the driver is a bound parameter. The builder returns `{ text, values }` and never interpolates; a test drives it with a fake client and asserts that no filter value appears anywhere in `text`.
- The same query string parsed twice yields an equal `MetricQuery` (a typed round-trip assertion, not a string comparison).

### M3-D-19. Supersession — `latest` by default

`ledger.metric_runs` is append-only and a recalculation writes a new row carrying `supersedes_metric_run_id`. Today's reporting endpoint returns **both**, so a naive table would show a cohort twice with two different ROAS values and no indication which is current.

**Options**

- (a) Always return every run.
- (b) Default to the current run per `(metric_name, metric_definition_version, grouping_digest)`; `supersession=all` returns the history.
- (c) Only ever return the current run.

**Decided (R-25): (b).** (a) is the present behaviour and is wrong for a screen. (c) destroys the audit story that motivates the whole project — "why did this number change?" is answered by the superseded row, its `reproducibility_status` (`redaction_affected` / `retention_affected`), and the `supersedes_metric_run_id` chain. Under (b) the dashboard shows the current value with a marker when a row has superseded something, and the marker links to the history.

Implementation note worth pinning: `supersedes_metric_run_id` points at the **older** run, so "superseded" is `metric_run_id IN (SELECT supersedes_metric_run_id FROM ledger.metric_runs WHERE supersedes_metric_run_id IS NOT NULL)` within the same tenant/app. Add a partial index on `supersedes_metric_run_id WHERE supersedes_metric_run_id IS NOT NULL`, because this predicate runs on every page view.

### M3-D-20. Pagination

**Options**

- (a) No pagination (today).
- (b) `LIMIT`/`OFFSET`.
- (c) Keyset (cursor) pagination on the table's own unique key.

**Decided (R-25): (c).** The natural key is already unique: `(tenant_id, app_id, metric_name, metric_definition_version, grouping_digest, input_snapshot_id)`, and `metric_run_id` is the primary key. Order by `(metric_name, grouping_digest, metric_run_id)` and carry the last tuple as an opaque cursor. (b) drifts under concurrent writes — and this table receives writes from the worker while an operator is paging — producing duplicated or skipped rows with no error. (a) is unbounded: a year of daily cohorts × campaigns × countries × twelve definitions is a response nobody wants to render or transfer.

Defaults: `limit` 200, maximum 1000 (`OPENMMP_REPORT_MAX_ROWS`), and a CSV export path that streams beyond the page limit under an explicit `export=true` with its own maximum, so that "export the range" does not require paging by hand.

### M3-D-21. Widened row model, and CSV additivity

`metricRow()` currently drops fields the dashboard needs and the audit story depends on. Add: `rule_bundle_id`, `rule_bundle_hash`, `aggregation_time_zone`, `computed_at`, `reproducibility_status`, `supersedes_metric_run_id`, `input_ledger_position`, and `grouping_digest`.

**CSV rule:** new columns are **appended**; existing column positions and names do not move. The CSV header is a consumed interface — an operator's spreadsheet or script binds to it — and reordering it silently breaks them. The `format=json` and `format=csv` equality test (M1 B7) is extended to the new columns rather than replaced.

### M3-D-22. Daily clicks, installs, and the attribution breakdown

The roadmap asks for "daily clicks/installs" and the "organic / non_organic / unattributed" split.

**Options**

- (a) Ad-hoc `SELECT count(*)` endpoints over `click_facts` / `install_facts`.
- (b) Contract metric runs, computed by the same SQL cohort engine, persisted as `metric_runs` artifacts with a definition version and a snapshot ID.
- (c) A mixture: installs as metric runs, clicks as a live count.

**Decided (R-25): (b), with (c) as the fallback if the contract item is declined.** The reason is that these numbers appear **on the same screen** as ROAS. If ROAS is snapshot-fixed and reproducible while the install count next to it is a live `count(*)`, the screen quietly contains two kinds of number with different reproducibility and no way for the reader to tell them apart — on the one page whose purpose is to demonstrate that this project's numbers are reproducible.

What each needs:

- **Installs by attribution status: no contract change.** `cohort_install_count` already exists in `packages/contracts/src/m1b-metric-definitions.ts`, and `attribution_status` is already a closed grouping dimension in `metric-run.schema.json` (contract v0.3, H-12). This is a new grouping instance of an existing definition.
- **Daily clicks: blocked by a missing dimension.** A click has no cohort. `grouping.dimensions` closes at five properties, the only date-shaped one is `cohort_date`, and M1 M-4 defines `cohort_date` as *the install day in the metric's aggregation time zone*. Using it as a click day would overload a dimension with a second meaning — the class of thing the project rejects (M2-D-27 refused a delimiter inside `producer_version` for the same reason).

  **M3-H-1 landed in contract v0.3.1:** `metric_date` is an additive dimension for day-keyed event-count metrics. The reviewed `daily_click_count` and `daily_install_count` definitions make both values persisted, snapshot-fixed artifacts instead of mixing metric runs with live evidence counts.

New definitions in `packages/contracts/src/m3-metric-definitions.ts`: `daily_click_count`, `daily_install_count`. Both go through the existing parity gate (`npm run test:metric-parity`), so the SQL and the evaluator must agree byte-for-byte after JCS, exactly as the cohort metrics do.

### M3-D-23. The raw-record read surface

The evidence gate names three things that must agree, and the first is "raw records". `docs/architecture.md:157` constrains how: *"Raw-record access remains separate from aggregate reporting; these endpoints never expose raw payloads."*

**Options**

- (a) No raw surface; the gate compares the API to the dashboard only.
- (b) `GET /v1/reports/records` returning **counts and non-identifying dimension values only**, over `ledger.logical_events` and the fact projections, under the same `MetricQuery` and the same watermark.
- (c) A raw-record browser showing individual records.

**Decided (R-25): (b).** (a) reduces the roadmap's three-way gate to a two-way one and drops the leg that actually proves anything — the API and the dashboard sharing a bug would agree with each other perfectly. (c) is a payload-exposure surface, forbidden by the sentence above, and it would need a whole authorisation and redaction story of its own.

Two rules:

- The response contains counts and the declared grouping values. It never contains `installation_id`, `click_id`, `record_id`, a payload, or a payload reference. Grouping by any installation-identifying column is refused at the parser, not at the query.
- **The surface is parameterized by `input_received_at_watermark`, not by wall-clock time.** This is the crux of the whole gate and the thing that would otherwise make it flaky: a metric run is fixed at a watermark, while a live count is as-of-now, so the two legitimately differ whenever evidence arrived after the watermark. Comparing them at the same watermark (`WHERE received_at <= $watermark`, the same inclusive rule M1 M-1 defines) is the only comparison that means anything, and it is exactly reproducible.

### M3-D-24. Difference-audit viewer

`differenceAudit` returns whole artifacts unfiltered. Add the same query object (date range, `difference_reason_code`, supersession) plus a per-row detail page rendering the persisted reconciliation artifact's own sections — matching keys, candidates, exclusions, windows, joins, freshness, and both snapshot IDs — as a table rather than as pretty-printed JSON.

Nothing about the artifact is recomputed for display. The viewer's only job is to make a stored artifact legible; any transformation that could change a value belongs in the engine, where the parity gate covers it.

### M3-D-25. Export

Two routes producing byte-identical bodies for the same filter:

- `GET /v1/reports/metrics?…&format=csv` — bearer only, unchanged shape.
- `GET /dashboard/apps/{appId}/cohorts.csv?…` — session only, same builder, same encoder.

Byte-identity for the same `MetricQuery` is an acceptance criterion, because it is the cheapest possible proof that the browser path and the API path did not fork.

Export responses carry `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, and `Cache-Control: no-store`. The filename includes the app, the range, and the short snapshot id, so a file on someone's disk can still be traced back to what produced it.

And the sentence from M3-D-10, repeated in the UI: this is an operator export of aggregate reports, not a data-subject export.

### M3-D-26. The three-way consistency check — how it is actually mechanised

The roadmap's evidence gate is *"Raw records, reporting API, and dashboard match under identical filters and definitions."* A prose promise here is worth nothing; the design has to make it a command that fails.

**Options**

- (a) A manual checklist.
- (b) An automated test that drives the HTTP API and scrapes the rendered HTML with a regular expression.
- (c) A typed seam: the renderer is split into `buildDashboardView(query) → DashboardView` (pure, typed) and `renderDashboard(view) → string` (pure). The gate asserts, at one fixed watermark and for a table of filter combinations, that the raw count rows, the API rows, and the `DashboardView` are equal as **typed values**; and separately that the numbers extracted from `data-*` attributes in the rendered HTML equal the view's numbers.

**Decided (R-25): (c).** (a) is not a gate. (b) makes the test depend on markup and wording, which the owner's testing standard rejects and which turns every CSS change into a failing test. (c) keeps the substantive assertion on typed contracts — where a field rename is a compile error rather than a silent pass — while still proving the last hop, that the renderer did not drop, round, or reformat a value on its way into the page.

The `data-*` extraction is deliberately narrow: each numeric cell carries `data-metric-run-id` and `data-value-unscaled`, and the test reads exactly those. That is structure, not wording; the visible text may change freely.

Fixed-watermark discipline: the gate seeds synthetic fixtures, runs one metric run at watermark `W`, and then asks all three surfaces for `W`. It never uses "now".

`npm run verify:consistency`, added to `runtime.yml`, is the command.

### M3-D-27. Undefined values on screen

M1 B8 established that an undefined ROAS is emitted with `value_state=undefined` and an `undefined_reason`, never `0` and never infinity, and never folded into a blended figure. The screen has to honour the same rule or the property is lost at the last hop:

- a table cell renders `—` plus the reason text (`no_attributed_cost`, `no_activity_events`, `empty_cohort`) as visible small text, not as a tooltip;
- the header strip shows how many cells on this page are undefined, so an operator sees at a glance whether they are looking at a mostly-empty table;
- the CSV cell is **empty**, with the reason in the existing `undefined_reason` column — not `0`, not `null`, not `N/A`;
- the SVG series shows a gap (M3-D-14);
- organic and unattributed cohorts remain **separate rows** and are never summed into an "all traffic" row that would imply an attributed cost they do not have.

---

## Data model additions

Same conventions as M1 and M2: `control.identifier`, `control.canonical_timestamp`, forced RLS with `SET LOCAL open_mmp.tenant_id`, append-only in `ledger` and `control`, deletable only in `ephemeral`.

- `ephemeral.dashboard_sessions` — as in M3-D-04. Tenant-scoped, no foreign key to `control.apps`, deletable, swept by the worker.
- `ledger.audit_logs` — `target_scope` CHECK gains `session`. New `action` values are runtime vocabulary and need no DDL.
- `control.admin_keys` / `control.admin_key_states` — `app_id` becomes nullable and the composite FK to `control.apps` is dropped (M3-D-16).
- `ledger.metric_runs` — a partial index on `supersedes_metric_run_id` (M3-D-19), and an index supporting `(tenant_id, app_id, metric_name, grouping_digest, metric_run_id)` keyset order if `EXPLAIN` shows the existing unique index does not serve it.
- `openmmp_reader` — `USAGE` on `ephemeral` and `SELECT` on `ephemeral.dashboard_sessions`; everything else it needs is already granted.

`docs/architecture.md` gains a `dashboard` component identifier, and `docs/threat-model.md` gains the matching row, or `npm run check:threat-model` fails — which is the intended behaviour, not an obstacle.

---

## Local runtime and CI

### Compose and first run (M3-D-28)

No new service, no new port, no new volume. The dashboard is served by the existing `api` service under `/dashboard`.

Bootstrap output gains one line: the dashboard URL, printed next to the admin key and the MAX postback template it already prints. The first-run promise is unchanged and gains a step that matters — after `docker compose up`, the operator has a URL, a key to paste into it, and a page that says "no data yet; run `npm run seed`".

New environment variables, all of which must appear in `.env.example` with a generator or a default because `npm run test:env-coverage` (M1 A13) fails otherwise:

`OPENMMP_DASHBOARD_ENABLED` (default `true`), `OPENMMP_DASHBOARD_SESSION_TTL_SECONDS` (`43200`), `OPENMMP_DASHBOARD_LOGIN_RATE_RPM` (`5`), `OPENMMP_DASHBOARD_LOGIN_RATE_BURST` (`10`), `OPENMMP_REPORT_MAX_ROWS` (`1000`), `OPENMMP_REPORT_EXPORT_MAX_ROWS` (`200000`). Plus exporting the already-existing `OPENMMP_READER_DATABASE_URL` into the `api` service environment (M3-D-13).

### CI (M3-D-29)

`runtime.yml` gains `npm run verify:consistency` and the M3 integration tests. `contract.yml` is untouched; its dependency surface must not grow, which M3 makes easy because M3 adds no dependency at all.

**And that fact should be a gate, not a claim.** M3-D-11's whole argument is "no new dependency"; the way to keep it true in six months is to assert it:

> The CycloneDX component list for `@open-mmp/api` produced by `npm run sbom` contains the same set of runtime components before and after M3. CI fails if the set grows.

This costs a few lines on top of the existing per-workspace SBOM gate (M1 D-29) and it is the only thing that will stop a future "just add one small library" from quietly reversing the decision.

### Time zone handling (M3-D-30)

Storage stays UTC and canonical-text-authoritative (M1 D-18). The dashboard renders each metric row's dates **in that run's own `aggregation_time_zone`**, labels the zone in the header strip, and never renders a browser-local time — which is trivially true here because there is no client JavaScript to ask the browser. Timestamps that are evidence (`computed_at`, `input_received_at_watermark`) are shown in their canonical UTC form, unmodified, because they are values a reader may need to paste back into a query.

---

## Acceptance criteria

Written as commands and observable outcomes; "verify" means the output goes into the completion report. The M1 D-30 / M2-D-32 principle applies: everything below runs on synthetic data with no real credentials and no browser automation. A human still has to look at the page once and say whether it is usable — that is an owner observation recorded in `docs/validation/`, not a code gate.

### M3a — headless code gates

**C-01 — login.** A correct admin key returns `303` with a `Set-Cookie` whose parsed attribute set is exactly `{HttpOnly, Secure, SameSite=Strict, Path=/}` and whose name matches the M3-D-05 rule for the configured base URL. A wrong key returns `401` with a body byte-identical to the unknown-key case and writes one `audit_logs` row with `outcome=failed`, `action=dashboard_login`, `actor_ref=admin_key:unrecognized`. Both keys work during a two-key overlap.

**C-02 — session lifecycle.** The cookie authenticates a dashboard page; `POST /dashboard/session/delete` removes the row and the same cookie then fails; a session past `expires_at` fails; the sweep deletes expired rows; a token that differs by one character fails. `SELECT count(*) FROM ephemeral.dashboard_sessions` returns to its starting value after logout.

**C-03 — GET never writes.** Every `mutates: false` route is executed against a handler constructed with the reader pool; a deliberately introduced `INSERT` in a read handler makes the test fail with insufficient privilege. Revert it and record that it failed.

**C-04 — credential separation.** Iterating the route table: no `/v1/` route is constructed with the cookie parser; no `/dashboard/` route accepts `Authorization`. A dashboard page requested with a valid bearer and no cookie returns `401`; a `/v1` endpoint requested with a valid session cookie and no bearer returns `401`.

**C-05 — CSRF.** A `/dashboard` POST without the token returns `403` and writes an audit row; with a token belonging to a different session returns `403`; with an `Origin` header naming another host returns `403`; with the correct token succeeds.

**C-06 — login abuse refuses before insert.** Exceeding `OPENMMP_DASHBOARD_LOGIN_RATE_RPM` returns `429`, and `SELECT count(*) FROM ledger.audit_logs` is **unchanged** across the throttled attempts. A full-text scan of every table and payload object after the run finds no occurrence of the source IP used.

**C-07 — boot self-check.** Starting with `OPENMMP_PUBLIC_BASE_URL=http://198.51.100.10:8080` and the dashboard enabled exits non-zero with a named error; `http://localhost:8080` and `https://example.invalid` start.

**C-08 — app registration.** `POST /v1/admin/apps` creates a `control.apps` row, writes `app_registered` and `sdk_key_issued` audit rows, and returns the SDK secret once; a second read never returns it and it appears in no audit row and no log line. Reporting for the new app returns an empty result set with a `200`, not an error. An unregistered `app_id` and another tenant's `app_id` return the identical `404`.

**C-09 — filter contract.** The same query string parsed twice yields an equal `MetricQuery` (deep typed equality). An unknown filter key returns `400 unknown_filter`. A limit above the maximum returns `400`. A fake client asserts that no filter value appears anywhere in the emitted SQL text and that every value is in the parameter array. A grouping key not present in `metric-run.schema.json` is rejected by the parser.

**C-10 — supersession.** Seeded with a superseded run and its replacement: `supersession=latest` returns one row; `all` returns both; the superseded row is flagged; the replacement carries `supersedes_metric_run_id` and `reproducibility_status=redaction_affected`; the earlier row's digest is unchanged.

**C-11 — pagination.** A keyset walk across three pages returns every row exactly once and terminates. Inserting a new metric run between page two and page three neither duplicates nor skips a row already returned.

**C-12 — row model and export equality.** `format=json` and `format=csv` carry identical values for every column including the new ones; the CSV header's existing columns are in their previous positions; the new columns are appended.

**C-13 — new metric definitions.** `npm run test:metric-parity` passes with `daily_click_count`, `daily_install_count`, and `cohort_install_count` grouped by `attribution_status`: the SQL engine's `metric_runs` are byte-identical after JCS to the evaluator's output for the same definitions and watermark. Organic, non-organic, and unattributed appear as three rows that sum to the ungrouped install count.

**C-14 — raw-record surface.** `GET /v1/reports/records` returns counts only; a response scan finds no `installation_id`, `click_id`, `record_id`, payload, or payload reference. Requesting a grouping by an installation-identifying column returns `400`.

### M3b — surface code gates

**C-15 — the roadmap evidence gate.** `npm run verify:consistency` exits 0. For at least eight filter combinations (all-apps default, a campaign filter, a country filter, an attribution-status filter, a date sub-range, a single metric name, `supersession=all`, and an empty result), at one fixed watermark `W`: the raw-count rows, the reporting API rows, and the `DashboardView` are equal as typed values, and the `data-value-unscaled` attributes extracted from the rendered HTML equal the view's values. Verify by pasting the summary line.

**C-16 — CSV path equality.** `GET /dashboard/apps/{id}/cohorts.csv?<Q>` and `GET /v1/reports/metrics?<Q>&format=csv` return byte-identical bodies.

**C-17 — no script, ever.** Every rendered dashboard body contains no `<script`, no `javascript:`, and no `on…=` attribute. The CSP response header parses to exactly the M3-D-07 directive set. A page requested with a broken stylesheet still renders its headings and tables in document order.

**C-18 — undefined stays undefined.** A cohort with no attributed cost renders `—` with `no_attributed_cost` visible, produces an empty CSV cell with the reason in `undefined_reason`, is absent from the SVG series (a gap, asserted on the path data), and never appears in a summed row.

**C-19 — chart purity.** The SVG generator is deterministic for a given series; its output parses as well-formed XML; a series containing `undefined` produces a discontinuous path; the output contains no `<script>` and no external reference.

**C-20 — no new dependency.** The CycloneDX runtime component set for `@open-mmp/api` is unchanged from the pre-M3 baseline. CI fails if it grows.

**C-21 — first run.** `docker compose up -d --wait` exits 0; `docker compose logs api` contains the dashboard URL; `GET /dashboard` unauthenticated returns `200` with a login form and no data; every data route without a session returns `401` or a redirect to the login page; after `npm run seed` and one metric run, the cohort page shows a number.

**C-22 — gates that must keep passing.** `npm run validate` prints its summary line unchanged (unless M3-H-1 landed first, in which case it changes exactly once, in that contract work order, and never in WO-7). `npm run test:env-coverage` and `npm run check:threat-model` pass with the new `dashboard` component. `npm run sbom` produces a file per workspace. `git diff --stat -- fixtures/` is empty.

### Owner-observed — `docs/validation/m3-operator-checklist.md`, not code gates

- **V-1 — the morning test.** An operator with real data opens the page once a day for five working days and records, each day, whether they could answer "did yesterday's spend do anything" without leaving the page. This is the only test of "usable" that means anything, and it cannot be automated.
- **V-2 — browser matrix.** Confirm the cookie is accepted and the page renders on current Chrome, Firefox, and Safari, including the `__Host-` prefix on an HTTPS deployment.
- **V-3 — TLS deployment.** Run behind the `proxy` profile and confirm the `Secure` cookie, the boot check, and the export download over HTTPS.
- **V-4 — legibility with real cardinality.** Record how the cohort table behaves at the operator's real campaign × country cardinality; the synthetic fixtures cannot produce it.

Results, campaign identifiers, and values stay outside the public repository, as `docs/validation/real-data-checklist.md` requires.

---

## Decisions adopted by R-25

| # | Decision | Recommendation |
| --- | --- | --- |
| M3-D-01 | M3a / M3b split | M3a headless (identity, API, definitions, migrations); M3b surface + consistency gate |
| M3-D-02 | What "usable" means | One morning screen: cohort table, attribution split, clicks/installs, freshness header, export; plus app registration, links, login |
| M3-D-03 | Human authentication | Login form taking the existing admin key; no new credential type; no user accounts (M3-S-1) |
| M3-D-04 | Session storage and lifetime | `ephemeral.dashboard_sessions`, SHA-256 of a 32-byte token, absolute 12 h, **no sliding window** so GET never writes (M3-S-2) |
| M3-D-05 | Cookie attributes | `HttpOnly; Secure; SameSite=Strict; Path=/`; `__Host-` only under HTTPS; boot refuses plain-HTTP non-localhost (M3-S-3) |
| M3-D-06 | CSRF | `/v1` never reads a cookie, `/dashboard` never reads a bearer; synchronizer token is the asserted control (M3-S-4) |
| M3-D-07 | CSP | `default-src 'none'` with `style-src`/`img-src`/`form-action` `'self'`; zero client JavaScript makes it honest (M3-S-5) |
| M3-D-08 | Login abuse and audit | In-memory buckets, memory-only IP, audit every attempt, **refuse before insert**; `target_scope` gains `session` (M3-S-6) |
| M3-D-09 | Authority level | One level; state in the threat model that a session equals the admin key; RBAC is M5 (M3-S-7) |
| M3-D-10 | DSAR promise | Ship operator export only and rewrite `privacy-security.md:87` in the same change; DSAR needs its own contract work (M3-S-8) |
| M3-D-11 | Rendering model | Server-rendered HTML from TypeScript, no framework, no bundler, no client JavaScript |
| M3-D-12 | Placement | Routes under `/dashboard` inside `apps/api`; separate hostname documented as operator hardening |
| M3-D-13 | Routing | Declarative route table with `auth` and `mutates`; read handlers get the `openmmp_reader` pool |
| M3-D-14 | Charts | One server-rendered inline SVG primitive from a pure function; undefined is a gap, never zero |
| M3-D-15 | Styling and assets | One CSS file, system fonts, no external requests, readable without CSS |
| M3-D-16 | Identity scope | Admin key becomes tenant-scoped; `app_id` becomes a validated request parameter; correct `architecture.md:158` |
| M3-D-17 | App registration | Creates the app row, mints one SDK key shown once, prints the app's link and postback templates |
| M3-D-18 | Filter contract | One typed `MetricQuery`, one parser, one SQL builder, shared in-process by the API and the dashboard |
| M3-D-19 | Supersession | `latest` by default, `all` available, superseded rows flagged with their history link |
| M3-D-20 | Pagination | Keyset cursor, default 200 / max 1000, separate export limit |
| M3-D-21 | Row model | Add rule-bundle, freshness, reproducibility, and supersession fields; CSV columns are appended, never reordered |
| M3-D-22 | Clicks / installs / attribution split | Contract metric runs, not ad-hoc counts; installs need no contract change, clicks need `metric_date` (M3-H-1) |
| M3-D-23 | Raw-record surface | Counts and declared dimensions only, watermark-parameterized, never payloads or identifiers |
| M3-D-24 | Difference-audit viewer | Same filter object; render the stored artifact's sections; recompute nothing |
| M3-D-25 | Export | Bearer and session paths share one builder and encoder and must be byte-identical; not a DSAR export |
| M3-D-26 | Consistency gate | Typed `DashboardView` seam plus narrow `data-*` extraction, all three legs at one fixed watermark |
| M3-D-27 | Undefined on screen | `—` plus reason, empty CSV cell, gap in the chart, never summed |
| M3-D-28 | Compose and first run | No new service or port; bootstrap prints the dashboard URL; six new documented env variables |
| M3-D-29 | CI and SBOM | Add `verify:consistency`; assert the API workspace's runtime component set does not grow |
| M3-D-30 | Time zones | Render in each run's `aggregation_time_zone` with the zone labelled; evidence timestamps stay canonical UTC |

---

## Handoffs

### To the contract (adopted for WO-7 under R-27)

| # | Severity | Item |
| --- | --- | --- |
| M3-H-1 | **Blocks an M3 roadmap item cleanly** | `metric-run.grouping.dimensions` closes at five properties and its only date is `cohort_date`, defined as the cohort acquisition day. Day-keyed metrics that are not cohort metrics — daily clicks first — have no honest key. Add an optional `metric_date`. Additive, one property, no existing golden changes. Without it, M3-D-22 falls back to showing clicks as an evidence count next to reproducible metric artifacts, and the asymmetry is permanent and visible on the main screen. |
| M3-H-2 | P2 | `metric-run` has no place for the *attribution method* the roadmap asks M3 to display. Method is a property of an individual attribution decision, not of an aggregate that may mix methods, so the honest display is the rule-bundle identity plus the `attribution_status` breakdown. Either state that in the spec, or add a closed `method_mix` to the artifact. Recommend stating it; a mixed aggregate labelled with one method would be a false claim. |

### To documentation (same change as WO-7)

| Target | Change |
| --- | --- |
| `docs/architecture.md:158` | "The authenticated scope, not request parameters, fixes the tenant and app" → the scope fixes the **tenant**; the app is a validated request parameter (M3-D-16). This corrects a sentence that was always stronger than M1 S-8's actual design. |
| `docs/architecture.md` Components | Add the `dashboard` component identifier; `docs/threat-model.md` gains the matching row or `check:threat-model` fails. |
| `docs/architecture.md` Reporting API | Document filters, supersession, pagination, the records surface, and the two export paths. |
| `docs/privacy-security.md:87` | Rewrite the DSAR sentence (M3-D-10). **Owner check.** |
| `docs/roadmap.md` M3 | State that "match under identical filters" means *at one fixed input watermark*, so the gate is not read as a wall-clock comparison. Keep the milestone name byte-identical across roadmap, project-plan, privacy-security, and threat-model. |
| `docs/project-plan.md` Phase 3 | Keep the crosswalk in step, per `AGENTS.md`. |
| `.env.example` | Six new variables plus `OPENMMP_READER_DATABASE_URL` in the api service environment. |

### To M5

- RBAC and roles, on top of M3's single authority level (M3-D-09).
- SDK key rotation and revocation UI (M3-D-17 ships issuance only).
- Subject access/portability, which needs its own contract work (M3-D-10).
- Any interactive client layer, which should be built over the same JSON API rather than by rewriting the pages (M3-D-11).

---

## References

Fetched and checked on **2026-08-20**.

| Topic | URL | What was confirmed |
| --- | --- | --- |
| `Set-Cookie` | `https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie` | "Insecure sites (`http:`) cannot set cookies with the `Secure` attribute. The `https:` requirements are ignored when the `Secure` attribute is set by localhost." `__Host-` requires `Secure` set by a secure page, no `Domain`, and `Path=/`; `__Secure-` requires `Secure` set by HTTPS. `SameSite` values `Strict`/`Lax`/`None` (`None` requires `Secure`); some browsers default to `Lax` when omitted. `HttpOnly` blocks `document.cookie` but the cookie is still sent by `fetch`/XHR. |
| Content Security Policy | `https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy` | Directive inventory including `default-src`, `script-src`, `style-src`, `img-src`, `connect-src`, `form-action`, `frame-ancestors`, `base-uri`, `object-src`, `require-trusted-types-for`. "By default, if a CSP contains a `default-src` or a `script-src` directive, then inline JavaScript is not allowed to execute"; inline code requires a nonce or a hash, and a nonce or hash causes `'unsafe-inline'` to be ignored. |

Repository facts used as premises, read on 2026-08-20 from `review/wo-6-m2`:

- `apps/api/src/reporting.ts` — `metricReport` selects every `ledger.metric_runs` row for the tenant/app with no filter, no pagination, and no supersession handling.
- `apps/api/src/router.ts` — the admin-key verification block appears three times; the scope passed to `verifyAdminKey` comes from `maxConfig` (environment variables), not from the key.
- `db/schema.sql` — `control.admin_keys.app_id` is `NOT NULL` with a composite FK to `control.apps`; `ledger.audit_logs.target_scope` has a closed `CHECK` list without `session`; `openmmp_reader` holds `SELECT` on `control` and `ledger`; `ephemeral` grants `SELECT, INSERT, DELETE` on `request_nonces` to `openmmp_app`.
- `schemas/metric-run.schema.json` — `metric_name` is an open pattern (`^[a-z][a-z0-9_]{2,127}$`) with no registry, so new metric names are not a contract change; `grouping.dimensions` is closed to five properties with `additionalProperties: false`, so a new dimension is.
- `.env.example` and `apps/runtime/src/bootstrap.ts` — `OPENMMP_READER_DATABASE_URL` already exists and a reader password is already generated, but the variable is not exported into the container runtime environment.
- No HTML, CSS, or bundler exists anywhere in the repository today.

## Verified during WO-7

Checked in the PostgreSQL-backed Runtime workflow on **2026-08-20**.

1. `openmmp_reader` executes the reporting and session lookups under forced RLS with `SET LOCAL open_mmp.tenant_id`. An unset tenant sees no app rows, the selected tenant sees its row, and a deliberate `INSERT` fails with SQLSTATE `42501`. No fallback to `openmmp_app` is used.
2. `cohort_install_count` groups organic, non-organic, and unattributed installs into disjoint rows whose counts sum to the ungrouped count. An install with no attribution row is classified as unattributed. The SQL result remains JCS-identical to the contract evaluator.

## Not verified

Stated as unverified rather than assumed.

1. Whether browsers accept the `__Host-` cookie name prefix on `http://localhost`. MDN states the prefix requirement in terms of HTTPS and does not mention the localhost exemption that it does state for `Secure`. **M3-D-05 removes the dependency** by using the prefix only under HTTPS.
2. Query performance of the supersession predicate and the keyset order at real cardinality. The indexes in [Data model additions](#data-model-additions) are proposed from the query shape, not from `EXPLAIN` output on realistic data.
3. Whether the existing CSV consumer set is empty. The CSV header is treated as a consumed interface (M3-D-21) on the assumption that someone may already be parsing it; no consumer has been surveyed.
4. Every rate and size default in M3-S-6 and M3-D-20 is a proposal, not a measurement.
5. Whether five working days of V-1 is enough to judge "usable". It is a proposal; the owner may want a different observation period, as `docs/review/2026-08-17-review.md` §6-7 did for the shadow pilot.
6. Whether any operator wants multiple humans on one deployment during M3. If they do, M3-D-09's single authority level becomes a real operational problem sooner than M5, and the ordering of RBAC should be revisited rather than absorbed.
