# Adopter request log — standing intake

**Status:** Standing pointer + the 2026-08-20 triage, extended 2026-08-30 with items 35-36. **Priority: P2** (the log itself; individual
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

**Status refreshed 2026-08-22.** This table had gone stale — it still listed #16, #24, #26, #27 and #28
as open after all five were fixed, which is the exact failure mode the file exists to prevent. Every
row now names what actually landed.

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
| 24 | Assets/media system undiscoverable | Confirmed (docs), plus one real behaviour gap | Fixed — docs, then the basePath behaviour half in PR #261 |
| 22 | Enumeration and resolution disagree on URL count | **Confirmed, plus a second consequence they did not find** | Half fixed 2026-08-21 ([url-resolver-index-entry-extra-url.md](resolved/url-resolver-index-entry-extra-url.md)); remainder fixed 2026-08-22 as **#34** below |
| 20b | `extraUrls` bypasses `isNoindexEntry`, no `lastModified` | Confirmed, both halves | **Shipped 2026-08-21** — docs earlier, `pathFor` on `feat/sitemap-path-for-index-entries` |
| 27 | Non-list `object` field can be entered but never cleared | Confirmed | Fixed — Clear control, clears to `undefined` |
| 28 | `object` fields drop comment support | **Partially true** — see below | Fixed — container-level wrap; children always worked |
| 26 | `generate-ai-content` never prunes previous output | Confirmed | Fixed — record-based prune, never a directory sweep |
| 23 | `select` infers `string \| number` | Confirmed, and the literal-union fix is **verified reachable** | Fixed on this branch |
| 29 | Unknown keys never reported | Confirmed; cheaper than they framed it | Fixed on this branch |
| 16 | `listEntries()` never resolves `reference` fields | Confirmed; blast radius **differs** from their account | Fixed — PRs #242, #245 |
| 20 | Reference app teaches index singletons the hard way | Confirmed but **narrower** than framed | **Shipped 2026-08-21** on `feat/sitemap-path-for-index-entries` |

### Item 34 — the remainder of #22, filed 2026-08-22

**Shipped 2026-08-22** on `fix/readbyurlpath-url-addressable-only`. Their framing was right, their
measurement was right, and their table was under-scoped in the same direction our own docs were —
which is the useful part of this item.

| # | Their claim | Verdict | Disposition |
| - | ----------- | ------- | ----------- |
| 34.1 | Drop the entry-type-name candidate from `resolveUrlPathCandidates`; confirm nothing that round-trips breaks | **Confirmed, and the fix is wider than requested** | Fixed — but NOT in that module, and covering two more shapes |
| 34.2 | Add the invariant as a property test over your own fixtures | Confirmed; the right ask | Fixed — `url-exclusivity-fixtures.ts`, run over fixtures AND `apps/example1`'s real tree |
| 34.3 | If the candidate must stay, widen the caveat in `adopter-migration.md` | Moot | The two under-scoped caveats were corrected in place anyway, rather than shipped falsified |
| 34.4 | `/site` resolves the settings singleton, unenumerated | **Not this bug**, and we think not a bug | See below — no change |
| 34.5 | Check whether `apps/example1` reproduces it | Confirmed, and **worse than they predicted** | Fixed; now covered by a test over that app's real tree |

**Where the fix diverges from what they asked for.** They asked us to drop the candidate.
`resolveUrlPathCandidates` cannot tell an entry-type path from a collection path — it is pure and
schema-free on purpose — so dropping the candidate there would also have closed the collection
literally *named* `index`, which that candidate exists to answer. The rule is instead enforced one
layer down, in the reader, which already holds the branch's schema: for a read by published URL,
every candidate's `entryPath` must be a collection. Their diagnosis ("one shared candidate list,
two callers with different needs") was exactly right; the fix separates the callers rather than
the list.

**What their probe did not reach.** The same delegation is available through the OTHER candidate:
`/<collection>/<entryTypeName>/<slug>` resolves `<collection>` + `<slug>`. It needs no index entry,
so unlike everything in their table it applies to **every entry in every collection** — their site
will have had one of these per page. Worth telling them explicitly, since a guard written against
their table would not have covered it.

**Their `/site` row is a different mechanism and we made no change.** It resolves through the
direct-entry candidate against the root *collection*, not through an entry-type path: a singleton
written with no explicit slug lands on disk as `site.site.<id>.json`, so its slug genuinely is
`site` and `computeEntryUrl` genuinely publishes `/site` for it. If their enumeration does not show
`/site`, the question is why the listing does not include it (scope? ACL?) rather than why
resolution does. The adjacent real issue — that a slugless `read({ entryPath })` is coupled to the
entry-type name, so renaming a slug silently breaks it — is tracked separately in
[entrypath-read-resolves-by-entry-type-name.md](entrypath-read-resolves-by-entry-type-name.md).

**Their verification suggestion was the most valuable line in the report.** `apps/example1` does
reproduce it, but not at `/home` as they guessed — that URL has no route there, so Next 404s it.
It reproduces through the family they had not found, under the app's live `docs` catch-all:
`/docs/doc/overview`, `/docs/api/doc/intro`, `/docs/api/v1/doc/authentication` and four more, seven
duplicate pages in total, with `next build` green and the sitemap clean throughout. Their note that
example1's emitted HTML is not inspected in CI was out of date (that gap was closed in
`example1-next-build-not-in-ci.md`) but the underlying point stood: the build-verify suite asserts
on three routes, and none of them is a phantom. The reference app is now held to the invariant
directly, over its whole content tree.

