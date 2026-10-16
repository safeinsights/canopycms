---
adopters: BOTH
summary: >-
  RESOLVED 2026-10-09, branch `fix/guard-referenced-delete`, base `int-202610-b` (stacked on `chore/backlog-frontmatter`); adopter request 92. `DELETE /:branch/entries/...entryPath` now refuses an entry other entries reference with a 409 whose `data.referencedBy` lists the referencing entries the user may read (title, path, reference-field positions, `entry:` links) plus a count of the rest; `?confirmReferenced=true` deletes anyway. The editor's delete dialog shows that list and a "Delete anyway" button. Unreadable referencing entries are counted only, stricter than `RestrictedReference` on purpose: a delete is a different surface from a read. The scan is a raw `listEntries` walk per unconfirmed delete, no cache: about 60 ms at 1,000 entries and 300 ms at 5,000 on local disk. Folded in [deletion-checker-refactor.md](deletion-checker-refactor.md).
---
# Deleting an entry other entries reference is unguarded

**Status: RESOLVED 2026-10-09**, branch `fix/guard-referenced-delete`.

## The request

`validation/deletion-checker.ts` had a `DeletionChecker.canDelete(id)` that nothing called. The
editor's delete endpoint (`api/entries.ts`) went straight to `contentStore.delete(...)`, so an
author could delete an entry other entries reference, with no warning. On an adopter site that
means deleting a person silently removes that person's byline and structured-data author from
every article they wrote or reviewed.

The class could not have been wired in as it stood. It read each entry through `store.read()`,
which resolves references by default, so a stored id had already become an object and never
matched; and it used one field list per collection, so a collection with several entry types was
read against the wrong schema. Its tests mocked `read()` and saw neither.

## Decisions (manager, 2026-10-09)

- **Confirm, don't refuse.** A delete without confirmation gets a typed 409 naming the referencing
  entries; the dialog offers "Delete anyway", which re-sends with the confirm flag. A hard refusal
  would block legitimate cleanup.
- **ACLs.** Readable referencing entries are shown with title and a link; the rest are only
  counted ("and 2 entries you can't view"). A user who may not edit the entry gets the 403 before
  any scan, so learns nothing about its references.
- **Links count.** The reader rewrites an `entry:<id>` link in any string of an entry's data
  (`resolveEntryLinksInData`), so a link breaks just as a reference field does. Every such string
  is checked, the md/mdx body included, and listed as "linked from <path>"
  (`validation/deletion-checker.ts`, `findLinkingPaths`).
- **No cache.** Measured on a synthetic tree (md entries with two reference fields and a body
  link each, median of five): 20 entries 4 ms, 1,000 entries 61 ms, 5,000 entries 306 ms. A
  confirmed re-request skips the scan. A reverse-reference cache would be a read-modify-write
  under [docs/concurrency.md](../../../docs/concurrency.md) for an operation this rare.

## Other delete paths

Checked and left alone: collection delete refuses a non-empty collection, entry-type removal
refuses a type still in use, and a rename keeps the content id (it lives in the filename), so
none of them can orphan a reference. There is no bulk delete.

## Shape that shipped

- `collectReferenceIds(fields, data)` in `validation/field-traversal.ts`: every id a schema's
  reference fields hold, at its path (`[i]` per element of a list reference). Reusable by any
  reference check.
- `findReferencingEntries(entries, targetId)` in `validation/deletion-checker.ts`: pure, over raw
  `listEntries` items.
- `deleteEntry` in `api/entries.ts`: `confirmReferenced` query param, `referencedBy` on the 409.
- `useSchemaManager.deleteEntry(path, { confirmReferenced })`, `ReferencedByList`, and the
  dialog wiring in `Editor.tsx`.

The check is advisory under races: a reference saved between the scan and the delete still
dangles, which is the case
[dangling-reference-null-overwrites-id.md](dangling-reference-null-overwrites-id.md) covers.
