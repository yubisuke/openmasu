# Contributing to Open MMP

Open MMP is currently a contract and reference-evaluator project. Read [AGENTS.md](AGENTS.md) before changing the repository, and use the setup and validation commands in the [README](README.md#contract-validation) rather than duplicating environment instructions here.

## Local workflow

- Create a working branch from `main`; never edit `main` directly.
- Keep each commit focused and write commit messages in English.
- Run `npm run validate` before reporting a completed change.
- GitHub authentication, pushes, issues, pull requests, releases, and other remote writes require explicit authorization for the exact operation.

## Contract artifacts

- Follow the reviewed workflow in [fixtures/v0.2/README.md](fixtures/v0.2/README.md) when proposing a fixture. Golden outputs require human review and a written derivation; validation must not regenerate them.
- Treat schema identifiers published at the `contract-v0.1` tag as frozen. Follow [the schema versioning policy](docs/schema-versioning.md) for later changes and document migrations in a version-specific migration guide.
- Commit evaluator or schema behavior changes separately from reviewed golden changes. The behavior commit establishes the proposed rule; a following golden-only commit records the independently reviewed expected artifacts and derivations. Never regenerate or silently update approved golden files during validation.
- Do not include real user, campaign, credential, provider-export, or live fraud-defense data in public fixtures or documentation.

## Real data never enters this repository

This repository is public. Real or production data — MMP exports, ad revenue, media cost, identifiers, campaign, ad-set, creative, or app names, and any value derived from them — must never enter the repository in any form: files, fixtures, tests, documentation, commit messages, or examples. Fixtures are synthetic only. Guardrails enforce part of this: `.gitignore` excludes tabular exports and lab/input directories, and both CI and `npm run validate` fail if a tracked or addable file has a `.csv`, `.tsv`, `.xlsx`, `.xls`, or `.parquet` extension, sits under an `open-mmp-lab/`, `real-data/`, or `input/` directory, or is a non-JSON file under `fixtures/`. If a future importer needs a synthetic CSV fixture, allow-list that exact path in `.gitignore`, `tools/validate.ts`, and the CI step in the same change and explain in the pull request why the file is synthetic.
