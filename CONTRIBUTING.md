# Contributing to Open MMP

Open MMP is currently a contract and reference-evaluator project. Read [AGENTS.md](AGENTS.md) before changing the repository, and use the setup and validation commands in the [README](README.md#contract-validation) rather than duplicating environment instructions here.

## Local workflow

- Create a working branch from `main`; never edit `main` directly.
- Keep each commit focused and write commit messages in English.
- Run `npm run validate` before reporting a completed change.
- GitHub authentication, pushes, issues, pull requests, releases, and other remote writes require explicit authorization for the exact operation.

## Contract artifacts

- Follow the reviewed workflow in [fixtures/v0.1/README.md](fixtures/v0.1/README.md) when proposing a fixture. Golden outputs require human review and a written derivation; validation must not regenerate them.
- Treat existing v0.1 schema identifiers as frozen. Breaking and non-breaking schema changes, version resolution, and the v0.2 layout are to be defined in the v0.2 contract work before a versioned schema change is accepted.
- Do not include real user, campaign, credential, provider-export, or live fraud-defense data in public fixtures or documentation.
