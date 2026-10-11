import fs from 'node:fs/promises'

import type { SimpleGit } from 'simple-git'

import { isSettingsBranchName, sanitizeBranchName } from '../paths/branch-name'
import { listTasks } from '../task-queue/cms-task-queue'
import { getErrorMessage, isNodeError } from '../utils/error'
import { branchProvisioningLockName, tryAcquireProvisioningLock } from '../utils/provisioning-lock'
import { releaseProvisionedWorkspace } from './provisioned-workspace'
import type { WorkerContext } from './worker-context'

export type StaleMirrorContext = Pick<
  WorkerContext,
  'baseBranch' | 'contentBranchesPath' | 'taskDir'
>

/**
 * Why a `remote.git` head is this deployment's own, not a copy of GitHub's: the base branch, a
 * settings branch (its workspace lives outside the branches root, and a stranded one is [SYNC-M3]'s
 * signal), a branch workspace at its sanitized name (which is also where the [SYNC-H1] marker
 * lives), a push task queued or running for it, or its provisioning lock held, so a workspace may
 * be appearing.
 */
export type EditorState = 'base' | 'settings' | 'workspace' | 'queued-push' | 'busy'

export type MirrorSettlement =
  /** The head now matches GitHub: moved to GitHub's tip, or deleted when GitHub has no such branch. */
  | { kind: 'settled' }
  | { kind: 'kept'; state: EditorState }
  /** The head moved after it was read; the lease refused the update, and the next cycle retries. */
  | { kind: 'moved-meanwhile'; error: string }

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
 * A push task already in the queue for the branch keeps the head too. Pending is listed before
 * processing, since a claim moves a task from the first to the second. A task that slips past the
 * check (put back to pending between the two listings) reads the head before the update, and
 * pushes what it would have pushed without it, or after, and finds nothing of its own to push.
 *
 * Every party that can write this head can already set it to any value it holds or delete it:
 * the update only ever makes the head match GitHub, as the gateway's fetch reported it.
 */
export async function settleStaleMirror(
  ctx: StaleMirrorContext,
  git: SimpleGit,
  head: { name: string; from: string; to: string | null },
  ownSettingsBranch: string,
  /** The branches root as listed earlier this cycle: a name in it is kept without the lock. */
  listedWorkspaces: ReadonlySet<string>,
): Promise<MirrorSettlement> {
  const { name, from, to } = head
  if (name === ctx.baseBranch) return { kind: 'kept', state: 'base' }
  if (isSettingsBranchName(name, ownSettingsBranch)) return { kind: 'kept', state: 'settings' }

  const dirName = sanitizeBranchName(name)
  if (listedWorkspaces.has(dirName)) return { kind: 'kept', state: 'workspace' }
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
    for (const status of ['pending', 'processing'] as const) {
      const tasks = await listTasks(ctx.taskDir, status, Number.POSITIVE_INFINITY)
      if (tasks.some((task) => task.action.startsWith('push') && pushesBranch(task, dirName))) {
        return { kind: 'kept', state: 'queued-push' }
      }
    }
    const ref = `refs/heads/${name}`
    try {
      await git.raw(to === null ? ['update-ref', '-d', ref, from] : ['update-ref', ref, to, from])
    } catch (err: unknown) {
      // The lease's refusal, or the ref's lock held by a concurrent writer; sharedRepoGit pins the
      // C locale, so the text is git's own. Anything else is the caller's to report.
      const message = getErrorMessage(err)
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

/** Compared sanitized, the form a workspace's directory takes, so near-collisions count too. */
function pushesBranch(task: { payload: Record<string, unknown> }, dirName: string): boolean {
  const branch = task.payload.branch
  return typeof branch === 'string' && sanitizeBranchName(branch) === dirName
}
