# Release Candidate Records

This directory contains descriptions prepared for source and SDK release
candidates. A record becomes immutable release evidence only when its matching
annotated tag and GitHub prerelease point to the same green `main` commit. Read
each note together with its evidence manifest. Do not update an older record to
describe later `main` behavior.

| Tag | Record | Evidence |
| --- | --- | --- |
| `v0.2.0-rc.4` | [Release notes](v0.2.0-rc.4.md) | [Synthetic evidence](../validation/v0.2.0-rc.4-synthetic-evidence.md) |
| `v0.2.0-rc.3` | [Release notes](v0.2.0-rc.3.md) | [Synthetic evidence](../validation/v0.2.0-rc.3-synthetic-evidence.md) |
| `v0.2.0-rc.2` | [Release notes](v0.2.0-rc.2.md) | [Synthetic evidence](../validation/v0.2.0-rc.2-synthetic-evidence.md) |
| `v0.2.0-rc.1` | [Release notes](v0.2.0-rc.1.md) | [Synthetic pilot record](../validation/v0.2.0-rc.1-pilot.md) |

The repository is configured for candidate `v0.2.0-rc.4`; rc.3 is the preceding
published tag. Verify the tag, GitHub prerelease, source commit, and full-gate
results before treating rc.4 as published. See [Project status](../STATUS.md).
An untagged bundle is only a local candidate artifact.
