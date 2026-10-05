# Preview page: server-rendered views, and a prefix/route mismatch check

## Priority: P3 [BOTH]

Filed 2026-10-05, out of scope for the `createPreviewPage` PR (`feat/preview-page`).

## The gaps

1. **Server-component views get no preview route.** `createPreviewPage({ views })` renders each
   entry through a `'use client'` view, because live drafts arrive in the browser. A site whose
   page components are server components (server-rendered MDX, say) cannot use it as-is.
2. **Nothing checks that `editor.previewPrefix` names the route's folder.** A mismatch previews
   every entry as a 404, with no hint why.

## Proposed solution

1. Accept a per-type server `render(entry)` fallback, wrapped in a small client scope that only
   posts `preview:ready`, so the editor's sync indicator clears. Such a view shows the branch's
   saved content on each load, without keystroke drafts. Build it only once an adopter needs it.
2. Have `withCanopy` (or a dev-mode warning in `createPreviewPage`) compare the request path with
   the configured prefix and name the mismatch.

## Related

- [preview-src-trailing-slash.md](resolved/preview-src-trailing-slash.md): the preview prefix itself.
