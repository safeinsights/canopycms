# Production-Readiness Program

**Status:** active — started 2026-07-30. The first deployed editor went live 2026-10-05
(see [program-log.md](program-log.md)); workstreams D, E and F are retired as resolved by events,
and G (operational readiness) is the one open workstream.
**Goal:** CanopyCMS running as the content system for the adopter sites in production on AWS.

This is the hub document. Each workstream has its own file with enough context to
execute cold. Learnings go in [program-log.md](program-log.md) (append-only).

---

## Why this program exists

The July deployment-test epic proved the whole prod-mode stack end-to-end on AWS
(editor Lambda, EFS branch clones, EC2 worker, real Clerk, image upload +
transform, submit → bot PR → merge → static rebuild). See
[resolved/cms-service-deployment-test.md](resolved/cms-service-deployment-test.md).

What had not happened as of the program's start: **a real site running the deployed
editor.** Both adopters had `/edit` routes, catch-all API routes, schemas and
Canopy-managed content, but ran Canopy in `mode: 'dev'` locally, with static-only
deployed infrastructure. That gap closed on 2026-10-05: the marketing site's
editor runs on Lambda + EFS + worker with real auth and group path rules. The
knowledge base follows on the same shape.

---

## Workstreams

| ID | Workstream | Size | Status | File |
| -- | ---------- | ---- | ------ | ---- |
| A | Release path (prerelease channel + standing draft PR) | S | **done** 2026-07-30 | [resolved/program-a-release-path.md](resolved/program-a-release-path.md) |
| B | Canopy hardening (multi-deployment safety, ops gaps, editor correctness, build shapes) | L | **done** 2026-07-30 | [resolved/program-b-canopy-hardening.md](resolved/program-b-canopy-hardening.md) |
| C | E2E coverage sweep (3.5-month gap) | L | **done** 2026-07-30 — 52→97 tests; matrix in [COVERAGE-MATRIX.md](../../apps/test-app/e2e/COVERAGE-MATRIX.md) | [resolved/program-c-e2e-coverage.md](resolved/program-c-e2e-coverage.md) |
| D | Rebuild + exercise the deploy-test stack | M | **retired** 2026-10-05, resolved by events | [resolved/program-d-stack-rebuild.md](resolved/program-d-stack-rebuild.md) |
| E | Docs-site CMS deployment | L | **retired** 2026-10-05, resolved by events | [resolved/program-e-docs-site-cms.md](resolved/program-e-docs-site-cms.md) |
| F | Production + shared site-CDK for the second site | L | **retired** 2026-10-05, resolved by events | [resolved/program-f-production.md](resolved/program-f-production.md) |
| G | Operational readiness | M | open, a normal P2 task | [program-g-operational-readiness.md](program-g-operational-readiness.md) |

### Sequencing

```
A ─┬──────────────────────────────────────────────►
   │
B ──B1──B2──►  B3, B4 ──────────►
   │           │
C ─┴───────────┤ (parallel throughout)
               │
D ─────────────┴──────►
                       │
E ─────────────────────┴────────►
                                 │
F ───────────────────────────────┴──────►
                                         │
G ───────────────────────────────────────┴──►
```

A, B and C are done. The D, E, F ordering above was overtaken by events: the first
deployed editor shipped on the marketing site without it, so D, E and F are retired and G
no longer waits on F.

---

## Decisions taken

