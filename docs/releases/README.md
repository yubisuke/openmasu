# Release Records

This directory contains descriptions prepared for source and SDK releases. A
record becomes immutable release evidence only when its matching annotated tag
and GitHub Release point to the same green `main` commit. Read
each note together with its evidence manifest. Do not update an older record to
describe later `main` behavior.

| Tag | Record | Evidence |
| --- | --- | --- |
| `v0.2.0` | [Release notes](v0.2.0.md) | [Synthetic evidence](../validation/v0.2.0-synthetic-evidence.md) |
| `v0.2.0-rc.4` | [Release notes](v0.2.0-rc.4.md) | [Synthetic evidence](../validation/v0.2.0-rc.4-synthetic-evidence.md) |
| `v0.2.0-rc.3` | [Release notes](v0.2.0-rc.3.md) | [Synthetic evidence](../validation/v0.2.0-rc.3-synthetic-evidence.md) |
| `v0.2.0-rc.2` | [Release notes](v0.2.0-rc.2.md) | [Synthetic evidence](../validation/v0.2.0-rc.2-synthetic-evidence.md) |
| `v0.2.0-rc.1` | [Release notes](v0.2.0-rc.1.md) | [Synthetic pilot record](../validation/v0.2.0-rc.1-pilot.md) |

`v0.2.0` is the current published source and SDK release. Its annotated tag,
[GitHub Release](https://github.com/yubisuke/openmasu/releases/tag/v0.2.0),
and full platform workflows identify green `main` commit `68b8c48`.
`v0.2.0-rc.4` remains the latest published prerelease and frozen historical
record. Verify the tag, source commit, and full-gate results independently when
consuming a release. See [Project status](../STATUS.md). An untagged bundle is
only a local candidate artifact.
