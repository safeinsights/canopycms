# Baseline review 2026-08: production-readiness blockers and follow-ups

Found by the August 2026 whole-codebase baseline review (5 independent Fable reviews at
`integration-202607-a` @ `6770327c`).
Full detail: [REVIEW-REPORT-2026-08.md](../../REVIEW-REPORT-2026-08.md).

Part A blocks the production-readiness program directly (see
[production-readiness-program.md](production-readiness-program.md)). Part B is the verified
remainder — real, individually small, none blocking.

Findings are struck ~~in place~~ as they resolve (see the note in
[baseline-2026-08-content-loss.md](baseline-2026-08-content-loss.md)).

---

# Part A — blocks production

## A1. [P1] Nothing scaffolds or documents how a deployed Lambda reaches `mode: 'prod'`

`cli/cli.ts:123` is a literal `const mode = 'dev'`, baked into the generated
`canopycms.config.ts` via `template-files/canopycms.config.ts.template:5`. There is **no runtime
env override**: `CANOPY_MODE` appears only in a Dockerfile template comment and in
`init.test.ts:430`, which asserts the Dockerfile does *not* set it — **no code reads it
anywhere**. Following `docs/deploying-to-aws.md` therefore ships a dev-mode Lambda, which
resolves its workspace to `<cwd>/.canopy-dev` and fails `EROFS` on a read-only container
filesystem.

An adopter can hand-edit the config, but nothing tells them to, and the one env var the templates
mention is a dead end — actively misleading.

**Fix direction:** give `init` a mode flag *or* a documented runtime env override the code
actually reads; fix the Dockerfile comment; add the switch to the deploy guide.

**Guard to add:** a CI assertion that the generated deploy artifact resolves to prod mode.

## A2. [P1] Dependency advisories on the untrusted-upload path, and an exposed peer range

`pnpm audit` reports 32 advisories; four matter, and the classification is what matters most:

| Package | Where | Issue | Action |
|---|---|---|---|
| `aws-cdk-lib` | `canopycms-cdk` dev **and peer** `^2.192.0` | OS command injection in `NodejsFunction` bundling (<2.260.0) | Routine same-major bump. **The peer range is the real exposure** — it lets adopters install a vulnerable version into the path that builds the prod Lambda |
| `image-size` | `canopycms` **prod** `^2.0.2` | DoS on malformed image; **no upstream fix exists** | A mitigation decision, not a bump — bound input size/dimensions before the call, or replace |
| `file-type` | `canopycms` **prod** `^20.4.1` | DoS on malformed input; fixed ≥21.3.2 | Major bump + compat check |
| `next` | `canopycms-next` dev `^15.5.19`, wide peer range | multiple <15.5.21 | Bump dev; raise peer floors |

`sharp` is **already patched** at `^0.35.3`; that audit hit is a nested copy under `next`.

Both `image-size` and `file-type` are called directly on uploaded bytes —
`assets/pipeline.ts:143` (`imageSize(data)`) and `:275` (`fileTypeFromBuffer(input.data)`). The
asset *logic* around them was reviewed and is solid (strict staging-key validation, allowlist SVG
sanitizer, fully allowlisted transform directives); the parsers underneath are the exposure.

## A3. [P1] Settings-workspace git plumbing: the init lock does not synchronize, and the pull is a permanent no-op

Two defects in one subsystem; fix together.

**The init lock is decorative** (`settings-workspace.ts:144-248`): `acquireFileLock` returns
`false` to a loser, but `acquired` is read **only** to decide whether to release — there is no
wait or skip path, so concurrent cold starts genuinely race `git clone`/orphan-init. Two waiters
can also both classify a lock stale and both `unlink` it (no inode identity check), and the lock
mtime is never refreshed, so an init slower than 30s is stolen. `docs/concurrency.md:250-260`
describes this as a concurrency control for initialization; it is not.
(Overlaps [settings-workspace-init-lock-uncatalogued.md](settings-workspace-init-lock-uncatalogued.md),
which reached the same conclusion from the doc side. This review re-derived it independently.)

**The settings pull has never worked** (`git-manager.ts:1138-1143`): `pullCurrentBranchInner`
merges `origin/<currentBranch>`, but workspaces are cloned `--single-branch`, so no
remote-tracking ref exists for the orphan settings branch. The sibling `pullBaseInner:1104-1113`
pins `FETCH_HEAD` to a SHA and its comment explains this exact hazard — **this is the third
occurrence of a bug already fixed twice**. Its only production caller, `services.ts:380`, swallows
the throw as `"No remote settings branch changes to pull (this is normal for first commit)"`, so
the failure is logged as normal. Consequence: once the remote settings branch diverges, every
settings save reports `committed: true, pushed: false` forever and nothing in the product can
converge it.

