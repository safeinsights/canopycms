---
priority: P3
adopters: BOTH
summary: >-
  A thread on a removed list item or block names the item ("Features › Typed › Title") only while the removal is still in the draft; once it is saved, the breadcrumb drops the item, unless the thread stores the item's title when it is made
---

# Removed-item comment threads: name the item after a save

A field thread whose list item or block is gone shows in "Comment on this entry", with an "On a
removed item" badge and the field's breadcrumb. While the item's key is still in the saved value,
`commentFieldLabel` in `editor/Editor.tsx` names the item from there. After the removal is saved
the breadcrumb comes from the schema alone ("Features › Title"). Storing the item's title on the
thread when it is made would keep the name; it is a change to the stored comment format
(`comment-store.ts`).
