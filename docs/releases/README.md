# Release Records

This directory contains descriptions prepared for source and SDK releases. A
record becomes immutable release evidence only when its matching annotated tag
and GitHub Release point to the same green `main` commit. Read
each note together with its evidence manifest. Do not update an older record to
describe later `main` behavior.

| Tag | Record | Evidence |
| --- | --- | --- |
| `v0.3.0-rc.1` | [Release notes](v0.3.0-rc.1.md) | [Frozen requirements](../validation/v0.3.0-rc.1-synthetic-evidence.md) and [public receipt](../validation/v0.3.0-rc.1-publication.md) |
| `v0.2.0` | [Release notes](v0.2.0.md) | [Synthetic evidence](../validation/v0.2.0-synthetic-evidence.md) |
| `v0.2.0-rc.4` | [Release notes](v0.2.0-rc.4.md) | [Synthetic evidence](../validation/v0.2.0-rc.4-synthetic-evidence.md) |
| `v0.2.0-rc.3` | [Release notes](v0.2.0-rc.3.md) | [Synthetic evidence](../validation/v0.2.0-rc.3-synthetic-evidence.md) |
| `v0.2.0-rc.2` | [Release notes](v0.2.0-rc.2.md) | [Synthetic evidence](../validation/v0.2.0-rc.2-synthetic-evidence.md) |
| `v0.2.0-rc.1` | [Release notes](v0.2.0-rc.1.md) | [Synthetic pilot record](../validation/v0.2.0-rc.1-pilot.md) |

`v0.3.0-rc.1` is the current published prerelease. Its annotated tag,
[GitHub Release](https://github.com/yubisuke/openmasu/releases/tag/v0.3.0-rc.1),
eight SDK assets and full platform workflows identify green `main` commit
`90a0f5f`. Candidate notes/requirements remain frozen at that tag; the separate
receipt records their completed publication and public download checks.
`v0.2.0` remains the latest non-prerelease source line at `68b8c48`.
Earlier prereleases are frozen historical records. Verify the tag, source
commit, and full-gate results independently when
consuming a release. See [Project status](../STATUS.md). An untagged bundle is
only a local candidate artifact.

[Next release scope](next.md) is a living development inventory, not a tagged
release note or evidence manifest. It does not change an existing release.
