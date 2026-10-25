# App-scoped operator access

Current source supports an optional single-app restriction on each existing
`admin`, `operator` or `read_only` key. Keys without that restriction retain
tenant-wide access. This feature is not included in published rc.2 SDK assets.

The role sets capabilities; an app restriction only narrows their resource
scope. It cannot turn a reader into an operator or administrator. API lists,
details, CSV exports, cursor requests, job controls and dashboard sessions use
the same registered-app gate. Unknown, cross-tenant and unauthorized apps have
the same not-found response within each endpoint. A cursor is a position, never
a capability to read another app.

## Issue and retire keys

Use the existing app database connection and a tenant-wide **admin** key through
`OPENMASU_ADMIN_KEY_FILE` (preferred) or `OPENMASU_ADMIN_KEY`. Never put a key in
command arguments, a URL, a public file or an operational log. Run in the private
operator environment, not the public checkout with real credentials.

```sh
npm run admin:keys -- issue --tenant=synthetic-tenant --role=read_only --app=synthetic-app
npm run admin:keys -- retire --tenant=synthetic-tenant --key-id=key:synthetic-issued-id
```

Omitting `--app` explicitly issues a tenant-wide key. The command prints the new
key **once** as `admin_key` in JSON; capture it privately, then pass it as the
normal API bearer or dashboard login credential. It takes effect immediately;
server restart and a new authentication service are not required. The CLI
rejects duplicate/unknown flags and an empty or multi-app `--app` value.

Role and app scope are immutable. Issue a replacement and retire the old key to
change either. At most two keys may be active per role and app scope, allowing
rotation; the last active tenant-wide admin cannot be retired. Issuance and
retirement serialize per tenant, record only key references in the existing
audit ledger, and commit with the verifier/state change. Failed operations roll
back both. Reapplying old bootstrap configuration never reactivates a retired
key. Preexisting `admin_keys.app_id` metadata is not reinterpreted as a scope.

## Sessions and tenant-wide controls

An opaque dashboard session resolves role and app scope from its backing active
key on every request. Retiring that key invalidates both bearer access and all
of its existing sessions. A newly issued key requires a new login. Cookie-only
dashboard authentication and bearer-only `/v1` authentication remain separate;
CSRF and absolute session expiry remain unchanged.

App-scoped admins retain their own app's administrative controls. They cannot
register apps or tenant link domains, issue/retire operator keys, request a
tenant-wide privacy deletion, or read tenant-wide `/metrics`. Use an unscoped
tenant admin for these operations; monitoring may use an unscoped reader.
Tenant-wide forms are hidden from scoped sessions, but HTTP authorization is
still enforced independently of the HTML.

The backend's `openmasu_reader` connection remains a trusted tenant-RLS database
credential, not an app-scoped end-user SQL login. Do not distribute it to app
readers: application authorization is enforced at the HTTP/session boundary.
SSO, invitations, arbitrary ACLs and a general IAM service are outside scope.

Synthetic acceptance extends the existing production-controls integration suite
with two apps in one tenant and a foreign tenant, actual SQL-generated metric
runs, the real reader role, API/dashboard CSV identity, cursor isolation,
mutation refusal, legacy-key compatibility and CLI issuance/retirement. It does
not establish a live deployment or external identity-provider qualification.
