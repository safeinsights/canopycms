# Program F — Production, and the second site

**Part of:** [production-readiness-program.md](production-readiness-program.md)
**Size:** L · **Status:** not started · **Blocked by:** E stable with real editors
**Repos:** `safeinsights/canopycms`, `safeinsights/docs-site-proto`, `safeinsights/website`

## Part 1 — Shared deployment code

Two sites need the same deployment shape:

- `docs-site-proto` hand-rolls the entire static-site half in `infrastructure/`
  (Artifacts, Environment, Preview, Replica, OAI stacks) — unpublished, ~zero
  reuse surface. Its README documents multi-site reuse via a `projectName` prop,
  but only within the same CDK app.
- `website@v2` has **no `infrastructure/` and no `.github/` at all**. Its CLAUDE.md
  says the plan is to *port* docs-site-proto's `infrastructure/` in a future
  "Phase 6" — while also saying "prefer adding it upstream in `../canopycms` so
  `docs-site-proto` and future adopters benefit."

`canopycms-cdk` today covers only the CMS half (`CanopyCmsService`,
`CanopyCmsDistribution`, `AssetSupport`).

**Recommended:** extract the static-site half into the package — a
`canopycms-site-cdk`, or a widened `canopycms-cdk` — with Artifacts / Environment
/ Preview stacks generalized by `projectName` and a `deploymentModes` config. Each
repo keeps a thin `infrastructure/bin/app.ts`, `cdk.json`, and its workflows, so
deployment stays reachable from GitHub Actions in-repo without a second divergent
copy existing.

Decide during this workstream (open decision #3): extract now, or when website v2
resumes — it has been stale since 2026-06-14. Also decide whether the
`production → main` sync automation generalizes or stays docs-site-specific.

## Part 2 — Production deployment

`docs-site-proto`'s `official` mode is fully configured in `infrastructure/cdk.json`
and has **never been synthesized or deployed**. It maps onto the real SafeInsights
accounts from `iac/lib/definitions.ts`:

| Role | Account |
| ---- | ------- |
| build | `767397792557` (Security) |
| preview / dev | `872515273917` (Dev) |
| staging | `867344442985` (Staging) |
| production | `533267019973` (Production) |

Domain `safeinsights.org`, docs at the `docs` subdomain.

**Work:**

- Deploy `official` mode across those accounts. Budget for a first-deploy defect
  list comparable to the sandbox one — 13 PRs of fixes came out of the first
  prod-mode deploy.
- SSO profiles follow `<RoleName>-<AccountId>`; only `sandbox-admin` is configured
  locally today, so profiles for the other accounts are a prerequisite.
- Create the missing `production` branch and reconcile the stale `main` (untouched
  since February because it targets a mode that has never deployed).
- CMS in production: a production Clerk instance with real org/role mapping,
  cross-account `canopy` bootstrap, per-account secrets following the org's
  `${namePrefix}Secrets-${envSlug}` convention, and a production bot machine
  account.
- DNS/certs: reuse `iac`'s `management-app` pattern — `HostedZone.fromLookup`
  against the per-account zone created by `AwsAccountBaseStack`, ACM with
  `CertificateValidation.fromDnsMultiZone`, CloudFront alias records.
- **`iac` relationship** (open decision #5): site stacks stay in their own repos
  with GitHub Actions OIDC; `iac` continues to own account baselines the site
  stacks consume. Confirm with the team.

## Part 3 — Content lifecycle design (do this first)

[content-lifecycle-scenarios.md](content-lifecycle-scenarios.md) is currently
scoped with nothing implemented. **It belongs before the production deploy, not
after** — it decides whether content edited in one environment can reach
production at all:

- dev / staging / production content flow
- schema changes vs. in-flight content branches
- long-lived vs. short-lived branches and the guardrails for each
- upstream-conflict UX
- PR-workflow checks

Also plan the transition from all-in-sandbox `testing` mode to `official` mode
without an outage for the teams.

## Verification

Staged rollout. The teams' site cuts over only after the CMS deployment has been
stable through a real content cycle.

## Definition of done

The docs site serves from production on `safeinsights.org` with a deployed editor,
and website v2 has a documented, non-duplicated path to the same shape.
