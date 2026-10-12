---
priority: P3
adopters: NEITHER
summary: >-
  docs/ux-guidelines.md Keyboard sends focus to the nearest list heading or search field when an overlay's opener is gone. The navigator drawer opened from the file dropdown's "All Files" menu item (which unmounts on click) instead returns focus to that dropdown, the menu's own trigger, as does a quick-open palette that replaced the drawer. Rule on whether a menu item's trigger is the opener for this purpose.
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
