# E2E harness follow-ups from the coverage sweep

**Priority:** P2 — latent harness defects; none currently breaks a test
**Found:** 2026-07-30, program workstream C (see
[apps/test-app/e2e/COVERAGE-MATRIX.md](../../apps/test-app/e2e/COVERAGE-MATRIX.md))

Four issues surfaced while adding 45 e2e tests. Each was worked around rather
than fixed, to keep the coverage work reviewable.

## 1. Settings workspace is never reset between tests or runs

`resetWorkspace()` now resets `content-branches/`, the task queue
(`.canopy-dev/.tasks`) and the asset store (`.canopy-dev/assets`) — but **not**
the settings workspace that holds `permissions.json` and `groups.json`. A
permission assigned by one run persists into the next, which can turn a later
"assign a group" step into a silent no-op.

`permissions-groups.spec.ts` works around this with its own
`clearPermissionsViaApi()` helper. The durable fix is to reset that workspace in
`resetWorkspace()` alongside the other two, which also protects the two
back-to-back-runs acceptance gate.

## 2. `TEST_USERS.admin.userId` does not match the real dev auth id

`apps/test-app/e2e/fixtures/test-users.ts` declares `userId: 'test-admin'`, but
`canopycms-auth-dev` maps the `admin` test key to `DEV_ADMIN_USER_ID`
(`'dev_admin_3xY6zW1qR5'`). Any assertion comparing a persisted `createdBy`
against the fixture's `userId` is wrong.

`admin-branch-health.spec.ts` imports the real `DEV_ADMIN_USER_ID` constant for
its repair assertion. Either make the fixture re-export the real ids or drop the
`userId` fields so nobody trusts them.

## 3. `listBranchesViaAPI` has a wrong return type

Typed `Promise<unknown[]>`, but `GET /branches` returns an envelope
`{ ok, status, data: { branches, defaultBranch } }`, not a bare array. Currently
unused by any spec, so latent.

## 4. `submitBranchViaAPI` consumes the response body

It calls `.text()` internally for its own failure logging, so a caller that then
calls `.json()`/`.text()` on the returned `Response` gets
"Body is unusable: Body has already been read."

`branch-state-badges.spec.ts` sidesteps it with a raw `fetch`. Either return the
parsed body alongside the response, or clone before reading.
