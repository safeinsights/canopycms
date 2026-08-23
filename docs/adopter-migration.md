# Adopter Migration Guide

What changed in CanopyCMS, what you must do to adopt it, and **what you can now
delete**. Written as the changes land, not reconstructed afterward.

## How to use this document

Work top-down through the entries for every version between your current pin and your
target. Each entry has the same three parts:

- **What changed** — the package-side change.
- **To adopt** — what you do in your repo.
- **Now deletable** — the kind of local code the change supersedes. **This part is the
  point.** An upgrade that adds the new API without removing the code it replaces has
  left two implementations to drift apart, which is the failure mode most of these
  changes exist to end.

Several entries below exist because real adopters independently hand-rolled the same
missing capability and got it subtly wrong in different ways. Where that happened, the
entry says what the bug looked like — that is usually a faster way to recognise the
code in your own repo than any description of the fix.

Entries are grouped by the release that carries them. Unreleased work sits under
**Unreleased** until it ships.

## Picking a target version

Resolve your target at the time you plan the upgrade, with
`npm view canopycms version` — do not copy a version number out of this document.
`main` auto-publishes a patch on every push, so the number moves.

If you are several releases behind, read every entry between your pin and your target,
not just the newest: the deletable-code lists compound, and a later entry sometimes
supersedes an earlier one's workaround entirely.

---

## Unreleased

_Entries land here as changes merge._

**Promoting them is a manual step, and it is easy to miss.** `main` auto-publishes a patch
on every push, so an entry written here is usually released within hours — while the heading
still says "Unreleased". When you next touch this file, check `npm view canopycms version`
and move anything already published down into `## Released` under its version heading,
demoting each entry from `###` to `####`. An adopter reading "Unreleased" about a feature
they already have installed cannot tell whether they are missing something.

### `basePath` deployments are supported, and `assetUrl`'s `baseUrl` is now safe for path prefixes (#24)

**What changed.** Three things, all pointing at the same failure — deploying under a Next.js
`basePath` (the usual shape for per-branch preview builds), where Next auto-prefixes only its own
`Image`/`Link`/`Script` and leaves every raw string URL resolving at the origin root.

1. `assetUrl()` / `assetSrcSet()`'s existing `baseUrl` option is now a documented contract that
   accepts a **same-origin path prefix** (`'/preview-123'`), not just an absolute origin. It also
   got two bug fixes it needed before that was safe to recommend: an already-absolute `src` is now
   returned untouched instead of being concatenated onto the prefix (which produced
   `/preview-123/https://cdn.example.com/x.png`), and a prefix without a leading slash is
   normalized instead of producing a _document-relative_ URL that resolved differently on every
   page. There is deliberately **no** new `basePath` parameter — `baseUrl` is the one prefix
   concept for asset URLs.
2. A new top-level `basePath` config key makes the **editor** work under a `basePath`. Its API
   route base and preview pane were hardcoded to the origin root, so the editor previously loaded
   no API response at all on such a deployment.
3. `media.publicBaseUrl`'s documentation was wrong about what it is for (it described an editor
   origin while showing an asset-host value). It is the editor's own answer to "where is `/assets`
   mounted", and is editor-display-only.

**To adopt.** Nothing is required if you deploy at the origin root — all of this is additive and
the default behaviour is unchanged.

If you deploy under a `basePath`, state it in your Canopy config as well as `next.config`
(CanopyCMS cannot read `next.config`):

```typescript
// canopycms.config.ts
basePath: process.env.NEXT_PUBLIC_BASE_PATH,
```

Then decide whether your **asset** space actually moved, which is not the same question:

- Next serves `/assets` (local adapter, `next dev`, S3 with no distribution) → it moved. Pass your
  prefix: `assetUrl(image, { width: 960, baseUrl: BASE_PATH })`.
- Assets are on CloudFront via `canopycms-cdk`'s `AssetSupport` → it did **not** move. Those
  behaviors are anchored at the distribution root. Pass no `baseUrl`.

Deriving `baseUrl` from `next.config`'s `basePath` unconditionally breaks the second case. See the
mount table under "Where `/assets` is mounted" in the project README.

Two traps worth checking for explicitly:

- **Do not pass a deployment `basePath` to `contentStaticParams({ basePath })`.** That option is
  the route prefix of a nested catch-all and _filters_ entries by it — a deployment prefix matches
  nothing, emits zero static params, and still builds green.
- **Body images bypass `assetUrl()` entirely.** Images inserted into markdown/MDX bodies are
  stored as raw srcs and rendered by your own renderer. Under a `basePath` they need an `img`
  override; the README shows one. It is safe to put on every image in a body: `assetUrl()` hands
  back off-site srcs and `data:` URIs byte-identical. Note it DOES root a **page-relative** src
  (`images/x.png`) onto the base you pass, so make those root-relative first.

**Now deletable.** Any hand-rolled prefixing wrapper around `assetUrl` — the shape is a module
exporting a re-bound `assetUrl`/`assetSrcSet` that injects a prefix read from an env var. The
option it was working around is first-class and now handles the cases such a wrapper usually gets
wrong: an off-site src, a prefix missing its leading slash, and a prefix that is nothing but
slashes. Also deletable: any local copy of a "strip trailing slashes from a base URL" helper —
`stripTrailingSlashes` is exported from `canopycms/server` and is the linear, non-ReDoS version.

### `select` fields now infer their own options — **breaking (type-level)**

_Adopter request log item 23._

**What changed.** `TypeFromEntrySchema` used to infer every `select` field as
`string | number`. It now infers the literal union of that field's own `options`:

```diff
- status: string | number
+ status: 'draft' | 'published'
```

The `number` half was never reachable. `SelectOption` carries `value: string` in both
of its arms, the editor's option normalizer emits strings, and the entry validator
rejects any select value that is not a string — so `number` was a type-level fiction
that every adopter had to launder back out by hand.

Both option forms work, including a single array that mixes them: a bare string option
contributes itself, and a `{ label, value }` option contributes its **`value`**, not its
label and not the whole object.

**To adopt.** Nothing, if your schema goes through `defineEntrySchema` (or is declared
`as const`) and your code already treats select values as strings. The narrowing is
inferred from the schema you already wrote.

Two things determine whether you get the narrow type:

- **The options must still be literals at the type level.** `defineEntrySchema` and
  `as const` preserve them. An options array annotated as the runtime type
  (`const options: SelectOption[] = [...]`) has no literals left, so the field falls
  back to `string`. That fallback is deliberate, not an error — but if you expected a
  union and got `string`, this is why.
- **A `select` with no `options`, or with `options: []`, also falls back to `string`.**
  Both are schema mistakes, rejected with a clear message by
  `ensureSelectFieldsHaveOptions` — which runs from `createEntrySchemaRegistry`, not
  from `validateCanopyConfig`. So a schema you only ever feed to `TypeFromEntrySchema`
  and never register gets no runtime rejection at all. Either way the inferred type
  stays usable rather than collapsing to `never`.

**`''` is deliberately not in the union.** The validator accepts an empty string as
"not filled in" for any field that is not explicitly `required: true`, so a select can
hold `''` on disk. Like the rest of `TypeFromEntrySchema`, this models the schema's
declared shape rather than everything the validator tolerates — the same stance that
already types a field omitting `required` as a required property. If your content has
cleared selects and you branch on that, compare before the value reaches the typed
surface, or add `''` to your own schema's options so it becomes a declared state.

_Broken (act on these):_

- **Comparing a select value against a string that is not one of its options.** This
  now fails to compile with "no overlap" instead of silently being dead code. That is
  usually a real bug being surfaced — a renamed option, or a comparison against a
  label instead of a value. Fix the comparison; do not widen the type to silence it.
- **Assigning a schema-derived select value to a hand-written `string` field.** Still
  fine — the union is assignable to `string`. The reverse is not: assigning a plain
  `string` **into** a schema-derived select value is now an error. Derive the type from
  the schema instead of re-declaring it.
- **A custom field type that uses the property name `options` for something other than
  select options.** `options` is now a reserved, typed key on the schema field shape
  (alongside `fields`, `templates`, `entryTypes` and `collections`), so a custom field
  declaring e.g. `options: [1, 2, 3]` stops compiling, even though the runtime still
  accepts it — custom field configs are validated with a passthrough schema. Rename the
  property on your custom field; there is no way to keep the name and the shape.
- **Anything that relied on the `number` half.** A `typeof value === 'number'` branch on
  a select value now narrows to `never` — correctly, since it never ran. Note this is
  silent: TypeScript reports nothing for a `typeof` check that cannot match, so grep for
  these rather than expecting the compiler to list them. (An `===` comparison against a
  non-option string _does_ error, with "no overlap".)

**Now deletable.** Any local shim that re-narrows a schema-derived select value back to
the app's own union before use — typically a helper or an inline cast that takes the
value, checks it against a hand-maintained allowlist of the same option strings (or
just asserts `as 'a' | 'b'`), and returns the narrow type. That allowlist was a second
copy of the schema's `options`, free to drift from it silently; the schema is now the
single source. Also deletable: `typeof v === 'string'` guards that existed only to
strip the impossible `number`.

### `listEntries()` and `buildContentTree()` can now resolve `reference` fields (#16)

_Adopter request log item 16. This supersedes the caveat shipped in `0.0.63` under
"Shared/referenced blocks", whose "Now deletable" list said, correctly at the time, that
there was nothing to delete because the gap was real. There is now._

