# M3 Operator Validation Checklist

This checklist records observations that cannot be established by the synthetic code gate. Do not commit real campaign names, values, exports, credentials, session tokens, source IP addresses, screenshots containing real data, or operator notes from a live deployment to this public repository.

The automated baseline is `npm run verify:consistency` plus the Runtime workflow. It covers the typed query contract, PostgreSQL reader isolation, metric parity, aggregate-only record counts, API/dashboard CSV byte identity, undefined-value rendering, zero-JavaScript CSP, and the API runtime SBOM component baseline.

## V-1: Five-day morning test

For five working days, an authorized operator opens the dashboard once and records outside this repository whether the page answered: "Did yesterday's spend produce measurable activity?"

- [ ] Day 1 observation stored privately
- [ ] Day 2 observation stored privately
- [ ] Day 3 observation stored privately
- [ ] Day 4 observation stored privately
- [ ] Day 5 observation stored privately
- [ ] Any missing definition, filter, or freshness signal has an owner and follow-up date

## V-2: Browser matrix

- [ ] Current Chrome accepts the session cookie and renders headings, tables, CSV links, and SVG gaps
- [ ] Current Firefox accepts the session cookie and renders the same aggregate values
- [ ] Current Safari accepts the `__Host-openmmp_dashboard` cookie on HTTPS
- [ ] The page remains legible with the stylesheet blocked
- [ ] No browser request is made to an external asset, script, font, or analytics endpoint

## V-3: TLS deployment

- [ ] The deployment uses HTTPS and the `__Host-openmmp_dashboard` cookie name
- [ ] The cookie attributes are `HttpOnly`, `Secure`, `SameSite=Strict`, and `Path=/`
- [ ] A non-loopback HTTP base URL fails the boot self-check
- [ ] Reverse-proxy access-log retention and redaction are documented privately
- [ ] Login throttling across multiple API replicas is documented or explicitly accepted as single-process only

## V-4: Real cardinality and usability

- [ ] Campaign × country × date cardinality is tested outside the public repository
- [ ] Query latency and export size are recorded privately
- [ ] The keyset walk is checked for duplicates and omissions under normal ingestion
- [ ] Undefined values remain visible as undefined rather than zero
- [ ] Organic, non-organic, and unattributed rows remain separate
- [ ] Aggregate CSV is not represented as a DSAR or installation-level export

## Public completion boundary

Leave this file as a procedure. Live results remain private. A checked item in a private deployment does not change the public repository's claims unless a separate, non-identifying evidence record is explicitly approved.
