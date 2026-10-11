import fs from 'node:fs/promises'
import path from 'node:path'

import type { SimpleGit } from 'simple-git'

import { isSettingsBranchName, sanitizeBranchName } from '../paths/branch-name'
import { listTasks } from '../task-queue/cms-task-queue'
import { getErrorMessage, isNodeError } from '../utils/error'
import { branchProvisioningLockName, tryAcquireProvisioningLock } from '../utils/provisioning-lock'
import { releaseProvisionedWorkspace } from './provisioned-workspace'
import type { WorkerContext } from './worker-context'

export type StaleMirrorContext = Pick<
  WorkerContext,
  'baseBranch' | 'contentBranchesPath' | 'taskDir' | 'remoteGitPath'
>

/**
 * Why a `remote.git` head is kept as this deployment's own rather than treated as a copy of
 * GitHub's: the base branch; a settings branch (its workspace lives outside the branches root, and
 * a stranded one is [SYNC-M3]'s signal); a head GitHub no longer has whose history shares no commit
 * with the base, as a settings branch's never does, even under a name this worker does not know as
 * one; a branch workspace at its sanitized name (which is also where the [SYNC-H1] marker lives); a
 * push task queued or running for it; its provisioning lock held, so a workspace may be appearing;
 * this deployment's settings branch unresolvable, so any head may be it; or the check failing.
 */
export type EditorState =
  | 'base'
  | 'settings'
  | 'unrelated-history'
  | 'workspace'
  | 'queued-push'
  | 'busy'
  | 'unresolved-settings'
  | 'unchecked'

/**
 * The branches root and the task queue as read once this cycle, by sanitized name. A name in
 * `workspaces` is kept without taking its lock; one absent there is re-read under the lock.
 */
export interface EditorWorkSnapshot {
  workspaces: ReadonlySet<string>
  queuedPushes: ReadonlySet<string>
}

/**
 * Read {@link EditorWorkSnapshot}, once per sync cycle and after the heads it applies to. Pending is
 * listed before processing, since a claim moves a task from the first to the second. A push task
 * queued after this read comes from a workspace, which {@link settleStaleMirror}'s lock keeps from
 * appearing, or was planted; one that slips past it (put back to pending between the two listings)
 * reads the head before the update, and pushes what it would have pushed without it, or after, and
 * finds nothing of its own to push.
 */
export async function readEditorWork(
  ctx: Pick<StaleMirrorContext, 'contentBranchesPath' | 'taskDir'>,
): Promise<EditorWorkSnapshot> {
  const workspaces = new Set(await fs.readdir(ctx.contentBranchesPath).catch(() => []))
  const queuedPushes = new Set<string>()
  for (const status of ['pending', 'processing'] as const) {
    for (const task of await listTasks(ctx.taskDir, status, Number.POSITIVE_INFINITY)) {
      const payload: unknown = task.payload
      const branch =
        typeof payload === 'object' && payload !== null
          ? (payload as Record<string, unknown>).branch
          : undefined
      // Compared sanitized, the form a workspace's directory takes, so near-collisions count too.
      if (task.action.startsWith('push') && typeof branch === 'string') {
        queuedPushes.add(sanitizeBranchName(branch))
      }
    }
  }
  return { workspaces, queuedPushes }
}

export type MirrorSettlement =
  /** The head now matches GitHub: moved to GitHub's tip, or deleted when GitHub has no such branch. */
  | { kind: 'settled' }
  /** `error` says why an `unchecked` head could not be checked. */
  | { kind: 'kept'; state: EditorState; error?: string }
  /** The head moved after it was read; the lease refused the update, and the next cycle retries. */
  | { kind: 'moved-meanwhile'; error: string }
  /**
   * `packed-refs.lock` is held, which every deletion needs: by a concurrent deletion, or left by a
   * git killed mid-delete, which github-transfer.ts reports once it is stale.
   */
  | { kind: 'packed-refs-locked' }