**What changed.** Both batch listing surfaces take a `resolveReferences` option. Turn it on
and every `reference` field in the returned `data` is resolved to the referenced entry —
including references nested inside `object` fields, inline `group`s and block templates, so a
shared/referenced block finally carries its snippet's content in a listing. Off (the default),
they stay what they have always been: a bare id string, or `null`.

`collectRoutableEntries` takes the same option and forwards it. `collectStaticPaths` does not,
because it discards `data` outright.

**The default is `false`, and `read()`'s is `true`.** That asymmetry is deliberate. A resolved
reference changes from `'a1b2c3d4e5f6'` to `{ id, slug, collection, ...data }`, and a listing's
`data` is your own generic parameter while `extract` receives an untyped record — so a flipped
default would have changed the shape under every existing call site with no compile error to
catch it, turning an `/authors/${data.author}` template into `/authors/[object Object]` at
runtime. Opting in per call site keeps that decision next to the code that reads the field.

**Cost.** Resolution needs the ContentId index, so an opted-in call adds one index scan plus
one read per **distinct** referenced entry — not per referencing entry. A single per-call cache
spans the whole batch, so a shared block referenced from 40 pages is read once, and a
search-index build over thousands of entries does not multiply by its reference count. Nothing
is constructed and nothing is scanned when the option is off, so existing calls are unaffected.

Two things worth knowing before you switch it on. Path ACLs are **not** applied to the resolved
targets — matching `read()` exactly, so a reference can resolve to an entry the current user
could not `read()` directly; the entries being listed are still ACL-filtered as always, and a
filtered-out entry is never resolved at all. And within one call, a given id resolves once and
every occurrence shares that answer, so a batch is internally consistent rather than
re-deciding per page. Each occurrence still gets its own copy of the resolved object,
so the shared lookup cannot turn into shared mutable state between entries.

The admin entries API (`GET /:branch/entries`) deliberately does not resolve: it is a paginated
table that never reads inside a reference, and resolution there would run before pagination on
a request path.

**To adopt.**

```ts
// A search index that must see shared-block content:
const entries = await ctx.listEntries({ resolveReferences: true })

// Or through the static helper:
const routable = await collectRoutableEntries(await getCanopyForBuild(), {
  resolveReferences: true,
})
```

Leave it off for `generateStaticParams`, sitemaps, and anything else that only needs paths,
slugs or `updatedAt`.

**Now deletable.**

- **A second `read()` pass bolted onto a `listEntries()`-derived surface.** The shape is a
  build script or route that lists entries, walks the results looking for id-shaped strings or
  empty block values, then issues a follow-up single-entry read per hit to fill them in —
  usually with its own ad-hoc memo table so a shared block is not fetched repeatedly. All of it
  goes: pass the option, delete the second pass and the memo.
- **A surface deliberately rebuilt on `read()`/`readByUrlPath()` to dodge the gap** — a search
  index or feed that enumerates paths and then reads each entry individually, purely because
  the listing could not resolve references. It can go back to a single listing call.
- **Nothing where the listing never touched a reference field.** Leaving the option off is the
  right answer there, not an oversight to correct.

### Resolved references now carry `urlPath`, and can carry the target's body — **breaking (type-level)**

_Follows the `listEntries` entry above; together they close what a resolved reference is for._

**What changed.** A resolved reference used to be `{ id, slug, collection, ...frontmatter }`,
which served neither job it gets used for. Two additions:

- **`urlPath`, on every resolved reference, always.** The referenced entry's URL, following the
  same rule `listEntries` publishes as `item.urlPath` (an `index` entry collapses to its parent
  path). Both now come from one shared function, so a link built from a resolved reference
  reaches the entry the listing enumerates, by construction rather than by coincidence.
- **`includeBody` on the reference field**, default `false`. When set, the resolved value also
  carries the target's body, under the _target_ entry type's own body field name (`isBody: true`,
  else `body`). Only meaningful for md/mdx targets — a json/yaml document is already all data.

```diff
  {
    name: 'snippet',
    type: 'reference',
    entryTypes: ['ctaSnippet'],
+   includeBody: true,     // this reference EMBEDS its target, so it wants the prose
  }
```

**Why `includeBody` sits on the field and not on the call.** A reference either **embeds** its
target (a shared call-to-action rendered inline — wants the prose) or **links** to it (related
posts, an author byline — wants a URL and a title, and definitely not the target's full body
inlined into every page read). That is a property of your content model, not of the call site,
and a single `listEntries()` call routinely contains both kinds — a page with a shared CTA _and_
a related-posts list cannot be served by one call-level setting. Declaring it on the field means
every caller (`read()`, `readByUrlPath()`, `listEntries()`, `buildContentTree()`) gets the right
shape without being told.

**The type-level break.** `TypeFromEntrySchema` used to infer a resolved reference as just the
target's content shape. It now intersects the resolution metadata that was always returned at
runtime but missing from the type:

```diff
- author: { name: string; bio: string } | null
+ author: ({ name: string; bio: string } & ResolvedReferenceMeta) | null
+   // ResolvedReferenceMeta = { id: string; slug: string; collection: string; urlPath: string }
```

Reads keep compiling — this is a widening, and `ref.id` no longer needs a cast. What can break
is an exact-shape assignment: a variable annotated with the old literal object type, an
`Exact<>`-style helper, or a test asserting the inferred type equals a hand-written shape. If
you have any, add `& ResolvedReferenceMeta` (exported from `canopycms`) or widen the annotation.

**One thing to know.** If a field's `resolvedSchema` declares a body field but you have not set
`includeBody`, the inferred type still promises that field while the runtime omits it. Setting
`includeBody: true` makes the promise true; alternatively, leave the body field out of the
`resolvedSchema` you pass, which is inference-only and need not be the target's full schema.

**Two things to know.** `id`, `slug`, `collection` and `urlPath` are **reserved** on a resolved
reference: the resolution value now wins over a target that models one of them as a real content
field. That ordering is a fix, not a preference — the write boundary recovers a reference's id
from `value.id`, so a target with its own `id` frontmatter field used to make a re-save persist
that value and silently repoint the reference. If a target of yours legitimately carries one of
those four names as content, read that entry directly to get it.

And `includeBody: true` carries the target's body into every referencing entry's resolved value,
so a long document embedded by many pages is carried once per page. Fine for a snippet; think
twice for a full article, which probably wanted a link.

**A save no longer freezes a resolved reference into your content.** Separately fixed here: the
editor reads a document with references already resolved, so a plain open-and-save posted those
resolved objects back, and the write boundary persisted them verbatim into the content file.
Because resolution only re-resolves a bare string, the frozen snapshot then survived every later
read and save — the reference was silently severed from its target for good, and renaming or
editing the target changed nothing. Reference fields are now collapsed back to their ID at the
write boundary, not just in the copy handed to validation.

The mechanism predates this release; `includeBody` is what made it urgent, since the snapshot
would otherwise carry the target's entire prose. **If you have edited entries with reference
fields through the editor on an earlier version, check your content files**: a reference field
holding an object rather than a 12-character ID string is a severed reference. Replacing the
object with its own `id` value restores it.

One case this does **not** cover, so you know the boundary: if a reference's target has been
deleted, resolution yields `null` and a save persists that `null` over the ID — there is no
object left to collapse back. Open-and-save is lossless only while every reference still
resolves. Tracked separately; if you see `null` where a reference should be, the ID it used to
hold is not recoverable from the file.

**To adopt.** Nothing is required — `urlPath` simply appears. Add `includeBody: true` to
reference fields whose target's prose you actually render or index.

**Now deletable.**

- **A contentId → URL index built by a second content pass.** The shape is a helper that walks
  `listEntries()` (or the content tree) a second time purely to map ids to URLs, so referenced
  entries can be linked — usually memoised, usually built per request or per build. Delete it;
  read `urlPath` off the resolved reference.
- **The `resolveReferences: false` escape hatch that index forced.** Pages that turned resolution
  off because paying for resolution _and_ a separate URL lookup was worse than hand-rolling both
  can turn it back on.
- **A follow-up `read()` of a referenced entry purely to get its body**, in code that renders a
  shared/referenced block. Set `includeBody: true` on the field instead.

### Editor saves no longer delete comments in content files

**What changed.** `ContentStore` used to write an entry by re-serialising a fresh plain object
(`yaml.stringify` for `.yaml`, `gray-matter` for `md`/`mdx` frontmatter). Comments are in neither
the object nor that round trip, so the first CMS save of a hand-authored entry silently deleted
every comment in it — with no warning, and no recovery outside git. `canopycms sync` copies files
byte-for-byte, so a dev team never saw this; an editorial team hit it on their first save.

Writes now re-serialise onto the file's own parsed document, so a node whose value did not change
keeps its comments (and its original quoting and block style). Both YAML entries and md/mdx
frontmatter are covered. Reordering a list carries each comment with the content it was written
about rather than leaving it on whatever now sits at that index. JSON is unaffected — it has no
comment syntax.

The payload is still authoritative about _content_: a key the editor removed is removed from the
file, and a client that posts a partial payload still replaces the document, exactly as before.
Comments are the only thing inherited from what was on disk.

**To adopt.** Nothing. It applies to every save automatically.

**Now deletable.** Any convention your team adopted to work around it — moving explanatory notes
out of content files into a sidecar doc or a README, or a rule that comment-bearing entries must
never be opened in the CMS. Content files can carry comments again, including notes that code
elsewhere refers to by name.

