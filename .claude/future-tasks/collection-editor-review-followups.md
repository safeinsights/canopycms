---
priority: P3
adopters: BOTH
summary: >-
  One follow-up left from reviewing the collection dialog: a VoiceOver check of the entry-type status line
---
# Collection dialog: review follow-ups

## Code follow-ups

- **Screen-reader check.** After an entry-type add or update, the status line updates while the
  closing sub-dialog is still in the DOM with `aria-modal`. Some screen readers suppress live-region
  updates outside the active modal. Check with VoiceOver; if it is swallowed, announce after the
  sub-dialog's exit transition. Not run yet: it needs a real screen reader, which an agent
  session can't drive.
