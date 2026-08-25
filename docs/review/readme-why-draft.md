# Draft: Why Open MMP Exists

This file is a proposed replacement for the README's "Why this project exists" section. It is a review artifact only and does not change the current README.

## Who it is for

Open MMP is for teams that need to understand and defend their own mobile measurement results. It is intended to let an operator:

- reproduce and explain reported numbers from retained raw evidence and versioned policies;
- run measurement infrastructure whose cost is primarily proportional to its own processing and storage; and
- verify in code which data is collected and, just as importantly, which data is not collected.

## Why it is open

Measurement disagreements are difficult to resolve when event meanings, attribution decisions, and aggregation rules are hidden behind separate implementations. Open MMP provides a shared, versioned vocabulary for those differences. Its public contracts and synthetic fixtures are designed so that another team, an independent implementation, or an AI-assisted implementation can reproduce the same result without access to a private service. Open development also makes the boundaries, assumptions, and evidence handling available for external audit.

## What it is not

Open MMP is not a neutral third party for billing reconciliation. It does not claim partner-only access or user-level attribution where an advertising platform requires an approved MMP relationship. In particular, user-level attribution for platforms such as TikTok, AppLovin, Unity, or Mintegral remains outside this project's scope when it depends on partner status. Google App campaigns also exclude third-party click measurement from this project's planned capabilities.

The project instead focuses on an auditable measurement layer for first-party evidence and interfaces that an operator can lawfully access. Examples include Meta Install Referrer decryption, Apple AdServices, and developer postbacks from SKAdNetwork or AdAttributionKit. These examples describe reachable integration surfaces, not a claim that the integrations are already implemented or production-ready.
