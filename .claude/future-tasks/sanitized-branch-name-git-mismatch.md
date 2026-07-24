# Verify sanitized-vs-git branch-name behavior for slashed branch names

## Priority: P2

Surfaced during exploration for the protected-base-branch work (2026-07-24).
Unverified suspicion — first step is to confirm or refute, then scope.

## Problem (suspected)

Branch names are sanitized for filesystem use (`sanitizeBranchName`,
paths/branch.ts: `feature/foo` → `feature-foo`), and `openOrCreateBranch`
(branch-workspace.ts) passes the **sanitized** name to
`GitManager.initializeWorkspace` as `branchName`, while metadata `branch.name`
is also the sanitized form. For CMS-created branches that's self-consistent —
the git branch is simply named `feature-foo`. The suspect case is dev mode with
a slashed HEAD branch: the developer is on git branch `feature/foo`, the
auto-provisioned "base" workspace gets git branch `feature-foo`, and everything
that compares against or pushes to the real branch name (`refreshActiveBranch`
detection returns the raw name; worker fetches use raw `baseBranch`; the
simulated remote serves raw names) may disagree with the clone's checked-out
sanitized name. The protected-branch predicate compares sanitized-to-sanitized,
so protection itself is safe — but workspace seeding, sync push/pull targets,
and PR head/base names may not round-trip.

## Scope of verification

- Dev mode on a `feature/foo` checkout: does workspace provisioning succeed, and
  which branch name does the clone check out? Does `canopycms sync` work?
- Prod with `defaultBaseBranch: 'release/1.0'`: workspace seeding, worker
  `refreshBaseBranchWorkspace` (fetches raw name, filesystem uses sanitized),
  PR base names.
- If broken: either keep the raw git name for git ops end-to-end (sanitize only
  for paths, like cms-worker's raw-vs-sanitized split), or reject slashed
  base-branch names loudly at config validation.

## Related

- `paths/branch.ts` `sanitizeBranchName`; `branch-workspace.ts`
  `openOrCreateBranch` → `ensureGitWorkspace`
- `worker/cms-worker.ts` — already splits raw (`this.baseBranch`) vs sanitized
  (`this.sanitizedBaseBranch`) usage; the model to follow
