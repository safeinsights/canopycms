# [P3] RESOLVED — Pinned GitHub Actions still declare the Node 20 runtime

See [Resolution](#resolution) at the end.

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

Separate from [node-version-alignment.md](../node-version-alignment.md), which covers
the Node version the project itself targets, not the runtime the actions declare.

## Resolution

2026-09-11, branch `chore/actions-node24`, base `int-202609-a`.

The annotation lists only the actions used by the job it appears on, so three was
an undercount. Every third-party action we pin was on Node 20: CI also carried
`actions/cache`, `upload-artifact`, `download-artifact` and `dorny/paths-filter`,
`publish.yml` carried `create-github-app-token`, and the adopter template and the
example carried `aws-actions/configure-aws-credentials`. All nine are re-pinned
across the three workflows, `deploy-cms.yml.template` and
`examples/aws-deployment/deploy-cms.yml`. Each SHA came from
`gh api repos/OWNER/REPO/commits/TAG`, and `runs.using: node24` was read from
`action.yml` at that SHA rather than at the tag.

| Action | Was | Now |
| --- | --- | --- |
| `actions/checkout` | v4 | v7.0.1 |
| `actions/setup-node` | v4 | v7.0.0 |
| `pnpm/action-setup` | v4 | v6.1.0 |
| `actions/cache` | v4 | v6.1.0 |
| `actions/upload-artifact` | v4 | v7.0.1 |
| `actions/download-artifact` | v4 | v8.0.1 |
| `actions/create-github-app-token` | v2 | v3.2.0 |
| `dorny/paths-filter` | v3 | v4.0.3 |
| `aws-actions/configure-aws-credentials` | v4 | v6.2.4 |

**Two departures from the Fix above.** JP approved the first; the second was my
call, and he was not asked about it:

- **Latest release, not the first `node24` one.** The first `node24` majors are
  already superseded (checkout v5 by v6 and v7), so pinning them would only have
  scheduled this again. Every intermediate major's changelog was read.
- **Full-version comments** (`# v7.0.1`), not `# vN`. A SHA is one exact release,
  and `v7.0.1` is the tag that resolves to it. `# v7` names a tag that moves.

**Changelog items that touch us:**

- **setup-node v7** stops exporting a dummy `NODE_AUTH_TOKEN` when `registry-url`
  is set. Upstream's stated reason (actions/setup-node#1558) is cleaner OIDC
  publishing, which is how we publish. It is the one change to how publishing
  authenticates, and the first thing to run it is a prerelease dispatch.
- **checkout v6** writes the persisted credential to its own file under
  `$RUNNER_TEMP` and has `.git/config` include that file, so `publish.yml`'s
  `git push` still picks it up. **v7** refuses fork-PR checkout under
  `pull_request_target`/`workflow_run`; we use neither.
- **create-github-app-token v3.1.0** deprecated `app-id` (v3.0.0's `action.yml`
  has no `deprecationMessage` on it; v3.1.0's does). Switched to
  `client-id: ${{ vars.RELEASE_BOT_CLIENT_ID }}`: a public identifier, hence a
  variable, not a secret.
- **download-artifact v8** fails on a digest mismatch instead of warning.
- **pnpm/action-setup v6** bootstraps pnpm 11, then self-updates to the
  `packageManager` pin.

**Verification.** PR #317's CI at `403a3afb` against PR #316's at `54f249d5` (old
pins), same eight jobs. Counts come from the jobs API and from full job logs
fetched with `gh api --allow-escape-sequences`. Without that flag, `gh` refuses a
log that contains escape codes: nothing goes to stdout, the refusal goes to stderr,
and a `grep -c` piped from it reads 0.

- The Node 20 annotation was on all 8 jobs before and is on none after.
- The `[DEP0040] punycode` deprecation printed 2–8 lines per job before and none
  after, in all eight job logs.
- Every job's step conclusions match: the same steps ran and the same one was
  skipped, so no `paths-filter` gate turned the run vacuous.
- The new pins print two log lines of their own, neither an annotation:
  - pnpm/action-setup v6's `Detected a pnpm v10 installation layout at PNPM_HOME`
    WARN, once per job. The only v5 release, 5.0.0, bootstraps pnpm 8 and was
    never patched, so v6 stays.
  - download-artifact v8's `[DEP0005] Buffer()` deprecation, once, in Merge E2E.
- The publish path was reproduced locally with pnpm 10.12.1 and npm 11.19.0,
  against an `.npmrc` written the way setup-node v7 writes it, with
  `NODE_AUTH_TOKEN` unset:
  - `pnpm install`, `pnpm pack` and `npm publish --dry-run` exit 0, and
    `npm view canopycms version` still returns the published version.
  - pnpm prints `WARN Failed to replace env in config: ${NODE_AUTH_TOKEN}` on
    each command.
  - npm's OIDC exchange overwrites whatever token is configured (npm v11.19.0
    `lib/utils/oidc.js`, `config.set(authTokenKey, response.token, 'user')`).
  - Dropping `registry-url` would silence the warning, but setup-node's own
    Trusted Publisher example keeps it, so it stays. The cost is log noise in a job
    that runs once per release.

Decided separately the same day: Dependabot stays security-only, so the next sweep
will be manual too. See
[dependabot-actions-version-updates.md](dependabot-actions-version-updates.md).
