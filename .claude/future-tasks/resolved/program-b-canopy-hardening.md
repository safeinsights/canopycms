# Program B — Canopy hardening

**Part of:** [production-readiness-program.md](production-readiness-program.md)
**Size:** L (run as an epic via the `epic-workflow` skill) · **Status:** RESOLVED 2026-07-30
**Blocks:** D (B1 + B2 specifically), and therefore E

The Canopy-side work that a real multi-editor deployment needs. Ordered by what
the docs-site deployment actually depends on. B1 and B2 gate the stack rebuild in
D; B3 and B4 can follow.

---

## B1 — Multi-deployment safety (M)

**Why:** the program stands up a second Canopy deployment against a GitHub repo
that another deployment will eventually also use. Two hazards exist today, both
found by inspection and neither yet hit.

1. **Settings-branch collision.** `deploymentName`
   (`packages/canopycms/src/config/schemas/config.ts`) defaults to `'prod'` and is
   only ever set in the adopter's static `canopycms.config.ts`. Two prod-mode
   stacks against one repo both resolve settings branch
   `canopycms-settings-prod` and fight over permission/group PRs. The mechanism to
   avoid this exists (`getSettingsBranchName` → `canopycms-settings-{deploymentName}`,
   design intent documented at `ARCHITECTURE.md`'s branch-naming section) but is
   opt-in, absent from `cli/template-files/canopycms.config.ts.template`, and
   unmentioned in `docs/deploying-to-aws.md`.
2. **Content-branch collision.** No namespacing mechanism at all.
   `branchNameSchema` in `packages/canopycms/src/api/validators.ts` validates git
   syntax only. `pushBranchToGitHub` in
   `packages/canopycms/src/worker/cms-worker.ts` does a plain non-force push, so
   two deployments whose editors pick the same branch name produce a
   non-fast-forward rejection — no data loss, but a stuck task with no automated
   recovery.

**Work:**
- Make `deploymentName` environment-injectable: stamped by `CanopyCmsService` into
  the Lambda and worker environment, read by the generated config template.
- Decide and implement cross-deployment content-branch behaviour — namespacing
  (prefix / reserved-name check), or explicit collision detection surfaced as a
  first-class editor error rather than a stuck task. **This is open decision #1;
  settle it in the epic's design phase, adversarially reviewed before implementing.**
- Document the "two stacks, one repo" scenario in `docs/deploying-to-aws.md`.

---

## B2 — Ops gaps that make a deployment un-runnable (S each)

- **Worker ASG `updatePolicy`** — see
  [worker-asg-rolling-update.md](worker-asg-rolling-update.md). The ASG in
  `packages/canopycms-cdk/src/constructs/cms-service.ts` sets no `updatePolicy`,
  so `cdk deploy` changes to worker user-data or the worker bundle never reach the
  running instance until a spot interruption or manual terminate. Fix:
  `autoscaling.UpdatePolicy.rollingUpdate({ minInstancesInService: 0 })`;
  cfn-signal is a stretch goal.
- **Lambda log retention** — see
  [lambda-log-retention.md](lambda-log-retention.md). The CMS Lambda and transform
  Lambda rely on auto-created infinite-retention log groups with no removal
  policy. Mirror the worker's existing `workerLogGroup` pattern (90-day default,
  `RemovalPolicy.DESTROY`) for both.
- **Deploy CI template** — `cli/template-files/deploy-cms.yml.template` is a stub
  that builds a Docker image and does nothing with it. `examples/aws-deployment/deploy-cms.yml`
  pushes to ECR and updates the Lambda but never runs `cdk deploy`, so infra
  changes remain a manual step. Ship a template that does both.

---

## B3 — Editor correctness the teams hit on day one (M)

- [stale-draft-prevents-content-load.md](stale-draft-prevents-content-load.md) — a
  stale localStorage draft silently shadows fresh server content, with no error.
  Found during docs-site content migration; with several editors it becomes a
  support burden. Fix via staleness detection against `updatedAt`, or
  always-load-and-merge.
- ~~[swr.md](resolved/swr.md) + [editor-async-patterns.md](resolved/editor-async-patterns.md)~~
  — RESOLVED 2026-07-30 on `feat/editor-request-dedup-and-cancellation`: SWR
  adopted for the branches/entries+schema/comments fetch-on-load hooks
  (dedup verified via React Strict Mode regression tests), `ReferenceField`
  keyed on a derived fetchKey with an `active`-flag guard,
  `useReferenceResolution` gets a generation-counter guard, and the
  Editor.tsx entry-load race is fixed via a contentId ref check. One
  pre-existing quirk spun out separately: see
  [reference-resolution-branch-switch-stale.md](reference-resolution-branch-switch-stale.md).
- ~~[finalize-transform-decoder-mismatch.md](resolved/finalize-transform-decoder-mismatch.md)
  — upload `finalize` (header-sniffing, no sharp) accepts rasters the transform
  Lambda's libvips later rejects with a 422, so the asset "uploads fine" and
  renders broken everywhere with no user feedback. Confirmed on the live
  deploy-test. Real editors upload imperfect exports.~~ RESOLVED 2026-07-30.

---

