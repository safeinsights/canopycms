import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { SimpleGit } from 'simple-git'

import { extractIdFromFilename } from '../content-id-index'
import { normalizeFilesystemPath } from '../paths/normalize'
import { ROOT_COLLECTION_ID, type ContentId } from '../paths/types'
import type { ConflictStatus } from '../types'
import { isNonFastForwardRejection } from '../utils/git'
import { getErrorMessage, redactCredentials } from '../utils/error'
import { runGit } from './git-process'
import { workerLogWarn } from './log'
import { pinnedReceivePack, sharedRepoGit, sharedRepoProcessOptions } from './shared-repo-git'
import type { WorkerContext } from './worker-context'

/**
 * Merging into a branch workspace's history without touching its working tree: the merge is built
 * as objects, and the clone only ever fast-forwards to it. So no crash can leave a clone mid-merge,
 * which would need a second copy of the rebase loop's lossy interrupted-rebase recovery, and a
 * refused merge changes nothing at all.
 */

const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/

/** What {@link buildMergeCommit} made of the two commits. */
export interface BuiltMerge {
  /** The merge commit, reachable from no ref yet. */
  sha: string
  /** Paths git could not merge, for which the branch's version was kept. */
  conflicted: string[]
}

/**
 * The merge of `other` into `head`, as a commit no ref names. A path git cannot merge keeps
 * `head`'s version, whole, or stays deleted when `head` deleted it: the rule the rebase loop
 * applies to a conflict, and what `head` having the editor's work is for. `head` is the first
 * parent.
 *
 * Reads the output rather than the exit status: `merge-tree` exits 1 on a conflict with no
 * stderr, which simple-git resolves, and any failure of its own writes stderr and throws. The
 * commit takes its identity from the clone's `user.*`, written when the clone is provisioned.
 */
export async function buildMergeCommit(
  git: SimpleGit,
  clonePath: string,
  args: { head: string; other: string; message: string; timeoutMs: number },
): Promise<BuiltMerge> {
  const { head, other, message, timeoutMs } = args
  const output = await git.raw([
    'merge-tree',
    '--write-tree',
    '--name-only',
    '-z',
    '--no-messages',
    '--end-of-options',
    head,
    other,
  ])
  const [mergedTree, ...conflicted] = output.split('\0').filter((field) => field.length > 0)
  if (mergedTree === undefined || !OBJECT_ID.test(mergedTree)) {
    throw new Error(`git merge-tree printed no tree for ${head} and ${other}`)
  }
  const tree =
    conflicted.length === 0
      ? mergedTree
      : await keepBranchVersions(git, clonePath, { mergedTree, head, conflicted, timeoutMs })
  const sha = (
    await git.raw(['commit-tree', '-p', head, '-p', other, '-m', message, '--end-of-options', tree])
  ).trim()
  return { sha, conflicted }
}

/**
 * `mergedTree` with every path in `conflicted` as `head` has it, through a throwaway index, so the
 * clone's own index is never read or written. `ls-tree -r` lists `head`'s blobs at or under each
 * path, so a path that became a directory on one side takes all of `head`'s entries.
 */
async function keepBranchVersions(
  git: SimpleGit,
  clonePath: string,
  args: { mergedTree: string; head: string; conflicted: string[]; timeoutMs: number },
): Promise<string> {
  const { mergedTree, head, conflicted, timeoutMs } = args
  const shared = sharedRepoProcessOptions(clonePath, 'worktree')
  const indexFile = path.join(clonePath, '.git', `canopy-merge-index-${randomUUID()}`)
  const options = {
    ...shared,
    env: { ...shared.env, GIT_INDEX_FILE: indexFile },
    inactivityTimeoutMs: timeoutMs,
  }
  try {
    await runGit(['read-tree', '--end-of-options', mergedTree], options)
    const branchEntries = await runGit(
      ['ls-tree', '-r', '-z', '--full-tree', '--end-of-options', head, '--', ...conflicted],
      options,
    )
    // Mode 0 removes a path. `--index-info` reads `ls-tree` output as it is, so `head`'s entries,
    // listed after, put back what it has.
    const removals = conflicted.map((file) => `0 ${'0'.repeat(head.length)}\t${file}\0`).join('')
    await runGit(['update-index', '-z', '--index-info'], {
      ...options,
      stdin: removals + branchEntries,
    })
    return (await runGit(['write-tree'], options)).trim()
  } finally {
    await fs.rm(indexFile, { force: true }).catch(() => {})
  }
}

/**
 * Move `refs/heads/<branchRef>` in remote.git to `sha` as a plain push, so it can only ever
 * fast-forward. Resolves false when it could not: a concurrent reconcile moved the head, and the
 * caller's next cycle looks again. Any other failure throws.
 */
