# Production-Readiness Program

**Status:** active — started 2026-07-30
**Goal:** CanopyCMS running as the content system for `safeinsights/docs-site-proto`
in production on AWS, with `safeinsights/website@v2` following the same pattern.

This is the hub document. Each workstream has its own file with enough context to
execute cold. Learnings go in [program-log.md](program-log.md) (append-only).

---

## Why this program exists

The July deployment-test epic proved the whole prod-mode stack end-to-end on AWS
(editor Lambda, EFS branch clones, EC2 worker, real Clerk, image upload +
transform, submit → bot PR → merge → static rebuild). See
[resolved/cms-service-deployment-test.md](resolved/cms-service-deployment-test.md).

What has never happened: **a real site running the deployed editor.** Both
adopters — `docs-site-proto` (canopycms `^0.0.54`) and `website@v2` (canopycms
`^0.0.41`) — have `/edit` routes, catch-all API routes, schemas, and
Canopy-managed content, but both run Canopy in `mode: 'dev'` locally. Their
deployed infrastructure is static-only. Content changes require a developer.

Closing that gap is what this program covers.

---

## Workstreams

| ID | Workstream | Size | Status | File |
| -- | ---------- | ---- | ------ | ---- |
| A | Release path (prerelease channel + standing draft PR) | S | not started | [program-a-release-path.md](program-a-release-path.md) |
| B | Canopy hardening (multi-deployment safety, ops gaps, editor correctness, build shapes) | L | not started | [program-b-canopy-hardening.md](program-b-canopy-hardening.md) |
| C | E2E coverage sweep (3.5-month gap) | L | **done** 2026-07-30 — 52→97 tests; matrix in [COVERAGE-MATRIX.md](../../apps/test-app/e2e/COVERAGE-MATRIX.md) | [resolved/program-c-e2e-coverage.md](resolved/program-c-e2e-coverage.md) |
| D | Rebuild + exercise the deploy-test stack | M | not started | [program-d-stack-rebuild.md](program-d-stack-rebuild.md) |
| E | Docs-site CMS deployment | L | not started | [program-e-docs-site-cms.md](program-e-docs-site-cms.md) |
| F | Production + shared site-CDK for the second site | L | not started | [program-f-production.md](program-f-production.md) |
| G | Operational readiness | M | not started | [program-g-operational-readiness.md](program-g-operational-readiness.md) |

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

A unblocks both sites and is hours of work. B + C are the bulk of the Canopy
work. D is the gate before any real-site deployment. E is the deliverable that
gets editors working. F and G make it production and team-ownable.

---

## Decisions taken

| Decision | Rationale | Date |
| -------- | --------- | ---- |
| Tear down the deploy-test stack and rebuild fresh | Re-proves the from-scratch adopter path and clears drift from the July fix-forward cycle | 2026-07-30 |
| Do not touch `dev-docs.sandbox.safeinsights.org` | It is the teams' working docs site; changes only at a planned cutover. See the protection rules below | 2026-07-30 |
| Prereleases published under a non-`latest` dist-tag | Lets adopters consume unreleased integration work without a human review gate, and without adopters resolving prereleases by accident | 2026-07-30 |
| GitHub Actions OIDC for site deploys, not Jenkins/CodeBuild | Both sites already use OIDC; deployment code stays in each site's repo so workflows can reach it. `iac` continues to own account baselines only | 2026-07-30 |
| Work continues on integration branches with a standing draft PR to `main` | Human review is the scarce resource; batch it rather than gating every change | 2026-07-30 |

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
| 1 | Content-branch namespacing shape: prefix-per-deployment vs. detect-and-surface | B1 design |
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