**Fix direction:** reuse `acquireProvisioningLock` (proper-lockfile, heartbeat, patient retries)
for the init race, exactly as `branch-workspace.ts:71-74` already does; mirror `pullBaseInner`'s
`FETCH_HEAD` pin; narrow the `services.ts:381` catch to distinguish "remote ref does not exist
yet" from a real merge failure. Update `docs/concurrency.md` either way.

**Guard to add:** a `pullCurrentBranch` test in the **production clone shape** — `--single-branch`
clone checked out on a different branch. Today's tests (`git-manager.test.ts:1609-1657`) use full
clones with `currentBranch === cloned branch`, which is why this shipped.

## A4. [P1] A reviewer-approved branch can be destroyed by one unconfirmed click

Compound: `api/branch.ts:599-606` blocks deletion for `status === 'submitted'` but **permits
`approved`** — a branch whose PR a reviewer has already approved — while
`BranchManager.tsx:548-557` wires Delete straight to the API with **no confirmation**, though
Submit and Withdraw both use `modals.openConfirmModal`. So a creator (not necessarily a reviewer)
destroys a reviewed branch — clone, metadata, mirror head — in one click, leaving the PR dangling
and `mark-merged` impossible.

**Fix direction:** both halves. Add the confirmation matching the existing submit/withdraw
pattern, and extend the delete guard from `submitted` to `submitted | approved` — one literal in
the same condition. Related: [approved-status-dead-end.md](approved-status-dead-end.md) already
notes `approved` has no non-destructive exit; deciding that question resolves this cleanly.

---

# Part B — verified follow-ups

Each is confirmed and individually small.

## B1. [P2] One duplicate content ID bricks every content operation on a branch

`content-id-index.ts:109` throws on the first duplicate embedded ID; `content-store.ts:258-262`
wraps the rebuild in `try/finally` with **no `catch`**, so `loadedIndexGeneration` never advances
and every subsequent access re-scans and re-throws — permanently. Every mutator warms the index
first, so read-by-id, reference resolution, listing and all writes die for the whole branch.

The state is created by the product itself: `renameEntry`'s `fs.link` → `fs.unlink` window (whose
comment calls it "detectable and recoverable" — nothing detects or recovers it) and `write()`'s
slug-change equivalent. `branch-health.ts` does not classify it, so prod admins have no repair
path at all.

**Fix direction:** the valuable half is surfacing duplicate-ID pairs in `scanBranchHealth` with a
repair action, matching the corrupt-`branch.json` quarantine precedent. Secondarily, make the
rebuild quarantine deterministically rather than throw.

## B2. [P2] The settings-branch name is reachable through generic `/:branch` routes

`http/handler.ts:76-86`'s `shouldAutoCreate` includes `branch === settingsBranch`, so any
authenticated request to any `/:branch/…` route provisions a **content** workspace for the
deployment's settings-branch name — bypassing `createBranchHandler`'s explicit rejection of that
namespace. Being `canopycms-system`-created and unprotected, `authorization/branch.ts:104-109`
then makes it **submittable by anyone with branch access** — which under the scaffolded
`defaultBranchAccess: 'allow'` is every authenticated user. Outside the pre-first-push window the
submit merely 409s, but the shadow clone still exists and appears in admin listings.

**Fix direction:** drop `branch === settingsBranch` from `shouldAutoCreate` (settings has its own
provisioning path via `getSettingsBranchRoot`), and/or refuse `RESERVED_SETTINGS_BRANCH_PREFIX` in
the workflow guards, mirroring the create-time guard.

## B3. [P2] `parseBranchName` accepts names that sanitize to a leading hyphen

`parseBranchName` (`paths/validation.ts:306`) rejects a *raw* leading `-`, but permits `!`, `$`,
`%`, `&`, `(`, `)`, `=`, `|`, `{`, `}`, backtick and all non-ASCII — which
`sanitizeBranchName` (`paths/branch-name.ts:21`) maps to `-`. So `!f` is accepted and becomes the
git branch and directory name `-f`. The invariant asserted in `parseBranchName`'s own comment at
`:303-305`, which `git-manager`'s separator-free `checkout` calls are documented as relying on,
does not hold. Fails safe today (500 + orphan directory) — the hazard is that future call sites
are told they may trust it.

