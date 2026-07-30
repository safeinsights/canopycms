# Production-Readiness Program — Log

Append-only. Newest entries at the bottom. One entry per working session that
learned something worth carrying forward.

**What belongs here:** surprises, disproven assumptions, deploy-proven facts,
decisions and the reasoning behind them, measurements, and dead ends (so nobody
re-walks them). **What does not:** routine progress narration, or anything
already captured in a workstream file or a PR description.

**Entry format:**

```
## YYYY-MM-DD — [workstream] short title

- Fact, finding, or decision. Cite files/commands where it was established.
```

---

## 2026-07-30 — [program] Baseline survey before kickoff

Established by direct inspection of `canopycms`, `docs-site-proto`,
`safeinsights/website@v2`, `iac`, and `canopy-deploy-test`.

**Release channel is the hidden blocker.** `publish.yml` fires only on push to
`main`, so the 55 commits on `integration-202607-a` (git/admin observability
#163, UX fixes #164, e2e stabilization #151, client-bundle lint guard #166) exist
in no published version. Any adopter consuming from npm is on 0.0.60 and cannot
see them. On `main` the e2e CI job is still `if: false`; it is enabled only on the
integration branch.

**npm prerelease semantics (checked, not assumed).** Publishing with a non-`latest`
dist-tag cannot reach adopters accidentally: `npm install <pkg>` resolves
`latest`, and npm semver excludes prerelease versions from range matching unless
the range itself names a prerelease at the same major.minor.patch. `^0.0.60`,
`0.0.x`, and `*` will never resolve `0.0.61-int.3`. The only cost is cosmetic —
prerelease versions remain visible in `npm view <pkg> versions`.

**E2E coverage gap is 3.5 months, not "the last couple of epics."** The last e2e
spec file *added* was `apps/test-app/e2e/tests/field-groups.spec.ts` at `e223a73`
on **2026-04-12**; every spec predates it. Test-case count went **51 → 52**
between then and 2026-07-30 — one net new test — while ~60 non-merge commits
landed in `packages/canopycms/src/editor` and `src/api` alone. Only 3 commits
touched `e2e/tests` since April, all on 2026-07-24 (stabilization plus one
string-list field test). Any coverage audit should start from `e223a73` and work
forward, not from the most recent epics.

**Neither adopter has ever deployed the editor backend.** `docs-site-proto`
declares `canopycms-cdk` as a dependency and imports it nowhere; its
`infrastructure/lib/` has zero references to Lambda or EFS. `website@v2` has no
`infrastructure/` and no `.github/` at all. Both run `mode: 'dev'`.

**Two-deployments-one-repo hazards (by inspection, not yet hit).**
`deploymentName` defaults to `'prod'` and is only ever set in the adopter's static
config file, so two prod-mode stacks against one GitHub repo would both use
settings branch `canopycms-settings-prod`. The namespacing mechanism exists
(`canopycms-settings-{deploymentName}`) but is opt-in, absent from the CLI
template, and unmentioned in `docs/deploying-to-aws.md`. Content branches have no
equivalent mechanism at all — two deployments where editors pick the same branch
name produce a non-fast-forward push rejection (no `--force` anywhere in the push
path, so no silent data loss) surfacing as a stuck task with no automated
recovery.

**docs-site-proto's branch → environment model.** Selection is by branch *prefix*:
`testing-main`→testing/dev, `testing-production`→testing/prod,
`testing-staging-*`→testing/staging; `main`→official/dev, `production`→official/prod,
`staging-*`→official/staging. The teams use `dev-docs.sandbox…` off `testing-main`.
`main` has been stale since February because it targets `official` mode, which has
never been deployed. `cdk.json` defines exactly two modes and three environments
each (`dev`, `staging`, `production`) — there is no `dev-staging` key anywhere in
the repo.

**official mode maps onto the real SafeInsights accounts.** build `767397792557`
(Security), dev `872515273917`, staging `867344442985`, production `533267019973`
— matching `iac/lib/definitions.ts`. `iac` itself contains no docs-site infra at
all, deploys via CodeBuild + Jenkins rather than GitHub Actions OIDC, and uses
Secrets Manager exclusively with a `${namePrefix}Secrets-${envSlug}` convention.

**APPROACH.md already anticipates Canopy, but three phases were never built.** The
dual-branch model (content editors PR into the content branch; developers into the
code branch) is documented and the deploy workflows match it. Missing: the
`production → main` auto-sync PR workflow with circular-sync detection (exists
only as a proposal in `APPROACH-implementation-ideas.md` Phase 3), CODEOWNERS and
branch protection (Phase 4), and Canopy `targetBranch` wiring (Phase 5).

**Documented-vs-real drift in docs-site-proto.** README claims
build-once-deploy-many, but `deploy-reusable.yml` runs a fresh `npm run build` on
every deploy. Promotion is `updateDistributionOriginPath()` re-pointing CloudFront
at `builds/{sha}` — and it stamps the new path onto **every** origin, which will
404 all assets the moment an asset origin is added. That fix must land before any
asset origin exists anywhere.

**PR previews are the safety valve.** `deploy-preview.yml` fires on every pull
request into a separate Basic-Auth preview distribution, with deployment mode
detected from the base branch. This is what lets the Canopy version upgrade be
validated without merging to `testing-main`.

**Both sites are pinned to Next 16.1.x** by the same Turbopack/PostCSS fork-bomb
regression, currently recorded as prose in two separate CLAUDE.md files rather
than as a package-level constraint.

**Could not verify live AWS state.** Only the `sandbox-admin` profile is
configured locally and its SSO token is expired, so the current status of
`canopy-cms-deploy-test`, the `CDKToolkit-canopy` bootstrap, and the
`docs-site-proto` stacks is unknown. Workstream D must inventory before
destroying. `canopy-deploy-test`'s working tree is also dirty with uncommitted
split-page (`page.server` / `page.static`) work that needs resolving first.

## 2026-07-30 — [C] E2E coverage sweep: 52 → 97 tests, and what the gap was hiding

**The measurement reproduced exactly.** Last spec file added: `field-groups.spec.ts`
at `e223a73`, 2026-04-12. 51 test cases then, 52 at `c991216`. All 12 pre-existing
spec files predate the baseline.

**The gap was hiding three real defects.** None was findable by unit tests, because
each lives at a seam no unit test crosses:

1. **The test app never called `withCanopy()`** in its `next.config.mjs`, so the
   `/assets/:path*` → `/api/canopycms/assets/raw/assets/:path*` rewrite was never
   registered. Every public asset URL — MediaLibrary thumbnails, ImageField
   previews, every `/assets/t/{directives}/...` transform output — 404'd in the
   harness. `apps/example1` wraps correctly; the test app never did. The asset
   epic shipped in July with no e2e exercising a single asset URL, so nothing
   noticed. Note the shape of this: the *harness* was misconfigured in exactly the
   way an adopter could be, and the product looked fine.
2. **Internal groups are unreachable from the Permission Manager.** The "Add
   Groups" picker reads `authPlugin.listGroups()` (external groups only), never
   `groups.json` — so a group created in Manage Groups can never be assigned a
   path permission, even though `authResultToCanopyUser` merges both kinds into
   `user.groups` and authorization treats them identically.
3. **`EntryCreateModal` can silently write the wrong filename.** Its slug-reset
   effect is keyed on the `entryTypes` array identity; a stray parent re-render
   between typing a slug and submitting reverts it to `untitled`. ~1 in 8 under
   suite render pressure, never in isolation, and no error is surfaced.

**Two state-leak sources existed that the PR #151 two-run proof would not have
caught**, because nothing wrote to them yet: `resetWorkspace()` reset
`content-branches/` but neither `.canopy-dev/.tasks` nor `.canopy-dev/assets`.
Both are now reset. A third — the settings workspace holding permissions and
groups — is still not reset; `permissions-groups.spec.ts` clears its own slice
via the API. Any future spec that writes a new kind of workspace state must add
its own reset, or the two-run gate silently stops proving anything.

**Dev-mode has no worker, so admin observability had to be seeded on disk.** The
task queue, `.worker-lock`, `worker-status.json`, and corrupt/orphan branch
directories are all written directly by fixtures (`admin-workspace.ts`) rather
than through new endpoints — deliberately, to keep the production request surface
unchanged. The app still has exactly one test-only route (`/api/e2e-test/rebase`).

**`branch.json` on disk is an OCC envelope**, `{schemaVersion, version, writeId,
branch: {...}}` — not bare `BranchMetadata`. A fixture that patches the top level
writes fields that the API and components never read, and the tests pass for the
wrong reason. Cost half a debugging cycle; worth knowing before writing any
metadata fixture.

**The base branch is not `main` in a worktree.** With no `defaultBaseBranch` set,
dev mode derives it from git HEAD, so the protected/base branch is a directory
named after the sanitized git branch, while the fixtures' `main` is an ordinary
content branch. On CI's detached HEAD it falls back to literal `main`. Any
protected-branch assertion must discover the base branch at runtime from
`GET /branches` (`isProtected`), never hardcode it. Both spec-writing sessions
hit this independently.

**Deferred with reasons, not silently.** 20 of 67 capabilities are deferred; every
one is covered at the layer where its logic lives, is not browser-reachable (CLI,
CDK, build shapes), or needs a fixture investment of its own. The grouped list is
in `e2e-deferred-coverage.md`; the per-capability reasoning is in
`apps/test-app/e2e/COVERAGE-MATRIX.md`. Nothing in the "no manual fallback in
production" set is deferred.

**Two invariants from the git-admin-observability epic are now pinned by
assertions that fail if the invariant breaks**, not merely by tests that happen to
pass: task requeue must mint a fresh UUID (a same-id copy is eaten by dequeue
dedup, so "Retry" would silently do nothing), and trash retention must parse the
NAME stamp rather than mtime (`rename()` preserves mtime, so an mtime-based sweep
would delete a stale orphan's trash on the first pass).

**Cost and shape.** Full suite is now 97 tests in ~5.5m locally against the prod
server (was 3.0m for 52). CI's 3-way shard should stay near its ~2m45s/shard.
Playwright's `webServer` now builds `canopycms-next` first (~5s) because
`withCanopy` ships from `dist/`.

**One pre-existing unit flake is not ours**: `MarkdownField.test.tsx`'s MDXEditor
mount fails intermittently under full-suite load and passes in isolation —
already filed as `markdownfield-mdxeditor-mount-flake.md` (P3).
