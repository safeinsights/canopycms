---
priority: P3
adopters: NEITHER
summary: >-
  New 2026-10-09. `Editor.preview-references.test.tsx` "hands the frame null for a pending reference, never its id, then the resolved target" failed 3/3 in isolation at load average ~140 and passed 3/3 at lower load with no code change: under load the first frame carrying entry data already holds resolved references, so its `[null, null]` assertion races the resolve request. Make the pending state observable deterministically (hold the resolve response until the pending frame is seen)
---
# A preview-references test races the reference resolve under machine load

**Status:** Open. **Priority: P3.** Filed 2026-10-09 while gating
`fix/preview-highlight-focus-regression`.

## What happens

`packages/canopycms/src/editor/Editor.preview-references.test.tsx`, test "hands the frame null
for a pending reference, never its id, then the resolved target", asserts that the first
PreviewFrame render carrying the entry's data has `null` at both reference positions. Its
`stubApi()` answers `/resolve-references` immediately, so whether a render lands between the
entry load and the resolve result depends on scheduling. With the machine at load average
~140 it failed 3 runs of 3 in isolation (`expected [ { id: 'perAAAAAAAAA', … }, … ] to deeply
equal [ null, null ]`); with the same files at lower load it passed 3 of 3, and on base.

## Fix

Hold the `/resolve-references` response behind a promise the test releases only after a frame
with `[null, null]` has been recorded, so the pending state is asserted rather than raced.