**One more narrowing they did not ask for, flagged because it can remove a page.** A collection
declaring no entry types lists nothing at all (`listCollectionEntries` returns `[]` for one), so
files sitting in a collections-only container are no longer resolvable by URL either. Same class as
the undeclared-token case, and equally un-authorable through the CMS, but worth naming since it is
the one part of this change that can 404 something an adopter is currently serving.

**One thing we did not fix, stated plainly so they can stop looking for it.** A legacy untyped file
(`overview.json`, not `{type}.{slug}.{id}.{ext}`) is still readable by URL and still invisible to
every enumerating surface. Left open for test-migration cost, not disagreement — tracked in
[legacy-untyped-files-url-addressable.md](legacy-untyped-files-url-addressable.md).

### Items 35 and 36 — build-artifact determinism, filed 2026-08-30

**Both shipped 2026-08-30.** Filed by the marketing site while building a content-addressed
deploy pipeline, and both are gaps every static-export adopter would hit. Their report was
unusually good: every claim about Next's internals was re-verified here against the installed
`next@15.5.21` and every one held, including the two subtle ones (below) that we would have got
wrong without them.

| # | Their claim | Verdict | Disposition |
| - | ----------- | ------- | ----------- |
| 35 | `generate-ai-content` bakes `new Date()` into `manifest.json`, no override | Confirmed | Fixed — but with omission rather than the override they asked for |
| 36 | `withCanopy` should pin `generateBuildId` for static-export adopters | Confirmed; `generateBuildId` appeared nowhere in this repo | Fixed as requested, gated on `staticBuild` |

**Two details from their report that were load-bearing, both verified in the Next source.** They
warned that `||` and `??` are not interchangeable here: an empty-string env var survives `??`,
then clears Next's `typeof buildId !== 'string'` guard, and the build ships with an EMPTY build
id. And that Next re-rolls ids containing `ad` (ad-blocker false positives) **only** on the
`null` fallback path, so a returned string is used verbatim — which is what makes a hex tree hash
usable as a build id at all. Both are asserted by tests now, and the empty-string one was watched
failing (flip `||` back to `??` and two go red — the empty-string case and the whitespace-only
one added when review found that `||` alone still shipped an empty id, because Next trims only
AFTER its string guard).

**Where the fix diverges from what they asked for.**

- **The env var is `CANOPY_BUILD_ID`, not `NEXT_BUILD_ID`.** Theirs reads like an official Next
  variable and is not one — Next never consults it — and the AI generator that also reads it
  lives in `canopycms`, which is framework-agnostic. So this one was ours to name, and it matches
  the existing `CANOPY_BUILD` convention. `SOURCE_DATE_EPOCH` is kept under its standard name for
  the opposite reason: it is the Reproducible Builds convention, so a harness already exporting it
  for tar/gzip/rpm gets our behaviour for free. Renaming it would have cost that for nothing.
- **`generated` is omitted, not overloaded.** They asked for the build id *in* that field. It goes
  into a new optional `buildId` instead, and `generated` disappears when a build id is set with no
  `SOURCE_DATE_EPOCH`. Overloading a field the README documents as an ISO date would change its
  meaning for every other adopter; omission makes the field's PRESENCE meaningful instead. This
  also answers their deeper point better than the override they proposed would have: with only an
  override, the value they would most naturally pin is the commit date — and their own item
  correctly warns that a rebase or cherry-pick gives an identical tree a different commit date,
  reintroducing the variance. There is no tree-derived *date*; the tree hash is the only stable
  content-identifying fact, and it now has a field of its own.
- **`AIManifest.generated` is now `string | undefined`** — a type-level break for anyone reading
  it. Nothing in this repo did; the only references were four `toBeTruthy()` assertions.

**Gated on `staticBuild`, and that is not just deference to their framing.** Under the dual-build
convention the static and CMS flavors have different `pageExtensions` and therefore different
chunk sets. Pinning both from one env var would give two different file sets the same
`_next/static/<id>/` path, which nothing can route between if they ever share an origin. The CMS
build keeps nanoid so the two artifacts stay distinguishable.

**One thing to tell them that is not in their report.** The runtime `/ai/*` route handler shares
the same generator and was deliberately left on a live clock — correct for a response generated on
demand. So a `SOURCE_DATE_EPOCH` exported in a *server* environment does not (and must not) freeze
the CMS server's manifest timestamps. Only the build path reads it.

### Items 45 and 46 — worker credential sources, filed 2026-09-12

**Both DELIVERED 2026-09-12/13** on `int-202609-a`, as five PRs: #320 (secret reader),
#322 (its CDK props), #319 (async URL groundwork), #321 (App auth in core), #329 (its CDK
props and entrypoint wiring). Every premise in both items was re-verified here against the
source before any code was written, and **both held exactly as reported**.

