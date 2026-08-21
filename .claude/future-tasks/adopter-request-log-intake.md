# Adopter request log — standing intake

**Status:** Standing pointer + the 2026-08-20 triage. **Priority: P2** (the log itself; individual
items carry their own).

## What this is

The marketing site keeps `docs/canopycms-requests.md` — a running log of CanopyCMS bugs, gaps and
feature requests found while building a real site on the package. It is the closest thing we have
to an external adopter's view of our own work, and it is unusually disciplined:

- every item states **what was hit**, **the cost actually paid**, and **a suggested shape** — an
  item with no cost attached is explicitly filed as a wish and excluded;
- every item is re-verified per release against the installed tarball, not against memory;
- item numbers are **stable and never reused**, because they are referenced from code comments in
  their repo and from our `docs/adopter-migration.md`. Cite by number; never renumber;
- it carries its own Corrections section for status markers that turned out to be wrong.

Until 2026-08-20 nothing in this backlog referenced it, so items sat unread for releases at a time.
That is the gap this file closes: **whenever we pick up adopter-driven work, read their Open
section first**, and record the disposition of anything acted on back into this file.

## Triage of 2026-08-20 — all 16 open items

Verified against `v0.0.63` (= `origin/main` at the time, so their 2026-08-18 verification was
against current `main`, not a stale pin). `#18` is declined upstream and marked do-not-relitigate —
left alone.

| # | Their claim | Verdict | Disposition |
| - | ----------- | ------- | ----------- |
| 19 | `canopycms-next` unimportable by Node ESM | **Confirmed, and wider than reported** | Fixed on this branch |
| 17b | `toPlainText` passes HTML comments through | Confirmed | Fixed on this branch |
| 9 | AI markdown output isn't prettier-stable | Confirmed, both constructs | Fixed on this branch |
| 21 | Published sourcemaps point at unshipped sources | Confirmed | Fixed on this branch |
| 25 | `adopter-migration.md`'s `## Unreleased` is stale | Confirmed | Fixed on this branch |
| 6 | `react-markdown`-in-RSC trap undocumented | Confirmed | Fixed on this branch |
| 24 | Assets/media system undiscoverable | Confirmed (docs), plus one real behaviour gap | Docs fixed; behaviour split out |
| 22 | Enumeration and resolution disagree on URL count | **Confirmed, plus a second consequence they did not find** | [url-resolver-index-entry-extra-url.md](resolved/url-resolver-index-entry-extra-url.md) |
| 20b | `extraUrls` bypasses `isNoindexEntry`, no `lastModified` | Confirmed, both halves | **Shipped 2026-08-21** — docs earlier, `pathFor` on `feat/sitemap-path-for-index-entries` |
| 27 | Non-list `object` field can be entered but never cleared | Confirmed | Open, small |
| 28 | `object` fields drop comment support | **Partially true** — see below | Open, small |
| 26 | `generate-ai-content` never prunes previous output | Confirmed | Open, small-medium |
| 23 | `select` infers `string \| number` | Confirmed, and the literal-union fix is **verified reachable** | Fixed on this branch |
| 29 | Unknown keys never reported | Confirmed; cheaper than they framed it | Fixed on this branch |
| 16 | `listEntries()` never resolves `reference` fields | Confirmed; blast radius **differs** from their account | Open, medium |
| 20 | Reference app teaches index singletons the hard way | Confirmed but **narrower** than framed | **Shipped 2026-08-21** on `feat/sitemap-path-for-index-entries` |

### Where our verification disagreed with theirs

Recording these because the log is a two-way document and its accuracy is the reason it is worth
reading at all.

- **#19 is worse than they reported.** They found `canopycms-next`. In fact **four of five
  published packages** emit extensionless relative specifiers under `"type": "module"` —
  `canopycms-next`, `canopycms-auth-dev`, `canopycms-auth-clerk` and `canopycms-cdk`. Only
  `canopycms` is correct, because only `canopycms` wires up the `postbuild` step that rewrites
  them. `canopycms-cdk` is the sharpest case, since CDK apps are run directly by Node.
- **#28 overstates its consequence.** The code claim is right — the `object` branches never call
  `wrapWithComments`, unlike `string` (`FormRenderer.tsx:245`), `block` (`:394`) and `image`
  (`:374`). But a field nested inside an object still renders through the same recursive
  `renderField` path and **keeps its own comment affordance**. What is actually missing is a
  comment on the object *as a whole*. Real inconsistency, narrower blast radius.
- **#16's blast radius is different, not smaller.** Our AI export does *not* build from
  `listEntries` — it walks `store.getCollectionEntryPaths` + `store.read(..., { resolveReferences:
  false })`, so reference resolution is already independently disabled there. But `buildContentTree`
  and the admin list API share the same underlying primitive and are affected, and neither is in
  their account. A fix also needs an **opt-in** default (unlike `read()`, which defaults to `true`)
  or it silently changes every existing caller's data shape, and a shared per-batch resolve cache —
  a search-index build resolving thousands of items would otherwise re-read a shared block once per
  referencing entry.
