---
priority: P2
adopters: BOTH
summary: >-
  New 2026-10-11. The UX review saw Shift+Tab inside a markdown body field never leave the editor in apps/example1. Reproduced in a jsdom probe: Tab and Shift+Tab are both default-prevented at a collapsed caret in a plain paragraph, by MDXEditor's lists plugin (Lexical's tab-indentation). A keyboard trap (WCAG 2.1.2) unless an escape route exists. Not fixed
---
# Tab and Shift+Tab never leave a markdown body field

**What was found.** The `ux-review` of PR 532 walked `apps/example1` and could not Shift+Tab out of
a markdown body field. A throwaway vitest rendered `MDXEditorLazy` (as `rich-text-edits.test.tsx`
does), put a collapsed caret at the end of a plain paragraph, and dispatched `keydown` for Tab and
Shift+Tab on `.canopy-mdx-content`. Both came back `defaultPrevented`.

**Why.** `listsPlugin()` in `packages/canopycms/src/editor/fields/MarkdownField.tsx` mounts
`@lexical/react`'s `TabIndentationPlugin` (`@mdxeditor/editor` 4.3.2, `plugins/lists/index.js`).
Its `registerTabIndentation` handles `KEY_TAB_COMMAND` for any range selection: it calls
`event.preventDefault()`, then indents, outdents or inserts a tab character (Lexical 0.48.0,
`@lexical/extension` `TabIndentationExtension.ts`). Nothing returns focus to the page, so a
keyboard user who tabs into the body cannot tab out. jsdom proves only the `preventDefault`;
confirm the trap in a real browser (Storybook or `apps/example1`) before fixing.

**Options, not decided.**

- Only indent when the caret is in a list item, and let Tab through elsewhere (a custom
  `KEY_TAB_COMMAND` handler at higher priority that returns `false` without `preventDefault`).
- Keep Tab for indentation but add the usual escape: Esc, then Tab, moves on. Document it near
  the field and in the shortcut sheet.

Whichever is chosen, add a test that Tab leaves a plain paragraph and Shift+Tab leaves the first
block, and check `docs/ux-guidelines.md` Keyboard for a line on it.
