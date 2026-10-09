---
adopters: BOTH
summary: >-
  RESOLVED 2026-10-09, branch `fix/preview-reference-resolution-depth`, base `chore/backlog-frontmatter` — adopter request #94. Live preview re-resolves references at every position `read()` does (groups, objects, object lists, blocks, nested), batched 100 ids per request, and the frame never receives a bare id: `useReferenceResolution` runs in `Editor.tsx` during render, so a pending reference is `null` with `isLoading` `true`. `isLoading` is typed `PreviewLoadingState<T>`; `isResolvedReference` is exported from `canopycms`; the README says what a view receives
---
# Live preview resolves references only at the top level, and its first frame carries bare ids

**Status: RESOLVED 2026-10-09** on `fix/preview-reference-resolution-depth` (adopter request #94).

## What was wrong

- The README promised reference resolution "at any depth" in the preview, but the editor walked
  only top-level fields and inline groups (`flattenGroupFields`). A reference inside an object, an
  object list or a block reached the view as its bare id, so adopters kept reference fields at the
  top level of their data model.
- `FormRenderer` reported the resolved value through a callback into `Editor` state, so until that
  effect ran the preview frame received the raw form value: every reference as its id string.
- The README's example typed a reference as `AuthorContent | null`; a view reading `.name` off an id
  string renders nothing, so adopters narrowed every reference by hand.

## What shipped

- `traverseFields` hands each container a `dataPath`, the key path from the root (a block item's
  record sits under `value`). Additive; no other caller changes.
- `client-reference-resolver.ts` walks the draft with it and fills each reference from a cache
  keyed `<branch>:<id>`. The ids it lacks go to `POST /:branch/resolve-references` in batches of 100.
- Missing targets: an id the endpoint omits caches as `null` for `MISSING_REFERENCE_TTL_MS` (10s),
  after which the next edit asks again, since the target can be created meanwhile. A branch switch
  clears the cache. A failed request caches nothing (the reference stays pending). An `unavailable`
  object passes through as sent.
- A malformed id is never sent (the endpoint rejects a whole request for one) and reads `null`.
  When the open entry changes, cached targets are fetched again while still shown.
- `useReferenceResolution` is called by `Editor.tsx`, outside the form's per-field crash
  boundaries, and computes the preview value during render.
- `isResolvedReference(value)` (root `canopycms`) narrows a reference field's value to its target.
- `PreviewLoadingState<T>` types `isLoading` as a mirror of the data.

## Not done here

- A custom `renderPreview` still receives the raw form value; see
  [render-preview-receives-raw-references.md](../render-preview-receives-raw-references.md).