**Fix direction:** reject any name whose `sanitizeBranchName()` output starts with `-`, or strip
leading hyphens the way leading dots are already stripped.

**Guard to add:** a property test — for every `parseBranchName`-accepted name,
`sanitizeBranchName(name)` never starts with `-`.

## B4. [P2] `services.checkPathAccess` is dead and fail-open-shaped

`services.ts:236` binds it with an **empty rules array**, so it ignores every configured
permission rule and answers purely from `defaultPathAccess` — under the scaffolded `'allow'`,
allow-everything. It is exposed at `:473` with **zero production consumers**; the only reference
is `services.test.ts:91-92`, a test that blesses the shape. A well-named trap for the next person
who wants a path check.

**Fix direction:** delete it, or bind it lazily to the real settings-branch rules the way
`createContentAccessChecker` does.

## B5. [P2] Four already-diverging implementations of "does this user match allowedUsers/allowedGroups"

`authorization/path.ts:40-54`, `authorization/branch.ts:39-43`, `api/branch.ts:127-140` and
`api/branch.ts:500-524`. They **already disagree** — the listing filter ignores
`managerOrAdminAllowed`, so such a branch is hidden from listing while its access check has its
own semantics. Divergence here is a future authorization bug, not untidiness.

**Fix direction:** one shared target-matcher so listing and enforcement cannot disagree.

## B6. [P2] API error-status and decoding inconsistencies

- Unknown exceptions (ENOSPC/EACCES/bugs) mapped to **400** instead of 500
  (`api/content.ts:465,607`; `api/entries.ts:399`), inconsistent with sibling read/delete handlers.
- A non-busy order-cleanup failure after a *successful* delete returns 500 "Failed to delete
  entry" though the entry is gone; the retry then 404s (`api/entries.ts:447-480`).
- `:param` is double-decoded (malformed `%` → URIError → 500) and catch-alls are never
  router-decoded, with handlers compensating inconsistently — entries/schema decode, content does
  not (`http/router.ts:141`).

## B7. [P3] Smaller verified items

`createCollection` has no duplicate-slug check though rename does, so `posts.id1/` and
`posts.id2/` coexist and first-match resolution is nondeterministic across hosts
(`schema/schema-store.ts:542-611`) · entry-delete order cleanup is a read-modify-write whose read
is outside the schema lock (`api/entries.ts:436-447`) · corrupt `branches.json` bricks listing
instead of regenerating (`branch-registry.ts:113-121`) · crash between `completeTask` and
`updateBranchMetadata` wedges `syncStatus`, fixed by flipping the order
(`worker/cms-worker.ts:720-723`) · crash-leftover `*.tmp` files are staged by submit's `git add .`
· `q=` silently ignored when `f=` is omitted, though the cache key carries it
(`assets/transform.ts:224`) · an entry slugged `all` is overwritten by the collection aggregate
(`ai/generate.ts:237,282`) · `flattenSchema` drops the root collection label so root label edits
persist but never display · `meta-loader` silently drops collections nested under plain
directories · `sync push --force` on a conflicted workspace exits 0 · ~~the dev content watcher
silently no-ops for a non-default `contentRoot`~~ (**fixed by #206 in
[PR #211](https://github.com/safeinsights/canopycms/pull/211)**, 2026-08-13 — `getContentRoot`
now receives the resolved root) · comment threads are branch-scoped only, so
branch access leaks comments on path-forbidden entries (`api/comments.ts:52`) · `renameEntry`
checks `edit` on the source path only · Clerk `authorizedParties` optional in prod · switching
back to a loaded entry sends raw unresolved reference IDs to the preview.

## B8. [P2] Decide `defaultBranchAccess` in the init template, deliberately

`config/schemas/config.ts:14` correctly defaults to fail-closed `'deny'`, but
`cli/template-files/canopycms.config.ts.template:4` sets `'allow'`, so every scaffolded project
opts out — as do all three apps. This is the precondition that makes B2 above reachable by any
authenticated user and that turns B4 into an allow-everything checker. "Secure by default" holds
for the schema and not for the generated project. Defensible for a frictionless first run, but it
should be a decision rather than an inheritance — at minimum a template comment saying what to
tighten before production.