### Saves and builds now report content keys the schema does not define (#29)

**What changed.** Entry validation walked the schema, so it could only ever report fields the
schema already knew about. A key in the content with no schema counterpart was reported nowhere:
rename or reshape a field and there was no editor error, no 422 and no build failure, while the
old key persisted on disk indefinitely. The only symptom was a component receiving `undefined`.

Two non-fatal reports now exist:

- **On save**, unknown keys come back in the write response's `validationWarnings`, which the
  editor already surfaces as a "Saved with warnings" notification. The save still succeeds.
- **During a production build**, `collectStaticPaths` / `collectRoutableEntries` print a single
  warning naming the offending entries and their key paths. The count is exact; the listing stops
  after the first 20 and summarises the rest. The build still passes.

Both report paths, not just names — `hero.kicker`, `blocks[2].headline` — and neither fires for an
entry type with no schema at all, or for a block item's `template` discriminator. This is
reporting only: nothing is rejected and nothing is stripped, and with the comment-preserving write
above, an unknown key and its comments are still written back on every save.

**To adopt.** Nothing to wire up. Expect the first build after upgrading to list keys you no
longer use — that list is the point. For each one, either add the field to the entry type's schema
or delete the key from the content.

**Now deletable.** Any hand-rolled script that diffs content keys against a schema to catch drift
after a rename, and any defensive `?? fallback` a component carries purely because nobody could
tell whether a field was still populated.

### An `index` entry no longer answers at a second URL, and a contested URL now fails the build — **breaking (routing)**

_Adopter request log item 22._

**What changed.** Two things, from one root cause in the URL → entry resolver.

`readByUrlPath` no longer resolves an index entry at its literal `.../index` URL. An index entry's
URL is its collection's path — that is what `listEntries` publishes as `item.urlPath`, what
`buildContentTree` uses for node paths, and what a resolved reference's `urlPath` carries. The
resolver disagreed: it tried "last segment is the slug" first, so the same entry also answered at
`/x/index`, a URL no other API ever emits.

```diff
  await readByUrlPath('/guides')        // the index entry — unchanged
- await readByUrlPath('/guides/index')  // ALSO the index entry
+ await readByUrlPath('/guides/index')  // null
```

The round-trip guarantee now excludes the `.../index` spelling for index entries: `item.urlPath`
reaches the entry, and no `.../index` spelling does, in any case (`/x/Index` and `/x/INDEX` return
null too). The remaining extra URLs an entry answered at are closed by a later entry below, which
you should read together with this one — it supersedes this entry's original caveat, and its
"Now deletable" list is the one to act on if you wrote per-route guards. Ordinary
entries are unchanged — their final slug segment stays case-insensitive.
A collection literally _named_ `index` is unaffected and in fact fixed — `/docs/index` now resolves
to that collection's own index entry instead of being shadowed by its parent's.

Separately, a **production build** (`isBuildMode()` — not `next dev`) now fails when two entries
compute the same `urlPath`, listing each contested URL and its claimants. Previously one entry got
the route and the other silently had no page anywhere. The usual causes are an entry whose slug
matches a sibling collection that _also_ has an `index` entry, and two slugs differing only by
case (URL paths are lowercased). An entry beside a sibling collection with **no** index entry is
untouched — a landing page plus a folder of children is a legitimate shape and nothing about it
is contested.

**To adopt.** Mostly nothing: the resolver change removes URLs no API ever advertised. Three
exceptions worth checking.

