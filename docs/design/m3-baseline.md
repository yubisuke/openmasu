# Dashboard and Reporting Design

Status: implemented and synthetically verified. See
[Project status](../STATUS.md) for the evidence vocabulary and open operator
gates.

## Goals

- show one operator view of persisted metrics and difference evidence;
- keep API JSON, CSV export, typed view models, and HTML values consistent;
- prevent dashboard authentication from weakening the versioned API;
- add no client-side JavaScript or front-end dependency chain.

## Rendering model

The existing API process renders semantic HTML, a static local stylesheet, and
deterministic inline SVG. Pages remain readable in document order without CSS.
Undefined values display an em dash and a visible closed reason. A missing
series point creates an SVG gap rather than a zero.

## Authentication boundary

An admin key is exchanged for an opaque random session token. Only the token
digest is stored. Sessions have an absolute lifetime and do not slide. Secure
deployments use a `__Host-` cookie; local HTTP uses the development cookie name.
Cookies are HttpOnly and SameSite Strict. State-changing forms require both a
synchronizer CSRF token and matching Origin.

API routes ignore dashboard cookies. Dashboard routes ignore bearer headers.
Reader routes use the PostgreSQL reader role and never mutate state.

## Reporting contract

One query parser validates app, metric, grouping, half-open date range,
watermark, supersession mode, limit, and route-specific keyset cursor. Unknown
or identifying grouping fields are rejected. Metric, aggregate-record, and
stored-difference cursors are distinct and cannot be used on the wrong route.
SQL uses fixed fragments and bound values only.

Latest mode excludes artifacts superseded in the same tenant/app scope. All mode
includes history and marks superseded rows. Ordering is deterministic by metric
name, grouping digest, and run ID. Aggregate-record ordering uses metric name
and canonical PostgreSQL `jsonb` text; stored differences use reconciliation
ID. Every JSON page returns an optional `next_cursor`. CSV retains stable column
order and uses the same row encoder as JSON and dashboard export. A complete
CSV export fails closed with `export_limit_exceeded` instead of returning a
partial file; paged CSV responses expose the continuation in `X-Next-Cursor`.

`watermark_at_most` fixes metric and raw aggregate-record selection. Stored
reconciliation artifacts do not currently carry a comparable selection
watermark, so the difference route does not claim that filter as a reproducible
reconciliation cutoff.

## Consistency gate

At a fixed synthetic watermark, raw aggregate records, persisted metric rows,
API output, dashboard view models, rendered data attributes, and CSV are compared
across default, dimension, date, metric, history, and empty-result queries. A
mutation test proves that one altered value breaks the comparison.

## Security headers

Dashboard responses use `no-store`, `nosniff`, `no-referrer`, frame denial, and
a restrictive content security policy with no script source. All text and
attributes are escaped. Login failure is rate-limited before audit writes to
prevent audit amplification.

## Residual boundary

Synthetic HTML and database gates do not prove production TLS, accessibility
with real report cardinality, operator usability, identity-provider integration,
or long-running browser support.
