# `worker/` — Worker

The CmsWorker daemon and the git sync/rebase loop. The queue contract it consumes (`cms-task-queue.ts`, `task-queue-config.ts`, `worker-status.ts`) lives in `../task-queue/`.

The **code comment at the point of the rule is authoritative**; this file is the map to
where those rules live.

## Module map

Each of the four disjoint call trees under `start()` is its own module, reached through a
`WorkerContext`.

| File                        | What it owns                                                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cms-worker.ts`             | The `CmsWorker` class: fields, constructor, `start`/`stop`, the cross-host worker lock, `scheduleLoop`, `remote.git` provisioning, `branchWorkspacePath`, `refreshAuthCache`, and one delegating method per cluster entry point |
| `worker-context.ts`         | `WorkerContext` — the only channel between the class and the extracted clusters                                                                                                                                                 |
| `task-runner.ts`            | The task-queue cluster: `processTaskQueue` and everything below it                                                                                                                                                              |
| `git-sync.ts`               | The git-sync cluster: `syncGit` and everything below it except the rebase loop                                                                                                                                                  |
| `rebase.ts`                 | The rebase loop, the deepest leaf of the git-sync cluster                                                                                                                                                                       |
| `history-rewrite.ts`        | The [SYNC-H1] kernel all three clusters touch                                                                                                                                                                                   |
| `canopy-state.ts`           | Sync's handling of tracked `.canopy-meta/` state                                                                                                                                                                                |
| `provisioned-workspace.ts`  | Zero-retry provisioning-lock hold                                                                                                                                                                                               |
| `remote-git-maintenance.ts` | `remote.git` repack, logged (rule and gc config: `git-manager.ts`)                                                                                                                                                              |
| `sparse-cone.ts`            | Re-applying a changed sparse cone                                                                                                                                                                                               |
| `schema-gate.ts`            | Holding base for an editor deploy                                                                                                                                                                                               |
| `log.ts`                    | `workerLog`/`workerLogWarn`/`workerLogError`                                                                                                                                                                                    |
| `github-gateway.ts`         | `GitHubGateway`, the only user of the credential and Octokit, and its in-process implementation                                                                                                                                 |
| `github-auth.ts`            | Credential selection (token or App), installation-token minting, the PAT swap behind its 60s floor, PEM normalization                                                                                                           |
| `github-mirror.ts`          | The gateway's private GitHub mirror, the only repository where git carries the credential                                                                                                                                       |
| `shared-repo-git.ts`        | How the worker runs git in `remote.git` and the clones: the pins, the pinned pack commands, the config allowlist check                                                                                                          |

Imports run one way only — `cms-worker` → {`task-runner`, `git-sync`} → `rebase` →
`history-rewrite` → `worker-context`, with `canopy-state`, `provisioned-workspace`, `sparse-cone`, `schema-gate` and `remote-git-maintenance` leaves under `git-sync` and `rebase` (`cms-worker` also imports `schema-gate`). `github-gateway` sits outside that chain: `cms-worker` creates the instance, clusters reach it
via `ctx.github()`, and `github-auth`, `github-mirror` and `shared-repo-git` sit below it. `pnpm lint:cycles` enforces that the graph stays
ACYCLIC, which is not the same thing: a new `rebase.ts` → `task-runner.ts` edge would pass
lint and still break the layering above. Keep the direction by review.

## Where each rule lives

- Fresh context per call; every instance-backed member is a FUNCTION: `worker-context.ts`,
  the `WorkerContext` doc comment (INVARIANT).
- Extracted modules call `ctx.executeTask` / `ctx.pushBranchToGitHub`, never the module-level
  function: the same comment, and the `TaskRunnerContext` pick list in `task-runner.ts`.
- Non-fast-forward and workflow-content push refusals fail fast as `PermanentTaskError`, not
  retries: `task-runner.ts`, `pushBranchToGitHub`'s rejection branches.
- Sync-cycle order, upkeep ahead of the GitHub fetch: `git-sync.ts`'s top comment.
- Schema gate scope, fail-open and bound: `schema-gate.ts`, `decideBaseAdvance`.
- Push ONLY this deployment's settings branch: `git-sync.ts`, `pushSettingsBranches`'s doc.
- The drain's rules: `cms-worker.ts`'s `stop()`.
- Every worker-status.json write holds the worker lock, a pre-`start()` failure's and a lock
  loss's included; `selfStopped` settles only for a stop the worker chose: `cms-worker.ts`.
- `scrubPersistedRemote` fails CLOSED and re-runs every boot: `cms-worker.ts`.
- No push, plain or leased, to the base branch or GitHub's default branch, whatever a task asks:
  `github-mirror.ts`, `MirrorSession.pushToGitHub` (`RefusedPushError`).
- The credential only in mirror sessions' per-command files (`withCredentialConfig`); other
  shared-repository git only via `sharedRepoGit`, after `assertSharedRepoConfig`:
  `shared-repo-git.ts`'s module doc.
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
  `canopycms-cdk/worker/run.ts` has no other entrypoint: `cms-worker.ts`, at that re-export.
- github-auth's invariants (mint timeouts, no token caching, no re-wrapped mint rejection):
  `github-auth.ts`, at each rule; the fail-closed boot check: `github-gateway.ts`.

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