| Decision | Rationale | Date |
| -------- | --------- | ---- |
| Tear down the deploy-test stack and rebuild fresh | Re-proves the from-scratch adopter path and clears drift from the July fix-forward cycle | 2026-07-30 |
| Do not touch `dev-docs.sandbox.safeinsights.org` | It is the teams' working docs site; changes only at a planned cutover. See the protection rules below | 2026-07-30 |
| Prereleases published under a non-`latest` dist-tag | Lets adopters consume unreleased integration work without a human review gate, and without adopters resolving prereleases by accident | 2026-07-30 |
| GitHub Actions OIDC for site deploys, not Jenkins/CodeBuild | Both sites already use OIDC; deployment code stays in each site's repo so workflows can reach it. `iac` continues to own account baselines only | 2026-07-30 |
| Work continues on integration branches with a standing draft PR to `main` | Human review is the scarce resource; batch it rather than gating every change | 2026-07-30 |
| All npm publishing routes through `publish.yml`, prereleases via a reusable workflow | npm allows one trusted publisher per package, bound to a workflow filename, and validates the *calling* workflow for `workflow_call`. Any additional channel must enter through `publish.yml` or all five packages' npm settings change together | 2026-07-30 |
| Adopters pin prereleases exactly (`--save-exact`), never with a range | `^0.0.61-int.74` matches later prereleases of `0.0.61` *and* stable `0.0.61`, so a caret silently drifts off the pinned build | 2026-07-30 |
| Content-branch collisions: detect and surface, not prefix-per-deployment (open decision #1) | The CMS Lambda has no internet (`PRIVATE_ISOLATED`, no NAT), so a create-time GitHub call is impossible; detection is viable only because `remote.git` mirrors GitHub's refs and resolves to the same EFS inode from Lambda and worker. Prefixing was rejected because it is blind to the likelier collision (a human pushing that branch name, or a branch left by an earlier deployment), only works if the two deployments are configured differently — the very hazard being removed — and changes user-visible branch names for every single-deployment adopter | 2026-07-30 |
| Refuse to boot, rather than migrate, when a deployment's resolved settings-branch name changes | The old path ran `checkout --orphan` + `rm -rf .` on the settings workspace; orphan branches share no history, so permissions.json and groups.json were destroyed with nothing to recover from. An operator resolving it deliberately beats an automatic migration of authorization data | 2026-07-30 |
| `deploymentName` precedence is env > config > mode default | The env var is stamped per-stack by CDK and is the value guaranteed to DIFFER between two deployments; `config.deploymentName` lives in the shared repo and is guaranteed to be IDENTICAL. Config-winning would make the CDK knob silently do nothing in exactly the case it exists for | 2026-07-30 |
| `cdk deploy` is the single deployer; no paired `update-function-code` | The stack supplies the image as a CDK asset, so pairing the two builds it twice and leaves the function's image URI out of sync with CloudFormation — the next `cdk deploy` silently reverts the code | 2026-07-30 |

---

## Protecting the teams' docs site

`dev-docs.sandbox.safeinsights.org` serves the teams today. Every step in E is
checked against this list:

1. **`dev-docs` changes on exactly one trigger** — a push to `testing-main`
   (`deploy-dev.yml`). Nothing else writes to that distribution.
2. **Canopy content targets `testing-production`** → `docs.sandbox…`, a different
   CloudFront distribution in the same account.
3. **Every change is previewable before merge.** `deploy-preview.yml` builds every
   PR into the Basic-Auth preview distribution. The Canopy version upgrade is
   validated there, not by merging to `testing-main`.
4. **The sync automation is the one real coupling.** APPROACH.md's
   `production → main` sync PR would carry Canopy-authored content into the
   developer branch and therefore into `dev-docs`. Build it, but leave it opening
   **draft PRs for manual merge** until cutover.
5. **The shared artifacts bucket is the one real deploy hazard.**
   `updateDistributionOriginPath()` in
   `docs-site-proto/infrastructure/scripts/lib/aws.ts` stamps `builds/{sha}` onto
   *every* origin, so adding an asset origin would 404 assets on the next deploy.
   Land that fix before any asset origin exists anywhere.
6. **Rollback**: re-point the dev distribution's origin path at the previous
   `builds/{sha}` and invalidate. Capture the current SHA before E starts.

---

## Open decisions

| # | Decision | Resolved by |
| - | -------- | ----------- |
| 2 | Canopy's target environment in testing mode: `testing-production` vs. a new fourth env | D's AWS inventory |
| 3 | When to extract the shared static-site CDK package | F, or when website v2 resumes |
| 4 | Clerk instances for the docs-site CMS and for production | E and F |
| 5 | Confirm `iac` keeps owning account baselines only | Team discussion before F |

---

## How this program is driven

- **This file** is the hub: status, decisions, what's next.
- **[program-log.md](program-log.md)** is append-only. Every workstream session
  appends what it learned — surprises, disproven assumptions, deploy-proven
  facts, decisions and their reasons — so sibling sessions inherit findings
  instead of rediscovering them.
- **Per-workstream files** carry enough context to execute cold, and move to
  `resolved/` when they land.
- The **`program-orchestrator` skill** encodes the loop: read this doc + the log,
  pick the next workstream, run it (usually via `epic-workflow`), append to the
  log, update status here, propose the next move.

Cross-repo work in `docs-site-proto` and `website` is tracked from the relevant
workstream file; those repos get pointer files when their workstreams begin.
