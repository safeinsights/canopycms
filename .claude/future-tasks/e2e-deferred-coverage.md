# E2E capabilities consciously deferred by the coverage sweep

**Priority:** P2 — each is covered at another layer today; none is a silent gap
**Recorded:** 2026-07-30, program workstream C

The full reasoning per capability is in
[apps/test-app/e2e/COVERAGE-MATRIX.md](../../apps/test-app/e2e/COVERAGE-MATRIX.md).
This file is the actionable residue: the deferrals that need a fixture or
harness investment before they can be covered, grouped by what unblocks them.

## Needs a prod-mode test app

- **B5** — the `protected-branch-banner` / read-only base branch. `readOnly` is
  `mode: 'prod'` only by design, and the e2e app is `mode: 'dev'`, so the banner
  can never render there. Covered across the prod/dev matrix by
  `protected-branch.test.ts`.

A second test app (or a prod-mode variant of the existing one) would also unlock
prod-only guard behaviour generally. Overlaps [dual-build-ci.md](resolved/dual-build-ci.md).

## Needs a fake GitHub

- **B13** — auto-detect merged PRs and fast-forward the base workspace on sync.
  Requires real PR state to poll; `cms-worker-merge-poll.test.ts` covers it
  against a mocked GitHub service.

## Needs a bigger content/permissions fixture set

- **D5** — path-based access filtering of the entry list. The test app runs
  `defaultPathAccess: 'allow'` with no restrictive rules; covering this means a
  dedicated schema + permissions fixture.
- **E11** — pagination loading all entries. Needs a collection seeded past one
  page. Overlaps [entry-navigator-scalability.md](entry-navigator-scalability.md).

## Needs a server-side hook to force a state

- **E8 / E9** — provisioning loading state and the `entriesInitializing`
  "Loading…" pane. Both are transient states that race the harness's own
  provisioning wait; forcing them deterministically needs an injectable delay.
- **E14** — modal error propagation / derived field errors, and the untested
  "save failure shows an error notification" backlog item. Needs a forced 500.

## Needs a test-app config change with wide blast radius

- **E10** — the preview error channel and the `validateEntry` save hook. Requires
  an adopter-supplied `validateEntry` in the test app, which would run on every
  save in every existing spec.

## Deliberately not e2e

- **C10** crop step (canvas drag; crop math is unit-tested), **C11** MDX image
  dialog (blocked on
  [markdownfield-mdxeditor-mount-flake.md](markdownfield-mdxeditor-mount-flake.md)),
  **C12** SVG sanitize / sniff / size caps (pure server pipeline), **C9**
  admin-only asset delete, **D4** OCC 409 on concurrent settings save
  (see [settings-conflict-resolution-ux.md](settings-conflict-resolution-ux.md)),
  **E2** string-list comma/duplicate handling, **E7** comments copy changes.
- **F1–F5** — CLI (`init`, `migrate`), CDK constructs, static-build validation
  and dual-build shapes. Not browser-reachable; F5 is tracked by
  [dual-build-ci.md](resolved/dual-build-ci.md).