## B4 — Build-shape safety net (M)

- ~~[dual-build-ci.md](resolved/dual-build-ci.md) — nothing verifies the two deploy
  shapes. `init.test.ts` only asserts template string content and never runs
  `next build`. Both adopter sites depend on the `page.static` / `page.server`
  split (see [resolved/slug-route-nofallback-500.md](resolved/slug-route-nofallback-500.md)),
  so a `withCanopy()` pageExtensions regression would ship unnoticed. Build a CI
  fixture that runs both shapes, gated on relevant-path changes for cost.~~
  RESOLVED 2026-07-30 — `apps/dual-build-fixture` + `dual-build.test.ts` +
  the gated `dual-build` CI job.
- [next-16.2-postcss-fork-bomb.md](next-16.2-postcss-fork-bomb.md) — Next 16.2.x +
  Turbopack + PostCSS fork-bombs adopter `pnpm dev`. Both adopter sites are
  already pinned to 16.1.x, recorded as prose in two separate CLAUDE.md files.
  Make it a documented package-level constraint (README known-good versions at
  minimum) rather than tribal knowledge. PARTIALLY RESOLVED 2026-07-30 — README
  + peer-dependency range done; upstream root-cause chase still open.

---

## Gates

Per PR: `pnpm lint`, `pnpm exec tsc --noEmit`, the vitest suite (~2900 tests), and
the 3 e2e shards. Each fix carries its own test. Run the epic on an integration
branch with one small PR at a time and main-loop review of every diff.

## Definition of done

A second Canopy deployment can safely share a GitHub repo with another;
`cdk deploy` reaches every component including the worker; log groups have
retention; the day-one editor defects are fixed; and both build shapes are
verified in CI.


---

# Resolution (2026-07-30, `epic/canopy-hardening`)

Nine PRs. B1 and B2 clear Workstream D's Canopy-side gate.

| PR | Scope |
| -- | ----- |
| #168 | Sync fetch no longer destroys unpushed refs (found by the design review; see below) |
| #169 | `deploymentName` environment-injectable; settings-branch rename guard |
| #170 | Content-branch collision guards (reserved prefix, sanitized comparison, create-time mirror check) |
| #174 | Non-fast-forward push classification at both hops |
| #176 | Worker ASG rolling update + Lambda log groups + per-cycle orphan recovery |
| #177 | Deploy workflow that runs `cdk deploy` |
| #178 | Finalize validates raster decodability; transform status pass-through |
| #180 | Dual-build CI fixture; Next known-good versions |
| #181 | Editor request dedup and stale-response cancellation |

## Definition of done

- **A second deployment can safely share a GitHub repo.** `deploymentName` is
  env-injectable and stamped by CDK; all four previously-divergent readers
  agree; content-branch collisions are caught at create time against the local
  GitHub mirror and, when they slip through, surfaced as an actionable 409 or a
  fail-fast permanent task error instead of a stuck retry loop.
- **`cdk deploy` reaches every component.** The worker ASG has a rolling update
  policy, and the deploy template runs `cdk deploy` rather than only updating
  the Lambda image.
- **Log groups have retention.** CMS and transform Lambdas both, with custom
  names and explicit write grants.
- **Day-one editor defects fixed.** Duplicate loads deduped, stale responses
  discarded, undecodable uploads rejected at finalize instead of rendering
  broken forever. (`stale-draft-prevents-content-load` was already fixed and
  merged in July, before this epic.)
- **Both build shapes verified in CI**, by a fixture demonstrated to fail when a
  shape breaks.

## Where this deviated from the plan above

- **B1 gained a prerequisite.** The adversarial design review found that
  `syncGit()`'s fetch refspec silently destroyed unpushed refs — including a
  case that reported success while dropping the publish. B1's definition of
  done was not truthfully reachable on top of it, so it was fixed first (#168).
- **Open decision #1 resolved to detect-and-surface**, on the strength of an
  architectural constraint rather than a preference; rationale is in the hub
  doc's decisions table and in the program log.
- **B2's `cdk deploy` template turned out to conflict with the stack**, not
  merely to be missing. The old example paired an ECR push and
  `update-function-code` with a `fromImageAsset` stack, which builds the image
  twice and leaves the Lambda out of sync with CloudFormation.
- **B3's scope was smaller than written in one place and larger in another.**
  `stale-draft-prevents-content-load` was already fixed, and `refreshEntries`'s
  overlap already had seq-token guards with tests. But the finalize/transform
  item's central premise (sharp excluded from the CMS Lambda) was wrong, which
  made the *cleanest* fix also the cheapest.
- **cfn-signal was dropped** from B2 as a stretch goal, deliberately and with
  the reasoning recorded in-code — the obvious placement would make a
  CloudWatch-agent failure roll back the whole deploy, and it would pass for a
  crash-looping worker regardless.

## Still open

- [next-16.2-postcss-fork-bomb.md](../next-16.2-postcss-fork-bomb.md) — the
  package-level constraint and README documentation are done; the upstream
  root-cause chase is not.
- [reference-resolution-branch-switch-stale.md](../reference-resolution-branch-switch-stale.md)
  — spun out while fixing the reference-resolution race.
