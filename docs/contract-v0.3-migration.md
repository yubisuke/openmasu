# Contract v0.3 Historical Migration

This document summarizes the migration from Contract v0.2.1 to the completed
v0.3.6 line. It is historical guidance. The complete v0.3.6 contract is
preserved at the `contract-v0.3.6` tag; the active working contract is v0.4.

## Identity and paths

- schema identifiers moved to the v0.3 minor line;
- artifact and event versions moved to `0.3.0`;
- fixtures moved to `fixtures/v0.3/` at that release;
- later patches remained additive within the v0.3 minor line.

The current repository path is `fixtures/v0.4/` because the later OpenMasu
identity migration moved the complete v0.3.6 set. Use the tag when inspecting
the original v0.3 paths.

## v0.3.0 capabilities

- third-party referrer classification and explicit missing/invalid authority;
- typed Meta Install Referrer response and normalized context;
- imported attribution evidence that can include a protected click reference;
- install origin, self-attributed network, and attribution-status grouping;
- custom events, advertising-revenue precision, and wrapper provenance;
- public click-injection suspicion and explicit CTIT authority;
- stronger reconciliation reasons for missing candidates and unmatched external
  rows.

## Additive patch history

| Patch | Capability |
| --- | --- |
| 0.3.1 | daily metric date, event-count selector, and event-name sets |
| 0.3.2 | iOS launch origin, AdServices outcomes, signing environment, and supported SKAN minor versions |
| 0.3.3 | Apple aggregate metric definitions and conversion bucket grouping |
| 0.3.4 | conversion-schema provenance and conversion-value lifecycle event |
| 0.3.5 | optional server-assigned platform-integrity evidence |
| 0.3.6 | payload-schema-invalid rejection at the runtime import boundary |

Each addition was exercised by new synthetic fixtures. Earlier conforming
artifacts retained their meaning and schema IDs stayed on the v0.3 minor line.

## Consumer guidance

Do not mix v0.2 and v0.3 contract sets. New implementations should target the
active v0.4 contract. Use this document to understand historical meaning only;
use the tagged schemas and specification for exact validation.
