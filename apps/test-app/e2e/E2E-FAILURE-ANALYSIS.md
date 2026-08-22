# E2E Failure Analysis (2026-07-24)

> **STATUS: ALL FIXES LANDED (same day, this branch).** Six fixes, each
> verified live and by suite runs:
>
> 1. `EditorPage.goto()` pins `/edit?branch=main` (fix option A).
> 2. `ReferenceValidator` resolves schema-declared collection names via
>    `ContentStore.resolveCollectionItem` (the same normalization the
>    reference-options dropdown uses) — reference saves 200 where they 422'd.
> 3. `ReferenceValidator` treats `''` as a cleared reference (the editor sends
>    `''` when a single-select is cleared) instead of 422 "Invalid content ID
>    format".
> 4. `listBranchesHandler` returns a sanitized `defaultBranch` that matches
>    registry branch names.
> 5. `cms-worker.ts` rebase/refresh compares against `FETCH_HEAD` instead of
>    `origin/<base>` — workspaces are `--single-branch` clones, so on any
>    checkout whose git HEAD isn't the compared base, `origin/<base>` never
>    exists and every sync died with "ambiguous argument 'HEAD..origin/main'"
>    (this is what kept the conflict badge from ever appearing).
> 6. E2E fixtures: `pushConflictingChangeToMain` force-pushes (remote.git is
>    preserved across runs while `main` is re-cloned fresh, so plain push hits
>    non-fast-forward rejections from prior-run history), and
>    `entry-crud.spec.ts` only expands the Posts collection when the navigator
>    hasn't already auto-expanded it (EntryNavigator auto-expands the path to
>    the restored current entry — an unconditional click toggled it closed).
>
> Result: **49 passed / 2 failed / 1 skipped** on a pristine-workspace full
> run from this non-`main` worktree (was **35/16/1**), and every previously
> failing spec passes in isolation. The 2 residual failures are a distinct
> PRE-EXISTING intermittent race, not one of the classes fixed here: an
> mtime-based OCC 409 ("modified by another editor") when saving immediately
> after branch create/switch — which test hits it varies per run and it never
> reproduces in isolation. Filed as
> `.claude/future-tasks/resolved/e2e-occ-save-race-after-branch-create.md` with
> the established mechanism and suspects. **RESOLVED 2026-07-25**: root cause
> was client-side (a stale-key bug in `useEntryManager.ts`'s OCC version map),
> fixed there — see that file for detail. Other remaining follow-ups: console
> noise (§6), CI gating (§7).

Handoff brief for a follow-up session. Captures why `pnpm test:e2e` currently
fails a large batch of tests, the confirmed root causes, ranked fix options, and
the console-noise + CI-gating context that came up alongside it.

**TL;DR — there are TWO root causes, both verified by live experiment (§0):**

1. **Branch mismatch (harness assumption, ~10 tests):** the suite implicitly
   assumes **the dev server's git checkout is on branch `main`**. When it isn't
   (a worktree, a feature branch, an integration branch), the editor edits a
   different content branch than the tests read, so "edit → save → read the
   file on disk" assertions see the untouched seed value. Fix belongs in the
   test harness (pin the branch), not the app.
2. **Reference-save product bug (branch-INDEPENDENT, 3 tests):** the server's
   write-boundary reference validator rejects every reference save whose schema
   uses the documented `collections: ['posts']` convention with **422**
   ("Entry is in collection \"content/posts\", but only [posts] are allowed").
   It compares the ID-index's root-prefixed collection _path_ against the
   schema's unprefixed collection _name_. This fails on git `main` too —
   pinning the branch will NOT fix `reference-fields.spec.ts`. Real bug in
   `packages/canopycms/src/validation/reference-validator.ts` (~lines 100–115,
   169–181), masked in unit tests by root-prefixed fixtures.

## 0. Live verification (2026-07-24, later session)

A second session re-verified the first analysis by experiment against a running
dev server started from this worktree (git branch
`claude/test-output-noise-audit-9c7d34`), not just by code reading:

- `GET /api/canopycms/branches` returned
  `defaultBranch: "claude/test-output-noise-audit-9c7d34"` — the **raw git
  HEAD name** — while the branch list contained the sanitized CMS names
  `["claude-test-output-noise-audit-9c7d34", "main"]`. Root cause 1 confirmed
  at the API level. (Bonus wart: the raw name doesn't match ANY registry
  branch name, so `useBranchManager`'s `branches.find(b => b.name ===
branchName)` yields `currentBranch = undefined`; content APIs still work
  because the server sanitizes the branch segment when resolving the
  workspace dir. Consider returning the sanitized registry name from the API.)
- `PUT /api/canopycms/<defaultBranch>/content/home` with a changed title →
  **200**, and the write landed in
  `content-branches/claude-test-output-noise-audit-9c7d34/content/home...json`
  while `main/content/home...json` kept the seed. Exactly the failing tests'
  signature.
- Reference save replicated via API on BOTH branches: create a post (200),
  then `PUT .../content/home` with `relatedPost: <new post id>` → **422** with
  the collection-mismatch error, identically on the git-named branch and on
  `main`. So the 3 `reference-fields` failures die inside `saveAndVerify`
  (its `waitForResponse` predicate requires status 200; a 422 never matches →
  10s timeout), and they will keep failing after the branch fix.
- Convention check: README (`collections: ['authors']`, `['posts']`) and
  `apps/example1/app/schemas.ts` (`collections: ['authors']`) both use
  unprefixed names; `reference-validator.test.ts` fixtures use prefixed
  `'content/data-catalog'` — which is why 2900+ unit tests pass while the real
  write path 422s. When fixing, normalize against the configured `contentRoot`
  (don't hard-code `'content/'`), fix the unit fixtures to the documented
  convention, and add a regression test using `collections: ['posts']`.

---

## 1. How to reproduce

```bash
# From a git checkout that is NOT on branch `main` (e.g. this worktree,
# which is on claude/test-output-noise-audit-9c7d34):
pnpm test:e2e
```

Result on a clean workspace (no pre-existing `.canopy-dev/`):
`16 failed | 1 skipped | 35 passed (7.5m)`.

Running the same suite from a checkout that _is_ on git branch `main` is
expected to pass the 13 "core" failures below (unverified — worth confirming as
step 1 of any fix).

The workspace is ephemeral and gitignored: `apps/test-app/.canopy-dev/`
(bare `remote.git` + `content-branches/<branch>/`).

## 2. The failing tests

**Root cause 1 — branch mismatch (save lands off-`main`), ~10:**

- `editor-happy-path.spec.ts:51` — complete edit workflow: load → select → edit → save → verify
- `field-types.spec.ts:26,164,199,217,234,252` — text/multi-field/unicode/empty/large/rapid edits
- `field-groups.spec.ts:83,117` — group fields saved flat in content / no sibling clobber
- `yaml-format.spec.ts:62` — edit and save YAML entry writes valid YAML to disk

**Root cause 2 — reference-validator 422 (branch-independent product bug), 3:**

- `reference-fields.spec.ts:65,111,139` — single/clear/multi reference persist.
  These die inside `saveAndVerify` (`waitForResponse` 10s timeout) because the
  PUT returns **422**, not 200 — see §0. Fixing the branch mismatch will not
  clear these; fix `reference-validator.ts` collection normalization.

**Verify separately — may be the same root cause or distinct, ~3:**

- `branch-workflow.spec.ts:112` — submit and withdraw flow (this one _moved_ between runs: the earlier log failed `:215` instead — smells partly flaky/ordering)
- `conflict-management.spec.ts:41` — conflict badge visible after rebase (waits 30s for `[data-testid="conflict-badge"]`; likely a cascade of the branch mismatch during its rebase setup, but confirm)
- `entry-links.spec.ts:164` — selecting an entry inserts markdown link (MDX editor interaction; could be genuinely separate UI)

The passing 35 include every test that verifies **via UI reload** rather than by
reading the content file (e.g. `editor-happy-path.spec.ts:76` "edited value
persists after page reload", all of `draft-behavior`) — a key discriminator (see
§4).

## 3. Root cause 1: branch mismatch (confirmed by live experiment, §0)

The dev operating mode **auto-detects the active branch from git `HEAD`**, and
the editor opens that branch by default. The tests hard-code a content branch
literally named `main`. When git `HEAD` ≠ `main`, these diverge.

Code trail:

1. **Dev mode detects the branch from git HEAD.**
   `packages/canopycms/src/services.ts` — `createActiveBranchDetector()`:

   > "In dev mode, auto-detect from the current git HEAD branch."

   ```
   const branch = await detectHeadBranch(process.cwd(), config.defaultBaseBranch ?? 'main')
   ```

   The same file even warns that this "varies depending on the developer's
   working branch" and pins both branch fields **in unit tests** to avoid it —
   but e2e runs the _real_ dev server, so nothing pins it there.

2. **The branches API returns that as `defaultBranch`.**
   `packages/canopycms/src/api/branch.ts:204`

   ```
   const defaultBranch =
     ctx.services.config.defaultActiveBranch ?? ctx.services.config.defaultBaseBranch ?? 'main'
   ```

   (`defaultActiveBranch` is reassigned per-request from git HEAD via
   `services.refreshActiveBranch()`.)

3. **The editor adopts `defaultBranch` when no branch is pinned.**
   `packages/canopycms/src/editor/hooks/useBranchManager.tsx:201`

   ```
   if (!branchName && result.data?.defaultBranch) setBranchName(result.data.defaultBranch)
   ```

   Initial branch resolution: `packages/canopycms/src/editor/CanopyEditorPage.tsx:14`

   ```
   searchParams?.branch ?? config.defaultActiveBranch ?? config.defaultBaseBranch
   ```

4. **The test navigates to `/edit` with no branch param**, so it inherits the
   git-HEAD branch: `apps/test-app/e2e/fixtures/editor-page.ts` → `goto()` does
   `page.goto('/edit')`.

5. **But the test reads/writes the `main` tree**:
   `apps/test-app/e2e/fixtures/test-workspace.ts` — `ensureMainBranch()` creates
   a CMS branch named `main`, and `getContentFilePath()` reads
   `.canopy-dev/content-branches/main/content/...`.

Net: Save PUTs to `/api/canopycms/<git-branch>/content/...` (200 OK, writes that
branch's tree), while assertions read `main/content/...`, which still holds the
seed.

The test-app config does **not** pin the branch:
`apps/test-app/canopycms.config.ts` sets `mode: 'dev'` with no
`defaultActiveBranch` / `defaultBaseBranch`.

## 4. Evidence

- Clean-workspace run (this worktree, git branch `claude/…`): same 16 failures
  as the user's run from their main checkout → **not** cross-run state rot.
- `branches.json` after a run shows two branches: `main` (createdBy a dev user)
  and `claude-test-output-noise-audit-9c7d34` (createdBy `canopycms-system`,
  `baseBranch: "claude/test-output-noise-audit-9c7d34"`) — the git-derived one.
- Failing assertions read the _seed_: `expect(content.title).toBe("Test-Title-…")`
  → `Received: "Home Page"`; tagline → `Received: "Welcome to the test app"`.
  On disk `main/content/home.home.bo7QdSwn9Tod.json` = the seed.
- `saveAndVerify()` (editor-page.ts) waits for a **PUT … 200** and gets it — the
  save _succeeds_, just on the other branch.
- **Discriminator:** tests that verify via **UI reload pass**; tests that **read
  the content file fail**. Reload shows the branch the editor is on; the file
  read looks at `main`. Exactly the branch-mismatch signature.
- Reference-field failures surface as `page.waitForResponse` 10s timeouts rather
  than a value mismatch — RESOLVED: it IS a second issue; the PUT returns 422
  from the reference validator on any branch (see §0).

## 5. Fix options (ranked)

**A. Pin the editor to `main` in the e2e harness (recommended — surgical, test-only).**
Make `EditorPage.goto()` navigate to `/edit?branch=main`. Verified wiring: the
test-app's `/edit` page uses `NextCanopyEditorPage` (`packages/canopycms-next/
src/client.tsx`), which reads `?branch=` via `useSearchParams` and forwards it
as `searchParams.branch` — and every editor navigation funnels through the one
`EditorPage.goto()` (the param is honored
at `CanopyEditorPage.tsx:14`). Confirm every other navigation that expects to
edit `main` also pins it. Pro: no app/config change; deterministic regardless of
the developer's git branch. Con: must audit all navigations.

**B. Pin the branch in the test-app config used by e2e.**
Set `defaultActiveBranch: 'main'` (and/or `defaultBaseBranch: 'main'`) in
`apps/test-app/canopycms.config.ts`. An explicit `defaultActiveBranch` is _not_
overridden by git detection (`services.ts` keeps `explicitActiveBranch`). Pro:
one line, fixes all navigations at once. Con: changes the test-app's dev
behavior generally (e.g. manual `pnpm dev` on a feature branch would now default
to `main`). Could be gated behind an env var the config reads (e.g. only when
`process.env.CANOPY_E2E` is set).

**C. Make the tests branch-agnostic.**
Have the fixtures read the server's `defaultBranch` and use that path instead of
hard-coding `main`. Pro: tests reflect real behavior. Con: larger change; the
tests also _create_ `main` explicitly, so several call sites move.

Do **not** "fix" this in the app — dev-mode git-HEAD detection is intentional and
documented. The fragility is the test suite's assumption.

**Verify a fix:** re-run `pnpm test:e2e` from a **non-`main`** git branch and
expect the ~10 root-cause-1 failures to clear (reference-fields stays red until
the validator fix lands). Then re-check the 3 "verify separately"
tests; anything still red is a distinct bug.

## 6. Console noise in the e2e run (separate cleanup)

Unlike unit tests, e2e "noise" is the **dev server's** stdout/stderr, forwarded
by Playwright's `[WebServer]` prefix — `mockConsole()` does not apply. Sources
seen:

- Next.js startup warning: _"inferred your workspace root… multiple lockfiles"_
  (the worktree adds a second `pnpm-lock.yaml`). Fix: set `outputFileTracingRoot`
  in the test-app's Next config.
- `CanopyCMS: Unhandled error in API request handler: fatal: --local can only be
used inside a git repository` and `… fatal: Unable to read current working
directory: No such file or directory` — git commands racing the workspace
  reset (`resetWorkspace()` deletes the tree out from under an in-flight request).
  Real robustness gap; worth handling, not muting.
- `Failed to sync <branch>: fatal: ambiguous argument 'HEAD..origin/main'` — no
  `origin/main` in a worktree/standalone checkout.

Levers: fix the genuine errors above; optionally quiet routine output via
Playwright `webServer.stdout: 'ignore'` (keep `stderr` visible). Prefer fixing
over blanket-suppressing so real server errors still surface.

## 7. CI / gating context (Q2)

- The e2e CI job is currently **disabled**: `.github/workflows/ci.yml` job `E2E
Tests` has `if: false # temporarily disabled while stabilizing tests`. That is
  why these failures go unnoticed.
- A local run takes **~7.5 min** on a fast Mac (single worker; `fullyParallel:
false` because all tests share one workspace + server). CI runners are slower
  and the config sets `retries: 2` on CI, so a flaky/failing run can be much
  longer.
- Options discussed for making e2e actually catch regressions:
  1. Stabilize (this doc) → re-enable as a required PR check. Safest, slowest PRs.
  2. **Run on `push: main` only** (post-merge), non-blocking, failing check +
     notification. User was receptive to this — catches regressions on main
     without gating feature PRs.
  3. Opt-in required check via a PR label.
  4. Manual attestation (weak; pair with one of the above).
- **MEASURED (2026-07-25, run 30137416007 on this branch):** the e2e job was
  re-enabled and passed on a stock ubuntu runner:
  - E2E job wall-clock: **10m 51s** (setup ~43s — pnpm cache hit; Playwright
    browser cache was cold this run and is now saved; `pnpm test:e2e` itself
    **9m 58s**, suite reported 9.9m).
  - Result: **51 passed / 1 skipped / 0 failed / 0 flaky** — first-try green
    on CI, including the tests affected by the intermittent OCC race locally.
  - Validate job: 3m 20s. With `needs: validate` (serial, as configured),
    total PR CI latency ≈ **14m 16s**; dropping `needs` would run them in
    parallel for ≈ 11m total.
  - Decision inputs: per-PR gating costs ~11 min/PR; run-on-`main` post-merge
    costs 0 PR latency and surfaces regressions within ~11 min of merge. The
    job is currently enabled unconditionally on this branch — re-scope (or
    keep) before/at merge.
- **FINAL MEASURED SHAPE (2026-07-25, run 30140156141) — after the speed
  batch** (cheap in-place workspace reset; `next build && next start` on CI;
  3-way CI sharding with merged blob reports):
  - Local full suite: **3.3m** vs prod server (was 4.6m with cheap reset +
    dev server, 7.5m originally).
  - CI per shard: **~2m 45s** wall-clock each, all three in parallel
    (includes setup, `next build`, and its slice of tests: 2.1m / 1.8m /
    1.7m test phases; 20+19+12 = 51 passed, 1 skipped, 0 failed/flaky
    first-try). Merge-report job: ~30s, non-blocking.
  - With `needs: validate` removed (landed right after this run), e2e no
    longer waits for validate: **total PR CI latency ≈ max(validate ~4m,
    shards ~2m45s + merge 30s) ≈ ~4m** — down from 14m16s at first
    measurement.
  - The prod-server path immediately caught a real client-bundle regression
    (node:fs in the editor bundle via protected-branch imports — would have
    broken adopters' `next build`), partially covering the dual-build-ci.md
    (P1) gap.
  - Two CI-only harness gotchas fixed en route: pnpm forwards a literal
    `--` to scripts (Playwright read `--shard` as a file filter → "No tests
    found"), and CI's detached-HEAD checkout makes the git base branch fall
    back to 'main', so branch protection rejects the harness's explicit
    "create main" (now treated as the auto-provisioned base workspace).
- **RE-MEASURED (2026-07-30, run 30589885335) — after the coverage sweep took
  the suite 52 → 97 tests.** Sharding was raised 3 → 4 on the strength of these
  numbers:
  - 3-shard wall-clock: 3.5m / 3.82m / 3.92m (spread only 25s — `--shard`'s
    count-based split balances fine in practice; per-file durations vary a lot
    but average out). Validate: 4.1m. Merge report: 0.55m, serialized after the
    shards. Total PR latency **4.43m**, i.e. e2e had become the critical path.
  - **Per-shard fixed overhead is ~2m, not ~40s.** Step breakdown of one shard:
    ~48s of setup/post steps, and the "Run E2E tests" step's 184s _includes_
    ~70s of `canopycms-next build` + `next build` before the server binds. Only
    the remaining ~115s is actual test execution.
  - Model that fits the observed data: `wall ≈ 118s + 1.09 × local_test_time`
    (predicts 3.9m for the slowest shard vs 3.92m measured).
  - Consequence: **validate is the floor.** 5–6 shards, or pinning specs to
    shards by duration, all land on it and buy nothing further. Don't shard
    past 4 without first speeding up validate.
  - **CONFIRMED at 4 shards (run 30590540192; re-verified via `gh` 2026-07-31
    — the run id originally recorded here, 30590565843, resolves to nothing on
    GitHub):** shards 2.57 / 2.58 / 2.62 / 3.05m, merge 0.57m, validate 3.88m.
    E2E path 3.62m — _under_ validate, so validate is again the critical path.
    Total PR latency **4.47m → ~3.9m** (better than the ~16s predicted; the
    split landed more evenly than the count-based model assumed).
    Run-to-run variance on validate is ~5%, so treat these as ±10s.
  - Deliberately NOT done: pinning specs to shards via explicit per-shard file
    lists. It would save ~15s and introduce a silent-coverage-hole failure mode
    (a new spec file assigned to no shard never runs, and nothing fails).
  - The real lever is the ~70s `next build` paid once per shard — more shards
    make that worse in aggregate. See
    `.claude/future-tasks/e2e-build-once-share-artifact.md`.

## 8. Related harness notes (lower priority)

- `resetWorkspace()` (test-workspace.ts) wipes `content-branches/` but preserves
  the bare `remote.git` across tests and runs by design (recreating it is
  expensive). Not the cause of the current failures, but it does mean
  `remote.git` can drift across many runs — keep in mind if push/rebase tests
  act up after heavy local iteration.
- The dev base snapshot clones **all of `apps/test-app`** (including `e2e/…`
  specs) into each content branch working tree. Harmless here, but it is why a
  content-wide `grep` for test values matches the spec files.
