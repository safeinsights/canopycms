# Baseline review 2026-08: five shipped features that do not work

Found by the August 2026 whole-codebase baseline review (5 independent Fable reviews at
`integration-202607-a` @ `6770327c`, verified first-hand by the lead reviewer).
Full traces: [REVIEW-REPORT-2026-08.md](../../REVIEW-REPORT-2026-08.md) findings 3, 4, 7, 9, 10.

Grouped because they share a cause worth naming: **each is a seam where one layer is mocked in
tests and the layer beneath is tested with different inputs**, so the suite is green while the
feature is broken. The seam tests listed under each are worth more than any quantity of
additional unit tests.

Findings are struck ~~in place~~ as they resolve (see the note in
[baseline-2026-08-content-loss.md](baseline-2026-08-content-loss.md)).

---

## ~~1. [P1] Most schema-editor mutations return 400 against the paths the editor actually sends~~

**RESOLVED (PR #217) — one normalization at the `SchemaOps` boundary reusing `normalizeCollectionPath`, replacing the bespoke strip. Guarded by a table-driven test over all ten surfaces against a real `SchemaOps`; reverting turns 8 of 10 red, and the two that stay green are exactly the two the finding documented as already working.**

Verified end to end: `branch-schema-cache.ts:312` calls `flattenSchema(schema, contentRootName)`,
so production logical paths are content-root-prefixed (`content/posts`).
`CollectionEditor.tsx:284` passes that to `useSchemaManager.ts:196`; `api/schema.ts:591-598`'s
`decodeCollectionPath` **only URL-decodes**; and `schema-store.ts:810` passes it straight to
`resolveCollectionPath(this.contentRoot, …)`, which looks for `<contentRoot>/content/posts` →
not found → 400 "Collection not found".

`updateCollectionInner` is the **one** mutation that works, because `:662-663` explicitly strips
the prefix. The other eight call sites (`:416, :453, :548, :770, :810, :891, :943, :1005`) do
not. So add-entry-type, remove-entry-type, delete-collection, sub-collection create and the field
operations are all broken in the shipped product; only update-collection and update-order work.
Reproduced at runtime against a real `SchemaOps` during the review.

Hidden because API tests mock `SchemaOps`, store tests use unprefixed paths, and
`useSchemaManager.test.ts` mocks the API client — three layers each mocking the next.

**Fix direction:** one shared normalisation at a single boundary (preferably where `SchemaOps`
receives a logical path), applied to all nine sites; drop the bespoke strip in
`updateCollectionInner` in favour of it.

**Guard to add:** drive a **real** `SchemaOps` with `content/posts` for every mutation.

---

## ~~2. [P1] Group grants and revocations in the admin UI never change any privilege~~ (RESOLVED 2026-08-13)

Request-time effective groups come from `loadInternalGroups(mainBranchContext.branchRoot, …)` —
the **base-branch content clone** (`http/handler.ts:258-267`, and the same again in
`canopycms-next/src/context-wrapper.ts:275`). The Groups admin API reads and writes the
**settings workspace** (`api/groups.ts:128,177,189` via `api/settings-helpers.ts:27`). Both build
the filename with `operatingStrategy(mode).getGroupsFilePath(root)`; only `root` differs, and it
differs in every mode (prod `{workspace}/settings` vs `{workspace}/content-branches/{branch}`).

`mutateGroupsFile` has exactly one non-test caller — settings root only — and nothing copies
settings into the base clone (`git-manager.ts:1319-1365`'s `initialFiles` only seeds the orphan
settings branch at creation).

Impact is broader than failed revocation: because nothing in the product ever writes the base
clone's `groups.json`, **the entire internal-groups feature is inert for authorization**. Groups
created in the UI return 200, are echoed by `GET`, and match nobody in path/branch ACLs. Admin
access survives only because `bootstrapAdminIds` (env) is merged separately — which is why this
sits undetected: the one privilege anyone tests still works.

Escalates to P0 for any deployment that committed a `groups.json` on its base branch and then
tries to revoke someone: the revocation reports success and does nothing.

**Fix direction:** load internal groups from `getSettingsBranchRoot()` in both pipelines (the
pattern `createContentAccessChecker` already uses) and delete the base-branch read. Extract the
duplicated "resolve effective user" pipeline into core so the Next wrapper calls it instead of
re-implementing it — that duplication is the co-cause. Correct the settings PR body, which claims
"Changes are already active in the CMS".

**Guard to add:** `PUT /groups/internal` removing a user from `Admins` → that user's next
`whoami` no longer contains `Admins`. Today `groups-api.test.ts` covers the settings-file side,
`user-context.test.ts` covers the base-branch-seeded side, and nothing connects them.

**RESOLVED** (2026-08-13) — both read pipelines now load internal groups from
`getSettingsBranchRoot()`, matching `createContentAccessChecker`'s pattern, with the base-branch
read deleted entirely. The duplicated "authenticate -> load groups -> merge" sequence is extracted
into one shared helper, `resolve-canopy-user.ts` (`resolveCanopyUser`), exported off `canopycms/server`
and called by both `http/handler.ts` and `canopycms-next/src/context-wrapper.ts`. Settings-workspace
resolution failure now fails loud (503; the old silent `.catch(() => [])` fallback to an empty
group list is gone) rather than degrading privileges silently. The base-branch `getBranchContext`
call stays in `http/handler.ts` — it never actually served groups reads in the fixed pipeline, but
it still does real work: auto-provisioning the base/active workspace on the first request so later
handlers that assume it exists don't return confusing empty results, with the same
`BranchMetadataCorruptError` degrade-and-keep-routing behavior preserved for the `/admin` recovery
surface. `canopycms-next`'s copy of that call was dropped entirely (content reads already
provision the base branch themselves via `loadOrCreateBranchContext`), removing a redundant
per-request EFS round-trip there. The settings PR body in `services.ts` no longer claims merging
is what makes a change durable — both permissions and groups are read live from the settings
workspace, so a save already took effect before the PR exists; merging only records it for
review/audit history. `__integration__/test-utils/test-workspace.ts`'s `internalGroups` fixture
option, which previously seeded `groups.json` on the base branch content clone (the same wrong
location the bug read from, so it silently matched the bug instead of catching it), now seeds the
settings workspace's orphan branch the same way a real admin write would. New end-to-end coverage:
`__integration__/settings/groups-effective-privileges.test.ts` — grant/revoke via the real HTTP
API and assert the next `whoami`, a group created via the API matched by a branch ACL, and the
settings-workspace-unavailable case failing loudly. Confirmed red-before-green by reverting just
the `http/handler.ts` read-location change and observing the new test fail before restoring it.