| # | Their claim | Verdict | Disposition |
| - | ----------- | ------- | ----------- |
| 46 | The worker reads a secret's ENTIRE value, so a JSON credential document cannot be pointed at | **Confirmed** — `getSecret` returned `SecretString` verbatim, no `JSON.parse` on that path, `SecretId` unmodified | Fixed — a `jsonField` option plus two CDK props, **and a loud warning that closes the trap they actually described** |
| 45 | The worker can only authenticate with a static token, and reads secrets once at boot, so a GitHub App is unusable | **Confirmed, both halves** — both `getSecret` calls are inside `main()` before `new CmsWorker(...)`, and nothing re-reads them | Fixed — App auth with tokens minted on demand. The PAT remains the documented default, untouched |

**Their suggested shape for #46 was wrong for this call path, and it matters.** They proposed
honouring Secrets Manager's `arn:...:secret:name-AbCdEf:KEY::` suffix, or CDK's
`secretValueFromJson`. Neither works here: the suffix is a CloudFormation-dynamic-reference
and ECS-task convention, and the `GetSecretValue` API the worker actually calls does not
parse it; `secretValueFromJson` resolves the **plaintext into the CloudFormation template at
deploy time**, which would destroy the "the worker's `.env` carries the ARN, never the value"
posture that `docs/deploying-to-aws.md`'s Security Model rests on. Verified in
`aws-cdk-lib@2.265.0`: `fromSecretCompleteArn` gates on `/-[a-z0-9]{6}$/i` and throws on a
suffixed ARN, so their own scaffolded stack would have rejected it. The delivered shape is a
separate field prop and our own parse — and a **synth-time guard that refuses a suffixed ARN
by name**, so an adopter who tries the ECS convention is told what to use instead of getting
either CDK's cryptic suffix error or an unmatchable IAM `Resource` and a 5s restart-loop.

**#46 closes for two of their three keys, and this needs saying plainly.** Their document
holds `CLERK_SECRET_KEY`, `CLERK_JWT_KEY` and the publishable key. Only the first (plus the
GitHub token) is read by the worker's secret path. `CLERK_JWT_KEY` is threaded as a plain CDK
prop into the Lambda's environment and the publishable key is a Docker build arg — **neither
can point at a Secrets Manager ARN at any level.** That is defensible, since both are public
material, but unsaid it reads as the request being half-done.

**Where #45's fix went beyond the request, and one place their reasoning was better than
ours.** They noted the remote-URL half needed no change because the worker already uses the
`x-access-token:` form — correct, and it is cheaper still than they knew: no tokenized URL is
ever persisted to `.git/config` (`scrubPersistedRemote` removes *and verifies* removal), and
`redactCredentials` already matched `ghs_`. What it did **not** match was a PEM block or a
bare JWT, both of which App auth introduces into worker error text that reaches `task.error`
and the admin panel; those rules were added.

**A premise WE got wrong, recorded because this log is a two-way document.** Our own plan
asserted that an unconverted PKCS#1 private key would fail today, because
`universal-github-app-jwt`'s WebCrypto path accepts only PKCS#8. Measured with the worker's
exact esbuild flags, that is false: `@octokit/auth-app@6` resolves
`universal-github-app-jwt@1`, which signs via `jsonwebtoken`, and `--platform=node` selects
that build (lockfile confirms `universal-github-app-jwt@1.2.0` depending on
`@types/jsonwebtoken`). The WebCrypto-only constraint belongs to v2, i.e. `auth-app@7`. The
key normalization shipped anyway — it also accepts base64-wrapped and `\n`-escaped keys and
turns a bad key into a loud boot error — but as **insurance against a bundler-flag change or
an auth-app@7 bump, not a fix for a present bug**, and the code says so with a resolution
table.

**Found by us while implementing, absent from both items.** An empty-string credential is now
rejected rather than returned: it is not a credential, and every downstream consumer treated
it as absent *silently* — an empty Clerk key left `refreshAuthCache` undefined, disabling
auth-cache refresh with no log line at all. Two new `assertEnvSafe` rules (backslash,
surrounding whitespace) now cover every worker `.env` value, both grounded in how systemd's
`EnvironmentFile` parser actually behaves.

**Still open, and they should know.** (a) The boot-only read is only half-solved: under App
auth the credential refreshes itself, but **a PAT adopter who rotates still holds the
boot-time token until the ASG rolls** — their item's own "Related" note, and the majority case
since most adopters cannot register an App. Tracked as the reactive-re-read task. (b) The App
path ships **unexercised against real GitHub**: every test generates its key with
`node:crypto` and makes no network call, so nothing has yet proven a real installation token
authenticates, or survives the ~1-hour expiry boundary that is the entire reason #45 exists.
Planned against the `canopycms` org and its `deploy-test` repo. (c) `GitHubService` is still
static-token-only — inert on the shipped AWS deployment, filed as
[github-service-static-token-only.md](github-service-static-token-only.md).

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
    [example1-next-build-not-in-ci.md](resolved/example1-next-build-not-in-ci.md) (now resolved);
    it was verified here only
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
