# AGENTS.md

## Project

- This folder contains the development work for a self-hostable, open-source Mobile Measurement Partner.
- Project documentation, GitHub issues, pull requests, and release notes must be written in English by default.
- Code identifiers and API field names must use English.
- The initial product entry point is a Shadow MMP. The first native attribution vertical slice targets Android and Unity.
- `docs/roadmap.md` is the canonical milestone sequence. When a milestone, exit gate, or ordering changes, update its project-plan crosswalk in that file and the corresponding summary in `docs/project-plan.md` in the same change.

## Current state

- M0.4 Contract v0.4.0 and the M1 through M5 synthetic implementation milestones are complete. Runtime services, PostgreSQL, HTTP APIs, Kotlin and Swift SDKs, Unity bridges, and separate deterministic/SKAdNetwork/AdAttributionKit reporting exist. Real-device, live-provider, Unity-export, App Store, and production-deployment evidence does not yet exist.
- The active contract lives in `schemas/`, `schemas/events/`, `registries/`, `fixtures/v0.4/`, and `spec/event-metric-contract-v0.4.md`. The spec is normative for current contract behavior. Earlier complete contract lines remain at the `contract-v0.1`, `contract-v0.2.1`, and `contract-v0.3.6` tags. Issue drafts are historical records, not live checklists.
- Future work must follow `docs/roadmap.md` and preserve the residual boundaries in `docs/STATUS.md`.

## Running validation

- Pinned tool versions: Node.js `22.18.0` from `.nvmrc`, npm `11.6.2` from `package.json` `engines`, and Python `3.13.5` from `.python-version`. `.npmrc` enforces the Node.js and npm engine versions.
- Setup:

  ```bash
  npm ci
  python -m pip install --require-hashes --requirement requirements-contract.txt
  ```

- Full validation gate: `npm run validate`. It type-checks the TypeScript, compiles every schema, validates every registry and fixture, runs both the TypeScript and Python evaluators, and checks RFC 8785 canonical output. It normally completes in a few seconds. Run it after any change under `schemas/`, `registries/`, `fixtures/`, `spec/`, or `tools/`, and paste its final summary line into your report.
- Type-check only (faster, partial signal): `npm run typecheck`.
- Android/Unity synthetic gates: `./sdk/android/gradlew -p sdk/android androidAcceptance verifySdkSbom`, an API 36 emulator running `:sample:connectedDebugAndroidTest`, and `dotnet run --project sdk/unity/tests/UnityCompileProbe.csproj --configuration Release`.
- iOS synthetic gates run on macOS: `swift test --package-path sdk/ios`, iOS Simulator builds of the shipping products and sample, the pinned AppLovin provider compile probe, `node tools/check-ios-sdk.mjs --built-root <DerivedData>`, and the Unity C# bridge probe. The pinned `sdk-ios` workflow is the Windows development environment's authoritative Xcode evidence.
- `npm run validate` is strictly read-only: it never writes, regenerates, or reformats fixture files. If a change requires a new or updated golden fixture, follow the candidate and human-review workflow in `fixtures/v0.4/README.md`, hand-edit the `fixtures/v0.4/<NN-name>/expected_*.json` files, and explain in your report exactly how each expected value was derived.

## What must not change casually

- `fixtures/v0.4/<NN-name>/expected_*.json` files are reviewed, immutable golden artifacts (see `fixtures/v0.4/README.md`). Editing one changes what "passing" means for that scenario. Treat it as a contract-behavior change, not a routine test update, and call it out explicitly in your report even if `npm run validate` still passes afterward.
- Schema `$id` values (`urn:openmasu:schema:<artifact>:v0.4`) and the `contract_version` / `schema_version` constants are part of the public contract identity. Do not change an existing `$id`, or bump `schema_version`, without following `docs/schema-versioning.md`, updating every dependent fixture and evaluator path, and explicitly flagging the compatibility impact.
- Registry files (`registries/*.json`) are referenced both by `$ref`/enum from schemas and by name in prose inside `spec/event-metric-contract-v0.4.md`, `docs/`, and `issue-drafts/`. If you add, rename, or remove a registry value, grep for every place that value (or the full enumeration it belongs to) appears in prose and update all of them in the same change — do not update only the registry file.

## Documents to update together

- `docs/roadmap.md` and `docs/project-plan.md`: the milestone/phase crosswalk (already required above).
- `spec/event-metric-contract-v0.4.md`'s validation-gate summary (schema count, registry count, fixture count, golden-artifact count, scenario-assertion count, acceptance-criteria count) must match the literal final-line output of `tools/validate.ts`. If you add or remove an `AC##` entry in `tools/validate.ts`, a fixture directory, or a schema file, update this prose in the same change — do not let the two drift.
- Any registry value list written out in prose inside `spec/`, `docs/`, or `issue-drafts/` must match its source registry file in `registries/` exactly, field for field. Update every prose enumeration in the same change as the registry file.
- `docs/privacy-security.md`'s release-gate table and `docs/threat-model.md`'s residual-risk section both reference `docs/roadmap.md` gate ownership by milestone name; keep the milestone names byte-identical across all three documents.

## GitHub boundary

- Use the `yubisuke` account only when the user explicitly authorizes that specific GitHub operation.
- Without explicit authorization, do not authenticate with `gh`, read through the authenticated account, create or modify repositories, add or change remotes, run `git push`, or create issues, pull requests, or releases.
- Do not infer a repository name or visibility setting.
- Before any GitHub write, verify the account, exact `OWNER/REPO`, visibility, and operation.
- Local design, implementation, and testing do not imply that anything has been published to GitHub.
- Without GitHub write authorization, a finished task means: the change is committed on a local working branch (never directly on `main`), `npm run validate` passes, and the change and validation output are reported. Pushing, opening pull requests or issues, and any other remote write require explicit authorization.

## Product constraints

- Do not implement device fingerprinting.
- The SDK must not collect personal data by default.
- Advertising identifiers may be handled only when explicitly configured and permitted by platform rules and required consent.
- Store and display deterministic, platform-assigned, aggregate privacy-preserving, estimated, and unknown attribution as distinct categories.
- Use primary Apple, Google, and media-platform sources for behavior that depends on external specifications.
- Keep received evidence append-only where lawful, but redact personal data when a valid deletion request requires it. Append-only is not a reason to retain identifiable deleted data.
- Keep the measurement core open while separating deployment secrets and live fraud-defense policy.
- This repository is public. Real or production data — MMP exports, ad revenue, media cost, identifiers, campaign/ad-set/creative/app names, or any value derived from them — must never enter it in any form (files, fixtures, tests, docs, commit messages, examples). Fixtures are synthetic only. `.gitignore`, CI, and `npm run validate` enforce the file-level part of this rule; see CONTRIBUTING.md.
