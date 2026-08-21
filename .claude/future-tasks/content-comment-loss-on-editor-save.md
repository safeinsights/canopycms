# Editor saves silently delete every comment in a content file

**Status:** Open. **Priority: P1.** Found 2026-08-20 reviewing the marketing site's
`int-official-content` branch (PR #80). Not previously filed on either side — it is **not** the
adopter's #28, which is about CMS *review-thread* comments, a different thing entirely.

## Problem

`ContentStore` reads content into a plain object and writes it back by re-serialising that object.
Comments are not part of the object, so they do not survive the round trip.

```
packages/canopycms/src/content-store.ts:838    const data = asRecord(yamlParse(raw))
packages/canopycms/src/content-store.ts:1085   content = yamlStringify(input.data ?? {})
```

The blast radius is wider than YAML. The `md`/`mdx` branch three lines down has the same shape:

```
packages/canopycms/src/content-store.ts:1088   content = matter.stringify(input.body, input.data ?? {})
```

`gray-matter` also serialises frontmatter from a plain object, so **frontmatter comments in
`.md`/`.mdx` entries are destroyed too**. JSON is unaffected (no comment syntax).

There is no warning, no diff shown to the editor, and no way to recover except from git — and the
whole point of the editor is that non-technical users never touch git.

## Scope: which paths destroy comments, and which do not

- **Editor save → `ContentStore.write`** — destroys. This is the path a real editorial team takes.
- **`canopycms sync`** — safe. `sync-core.ts:87` uses `fs.copyFile`, byte-for-byte.
- **Dev working-tree edits** — safe, never round-tripped.

So the failure is invisible to the dev team (who use `sync` and their editor of choice) and
certain for the editorial team (who use the CMS). That asymmetry is why it went unnoticed until an
adopter's content happened to be comment-rich.

## Adopter cost, not yet paid but imminent

15 CMS-managed content files on the marketing site's branch carry comments — 44 lines in one
article entry, 43 in the FAQ landing entry, 14 in the media entry, ~250 lines in total. Several are
load-bearing rather than decorative: the `FLAG:` block in `landing.media.*.yaml` explaining that
its post cards are placeholders is cited **by name** from `src/app/resources/page.tsx` and tracked
as CF-7 in their own follow-up log. A single editor save of that entry deletes the explanation
while leaving the placeholder content it describes.

They have not been bitten yet only because the site is pre-launch and edits still come through
`sync`. Their editorial team is the trigger.

## Suggested fix (the direction chosen 2026-08-20)

Preserve comments in the package rather than declaring content files comment-hostile.

- YAML: move the read/write pair to `parseDocument` + document mutation (`yaml` 2.8.3 is already a
  dependency and supports this). Apply the incoming `data` onto the parsed `Document` so unchanged
  nodes — and their attached comments — are carried through untouched, instead of stringifying a
  fresh plain object.
- md/mdx frontmatter: the same treatment for the `matter.stringify` branch, or an explicit,
  documented decision that frontmatter comments are not preserved.

Two things a fix must get right:

1. **A key the editor removed must actually disappear.** Document mutation makes deletion explicit
   work rather than a side effect of rebuilding the object, so the fix has to handle it deliberately.
2. **This interacts with #29** (unknown keys are never reported, and `content-store.ts` serialises
   `input.data` wholesale, so stale keys are rewritten on every save). A document-mutation write
   path changes what "wholesale" means. Design the two together — see
   the unknown-key detection work filed alongside this.

## Verification

Round-trip a comment-bearing fixture through `ContentStore.write` and assert the comments survive;
it fails on `main` today. Use one of the marketing site's real entries as the fixture shape — a
top-of-file block comment, an inline comment on a nested key, and a comment inside a list.