---

## ~~3. [P1] `sanitizeHref` returns `'#'` for every relative URL~~

**RESOLVED (PR #213), with a follow-up: the composed-diff review found that fix introduced an **open redirect** — `startsWith('//')` misses backslash spellings (`/\evil.com`), which WHATWG URL treats as protocol-relative. Now guarded by whether the input declares a scheme.**

`utils/sanitize-href.ts:20` calls `new URL(url)` with **no base**, so any relative reference
throws and falls to the fallback. `sanitizeHref('/about')`, `('docs/guide')` and `('#section')`
all return `'#'`; only absolute `http(s)://` URLs survive.

Exposure is maximal: exported from the package's **main entrypoint** (`index.ts:1`), documented
across `README.md:1564-1595` as the recommended way to render any CMS link, described in
`ARCHITECTURE.md:2645` as the single auditable point for URL safety, used in `apps/example1`, and
**it has no test file at all**. Every internal link routed through the documented helper is dead.

It fails *closed*, so this is not an XSS hole — which is why it survived. The July baseline report
lists this function among its verified positives; it was assessed for the scheme allowlist
(correct) and never tried on a relative input.

**Fix direction:** parse against a sentinel base and return relative form when the origin matches
it — dangerous schemes still surface their own protocol, so the allowlist keeps working:

```ts
const SENTINEL = 'https://relative.invalid'
const parsed = new URL(url, SENTINEL)
if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fallback
if (parsed.origin === SENTINEL) return parsed.pathname + parsed.search + parsed.hash
return parsed.href
```
Decide deliberately about protocol-relative `//evil.com` (resolves absolute under the sentinel).

**Guard to add:** the missing test file — absolute, root-relative, relative, fragment-only,
query-only, `javascript:`, `data:`, `vbscript:`, protocol-relative, empty.

---

## ~~4. [P1] `submitBranch` retried after a failed push never pushes, and reports success~~

**RESOLVED (PR #214) — commit and push are gated separately; push now fires when the branch is ahead of the mirror, determined via a `FETCH_HEAD` pin rather than a remote-tracking ref that cannot exist in a `--single-branch` clone.**

`services.ts:326-331` puts the push **inside** the dirty-tree gate:

```ts
const status = await git.status()
if (status.files.length > 0) { await git.add('.'); await git.commit(…); await git.push(…) }
```

Committing cleans the tree, so attempt 1 (commit succeeded, push failed) leaves a clean tree and
the retry — which the failure invites — skips the whole block, returns normally, and the caller
records `status: 'submitted'`. The worker then ships `remote.git`'s stale tip, so the PR silently
lacks the author's last edit. `submitBranch` has **zero test coverage**.

**Re-rating:** this is already tracked as
[submit-retry-skips-push-after-failed-push.md](submit-retry-skips-push-after-failed-push.md) at
**P3**. An independent reviewer with no sight of that file re-derived it and rated it High; the
lead reviewer agrees. It belongs to the same silent-loss class as the P0s above. Promoting to P1
here; resolve the duplicate when this is fixed.

**Fix direction:** gate the push on "local branch is ahead of the mirror", not on a dirty tree.

**Guard to add:** commit-succeeded/push-failed, then retry → the push actually happens.

---

## ~~5. [P1] `number`, `datetime` and `rich-text` are declared field types that cannot be edited~~

**RESOLVED (PR #220) — all three implemented and `customRenderers` threaded through the public editor surface. The load-bearing guard is a test asserting **every** member of `primitiveFieldTypes` renders something other than the fallback, so config and renderer cannot drift apart again.**

`config/types.ts:15-24` declares eight primitives; `editor/FormRenderer.tsx:228-458` implements
five of them plus the composites. `number`, `datetime` and `rich-text` fall through to the
literal text "Unsupported field". The shared validator fully supports them, so a **required**
field of one of these types makes new entries of that type **permanently unsaveable** —
validation demands a value the form cannot provide.

The escape hatch does not rescue it: `customRenderers` is consulted at `FormRenderer.tsx:167`, but
repo-wide it appears only in that file and its own test. No caller threads it, and the public
`CanopyEditor` surface does not accept it.

**Fix direction:** implement the three (Mantine `NumberInput`, `DateTimePicker`, and a
textarea/MarkdownField for `rich-text`), **or** remove them from the public `fieldTypes` surface
until supported. Either way, thread `customRenderers` through `Editor`/`CanopyEditor` so the
documented extension point actually exists.

**Guard to add:** a test asserting every member of `primitiveFieldTypes` renders something other
than the unsupported fallback — so the config surface and the renderer cannot drift again.
