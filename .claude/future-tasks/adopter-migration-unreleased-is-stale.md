# `docs/adopter-migration.md`'s Unreleased section covers three shipped releases

**Status: open.** Found 2026-09-11 while adding an entry for
[asset-upload-behavior-from-a-bucket-alone.md](resolved/asset-upload-behavior-from-a-bucket-alone.md).

## Problem

`docs/adopter-migration.md` has a `## Released` section whose newest heading is `### 0.0.63`,
then `### 0.0.62 and earlier`. `0.0.64`, `0.0.65` and `0.0.66` have all been released
(`chore: release v0.0.64`, `v0.0.65`, `v0.0.66` are all ancestors of `main`, and `main`'s
`package.json` reads `0.0.66`). None has a section.

Everything shipped in those three releases is therefore still filed under `## Unreleased` —
roughly 1,150 lines, from the `media.uploadUrl` entry (`#44`) down to the static-exports entry.
`#44` in particular is verifiable: commit `b91b60a9`, which built its CDK half, is an ancestor
of `main`.

## Why it matters

The document's own instructions tell an adopter to "work top-down through the entries for every
version between your current pin and your target", and to resolve that target with
`npm view canopycms version`. An adopter pinned to a `0.0.66` prerelease who does exactly that
is told that everything they are already running has not shipped yet — so the entries that
would tell them what they can now delete read as speculative future work. The "Now deletable"
lists are described in the document as the point of it, and they are the part this
misfiling neutralises.

## Why it was not fixed in passing

Re-filing needs a per-entry mapping to a release boundary, and getting one wrong tells an
adopter a feature landed in a version that does not contain it — worse than the current
undifferentiated state. That is a careful pass over ~1,150 lines against `git log`, not a
docs tidy-up to fold into an unrelated PR.

## Shape of the fix

For each entry currently under `## Unreleased`, find the commit that introduced the behaviour
and the first `chore: release` commit that contains it, then move the entry under a new
`### 0.0.64` / `### 0.0.65` / `### 0.0.66` heading in `## Released`. Anything with no such
release commit genuinely is unreleased and stays. Worth adding a check to
`scripts/check-future-tasks.mjs`'s neighbourhood — or to the release workflow — so the next
release moves its own entries rather than accumulating another three.

## Related

- [document-release-process.md](document-release-process.md) — the release process is
  undocumented outside workflow comments, which is plausibly why this step has no owner.
