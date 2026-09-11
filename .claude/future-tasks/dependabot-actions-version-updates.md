# [P3] Nothing keeps GitHub Actions pins current — decide whether Dependabot should

Filed 2026-09-11, alongside the fix in
[resolved/gha-actions-node20-runtime.md](resolved/gha-actions-node20-runtime.md).

## What happened

`.github/dependabot.yml` was switched to security-only in f9c99b7f
(`open-pull-requests-limit: 0` for both `npm` and `github-actions`). The grouped
Actions bump Dependabot had already opened (#57) was closed unmerged. From then on
nothing moved the pins, and they surfaced only when every job started ending with a
Node 20 runtime-deprecation annotation. Until that fix, DEVELOPING.md's CI Workflow
Conventions still said "Dependabot/Renovate keeps pinned SHAs from going stale". The
fix corrected that line.

## The decision (JP's)

- **(a) Re-enable version updates for `github-actions` only.** Keep `npm`
  security-only and give Actions a grouped, monthly schedule. That is a handful of
  small PRs a year, each fully exercised by CI except the main-only steps of
  `publish.yml`. Dependabot rewrites both the SHA and the trailing version comment.
- **(b) Stay security-only.** Bump by hand when an annotation or a security advisory
  forces it, which is what happened this time.

## True either way

Dependabot only scans `.github/workflows/`, so it never touches
`packages/canopycms/src/cli/template-files/deploy-cms.yml.template` or
`examples/aws-deployment/deploy-cms.yml`. Adopters inherit those pins, including
`configure-aws-credentials` in front of a CDK-admin OIDC role. Under (a) they would
lag behind the workflows, since `actions/checkout` and `actions/setup-node` appear in
both.

A cheap guard would be to have `scripts/check-action-pins.mjs` (`pnpm lint:actions`)
fail when an action appears in both a workflow and a template/example at different
SHAs. A Dependabot PR would then go red until the template followed. That guard only
has a job under (a).
