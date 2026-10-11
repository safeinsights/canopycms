---
priority: P3
adopters: BOTH
summary: >-
  The header's branch menu says "Discard all changes", but the confirm dialogs it and the per-entry discard open (`editor/hooks/useDraftManager.ts`) are still titled "Discard drafts" / "Discard draft". docs/ux-guidelines.md's vocabulary says "Discard changes". Rename the dialog titles and confirm buttons, and update the e2e page object that finds the dialogs by name.
---

# Discard dialogs still say "drafts"

## What is known

- WS6-lite moved the header menu item to "Discard all changes"; the dialogs it opens kept their
  titles, so the menu and its dialog use two words for one action.
- `apps/test-app/e2e/fixtures/editor-page.ts` locates these dialogs by their accessible names, so
  the rename touches the page object too.

## Done when

The menu items, dialog titles and confirm buttons all say "Discard changes" (or "Discard all
changes" for the branch-wide one), and the page object finds the dialogs by test id.
