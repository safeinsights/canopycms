# Git Conflict Handling & Safe Branch Operations

## Problems

Three related issues that need to be solved together:

### 1. `checkoutBranch` silently force-resets existing local branches

`git-manager.ts:494–518` — fetch errors are silently swallowed, then code falls through to `checkout(['-B', branch, this.baseBranch])`. `-B` force-resets the branch to `baseBranch` even if the branch already has local commits. An existing feature branch can silently lose commits.

```ts
// Current (dangerous):
try { await git.fetch(...) } catch {} // swallowed!
// then: checkout(['-B', branch, this.baseBranch])  ← force-reset
```

Fix: Distinguish three cases: (1) branch exists locally → plain `checkout`, never `-B`; (2) remote ref found after successful fetch → create tracking branch; (3) neither → create new local branch. Never use `-B` against an existing branch.

### 2. `merge`/`rebase` conflicts leave workspace in broken state

`git-manager.ts:520–535` — `git.merge()` and `git.rebase()` throw on conflict but there is no `catch`. The repository is left with `.git/MERGE_HEAD` / `.git/REBASE_MERGE` present. Subsequent operations on the workspace fail unpredictably.

### 3. Worker `stop()` doesn't await all active operations (COMPOUND-3)

`worker/cms-worker.ts:260–276` — three concurrent `scheduleLoop` calls all overwrite `this.currentOperation`. `stop()` only awaits the one that wrote last. On spot-instance SIGTERM, an in-flight git operation (which may itself be in a merge) is abandoned.

Combined with #2: if a spot instance terminates mid-merge, no abort runs and no `stop()` await fires → EFS branch workspace is permanently in broken rebase state requiring manual intervention.

## Proposed Solution

### Typed git errors

```ts
export class GitConflictError extends Error {
  constructor(public readonly conflictedFiles: string[]) {
    super(`Git conflict in ${conflictedFiles.length} file(s): ${conflictedFiles.join(', ')}`)
  }
}
export class GitAuthError extends Error {}
export class GitNetworkError extends Error {}
export class GitNonFastForwardError extends Error {}
```

### Wrap merge/rebase with abort-on-conflict

```ts
async pullCurrentBranch(workspacePath: string): Promise<void> {
  const git = simpleGit(workspacePath)
  try {
    await git.merge(['--ff-only', 'origin/' + branchName])
  } catch (err) {
    await git.merge(['--abort']).catch(() => {})
    const status = await git.status()
    throw new GitConflictError(status.conflicted)
  }
}
```

### Track all active operations in worker

```ts
// cms-worker.ts
private activeOperations = new Set<Promise<void>>()

private track(op: Promise<void>): void {
  this.activeOperations.add(op)
  op.finally(() => this.activeOperations.delete(op))
}

async stop(): Promise<void> {
  this.stopping = true
  await Promise.race([
    Promise.allSettled([...this.activeOperations]),
    new Promise<void>((r) => setTimeout(r, this.taskTimeoutMs)),
  ])
}
```

### Conflict UX (future work)

When `GitConflictError` is thrown from a sync/rebase operation, surface it as a branch status `conflicted` state. The editor should show a conflict UI (not blocking saves to non-conflicted files). See BACKLOG.

## Priority

- **High** — affects any prod deployment using sync/rebase
- Checkpoint: fix issues 1 + 2 first (worker stop is lower blast radius)

## Files

- `packages/canopycms/src/git-manager.ts`
- `packages/canopycms/src/worker/cms-worker.ts`
- `packages/canopycms/src/worker/task-queue.ts`
- `packages/canopycms/src/types.ts` (add BranchStatus 'conflicted' if needed)

## Related

- Review report: HIGH-3, HIGH-4, COMPOUND-3
- `index-staleness-multiprocess.md` — git ops also invalidate the content ID index (CRIT-2 from review)
