# Security Policy

## Current phase

OpenMasu contains public contract artifacts, reference evaluators, runtime services, and SDK source backed by synthetic CI evidence. No production deployment, live provider connection, or real-device validation is established by this repository, and the project is not production-ready.

## Reporting a vulnerability

Do not disclose suspected vulnerabilities, credentials, personal data, or live defense details in a public issue.

Use GitHub's **Report a vulnerability** flow when the repository Security page
offers it. The repository does not publish a security email address. If GitHub
private reporting is unavailable, use only a previously established private
channel to ask the repository owner for a secure handoff and include no exploit,
credential, personal data, or live defense detail in that first message.

If neither private path exists, do not post the vulnerability details in a
public issue. The absence of an available private channel is a maintainer release
gap, not authorization for public disclosure of sensitive material.

## Scope

Reports may cover contract defects that could cause cross-tenant access, identifier leakage, deletion failure, replay acceptance, signature bypass, or exposure of private fraud controls. Deployment-specific credentials, personal data, and operational evidence must never be attached to a public report.

## Disclosure

Coordinate disclosure with the maintainer after a fix and validation plan exist. This document does not promise a response-time SLA.
