---
priority: P3
adopters: BOTH
summary: >-
  Two follow-ups left from reviewing the collection dialog: Title Case placeholders and a lint:ux-copy check for them, and a VoiceOver check of the entry-type status line
---
# Collection dialog: review follow-ups

## Code follow-ups

- **Placeholders in sentence case.** docs/ux-guidelines.md's sentence-case rule covers
  placeholders, but "Blog Posts" (`schema-editor/CollectionEditor.tsx`) and "Blog Post"
  (`schema-editor/EntryTypeEditor.tsx`) are Title Case. Fix them and extend `lint:ux-copy`
  (`scripts/check-ux-copy.mjs`) to check `placeholder` props.
- **Screen-reader check.** After an entry-type add or update, the status line updates while the
  closing sub-dialog is still in the DOM with `aria-modal`. Some screen readers suppress live-region
  updates outside the active modal. Check with VoiceOver; if it is swallowed, announce after the
  sub-dialog's exit transition. Not run yet: it needs a real screen reader, which an agent
  session can't drive.
