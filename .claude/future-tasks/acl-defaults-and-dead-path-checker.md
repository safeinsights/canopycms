# Scaffolded ACL default vs. schema default, and a dead path checker that answers "allow"

## Priority: P1

Split out of [baseline-2026-08-production-and-followups.md](resolved/baseline-2026-08-production-and-followups.md)
(findings B4 and B8) on 2026-08-13, when the rest of that review's findings were
fixed and the record moved to `resolved/`. Both items below were **re-verified
still open at `78e4ca8b`**.

They are filed together because the first makes the second dangerous.

## B8 — `canopycms init` scaffolds the opposite of the schema default

`config/schemas/config.ts:14` defaults `defaultBranchAccess` to fail-closed
`'deny'`. `cli/template-files/canopycms.config.ts.template:4` scaffolds
`'allow'`. So "secure by default" is true of the schema and false of every
project the CLI generates. All three in-repo apps (`example1`, `test-app`,
`dual-build-fixture`) inherit the scaffolded value.

This is defensible — a frictionless first run matters, and an adopter who hits
"permission denied" on their own new branch before they have configured anything
is a bad first experience. But it should be a **recorded decision** rather than
an accident of the template, and at minimum the template needs a comment naming
what to tighten before a multi-editor production deployment.

Relevant now: website v2 will be the first deployment with multiple editors who
do not all trust each other by default.

## B4 — `services.checkPathAccess` is bound to an empty rule set

`services.ts:236` binds `checkPathAccess` with an **empty rules array**. It
therefore ignores every configured permission rule and answers purely from
`defaultPathAccess`. Under a scaffolded `defaultBranchAccess: 'allow'` project,
that means allow-everything.

It is exposed on the services surface at `services.ts:510` with **zero
production consumers** — verified repo-wide, the only non-mock reference is
`services.test.ts:91-92`, a test that blesses the shape rather than the
behaviour. So nothing is broken today. The hazard is that it is a well-named,
plausible-looking, publicly reachable checker that silently does not check, sitting
one autocomplete away from the next person who needs a path check.

**Fix:** delete it, or bind it lazily to the real settings-branch rules the way
`createContentAccessChecker` already does. Deleting is preferable unless a
consumer is actually wanted — a dead correct API is better than a live wrong one,
and this one currently fails open.

PR #226's `repair-metadata` work removed one *consequence* of the `'allow'`
default but did not touch the default or this binding.

## Acceptance

- A deliberate, written decision on the template's `defaultBranchAccess` value,
  reflected in the template (either changed to `'deny'`, or kept at `'allow'`
  with a comment stating the tightening step and why).
- `services.checkPathAccess` is either removed from the services surface or
  bound to real rules, with a test that would fail against the empty-array
  binding.

## Related

- [authorization-enforcement-consolidation.md](authorization-enforcement-consolidation.md)
  — the matcher divergence and enforcement gaps split out of the same review
- [branch-namespace-validation-gaps.md](branch-namespace-validation-gaps.md) —
  B2's settings-branch shadow clone is reachable partly *because* of the
  scaffolded `'allow'`
- [client-server-workflow-permission-divergence.md](client-server-workflow-permission-divergence.md)
  — the same `'allow'`-vs-`'deny'` split is what makes that divergence latent
  rather than live for today's adopters
