# A block whose `value` is null or a YAML array crashes or corrupts reference resolution

**Status:** Open. **Priority: P2**, with a P1-shaped symptom — read it before triaging.

## What happens

`resolveReferencesInData`'s block branch (`content-store.ts`) guards with
`typeof b.value !== 'object'`, which is true for `null` and for arrays. Two failure modes,
both verified against a real store:

- **`value: null` under a known template → `TypeError: Cannot read properties of null`,
  thrown out of `read()`.** The editor's GET only catches not-found
  (`api/content.ts`'s `readContentHandler`), so the request 500s and **the entry becomes
  permanently unopenable in the editor**. A resolving `listEntries` — i.e. a production build
  using `resolveReferences: true` — crashes the same way.
- **`value:` as a YAML array → silently converted to an index-keyed object** by the
  `{ ...b.value }` spread: `["item1","item2"]` becomes `{"0":"item1","1":"item2"}`. An editor
  round-trip then freezes that shape into the file. Silent content corruption.

## Why it is filed rather than fixed

Pre-existing and untouched by the resolved-reference work — the base branch has byte-identical
code. It was left out of that PR deliberately: it is orthogonal to reference *shape*, it is
about hostile-but-legal YAML, and a fix to that branch would have shipped unreviewed.

But note the exposure grew. Resolution used to run only on single-entry `read()`; it now also
runs on `listEntries`/`buildContentTree` when opted in, so a build can hit it too.

The write path forbids these shapes, so reaching them requires hand-edited content, a merge, or
a rebase pulling in someone else's — all normal in a git-backed CMS.

## Shape of the fix

One line at each site: use `isPlainRecord` (`validation/field-traversal.ts`), which
`resolveBlockItem` in that same file already uses for exactly this guard. Decide separately what
a malformed block should DO — passing it through untouched (as the traversal helper does) is
consistent and non-destructive; failing loudly at build time would match the
`assertBuildEntriesValid` posture for malformed entries.

Worth grepping for the same `typeof x === 'object'` pattern elsewhere while in there —
`null` and arrays both pass it, and that is the bug in both directions.

## Related

- [build-content-tree-silent-skip.md](build-content-tree-silent-skip.md) — the other
  malformed-content-reaches-a-listing case, and the same question of skip-vs-fail-loud.

[BOTH]
