# Editor UX guidelines

The standard for every change to the CanopyCMS editor (`packages/canopycms/src/editor/`).
[Enforcement](#enforcement) lists what checks it.

## Vocabulary

One word per idea, everywhere. New UI takes the verbs from `EDITOR_ACTIONS` in
`packages/canopycms/src/editor/copy.ts`.

| Say                       | For                                                            | Not                                         |
| ------------------------- | -------------------------------------------------------------- | ------------------------------------------- |
| **Save**                  | Writing the open entry to the branch                           | Save file, Commit                           |
| **Save all**              | Saving every unsaved entry on the branch                       | Save branch                                 |
| **Refresh from server**   | Replacing the open entry with its saved copy                   | Reload entry                                |
| **Submit for review**     | Committing the branch and opening its pull request             | Submit branch, Publish                      |
| **Withdraw from review**  | Taking a submitted branch back for editing                     | Withdraw branch                             |
| **Approve**               | A reviewer signing off a submitted branch                      | Accept, LGTM                                |
| **Review**                | Opening a submitted branch to review it                        | Inspect                                     |
| **Request changes**       | A reviewer sending a branch back to its editor                 | Reject                                      |
| **Switch branch**         | Opening another branch                                         | Change branch, Change / Manage              |
| **New branch**            | Creating a branch                                              | Create branch, except as its form's confirm |
| **Remove**                | Taking an item out of a list or field; unlisting an entry type | Clear, Delete                               |
| **Clear**                 | Resetting an optional object field to unset                    | Remove                                      |
| **Delete**                | Destroying a stored entry, collection, branch or group         | Remove                                      |
| **Discard changes**       | Throwing away unsaved edits                                    | Discard drafts, Revert                      |
| **entry**, **collection** | A content item, and the folder that holds entries              | file, page, item; folder                    |
| **file**                  | An item in the media library                                   | asset, media item                           |
| **Content**               | The panel of collections and entries                           | All entries                                 |
| **Change URL**            | Changing an entry's slug; "Change slug" without a page         | Rename                                      |

Status labels and colours come from `packages/canopycms/src/editor/branch-status.ts`, lock labels
from `packages/canopycms/src/editor/branch-lock.ts`.

## Copy

- **Sentence case** for every label, title, menu item, tab, badge, toast and placeholder:
  "Delete branch", "Open in GitHub".
- **Buttons start with a verb** and name the result. A confirm repeats the action's verb
  ("Delete entry"), never "OK" or "Yes"; a form's confirm may add its noun ("Create branch").
- **`…`, the single character,** marks an in-progress state ("Saving…") or a command that
  asks for more input ("Change URL…"). None on a command that acts at once or only opens a
  confirm or a menu ("Delete branch", "Add section"); never three ASCII dots.
- **One primary action per card, by role**: on the open branch's card, a reviewer of someone
  else's submission sees "Approve" and "Request changes" (the latter alone once approved), and
  anyone else its workflow action; another branch in review shows them "Review"; others
  show "Open".
- **Dismissing a dialog** that mixes staged and immediate changes: "Discard changes" while edits
  are staged, "Close" after an immediate save, otherwise "Cancel".
- **Quote a named control**: the "Tasks" tab.
- **No "successfully"**: "Branch created".
- **Human labels, never internal names**: "Page sections › Hero › Heading", never
  `blocks[0].title`. An unlabelled schema name is humanised, as `entryTypeLabel`
  (`packages/canopycms/src/editor/editor-utils.ts`) does.
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
| A branch's lasting state: read-only, protected                         | Branch bar status     |
| One entry's lasting state, such as a read-only draft                   | Notice above its form |

Never open a modal from a modal. A popover anchored to a field never covers its input; a short field's opens below it
(`packages/canopycms/src/editor/comments/popover-placement.ts`). Don't toast what is already visible: a saved entry shows "Saved" inline, a new comment appears in its thread. Toasts go in the corner opposite the rail (`Notifications` in
`packages/canopycms/src/editor/theme.tsx`); one with an action pauses while hovered or focused
(`UndoToastMessage`). An error that needs action stays until dismissed.

## Destructive actions

- **Confirm** in a modal when the action destroys or publishes stored state: deleting an
  entry, collection, branch or group; submitting, withdrawing, requesting changes. The modal
  names the thing, states the consequences (`ReferencedByList` lists entries that reference
  it), and its red confirm button repeats the verb.
