---
'canopycms': minor
---

### Rename and delete from the entry menu; Save says "Saved" itself — **behaviour change**

<!-- migration
area: Editing
action: Editor UI tests
row: Entry menu renames and deletes; Save shows Saved, no toast
-->

**What changed.** The open entry's menu, on its name in the top bar, offers "Rename…" and
"Delete entry", through the same dialogs as the content panel's. On a locked branch both stay in
the menu, blocked, with the reason; for an entry a path rule refuses they are hidden, as in the
content panel. A Save reads "Saving…" on the button, then "Saved" for two seconds, announced to
screen readers, instead of a green "Saved" toast; on a phone the button shows a spinner, then a
check. Failures still show their toast or alert, and Save all its result. Save is the top bar's
one filled button; "Submit for review" and "Withdraw from review" are tinted. From either menu,
deleting the open entry leaves no entry open instead of opening the first, and renaming it keeps
it open under its new name. The delete dialog names the entry.

**To adopt.** Nothing, unless your browser tests wait for a "Saved" toast after Save: wait for the
save request's response, or for the Save button to read "Saved".
