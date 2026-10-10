---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-10, parked by the editor UI/UX epic. `fields/CodeField.tsx` is a monospace `Textarea` whose own comment calls it a "Placeholder for Monaco": no syntax highlighting, no indentation handling. Decide whether a code editor (Monaco or CodeMirror) earns its bundle weight
---
# Code field: a real code editor

The editor UI/UX epic ([ui-epic-202610.md](ui-epic-202610.md), C7) left the code field as a
textarea on purpose. Choosing an editor is a separate decision:

- **Monaco** is the full VS Code editor; it is heavy (multiple MB) and needs worker setup in the
  adopter's bundler.
- **CodeMirror 6** is far lighter, modular, and already the usual choice for in-form code fields.

Whichever is chosen must stay out of the public build and load lazily inside the editor only,
and must honour the epic's `readOnly` field contract.
