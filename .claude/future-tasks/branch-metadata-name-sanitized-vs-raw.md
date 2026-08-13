# `branch.json`'s `name` has two writers that disagree about sanitized vs raw ref

Captured 2026-08-13 by PR-4 of the 2026-08-12 adversarial review of
`integration-202607-a` (finding L14). The divergence itself was known — it was
recorded 2026-08-12 inside a **struck/RESOLVED** finding's body in
[program-b-final-review-followups.md](resolved/program-b-final-review-followups.md)
("Related and NOT changed: the rebase loop writes the _sanitized_ directory name
into metadata's `name` field while the API writes the raw ref name"). That is
the wrong place for open work — a reader scanning for live findings skips struck
ones — so this file exists to make it findable. **Nothing is being fixed here.**

## The divergence, verified at tip

Branch workspace directories are named `sanitizeBranchName(ref)`
(`paths/branch-name.ts:21`), which strips characters outside `[A-Za-z0-9._-]`.
A branch named `feature/x` lives in a directory named `feature-x`. Three
writers put three different things in `branch.json`'s `name`:

- **`branch-workspace.ts:148`** (`openOrCreateBranch`, the normal creation path)
  writes `safeName` — the **sanitized** name. `api/branch.ts:281-285` documents
  this as the invariant: "Comparison uses the sanitized name since that's what's
  persisted in branch.json".
- **`api/admin-branch-health.ts:405`** (metadata repair) deliberately writes the
  clone's **actual checked-out ref**, via `resolveRepairedBranchName`
  (`:434`), and its docstring (`:425-432`) says why: "writing `dirName` as
  `branch.name` would make later push/PR tasks target the wrong ref."
- **`worker/cms-worker.ts`** writes the **sanitized directory name**
  (`branchDir`) on every partial `meta.save`: `:1082`, `:1106`, `:2007`,
  `:2068`, `:2244`, `:2390`. `save()` merges field-wise, so each of these
  overwrites whatever `name` held.

The interaction worth naming: the worker's writes **silently revert the repair
path's deliberate choice.** Repair sets `name` to the real ref so push/PR tasks
target it; the next worker cycle that touches that branch — a rebase, a
PR-state poll, a rewrite-marker clear — puts the sanitized directory form back.
That is exactly the outcome `resolveRepairedBranchName`'s docstring exists to
prevent.

Note the same file already knows the two can differ: `cms-worker.ts:2178`
computes `branchRef` from `git rev-parse --abbrev-ref HEAD` under the comment
"branchDir is the sanitized DIRECTORY name and need not match it", and gates
every publish path on it. So the worker uses the real ref where it matters and
the directory name where it writes metadata.

## Why it is harmless today (re-verified, not inherited)

Every consumer that could be hurt either sanitizes both sides or is keyed on
sanitized names already:

- `getBranchProtection` (`authorization/protected-branch.ts:71-74`) sanitizes
  the name **and** both base-branch candidates before comparing — this is the
  load-bearing consumer, reached from `api/branch.ts:504`, `api/guards.ts:211`,
  and the branches-list wire flags.
- `resolveBranchPaths` (`paths/branch.ts:99`) sanitizes `branch.name` before
  deriving a path, so no unsanitized value reaches a filesystem join.
- `services.ts:312` and `api/github-sync.ts:44` sanitize both sides of their
  base-branch comparisons.
- `BranchRegistry.get` (`branch-registry.ts:152`) compares `branch.name`
  **exactly**, but its only production caller passes a sanitized value
  (`api/branch.ts:293`), and the registry is populated from the same metadata,
  so today both sides are the sanitized form.

And the divergence is not currently reachable through CanopyCMS's own paths:
`openOrCreateBranch` creates the git ref from `safeName` too
(`branch-workspace.ts:136-142`), so for any branch CanopyCMS created, ref ==
directory == metadata name. A workspace whose ref differs has to come from
somewhere else — a hand-provisioned clone, or a future feature that adopts an
existing GitHub branch. `resolveRepairedBranchName` was written on the premise
that such workspaces exist.

## What would make it bite

Two consumers use `branch.name` as a **ref** with no sanitization:

- `api/github-sync.ts:97` — `head: context.branch.name`, the PR's head ref.
- `services.ts:325,330` — `git.checkoutBranch(...)` / `git.push(...)`.

If a workspace ever holds a ref that differs from its directory name, those
target `feature-x` while the real branch is `feature/x`: the push creates a
divergent ref and the PR opens against the wrong head. That is the failure the
repair path's comment describes, and it is one worker cycle away from being
re-armed after any repair.

## Fix direction (undecided)

Pick one meaning for the field and make every writer honour it. The two shapes:

1. **`name` is always the real ref.** Matches what push/PR consumers assume.
   Requires the worker's six `name: branchDir` writes to resolve the ref (it
   already computes `branchRef` in the rebase loop) and requires every
   name-keyed comparison to sanitize — most already do.
2. **`name` is always sanitized**, and the real ref lives in a separate field.
   Matches what `openOrCreateBranch` and `api/branch.ts:281-285` already claim,
   and makes `BranchRegistry.get`'s exact match correct by construction; the
   repair path would write the ref into the new field instead.

Cheapest correct step either way: stop the worker from writing `name` at all in
its partial saves — none of those six sites is trying to change the name, they
just repeat it into a merge payload. `BranchMetadataUpdate.branch` is
`Partial<...>` (`branch-metadata.ts:289-291`), so omitting it type-checks and
the field-wise merge preserves whatever is on disk. The one thing to check
first: what `save()`'s defaults path does with an absent `name` when
`branch.json` does not exist yet — the worker's six sites all run against an
existing file, but that should be pinned rather than assumed.

Rated P3 because no adopter path produces a divergent ref today. It becomes P2
the moment branches can be provisioned from existing refs.
