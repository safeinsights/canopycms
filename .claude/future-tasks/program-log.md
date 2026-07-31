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
