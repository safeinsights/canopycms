# Should a crashing field take the whole editor down?

## Priority: P3 [BOTH]

## The question

The editor has no error boundary below Next's root. One field that throws while rendering
replaces the whole editor with "Application error: a client-side exception has occurred".
The MDX JSX crash in [turbopack-import-cycle-double-evaluation.md](turbopack-import-cycle-double-evaluation.md)
did exactly that, and every unsaved draft on screen went with it, though drafts persist to
localStorage.

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
