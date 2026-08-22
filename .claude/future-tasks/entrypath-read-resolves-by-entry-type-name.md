# A slugless `read({ entryPath })` resolves by entry-type NAME, so a slug rename silently breaks it

**Status:** Open. **Priority: P2.** Found 2026-08-21 while re-modelling `apps/example1`'s `home`
entry (adopter request #20). Not previously filed.

## The defect

`ContentStore`'s path builder falls back to the entry **type name** when no slug is given:

```
packages/canopycms/src/content-store.ts:671   // line number moves; locate by name
  // Use provided slug, falling back to entry type name
  const effectiveSlug = slug || schemaItem.name
```

So `read({ entryPath: 'content/home' })` — the documented shape for reading a singleton, and the
one `apps/example1/app/page.tsx` uses — resolves the file whose slug happens to equal the entry
type's name. That coincidence is not a contract anywhere. Rename the entry's slug and the read
stops finding it, with no error at the call site, no type error, and nothing in validation that
notices.

## Why it deserves a task rather than a comment

Three properties compound into a bad failure:

1. **The break is silent at the boundary.** `read()` throws on missing content, but the common
   adopter shape — a page that resolves content and renders it — surfaces that as a 404 or a blank
   page, not as "your read is misconfigured".
2. **The break can ship green.** A Next production build will happily prerender the 404 boundary
   into a route and report success. The first build after an example-app slug rename was green
   **with a 404 homepage and a sitemap still advertising the old URL**. So neither the build nor CI
   is a backstop here — and, at the time, `apps/example1` was not built in CI at all, filed
   separately as [example1-next-build-not-in-ci.md](resolved/example1-next-build-not-in-ci.md)
   (now resolved: see the `example1-build` job in `.github/workflows/ci.yml`).
3. **Renaming a slug is an ordinary editorial act**, not an exotic refactor — and it is exactly
   what the `index`-entry modelling recommendation asks adopters to do to their singletons.

## Options

- **Make the fallback explicit rather than implicit.** Require the slug, or accept an entry-type
  reference rather than a path that happens to end in the type name.
- **Detect it.** A slug rename could warn when some entry type's name no longer matches any entry's
  slug in that collection — cheap, and it fires exactly when the coincidence breaks.
- **Document it, at minimum.** The fallback is currently explained only by a one-line comment at
  the definition site; nothing adopter-facing says that `entryPath`-without-slug is name-coupled.

Worth designing alongside the write-boundary URL-collision guard, which already inspects entry
creation and rename — the rename path is where a detector would naturally live.