**If you route a collection through a single-segment `[slug]` route** — `shape: 'single'` static
params, typically the scaffolded `contentStaticParams({ shape: 'single' })` — that helper no
longer emits the collection's **index** entry. It never had a param that could address it (its
URL is the collection's own path, not a slug under it), and the URL it did emit is one of the
`.../index` URLs that now return null. **This is the one case where a page can silently stop
being generated**, so check for it: if a collection has an index entry and you were relying on
that route to render it, move it to the collection's own route (`app/posts/page.tsx`). Catch-all
routes are unaffected — they use the already-collapsed segments. If you have a collection literally _named_ `index`, `/x/index` was
advertised and now resolves to a **different** entry (that collection's own index, rather than its
parent's — the previous answer was a bug). And if a build starts failing on a contested URL, the
error names every colliding entry; rename or remove one of each pair. Note the build only fails if
it enumerates through Canopy's own helpers — `collectStaticPaths` / `collectRoutableEntries`,
or the bound wrappers over them that `createNextCanopyContext` returns (`generateContentStaticParams`
and `generateContentSitemap` — the scaffolded `lib/canopy.ts` re-exports the first as
`contentStaticParams`; if you wired the sitemap yourself, it is whatever you named it). A hand-rolled
`generateStaticParams` over `listEntries` does not fail; call `findDuplicateUrlPaths` yourself
there.
To check before upgrading:

```ts
import { findDuplicateUrlPaths } from 'canopycms/server'

const canopy = await getCanopyForBuild()
const duplicates = findDuplicateUrlPaths(await canopy.listEntries())
```

Scan `listEntries()`, not `collectRoutableEntries()` — the latter reduces each entry to what static
generation needs and drops the `entryPath` that names the offenders.

**Also changed, smaller.** The `path` field on a `read()` / `readByUrlPath()` result now collapses
an index slug and strips the content root from root-level entries, so it is a URL that actually
resolves. It previously returned `/guides/index` for an index entry — a URL this release stops resolving —
and `/content` / `/content/about` for root-level ones, which never resolved at all. If you were
working around either, stop.

**Now deletable.**

- **A route-level guard whose only job is to reject a `.../index` URL.** The shape is a check at
  the top of a `[slug]` route — usually on `entryType`, sometimes on the slug itself — that exists
  because the collection's index entry resolved through a template meant for its children and
  rendered with every field undefined. That URL is now a 404 on its own, in every case spelling.
  Delete the check; keep any `entryType` narrowing you rely on for real type safety.
- **A hand-rolled duplicate-URL integrity test.** The shape is a test that enumerates content and
  asserts no two entries share a URL, written because nothing in the package checked. The build
  now enforces it; if you want the assertion kept locally, call `findDuplicateUrlPaths` instead of
  re-implementing the scan.

### Sitemap `pathFor`, and modelling a page served at `/` as a root `index` entry

_Adopter request log items 20 and 20b._

**What changed.** Two changes answering one question — "the URL my app serves this entry at isn't
the entry's own `urlPath`" — in the order you should try them.

1. **Modelling, which needs no API at all.** An entry whose slug is `index` collapses onto its
   collection's path; at the content root that path is `/`. So a home page stored as
   `content/home.index.<id>.json` has `urlPath: '/'` — already the URL its route serves. Nothing to
   reconcile anywhere. This was always true and always documented; what was missing is that the
   reference app in this repo modelled `home` as an ordinary root entry (`urlPath: '/home'`) and
   then papered over the mismatch in its own sitemap, so the workaround was what adopters actually
   had in front of them. It no longer does that.

2. **`generateContentSitemap` gained `pathFor`**, for the cases where modelling is not available —
   a URL fixed by published history you cannot change, or a route prefix that deliberately differs
   from the content layout:

   ```ts
   pathFor: (entry) =>
     entry.entryType === 'article' ? entry.urlPath.replace(/^\/articles\//, '/blog/') : null,
   ```

   It overrides the URL while keeping the entry **inside** the entry walk, so the `isNoindexEntry`
   gate, the `updatedAt` `lastModified` default and `priority` all still apply.

   `null` (or `undefined`) means **"keep the structural path", not "drop this entry"** — so the
   callback above reroutes articles and leaves every other entry at its own URL. Dropping is still
   `exclude`'s job. An empty string throws rather than silently resolving to `/`.

   `extraUrls` is unchanged and now means only what its name says: URLs with **no entry behind
   them**, like a feed or a hand-written route. It still inherits neither the `noindex` gate nor
   the `lastModified` default, which is exactly why rerouting a real entry through it was always
   hand-managed.

**To adopt.** Nothing is required — `pathFor` is additive and the modelling change is a
recommendation. If you do re-model a singleton you serve at a collection's own path:

1. Rename the file so its slug segment is `index` (`git mv home.home.<id>.json
home.index.<id>.json`). Entry type and ID are unchanged, so references, `order` arrays and
   editor position all survive.
2. **Fix any read that addresses the entry by entry-type path.** This is the step that bites:
   `read({ entryPath: 'content/home' })` passes no `slug`, and a slugless read defaults the slug to
   the entry-type _name_ (`effectiveSlug = slug || schemaItem.name`), so it looks for slug `home`
   and stops resolving once the slug is `index`. Passing `slug: 'index'` explicitly keeps that call
   working. Prefer switching to `readByUrlPath('/')` and handling its `null` return (it
   returns `null` where `read` throws). Skipping this yields a **green build with a 404 at `/`** —
   a static build prerenders the not-found boundary and reports success either way, so verify by
   reading the emitted HTML, not the build's exit code.
3. Drop the sitemap workaround (below), and re-check the emitted `sitemap.xml` for the new URL.
4. If the old URL was publicly indexed, add a redirect from it — the entry's URL genuinely changes.

**A caveat this entry originally carried has since been fixed, in the same release.** Modelling
home at the root used to make `readByUrlPath('/home')` return the home entry as well as
`readByUrlPath('/')` — harmless on a route-per-page app, a duplicate homepage on one with a root
catch-all. The original wording also under-scoped it: it named `/home`, but _every_ entry-type name
declared beside home answered too, so filtering `/home` alone still left `/page` and `/landing`
serving duplicates. All of them now return `null`; see "`readByUrlPath` answers only where
`listEntries` publishes" below, and do not write the filter.

**Now deletable.**

- **The `exclude` + `extraUrls` pair that re-adds a page's real URL by hand.** The shape is an
  exclusion by entry type (or slug) in `generateContentSitemap`, paired with an `extraUrls` item
  putting the same page back at the URL the route actually serves — two lines that exist only
  because the entry's structural URL and its served URL disagree. Re-model the entry and both go;
  the page is then advertised on its own merits, carrying a real `lastModified` instead of
  whichever value was hand-copied into the extra URL, or none at all.
- **Hand-derived `noindex` and `lastModified` beside an `extraUrls` entry.** The shape is a
  re-implementation of the SEO-flag read, or a date threaded in from elsewhere, sitting next to an
  extra URL that stands in for a real entry — written because an extra URL inherits neither. If the
  entry exists, `pathFor` gives you both back; delete the re-derivation rather than keeping a second
  copy of the rule to drift.
- **Nothing on the `pathFor` side if you were not already working around this.** It is a new option
  for an existing gap, not a replacement for a supported API.

### The CMS now refuses to author a contested URL

_The write-boundary half of the previous entry._

**What changed.** Creating or renaming an entry (or renaming a collection) is refused when it
would give a second entry a URL another entry already holds. Previously only a production build
caught this, after the fact.

Refused in two shapes, both of which leave exactly one of the pair unreachable:

- an entry whose slug matches a sibling collection **that has an index entry** — both compute the
  same URL;
- an index entry added to a collection whose **parent** already holds an entry with that
  collection's name — the same collision from the other side.

**Deliberately not refused:** an entry beside a same-named sibling collection that has _no_ index
entry. That is a landing page plus a folder of children, nothing is contested, and it keeps
working. The guard keys on the URL, never on the name.

It is also create/rename **only**. An ordinary save of an entry already in a contested pair still
succeeds — blocking it would trap you in an entry you could no longer fix. Pre-existing collisions
(from a merge, a retrofit, or a direct commit) are the build guard's business, and it still runs.

**To adopt.** Nothing. Creating or renaming an entry into a contested URL returns **409** with a
message naming the other entry and its path; renaming a _collection_ into one returns **400**,
matching that endpoint's existing refusals. Both messages say which entry is in the way and what
to do about it — they are not the generic "modified by another editor", which would be advice you
cannot act on.

**Now deletable.** Nothing — this closes a gap rather than replacing local code. If you added your
own editor-side check for this after hitting it, it is now redundant.

### A slug that cannot round-trip through a URL now fails the build, and the CMS refuses to create one — **breaking (build)**

**What changed.** Content file names are `{type}.{slug}.{id}.{ext}`, and the parse is anchored on
the type and the ID — so the `slug` segment is allowed to contain characters that are not valid in
a URL segment. A dot is the common one: `post.getting.started.guide.<id>.md` parses fine and lists
with `slug: 'getting.started.guide'`. An underscore or a leading hyphen does the same. But
`readByUrlPath()` runs every URL-resolution candidate through a stricter rule — lowercase letters,
numbers and hyphens, starting with a letter or number — and skips anything that fails it. Such an
entry **built, got a `generateStaticParams` entry and a sitemap `<loc>`, and then 404'd on every
actual visit.** Silently.

Two changes, both aimed at that:

- A **production build now fails** on it, listing every offending entry by path. This is the part
  most likely to turn a previously-green build red on upgrade: nothing about your content changed,
  but a page you did not know was broken is now loud instead of silent.
- The **write API refuses to mint one**. A `PUT` creating an entry with a non-conforming slug is
  rejected with `400`, and so is a rename to one — enforced in `ContentStore` itself, so it holds
  for any client, not just the editor UI. Previously only `renameEntry`'s `newSlug` was checked;
  a create was accepted, and the build failed afterwards for whoever built next.

It is **create/rename only**, deliberately. An entry that already has a non-conforming slug stays
readable, stays saveable, and can be renamed — renaming it is the only way to clear the build
failure, so refusing to read or edit it would convert a red build into unreachable data. That is
also why enforcement is not in the path-resolution layer, which reads and writes share.

**To adopt.** Build once and read the failure list. For each entry it names, rename the file's
**slug segment** — the part between the type and the ID — to lowercase letters, numbers and
hyphens (`post.getting-started-guide.<id>.md`), leaving the type, the ID and the extension alone.
Renaming through the editor does the same thing and updates nothing else, since the ID is what
identifies the entry. If the old URL was reachable in practice it was not reachable through
CanopyCMS, so there is no redirect to preserve — but check any hand-written links to it.

If you generate content with a script, slugify with the same rule before writing; the CLI's
`canopycms migrate` already does. A script that writes files directly (rather than through the
write API) is not covered by the new refusal, which is exactly the case the build guard exists for.

**Now deletable.** Any local build-time or CI check you wrote that walks content filenames looking
for slugs your routing could not serve, and any editor-side slug-format check you added in front of
the create form — the package now rejects those at the write boundary and fails the build on the
ones that arrive some other way.

### `readByUrlPath` answers only where `listEntries` publishes — **breaking (routing)**

_Adopter request log item 34, and the remainder of item 22._

**What changed.** `readByUrlPath` now resolves exactly the set of URLs enumeration advertises. For
every entry, `readByUrlPath(item.urlPath)` reaches it and nothing else does. Three shapes that used
to resolve now return `null`:

```diff
  await readByUrlPath('/blog/hello')          // the article — unchanged
- await readByUrlPath('/blog/article')        // ALSO the blog's index entry
- await readByUrlPath('/blog/article/hello')  // ALSO the article
+ await readByUrlPath('/blog/article')        // null
+ await readByUrlPath('/blog/article/hello')  // null
```

`article` there is an entry-type _name_. Both shapes came from one cause: an entry type is
registered in the schema at `<collectionPath>/<typeName>`, and a read against that path is
delegated to the parent collection — which is correct for `read({ entryPath })`, and meaningless
for a URL, since a URL's non-slug segments are collection names by construction. The first shape
needed the collection to have an index entry; **the second did not**, so it applied to every entry
in every collection, at `/<collection>/<entryTypeName>/<slug>`. The reference app was serving seven
duplicate pages through it.

The third shape is an entry whose type token on disk is not one its collection declares — most
often an entry type renamed in the schema without renaming the files. `listEntries` has always
skipped those; resolution used to serve them anyway, so a page could stay live at a URL enumeration
had already stopped publishing. It now 404s. **A collection that declares no entry types at all
counts here too**: it lists nothing, whatever sits in its directory, so a file placed in a
collections-only container is no longer served either. Neither case can arise from content the CMS
authored — there is no entry type to have created it as — so if it describes content you have, it
arrived by hand, by merge or by retrofit, and it was already missing from your sitemap and static
params. The fix is to rename the files to a declared type, or declare the type. The entry remains
fully editable, renameable and deletable in the CMS throughout, which is deliberate: only URL
resolution was narrowed, not reading, writing or renaming — otherwise a save would create a second
file with the same slug and the mistake would be unfixable from the editor.

**Two things deliberately did not change.** `read({ entryPath: 'content/home' })` still addresses a
singleton structurally, defaulting the slug to the entry type's own name. And two _different_
entries claiming one `urlPath` is still a separate problem with its own guard
(`findDuplicateUrlPaths`, and the build failure described further up).

**One gap remains, and is not fixed here.** A legacy untyped content file — `overview.json` rather
than `{type}.{slug}.{id}.{ext}` — is still readable by URL while being invisible to `listEntries`,
`generateContentStaticParams` and the sitemap. If you have such files, they are already absent from
every enumerating surface; rename them into the typed grammar to make them real entries.

**To adopt.** Nothing, unless a route of yours depends on one of the URLs above. Two checks worth
doing once:

1. If you serve a catch-all route, request `/<collection>/<entryTypeName>` and
   `/<collection>/<entryTypeName>/<some-slug>` for a few of your own type names and confirm you get
   a 404 rather than a page you did not mean to publish. Under a full static export these were
   always CDN 404s; under `next dev` or `output: 'standalone'` they were served.
2. If you renamed an entry type without renaming files on disk, those entries stop resolving. They
   were already missing from your sitemap and static params, so a build will not tell you —
   `listEntries()` will.

**Now deletable.**

- **Per-route `entryType` gates that exist only to reject a URL that should not have resolved.**
  The shape is a check at the top of a catch-all or `[slug]` route asserting the resolved entry is
  the type that route renders — added because the resolver handed back an index entry, or an entry
  from a different level, and the template rendered with every field `undefined` while
  `if (!result) notFound()` stayed silent. Those URLs are `null` now. Keep any `entryType` branch
  that genuinely dispatches between templates; delete the ones that only ever throw or 404.
- **A catch-all filter that drops entry-type names before resolving.** The shape is a hard-coded
  list of segments to reject — usually the app's own entry type names — sitting in front of
  `readByUrlPath`. Note it was never sufficient anyway: filtering the singleton's own name left
  every other type name declared beside it resolving.
- **A regression test asserting a specific phantom URL returns null.** The package now asserts the
  general invariant — enumerate, then probe every adjacent URL the resolver would attempt — over
  both its own fixtures and its reference app, which is what stops the next shape of this bug
  reaching you. Keep a local test only if it covers routing you own rather than resolution we own.

---

<!--
Template for each entry — copy, don't improvise:

### <short title>

**What changed.** One or two sentences.

**To adopt.** Concrete steps, with the import path and the call shape.

**Now deletable.** Describe the PATTERN of local code this supersedes — "a hand-rolled
filename parser", "a build-time directory walk that stats content files" — so any
adopter can recognise it in their own tree. Do NOT name files, paths, branches, hosts,
or identifiers from a specific adopter's repo: this package is public and its adopters'
repos generally are not. If nothing becomes deletable, say so explicitly — that is a
real and useful answer.
-->

---

## Released

### 0.0.63

Every entry below shipped in `0.0.63`. They were promoted from `## Unreleased` on
2026-08-20, after an adopter reported that the section had been describing already-released
features as unreleased — see the note under `## Unreleased` for why that happens and what to
check before trusting the heading.

#### `required: false` now infers an optional property (#14) — **breaking (type-level)**

**What changed.** `TypeFromEntrySchema` used to emit every field as a _required_
property, adding `| undefined` to the value type for `required: false` fields. It now
emits `required: false` fields as genuinely _optional_ properties:

```diff
- { heading: string; subheading: string | undefined }
+ { heading: string; subheading?: string }
```

The rule applies at every level: top-level fields, fields inside `object` fields, and
fields inside block templates.

**Only an explicit `required: false` is affected.** A field that omits `required`
entirely still infers a required property — that is unchanged and deliberate, and is
now pinned by tests.

This is a **type-only** change. No runtime behavior, no content-file format, and no
validator behavior changes. The direction of the break is narrow:

_Not broken (nothing to do):_

- **Reading.** `data.subheading` is still `string | undefined`.
- **Constructing literals.** Strictly more permissive — every literal that compiled
  before still compiles. This is the win.
- `keyof T`, `'subheading' in data`, object spreads, `Object.entries(data)`.

_Broken (act on these):_

- **Assigning a `TypeFromEntrySchema` value to a hand-written interface that declares
  the key as required-with-`undefined`** (`subheading: string | undefined`). The
  optional property is no longer assignable to it. Fix the hand-written interface to
  use `subheading?: string` — or, better, delete it and derive from the schema.
- **`Required<T>`** now behaves differently: it strips the `?` and yields
  `subheading: string`, where before it was a no-op returning `string | undefined`.
  Audit any `Required<...>` applied to a schema-derived type.
- **`exactOptionalPropertyTypes: true` projects.** Under that flag, explicitly writing
  `x.subheading = undefined` or passing `{ subheading: undefined }` becomes an error;
  omit the key instead. Check your `tsconfig.json` before upgrading; a plain
  `"strict": true` does not enable it.
- **`exactOptionalPropertyTypes: true` combined with `skipLibCheck: false`.** This
  combination fails to compile against the package at all, independent of the
  assignment-level advice above: a pre-existing gap in a `reference` field's inferred
  type surfaces as a library-internal type error. `skipLibCheck: true` (the Next.js
  default) avoids it entirely; there is no other workaround today.

**To adopt.** Bump the pin. There is no API change and no import to add. Then delete
the code below.

**Now deletable.**

- **`undefined`-walls in schema-typed literals.** Any `: undefined,` line that exists
  only to satisfy a `required: false` field can simply be removed — delete the line, do
  not replace it. These cluster in route or page modules that construct a schema-typed
  object by hand; one adopter carried 11-line walls in three separate routes.

  The follow-on benefit is the real point: adding a new `required: false` field to a
  schema no longer breaks every hand-written literal in the app. That friction is worth
  naming, because its observed effect was to push a team toward hardcoding content
  directly into components rather than extending the schema — the opposite of what a
  CMS is for.

- **Nothing, possibly.** `: undefined` inside ternaries, local test fixtures, or
  non-schema-derived types is unaffected. Two patterns that look affected but are not:
  `NonNullable<Schema['field']>` still resolves identically, because indexing an
  optional property still yields `| undefined`; and `Required<...>` applied to a
  _local_ type rather than a schema-derived one is untouched.

#### Sitemap and SEO metadata helpers (#10, #10a)

**What changed.** CanopyCMS now ships the two static-export surfaces it previously told you
were "coming separately", and they ship **together on purpose** (see the `noindex` note below).

Core, framework-agnostic, from `canopycms/server`:

- `collectRoutableEntries(buildCtx, opts?)` — the same enumeration as `collectStaticPaths`, with
  each entry's `data` and `updatedAt` carried through instead of discarded.
- `extractSeoFields(entryData, opts?)` — entry data → a neutral
  `{ title, description, ogImage, ogType, canonical, noindex, twitterCard }`. Field names are
  configurable and default to the recommended group. **An empty or whitespace-only field counts
  as unset**, so a fallback wins — CanopyCMS writes optional fields present-but-empty, so an
  untouched SEO group is `metaTitle: ''` on disk, not an absent key.
- `isNoindexEntry(entryData, opts?)` — the single `noindex` predicate.
- `resolveSeoUrl` / `withTrailingSlash` / `isAbsoluteUrl` — URL shaping.

Schema, from `canopycms`:

- `defineSeoFieldGroup()` — the recommended seven-field group, matching `extractSeoFields`'s
  defaults, every field optional. Flat by default; `defineSeoFieldGroup({ group: 'seo' })` nests
  them under a key, and you then pass the same `{ group: 'seo' }` to the read side.

Next adapter, from `canopycms-next` (and bound on `createNextCanopyContext`'s result, so your
route modules never import the admin build context):

- `generateContentSitemap(buildCtx, { siteUrl, ... })` → `MetadataRoute.Sitemap`.
- `entryToMetadata(entryData, opts?)` → `Metadata` (title, description, openGraph, twitter,
  `alternates.canonical`, `robots`).

**Four behaviors worth knowing before you wire it up.**

1. **Every routable entry type is in the sitemap by default.** There is no allow-list to
   maintain; omission requires an explicit `exclude` predicate or a `noindex` flag. This is a
   direct response to a real production failure: a hand-rolled sitemap that enumerated only the
   entry types someone remembered to list shipped advertising a fraction of the site, with whole
   content types built as HTML and invisible to search engines. Nothing failed and nothing
   warned.

2. **The mirror failure: a type with no route.** "Every entry type by default" only holds if
   every entry type actually has a route serving its `urlPath` shape. An entry type meant for
   embedding elsewhere — content addressed by a `reference` field from inside a block, never
   visited directly — is schema-routable but has no page for it, so leaving it unexcluded
   advertises a URL that 404s. Tell the two apart the same way: does some route in your app
   actually serve that `urlPath` shape, not whether the schema happens to allow it. Exclude any
   entry type without one, same as the `author` exclusion below.

3. **`trailingSlash` is an explicit option, and it is not inferred.** CanopyCMS cannot see your
   framework's routing config, so it cannot know whether your site canonically serves `/contact/`
   or `/contact`. Pass `trailingSlash: true` to `generateContentSitemap` and `entryToMetadata` if
   your site serves trailing slashes. The same gap previously shipped a sitemap advertising URLs
   that redirected.

4. **`noindex` drives BOTH surfaces from one predicate** — `robots: { index: false }` on the
   page and exclusion from the sitemap. That is why these two helpers ship in one change:
   derived separately, an entry stayed advertised in one surface while correctly suppressed in
   the other. It does **not** affect enumeration: `generateContentStaticParams` still builds
   noindex entries, so their URLs resolve for anyone holding the link.

**`lastModified` — read this before trusting it.** It defaults to the entry's `updatedAt`, which
is the file's **filesystem mtime**, not an editorial timestamp. A fresh CI clone resets every
file's mtime to checkout time, so on a clean build agent the default dates every URL to the
moment the tree was cloned. Pass a `lastModified` callback returning a real content date if you
have one, or `undefined` to omit `<lastmod>` for that URL — an omitted date is better than a
wrong one.

**`robots.txt` is out of scope.** It is a few static lines with no CMS content behind it. Write
`app/robots.ts` yourself and point its `sitemap` field at your sitemap route.

**New way for a build to go red.** `generateContentSitemap` inherits `collectStaticPaths`'s
build-time schema-validity guard, so during a production build a schema-invalid entry (typically
an abandoned create-scaffold) now fails **sitemap generation** as well as static-params
generation. Same error, same fix — finish or delete the entry — but it is a new place the failure
can surface, including in an app that has no `generateStaticParams` at all.

**To adopt.**

```ts
// app/lib/canopy.ts — bind the sitemap helper once
export const contentSitemap = async (options: GenerateContentSitemapOptions) => {
  const context = await canopyContextPromise
  return context.generateContentSitemap(options)
}

// app/sitemap.ts
export const dynamic = 'force-static' // required for output: 'export'
export default () =>
  contentSitemap({
    siteUrl: SITE_URL,
    trailingSlash: true, // match your framework's routing config
    exclude: (entry) => entry.entryType === 'author', // types with no page of their own
  })

// app/posts/[slug]/page.tsx
import type { PostContent } from '../../schemas'

export const generateMetadata = async ({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> => {
  const { slug } = await params
  // The type argument matters: without it, `result.data` is `unknown` and
  // `result?.data.title` below fails to compile (`TS18046`).
  const result = await readByUrlPath<PostContent>(`/posts/${slug}`)
  return entryToMetadata(result?.data, {
    path: `/posts/${slug}`,
    siteUrl: SITE_URL,
    fallbackTitle: result?.data.title,
  })
}
```

Add `defineSeoFieldGroup()` to any schema whose entries should carry SEO fields. If you already
have an ad-hoc SEO group using different field names, either rename the fields to the defaults or
pass `{ fields: { title: 'yourName' } }` to the read side — do not keep both.

**Now deletable.**

- **A hand-rolled sitemap that enumerates a hardcoded list of entry types.** This is the pattern
  that produced the production bug above: a module holding a `ROUTABLE_ENTRY_TYPES`-style array,
  looping it, and mapping each type to a URL prefix. Replace it wholesale — the replacement has
  no list to forget to update. If you keep any of it, keep only the deliberate exclusions, now
  expressed as an `exclude` predicate.
- **A hand-written entry-data → `Metadata` mapper**, and any per-route copy of "meta title else
  page title else site name". The fallback convention now lives in one function; scattered copies
  are how two routes end up disagreeing about which title wins.
- **A local `withTrailingSlash` / `absoluteUrl` pair** used to shape canonical, sitemap and feed
  URLs. Watch for one specific bug while deleting: if your version normalized the path _before_
  checking whether it was absolute, it was turning an off-site canonical
  (`https://other.org/page`) into `<your-site>/https://other.org/page/`. The shipped
  `resolveSeoUrl` checks absolute first.
- **A build-time content walk that exists only to date sitemap URLs** — see the `updatedAt`
  entry above; `collectRoutableEntries` now carries it, with the same mtime caveat.
- **Nothing, for `robots.txt`.** It stays hand-written; that is deliberate, not an oversight.

#### Static-generation review follow-ups: siteUrl validation, one shared SEO field location, sitemap dedup

**What changed.** A static-generation review of the sitemap/SEO helpers above found four gaps
before they shipped to any adopter, all fixed here, plus one silent-content-loss gap one layer
below them:

1. **`generateContentSitemap`'s `siteUrl` is now validated.** A non-absolute value
   (`'example.com'`, or `''`) previously produced a `<loc>` with no scheme — invalid per the
   sitemap spec, and most search engines silently reject the **entire file**, not just that URL.
   It now throws, naming the value it received.
2. **`generateContentSitemap` and `entryToMetadata` can now share ONE SEO field location.** Each
   previously took its own `seo`/`fields`/`group` option independently — set it on one call and
   forget it on the other, and a `noindex` entry stayed advertised in the sitemap while its own
   page correctly said `robots: noindex`. Pass `seo` to `createNextCanopyContext` once and both
   bound helpers use it by default; a per-call override still wins for just that call.
3. **`withTrailingSlash` no longer appends the slash inside a query string or fragment.**
   `/blog?page=2` with `trailingSlash: true` used to become `/blog?page=2/`; it is now
   `/blog/?page=2`.
4. **`generateContentSitemap` dedupes colliding URLs and warns.** Two entries resolving to the
   same `<loc>` — an index entry collapsing onto a sibling's path, or two `urlPath`s that only
   differ by case — used to appear twice, verbatim. The first is now kept, the rest dropped, with
   a warning naming the collision.
5. **A content file CanopyCMS can't parse into an entry now fails a production build**, the same
   way a schema-invalid entry already did. Previously it was dropped from `listEntries` — and
   therefore from every surface built on it, including static params and the sitemap — with
   **zero build output** unless `CANOPYCMS_DEBUG=true`. The realistic trigger is a schema rename
   that left a stale file behind, or an entry type declared in one collection but not another.
   `next dev` and the admin UI are unaffected; only an actual `next build` throws.

**To adopt.** If you already pass `seo`/`fields`/`group` identically to both
`generateContentSitemap` and `entryToMetadata`, move it to `createNextCanopyContext({ seo })` and
drop the per-call copies. Otherwise nothing changes — `siteUrl` was already documented as
required-absolute, `trailingSlash` was already documented to handle a query string (it just had a
placement bug), and the dedup/build-failure behaviors only fire on inputs that were already wrong
(a bad `siteUrl`, a colliding URL, an unparseable content file).

**Now deletable.** A local workaround that repeats the SEO field location on every call site to
keep the two surfaces in sync by hand — the shared `seo` option replaces the discipline of
remembering to update both.

#### The build guard now ignores files that were never entry-shaped

**What changed.** Item 5 above (the content-entry build guard) turned out to be too broad: it
fired on _any_ file inside a collection directory that shared a recognized content extension but
failed to parse as `{type}.{slug}.{id}.{ext}` — including a file that was never meant to be an
entry at all. The most concrete case: a colocated sibling artifact read via an `entryTransforms`
`readSibling(...)` call (see the AI-content-generation section of this README), named
`{contentId}.suffix.ext` per that convention. Dropping one of those next to its entry used to red
a production build for using a documented feature.

The guard now only fires on a file that structurally _could_ have parsed as an entry: 4 or more
dot-separated segments (matching the four grammar positions `type`, `slug`, `id`, `ext`), OR
exactly 3 segments whose first segment names a real entry type in that collection. A file with
fewer segments — or a 3-segment file whose first segment ISN'T a known entry type — could never
have matched the grammar regardless of its content, so it isn't this guard's failure mode — it's
silently skipped, same as before this guard existed. Concretely: a bare `README.md` (2 segments)
and an `{contentId}.suffix.ext` sibling artifact (3 segments, e.g. `5NVkkrB1MJUv.profile.json`,
whose first segment is a content ID, never a configured entry type) both build clean. A file that
still looks like an attempted entry — wrong type, invalid ID, genuinely 4+ segments, or a real
entry type name with no ID at all (`post.hello-world.md`, the likeliest real accident: a hand
edit or a bad rename that dropped the ID segment entirely) — still fails the build with an error
naming the file. Dot-prefixed and underscore-prefixed filenames are now always skipped outright,
regardless of segment count, on the theory that both are established "not an entry" conventions
(hidden/editor-swap files, and an adopter's own draft/private-file marker respectively).

_Correction, same release:_ the first version of this narrowing only checked segment count, which
missed the 3-segment ID-loss case above — a lost-ID file built clean with the page silently gone,
the exact failure this guard exists to prevent. Fixed before this reached a tagged release, so
there is nothing to migrate away from; noted here because the "now deletable" entry below still
applies unchanged.

The thrown error message is also more actionable: when a file trips the guard, it now suggests
that a colocated sibling artifact accidentally landed in 4+ segment territory and names the
convention (keep sibling filenames to `id.suffix.ext`, three segments, to stay clearly out of
entry-shaped territory) as one way to resolve it.

**To adopt.** Nothing required. If you previously moved a sibling artifact outside its
collection directory, or renamed it to dodge the old overly-broad guard, you can move or rename
it back — `readSibling` only ever looked inside the collection directory next to the entry to
begin with, so relocating it may have silently broken the `entryTransforms` call that reads it.

**Now deletable.** Any workaround that relocated or renamed a colocated sibling artifact solely
to avoid tripping the build guard.

#### `canopycms init` scaffolds `defaultBranchAccess: 'deny'` and public read by default

**What changed.** The generated `canopycms.config.ts.template` used to write
`defaultBranchAccess: 'allow'`, which no longer matches the package's fail-closed schema default
(`'deny'`) — a freshly scaffolded project silently ran with a WIDER access posture than the
package itself considers safe, purely because the generator hadn't been updated alongside the
schema. That divergence is now closed: the template scaffolds `defaultBranchAccess: 'deny'`,
matching the schema.

Flipping the branch default alone would have made `canopycms init` -> `npm run dev` 403 every
route for the developer running it, including the dev-auth default user — because
`defaultPathAccess` (a separate layer; both must allow a read) has its own fail-closed default
and the template previously relied on the branch layer's now-corrected `'allow'` to paper over
it. So the template also now scaffolds `defaultPathAccess: { read: 'allow' }` — public read,
with edit and review still closed — the posture [README's "Public read on server
deployments"](../README.md#public-read-on-server-deployments) section recommends and
`apps/example1`'s own config already uses. This is not a security walk-back: only `read` opens,
and it opens on the PATH layer only — the branch layer still defaults closed, and an anonymous
request must still pass both layers.

**To adopt.** If you scaffolded your project before this change and never wrote
`defaultBranchAccess`/`defaultPathAccess` yourself, your config still says whatever it said —
this only changes what NEW `canopycms init` runs write, not existing files. Two cases to check
in your own `canopycms.config.ts`:

- You relied on the old scaffold's `defaultBranchAccess: 'allow'` and never overrode it: you were
  already running wider-than-recommended branch access; consider tightening to `'deny'`
  (creators and the base branch still resolve, so this is rarely a functional lockout — see the
  key's own doc comment for what stays reachable).
- You copied the scaffold, kept `defaultPathAccess: { read: 'allow' }`, and later deleted that
  line thinking it was just an example: you have silently inherited the fully closed default on
  every path level, including `read` — anonymous/public routes will 403 until you restore it (or
  deliberately want that closed posture).

**Now deletable.** Nothing — this only affects newly generated files.

#### `parseTypedFilename` exported from `canopycms/server` (#1)

**What changed.** `parseTypedFilename` — parses a content filename
`{type}.{slug}.{id}.{ext}` into `{ type, slug, id }` — existed in `content-listing.ts`
but was never re-exported, so no adopter could import it, despite four hand-rolled
copies of the same parsing logic existing across the two sites. It's now exported from
`canopycms/server`, with a JSDoc block documenting the filename grammar in full.

Its `entryTypes` second argument (used internally to validate the parsed `type` against
a collection's configured entry types) is now **optional**. Omit it to parse the
`{type}.{slug}.{id}.{ext}` shape structurally without validating `type` against a known
list — this matches what all four existing hand-rolled copies actually do, since none
of them have an entry-types list in hand at the point they parse a filename. Internal
callers that already pass `entryTypes` are unaffected; behavior is byte-identical when
the argument is supplied.

**To adopt.**

```ts
import { parseTypedFilename } from 'canopycms/server'

const parsed = parseTypedFilename('post.hello-world.vh2WdhwAFiSL.md')
// { type: 'post', slug: 'hello-world', id: 'vh2WdhwAFiSL' }
```

IDs are 12-character Base58, excluding the ambiguous characters `0 O I l`.
`parseTypedFilename` returns `null` for a filename whose ID segment fails that check,
even when the rest of the shape looks right.

**Now deletable.**

Every hand-rolled copy of this parsing. Search your tree for `.split('.')` or
`lastIndexOf('.')` applied to a content filename — across two audited adopter repos
there were four such copies, and **they disagreed with each other**: different segment
counts, and one lowercased the slug while another did not. Two of them backed a
link-integrity check, so the drift silently narrowed what that check actually covered.

Typical homes for a copy:

- A test or script that validates content links or checks for slug collisions.
- A build-time module that walks the content root (which this change plus the
  `updatedAt` entry below usually delete entirely).
- A helper that recovers an entry's type or ID from a path — superseded more completely
  by the `meta.entryType` entry below, which removes the need to parse at all.
- Route-level `{type}.{slug}.{id}` hand-splits.

#### `defaultBuildPath` exported from `canopycms/server` (#2)

**What changed.** `buildContentTree`'s default URL path builder (strip the content
root prefix, collapse an entry's `index` slug to its parent collection path, lowercase)
was a module-private function in `content-tree.ts`. Extending it — rather than
replacing it outright via the `buildPath` option — required reimplementing it from
scratch. It's now exported as `defaultBuildPath` from `canopycms/server`, and the
`buildPath` option's JSDoc documents the default's exact behavior instead of requiring
a source read.

**To adopt.**

```ts
import { defaultBuildPath } from 'canopycms/server'

canopy.buildContentTree({
  buildPath: (logicalPath, kind) => {
    const base = defaultBuildPath(logicalPath, 'content', kind)
    return kind === 'entry' ? someTransform(base) : base
  },
})
```

`buildPath` still fully replaces the default when supplied — it is not automatically
composed with it. Call `defaultBuildPath` yourself inside your `buildPath` to build on
top of it instead of reimplementing it.

**Now deletable.**

- Any verbatim reimplementation of the default path builder passed as a custom
  `buildPath`. A real adopter had copied it exactly — strip-content-root, collapse
  `index`, lowercase — which silently forks URL derivation the moment the package
  default changes. Replace with a call to `defaultBuildPath`, or drop the custom
  `buildPath` entirely if you were not actually extending the default.

#### `read()` / `readByUrlPath()` return `meta.entryType` and `meta.entryId` (#3, `.claude/future-tasks/resolved/readbyurlpath-entry-type.md`)

**What changed.** `CanopyContext.read()` and `.readByUrlPath()` now include
`entryType: string` and `entryId?: ContentId` on the returned `meta`, alongside the
existing `meta.physicalPath`. Both were already resolved internally during path
resolution — this is plumbing, not new derivation. `entryId` is optional: it's
`undefined` only for legacy entry files that predate embedded-ID filenames
(`{slug}.{ext}` rather than `{type}.{slug}.{id}.{ext}`); `entryType` is always
populated.

**Read this before branching routing logic on `entryType`.** "Always populated" does
not mean "always accurate." The entry type is read from the resolved file's own
filename, not re-validated against the collection's current schema on every read:

- **For a legacy file, `entryType` is a guess, not a read.** A legacy filename
  (`{slug}.{ext}`) carries no type at all, so `entryType` silently falls back to the
  collection's _default_ entry type — which may or may not be what the file actually
  is. **`entryId === undefined` is the signal that this happened**: whenever `entryId`
  is `undefined`, treat `entryType` as inferred rather than read.
- **It is usually, but not guaranteed to be, a key in the collection's `entries`
  config.** Because the type is read from the filename and not re-checked, it can
  diverge if an entry type was renamed or removed from the schema after files using
  the old name were created, or if a file was hand-authored with a type token that was
  never a real entry type. Do not assume `result.meta.entryType` is safe to look up in
  your schema's `entries` array without a fallback case.

**To adopt.**

```ts
const result = await canopy.readByUrlPath(urlPath)
if (result) {
  switch (result.meta.entryType) {
    case 'home':
      return <HomePage data={result.data} />
    case 'partner':
      return <PartnerPage data={result.data} />
    default:
      return <DocView data={result.data} />
  }
}
```

Purely additive — no change to the input side of either function.

**Now deletable.**

- Any helper that recovers the entry type by parsing `meta.physicalPath` — typically a
  one-liner splitting the filename on `.` and taking the first segment.
  `meta.entryType` replaces it outright.
- Any matching re-derivation of the entry ID from `meta.physicalPath` — replaced by
  `meta.entryId`.
- Guard-and-delegate blocks in routes that exist only because the read result carried
  no entry type — the shape is a route that must re-check "is this actually the type I
  handle?" before rendering, because a different type resolves at the same URL depth.
  Each collapses to a `switch` on `result.meta.entryType`, often letting several
  near-duplicate route files become one catch-all.

#### Build-context factory, title derivation, and a Markdown-to-plaintext primitive (#17)

**What changed.** An adopter asked for a single `extractSearchDocuments(registry, opts)`
helper so two sites building their own search indexes could share one implementation.
Comparing both real derivations found they share essentially nothing at that level —
one walks page sections against a large structural-key denylist, the other has
domain-specific handling for its own entity types. A generic extractor would have to
guess which keys are prose, and guessing wrong silently omits content from a search
index — the same silent-divergence failure the request was trying to escape, just
moved somewhere adopters can't see it. **That helper is not being built.**

What genuinely was duplicated — byte-similar across both sites — was the plumbing
_around_ the derivation, not the derivation itself. Three primitives now cover that:

- **`createBuildCanopy(config, options)`**, from `canopycms/server`. A one-call factory
  for a **build/admin** Canopy context — `createCanopyServices` + `createCanopyContext`
  - a synthetic admin user, wired the same way `createNextCanopyContext(...)`'s own
    `getCanopyForBuild()` does it internally, minus the Next.js pieces. For standalone
    scripts that run entirely outside a Next.js request or build phase: index builders,
    content audits, codegen, ad hoc reports. It bypasses all branch/path ACLs — do not use
    it in request-handling code.
- **`resolveEntryTitle(data, options)`**, from `canopycms/server` and the root
  `canopycms` entry (it has no runtime dependencies beyond type-only imports, so it's
  client-safe too). Resolves a display title through the fallback chain: a
  schema-marked `isTitle` field, then `data.title`/`data.name`, then an entry-type
  label, then a humanized slug, then `"Untitled"`.
- **`toPlainText(markdown)`**, from `canopycms/ai`. Converts MDX/Markdown body content
  to plain prose text: strips frontmatter, JSX tags and JSX expressions, and Markdown
  syntax (headings, emphasis, list/blockquote markers, thematic breaks); unwraps code
  fences and inline code to their bare content; keeps link and image text while
  dropping the URL. The reason this one is worth shipping: **a paired custom component
  loses only its tags, never its contents.** A hand-rolled stripper that treats
  `<Callout>...</Callout>`-shaped markup as one opaque unit and deletes it wholesale
  silently drops every word inside it from the search index — a real bug found in one
  adopter's hand-rolled version, invisible until someone searches for a phrase that
  only ever appeared inside a callout, a steps block, or an FAQ component.

**To adopt.**

```ts
// A standalone script — index builder, content audit, codegen — run with tsx/node,
// never imported by Next.js.
import { createBuildCanopy, resolveEntryTitle } from 'canopycms/server'
import { toPlainText } from 'canopycms/ai'
import config from '../canopycms.config'
import { entrySchemaRegistry } from '../src/schemas'

const canopy = await createBuildCanopy(config.server, { entrySchemaRegistry })
const entries = await canopy.listEntries()

for (const entry of entries) {
  const title = resolveEntryTitle(entry.data, { schema: entry.schema })
  const body = typeof entry.data.body === 'string' ? toPlainText(entry.data.body) : ''
  // ...build your search document however your site actually needs it
}
```

Because the boot sequence is now one function call over a plain config object, a script
built this way can be imported and exercised from a test — unlike a hand-rolled
top-level-`await` boot block, which can never be imported by anything.

**Now deletable.**

- **The hand-rolled boot block.** Any standalone script that manually calls
  `createCanopyServices` + `createCanopyContext` + builds its own synthetic
  admin-user object to get a filesystem-direct read context. Replace with one
  `createBuildCanopy` call.
- **A hand-rolled title-fallback chain.** Any `data.title ?? data.name ?? humanize(slug)
?? 'Untitled'`-shaped helper, especially one that does _not_ also check for a
  schema-marked title field — that's a second, weaker implementation of the same
  fallback chain `resolveEntryTitle` already provides.
- **A hand-rolled Markdown/MDX-to-plaintext stripper**, especially one that deletes a
  matched custom component's entire span (tags and children together) rather than
  keeping the children's text. If your search results are missing content that you can
  see is present in the source file, this is the pattern to look for.

#### `listEntries` carries `updatedAt` (#4)

**What changed.** `listCollectionEntries` already ran an unconditional `fs.stat` on
every entry file and set `updatedAt` on its `CollectionListItem` result; `listEntries`
was discarding it when building `ListEntriesItem`. It's now carried through:
`ListEntriesItem.updatedAt?: string` (ISO 8601), populated on every result.

**Caveat — read before wiring this to `<lastmod>`.** `updatedAt` is the file's
filesystem mtime, **not** an editorial "last changed" timestamp. A fresh CI clone (or a
fresh EFS/branch-clone checkout) resets every file's mtime to checkout time, so in that
environment `updatedAt` reflects "when the branch was last checked out," not "when the
content was last edited." Treat it as "changed since the last build" at best — do not
present it as an authoritative sitemap `<lastmod>`. Sourcing mtime from git commit
history instead is a real gap this does not close; it's a separate, not-yet-built task.

**To adopt.** No signature change — `entries[i].updatedAt` is populated automatically
wherever `listEntries` is already called.

**Now deletable.**

- Any build-time module that walks the content root with `node:fs` to collect file
  mtimes. One adopter had ~75 lines of directory walking plus a second copy of
  filename parsing for exactly this. Read `updatedAt` off the `listEntries` item
  instead — and note that deleting such a module usually removes a duplicate filename
  parser too (see the `parseTypedFilename` entry above).

#### `BlockValueOf` / `BlockComponentRegistry` — exhaustive block → component types (#13)

**What changed.** Two new exported types, `BlockValueOf<Blocks, N>` and
`BlockComponentRegistry<Blocks, ExtraProps>`, make a block-field → React-component
mapping exhaustive **at compile time**. `Blocks` is a block field's own discriminated
union (as already derived by `TypeFromEntrySchema`); `BlockComponentRegistry` requires
exactly one component per template name — no more, no fewer, when the registry is written
as an object literal (TypeScript's excess-property check, which catches a stray key, is
literal-only; the missing-key direction holds regardless). Deliberately shipped as
types, not a `renderBlocks()` runtime helper: a helper would have to pick a key
strategy, an unknown-template policy, and how extra props reach each component, and any
one of those choices is wrong for someone. See the README's "Block Component
Registries" section for the full recipe, including the one contained type assertion the
dispatch loop needs (TypeScript can't correlate a dynamic key lookup with a
discriminated union's narrowing on its own — the registry's exhaustiveness is what
makes that assertion safe to write once). `apps/example1/app/components/PostView.tsx`
in this repo now uses the pattern end-to-end as a worked example.

**To adopt.**

```ts
import type { BlockComponentRegistry } from 'canopycms'

type Blocks = Page['blocks'][number]

const blockRegistry: BlockComponentRegistry<Blocks> = {
  hero: ({ data }) => <HeroSection headline={data.headline} />,
  cta: ({ data }) => <CtaSection title={data.title} />,
  // Missing a key here, or a key that doesn't match a template name, is a compile error.
}
```

Purely additive — no existing API changes.

**Now deletable.**

- A `switch (block.template) { ... default: return null }` (or `default: return
<UnknownBlock />`) over block templates. That `default` case is exactly the failure
  mode this replaces: renaming or removing a template in the schema falls through it
  silently — green build, green tests, a page section that renders nothing. Replace the
  switch with a `BlockComponentRegistry`; the equivalent drift is now a compile error
  instead of a runtime no-op.
- A hand-written test asserting "the schema's declared block templates match the
  handled set" in both directions. That test exists to catch exactly the drift a
  `BlockComponentRegistry` now catches at compile time — the runtime guard becomes
  redundant once the registry is in place.

#### Reusable field fragments — documented, plus `defineFieldFragment()` (#15)

**What changed.** No new runtime behavior — this closes a documentation gap. Two
patterns for sharing a field cluster across schemas already worked and now have a
README section ("Reusable Field Fragments," under Page Blocks): spreading a
`const`-inferred field array into multiple schemas' `fields` (both `defineEntrySchema`
and `defineBlockTemplate` already infer literal types from a `const` array regardless
of where it came from), and nesting `defineInlineFieldGroup()` inside a block template
(inline groups are transparent at every layer — type inference, data storage,
validation, reference resolution, and the editor). A new 3-line
`defineFieldFragment()` identity helper sits beside `defineBlockTemplate` purely for
discoverability; a plain `const fields = [...] as const` spread works identically
without it.

**To adopt.**

```ts
import { defineFieldFragment, defineEntrySchema } from 'canopycms'

const ctaFields = defineFieldFragment([
  { name: 'ctaLabel', type: 'string' },
  { name: 'ctaHref', type: 'string' },
])

const heroSchema = defineEntrySchema([{ name: 'headline', type: 'string' }, ...ctaFields])
const bannerSchema = defineEntrySchema([{ name: 'message', type: 'string' }, ...ctaFields])
```

For a per-use override (one schema needs a different `required` or `label` on one field
of the shared cluster), don't spread that one field — compose from the same underlying
`const` field object and override just the key that differs. See the README section for
the full example.

**Now deletable.**

- A field cluster spelled out identically across several schemas by hand. In one
  audited real-world schema, the same field cluster was retyped eight times and a
  preview-object cluster three times — and the copies had already drifted apart on a
  `select` field's option list, invisibly, because nothing forced them to stay in sync.
  Collapse the copies into one `defineFieldFragment()` (or plain `const` array) and
  spread it everywhere it's used; for schemas that need one field to differ, override
  just that field per the pattern above instead of retyping the whole cluster.

#### Shared/referenced blocks: documented recipe, plus a `listEntries` caveat (#16)

**What changed.** No new runtime behavior. A block template can already hold a
`reference` field pointing at another entry — so a "shared content block" (a call to
action, a promo card, anything reused verbatim across pages) is just a small entry type
plus a one-field block template, and `read()`/`readByUrlPath()` already resolve the
reference before your code sees it. This now has a README recipe ("Shared / Referenced
Blocks," under Page Blocks) with a worked example, plus one shared reference wired into
`apps/example1/app/schemas.ts` in this repo.

**The caveat, documented prominently in both places it applies:** `listEntries()` reads
content files raw off disk and never resolves `reference` fields — inside a block
template or anywhere else. A surface built from `listEntries()` (a search index, a
sitemap, an AI-content export) sees a shared block's reference as `null` or a bare id
string, never the referenced entry's data.

**To adopt.**

```ts
const ctaSnippetSchema = defineEntrySchema([
  { name: 'title', type: 'string' },
  { name: 'ctaText', type: 'string' },
])

const sharedCtaBlock = defineBlockTemplate({
  name: 'sharedCta',
  fields: [
    {
      name: 'snippet',
      type: 'reference',
      entryTypes: ['ctaSnippet'],
      resolvedSchema: ctaSnippetSchema,
    },
  ],
})
```

**Now deletable.**

- A hand-rolled second `read()` call scattered through page code to "unwrap" a shared
  block's reference field, if you built one before this was documented — the resolution
  already happens automatically inside `read()`/`readByUrlPath()`, including inside
  block templates. Nothing to build; delete the workaround, keep the field.
- Nothing yet where `listEntries()` is the surface — the caveat above is a real gap,
  not a superseded workaround. If you have a search index or sitemap built over
  `listEntries()` output and it includes pages with shared blocks, those blocks are
  silently empty there today; resolve them with a follow-up `read()` call, or build
  that surface from `read()`/`readByUrlPath()` results instead.

#### `checkPathAccess` removed from `CanopyServices`

**What changed.** The `CanopyServices` interface (reachable via `context.services` from
`getCanopy()`/`createBuildCanopy()`) no longer exposes `checkPathAccess`. It was bound
at service-creation time with an empty rule set — path permissions are loaded from the
settings branch per request, not known that early — so any call through it always fell
through to the default path-access decision, never a real per-path rule. Content and
branch access checks (`checkContentAccess`, `checkBranchAccess`,
`createContentAccessChecker`) are unaffected; they load rules from the right place per
call and remain on `CanopyServices`.

**To adopt.** Nothing, unless you called `context.services.checkPathAccess` directly.
If you did, it was never evaluating your actual path-permission rules — replace it with
`context.services.createContentAccessChecker(...)`, which resolves the real rule set
(from the settings branch) once and returns a synchronous per-path checker.

**Now deletable.** Nothing new — an adopter integration would not have built anything
around this, since it never returned a real answer to begin with.

### 0.0.62 and earlier

Not retro-documented. Two things adopters upgrading from an older pin should know,
because both bit a real site:

- **`rich-text` was removed** (breaking, commit `d414920e`). It was an undocumented
  alias for `markdown` and was used by no adopter, example or fixture. If you have a
  `type: 'rich-text'` field, change it to `type: 'markdown'`.
- **Content IDs are 12-character Base58** and exclude the ambiguous characters
  `0 O I l`. A hand-rolled ID containing one of those is silently ignored — the entry
  never loads and nothing warns. Use `generateId()` from `canopycms/server`; never
  hand-roll an ID.
