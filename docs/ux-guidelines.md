# Editor UX guidelines

The standard for every change to the CanopyCMS editor (`packages/canopycms/src/editor/`).
[Enforcement](#enforcement) lists what checks it.

## Vocabulary

One word per idea, everywhere. New UI takes the verbs from `EDITOR_ACTIONS` in
`packages/canopycms/src/editor/copy.ts`.

| Say                       | For                                                            | Not                                         |
| ------------------------- | -------------------------------------------------------------- | ------------------------------------------- |
| **Save**                  | Writing the open entry to the branch                           | Save file, Commit                           |
| **Submit for review**     | Committing the branch and opening its pull request             | Submit branch, Publish                      |
| **Withdraw from review**  | Taking a submitted branch back for editing                     | Withdraw branch                             |
| **Request changes**       | A reviewer sending a branch back to its editor                 | Reject                                      |
| **Switch branch**         | Opening another branch                                         | Change branch, Change / Manage              |
| **New branch**            | Creating a branch                                              | Create branch, except as its form's confirm |
| **Remove**                | Taking an item out of a list or field; unlisting an entry type | Clear, Delete                               |
| **Clear**                 | Resetting an optional object field to unset                    | Remove                                      |
| **Delete**                | Destroying a stored entry, collection, branch or group         | Remove                                      |
| **Discard changes**       | Throwing away unsaved edits                                    | Discard drafts, Revert                      |
| **entry**, **collection** | A content item, and the folder that holds entries              | file, page, item; folder                    |
| **file**                  | An item in the media library                                   | asset, media item                           |

Branch status labels and colours come from `packages/canopycms/src/editor/branch-status.ts`.

## Copy

- **Sentence case** for every label, title, menu item, tab, toast and placeholder: "Delete
  branch", "Open in GitHub".
- **Buttons start with a verb** and name the result. A confirm repeats the action's verb
  ("Delete entry"), never "OK" or "Yes"; a form's confirm may add its noun ("Create branch").
- **`…`, the single character,** marks an in-progress state ("Saving…") or a command that
  asks for more input ("Rename…"). None on a command that acts at once or only opens a
  confirm or a menu ("Delete branch", "Add section"); never three ASCII dots.
- **One primary action per card, by role**: on the open branch's card, a reviewer of someone
  else's submission sees "Request changes" and anyone else its workflow action; other cards
  show "Open".
- **Dismissing a dialog** that mixes staged and immediate changes: "Discard changes" while edits
  are staged, "Close" after an immediate save, otherwise "Cancel".
- **Quote a named control**: the "Tasks" tab.
- **No "successfully"**: "Branch created".
- **Human labels, never internal names**: "Page sections › Hero › Heading", never
  `blocks[0].title`. An unlabelled schema name is humanised, as `entryTypeLabel` does.
- **Developer diagnostics** go behind a "Details" disclosure or are shown to admins only.
- **Dates** are relative, with the absolute date in a tooltip
  (`packages/canopycms/src/editor/relative-time.ts`).
- **Plurals agree**: "1 member", "2 members".

## Choosing a surface

| Need                                                                   | Use                   |
| ---------------------------------------------------------------------- | --------------------- |
| A decision that cannot be undone, or a short form of at most 3 fields  | Modal                 |
| A list or task worked alongside the content: branches, comments, media | Drawer or panel       |
| Context for one control: a field's comments, a picker, a short note    | Popover               |
| The result of an action that is not otherwise visible                  | Toast                 |
| A branch's lasting state: read-only, protected, conflict               | Banner                |
| One entry's lasting state, such as a read-only draft                   | Notice above its form |

Never open a modal from a modal. A popover anchored to a field never covers its input; a short field's opens below it
(`packages/canopycms/src/editor/comments/popover-placement.ts`). Don't toast what is already visible: a saved entry shows "Saved" inline, a new comment
appears in its thread. Toasts go in the corner opposite the rail (`Notifications` in
`packages/canopycms/src/editor/theme.tsx`); one with an action pauses while hovered or focused
(`UndoToastMessage`). An error that needs action stays until dismissed.

## Destructive actions

- **Confirm** in a modal when the action destroys or publishes stored state: deleting an
  entry, collection, branch or group; submitting, withdrawing, requesting changes. The modal
  names the thing, states the consequences (`ReferencedByList` lists entries that reference
  it), and its red confirm button repeats the verb.
- **Undo instead of confirm** for removals inside a form: a list item, block or image goes at
  once, and a toast offers Undo. Undo updates the current draft rather than restoring a
  snapshot, and moves focus to the restored row.
- Never both. A removal with no restore UI, such as "Remove from library", confirms: an Undo
  would be false.

## Disabled controls

- **Disabled says why.** A control that can't act now stays visible, disabled, with a Tooltip
  giving the reason as a full sentence with the way forward ("This branch is in review.
  Withdraw it to make changes."). One reason blocking controls with different verbs names the
  blocking condition, not a verb. Mantine's `data-disabled` keeps the Tooltip working; it also
  opens on focus and touch.
- A submit button disabled only because its adjacent input is empty, such as Reply, needs no
  reason.
- A disabled menu item stays focusable (`aria-disabled`, not `disabled`) and shows the reason
  inline (`ReasonedMenuItem`). An empty menu shows one such item saying why, so arrow keys reach
  it.
- **Hide** a control that can never apply for this user, such as admin items for an editor.

## Loading, empty and error states

- **Loading** shows a `Skeleton` in the shape of the content; a spinner belongs only on the
  control that is working (`loading` on a Button). Track loading per item, not one flag for a
  list.
- Content arriving in the background never reorders under the pointer: append it, then
  re-sort once loading finishes.
- **Empty** states appear only after loading finishes, say what is missing and offer the next
  action.
- **Errors** say what failed in plain words, keep the user's input and offer Retry.
- **A write with no answer** (a timeout or a gateway's 5xx page) may have gone through
  (`packages/canopycms/src/editor/unanswered.ts`). Reload what it touched; if that settles the
  outcome, say so. Otherwise warn in yellow, comment posts included, until dismissed or acted on:
  "… may have gone through even though the server didn't answer", naming the entry and where
  to check, quoted. Keep the input, unless a retry could duplicate the write (a create): then
  close, saying where to check, and prefill that dialog's next open with what was typed.
- An inline alert about a list sits above the list, under its heading.
- A placeholder takes the height of what replaces it, so nothing shifts.

## Fields

Every field's label row has the same anatomy, rendered by
`packages/canopycms/src/editor/fields/FieldLabel.tsx`: label, required marker and comment
control on the left, field actions on the right, and the description beneath. No hand-rolled
label styles. A read-only form's inputs are read-only, not disabled; one notice explains once;
no lock icon per field, row drag handle or item menu. List and block rows collapse, take their title from the content, and
carry a drag handle and a "…" menu (Move up, Move down, Duplicate, Remove). Validation shows
inline and in a summary of labelled breadcrumbs that focus the field. A date-time input takes
12- or 24-hour time from the locale and shows the time zone; a date-only value is read as local
midnight.

The comment control hides until its field is hovered or focused, unless the field has open
threads: then it shows their count, never a zero badge. Idle, it is not a Tab stop
(`tabIndex={-1}`): Mod+Alt+M on the focused field, or the "Field comments" menu listing every
field (`comments/form-comments.tsx`), reaches comments instead.

## Keyboard

- Bind shortcuts with Mantine's `useHotkeys` as `mod+…`, which is ⌘ on macOS and Ctrl
  elsewhere, scoped to the editor root. A shortcut that must work while typing, such as Save,
  passes `[]` as `tagsToIgnore` and `true` as `triggerOnContentEditable`.
- Taken: Mod+P quick open, Mod+Alt+M comments, Esc closes the topmost panel. Planned for WS8:
  Mod+S save, Mod+. content panel, Mod+Shift+L layout. Never bind Mod+K (MDXEditor's link), the formatting keys, or the browser's own
  (Mod+W, T, R, L, F).
- Tooltips and the shortcut sheet show the platform's modifier.
- Every action is reachable by keyboard, focus follows visual order, and closing an overlay
  returns focus to the control that opened it. A menu item is gone once it acts, so its menu's
  trigger stands in (`packages/canopycms/src/editor/utils/focus-return.ts`). Any other opener that
  is gone or hidden hands focus to the menu trigger offering the same action (`returnTarget`).
- Sticky regions reserve scroll padding so focus is never hidden behind them (WCAG 2.4.11), as
  `FormHeader` does.

## Accessibility

- An icon-only control has an `aria-label` and a same-text Tooltip that also opens on focus.
- Anything clickable is a button or link (`UnstyledButton` when it must look bare), never a
  `div` with `onClick`.
- An `iframe` has a `title`; an input has a label or `aria-label`.
- Focus rings stay visible; never set `outline: none`.
- `autoFocus` only on the first field of a dialog the user just opened.
- A detail shown only in a tooltip, such as an email or an absolute date, also needs a
  focusable route: a focusable trigger, or visually hidden text in it or via `aria-describedby`.
- A live region announces background progress when its phase changes (started, finished,
  result count), never page by page.

## Colour and contrast

Colour carries meaning: green success, blue info, yellow warning, red error. State is never
shown by colour alone. Text, including on controls and status badges, is at least 4.5:1, or 3:1
for large text; icons and control borders at least 3:1. Text and backgrounds use scheme-aware
tokens (`--mantine-color-text`, `light-dark(…)`), never a fixed shade (`gray.0`, `dark.7`,
`bg="white"`). The theme (`packages/canopycms/src/editor/theme.tsx`) sets three of them:

- `--mantine-color-dimmed`, the only dimmed colour: `gray.7` in light mode; in dark mode
  `color-mix(in srgb, var(--mantine-color-dark-1) 70%, var(--mantine-color-dark-2))`, 4.7:1 on
  `dark.5`, since `dark.1` reads as body text.
- `--mantine-color-placeholder`, at least 4.5:1.
- `--canopy-danger-text`, for all destructive and error text, menu items included: `red.9` in
  light mode (`red.8` is 4.3:1 on `gray.0`) and `red.4` in dark mode.

Success text is the default colour beside a green icon; `green.8` and `green.9` miss 4.5:1 on
white. Count badges put text colour on a tinted background. A light yellow `Alert`'s title, icon
and close button take the text colour; yellow on its own tint is under 2:1. Filled destructive
buttons are `red.8`, 4.5:1 under white; no orange shade reaches that, so filled orange buttons
are `orange.6` with black text.

## People

- Show a person's name or a fallback ("Name unavailable"), never a raw user id: an id is an
  internal name.
- A branch card's access list shows the names the viewer can resolve, then "and N others". A
  caller without the privileged lookup never receives `access.allowedUsers` ids.
- An avatar beside a name has empty `alt`.

## Shell regions

The editor fills the window as one grid: **top bar** (breadcrumb, branch pill, unsaved
indicator, Save), **banner** (branch-wide notices), **rail** (activity icons), **panel**
(content tree, branches, comments, media), **main** (preview and form) and **overlays**
(drawers, modals, toasts). The regions are layout only; features plug into them. New UI goes
into an existing region, and adding a region is a design decision. The unsaved indicator is
icon-only below `lg`; its presentation is provisional until the shell redesign settles.

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
