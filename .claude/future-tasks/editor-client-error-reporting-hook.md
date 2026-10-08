# Editor crashes reach no one but the console

## Priority: P2 [BOTH]

## The gap

When the editor throws in the browser, the only record is the author's console. The MDX JSX crash
in [turbopack-import-cycle-double-evaluation.md](turbopack-import-cycle-double-evaluation.md) was
found only because someone was watching it. A deployment has no way to send editor errors to its
own monitoring.

## Suggested shape

An adopter hook in the editor's client config, for example `onClientError(error, context)`. It is
called for errors the editor's boundaries catch (each passes through `reportEditorError` in
`editor/utils/editor-errors.ts`; see
[editor-field-error-boundary.md](resolved/editor-field-error-boundary.md)), for uncaught window errors and
unhandled rejections while `/edit` is mounted, and for failed API calls the editor already surfaces.
`context` carries the branch, entry path, field path and editor version, never field values.

This adds an adopter touchpoint, so it needs JP's approval before it's built. Decide too whether
the editor should report to the CMS's own API (one log for all adopters) instead of, or as well as,
a callback.
