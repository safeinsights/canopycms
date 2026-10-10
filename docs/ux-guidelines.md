# Editor UX guidelines

The standard for every change to the CanopyCMS editor (`packages/canopycms/src/editor/`).
[Enforcement](#enforcement) lists what checks it.

## Vocabulary

One word per idea, everywhere: buttons, menus, titles, toasts and errors.

| Say                       | For                                                    | Not                            |
| ------------------------- | ------------------------------------------------------ | ------------------------------ |
| **Save**                  | Writing the open entry to the branch                   | Save file, Commit              |
| **Submit for review**     | Committing the branch and opening its pull request     | Submit branch, Publish         |
| **Withdraw from review**  | Taking a submitted branch back for editing             | Withdraw branch                |
| **Request changes**       | A reviewer sending a branch back to its editor         | Reject                         |
| **Switch branch**         | Opening another branch                                 | Change branch, Change / Manage |
| **New branch**            | Creating a branch                                      | Create branch                  |
| **Remove**                | Taking an item out of a list, block list or field      | Clear, Delete                  |
| **Delete**                | Destroying a stored entry, collection, branch or group | Remove                         |
| **Discard changes**       | Throwing away unsaved edits                            | Discard drafts, Revert         |
| **entry**, **collection** | A content item, and the folder that holds entries      | file, page, item; folder       |

Branch status labels are **Editing**, **In review** and **Protected**.

## Copy

- **Sentence case** for every label, title, menu item, tab and toast. Only the first word and
  proper nouns take a capital: "Delete branch", "Open in GitHub".
- **Buttons start with a verb** and name the result. A confirm button repeats the action's
  verb ("Delete entry"), never "OK" or "Yes".
- **`…`, the single character,** marks an in-progress state ("Saving…") or a command that
  asks for more before it acts ("Rename…", "Switch branch…"). A command that acts at once
  has none. Never three ASCII dots.
- **No "successfully".** The past tense already says it: "Branch created".
- **Human labels, never internal names.** A message names "Page sections › Hero › Heading",
  never `blocks[0].title`.
- **Developer diagnostics** go behind a "Details" disclosure or are shown to admins only.
- **Dates** are relative, with the absolute date in a tooltip
  (`packages/canopycms/src/editor/relative-time.ts`).
- **Plurals agree**: "1 member", "2 members".

## Choosing a surface

| Need                                                                   | Use             |
| ---------------------------------------------------------------------- | --------------- |
| A decision that cannot be undone, or a short form of at most 3 fields  | Modal           |
| A list or task worked alongside the content: branches, comments, media | Drawer or panel |
| Context for one control: a field's comments, a picker, a short note    | Popover         |
| The result of an action that is not otherwise visible                  | Toast           |
| A state that lasts while it is true: read-only, protected, conflict    | Banner          |

Never open a modal from a modal. Don't toast a result the user can already see: a saved entry
shows "Saved" inline, and a new comment appears in its thread. Toasts belong bottom-right,
away from the rail; `Notifications` in `packages/canopycms/src/editor/theme.tsx` sets it. Colour carries meaning: green success, blue
info, yellow warning, red error. An error that needs action stays until dismissed.

## Destructive actions

- **Confirm** in a modal when the action destroys or publishes stored state: deleting an
  entry, collection, branch or group; submitting, withdrawing, requesting changes. The modal
  names the thing, states the consequences (`ReferencedByList` lists entries that reference
  it), and its red confirm button repeats the verb.
- **Undo instead of confirm** for removals inside a form: a list item, block or image goes at
  once, and a toast offers Undo. Undo updates the current draft rather than restoring a
  snapshot.
- Never both.

## Disabled, loading, empty and error states

- **Disabled says why.** A control that can't act now stays visible, disabled, with a Tooltip
  giving the reason and the way forward ("This branch is in review. Withdraw it to make
  changes."). Mantine's `data-disabled` keeps the Tooltip working. **Hide** a control that can
  never apply for this user, such as admin items for an editor.
- **Loading** shows a `Skeleton` in the shape of the content; a spinner belongs only on the
  control that is working (`loading` on a Button). Track loading per item, not one flag for a
  list.
- **Empty** states appear only after loading finishes, say what is missing and offer the next
  action.
- **Errors** say what failed in plain words, keep the user's input and offer Retry.
- A placeholder takes the height of what replaces it, so nothing shifts.

## Fields

Every field's label row has the same anatomy, rendered by one shared `FieldLabel`: label and
required marker on the left, field actions then the comment control on the right, and the
description beneath. No hand-rolled label styles. A read-only form disables its inputs and
lets the banner explain once; no lock icon per field. List and block rows collapse, take their
title from the content, and carry a drag handle and a "…" menu (Move up, Move down, Duplicate,
Remove). Validation shows inline and in a summary of labelled breadcrumbs that focus the
field.

## Keyboard

- Bind shortcuts with Mantine's `useHotkeys` as `mod+…`, which is ⌘ on macOS and Ctrl
  elsewhere, scoped to the editor root. A shortcut that must work while typing, such as Save,
  passes `[]` as `tagsToIgnore` and `true` as `triggerOnContentEditable`.
- Taken: Mod+S save, Mod+P quick open, Mod+. content panel, Mod+Shift+L layout, Esc closes the
  topmost panel. Never bind Mod+K (MDXEditor's link), the formatting keys, or the browser's own
  (Mod+W, T, R, L, F).
- Tooltips and the shortcut sheet show the platform's modifier.
- Every action is reachable by keyboard, focus follows visual order, and closing an overlay
  returns focus to the control that opened it.

## Accessibility

- An icon-only `ActionIcon` has an `aria-label` and a Tooltip with the same text.
- Anything clickable is a button or link (`UnstyledButton` when it must look bare), never a
  `div` with `onClick`.
- An `iframe` has a `title`; an input has a label or `aria-label`.
- Focus rings stay visible; never set `outline: none`.
- Text contrast is at least 4.5:1, or 3:1 for large text. Check dimmed `xs` text.
- State is never shown by colour alone.
- `autoFocus` only on the first field of a dialog the user just opened.

## Shell regions

The editor fills the window as one grid: **top bar** (breadcrumb, branch pill, Save), **banner**
(read-only and lock notices), **rail** (activity icons), **panel** (content tree, branches,
comments, media), **main** (preview and form) and **overlays** (drawers, modals, toasts). The
regions are layout only; features plug into them. New UI goes into an existing region, and
adding a region is a design decision.

## Enforcement

- `pnpm lint:ux-copy` ([scripts/check-ux-copy.mjs](../scripts/check-ux-copy.mjs)) flags Title
  Case labels, ASCII `...` and "successfully" against a per-file baseline. After a fix, record
  it with `node scripts/check-ux-copy.mjs --write-baseline`.
- `pnpm lint:a11y` runs `eslint-plugin-jsx-a11y` on the editor as errors against ESLint's
  suppressions in `scripts/a11y-suppressions.json`; `pnpm lint` shows the same rules as
  warnings. After a fix, run `pnpm lint:a11y --prune-suppressions`.
- The `ux-review` agent ([.claude/agents/ux-review.md](../.claude/agents/ux-review.md)) checks
  a diff against this page, renders its Storybook stories and walks the flow in
  `apps/example1`.
