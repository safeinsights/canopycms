# Export `defaultBuildPath`

## Priority: P3 [KB]

From the 2026-08-13/14 site audits, verified finding 2 in the go-live
briefing. Triaged as part of the 2026-08-14 go-live backlog re-baseline. No
existing task file covered this. **This epic (`integration-202608-b`, PR
#235) is implementing this now** — don't double-build.

## Problem

`defaultBuildPath` is module-private (`content-tree.ts:188`), while
`buildContentTree` — the function that calls it — is exported. So an adopter
who wants to extend the default build-path logic (add a fallback, change how
a segment maps to a path) has no way to reuse the default; they have to
reimplement it whole. `docs-site-proto` did exactly that, verbatim, in
`src/lib/canopy-helpers.ts` — which is a silent URL-drift risk: if the
package's `defaultBuildPath` logic ever changes, the KB's copy silently
diverges with nothing to catch it.

## Fix

Export `defaultBuildPath` alongside `buildContentTree` from wherever
`content-tree.ts`'s public surface already lives (no new package entrypoint —
this is an existing module's export list). Small, mechanical change; the
value is entirely in removing the KB's hand-copy once this ships.

## Follow-up (not this task)

Once exported, the adopter's verbatim hand-copy of the default should be
deleted in favor of importing the real one — that's adopter-repo work, tracked
outside this backlog.
