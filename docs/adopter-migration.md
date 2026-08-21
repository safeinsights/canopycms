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
