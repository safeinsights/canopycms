# [P3] CODEBASE_GUIDE.md's with-canopy.ts row still cites bare `assignDefaults`

**Priority:** P3. Documentation-only staleness, no behavior at stake.

**Found:** 2026-09-13, by the phase-3 mechanical claim-check of commit `c32410eb` ("docs: claims
pass over the CMS image epic (#331)") on `int-202609-cms-image`.

## What's stale

That commit corrected every citation of Next's `assignDefaults` (which drops `undefined`/`null`
before migrating legacy `experimental.*` keys) to note it is `assignDefaultsAndValidate` in Next
16.1.7 — in `with-canopy.ts`'s own JSDoc, `ARCHITECTURE.md`, and
`cms-image-build-epic.md`. `CODEBASE_GUIDE.md`'s `with-canopy.ts` table row was not touched and
still reads "`undefined`/`null` count as unset, as in Next's `assignDefaults`", with no
16.1.7-name parenthetical.

## Why this file didn't fix it in the same pass

The row (`CODEBASE_GUIDE.md`, the `with-canopy.ts` line in the `canopycms-next/src/` table) is a
single giant pipe-table cell that is also the table's width pacesetter (2712 characters,
matching the separator row to within one space). This same phase-3 pass already used that row's
exact-length-preserving budget to fix a different, explicitly-flagged staleness (C-W14, the
version-warning firing condition) — net zero characters added, verified via `git diff --stat`
showing exactly one line changed and `prettier --check` reporting no further reformatting.
Adding `, \`assignDefaultsAndValidate\` in 16.1.7` costs +39 characters with no obvious same-cell
trim of that size that doesn't also touch text this pass wasn't scoped to touch, so it was left
for its own pass rather than risking a whole-table repad (which would obscure this fix's diff and
every future diff against this table until someone re-derives the pacesetter math again).

## Direction

Add `(\`assignDefaultsAndValidate\` in 16.1.7)` after the `assignDefaults` citation, the same
wording already used in `with-canopy.ts` and `ARCHITECTURE.md`. Before touching the row, measure
its current length and the table's other rows' padding (`python3 -c` over the file, or eyeball
via `awk '{print length}'`) — if this row is still the pacesetter, either find same-cell trims
that net the addition to zero, or accept the ensuing `prettier --write` repad of the whole
`canopycms-next/src/` table and confirm with `git diff --stat` that only whitespace changed on
the other rows (no other cell's wording moves).
