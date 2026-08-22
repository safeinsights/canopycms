# Unresolved git conflict markers are committed on `epic/adopter-request-intake`

**Status:** Open. **Priority: P1.** Found 2026-08-22 in passing, while fixing the slug write-boundary
seam (`fix/write-boundary-slug-validation`). Pre-existing on the epic branch — not introduced by that
work, and deliberately not fixed there because resolving the merge is a judgement call that belongs to
whoever made it.

## The defect

Two files on `origin/epic/adopter-request-intake` contain literal conflict markers:

1. **`AGENTS.md`** — lines ~69-72. `<<<<<<< HEAD` and `=======` are present; the closing `>>>>>>>` is
   **not**, so nothing that greps for the full triple will find it. The result is the whole
   "Top-level files (intentionally flat for discoverability)" paragraph appearing **twice**, in two
   divergent versions.

2. **`.claude/future-tasks/entrypath-read-resolves-by-entry-type-name.md`** — lines 33-37, a complete
   three-marker conflict over one link's trailing text (`(now resolved).` vs `.`).

## Why this is P1 rather than a typo

`AGENTS.md` is loaded as **project instructions for every agent session in this repo** (`CLAUDE.md`
ends with `@AGENTS.md`). Every agent is currently reading conflict markers plus two contradictory
copies of the same module inventory, and picking whichever it happens to read. The two copies are not
identical, so this is a live source of disagreement, not just noise:

- The **first** copy (`<<<<<<< HEAD` side) carries more `content-listing.ts` detail — notably the
  gray-matter frontmatter-copy paragraph explaining why `readEntryData` copies the parsed object.
- The **second** copy carries the `findUrlPathClaimant` / `isIndexSlug` collection-named-`index`
  paragraph, and the matching `SchemaOps.updateCollectionInner` note.

Both paragraphs are real and current. A resolution that just deletes one side loses documented
invariants that were each written to stop a specific bug recurring.

## How it got here

`848ea0d6 style: prettier AGENTS.md after the merge` ran prettier over a file that still had an
unresolved conflict in it. Prettier reflowed the region and the `>>>>>>>` line did not survive, which
is why the damage is invisible to the usual `grep '>>>>>>>'` check. The merge itself came in via
`380e9cc9 Merge epic into docs/epic-sync-2026-08-22` / `1ce481f9 Merge epic into
fix/url-roundtrip-and-index-collection`.

## To fix

1. Resolve `AGENTS.md` by **unioning** the two paragraphs — keep the gray-matter note from the first
   and the `isIndexSlug` note from the second — into a single "Top-level files" paragraph, then delete
   the `<<<<<<< HEAD` and `=======` lines.
2. Resolve the `entrypath-read-resolves-by-entry-type-name.md` conflict (the `(now resolved).` side is
   correct — `example1-next-build-not-in-ci.md` is in `resolved/`).
3. Add a guard so a marker cannot be committed again. A `grep -rn '^<<<<<<< \|^>>>>>>> '` check does
   **not** catch this case; the check needs to key on `^=======$` **or** `^<<<<<<< ` independently, so a
   half-eaten conflict still trips it. Natural homes: the existing `lint:tasks` script
   (`scripts/check-future-tasks.mjs`) for the task files, plus a repo-wide pre-commit hook.

## Verification

`grep -n '^<<<<<<<\|^=======$\|^>>>>>>>' AGENTS.md` returns nothing, and the "Top-level files"
paragraph appears exactly once.
