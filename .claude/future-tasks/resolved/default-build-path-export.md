# Export `defaultBuildPath`

## RESOLVED (2026-08-14, epic `integration-202608-b`)

From the 2026-08-13/14 site audits, verified finding 2 in the go-live
briefing. Triaged as part of the 2026-08-14 go-live backlog re-baseline.

## Problem

`defaultBuildPath` was module-private (`content-tree.ts:188`), while
`buildContentTree` — the function that calls it — is exported. So an adopter
who wants to extend the default build-path logic (add a fallback, change how
a segment maps to a path) had no way to reuse the default; they had to
reimplement it whole. The knowledge base site did exactly that, verbatim, in
its own helper module — a silent URL-drift risk: if the package's
`defaultBuildPath` logic ever changed, that copy would silently diverge with
nothing to catch it.

## What shipped

`defaultBuildPath` is now exported from `canopycms/server` (`server.ts:122`
re-exports the `content-tree.ts:211` implementation), alongside
`buildContentTree`. No new package entrypoint — this rides the existing
`canopycms/server` export list. `buildPath`'s JSDoc documents the default's
exact behavior.

## Follow-up (not this task)

The adopter's verbatim hand-copy of the default should be deleted in favor of
importing the real one now that it's exported — that's adopter-repo work,
tracked outside this backlog.