export async function publishPlainToLocalRemote(
  ctx: Pick<WorkerContext, 'remoteGitPath' | 'taskTimeoutMs'>,
  clonePath: string,
  branchRef: string,
  sha: string,
): Promise<boolean> {
  const pushGit = sharedRepoGit(clonePath, 'worktree', { timeout: { block: ctx.taskTimeoutMs } })
  try {
    await pushGit.raw([
      'push',
      // Otherwise remote.git's own hooks run, as the worker.
      `--receive-pack=${pinnedReceivePack()}`,
      '--end-of-options',
      ctx.remoteGitPath,
      `${sha}:refs/heads/${branchRef}`,
    ])
    return true
  } catch (err) {
    const message = redactCredentials(getErrorMessage(err))
    if (!isNonFastForwardRejection(message)) throw err
    workerLogWarn(
      `  ${branchRef} moved in remote.git while it was being published; the next cycle looks again`,
    )
    return false
  }
}

/** Commits unique to each side: `[in a, not b]` and `[in b, not a]`. */
export async function commitsApart(
  git: SimpleGit,
  a: string,
  b: string,
): Promise<{ onlyA: number; onlyB: number }> {
  const counts = (await git.raw(['rev-list', '--left-right', '--count', `${a}...${b}`])).trim()
  const [left, right] = counts.split(/\s+/).map((n) => parseInt(n, 10))
  if (!Number.isInteger(left) || !Number.isInteger(right)) {
    throw new Error(`Unreadable rev-list output for ${a}...${b}: ${JSON.stringify(counts)}`)
  }
  return { onlyA: left, onlyB: right }
}

/**
 * Map the file paths a rebase or merge kept the branch's version of onto the ContentIds the
 * editor shows as conflicted, deduplicated. IDs rather than paths because they are
 * immutable: a later slug rename must not orphan a conflict marker. Paths that
 * carry no recoverable ID are dropped rather than guessed at.
 *
 * Pure.
 */
export function conflictFilesToContentIds(
  conflictedFiles: readonly string[],
  contentRoot: string,
): ContentId[] {
  // Entry files carry their ID in the filename. A `.collection.json` has none
  // of its own (extractIdFromFilename returns null for dot-prefixed files), so
  // the ID comes from the parent directory; the root content directory has no
  // embedded ID at all, so ROOT_COLLECTION_ID stands in -- but only for the
  // configured contentRoot.
  //
  // Two different notions of "parent" are needed, and conflating them is the
  // bug this guards against (see schema-store.ts's contentRootName doc comment
  // for the same shape elsewhere):
  //  - `parentDir` (a basename) recovers a SUB-collection's own embedded ID,
  //    correct as a basename since a collection directory carries its ID in its
  //    own name, one path segment;
  //  - `parentPath` (the full normalized relative parent path) is what must be
  //    compared against `contentRoot`, which is documented (config/helpers.ts)
  //    as allowed to span multiple segments (e.g. "cms/content"). Comparing a
  //    basename against that full value is always false, silently dropping the
  //    root collection's conflict. Git reports POSIX paths and the configured
  //    value may use either separator, so both sides go through
  //    normalizeFilesystemPath first.
  const normalizedContentRoot = normalizeFilesystemPath(contentRoot)
  const conflictIds = [...new Set(conflictedFiles)]
    .map((f) => {
      const fileId = extractIdFromFilename(path.basename(f))
      if (fileId) return fileId
      const parentDir = path.basename(path.dirname(f))
      const dirId = extractIdFromFilename(parentDir)
      if (dirId) return dirId
      // Only assign ROOT_COLLECTION_ID when the file's parent directory IS the
      // configured content root. Other unrecognized paths are filtered out.
      const parentPath = normalizeFilesystemPath(path.dirname(f))
      if (path.basename(f) === '.collection.json' && parentPath === normalizedContentRoot) {
        return ROOT_COLLECTION_ID
      }
      return null
    })
    .filter((id): id is ContentId => id !== null)
  return [...new Set(conflictIds)]
}

/**
 * The conflict record after a rebase or merge: the IDs already recorded plus
 * its own. A conflict means this branch's version replaced base's change to
 * that entry, which a later clean rebase does not undo, so the record only
 * grows until the branch merges (buildMergedBranchUpdate clears it).
 *
 * Pure.
 */
export function recordConflicts(
  recorded: readonly ContentId[] | undefined,
  found: readonly ContentId[],
): { conflictStatus: ConflictStatus; conflictFiles: ContentId[] } {
  const conflictFiles = [...new Set([...(recorded ?? []), ...found])]
  return {
    conflictStatus: conflictFiles.length > 0 ? 'conflicts-detected' : 'clean',
    conflictFiles,
  }
}
