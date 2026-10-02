# `docs/adopter-migration.md`'s Unreleased section covers three shipped releases

**Status: RESOLVED 2026-10-01.** Found 2026-09-11 while adding an entry for
[asset-upload-behavior-from-a-bucket-alone.md](asset-upload-behavior-from-a-bucket-alone.md).

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

## Resolved 2026-10-01

Triggered by an adopter on `0.0.67-int.90` who hit this and spent a verification pass on
it. Worth recording what that incident did _not_ show, because it is easy to misread: the
`int.90` entries were never stranded or awaiting a merge — they were in the tree at
`92961874`, the exact commit `int.90` was built from, alongside the code they describe.
Code and docs ship in lockstep on the integration branch.

Each of the 28 entries was mapped by finding the commit that introduced its heading into
the file, then the earliest release tag containing that commit. The mapping was validated
against the code: `b91b60a9`, the CDK half of `#44` named above, lands on `v0.0.66`, which
is where the doc-commit proxy independently put that entry. Result: 10 entries to
`0.0.64`, 11 to `0.0.66`, 7 genuinely unreleased. Nothing mapped to `0.0.65`, which was
tagged about two hours after `0.0.64` on the same day — it gets a heading saying so, since
a missing section and an empty one are indistinguishable to a reader.

The recurrence guard asked for above is check 9 in `scripts/check-docs.mjs`: `pnpm
lint:docs` fails when a release tag reachable from `HEAD` has no `### <version>` section.
It is inert on a shallow clone (what CI checks out), which is deliberate and said at the
check — lint-staged runs `lint:docs` on every commit touching Markdown, locally, where the
tags exist. It catches an unlisted release, not a misfiled entry; that still needs a read
of `git log`.

## Related

- [document-release-process.md](../document-release-process.md) — the release process is
  undocumented outside workflow comments, which is plausibly why this step has no owner.
  Its adopter half shipped 2026-10-01.
