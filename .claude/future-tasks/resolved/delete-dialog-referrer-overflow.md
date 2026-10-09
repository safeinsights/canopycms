---
adopters: BOTH
summary: >-
  RESOLVED 2026-10-09, branch `fix/delete-dialog-referrer-overflow`, base `int-202610-b`; adopter request 98. The referenced-delete dialog's list of referencing entries no longer uses Mantine's `List`, whose items are `white-space: nowrap` around a column `inline-flex`: that stopped a long title wrapping, grew a horizontal scrollbar, and split the field label onto its own row. Each row is now a `Box` `li` holding the title link and, under it, the label as a dimmed line, both `overflow-wrap: anywhere`, so a 200-character unbroken title or a long slug wraps within the dialog. The test loads Mantine's own CSS into jsdom, so the `nowrap` it rules out is the real one.
---
# Long titles overflow the referenced-delete dialog

**Status: RESOLVED 2026-10-09**, branch `fix/delete-dialog-referrer-overflow`.

Adopter request 98. In the "This entry is referenced by N other entries" delete dialog
(`ConfirmDeleteModal` with `ReferencedByList` from
[delete-referenced-entry-unguarded.md](delete-referenced-entry-unguarded.md)), a long article
title wrapped badly. The link was indented, the field label ("(reviewer)") landed on its own
line, and the dialog grew a horizontal scrollbar.

## Cause

Mantine's `List.Item` sets `white-space: nowrap` on the `li` and wraps its children in an
`inline-flex` column. The column puts the title and its label on separate flex rows, and the
`nowrap` `inline-flex` box cannot narrow below its content's width.

## What shipped

`ReferencedByList` renders a `Stack` `ul` of `Box` `li` rows. In each row the title link sits
over its label, which is a dimmed line. Both use `overflow-wrap: anywhere`, which, unlike
`break-word`, also lowers the min-content width. The link also uses `ta="start"`, because a
`<button>` centres its text by default and a wrapped title shows it. The `ul` has
`role="list"`, since WebKit drops the list role from a `ul` styled `list-style: none`. In a
one-off Chromium check (not in the suite), a 440 px container holding a 200-character title
went from `scrollWidth` 1893 to 438.

No e2e covers this dialog. The component test injects Mantine's `List`, `Anchor`, `Text` and
`Stack` CSS into jsdom and checks that no element in the list is `nowrap`,
`inline-flex` or fixed-width.
