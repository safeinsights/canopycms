# gray-matter's global cache makes md/mdx frontmatter objects shared across reads

**Status:** Open. **Priority: P2** — latent today, but it is a shared-mutable-state bug in a
hot read path, and one half of it already shipped a real defect (see below).

## The mechanism

`gray-matter@4` keeps a **process-global cache keyed by file content**. A repeat `matter(raw)`
returns a fresh *file* object but the **same `data` object instance**:

```js
const a = matter(raw), b = matter(raw)
a === b            // false
a.data === b.data  // TRUE  <-- every caller shares one frontmatter object
```

Two consequences, only one of which is fixed.

## Half already fixed (on `fix/list-entries-reference-resolution`, adopter request #16)

`readEntryData` in `content-listing.ts` merged the body into that shared object in place:

```ts
const data = (parsed.data as Record<string, unknown>) ?? {}
if (parsed.content) data[bodyFieldName] = parsed.content   // mutates the SHARED object
```

That poisoned the cache process-wide. Because `ContentStore.read()`'s md branch calls
`matter()` again, a **resolved reference to an md entry came back WITH `body` when the listing
also listed that entry's own collection, and WITHOUT it when scoped past it** — the same entry,
two shapes, decided by unrelated scoping elsewhere in the call. Fixed by copying before the
merge; regression tests live with the reference-resolution tests in `content-listing.test.ts`.

## The half still open

Even with nothing mutating it, `read()` on an md/mdx entry returns a `doc.data` that **is** the
cached instance. So:

- Two `read()` calls for the same md entry return frontmatter objects that are the same object.
- `resolveSingleReferenceOnce`'s `{ id, slug, collection, ...doc.data }` severs exactly **one**
  level — every **nested** frontmatter object (`seo: { title, description }`, a nested list of
  objects) still aliases the global cache across occurrences, calls, and requests.
- A caller that mutates `doc.data.seo.title` rewrites it for every later reader in the process,
  including other requests in a warm Lambda container.

Proven, not theorised: mutating a nested value on one `matter()` result is visible to a later
independent `matter()` of the same content.

Note the irony recorded in `resolveSingleReference`'s doc comment: the **cached** resolution
path is the safer of the two, because it hands out a `structuredClone`. The uncached path — i.e.
plain `read()` — is the one with the aliasing.

## Why it was left open

Fixing it means changing `ContentStore.read()`'s md branch, and #16's PR explicitly promised
`read()` was byte-identical. Out of scope there, deliberately, rather than overlooked.

## Shape of the fix

One line, same as the fix already landed, in `content-store.ts`'s md branch of `read()`:

```ts
data: { ...((parsed.data as Record<string, unknown>) ?? {}) },
```

That severs the top level for `read()` too. It does **not** fix nested aliasing — for that,
either deep-copy there, or pass `{ cache: false }` to `matter()` and give up the cache
(measure first: the cache is why repeat parses are cheap). Decide which, then say so in
[concurrency.md](../../docs/concurrency.md), whose reference-resolve-cache row currently points
here for exactly this caveat.

Worth checking at the same time whether the cache is even a win for us, given every read already
does its own `fs.readFile` — gray-matter's cache only skips the *parse*, not the I/O.

## Related

- [resolved-reference-shape.md](resolved/resolved-reference-shape.md) — the resolved-reference
  shape question (`urlPath` + `includeBody`), resolved 2026-08-21.
- [shared-blocks-listentries-caveat.md](resolved/shared-blocks-listentries-caveat.md) — the
  documentation half of #16.

[BOTH]
