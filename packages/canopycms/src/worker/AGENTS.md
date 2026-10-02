# `worker/` — Worker

The CmsWorker daemon and the git sync/rebase loop. The queue contract it consumes (`cms-task-queue.ts`, `task-queue-config.ts`, `worker-status.ts`) lives in `../task-queue/`.

The **code comment at the point of the rule is authoritative**; this file is the map to
where those rules live.

## Module map

Each of the four disjoint call trees under `start()` is its own module, reached through a
`WorkerContext`.

| File                 | What it owns                                                                                                                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cms-worker.ts`      | The `CmsWorker` class: fields, constructor, `start`/`stop`, the cross-host worker lock, `scheduleLoop`, `remote.git` provisioning, `buildGitHubUrl`/`refreshGitHubCredential`/`branchWorkspacePath`, `refreshAuthCache`, and one delegating method per cluster entry point |
| `worker-context.ts`  | `WorkerContext` — the only channel between the class and the extracted clusters                                                                                                                                                                                            |
| `task-runner.ts`     | The task-queue cluster: `processTaskQueue` and everything below it                                                                                                                                                                                                         |
| `git-sync.ts`        | The git-sync cluster: `syncGit` and everything below it except the rebase loop                                                                                                                                                                                             |
| `rebase.ts`          | The rebase loop, the deepest leaf of the git-sync cluster                                                                                                                                                                                                                  |
| `history-rewrite.ts` | The [SYNC-H1] kernel all three clusters touch                                                                                                                                                                                                                              |
| `log.ts`             | `workerLog`/`workerLogWarn`/`workerLogError`                                                                                                                                                                                                                               |
| `github-auth.ts`     | GitHub credential selection (token or App), installation-token minting, the PAT swap in `refreshCredential` behind its 60s floor, PEM normalization                                                                                                                        |

Imports run one way only — `cms-worker` → {`task-runner`, `git-sync`} → `rebase` →
`history-rewrite` → `worker-context`. `github-auth` sits outside that chain as a leaf:
`cms-worker` imports it, and it imports nothing from `worker/`. `pnpm lint:cycles` enforces that the graph stays
ACYCLIC, which is not the same thing: a new `rebase.ts` → `task-runner.ts` edge would pass
lint and still break the layering above. Keep the direction by review.

## Where each rule lives

Every rule below is stated at the point it applies, in the code. This section only says
which comment owns it.

- Fresh context per call; every instance-backed member is a FUNCTION: `worker-context.ts`,
  the `WorkerContext` doc comment (INVARIANT).
- Extracted modules call `ctx.executeTask` / `ctx.pushBranchToGitHub`, never the module-level
  function: the same comment, and the `TaskRunnerContext` pick list in `task-runner.ts`.
- Non-fast-forward push rejection fails fast as `PermanentTaskError`, not retries:
  `task-runner.ts`, `pushBranchToGitHub`'s rejection branches.
- Push ONLY this deployment's settings branch: `git-sync.ts`, `pushSettingsBranches`'s doc.
- `scrubPersistedRemote` fails CLOSED and re-runs every boot: `cms-worker.ts`, at that
  function (it is part of provisioning, so it stays there).
- `rebaseOneBranch` never throws; the `rebased` rider on `{ kind: 'failed' }`: `rebase.ts`,
  `BranchRebaseOutcome`.
- Interrupted-rebase recovery is lossy and keyed on the WORKING-TREE column: `rebase.ts`, the
  `isRebaseInProgress` block.
- MODIFY/DELETE conflicts resolve by `git rm`/`git add`: `rebase.ts`, inside `runRebaseRounds`'s
  conflict branch.
- ABORT OWNERSHIP is split across four sites, none redundant: `rebase.ts`, `runRebaseRounds`'s
  doc comment.
- `isLockCompromised` is a CALLBACK because [SYNC-C1] the lock can be lost between rounds: the
  same comment.
- [SYNC-H1] every force push leases on a commit THIS worker replaced: `history-rewrite.ts`, the
  module doc comment.
- Worker log prefix (CloudWatch `multi_line_start_pattern`): `log.ts`, the module doc comment
  (INVARIANT); enforced by eslint `no-restricted-syntax` on `**/worker/**`, which a new file
  here inherits.
- The `log.ts` re-export from `cms-worker.ts` must survive any reshuffle, since
  `canopycms-cdk/worker/index.ts` has no other entrypoint: `cms-worker.ts`, at that re-export.
- github-auth's own invariants (fail-closed boot classification, mint-timeout bounds, never
  caching a resolved token, never re-wrapping a mint rejection): `github-auth.ts`, at each rule.

## `github-auth.ts`: the one cross-file rule

**`@octokit/auth-app` must never become a dependency of `canopycms`.** It spans files,
which is why it is here and the rest are in the code. `github-service.ts` is reachable
from `services.ts`, so anything it imports lands in every adopter's Next.js **server**
bundle — including the majority who use a personal access token and will never register a
GitHub App. The package therefore holds only the SHAPE (`OctokitAuthStrategyOptions` in
`github-service.ts`, `GitHubAppAuth` here); a deployment using an App constructs the
strategy in its own entrypoint and injects it, through the seam `refreshAuthCache` uses.

Two guards hold it, and **neither is `pnpm lint:bundle`**, which cruises only the two
client entries and never reaches `github-service.ts`: the `core-no-github-app-auth`
dependency-cruiser rule, evaluated by `pnpm lint:cycles` (CI and the pre-commit hook), and a
manifest assertion in `github-auth.test.ts`.
