# Pull Request CI Scope Validation

OpenMasu keeps every required pull-request job visible while avoiding work that
cannot be affected by a change. The classifier is fail-open: unknown paths,
detection failures, pushes to `main`, and manual workflow runs execute every
gate.

## Expected documentation-only result

A pull request that changes only Markdown documentation must produce these
results:

| Required job | Expected work |
| --- | --- |
| `validate (ubuntu-24.04)` | Full contract, documentation, and guardrail validation |
| `validate (windows-2025)` | Full contract, documentation, and guardrail validation |
| `runtime` | Successful no-op after changed-scope detection |
| `android-jvm` | Successful no-op after changed-scope detection |
| `android-emulator` | Successful no-op after changed-scope detection |
| `ios-sdk` | Successful no-op after changed-scope detection |

The no-op jobs remain required contexts; they are not skipped jobs. Changes to
workflow, tooling, dependency, or unknown paths execute all gates. Platform and
runtime evidence for a release must come from the full `main` push or manual
workflow at the candidate commit, never from a path-reduced pull request.

## Reproduction

1. Create a pull request containing only a Markdown change under `docs/`.
2. Confirm that all six required jobs are present.
3. Confirm that the two `validate` jobs run the full contract checks.
4. Confirm that the remaining jobs report their named `No ...-sensitive
   changes` step and complete successfully without dependency installation,
   native builds, emulators, simulators, database migrations, or containers.
5. Confirm separately that a push to `main` executes all gates.

This validation uses only repository-controlled synthetic inputs. It does not
exercise credentials, real provider data, devices, or production services.
