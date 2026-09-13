# Admin status: report whether image processing is available

## Priority: P3

Filed 2026-09-12 by PR 2 (`fix/sharp-lazy-load`) of [cms-image-build-epic.md](cms-image-build-epic.md),
which deferred it by decision: for now the loud signal is a one-time error log.

## State

sharp loads lazily, through `loadSharp()` in `packages/canopycms/src/assets/sharp-loader.ts`.
When the native binary cannot load in a process (a libvips `.so` missing from a standalone
image, or a binary built for another platform), the editor stays up and only image work
degrades:

- `applyTransform` rejects, so the dev-mode `/assets/t/*` route and the transform Lambda
  answer 500.
- Upload finalize fails open: raster uploads are accepted without decode validation
  (`rasterIsDecodable` in `assets/pipeline.ts`).

The signals are one `canopyLogError` line per process from `loadSharp()` and a per-upload
`console.warn` from finalize. An operator who is not reading logs sees broken transformed
images and never learns that uploads are going through unvalidated.

## Proposal

Add `imageProcessing: { available: boolean; error?: string }` to the admin status response
(`GET /admin/status`, `api/admin.ts`), and surface it in the admin UI next to the rest of
that response.

## Open questions

- **Probe or report?** Calling `loadSharp()` from the status handler makes the first admin
  status request load libvips in that process. Reporting only an already-settled result
  would read "unknown" until some image operation has run. Probing is probably right: the
  status request is rare and admin-only, and "unknown" hides exactly the case this is for.
- **Which process?** On AWS the editor Lambda and the transform Lambda are different
  functions with different packaging. The status response can only speak for the process
  that serves it, which is the editor Lambda: the one running finalize validation, but not
  the one serving `/assets/t/*`.
