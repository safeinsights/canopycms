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
import { pinnedReceivePack, sharedRepoGit, sharedRepoProcessOptions } from './shared-repo-git'
import type { WorkerContext } from './worker-context'

/**
 * Merging into a branch workspace's history without touching its working tree: the merge is built
 * as objects, and the clone only ever fast-forwards to it. So a refused merge changes nothing, and
 * a clone is never left stopped on a merge's conflicts, which would need a second copy of the
 * rebase loop's lossy interrupted-rebase recovery.
 */

const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/

/**
 * The conflicts {@link buildMergeCommit} settles by keeping `head`'s side of one path. Every other
 * kind (a rename colliding with another, a file meeting a directory, a directory rename) moves or
 * joins paths, so no one side of one path is the branch's version, and settling it by rule loses a
 * file. Messages that are not `CONFLICT` are git's notes, such as `Auto-merging`.
 */
const SETTLED_BY_KEEPING_HEAD: ReadonlySet<string> = new Set([
  'CONFLICT (contents)',
  'CONFLICT (binary)',
  'CONFLICT (modify/delete)',
])

/** One stage of a conflicted path, as `merge-tree` lists it. */
interface ConflictStage {
  mode: string
  oid: string
  stage: string
  path: string
}

interface MergeTreeResult {
  tree: string
  stages: ConflictStage[]
  /** Conflict kinds other than {@link SETTLED_BY_KEEPING_HEAD}. */
  unsettled: string[]
}

/**
 * Parse `merge-tree --write-tree -z`: the tree, then each stage of each conflicted path, an empty
 * field, then messages of a path count, the paths, a stable kind and a sentence. Reads the output
 * rather than the exit status, since it exits 1 on a conflict with no stderr, which simple-git
 * resolves, and any failure of its own writes stderr and throws.
 */
function parseMergeTree(output: string, head: string, other: string): MergeTreeResult {
  const fields = output.split('\0')
  const tree = fields[0]
  if (!OBJECT_ID.test(tree)) throw new Error(`git merge-tree printed no tree for ${head}, ${other}`)
  const stages: ConflictStage[] = []
  let i = 1
  for (; i < fields.length && fields[i] !== ''; i++) {
    const match = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]*)$/.exec(fields[i])
    if (!match) throw new Error(`Unreadable git merge-tree entry: ${JSON.stringify(fields[i])}`)
    const [, mode, oid, stage, path] = match
    stages.push({ mode, oid, stage, path })
  }
  const unsettled = new Set<string>()
  for (i++; i < fields.length && fields[i] !== ''; ) {
    const kind = fields[i + parseInt(fields[i], 10) + 1]
    if (kind?.startsWith('CONFLICT') && !SETTLED_BY_KEEPING_HEAD.has(kind)) unsettled.add(kind)
    i += parseInt(fields[i], 10) + 3
  }
  // A path git could not decode as UTF-8 reads back as U+FFFD, which names no file.
  if (stages.some(({ path }) => path.includes('\ufffd'))) unsettled.add('an unreadable file name')
  return { tree, stages, unsettled: [...unsettled] }
}

/** What {@link buildMergeCommit} made of the two commits. */
export type BuiltMerge =
  /** `sha` is the merge, reachable from no ref yet. `conflicted` kept the branch's version. */
  | { kind: 'built'; sha: string; conflicted: string[] }
  /** Git met conflicts no rule settles safely. Nothing was built. */
  | { kind: 'unsettled'; conflicts: string[]; paths: string[] }

/**
 * The merge of `other` into `head`, as a commit no ref names, with `head` the first parent. A path
 * git cannot merge keeps `head`'s side, stage 2, at the path git reports, or stays deleted when
 * `head` has no such stage: the rule the rebase loop applies to a conflict, since `head` has the
 * editor's work. The commit takes its identity from the clone's `user.*`, written when the clone
 * is provisioned.
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
    '-z',
    '--end-of-options',
    head,
    other,
  ])
  const { tree: mergedTree, stages, unsettled } = parseMergeTree(output, head, other)
  const conflicted = [...new Set(stages.map(({ path }) => path))]
  if (unsettled.length > 0) return { kind: 'unsettled', conflicts: unsettled, paths: conflicted }
  const tree =
    stages.length === 0
      ? mergedTree
      : await keepHeadStages(clonePath, { mergedTree, stages, conflicted, timeoutMs })
  const sha = (
    await git.raw(['commit-tree', '-p', head, '-p', other, '-m', message, '--end-of-options', tree])
  ).trim()
  return { kind: 'built', sha, conflicted }
}

/**
 * Whether `merged` holds exactly what `from` and `other` merge to cleanly, and so nothing else. A
 * conflict counts as no: whoever settled it chose what `merged` holds.
 */
export async function isCleanMergeOf(
  git: SimpleGit,
  merged: string,
  from: string,
  other: string,
): Promise<boolean> {
  const output = await git.raw([
    'merge-tree',
    '--write-tree',
    '-z',
    '--end-of-options',
    from,
    other,
  ])
  const { tree, stages } = parseMergeTree(output, from, other)
  if (stages.length > 0) return false
  return (await git.revparse(['--verify', '--end-of-options', `${merged}^{tree}`])).trim() === tree
}

/** `mergedTree` with each of `conflicted` as `head` has it, through a throwaway index. */
async function keepHeadStages(
  clonePath: string,
  args: {
    mergedTree: string
    stages: readonly ConflictStage[]
    conflicted: readonly string[]
    timeoutMs: number
  },
): Promise<string> {
  const { mergedTree, stages, conflicted, timeoutMs } = args
  const shared = sharedRepoProcessOptions(clonePath, 'worktree')
  const indexFile = path.join(clonePath, '.git', `canopy-merge-index-${randomUUID()}`)
  const options = {
    ...shared,
    env: { ...shared.env, GIT_INDEX_FILE: indexFile },
    inactivityTimeoutMs: timeoutMs,
  }
  const kept = new Map(stages.filter((s) => s.stage === '2').map((s) => [s.path, s]))
  // Mode 0 removes a path: what is left when `head` has no side of it.
  const zeros = '0'.repeat(mergedTree.length)
  const entries = conflicted.map((file) => {
    const entry = kept.get(file)
    return `${entry?.mode ?? '0'} ${entry?.oid ?? zeros}\t${file}\0`
  })
  try {
    await runGit(['read-tree', '--end-of-options', mergedTree], options)
    await runGit(['update-index', '-z', '--index-info'], { ...options, stdin: entries.join('') })
    return (await runGit(['write-tree'], options)).trim()
  } finally {
    await fs.rm(indexFile, { force: true }).catch(() => {})
  }
}

/**
 * Move `refs/heads/<branchRef>` in remote.git to `sha` as a plain push, so it can only ever
 * fast-forward. Resolves false when it would not: under the caller's locks, the only writers left
 * are this loop and a person, so remote.git holds a commit `sha` lacks. Any other failure throws.
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
    if (isNonFastForwardRejection(redactCredentials(getErrorMessage(err)))) return false
    throw err
  }
}

/** Commits unique to each side: `[in a, not b]` and `[in b, not a]`. */
export async function commitsApart(
  git: SimpleGit,
  a: string,
  b: string,
): Promise<{ onlyA: number; onlyB: number }> {
  const counts = (
    await git.raw(['rev-list', '--left-right', '--count', '--end-of-options', `${a}...${b}`])
  ).trim()
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
