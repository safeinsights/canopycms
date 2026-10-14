---
priority: P3
adopters: BOTH
summary: >-
  The `stampOnPublish` field states its rule conditionally ("if left empty on a new entry…") because the editor cannot tell whether an entry is new to the base branch, and the "Submit for review" dialog does not say that submitting writes dates. Proposed: have the entry read report whether the entry is new to the base, show the rule only then, and list the stamping in the submit dialog
---
# `stampOnPublish`: say it only where it applies

## Priority: P3 [BOTH]

## Problem

`DateTimeField` puts the `stampOnPublish` rule in the field's description, worded conditionally,
because the editor cannot tell a new entry from one already on the base branch, which is never
stamped (`stamp-on-publish.ts` filters by the base tip and fork-point trees). An editor on a
published entry with an empty date therefore reads a rule that will never apply to it.

The "Submit for review" confirm dialog (`useBranchManager.tsx` `showSubmitConfirmation`) lists
what a submit does, and does not say it writes dates into new entries; the success toast counts
the entries dated afterwards.

## Proposed fix

- The entry read reports whether the entry's ContentId is new to the base (the same tip and
  fork-point check stamping runs, cached per base SHA), and the field shows the rule only then;
  an existing entry gets the plain field.
- When the branch's schema has a stamp field, the submit dialog adds a line such as "Fill empty
  'Published at' dates on new entries", using the field label.

## Trigger

An editor is confused by the rule on a published entry, or the next change to the submit dialog.

## Related

- [stamp-failed-submit-draft-409.md](stamp-failed-submit-draft-409.md)
