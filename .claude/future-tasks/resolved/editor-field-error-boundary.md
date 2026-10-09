# Should a crashing field take the whole editor down?

**RESOLVED 2026-10-08, branch `fix/editor-field-crash-containment`, base `int-202610-b` (adopter request 87a).** See the resolution at the end.

## Priority: P3 [BOTH]

## The question

The editor has no error boundary below Next's root. One field that throws while rendering
replaces the whole editor with "Application error: a client-side exception has occurred".
The MDX JSX crash in [turbopack-import-cycle-double-evaluation.md](../turbopack-import-cycle-double-evaluation.md)
did exactly that. The whole form went with it; unsaved drafts survive only in localStorage.

## Trade-off

- **For a boundary per field, or around `FormRenderer`:** the editor survives. The user still sees
  the entry, the other fields, the branch and the save state. The broken field shows an error and
  a "view source" fallback.
- **Against:** a boundary also hides crashes. The MDX crash was found because it was loud. A
  quietly broken field can save a value the user never saw rendered, and a boundary that resets
  the field's state can discard what it held. Whatever the boundary shows must stop that field
  from emitting edits and must make the failure reportable.

## Suggested shape

If wanted: one boundary around each field in `FormRenderer`. It renders the field's value
read-only with the error message, blocks that field's `onChange`, and logs through the same path
as other editor errors. Decide first whether a crashed field should also block Save for the entry.

## Resolution

Yes, with the guard the trade-off asked for:

- Every field `FormRenderer` renders, nested ones included, has its own boundary. A field
  that throws shows its label, a plain-language message, its value read-only and "Copy error
  details". Every edit callback it was rendered with before the crash is dead for good, so
  nothing it scheduled can write a value the author no longer sees, even after the boundary
  resets on an entry or branch change (`FieldBoundary` in `editor/FormRenderer.tsx`).
- A crashed field does **not** block Save. Its value is unchanged and on screen, so Save writes
  it back as it is; blocking Save would trap the author's other edits, which is the failure
  the boundary exists to prevent.
- A markdown or mdx field falls back to its raw source, which the author can edit and save.
  MDXEditor rejecting a body and MDXEditor crashing on it are one mechanism, keyed by the text
  and remembered in memory for the session (`editor/fields/rich-text-failures.ts`); text edited
  from the fallback stays in source in that field only.
- Each caught error is logged through `reportEditorError` (`editor/utils/editor-errors.ts`),
  the single choke point an adopter error hook would call. A crash inside the editor's own
  shell shows a crash screen with Reload, Back to entries and Copy error details. Back to
  entries opens `?entry=`, which shows the navigator with no entry open, so an entry that
  crashes the editor is not reopened.

Not covered: errors Lexical throws from a microtask commit are uncaught window errors, which
no React boundary sees.
