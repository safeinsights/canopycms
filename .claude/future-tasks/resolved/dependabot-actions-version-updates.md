# [P3] RESOLVED — Nothing keeps GitHub Actions pins current — decide whether Dependabot should

Filed 2026-09-11, alongside the fix in
[gha-actions-node20-runtime.md](gha-actions-node20-runtime.md). Decided the same
day. See [Decision](#decision) at the end.

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
  security-only and give Actions a grouped, monthly schedule. That is at most one
  PR a month, and its own CI exercises every action except the ones only the two
  publish workflows use. GitHub's docs don't say whether Dependabot also rewrites
  a trailing `# vX.Y.Z` comment next to a SHA pin, so check the first such PR.
- **(b) Stay security-only.** Bump by hand when an annotation or a security advisory
  forces it, which is what happened this time.

## True either way

Dependabot only scans `.github/workflows/`, so it never touches
`packages/canopycms/src/cli/template-files/deploy-cms.yml.template` or
`examples/aws-deployment/deploy-cms.yml`. GitHub's docs say `directory: "/"` checks
"workflow files in `.github/workflows`", and #57 bears it out. On 2026-06-03 the
template and the example held the same `actions/checkout@v4` pin as the workflows,
and #57 changed only `ci.yml` and `publish.yml`. Adopters inherit those pins, including
`configure-aws-credentials` in front of a CDK-admin OIDC role. Under (a) they would
lag behind the workflows, since `actions/checkout` and `actions/setup-node` appear in
both.

A cheap guard would be to have `scripts/check-action-pins.mjs` (`pnpm lint:actions`)
fail when an action appears in both a workflow and a template/example at different
SHAs. A Dependabot PR would then go red until the template followed. That guard only
has a job under (a).

## Decision

**(b), JP, 2026-09-11: Dependabot stays security-only** for both ecosystems, and
`.github/dependabot.yml` is unchanged. Pins move when an annotation or a security
advisory forces a manual sweep, which is what DEVELOPING.md's CI Workflow
Conventions now says. The guard above is not needed.

For the next manual sweep, start from
[gha-actions-node20-runtime.md](gha-actions-node20-runtime.md)'s Resolution. It
shows how each SHA was resolved and checked, and how the result was measured
against the old pins in CI. The sweep has to cover the adopter template and the
example as well, because `lint:actions` checks that they are SHA-pinned, not that
they are current.
