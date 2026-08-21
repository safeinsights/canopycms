# `next build` in `mode: 'dev'` reads the branch clone, not the working tree — contradicts DEVELOPING.md

**Priority:** P1 — documented behavior is wrong, and following it wastes real time (see below)
**Found:** 2026-08-15, PR #235 human-review fix session (fix/human-review-235), while proving a
build-guard fix with real `next build` runs against `apps/example1`

## Problem

`DEVELOPING.md`'s "Dev Content Sync" section states:

> In dev mode, the editor and dev server read content from a branch clone under
> `.canopy-dev/content-branches/<branch>/`, while the static build reads the working tree
> directly.

Verified directly (temporary diagnostic logging in `content-listing.ts`'s `listEntries`, then a
real `next build` against a `mode: 'dev'` app): this is **not what happens**. `listEntries` (and
by extension `buildContentTree`) resolves its `branchRoot` via `resolveSchemaContext` ->
`loadOrCreateBranchContext` -> `resolveBranchPaths` UNCONDITIONALLY — there is no `isBuildMode()`
branch in that path at all (`context.ts`'s `resolveSchemaContextImpl`, shared by both
`listEntries` and `buildContentTree`). For `mode: 'dev'`, that always resolves to
`.canopy-dev/content-branches/<branch>/`, during `next build` exactly as during `next dev`. A
build-time `getUser()` short-circuit exists (`isDeployedStatic(...) || isBuildMode()` ->
`STATIC_DEPLOY_USER`), but that only changes WHO the read is authorized as, not WHERE the read
happens.

Concretely: editing `content/**` in the working tree and running `next build` immediately
afterward silently builds against whatever was last provisioned into the `.canopy-dev` clone
(itself seeded from git-committed state, not the live working tree or even the git index) —
**not** the edit just made. Deleting `.canopy-dev` and rebuilding re-provisions the clone from
git HEAD, which still does not see an uncommitted change.

This is exactly the trap this session's own task briefing warned about ("three previous agents
lost time to this"), and it cost real time in this session too before the cause was isolated.
The doc's own framing plausibly used to be true (or was the intended design) and drifted, or was
written aspirationally — either way, an agent or contributor who trusts it and edits
working-tree content expecting a build to pick it up will get silently stale build output with
zero error, which is a worse failure mode than a build that simply reads the wrong place loudly.

## Suggested fix

Two separate questions, best handled together:

1. **Fix the documentation first, regardless of the design question below** — `DEVELOPING.md`'s
   "Dev Content Sync" section should describe what `next build` actually reads today (the branch
   clone, seeded from git-committed state) rather than the working tree, and should say so
   plainly enough that "add a file, run `next build`, expect to see it" reads as the trap it is.
2. **Decide whether the CODE should change to match the doc's original claim** — i.e., should
   `next build` (an actual production build, not `next dev`) resolve content straight from the
   working tree for `mode: 'dev'` apps, bypassing the branch-clone machinery entirely? That would
   make local static builds match what a real deploy does more closely (no branch/clone concept
   at all for a one-shot static build) and would remove this trap outright. This is a real design
   decision — it changes what "build-time content" means for every `mode: 'dev'` adopter — not
   something to change as a drive-by fix.

Either way, a fast, reliable way to verify: temporarily add a debug log of `branchRoot` in
`content-listing.ts`'s `listEntries`, or check `.canopy-dev/content-branches/<branch>/content/`
directly after a build — a file present only in the working tree (uncommitted, or even staged
but uncommitted) will be absent from the clone.

## Confirmed again, 2026-08-21 (`feat/sitemap-path-for-index-entries`)

Cost another session real time, in exactly the shape the last paragraph above predicts — a
**staged but uncommitted** `git mv`. Renaming `apps/example1`'s home entry to an `index` slug and
running `next build` produced a build that was green, prerendered `/`, and was reading the OLD
filename: the sitemap still advertised `/home` and `/` rendered the 404 page, because the branch
clone is seeded from git-committed state. Committing the rename and rebuilding gave the expected
result with no other change.

Two details worth adding to the eventual fix or doc:

- The failure is **silent and green**, not an error. The only tells were content-level (`/home`
  still in the emitted sitemap, `_not-found` markup in `index.html`), so a build that is merely
  "successful" proves nothing about which content it read.
- `rm -rf .canopy-dev` does NOT help, which is counter-intuitive: the clone is re-provisioned from
  git, so a fresh workspace reproduces the stale content exactly.
