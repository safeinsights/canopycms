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

## 2026-07-30 — [A] Prerelease channel shipped; npm and Actions behaviours that shaped it

Established by building the channel and publishing `0.0.61-int.74` for real
([run 30586482757](https://github.com/safeinsights/canopycms/actions/runs/30586482757)).
Every claim below was executed, not read.

**npm allows exactly one trusted publisher per package, bound to a *workflow
filename* — and this dictated the design.** All five packages are bound to
`publish.yml`; there is no `NPM_TOKEN` in the repo (`gh secret list` shows only
`RELEASE_BOT_PRIVATE_KEY`), so publishing is pure OIDC. A standalone
`publish-prerelease.yml` therefore could not have authenticated, and re-pointing
npm at it would have broken stable releases. The escape hatch is in npm's own
docs: for `workflow_call`, **validation checks the calling workflow's name**, not
the workflow containing `npm publish`. So `publish-prerelease.yml` is a reusable
workflow invoked by `publish.yml`, and every publish enters through `publish.yml`.
Verified working end-to-end. Consequence for anyone adding a third channel: it
must also route through `publish.yml`, or the npm settings for all five packages
must change together. `id-token: write` is required on both caller and callee.

**`workflow_dispatch` does *not* require the trigger to exist on the default
branch — only the workflow *file* does.** Expected this to be a blocker
(main's `publish.yml` has no `workflow_dispatch`) and planned to merge the CI
change to `main` first. Unnecessary: `gh workflow run publish.yml --ref
feat/prerelease-publish-channel` succeeded, because `publish.yml` exists on
`main` and the trigger is read from the *target* ref. `--ref main` correctly
fails 422 today, since main's copy has no dispatch trigger. **So no merge to
`main` was needed to ship or verify this.** The in-workflow "refuse to publish
from main" guard is what matters once this does reach `main`.

**A caret in front of a prerelease drifts — this bit, and was caught only by an
end-to-end test.** `npm install <pkg>@<exact-prerelease>` rewrites `package.json`
with npm's default `^` prefix, silently converting an exact pin into a range.
`^0.0.61-int.74` matches any later prerelease of `0.0.61` **and** stable
`0.0.61`. Adopter pins need `--save-exact`. This is the one sharp edge in the
whole prerelease story.

**The "prereleases are invisible to normal installs" claim is stronger than
recorded.** Confirmed with the `semver` library and against the live registry:
`^0.0.60`, `0.0.x`, `*`, `~0.0.60` **and `^0.0.61`** all fail to match
`0.0.61-int.42`. The last one matters — even after `main` releases `0.0.61`,
adopters on ranges still cannot resolve a `0.0.61-int.*` build. Only an exact
pin or the `int` dist-tag reaches one.

**`workspace:*` makes `@int` a coherent set for free.** `pnpm pack` resolves it
to the exact local version, so `canopycms-next@int` declares
`peerDependencies.canopycms: "0.0.61-int.74"` rather than pointing at the stable
channel. No extra wiring needed.

**`github.run_number` is per-workflow-file, and that is the right counter here.**
Because both channels enter through `publish.yml`, the counter is shared and
monotonic across stable and prerelease runs — hence the first prerelease being
`int.74`, not `int.1`. The gaps are harmless; monotonicity is what matters, and
npm compares numeric prerelease identifiers numerically (`int.42` > `int.5`).

**`npm view <pkg>@<tag>` exits non-zero (E404) when the tag doesn't exist**, so
any script resolving a dist-tag must catch rather than parse empty output.

**Multi-package publishes and `cancel-in-progress: true` are a bad combination.**
`publish.yml`'s concurrency would have let a superseding run cancel a prerelease
part-way through five sequential publishes, moving the `int` tag for some
packages and not others. Now scoped by event, cancelling only on `push`. The
same latent hazard exists for stable releases on rapid merges to `main`; left
alone as out of scope, but it is real.

**Not done deliberately:** no `push` trigger on `integration-*`. Publishing on
demand keeps the prerelease version list short, which is the only real cost of
this scheme.

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

## 2026-07-30 — [B] Canopy hardening: what the adversarial review changed

Run as an epic on `epic/canopy-hardening` (7 PRs: #168, #169, #170, #174, #176,
#177, #178, #180, #181). Established by reading the code and by reproduction,
not by trusting the workstream file.

**The design review found a data-loss bug the design was about to build on.**
`syncGit()` fetched GitHub with `+refs/heads/*:refs/heads/*` and `--prune`
straight into `remote.git` — which is not a throwaway mirror but the
deployment's local origin, the thing the Lambda pushes editor work INTO and
branch clones are cloned FROM. Reproduced with real git, two failure modes: a
branch pushed to `remote.git` but not yet on GitHub is **deleted** by `--prune`
(the later push task then fails `src refspec does not match any`, is classified
transient, burns 3 retries, and lands as `sync-failed` with the reason
discarded); and a branch already on GitHub where `remote.git` is ahead is
**force-rewound**, after which the worker's push prints `Everything up-to-date`,
**exits 0, and the task COMPLETES SUCCESSFULLY** while the commit never reaches
GitHub. The branch reports `synced`. `syncGit()` also runs at worker startup
*before* the task queue, so every restart began by destroying whatever the
Lambda pushed while the worker was down. Fixed by fetching into
`refs/remotes/github/*` and reconciling `refs/heads/*` non-destructively.
**Content was never lost — the branch clone on EFS still held the commits — but
a publish was silently dropped while the UI reported success.**

**Open decision #1 was settled by an architectural constraint, not a
preference.** The CMS Lambda runs in `PRIVATE_ISOLATED` subnets with no NAT, so
a synchronous "does GitHub have this branch?" call at create time is
**impossible**; that alone rules out one whole family of designs. What makes
detection viable anyway is that `remote.git` is a mirror of GitHub's refs AND
the Lambda and worker resolve it to the same EFS inode (the Lambda mounts the
`WorkspaceAP` access point — already rooted at EFS `/workspace` — at `/mnt/efs`,
while the worker mounts the filesystem root and reaches the same directory at
`/mnt/efs/workspace`). Detect-and-surface won over prefix-per-deployment
because prefixing is blind to the *likelier* collision (a human pushing that
branch name, or a branch left by an earlier deployment), only works if the two
deployments are configured differently — the very hazard being removed — and
changes user-visible branch names for every single-deployment adopter.

**`deploymentName` was three-quarters non-functional before this.** Four
independent readers disagreed: the strategies, `api/settings-helpers.ts` (which
never passed `deploymentName`, so it always computed the default),
`http/handler.ts` (a third hardcoded default with no suffix), and
`getConfigDefaults()` (a mode-blind `'prod'`). Precedence is now
**env > config > mode default**, env winning deliberately: the env var is
stamped per-stack and is the value guaranteed to *differ* between two
deployments, while `config.deploymentName` lives in the shared repo and is
guaranteed to be *identical*.

**Changing the settings-branch name silently wiped ACLs.** With an existing
settings workspace, `createOrphanSettingsBranch` ran `checkout --orphan` +
`rm -rf .` + an empty commit — orphan branches share no history, so
permissions.json and groups.json were destroyed with nothing to recover from.
Now refused at boot. Decision: refuse loudly rather than migrate.

**Disproven: sharp is NOT excluded from the CMS Lambda.** The
finalize/transform write-up assumed it was, which framed the clean fix as
expensive. `sharp` is a direct dependency of `canopycms` and `Dockerfile.cms` is
a plain `npm ci`, so it ships in the image and `transform.ts` already imports
it. Finalize can therefore use the *same decoder the transform engine will use*
before persisting bytes. Note `.metadata()` does not work for this — it reads
headers, which is exactly what already failed to catch a corrupt IDAT; a resize
to a throwaway 8x8 forces a real decode.

**Two things nothing in CI had ever exercised.** No app in the repo set
`CANOPY_BUILD` or contained a single `.server.*`/`.static.*` file, so neither
deploy shape was verified — and `canopycms-next`'s `dist/config.{cjs,mjs}` was
**stale**, because no app importing `canopycms-next/config` had ever been
`next build`-ed in CI. The new fixture found the latter while being written.

**CI gotcha worth not rediscovering:** `actions/checkout` leaves HEAD
*detached*, which CanopyCMS dev mode resolves to the literal branch name
`"HEAD"` — a name `parseBranchName` rejects — so a dev-mode request-time content
read 500s in CI while passing locally. Creating a `main` branch (what the e2e
job does) is **not** sufficient: it names a branch but leaves HEAD detached.
`git checkout -B main` is what actually resolves, and it also makes the branch
carry the PR's content rather than `origin/main`'s.

**Also worth not rediscovering:** the repo fails any test that writes to
`console.stderr`, so a test exercising a path that logs a warning must wrap it
in `mockConsole()`. This passed locally and failed only in CI, where all 3228
tests passed and the *run* still failed.

**Measurement:** `dorny/paths-filter` inside an always-running job (rather than
a `paths:` filter on the workflow trigger) keeps an irrelevant PR's dual-build
job at ~6s while still reporting a conclusion — a `paths:`-skipped workflow
never posts a status at all, which hangs any required check forever.

**Local-environment note:** 9 `cli/init.integration.test.ts` failures are a
sandbox artifact on this machine (tsx cannot open its IPC pipe) and pass with
the sandbox disabled; `MarkdownField`'s "mounts the real MDXEditor" is a
documented pre-existing flake under full-suite load. Neither is a real failure.

## 2026-07-30 — [B] Independent review of the hardening epic: four real defects, two proofs, one disproof

An independent session (not the one that wrote the epic) merged the base,
re-reviewed PR #183's full diff adversarially, and fixed what it found on
`epic/canopy-hardening` (commits 4d464592, a694e0d8, TBD). Verified claims by
reproduction where possible.

**The settings rename guard could be bypassed by losing a lock race.** The
guard (refuse to re-orphan a populated settings workspace under a new branch
name) ran only when this process ACQUIRED the init file-lock — but the
un-acquired process still proceeded to initializeWorkspace (pre-existing
concurrent-init design), so two Lambdas cold-starting together with a changed
deploymentName had one refuse and the other wipe. Concurrent cold starts
right after a deploy are exactly when a changed env value arrives. The guard
now runs lock-or-not; enumerating mid-init states shows a same-name
concurrent init cannot false-positive it (first init sits on base with no
settings files; same-name re-init has current==resolved). Regression test
seeds a fresh foreign lock and asserts the refusal plus intact files.

**#168's non-destructive fetch created a new lifecycle hole: nothing ever
removed a deleted branch's head from remote.git.** Pre-#168, the destructive
`--prune` into refs/heads/* cleaned it up (that WAS the data-loss bug — the
cure was right). But after: create → publish → squash-merge (GitHub
auto-deletes) → delete in editor → reuse the name, and the reused branch's
first publish is rejected non-fast-forward against the stale old tip — a
permanent 409 blaming "another CanopyCMS deployment". Worse: retrying the
submit skips the local push (clean tree) and enqueues the worker push of the
STALE head, resurrecting the deleted branch's content on GitHub as an
apparent success. Fixed where the epic's own comments said the "explicit
path" should live: deleteBranchHandler now deletes refs/heads/<name> from the
mirror (GitManager.deleteBareRemoteHead, expected-old-value-guarded like
reconcileTrackedBranches' updates), deliberately keeping the tracking ref so
a name still live on GitHub keeps 409ing at create time — the honest outcome.
The retry-skips-push half is pre-existing and filed separately
(submit-retry-skips-push-after-failed-push.md).

**#181's stale-response guard broke SWR's cache replay: A→B→A within the 2s
dedupe window left branch B's entries rendered under branch A indefinitely.**
The commit guard compared the cached tag's seq against a GLOBAL claim counter
that B's load had advanced; the replayed (valid) A cache hit was rejected,
and inside dedupingInterval no revalidation followed — with
revalidateOnFocus:false, nothing ever corrected it. Proven by a hook test
that fails on the pre-fix code and passes after. Replaced with a per-branch
committed-seq rule ("never move a branch's view backwards; never commit
another branch's tag"), which also required reading the current branch
through a ref — the settle-time check in refreshEntries closes over a stale
options object, which the first fix attempt got wrong and its own test
caught.

**A stale entry-load settle could strand the editor's busy flag.** Editor.tsx
only cleared entriesLoading when the settling load's entry was still
selected; navigating from a slow-loading entry to an ALREADY-loaded one
starts no new load, so nothing ever cleared it. Now also cleared when no
loads remain in flight.

**Proof the dual-build net fires:** sabotaged withCanopy (static build no
longer excludes .server.* extensions), rebuilt, ran the fixture: 3 assertions
fail, exit 1. Reverted. Also: the job's path filter omitted pnpm-lock.yaml —
a Next resolution bump (the exact class the known-good pin exists for) would
have skipped the job; added.

**Verified holding, not just asserted:** worker-persisted error redaction
(every path to task JSON/branch metadata passes redactCredentials before any
HTTP surface; classifier messages are fixed strings), classifier tested
against real captured git output at both hops including --porcelain,
C-locale forced at every classified call site, ASG
rolling-update-cannot-overlap reasoning (min-in-service 0, max 1 →
terminate-then-launch), CDK stamps CANOPYCMS_DEPLOYMENT_NAME unconditionally
for Lambda AND worker, `${branch}:${contentId}` OCC keying with
request-branch pinning survived the #181 refactor intact, log-group custom
names dodge the auto-created /aws/lambda group on existing stacks.

**Env-divergence residue filed, not fixed:** config.settingsBranch overrides
diverge Lambda vs worker (no CANOPYCMS_SETTINGS_BRANCH CDK prop) — bounded
because the primary settings-push path carries the Lambda-resolved name in
the task payload; extends worker-base-branch-env-divergence.md.

**Local-environment note:** packages/canopycms-cdk tests fail in a fresh
worktree until `pnpm run build:worker && pnpm run build:lambda` produce the
asset dirs the construct synths against — environment artifact, not a
failure.

**A second, fully independent reviewer over the accumulated diff confirmed
all five hard invariants and found the first fix's blind spot.** The
delete-time mirror-head cleanup only wins the auto-delete-first ordering:
when the branch still exists on GitHub at editor-delete time, the sync
loop's reconcile re-creates the local head from the tracking ref within a
cycle, and once GitHub's side is later deleted (pruning the tracking ref)
that head is orphaned forever — no registry entry remains for the delete
path to ever run against. Resolved with the reviewer's suggested reuse-time
heal: createBranchHandler clears any remaining local head once the registry
and tracking checks both pass (at that point it is stale by definition),
covering every ordering; delete-time cleanup stays as belt-and-suspenders.
Its smaller findings were also applied (orphan-recovery staleness now
derived from taskTimeoutMs so the every-cycle-recovery safety argument holds
for any configured timeout; the never-mounted useEntriesData wrapper hook
deleted — its untagged fetcher would have silently poisoned useEntryManager's
tagged cache slots; delete-response cleanupWarning strings sanitized) or
filed (foreign-settings-branch signal into worker-status.json; the
two-writer entriesLoading flag, now patched twice ad hoc, folded into the
editor-state-context migration task).

**Sibling-session gotcha worth recording:** two concurrent sessions running
the e2e suite collide invisibly on the hardcoded port 5174 —
`reuseExistingServer: true` makes one session's playwright attach to the
OTHER session's server (different worktree, different code), producing a
97/97 wipeout that looks like a catastrophic regression and is actually
pure cross-contamination. Check `lsof -iTCP:5174` before believing a local
e2e wipeout.

## 2026-07-31 — [C] Independent review of the coverage sweep: the tests survive mutation; the harness did not survive a sibling session

Adversarial review-and-fix of PR #175 (52 → 97), run as its own session with
fixes on `fix/e2e-coverage-review-findings`.

**The headline claim held up under mutation testing.** 12 deliberate
production-code breaks across the four highest-value specs plus the
status-lock guard (corrupt-metadata misclassification, backdated trash stamp,
young-orphan rail removal, mark-merged submitted-only regression, same-id
requeue, task-filter default flip, alt-rule removal, dropped image dims,
transform cache written to a wrong key, groups/permissions no-persist,
status-lock bypass) — every one turned exactly the intended tests red and left
unrelated tests green. Zero surviving mutants. Two back-to-back full runs
without wiping `.canopy-dev`: 97/97 both times. Five runs of the 8 new specs:
225/225, timing spread ±0.2m.

**Three assertions were strengthened because they could not fail.** C8's
"served again from cache" also passed under a recompute (fixed: delete the
original blob first, so only the cache path can 200 — verified red under a
cache-lookup-bypass mutation); the base-branch purge test only proved healthy
rows render no Purge control (fixed: corrupt the live base metadata with a
mandatory restore, assert disabled control + tooltip + the server's reasoned
400 — verified red under a UI-rail-removal mutation); the repair test read
`branch.json` once inside the server's rename→git-spawn→rewrite ENOENT window
(fixed: poll until parseable — the flake would have been buried by CI
`retries: 2`).

**The settings workspace leak is real and now self-heals.** Each run left one
`e2e-group-*` group and a `team-a → content/posts/** edit` rule in the
never-reset settings workspace (benign today only because every later spec
runs as admin, which bypasses path permissions). The specs now clear their own
slice at start (healing crashed runs) and in `finally`. The durable
resetWorkspace() fix stays filed in `e2e-harness-followups.md`.

**Concurrent sessions on one machine WILL corrupt each other's e2e runs —
proven live, now fixed.** With the fixed port 5174 plus
`reuseExistingServer: true`, this session's post-fix verification silently
attached to a sibling review session's dev server (fingerprinted via
`GET /branches` → `defaultBranch: claude-canopy-hardening-review-fb61d9`) —
rooted in the OTHER checkout's workspace, so a freshly seeded task queue read
"pending 0" and three specs failed with no product cause. Fix:
`CANOPY_E2E_PORT` threads one port through playwright.config (baseURL +
`exec next --port`) and a shared `fixtures/base-url.ts` all 20 specs import.
Sibling sessions must export distinct ports until this merges everywhere.
Corollary: any inexplicable seeded-state e2e failure on a shared machine
should be fingerprinted against `GET /api/canopycms/branches` before
debugging the product.

**Timing-doc correction.** The 4-shard run id recorded in
E2E-FAILURE-ANALYSIS.md (30590565843) resolves to nothing on GitHub; the
verifiable run is 30590540192 (shards 2.57/2.58/2.62/3.05m, merge 0.57m,
validate 3.88m). Conclusion unchanged — e2e path sits under validate; 4-way
sharding is a confirmed win.

**Found by the final Fable pass, filed not fixed** (production, out of the
review's scope): the admin purge rail re-derives "is base branch" from
`defaultBaseBranch` alone, skipping `getBranchProtection`'s drift clause — a
drifted base workspace with corrupt metadata scans as purgeable
(`purge-rail-config-clause-only.md`, softened by trash retention). Also filed:
`e2e-remote-git-ref-accumulation.md` (remote.git accrues submit-test refs and
settings commits forever; only `refs/heads/main` is ever reset).

**One inherited footgun removed:** `test.setTimeout(60000)` in three new tests
*lowered* the budget below the config's 90s — the calls read as "extend" but
shrink. The pattern came from older specs; those are left alone.

## 2026-08-14 — [program] Direction confirmed: both sites deploy, KB first — hub sequencing vindicated

Backlog re-baseline for the go-live epic, run on `chore/backlog-rebaseline-golive`
off `integration-202608-b`. Established via a shared, separately-verified
briefing (facts cross-checked against both adopter sites' own repos
directly, not re-derived here).

**Confirmed direction.** Both adopter sites (the knowledge base and the
marketing site) get a deployed editor on AWS. **The KB goes first.** This
closes the two open items the 2026-08-13 audit had flagged in `index.md`:

- The hub's original goal statement and E→F workstream sequencing (docs-site
  CMS deployment, then production + the second site) already assumed exactly
  this direction. **The audit's "inverted premise" warning was itself the
  error, not the hub** — no correction to the hub's sequencing was needed, only
  a retraction of the warning. `index.md`'s preamble, sibling-repo version
  line, and roughly two dozen `[MKT]`-only tags that assumed the KB stays
  dev-mode forever were corrected in this session (several `[MKT]` rows had no
  tag at all — `sanitized-branch-name-git-mismatch.md` and
  `worker-base-branch-env-divergence.md` — now `[BOTH]`).
- `program-log.md`'s staleness (last entry 2026-07-31, ~2 weeks and epic #211
  behind) is closed by this entry.

**Epic scope.** All go-live work lands on `integration-202608-b` (cut from
`main` at `db4f8711`), standing draft PR #235. `main` is at **0.0.62** as of
this session (auto-publishes a patch per push; never hardcode the target
version — resolve it when needed).

**Adopter-request triage (#10-#18 from an adopter's own requests list),
verdicts recorded in dedicated task files under `.claude/future-tasks/` so they
aren't re-derived by a future session:**

- **#12 (leaf-slug static params) was already fully shipped**, and already
  available on the marketing site's own pinned 0.0.41 — zero work. Filed as
  `resolved/leaf-slug-static-params-docs-gap.md`, a discoverability note, not
  a feature.
- **#18 (one blessed markdown renderer) is a deliberate no-build** —
  `react-markdown` needs `'use client'` in an RSC tree (client-bundle cost for
  every adopter), still can't cover the MDX half, and the divergence it's
  trying to fix is site policy, not CMS policy. Reasoning recorded in
  `markdown-rendering-not-building.md` so this isn't relitigated; the
  actionable remainder (documenting the react-markdown-in-RSC trap) is tracked
  there.
- **#11 (typed listing with data) is security-gated, not just unbuilt.**
  `listEntries` already returns the requested shape but has zero ACL
  awareness (`context.ts:301-306` passes no user) — latent only because the
  one route to it, `getCanopyForBuild()`, throws at request time. Three
  options written up in `listentries-acl-awareness.md`, which now interacts
  directly with `authorization-enforcement-consolidation.md`.
- #13/#15/#16 are partial-to-working-but-undocumented; #17's requested API is
  the wrong shape (the real duplication is a boot block + an unexported
  markdown stripper + unexported title derivation, plus `parseTypedFilename`
  sitting unreachable and `listEntries` dropping `updatedAt`); #14 is unbuilt,
  breaking, and the docs already promise the fixed behavior, with a 2-line
  in-repo blast radius.
- **This epic is implementing now**: `parseTypedFilename` export,
  `defaultBuildPath` export, `readByUrlPath` entryType+entryId, `listEntries`
  updatedAt, #14, #10 (sitemap half only — #10a/SEO metadata not confirmed in
  scope), #13 (types only), #15 (docs only), #16 (the caveat doc), and #17's
  underlying primitives (not the `extractSearchDocuments` API itself, which is
  not being built). See each item's task file for what's landing now vs. what
  a future session should pick up.

**Site-audit findings with no prior backlog file**, also filed this session:
draft/publish as a first-class lifecycle (the KB's `draft` frontmatter field
is a documented phantom — no schema field, no content sets it, three dead
filters), a stable heading-ID + `extractToc()` contract (both sites built
their own heading-attrs rehype pass independently; the marketing site's TOC
builder hand-mirrors rehype-slug's counter and desyncs on `#`/`####` in
heading text), a `compileAndRenderCheck()` + `canopycms validate-content`
CLI (porting the KB's own incident-driven render-safety script), resolved
references carrying a URL (removes the KB's second-`listEntries`-pass
doc-link index helper), trailing-slash router/href helpers,
`defaultBuildPath`'s export, a programmatic content-authoring API +
deterministic ID generator (the KB's own dataset-ingestion script bypasses
schema validation and the ID index, and copy-pastes Canopy's Base58
alphabet), and a supported script-runner entrypoint (both sites carry
`@ts-ignore`-scarred workarounds for lack of one).

Full detail for every item above lives in its own file; see `index.md`'s
P0–P3 tables and "Do next" list for links.
