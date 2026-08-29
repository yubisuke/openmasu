# Codex Prompt: Create One Approved MMP Gap Issue

> Historical record. This prompt reflects the gap review dated 2026-08-21 and
> must not be used as a current backlog or GitHub instruction. Start from the
> [current roadmap](../roadmap.md) and obtain fresh authorization for any
> GitHub operation.

The current gap summary has no `Build` rows. Use this prompt only after pilot
evidence causes the owner to change and approve exactly one capability's
decision as `Build` in `docs/review/mmp-gap-analysis-2026-08-21.md`.

## Rules

1. Before any authenticated GitHub read, obtain explicit authorization for the
   exact account/repository check and duplicate search.
2. After that authorization, verify that:
   - `git gh api user --jq .login` returns `yubisuke`;
   - `git gh repo view --json nameWithOwner --jq .nameWithOwner` returns
     `yubisuke/openmasu`.
3. Search open and closed issues for duplicates. Stop without creating anything
   if the read authorization or either identity check fails.
4. Create at most one GitHub issue. Never bulk-create the gap list.
5. Do not implement the issue in the same operation.
6. Write the issue in English.
7. Keep the issue to one provider, platform, or measurable outcome.
8. Treat `docs/roadmap.md`, `docs/STATUS.md`, and `docs/product-scope.md` as the
   current product boundary. The gap summary does not override them.
9. Before the GitHub write, present the final title and body and separately
   verify all of the following:
   - the user explicitly authorized this exact issue creation;
   - the account and repository checks above still identify `yubisuke` and
     `yubisuke/openmasu`;
   - the selected capability still has the decision `Build`.
10. If any check fails or the selected capability is ambiguous, stop and ask the
   user. Do not guess.

## Issue shape

Use this structure:

```markdown
## Why now

State the observed pilot or operator evidence that makes this the next gap.

## Current boundary

Describe what OpenMasu already does and the exact missing part.

## Smallest change

Define one provider, platform, or measurable outcome. Do not bundle adjacent
features.

## Acceptance criteria

- Add deterministic tests with synthetic data.
- Preserve privacy, attribution-category, and append-only boundaries.
- Add the relevant operator verification step.
- Update only the canonical documents affected by the change.

## Non-goals

List neighboring commercial-MMP features that this issue will not add.

## Evidence

Link the gap-summary row, current code, and the relevant primary provider
documentation.
```

Use `git gh issue create --repo yubisuke/openmasu` only after presenting the
final title and body and receiving the required explicit authorization.
