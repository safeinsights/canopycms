# `apps/example1` typecheck fails: TS2742 on the two `canopycms-next` static helpers

**Status:** Open, small-medium, downgraded to P3-ish (see 2026-08-21 re-check below) — **does not
currently reproduce**. Found 2026-08-20 while fixing adopter-request-log item `#23` (`select`
field inference) — entirely unrelated to that change, and confirmed present at the unmodified base
commit before any edit was made.

**Re-checked 2026-08-21** while building the `apps/example1` CI build gate
([resolved/example1-next-build-not-in-ci.md](resolved/example1-next-build-not-in-ci.md)), which
made "does this actually fail typecheck" directly relevant to scoping that work. Answer: **no.**
`pnpm install --frozen-lockfile` followed by `pnpm typecheck` at the repo root (recursive, the same
invocation CI runs) passes cleanly for `apps/example1` today, with zero TS2742s. Checked why: both
`apps/example1/node_modules/next` and `packages/canopycms-next/node_modules/next` are symlinks into
the SAME pnpm store path — `next@15.5.21` with an identical peer-dependency hash suffix (both pull
in the same `@babel/core`/`@playwright/test`/`react`/`react-dom` versions) — so pnpm deduplicates
them to one physical module, and `tsc` never has to name a type by reaching across two distinct
copies. This answers the file's own "open question" below: it is not a CI-vs-local install-layout
difference (the file's original guess), it is that the two installs currently happen to resolve
identically everywhere.

**Why this stays open rather than moving to resolved/:** nothing was fixed, and nothing prevents
the two `next` installs from re-diverging — a version bump to either package's dependents that
changes just one side's peer resolution (an unrelated devDependency bump, a canopycms-next-only
peer range change, etc.) reproduces this with no warning, since neither install is pinned to force
alignment. If it recurs, prefer fix option 2 below (re-export the surfaced Next types from
`canopycms-next`) over option 1 — it is the one that survives either install layout, not just
today's.

## What happens

`pnpm typecheck` is recursive and CI runs it (`.github/workflows/ci.yml:62`). Every
package passes; `apps/example1` fails with three errors, all TS2742:

```
app/lib/canopy.ts(66,14): error TS2742: The inferred type of 'contentSitemap' cannot be
  named without a reference to '../../../../packages/canopycms-next/node_modules/next/
  dist/lib/metadata/types/alternative-urls-types'. This is likely not portable.
app/lib/canopy.ts(66,14): ... '.../metadata-types'
app/lib/canopy.ts(76,14): ... '.../packages/canopycms-next/node_modules/next'
```

Both bindings at `apps/example1/app/lib/canopy.ts:66` and `:76` are exported `const`
arrows with **inferred** return types that transitively mention Next's metadata types.

## Why

There are two separate `next` installs in the tree:

- `apps/example1/node_modules/next`
- `packages/canopycms-next/node_modules/next`

`canopycms-next` returns types sourced from *its* copy, so when `tsc` writes the
inferred type for a binding in `example1` it can only name them by reaching across into
the other package's `node_modules` — which is exactly what TS2742 refuses to do.

The nested install is deliberate: the repo's standing rule is that each package must be
self-sufficient rather than relying on a hoisted root install. So **the fix is not to
hoist `next` to the root.** The two candidate fixes are:

1. **Annotate the two bindings explicitly** — the remedy TS2742 itself names. Import
   the option/return types from `canopycms-next` and write them out. Cheapest, and
   local to the example app, but it has to be redone for every new binding of this
   shape.
2. **Make `canopycms-next` re-export the Next types it surfaces**, so a consumer can
   name them through `canopycms-next` instead of through Next. Fixes the class for
   every adopter, not just the example app — and adopters hit this too, since an
   adopter app plus an installed `canopycms-next` reproduces the same two-copy layout.
   Prefer this one if the re-export surface stays small.

## Open question — does CI actually see this?

Unverified. It reproduces in a local worktree install, and `apps/example1/app/lib/
canopy.ts` is unchanged since it landed on `main`, so `main` itself should be red here.
If CI is green, its install layout differs from a local one (single hoisted `next`), and
that difference is itself worth knowing before choosing between fix 1 and fix 2 —
option 2 is the only one that survives either layout. **Check a recent CI run on `main`
before doing anything else**; if CI is green this is a local-only papercut and drops to
P3, and if CI is red it has been red for a while and nobody noticed.

## Related

- Adopter-facing surface: `generateContentSitemap` / `entryToMetadata` on
  `NextCanopyContextResult` (`packages/canopycms-next/src/static.ts`).
- [adopter-request-log-intake.md](adopter-request-log-intake.md) — where `#23` came
  from; this was found alongside it, but is not one of its items.
