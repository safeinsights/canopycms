# EntryCreateModal silently reverts a typed slug to `untitled`

**Priority:** P1 — silent wrong data on disk, no error surfaced
**Found:** 2026-07-30, writing `media-upload.spec.ts` (program workstream C)
**RESOLVED:** 2026-08-12, branch `fix/entry-create-slug-race` — see Resolution below

## Symptom

An entry created through the "Add Entry" modal is occasionally written to disk
as `post.untitled.<id>.json` even though a custom slug was typed into the slug
input and the modal reported success. Observed roughly 1 time in 8 under the
render pressure of the e2e suite; never reproduced in isolation.

## Mechanism

`packages/canopycms/src/editor/components/EntryCreateModal.tsx` resets its slug
field to the literal `'untitled'` from a `useEffect` keyed on
`[isOpen, selectedEntryTypeName, entryTypes]`.

`entryTypes` is an array prop. If the parent re-renders and passes a new array
identity — even with identical contents — the effect re-runs and overwrites
whatever the user has typed. Any stray re-render landing between "fill the slug"
and "click Create" therefore reverts the slug, and the entry is created under
the default.

There is no user-visible signal: the modal closes, the entry appears in the
navigator under its entry-type label, and only the filename on disk is wrong.

## Fix direction

Either key the reset effect on something stable (e.g. `isOpen` plus the entry
type *name*, not the array), or memoize `entryTypes` at the parent, or move the
default-slug seeding to the modal's open transition rather than a value-derived
effect. A regression test should re-render the parent with a fresh-but-equal
`entryTypes` array while the modal is open and assert the typed slug survives.

## Workaround in place

`apps/test-app/e2e/tests/media-upload.spec.ts` looks entries up by **title**
(set in a later, unaffected step) rather than by slug — see the
`readPostContentByTitle` doc comment there. Remove that workaround once this is
fixed.

## Resolution

Root cause was a **lifecycle event written as a value-derived effect**. Seeding
now happens on the closed → open transition, keyed on `isOpen` alone
(`wasOpenRef` guard in `EntryCreateModal.tsx`), so prop identity churn can no
longer clobber user input. `Editor.tsx` additionally memoizes the `entryTypes`
array it passes, removing the churn at its source.

Not probabilistic in the component, as the original write-up assumed: a *single*
parent re-render reverts the field every time. The "~1 in 8" e2e rate only
measured how often a re-render landed inside the typing → submit window.

The same effect also reset `entryTypeName`, so a non-default **entry type**
choice reverted identically — a worse outcome (wrong schema/format written).
Fixed by the same change and covered by its own test.

Three regression tests in `EntryCreateModal.test.tsx` (the first two failed
against the unfixed component): typed slug survives a parent re-render with a
fresh-but-equal `entryTypes` array; chosen entry type survives the same; and
close → reopen still reseeds the defaults (guards against over-correcting into
"never resets").

The e2e workaround above is gone — `media-upload.spec.ts` now reads entries back
by slug via `readPostContentBySlug`.
