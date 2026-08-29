# Audit, Privacy, and Rule Provenance Design

Status: implemented and synthetically verified. See
[Project status](../STATUS.md) for the evidence vocabulary and open operator
gates.

## Data-subject access and portability

Dashboard reporting is an aggregate operator surface and is not a data-subject
export. An enrolled installation may sign an access or portability request only
for its own installation. Tenant administrators may use the authenticated
management path for requests they are authorized to make.

The response is a closed allowlist of normalized facts and opaque scoped
references. It excludes raw payloads, provider credentials, encrypted blobs,
unrelated installations, and internal database rows. Responses use `no-store`
and are independently audited from deletion.

## Rule provenance

Attribution, metric, Apple postback, and fraud artifacts bind the exact rule
bundle ID, version, and hash used at evaluation time. Registered definitions use
canonical JSON and verified digests. Current-revision views may advance, but a
historical artifact remains reproducible from its recorded revision.

No production decision may claim an all-zero placeholder hash. Contract fixture
defaults are permitted only in offline reference evaluation.

## Device-reported evidence

The contract classifies `deep_link_open` and similar client observations by
their actual authority. Device-reported evidence can be forged and therefore
cannot silently become redirector- or provider-verified evidence. Public
reports retain the source and verification state needed for later fraud or
reconciliation rules.

## Evidence gates

- same-installation authorization and cross-install denial;
- allowlisted access and portability output;
- deletion remains a separate lifecycle;
- registered bundle resolution and hash verification;
- byte-identical replay under the recorded revision;
- no placeholder hash on runtime artifacts;
- forgeable evidence retains its source classification.