/**
 * Bring `remote.git`'s `refs/heads/<name>` to GitHub's tip `to` (null: delete it, GitHub having
 * no such branch) when the head holds no editor work: it is then a stale copy of GitHub's branch,
 * left by a force-push or a deletion on GitHub. `from` is the head as this cycle read it.
 *
 * The check and the update run under the branch's provisioning lock, taken zero-retry: the lock
 * the Lambda holds while it publishes a branch workspace and admin actions hold while they purge
 * or repair one. Every route to editor work in this head starts with a workspace (a submit pushes
 * from one, the rebase loop's push task is armed from one), and none can be published while this
 * holds the lock, so a workspace absent here stays absent until the update is done. A lock held
 * elsewhere keeps the head for this cycle. The update leases on `from`, so a push that moved the
 * head meanwhile wins and the head is revisited next cycle.
 *
 * A push task queued for the branch keeps the head too, as `editorWork` listed the queue. The
 * update names the head itself (`--no-deref`): the listing skips symbolic refs, and one planted
 * between the listing and the update fails the lease rather than moving the ref it points at.
 *
 * Every party that can write this head can already set it to any value it holds or delete it:
 * the update only ever makes the head match GitHub, as the gateway's fetch reported it.
 */
export async function settleStaleMirror(
  ctx: StaleMirrorContext,
  git: SimpleGit,
  head: { name: string; from: string; to: string | null },
  ownSettingsBranch: string,
  editorWork: EditorWorkSnapshot,
  /** GitHub's base tip, against which a head GitHub no longer has must share history. */
  baseTip: string,
): Promise<MirrorSettlement> {
  const { name, from, to } = head
  if (name === ctx.baseBranch) return { kind: 'kept', state: 'base' }
  if (isSettingsBranchName(name, ownSettingsBranch)) return { kind: 'kept', state: 'settings' }

  const dirName = sanitizeBranchName(name)
  if (editorWork.workspaces.has(dirName)) return { kind: 'kept', state: 'workspace' }
  if (editorWork.queuedPushes.has(dirName)) return { kind: 'kept', state: 'queued-push' }
  if (to === null && !(await sharesHistory(git, from, baseTip))) {
    return { kind: 'kept', state: 'unrelated-history' }
  }
  let release: () => Promise<void>
  try {
    release = await tryAcquireProvisioningLock(
      ctx.contentBranchesPath,
      branchProvisioningLockName(dirName),
    )
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ELOCKED') return { kind: 'kept', state: 'busy' }
    throw err
  }
  try {
    // Listing the root opens it, which makes NFS revalidate the directory rather than answer
    // from a cached name lookup. Anything at the name counts, residue included.
    if ((await fs.readdir(ctx.contentBranchesPath)).includes(dirName)) {
      return { kind: 'kept', state: 'workspace' }
    }
    const ref = `refs/heads/${name}`
    try {
      await git.raw(
        to === null
          ? ['update-ref', '--no-deref', '-d', ref, from]
          : ['update-ref', '--no-deref', ref, to, from],
      )
    } catch (err: unknown) {
      // sharedRepoGit pins the C locale, so the text is git's own. Anything else is the caller's
      // to report.
      const message = getErrorMessage(err)
      if (lockHeld(message) === path.join(ctx.remoteGitPath, 'packed-refs.lock')) {
        return { kind: 'packed-refs-locked' }
      }
      // The lease's refusal, or the ref's own lock held by a concurrent writer.
      if (/cannot lock ref|Unable to create '[^']*\.lock': File exists/.test(message)) {
        return { kind: 'moved-meanwhile', error: message }
      }
      throw err
    }
    return { kind: 'settled' }
  } finally {
    await releaseProvisionedWorkspace(release, dirName)
  }
}

/**
 * The lock file git found held, normalised, or null. A branch's own lock lives under `refs/`,
 * and its name can end in `packed-refs.lock` too, so only the repository's own path counts.
 */
function lockHeld(message: string): string | null {
  const match = /Unable to create '([^']*)': File exists/.exec(message)
  return match ? path.normalize(match[1]) : null
}

/** Whether `head` and `baseTip` share a commit; an error counts as no, which keeps the head. */
async function sharesHistory(git: SimpleGit, head: string, baseTip: string): Promise<boolean> {
  try {
    // No common ancestor exits 1 with no output, which simple-git may resolve as '' or throw.
    return (await git.raw(['merge-base', '--end-of-options', head, baseTip])).trim() !== ''
  } catch {
    return false
  }
}
