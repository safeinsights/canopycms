# Preview page: server-rendered views, a prefix/route mismatch check, and non-client views

## Priority: P3 [BOTH]

Filed 2026-10-05, out of scope for the `createPreviewPage` PR (`feat/preview-page`).

## The gaps

1. **Server-component views get no preview route.** `createPreviewPage({ views })` renders each
   entry through a `'use client'` view, because live drafts arrive in the browser. A site whose
   page components are server components (server-rendered MDX, say) cannot use it as-is.
2. **Nothing checks that `editor.previewPrefix` names the route's folder.** A mismatch previews
   every entry as a 404, with no hint why.
3. **A view that is not a client component type-checks, then fails every request.** The type is
   a call signature, and with the canary React types Next loads (`@types/react` 18.3, `canary.d.ts`)
   `ReactNode` includes a `Promise`. So an `async` view, or one
   from a file without `'use client'`, is accepted, then fails at render with Next's "Functions
   cannot be passed directly to Client Components", a 500 for every entry of that type.
4. **A `load` can reach `canopy.services`, which skips ACLs.** `PreviewLoadContext.canopy` is the
   request-scoped context, whose read helpers are ACL-checked, but its `services` field is the raw
   escape hatch. A loader is a new, inviting place to reach for it.

## Proposed solution

1. Accept a per-type server `render(entry)` fallback, wrapped in a small client scope that only
   posts `preview:ready`, so the editor's sync indicator clears. Such a view shows the branch's
   saved content on each load, without keystroke drafts. Build it only once an adopter needs it.
2. Have `withCanopy` (or a dev-mode warning in `createPreviewPage`) compare the request path with
   the configured prefix and name the mismatch.
3. Name the offending `views` key before rendering. A client reference reaches the server as a
   proxy carrying `$$typeof === Symbol.for('react.client.reference')`. Measure how that proxy
   answers `in` and `typeof` under webpack and Turbopack before relying on it.
4. Hand `load` a `CanopyContext` without `services` (an `Omit`), unless a real loader needs it.

## Related

- [mdx-preview-executes-editor-code.md](mdx-preview-executes-editor-code.md): rendering a draft MDX
  body in a preview view runs the editor's code.
- [preview-src-trailing-slash.md](resolved/preview-src-trailing-slash.md): the preview prefix itself.