- **Undo instead of confirm** for removals inside a form: a list item, block or image goes at
  once, and a toast offers Undo; an optional object's Clear leaves "Undo clear" behind. Undo
  updates the current draft, not a snapshot, and focuses the restored row or object. Inside a modal, the Undo is the dialog's own status line: a toast would sit outside
  its focus trap.
- A removed item's comment threads move to the entry's thread, labelled "On a removed item"; the
  Remove toast says so.
- Never both. A removal most users can't restore, such as "Remove from library", confirms.

## Disabled controls

- **Disabled says why.** A control that can't act stays visible, disabled, with a Tooltip
  giving a full-sentence reason with the way forward ("This branch is in review.
  Withdraw it to make changes."). One reason blocking controls with different verbs names the
  condition, not a verb. The Tooltip opens clear of its control and any control stacked beside it.
  Mantine's `data-disabled` keeps the Tooltip working on focus and touch. A control with text
  needs only the Tooltip; an icon-only one adds an `aria-label` for its name and the reason as
  visually hidden text.
- No reason for a submit disabled only by an empty adjacent input (Reply) or a busy dialog's
  close button.
- An action blocked only by unsaved state shows the reason first, allows drafting, and disables
  only its submit.
- A disabled menu item stays focusable (`aria-disabled`, not `disabled`) and shows the reason
  inline (`ReasonedMenuItem`). An empty menu shows one such item saying why, so arrow keys reach
  it; an empty section of a non-empty menu is plain text, with no not-allowed cursor.
- **Hide** a control that can never apply for this user, such as admin items for an editor, and
  a read-only form's row actions ([Fields](#fields)). Where a path rule refuses an action, hide
  the per-item "…" actions and show one collection-level line saying why ("You can't add entries
  here").
- A locked branch keeps each row's "…" slot and draws a lock there on the hovered, focused or
  selected row, by opacity; its Tooltip says why.

## Loading, empty and error states

- **Loading** shows a `Skeleton` in the shape of the content; a spinner belongs only on the
  control that is working (`loading` on a Button). Track loading per item, not one flag for a
  list.
- Content arriving in the background never reorders under the pointer: append it, then
  re-sort once loading finishes.
- **Empty** states appear only after loading finishes, say what is missing and offer the next
  action.
- **Errors** say what failed in plain words, keep the user's input and offer Retry. A refusal
  no retry can pass, such as saving an entry deleted since it was opened, offers the deliberate
  alternative instead ("Save as new entry").
- **A write with no answer** (a timeout or a gateway's 5xx page) may have gone through
  (`packages/canopycms/src/editor/unanswered.ts`). Reload what it touched; if that settles the
  outcome, say so. Otherwise warn in yellow, comment posts included, until dismissed or acted on:
  "… may have gone through even though the server didn't answer", naming the entry and where
  to check, quoted. Keep the input, unless a retry could duplicate the write (a create): then
  close, saying where to check, and prefill that dialog's next open with what was typed.
- An inline alert about a list sits above the list, under its heading.
- A placeholder takes the height of what replaces it, and a wrapping bar reserves its controls'
  widest label width, so nothing shifts.

## Fields

Every field's label row has the same anatomy, rendered by
`packages/canopycms/src/editor/fields/FieldLabel.tsx`: label, required marker and comment
control on the left, field actions on the right, and the description beneath. No hand-rolled label styles. A read-only
form's inputs are read-only, not disabled; one notice explains once; no lock icon per field, row
drag handle or item menu. List and block rows collapse, take their title from the content, and
carry a drag handle and a "…" menu (Move up, Move down, Duplicate, Remove). Validation shows
inline and in a summary of labelled breadcrumbs that focus the field. A date-time input takes
12- or 24-hour time from the locale and shows the time zone; a date-only value is read as local
midnight.

An image field is a bordered card; its label row carries Replace, Crop and Remove. A Crop that can't
apply stays, disabled with its reason.

The comment control hides until its field is hovered or focused, unless the field has open
threads: then it shows their count, never a zero badge. Idle, it is not a Tab stop
(`tabIndex={-1}`): Mod+Alt+M on the focused field, or the "Field comments" menu listing every
field (`comments/form-comments.tsx`), reaches comments instead.

## Keyboard

- Bind shortcuts with Mantine's `useHotkeys` as `mod+…`, which is ⌘ on macOS and Ctrl
  elsewhere, scoped to the editor root. A shortcut that must work while typing passes `[]` as
  `tagsToIgnore` and `true` as `triggerOnContentEditable`.
- Taken: Mod+P finds entries, opening a closed content panel until Enter, Esc or focus leaves;
  Mod+Alt+M comments; Esc closes the topmost overlay (not a docked panel it didn't open), else
  restores a maximized preview. Planned: Mod+S save, Mod+Shift+L layout. Never bind Mod+K (MDXEditor's link), formatting keys, or the
  browser's own (Mod+W, T, R, L, F).
- An overlay panel makes what it covers `inert` (`formInert` in
  `packages/canopycms/src/editor/shell/PaneLayout.tsx`), and anything that targets the covered
  part closes it first (`revealForm` in `packages/canopycms/src/editor/Editor.tsx`).
- Tooltips and hints show the platform's modifier.
- Every action is reachable by keyboard, focus follows visual order, and closing an overlay
  returns focus to its opener. A menu item is gone once it acts, so its menu's
  trigger stands in (`packages/canopycms/src/editor/utils/focus-return.ts`). Any other opener that
  is gone hands focus to the menu trigger offering the same action (`returnTarget`), else the
  nearest heading.
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

Colour carries meaning: green success, blue info, yellow warning, red error. A 409 conflict is
yellow: nothing is lost yet. State is never shown by colour alone. Text, including on controls
and status badges, is at least 4.5:1, or 3:1 for large text; icons and control borders at least
3:1. Text and backgrounds use scheme-aware tokens (`--mantine-color-text`, `light-dark(…)`),
never a fixed shade outside the theme (`gray.0`, `dark.7`, `bg="white"`). The theme
(`packages/canopycms/src/editor/theme.tsx`) sets these, measured on every surface, menu hover
included:

- `--mantine-color-dimmed`, the only dimmed colour. Dark dimmed text also differs in size or
  style (italic, `--canopy-dimmed-font-style`).
- `--mantine-color-placeholder`, at least 4.5:1, and at least 1.7:1 from the text colour.
- `--canopy-danger-text`, for all destructive and error text, menu items included: `red.9` in
  light mode and `red.3` in dark.
- `--canopy-input-border` (3:1), for inputs and the borders and tracks of Checkbox, Radio and
  Switch; `--canopy-surface-subtle` and `--canopy-surface-muted`.
- `--canopy-focus-ring` (3:1 on its surface for any brand) for focus rings, focused borders and
  checked controls; white on the primary colour sits on `--canopy-primary-fill`.

Pass a plain colour; the theme brings its text and light variant to 4.5:1, at which dark mode's
light status badges look alike. Success text is the default colour beside a green icon. Count badges put text colour on a tinted
background.
A light yellow `Alert`'s title, icon and close button take the text colour. Filled
destructive buttons are `red.8`; filled orange buttons are `orange.6` with black text. Nothing else but the
primary is filled: other badges, icons and indicators take their colour's light variant.

## People

- Show a person's name or a fallback ("Name unavailable"), never a raw user id: an id is an
  internal name.
- A branch card's access list shows the names the viewer can resolve, then "and N others". A
  caller without the privileged lookup never receives `access.allowedUsers` ids.
- An avatar beside a name has empty `alt`. One showing only initials is hidden from assistive
  tech, with the person's name as visually hidden text.

## Shell regions

The editor fills the window as one grid: **top bar** (branch pill and status, unsaved count, Save
all or the way forward, Submit or Withdraw, split below `md`), **rail** (Content, Comments while a
branch is open, Media, a divider, the layout toggle; Settings and Account below), **panel**
(content tree: docked, in the stacked form row, or over the form), **main** (entry header, keeping
Save above a maximized preview; preview and form) and **overlays** (drawers, modals, toasts).
Regions are layout only. New UI joins an existing region; adding one is a design decision.
Switch branch… and New branch… open the Branches drawer. Unsaved is one dot (`UnsavedMark`), also
on Content while its panel is closed.

## Enforcement

- `pnpm lint:ux-copy` ([scripts/check-ux-copy.mjs](../scripts/check-ux-copy.mjs)) flags Title
  Case labels and placeholders, ASCII `...` and "successfully" against a per-file baseline across
  editor code and imports. After a fix, record it with `node scripts/check-ux-copy.mjs --write-baseline`.
- `pnpm lint:a11y` runs `eslint-plugin-jsx-a11y` on the editor as errors against ESLint's
  suppressions in `scripts/a11y-suppressions.json`; `pnpm lint` shows the same rules as
  warnings. After a fix, run `pnpm lint:a11y --prune-suppressions`.
- The `ux-review` agent ([.claude/agents/ux-review.md](../.claude/agents/ux-review.md)) checks
  a diff against this page, renders its Storybook stories and walks the flow in
  `apps/example1`.
