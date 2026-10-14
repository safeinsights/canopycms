---
priority: P3
adopters: NEITHER
summary: >-
  New 2026-10-14. With an e2e run sharing the machine, two editor tests failed once and passed twice alone: `Editor.admin-and-undo.test.tsx` "keeps a create's draft through another create from a dialog it did not fill" (5000ms timeout) and `CollectionEditor.test.tsx` "moves focus to the Entry types heading when the red "Couldn't remove entry type" alert is dismissed" (focus still on body)
---

# Two editor tests flake under machine load

Seen while gating the UX batch 3 theme PR, which touches neither flow. The editor vitest project
ran beside an eight-spec Playwright run:

- `packages/canopycms/src/editor/Editor.admin-and-undo.test.tsx`, "a collection write with no
  answer" › "keeps a create's draft through another create from a dialog it did not fill": hit
  vitest's 5000ms default timeout. Its sibling "…through a create under another parent that
  succeeds" timed out the same way in an earlier full-suite run.
- `packages/canopycms/src/editor/schema-editor/CollectionEditor.test.tsx`, "Cancel and Close" ›
  "an entry type action the server never answered" › "moves focus to the Entry types heading
  when the red "Couldn't remove entry type" alert is dismissed": focus was still on `body` when
  the assertion ran.

Both files passed 145/145 alone, twice. Like
[editor-preview-references-test-load-sensitive.md](editor-preview-references-test-load-sensitive.md),
make each wait on the condition it asserts rather than on scheduling, or raise the first test's
timeout if its work is genuinely long.
