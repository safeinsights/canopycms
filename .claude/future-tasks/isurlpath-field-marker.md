# isUrlPath field marker — route entries by a schema field value (SHELVED)

**Status:** Shelved 2026-05-31. Designed in full (below); not implemented. Revisit when a real decoupled/vanity/multi-segment URL need appears. **Priority: P2.**

**Why shelved:** The only requester (the `safeinsights/website` adopter) no longer needs it. Their need is single-segment, slug-equals-URL pages (`/privacy`, `/solutions`, …), which the **root-collection restructure** (below) satisfies natively with zero new package code. `isUrlPath` only earns its keep for the strictly broader class the restructure can't do — so we defer it (YAGNI) rather than add surface area now. This is right-sizing, not a shortcut: the restructure is the correct native solution for slug-equals-URL.

---

## Problem / motivation

Adopters want to **control an entry's routable URL independent of where its file lives** — e.g. pages stored in one `pages` collection (`content/pages.<id>/`) but served at root URLs like `/privacy`, `/solutions`. Use cases: vanity URLs (URL ≠ slug), flat marketing pages inside a named collection, URL stability across file/slug moves, legacy URL parity.

As of 0.0.41 the routing helpers are **purely structural** — they compute the URL from the filesystem path and never read entry field data — so a `pages` entry routes to `/pages/<slug>` and `readByUrlPath('/solutions')` returns `null`.

### Verified root cause (with file:line)

Four structural computations, none reads `entry.data`:
- `content-listing.ts:237-239` (`listEntries`) — `urlPath` from `entry.logicalPath`/`slug`.
- `content-tree.ts:110-128` (`buildContentTree` → `defaultBuildPath`) — a **second**, parallel structural URL computation (nav/sitemap/editor tree).
- `static/index.ts:54-66` (`collectStaticPaths`) — maps `StaticPathEntry` from `entry.urlPath`; its `filter` callback only sees `StaticPathEntry` (no `data`), so adopters can't post-map by a field.
- `context.ts:169-200` (`readByUrlPath`) → `url-path-resolver.ts` `resolveUrlPathCandidates` — structural candidates only.

Adopter proposal that prompted this: `safeinsights/website/docs/canopycms-proposal-isurlpath.md` (proposed an in-memory `Map<urlPath,entry>` index; we rejected the index in favor of a scan — see decisions).

---

## The alternative that dissolved the need: root-collection restructure

The content **root is itself a first-class collection** (`flatten.ts:122-157` pushes it with `entries: root.entries`, `ROOT_COLLECTION_ID`, no parent). So a root-collection entry `content/page.solutions.<id>.yaml` → logicalPath `solutions` → structural `urlPath` **`/solutions`** (no collection-directory segment to strip). Therefore, for **single-segment, slug-equals-URL** pages, just declare the routable `page`/`landing` types on the **root** collection (alongside `site`/`home` singletons) and use native `readByUrlPath` + `contentStaticParams` (filtered by `entryType`). No custom field, no `isUrlPath`.

**Verified this is supported today:**
- Root = normal collection; **no special-casing** (`flatten.ts:122-157`). Existing precedent: `apps/test-app/content/.collection.json` already declares **two** entry types on root (`home` + `settings`, both `maxItems:1`), with a test in `api/entries.test.ts`.
- Editor handles multiple types per collection: `EntryCreateModal.tsx:137-152` shows a type picker when `>1` type (honors `default:true`); the sidebar/tree renders mixed types fine.
- `StaticPathEntry.entryType` exists, and `collectStaticPaths`/`ListEntriesOptions.filter` receive it ⇒ `contentStaticParams({ filter: e => ['page','landing'].includes(e.entryType) })` keeps singletons out of generation.
- **No** collection-level url-prefix/basePath config exists (checked `CollectionConfig` and `CanopyConfig` in `config/types.ts`). The structural `urlPath` always includes the collection dir segment; the only ways to drop it are root-collection or `isUrlPath`. (`canopycms-next` `basePath` is a route-side prefix, the inverse; `config.entryLinkUrl` only customizes entry-*link* rendering, not routing.)

