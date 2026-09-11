# [P3] Pinned GitHub Actions still declare the Node 20 runtime

Found 2026-09-11 while tracing CI log noise (the canopycms-cdk deprecation flood,
fixed separately). Every job's "Complete job" step ends with an annotation:

> Node.js 20 is deprecated. The following actions target Node.js 20 but are being
> forced to run on Node.js 24: actions/checkout@11d5960a…, actions/setup-node@49933ea5…,
> pnpm/action-setup@b906affc…

All three are pinned by SHA at their `# v4` tags, 7 uses each across
`.github/workflows/`. GitHub already runs them on Node 24 and they work, so nothing
is broken today. The cost is one more warning annotation on every job of every run,
the same kind of noise that hid the cdk flood, until the pins declare `node24`. The post-job
`[DEP0040] DeprecationWarning: The punycode module is deprecated` line in the same
log most likely comes from one of these actions' bundled dependencies. Verify that
it disappears after the bump rather than assuming so.

## Why nothing will fix it automatically

`.github/dependabot.yml` sets `open-pull-requests-limit: 0` for `github-actions`,
so it only raises security updates. Version bumps like this one never arrive.

## Fix

Bump each action to the first release that declares `runs.using: node24`, re-pin to
that release's commit SHA (`pnpm lint:actions` rejects tag-only refs), and keep the
`# vN` comment. Read each major version's changelog for changed inputs or defaults
before re-pinning. Done when a CI run's job annotations no longer carry the Node 20
notice.

Separate from [node-version-alignment.md](node-version-alignment.md), which covers
the Node version the project itself targets, not the runtime the actions declare.
