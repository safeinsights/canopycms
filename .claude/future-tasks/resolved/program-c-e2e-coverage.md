# Program C — E2E coverage sweep

**Part of:** [production-readiness-program.md](../production-readiness-program.md)
**Size:** L · **Status:** not started · **Runs parallel to B**

## The measured gap

Not "the last couple of epics" — **three and a half months**:

- The last e2e spec file *added* was `apps/test-app/e2e/tests/field-groups.spec.ts`
  at commit `e223a73`, **2026-04-12**. Every spec file in the suite predates it.
- Test-case count: **51 at `e223a73` → 52 on 2026-07-30**. One net new test.
- Only 3 commits have touched `apps/test-app/e2e/tests` since April, all on
  2026-07-24: stabilization fixes plus one string-list field test.
- In the same window ~60 non-merge commits landed in
  `packages/canopycms/src/editor` and `packages/canopycms/src/api` alone.

Reproduce the measurement:

```bash
git log --diff-filter=A --format='%ad %h' --date=short -1 <ref> -- <spec-file>
git grep -c -E "^[[:space:]]*test\(" <ref> -- apps/test-app/e2e/tests
```

## Approach

1. **Enumerate what shipped since `e223a73`.** Feature commits in `src/editor`,
   `src/api`, and `packages/canopycms-cdk` are the input list. Diff that against
   the 52 existing tests to produce an explicit coverage matrix — capability,
   covered yes/no, and if no, why it matters.
2. **Prioritise by "no manual fallback in production."** Prod has no shell and no
   EFS access, so admin-recovery and multi-editor paths are where an untested
   regression is unrecoverable. Highest priority:
   - admin System health panel (worker liveness, task retry/delete, branch-health
     repair, purge-to-trash)
   - branch sync/conflict badges
   - registry quarantine and corrupt-base degradation
   - persistent `rebaseFailure` records
   - mark-merged from approved
   - image upload → finalize → transform → MediaLibrary
   - permissions/groups editing
3. **Fill the gaps** as independent PRs into the integration branch, concurrent
   with B.

## Invariants to respect

From the git-admin-observability epic — future tests must not violate these:
fresh-UUID task requeue (dequeue dedup eats same-ID copies), trash age from the
NAME stamp not mtime, provisioning-lock rails are freshness-based not
presence-based, `withOccFileLock` is non-reentrant (release before `save()`),
`rebaseFailure` writes bounded hourly, worker-persisted error messages pass
`redactCredentials` before any HTTP surface serves them.

## Suite facts worth knowing before touching it

Read `apps/test-app/e2e/E2E-FAILURE-ANALYSIS.md` first. Key points:

- CI is 3-way sharded with per-runner isolation. In-process Playwright workers
  **cannot** work — all tests share one workspace and server.
- CI runs a prod server (`next build && next start`, `CANOPY_E2E=1`) in parallel
  with validate; total PR CI ≈ 3m55s, shards ~2m45s each.
- The prod-build path doubles as a client-bundle canary — it caught the same
  `node:fs`-in-editor-bundle regression from two different epics. Keep isomorphic
  helpers in dependency-free modules like `paths/branch-name.ts`.
- Local: `pnpm test:e2e` (dev server) or `E2E_PROD_SERVER=1 pnpm test:e2e` (prod
  server, ~3.3m).
- Gotchas that cost CI round-trips: pnpm forwards a literal `--` to scripts
  (breaks `--shard` pass-through); CI's detached-HEAD checkout makes dev-mode base
  branch fall back to `main`, so branch protection rejects creating a CMS branch
  named `main`.

## Verification

E2E green across **two back-to-back full runs without wiping `.canopy-dev`** —
the state-leak proof used on PR #151. Plus the standard per-PR gates.

## Definition of done

A written coverage matrix showing every capability added since 2026-04-12 is
either covered or consciously deferred with a reason, and the
no-manual-fallback-in-prod paths are covered.

---

# Implementation summary (resolved 2026-07-30)

Landed on `test/e2e-coverage-sweep` off `integration-202607-a`.

