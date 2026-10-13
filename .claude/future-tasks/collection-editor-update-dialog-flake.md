---
priority: P3
adopters: NEITHER
summary: >-
  CollectionEditor.test.tsx's "the alert above the list > clears when an update starts" failed in two of three CI runs of a docs-only PR (unit shard 1/3, runs 38333369829 and 38334202071): after "Edit…" was clicked, `findByRole('dialog', { name: /^Edit entry type:/ })` found only an empty Modal root. It passes locally, alone and with its file
---

# Flaky "clears when an update starts" in CollectionEditor.test.tsx

## What failed

`packages/canopycms/src/editor/schema-editor/CollectionEditor.test.tsx`, under "Cancel and Close >
an entry type action the server never answered > the alert above the list", the `'an update'`
case of `clears when %s starts`. `editEntryTypeLabelViaUi` (line 102) clicked the row menu's
"Edit…" item, then `entryTypeDialog` (line 80) timed out. The DOM dump showed a
`mantine-Modal-root` with no content and `data-scroll-locked="1"` on `<body>`.

The PR (#541) changed only docs and `.claude/` files, and other PRs' runs at the same time passed.
Locally the test passes alone and in the full file (96 of 96).

## Suspects

- `findByRole`'s default 1s timeout on a slow runner while the entry-type Modal transitions in.
- The test first runs `removeEntryTypeViaUi(user, 'featured')` (line 116). That helper clicks the
  confirm and returns without waiting for `confirm-delete-modal` to leave, so its exit transition
  may still be running when the update's dialog opens. `closeRowMenu`'s comment describes the
  same race for menus.

## Done when

The cause is found and fixed, so it is not just covered by a longer timeout, and the case
passes in a loop under CPU throttling, for example with `--repeat`.
