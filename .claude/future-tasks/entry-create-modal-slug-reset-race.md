# EntryCreateModal silently reverts a typed slug to `untitled`

**Priority:** P1 — silent wrong data on disk, no error surfaced
**Found:** 2026-07-30, writing `media-upload.spec.ts` (program workstream C)

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
