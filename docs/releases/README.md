# Tagged Release Records

This directory contains immutable descriptions of tagged source and SDK
release candidates. Read each note together with the evidence manifest named by
that release. Do not update an older record to describe later `main` behavior.

| Tag | Record | Evidence |
| --- | --- | --- |
| `v0.2.0-rc.3` | [Release notes](v0.2.0-rc.3.md) | [Synthetic evidence](../validation/v0.2.0-rc.3-synthetic-evidence.md) |
| `v0.2.0-rc.2` | [Release notes](v0.2.0-rc.2.md) | [Synthetic evidence](../validation/v0.2.0-rc.2-synthetic-evidence.md) |
| `v0.2.0-rc.1` | [Release notes](v0.2.0-rc.1.md) | [Synthetic pilot record](../validation/v0.2.0-rc.1-pilot.md) |

The latest tagged candidate is `v0.2.0-rc.3`. The current `main` tree is newer
and unreleased; see [Project status](../STATUS.md). A future candidate requires a
new version, release note, exact-commit evidence manifest, and full platform
gates. An rc.3-named bundle built from post-tag `main` is not an rc.3 release
artifact.
