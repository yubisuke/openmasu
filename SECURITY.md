# Security Policy

## Current phase

Open MMP contains public contract artifacts and executable reference evaluators, but no runtime service. It is not production-ready.

## Reporting a vulnerability

Do not disclose suspected vulnerabilities, credentials, personal data, or live defense details in a public issue.

Use GitHub's private vulnerability-reporting flow when it is enabled for this repository. If that flow is unavailable, contact the repository owner through a previously established private channel and include only the minimum information needed to arrange a secure report.

A maintainer-approved private reporting path must be enabled before Milestone 1 accepts runtime code. Until then, the project is not ready for a runtime release.

## Scope

Reports may cover contract defects that could cause cross-tenant access, identifier leakage, deletion failure, replay acceptance, signature bypass, or exposure of private fraud controls. Deployment-specific credentials, personal data, and operational evidence must never be attached to a public report.

## Disclosure

Coordinate disclosure with the maintainer after a fix and validation plan exist. This document does not promise a response-time SLA during the design phase.