- **#29 is cheaper than framed.** A non-blocking warning channel already ships end to end —
  `EntryValidationIssue` with `level: 'warning'`, surfaced as `validationWarnings` from
  `api/content.ts` and already rendered by `useEntryManager.ts`. The API/editor half can plug into
  it. The build-time half has no non-fatal concept and does need new plumbing. The real risk they
  did not flag: reference resolution injects `id`/`slug`/`collection` into saved data, so a naive
  unknown-key walker false-positives on every reference field that was read and re-saved.

  **Shipped 2026-08-21** on `fix/content-comment-preservation`, and both halves landed as
  predicted. The reference hazard turned out to be already retired by `3068cf32` — resolved
  objects are normalized back to id strings BEFORE persisting, and the check runs on that shape —
  and it could not have fired anyway, since a schema-driven walker never descends into a
  `reference` value. The risk the triage missed was different and closer to home: an inline
  **group** re-enters the traversal with the same record, so treating it as its own container
  double-reports every unknown key AND makes every sibling of the group read as unknown. Two
  guards proved necessary in practice: an entry type with no schema at all must report nothing,
  and a block item's `template`/`_type` discriminator is never a content key. Implemented by
  generalising `traverseFields` with an `onContainer` hook rather than adding a fourth copy of
  the schema-nesting rules. It found real stale data on its first run — three `apps/example1`
  fixtures carrying a redundant `slug` key that no schema models and nothing reads.
- **#20 is narrower than framed.** The `index`-slug convention *is* documented at length in the
  project README. What is genuinely missing is that `apps/example1` still models `home` the hard
  way and demonstrates the `exclude` + `extraUrls` workaround in its own `sitemap.ts`. Fixing the
  example is the work; documenting the convention is already done.

  **Shipped 2026-08-21** on `feat/sitemap-path-for-index-entries`, together with the deferred code
  half of #20b — one PR, because fixing the example DELETED the obvious demo for `pathFor`. Home is
  now `content/home.index.<id>.json`, so its `urlPath` is `/` and both workaround lines are gone;
  `app/page.tsx` resolves via `readByUrlPath('/')`. Two things the triage did not anticipate:

  - The old `read({ entryPath: 'content/home' })` passes no slug, and a slugless read **defaults the
    slug to the entry-type name** (`content-store.ts`'s `effectiveSlug = slug || schemaItem.name`),
    so the rename breaks that read — `/` 404s. Passing `slug: 'index'` explicitly would have kept it
    working; either way it had to change in the same commit, not as a follow-up.
  - **Nothing in CI would have caught that.** `apps/example1` is typechecked but never built, so a
    404 homepage ships green. Split out to
    [example1-next-build-not-in-ci.md](example1-next-build-not-in-ci.md); it was verified here only
    because the build was run by hand.

  `pathFor` is deliberately NOT demonstrated in `apps/example1`: the reference app's job is to teach
  the modelling that needs no option at all, and any use of it there would re-teach what this item
  removed. It is exercised by unit tests and documented as the fallback for URLs fixed outside the
  content tree.
- **#24 contains one real behaviour gap and one non-gap.** Their "two substantive gaps underneath
  the docs gap" do not weigh the same. The basePath one is real and was untracked — split out to
  [assets-basepath-deployments.md](resolved/assets-basepath-deployments.md). The branch-agnostic asset store
  is not a behaviour bug at all: it was audited, decided deliberately, and documented; it needed
  only a cross-reference from the ACL docs, which now exists.
- **#9's "adopter workaround" note describes their repo, not ours.** `apps/example1` has neither
  the `.gitignore` entry nor the `.prettierignore` the item implies. Immaterial to the fix.

## Found by us in the same review, absent from their log

- [content-comment-loss-on-editor-save.md](resolved/content-comment-loss-on-editor-save.md) —
  the editor destroyed every comment in a content file on save. Distinct from their #28.
  **Fixed 2026-08-21** on `fix/content-comment-preservation`, alongside #29 — the two shared a
  cause (how `ContentStore` rewrites a file) and were designed together.
- [conditional-field-visibility.md](conditional-field-visibility.md) — no way to express
  mutually-exclusive fields, so the rule ends up in labels.
- The second half of #22 — a flat entry in a parent collection can shadow a nested collection's
  index entirely.

## When you act on an item

Update `docs/adopter-migration.md` under the release it ships in (see the promotion note at the top
of that file — it goes stale easily), and produce a status table keyed by their item numbers so the
adopter can update their own log. Do not edit their repo from here.