### Restructure trade-offs / latent gaps it leans on (real, but acceptable for a small static marketing site)
- **URL = slug, single-segment only.** No vanity URLs (URL ≠ slug); no multi-segment paths for root pages (a future blog is its own `blog` collection → `/blog/<post>`). Renaming a slug changes the URL.
- ~~**`maxItems` is metadata-only — NOT enforced.** No check in `content-store.ts` `write()` or `api/content.ts`; no editor disable.~~ **STALE — corrected 2026-08-13.** `maxItems` **is** enforced server-side at the create boundary: `api/content.ts:360-373` (marked `SCH-H3`), landed in `e4097b0e` (PR #106, July 2026 baseline-review fix phase) — after this file was shelved on 2026-05-31. So `site`/`home` singletons are genuinely capped and this is no longer a latent gap. No task file was ever needed.
- **Singletons are routable.** `readByUrlPath('/home')` structurally resolves the `home` entry, and `readByUrlPath` has **no** `entryType` filter. **STALE — corrected 2026-08-14.** Its return now carries `meta.entryType` to post-filter on (see resolved: [readbyurlpath-entry-type.md](resolved/readbyurlpath-entry-type.md)). Harmless for static export (filter `contentStaticParams` by `entryType` ⇒ `/home`,`/site` simply aren't generated ⇒ 404 in static hosting), but bites under SSR/server mode unless the caller now applies that filter itself. **Second correction — 2026-08-21.** `apps/example1` now models its home singleton as a root `index` entry (`home.index.<id>.json`), so its advertised URL is `/`, and that is the recommended shape for any singleton served at a collection's own path. **This bullet's concern is NOT removed, and an earlier revision of this correction wrongly claimed it was.** Verified against a real `ContentStore`: `readByUrlPath('/home')` still resolves the entry, because the index-fallback candidate `{entryPath: 'content/home', slug: 'index'}` hits the registered entry-TYPE item `content/home`, which `buildPaths` delegates to the parent collection. So the singleton answers at BOTH `/` and `/home` — the entry-type name remains routable, exactly as this bullet warns. **Third correction — 2026-08-22, and this time the concern IS removed.** `readByUrlPath('/home')` returns `null`: a read by published URL now requires every candidate's `entryPath` to be a collection, and `content/home` is an entry-TYPE item (`ReadContentInput.urlAddressableOnly`, `ContentStore.isCollectionPath`). Closed in [resolved/readbyurlpath-entry-type-candidate-phantom-url.md](resolved/readbyurlpath-entry-type-candidate-phantom-url.md). Note what this bullet was RIGHT about and what stays true: `readByUrlPath` still has no `entryType` filter, and `read({ entryPath: 'content/home' })` still resolves the singleton structurally — the narrowing is to URL addressing only. What is gone is the need for a caller-side filter to hide a URL nothing published.

### When to revisit `isUrlPath` (triggers)
Build it when an adopter genuinely needs any of: **vanity URLs** (URL ≠ slug), **multi-segment URLs decoupled from file layout**, **URL stability across slug/file moves**, or **keeping pages in a named/organized collection while still routing at root**. Until then, root-collection covers it.

---

## Full proposed design (ready to implement when revived)

Mirrors the existing `isTitle` / `isBody` field-marker infrastructure exactly.

### Design principles
1. **Structural default (unchanged).** No `isUrlPath` field, or an empty value ⇒ URL is the structural file-path URL exactly as today. The field only *overrides*.
2. **Single source of truth.** One shared helper `resolveEntryUrlPath(schema, data)` feeds **both** structural computations (`listEntries` *and* `buildContentTree`) so routing, static params, nav, sitemaps, and the editor tree never drift.
3. **Unified collision namespace.** A collision is any two routable entries with the same final `urlPath` — field-vs-field **or** field-vs-structural-default (e.g. field `/solutions` vs a top-level `solutions` entry). Error, not last-wins. Gated on ≥1 field-based member so we never newly break pre-existing pure-structural setups.
4. **Scan, not index.** Resolution and collision checks enumerate live content via existing `listEntries` — **no persistent `urlPath→entry` index** (avoids the index-staleness pain documented in `index-staleness-multiprocess.md`; collections are small/medium). Optimize later only if scans prove slow.
5. **Branch-aware.** The resolution scan honors `options.branch`, matching the structural phase, so dev-preview reflects editor Saves on the active branch. (DECIDED.)
6. **Layered validation = core + editor-time** (DECIDED):
   - Registry build — at-most-one, must be `string` (mirrors `isTitle`/`isBody`).
   - Content-load / build / resolution — unified uniqueness safety net (catches collisions from direct file edits / git merges at build, at `readByUrlPath`, and in dev).
   - Editor-time — block collisions interactively on **Save** (urlPath field) and **slug Rename** (a plain entry renamed onto another entry's URL).

### Confirmed decisions
- Branch-aware phase-2 scan (per-branch memoized schema context).
- Validation scope = core **plus** editor-time (Save + Rename), not load-time-only.
- Scan over persistent index.
- Unified field+structural collision namespace, error gated on ≥1 field-based.
- Empty value ⇒ structural fallback + build warning (partial migration still routes).
- `isUrlPath` value is the **full, absolute URL**; basePath interaction documented, deep handling deferred.

### Changes by area

**A. The marker (3 additions)**
- `config/types.ts` — `isUrlPath?: boolean` on `BaseFieldConfig` (after `isBody`, ~74) + doc comment.
- `config/schemas/field.ts` — `isUrlPath: z.boolean().optional()` on `fieldBaseSchema` (~18).
- `entry-schema.ts` — `isUrlPath?: boolean` on `InferableField` (~8). **Required** (else `defineEntrySchema` literals with `isUrlPath:true` fail excess-property checks — same reason `isTitle`/`isBody` are listed there).

**B. New `utils/url-path-field.ts` (pure, no fs — mirror `body-field.ts`; top-level only, inline groups flattened)**
- `countUrlPathFields`, `findUrlPathFieldName`, `findInvalidUrlPathFields` (count / name / non-string) — for registry validation.
- `schemaDeclaresUrlPath(fields): boolean` — cheap guard.
- `normalizeUrlPathValue(value): string | undefined` — trim; empty ⇒ undefined; else lowercase, single leading `/`, strip trailing `/` (keep `/` for root). Matches `content-listing.ts:239` so both sides compare equal (`Solutions`, `/solutions/` ⇒ `/solutions`).
- `resolveEntryUrlPath(fields, data): string | undefined` — normalized field value, or undefined if no marker / empty.
- `assertUniqueUrlPaths(entries)` — pure global check over `{urlPath, urlPathSource, entryPath}[]`; throws naming colliders when a `urlPath` is shared by ≥2 entries **and** the group has ≥1 `urlPathSource==='field'`. Used at build/resolution.
- `findUrlPathConflict(entries, candidate, excludeEntryId)` — surgical lookup for editor-time checks.

**C. Registry validation — `entry-schema-registry.ts`** (after the `isBody` block ~98, mirror it, reuse `findFieldType`): `countUrlPathFields > 1` ⇒ "at most one"; `findInvalidUrlPathFields` ⇒ "isUrlPath is only valid on string fields".

**D. Field-sourced URL — shared across BOTH computations**
- `content-listing.ts` `listEntries` (loop ~229-264): look up the entry-type config via `collection.entries.find(e => e.name === entry.entryType)` (`.schema` is resolved `FieldConfig[]` — proven by `findBodyFieldName(entryType.schema)` at :378); `urlPath = resolveEntryUrlPath(schema, entry.data) ?? structuralUrlPath`. Add `urlPathSource: 'field'|'structural'` to `ListEntriesItem`. Schema declares `isUrlPath` but value empty ⇒ `log.warn` + structural fallback.
- `content-tree.ts` `buildEntryNode`: thread the collection's `entries` in; `node.path = resolveEntryUrlPath(schema, entry.data) ?? buildPath(entry.logicalPath, 'entry')` (field value authoritative even with a custom `buildPath` — document).
- `static/index.ts` `collectStaticPaths`: unchanged mapping ⇒ field-sourced for free; add the build-time `assertUniqueUrlPaths(items)` here (earliest/loudest for static export).

**E. Two-phase, branch-aware `readByUrlPath` — `context.ts`**
- Replace the single `schemaContextPromise` (:203) with a `Map<string, Promise<…>>` keyed by branch; `resolveSchemaContextImpl(branchName)`; `resolveSchemaContext(branch?)` keys on `branch ?? defaultBranch`; define it **before** `readByUrlPath`. `listEntries`/`buildContentTree` keep calling it with no arg.
- `readByUrlPath`: **Phase 1** unchanged (structural candidates). **Phase 2** (replace final `return null`): resolve schema context for `branch`; **skip guard** — if no entry type in `flatSchema` declares `isUrlPath` (`schemaDeclaresUrlPath`) ⇒ `return null` (zero overhead for non-adopters); `target = normalizeUrlPathValue(urlPath)`; `items = listEntriesImpl(...)`; **surgical** `matches = items.filter(i => i.urlPath === target)` — `>1` ⇒ throw ambiguous-urlPath naming them; `1` ⇒ re-read via `read({entryPath: match.collectionPath, slug: match.slug, branch, resolveReferences})` (ACL + reference parity with phase 1); `0` ⇒ `return null`. (A target surviving phase-1 can't equal any structural urlPath, so phase-2 matches are necessarily field-based.)

**F. Editor-time validation (Save + Rename)** — both reuse the live `listEntries` scan (non-asserting, so they don't self-trip on a pre-existing collision) + surgical self-excluding `findUrlPathConflict`.
- **Save** — `api/content.ts` `writeContentHandler` (resolve `fields` *before* `store.write()`, reusing :240-247): if `schemaDeclaresUrlPath(fields)` and a value is present, normalize it, **write the canonical value** to disk, then `findUrlPathConflict(target, selfId)`. Conflict ⇒ `400` naming the other entry; do not write.
- **Rename** — `api/content.ts` `renameEntryHandler` (before `store.renameEntry`): if the renamed entry is **not** field-routed, compute its new structural `urlPath` from `${collectionPath}/${newSlug}` (strip root, collapse index, lowercase) and `findUrlPathConflict(target, selfId)`. Conflict ⇒ `400`. Keep `store.renameEntry`'s existing same-collection filename check (`content-store.ts:679-696`); this adds the cross-collection / field-URL guard. (Background: `content-store-validation.md` notes write-boundary validation is generally thin today.)
- **Error surfacing** — today `useDraftManager.ts` maps non-200 saves to a generic "Save failed"; surface the server's specific message for urlPath/rename conflicts (the rename modal already does client-side slug validation).

**G. `canopycms-next` `basePath`** — `isUrlPath` values are absolute ("the value is the full URL"). Adopter route is a root catch-all (no basePath). Document; defer deep basePath+isUrlPath interaction. No code change.

### Example (`apps/example1`) — demonstrates "control your own URL"
`pageSchema` (`title` isTitle, `urlPath` string isUrlPath, `body` markdown isBody) registered; `content/pages.<id>/` with `page.privacy.<id>.md` (`urlPath:/privacy`) + `page.solutions.<id>.md` (`urlPath:/solutions`), id added to root `order`; `app/[...slug]/page.tsx` root catch-all mirroring `app/docs/[[...slug]]/page.tsx` using `contentStaticParams({rootPath:'content/pages'})` + `readByUrlPath`. Use `[...slug]` (required) so `/` stays with `app/page.tsx`; `/docs`,`/posts`,`/auth`,`/api`,`/ai` are more specific. Reuses existing public API — **not** a new example↔package touchpoint.

### Tests
- **Unit:** `utils/url-path-field.test.ts` (helpers + normalize cases + `assertUniqueUrlPaths` gating/message + `findUrlPathConflict`); `entry-schema-registry.test.ts` (two isUrlPath ⇒ throw; non-string ⇒ throw).
- **Integration** (real services+fs; reuse `context.test.ts` `tmpDir`/`buildBranchContext`/`createTestServices`/`createCanopyContext`, `content-listing.test.ts` `createCollection`/`createEntry`): routing (field `/foo` resolves; `collectStaticParams` yields `['foo']` not `['pages','foo']`; empty ⇒ structural; branch-aware); unified collision (field `/foo` + top-level structural `foo` ⇒ build throws naming both; two field `/foo` ⇒ ambiguous throw); `content-listing` urlPathSource; `content-tree` node.path field-sourced; **API** `writeContentHandler`/`renameEntryHandler` collision ⇒ 400 (real services); `canopycms-next/static.test.ts` field segments.
- **Optional stretch:** Playwright e2e (`apps/test-app/e2e`) for editor rename/urlPath-collision surfacing (needs an isUrlPath collection in test-app).

### Docs (run the doc agents)
ARCHITECTURE (markers + unified namespace + two-phase scan-not-index + shared `resolveEntryUrlPath` SSoT + editor-time validation + "value is full URL"); README (control-your-own-URL note); DEVELOPING (pattern + decisions + the two URL computations now unified); CODEBASE_GUIDE + AGENTS Code Organization (new `url-path-field.ts` + integration points). Agents: `update-codebase-guide`, `docs-architecture`, `docs-developing`, `docs-readme`.

### Implementation hygiene
Branch `url-path-field-marker` off main; **run `pnpm test` + `pnpm typecheck` first for a green baseline** (so any breakage is provably the change's). Before finishing: prettier --write changed files, `pnpm lint`, typecheck, test — all green.

### Verification
`pnpm test`/`typecheck` green. In `example1`: static export (`CANOPY_BUILD=static`) generates `out/privacy/index.html` + `out/solutions/index.html` and **not** `out/pages/...`; `readByUrlPath('/privacy')` resolves (round-trip); a duplicate `urlPath` ⇒ build throws naming both files. Dev: editing a urlPath onto an existing URL ⇒ Save blocked; renaming a plain entry onto a page's urlPath ⇒ Rename blocked.

### Backward compatibility
No schema declares `isUrlPath` ⇒ `resolveEntryUrlPath` returns undefined, phase-2 + editor checks skipped ⇒ identical to today.

---

## Related future tasks
- `url-mapping-system.md` (P2) — the **heavier alternative**: collection-level URL templates (`/blog/{field:publishDate|year}/{slug}`), date-based URLs, bidirectional registry. `isUrlPath` is the lighter per-entry declarative cousin; if both ever ship, reconcile (a marker for simple cases, templates for systematic patterns).
- [readbyurlpath-entry-type.md](resolved/readbyurlpath-entry-type.md) — RESOLVED 2026-08-14: `readByUrlPath` now returns `entryType`, closing the SSR gotcha above.
- `readbyurlpath-collection-url-support.md` (P2) — `listEntries` `urlPath` (shipped) + root `/` handling in `readByUrlPath`.
- `index-staleness-multiprocess.md` (P0) — the index-staleness pain that justifies "scan, not index" here.
- `content-store-validation.md` (P1) — write-boundary validation context for the editor-time Save check.
- [static-export-sitemap.md](resolved/static-export-sitemap.md) / [static-export-seo-metadata.md](resolved/static-export-seo-metadata.md) — RESOLVED 2026-08-14: sibling `static/` helpers (`collectRoutableEntries`, `generateContentSitemap`, `entryToMetadata`) that would still benefit from field-sourced `urlPath`.
- ~~**New gap surfaced (no file yet):** `maxItems` is metadata-only.~~ Closed — see the correction above; `api/content.ts:360-373` enforces it (`e4097b0e`, PR #106).

## Out of scope / follow-ups (when revived)
Persistent index (only if scans slow); deep basePath+isUrlPath; widening collision error to pure structural-vs-structural; dedicated client-side isUrlPath field component (inline format hints / live availability); Playwright e2e if not done in the main pass.
