# Contributing to OpenMasu

OpenMasu is a contract-first mobile measurement platform with reference evaluators, runtime services, and SDK source. Read [AGENTS.md](AGENTS.md) before changing the repository, and use the setup and validation commands in [Getting started](docs/getting-started.md) and [Development](docs/development.md) rather than duplicating environment instructions here.

## Local workflow

- Create a working branch from `main`; never edit `main` directly.
- Keep each commit focused and write commit messages in English.
- Run `npm run validate` before reporting a completed change.
- GitHub authentication, pushes, issues, pull requests, releases, and other remote writes require explicit authorization for the exact operation.

## Contract artifacts

- Follow the documented workflow in [fixtures/v0.4/README.md](fixtures/v0.4/README.md) when proposing a fixture. Golden outputs require human review and a written derivation; validation must not regenerate them.
- Treat every published schema identifier as frozen, including the active
  Contract v0.4 `$id` values and version constants. Earlier complete lines are
  preserved by the `contract-v0.1`, `contract-v0.2.1`, and `contract-v0.3.6`
  tags. Follow [the schema versioning policy](docs/schema-versioning.md) and
  document compatible patches or migrations in the matching guide.
- Commit evaluator or schema behavior changes separately from reviewed golden changes. The behavior commit establishes the proposed rule; a following golden-only commit records the independently reviewed expected artifacts and derivations. Never regenerate or silently update approved golden files during validation.
- Do not include real user, campaign, credential, provider-export, or live fraud-defense data in public fixtures or documentation.

## Continuous integration scope

Every pull-request workflow keeps its existing required job context. The local
classifier in `tools/ci/changed-scope.mjs` skips expensive steps that cannot be
affected by the changed paths; unknown paths and detection failures run every
gate. Documentation runs contract and drift checks, runtime code runs the
runtime gate, SDK sources run their native and packaging gates, and workflow,
tooling, or dependency changes run everything. A newer commit to the same pull
request cancels its superseded run. Pushes to `main` and manual dispatches
always run all gates and are never canceled by this policy.

## Real data never enters this repository

This repository is public. Real or production data — MMP exports, ad revenue, media cost, identifiers, campaign, ad-set, creative, or app names, and any value derived from them — must never enter the repository in any form: files, fixtures, tests, documentation, commit messages, or examples. Fixtures are synthetic only. Guardrails enforce part of this: `.gitignore` excludes tabular exports and lab/input directories, and both CI and `npm run validate` fail if a tracked or addable file has a `.csv`, `.tsv`, `.xlsx`, `.xls`, or `.parquet` extension, sits under an `openmasu-lab/`, `real-data/`, or `input/` directory, or is a non-JSON file under `fixtures/`. If a future importer needs a synthetic CSV fixture, allow-list that exact path in `.gitignore`, `tools/validate.ts`, and the CI step in the same change and explain in the pull request why the file is synthetic.
