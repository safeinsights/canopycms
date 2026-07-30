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
