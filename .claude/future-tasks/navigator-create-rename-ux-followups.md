---
priority: P3
adopters: BOTH
summary: >-
  UX follow-ups the navigator search PR left open: "Add entry…" is offered to users who cannot
  write to the collection (the create would only be refused), focus does not return to the row
  after a navigator dialog closes, and a set of copy and accessibility polish items in the
  filter, row menus, create and rename modals
---
# Navigator, create and rename: UX follow-ups

Found by the `ux-review` round on the navigator search, quick open and title-first create
work. The HIGH and MEDIUM findings that PR could fix are fixed; these are what is left.

## Offered but refused

- **"Add entry…" for users who can't write.** As a reviewer, every entry in a collection shows
  the lock and no menu, yet the collection's menu still offers "Add entry…". The navigator
  gates it on entry types only (`Editor.tsx`'s `navCollections`, `canAddEntry`). The client
  has `canEdit` per entry but no create permission per collection. Expose that from the API
  (it is the path ACL for the collection's path), then hide the item, or disable it with a
  reason and the way forward.

## Focus

- After Cancel or Escape in the create, rename or delete dialogs, focus falls to `body`.
  Return it to the row whose menu opened the dialog (the guideline: closing an overlay returns
  focus to the control that opened it). The dialogs are rendered by `Editor.tsx`, not the
  navigator, so the row's menu target needs a ref to hand back.
- Each row menu is named "Collection actions" or "Entry actions", so a screen reader can't tell
  them apart. Name the row in the label. Update the tests that find them by that name.

## Copy and polish

- A filter match inside the truncated part of a title is invisible, so the row looks like a
  false match. Show the slug or the match in the tooltip, or scroll the match into view.
- Slug messages read as two voices: "Enter a slug" / "Use lowercase letters" (`editor/slug.ts`)
  beside `parseSlug`'s "Slug must start with a letter or number and contain only lowercase
  letters, numbers, and hyphens" and "Slug too long (max 64 characters)". Rewrite the
  user-facing ones in one voice in `validateEntrySlug` instead of passing `parseSlug`'s through.
  "An entry with this slug already exists" could offer the next free slug.
- The slug placeholder `my-entry-slug` and the URL path's `your-slug` placeholder differ.
- Switching to an entry type without a title field drops the typed title, and the layout jumps.
- With several entry types, autofocus lands on Title, not the Entry type select above it.
- "Entry type: post" falls back to the internal name when a type has no label.
- Rename's button is disabled without a reason when the slug is unchanged. Rename changes the
  URL only, so renaming an `index` entry moves a landing page with no warning.
- The lock tooltip "You can't edit this entry" gives no way forward.
- The no-entry-types alert in the create modal offers no next action.
- The palette gives screen readers no result count and doesn't mark the open entry.
- The QuickOpenPalette story's button hard-codes "Ctrl+P".
- Mod+P does nothing for the ~200ms another modal plays its close transition (its dialog is
  still mounted, so the palette's overlay guard counts it). The shortcut is still kept from the
  browser, so nothing prints; it just needs pressing again.
- Every navigator row mounts a Mantine `Tooltip` (a floating-ui instance) for the truncated
  title, even when the title fits. Measure on a large tree; if it matters, mount the Tooltip
  only once the row is found truncated.
- The filter box carries `data-autofocus`, so opening the navigator focuses a text input. On a
  touch device that may raise the on-screen keyboard over half of the drawer each time it opens.
  Check on a device with the small-screen work; skip the autofocus on a coarse pointer if so.

Dimmed `xs`/`sm` text (Mantine's `dimmed`, about 3.3:1) is theme-wide and belongs to WS8's
contrast sweep in [ui-epic-202610.md](ui-epic-202610.md).