**Outcome:** suite went **52 → 97 tests**. The written coverage matrix is
[apps/test-app/e2e/COVERAGE-MATRIX.md](../../../apps/test-app/e2e/COVERAGE-MATRIX.md):
67 capabilities enumerated since `e223a73`, of which 4 were already covered,
43 were covered here, and 20 are deferred with a stated reason. **No capability
in the "no manual fallback in production" set is deferred.**

## Specs added (45 tests)

| Spec | Tests | Capabilities |
| ---- | ----: | ------------ |
| `admin-system-health.spec.ts` | 7 | worker liveness (alive/stale/absent), crash-loop window, queue stats, git-sync summary, unparseable status file, non-admin gating + 403 |
| `admin-task-recovery.spec.ts` | 6 | task listing by bucket, retry, delete, corrupt-file rows, empty states |
| `admin-branch-health.spec.ts` | 7 | health scan, repair, purge-to-trash + rails, rebase-failure indicator, mark-merged from approved |
| `branch-state-badges.spec.ts` | 8 | sync/conflict badges, protected-branch rails, status lock (UI + server 403), merged badge, approve, relative timestamps, sanitized names |
| `branch-degradation.spec.ts` | 3 | registry quarantine, corrupt base-branch degradation |
| `media-upload.spec.ts` | 8 | upload → finalize → transform → MediaLibrary, alt validation, replace-preserves-alt, library reuse |
| `permissions-groups.spec.ts` | 3 | group + permission round trips, admin gating |
| `draft-lifecycle.spec.ts` | 3 | save clears draft, discard-all pluralization, entries load with a restored draft |

New fixtures: `admin-workspace.ts`, `admin-page.ts`, `media-workspace.ts`,
`media-page.ts`, `settings-managers-page.ts`, additions to `branch-page.ts`, and
two PNG fixtures. `postSchema` gained an `image` field; the test app now wraps its
Next config with `withCanopy()`.

## Invariants pinned

Both are asserted in a way that fails if the invariant breaks:

- **Fresh-UUID requeue** — `admin-task-recovery.spec.ts` asserts the requeued task
  id differs from the original and that the original left `failed/`. A same-id
  copy would be eaten by dequeue dedup, making "Retry" a silent no-op.
- **Trash age from the NAME stamp** — `admin-branch-health.spec.ts` seeds an
  orphan with a 20-minute-backdated mtime, purges it, and asserts the trash
  name's stamp reads as *now*. An mtime-based sweep would misjudge retention.

The other invariants (freshness-based provisioning rails, non-reentrant
`withOccFileLock`, hourly-bounded `rebaseFailure` writes, `redactCredentials`
before HTTP) were respected but not all directly asserted — `redactCredentials`
runs at the write site, so the spec covers the display path only and says so.

## Defects found (filed, not fixed)

- [permission-manager-internal-groups-unreachable.md](permission-manager-internal-groups-unreachable.md) (P1 — RESOLVED 2026-08-12)
- [entry-create-modal-slug-reset-race.md](entry-create-modal-slug-reset-race.md) (P1)
- [e2e-harness-followups.md](../e2e-harness-followups.md) (P2) — incl. the settings
  workspace still not being reset between runs
- [e2e-deferred-coverage.md](../e2e-deferred-coverage.md) (P2) — the deferrals,
  grouped by what unblocks each

Fixed in place: the missing `withCanopy()` wrap (every public asset URL 404'd),
and `resetWorkspace()` now also resets `.canopy-dev/.tasks` and
`.canopy-dev/assets`.

## Verification

- **97 passed across two back-to-back full runs without wiping `.canopy-dev`**
  (5.4m / 5.6m) — the PR #151 state-leak proof.
- `pnpm typecheck` and `pnpm lint` clean across all 7 workspace projects.
- `pnpm test`: 3145 passed, 1 failed — the pre-existing P3 MDXEditor mount flake
  ([markdownfield-mdxeditor-mount-flake.md](markdownfield-mdxeditor-mount-flake.md)),
  which passes in isolation. Nothing under `packages/` was modified.
