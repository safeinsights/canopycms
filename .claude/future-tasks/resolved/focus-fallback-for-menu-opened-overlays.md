---
priority: P3
adopters: NEITHER
summary: >-
  RESOLVED (2026-10-11): ruled yes. docs/ux-guidelines.md Keyboard now says a menu item's trigger stands in as the opener once the item is gone. The navigator drawer already returns focus to the file dropdown, and a field comment popover opened from "Comments in this form" returns it to that menu's button.
---

# Focus fallback for an overlay opened from a menu item

## What is known

- `editor/Editor.tsx` records the navigator drawer's opener when it opens (`openNavigator`). A
  menu item unmounts on click, so for one the header's file dropdown, `data-testid="file-dropdown-button"`,
  stands in (`navigatorReturnTarget`). The drawer's own close and a palette that replaced it
  both return focus there, and only while focus is idle (`focusIfIdle` in
  `editor/components/QuickOpenPalette.tsx`).
- After the drawer closes there is no list heading or search field left in view, so the
  guideline's fallback has no target; the dropdown names the current entry.

## Done when

The Keyboard rule says whether a menu item's trigger counts as the opener, and the code matches.
