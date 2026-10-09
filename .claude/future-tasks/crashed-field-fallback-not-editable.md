---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-08, from #434's review. A crashed non-markdown field shows read-only and doesn't block Save, so a value that fails validation leaves the author unable to save. Consider an editable raw-value fallback
---
# A crashed non-markdown field can leave Save stuck

## Priority: P3 [BOTH]

## The gap

When a non-markdown field throws while rendering, `FieldBoundary` (`editor/FormRenderer.tsx`) shows
its value read-only and blocks its edits. Save is not blocked, because that value is unchanged and
on screen. But if the existing value fails schema validation, the server rejects the save, and the
author has no way to fix the field from a read-only fallback. Markdown and MDX fields don't have
this problem: their fallback is the editable source editor.

## Suggested shape

An editable raw-value fallback for crashed non-markdown fields: a JSON or plain-text input, used
only when the field's own renderer has crashed. It goes through the normal onChange and validation
path, and shows the validation error inline. Decide whether it's offered to every crashed field or
only after a save has been rejected for that field.
