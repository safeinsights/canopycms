---
priority: P3
adopters: BOTH
summary: >-
  RESOLVED (2026-10-11) — in WS6-lite's review fixes. The discard dialogs read "Discard all changes" and "Discard changes", count entries, and carry `confirm-discard-all` / `confirm-discard-entry` test ids, which the e2e page object uses.
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
