# Security Policy

## Current phase

OpenMasu contains public contract artifacts, reference evaluators, runtime services, and SDK source backed by synthetic CI evidence. No production deployment, live provider connection, or real-device validation is established by this repository, and the project is not production-ready.

## Reporting a vulnerability

Do not disclose suspected vulnerabilities, credentials, personal data, or live defense details in a public issue.

Use GitHub's private vulnerability-reporting flow when it is enabled for this repository. If that flow is unavailable, contact the repository owner through a previously established private channel and include only the minimum information needed to arrange a secure report.

A maintainer-approved private reporting path must remain enabled for runtime releases. If no private path is available, disclose only enough through a previously established private channel to arrange a secure report.

## Scope

Reports may cover contract defects that could cause cross-tenant access, identifier leakage, deletion failure, replay acceptance, signature bypass, or exposure of private fraud controls. Deployment-specific credentials, personal data, and operational evidence must never be attached to a public report.

## Disclosure

Coordinate disclosure with the maintainer after a fix and validation plan exist. This document does not promise a response-time SLA.
