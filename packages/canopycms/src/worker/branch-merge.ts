import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { SimpleGit } from 'simple-git'

import { readSchemaSnapshot } from '../branch-schema-cache'
import { extractIdFromFilename } from '../content-id-index'
import type { KeyRemap } from '../merge/entry-merge'
import type { FoundEntryConflict } from '../merge-conflicts'
import { normalizeFilesystemPath } from '../paths/normalize'
import { ROOT_COLLECTION_ID, type ContentId } from '../paths/types'
import { isNonFastForwardRejection } from '../utils/git'
import { getErrorMessage, redactCredentials } from '../utils/error'
import { parseTypedFilename } from '../utils/typed-filename'
import {
  changedFiles,
  resolveFieldMerge,
  differsInItemKeysOnly,
  type FieldMergeResult,
} from './field-merge'
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
 * The conflicts {@link planMerge} settles by keeping `head`'s side of one path. Every other kind (a
 * rename colliding with another, a file meeting a directory, a directory rename) moves or joins
 * paths, so no one side of one path is the branch's version, and settling it by rule loses a file;
 * only the field merge, which pairs entries by content ID, settles those, and only where it decides
 * every path the conflict names. Messages that are not `CONFLICT` are git's notes, such as
 * `Auto-merging`.
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

/** One of `merge-tree`'s messages that is a conflict no one side of one path settles. */
interface UnsettledConflict {
  kind: string
  paths: string[]
}

interface MergeTreeResult {
  tree: string
  stages: ConflictStage[]
  /** Conflicts of a kind other than {@link SETTLED_BY_KEEPING_HEAD}, with the paths they name. */
  unsettled: UnsettledConflict[]
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
  const unsettled: UnsettledConflict[] = []
  for (i++; i < fields.length && fields[i] !== ''; ) {
    const count = parseInt(fields[i], 10)
    const kind = fields[i + count + 1]
    if (kind?.startsWith('CONFLICT') && !SETTLED_BY_KEEPING_HEAD.has(kind)) {
      unsettled.push({ kind, paths: fields.slice(i + 1, i + 1 + count) })
    }
    i += count + 3
  }
  // A path git could not decode as UTF-8 reads back as U+FFFD, which names no file.
  const undecodable = stages.filter(({ path }) => path.includes('\ufffd')).map(({ path }) => path)
  if (undecodable.length > 0) unsettled.push({ kind: 'an unreadable file name', paths: [] })
  return { tree, stages, unsettled }
}

/** What {@link planMerge} made of the two commits. */
export type MergePlan =
  | {
      kind: 'planned'
      /** The merge's tree. */
      tree: string
      /** The tree git's own merge wrote, conflict markers and all. */
      gitTree: string
      /** Paths git could not merge, whoever settled them. */
      gitConflicted: string[]
      /** What a person must still decide, entry by entry. */
      conflicts: FoundEntryConflict[]
      /** Paths where the branch's version stands over the other side's change, whole or in part. */
      keptPaths: string[]
      /** Git's own merge with nothing for a person: no conflict, and every file as git merged it. */
      asGitDoes: boolean
      /** Item keys the merge changed, by the entry path the branch's comment threads name. */
      keyRemaps: Array<{ entryPath: string; contentId?: string; remaps: KeyRemap[] }>
      /** Where each entry the merge decided stands in it. */
      paths: Map<string, string>
    }
  /** Git met conflicts no rule settles safely. Nothing was built. */
  | { kind: 'unsettled'; conflicts: string[]; paths: string[] }

/** {@link commitMerge}'s commit of a planned merge; `sha` is reachable from no ref yet. */
export type BuiltMerge = Omit<
  Extract<MergePlan, { kind: 'planned' }>,
  'kind' | 'tree' | 'gitTree'
> & {
  kind: 'built'
  sha: string
}

const NO_FIELD_MERGE: FieldMergeResult = {
  updates: new Map(),
  covered: new Set(),
  conflicts: [],
  keyRemaps: [],
  paths: new Map(),
}

/**
 * The merge of `other` into `head`, as a tree. Every entry and `.collection.json` both sides
 * changed is merged field by field (field-merge.ts), which settles git's conflicts there, whatever
 * their kind. A path git cannot merge that is no entry keeps `head`'s side, stage 2, at the path
 * git reports, or stays deleted when `head` has no such stage: `head` has the editor's work. With
 * no single merge base, git's merge stands as that rule leaves it, since a field merge needs one
 * version both sides started from.
 */
export async function planMerge(
  git: SimpleGit,
  clonePath: string,
  args: { head: string; other: string; contentRoot: string; timeoutMs: number },
): Promise<MergePlan> {
  const { head, other, contentRoot, timeoutMs } = args
  const bases = (await git.raw(['merge-base', '--all', '--end-of-options', head, other]))
    .split('\n')
    .filter((line) => OBJECT_ID.test(line))
  if (bases.length === 0) {
    return { kind: 'unsettled', conflicts: ['no history in common with it'], paths: [] }
  }
  const output = await git.raw([
    'merge-tree',
    '--write-tree',
    '-z',
    '--end-of-options',
    head,
    other,
  ])
  const { tree: gitTree, stages, unsettled } = parseMergeTree(output, head, other)
  const gitConflicted = [...new Set(stages.map(({ path }) => path))]
  const field =
    bases.length === 1
      ? await resolveFieldMerge({
          git,
          clonePath,
          ancestor: bases[0],
          head,
          other,
          mergedTree: gitTree,
          conflicted: new Set(gitConflicted),
          contentRoot,
          flatSchema: await readSchemaSnapshot(clonePath),
          collectionIdOf: (file) => conflictFilesToContentIds([file], contentRoot)[0],
          timeoutMs,
        })
      : NO_FIELD_MERGE
  const unsettledLeft = unsettled.filter(
    ({ paths }) => paths.length === 0 || paths.some((p) => !field.covered.has(p)),
  )
  if (field.unsettled) unsettledLeft.push({ kind: field.unsettled, paths: [] })
  if (unsettledLeft.length > 0) {
    return {
      kind: 'unsettled',
      conflicts: [...new Set(unsettledLeft.map(({ kind }) => kind))],
      paths: gitConflicted,
    }
  }

  const updates = new Map(field.updates)
  const kept = gitConflicted.filter((file) => !field.covered.has(file))
  const headStages = new Map(stages.filter((s) => s.stage === '2').map((s) => [s.path, s]))
  for (const file of kept) {
    const stage = headStages.get(file)
    updates.set(file, stage ? { path: file, mode: stage.mode, oid: stage.oid } : null)
  }
  const tree =
    updates.size === 0 ? gitTree : await withUpdates(clonePath, { gitTree, updates, timeoutMs })
  const conflicts = [
    ...field.conflicts,
    ...keptVersions(kept, stages, contentRoot, field.conflicts),
  ]
  return {
    kind: 'planned',
    tree,
    gitTree,
    gitConflicted,
    conflicts,
    keptPaths: [...new Set([...field.conflicts.map(({ path }) => path), ...kept])],
    keyRemaps: field.keyRemaps,
    paths: field.paths,
    asGitDoes:
      gitConflicted.length === 0 &&
      conflicts.length === 0 &&
      field.keyRemaps.length === 0 &&
      tree === gitTree,
  }
}

/**
 * The files the merge kept `head`'s side of as entry-level conflicts, by the content ID their path
 * carries, one per ID and none for an ID the field merge already names. A path with none is
 * dropped rather than guessed at.
 */
function keptVersions(
  kept: readonly string[],
  stages: readonly ConflictStage[],
  contentRoot: string,
  named: readonly FoundEntryConflict[],
): FoundEntryConflict[] {
  const seen = new Set<string>(named.map(({ contentId }) => contentId))
  const found: FoundEntryConflict[] = []
  for (const file of kept) {
    const [contentId] = conflictFilesToContentIds([file], contentRoot)
    if (!contentId || seen.has(contentId)) continue
    seen.add(contentId)
    const oid = (stage: string) => stages.find((s) => s.path === file && s.stage === stage)?.oid
    const [ancestor, branch, base] = [oid('1'), oid('2'), oid('3')]
    found.push({
      contentId,
      path: file,
      kind: 'unreadable',
      sides: {
        ...(ancestor && { ancestor }),
        ...(base && { base }),
        ...(branch && { branch }),
      },
    })
  }
  return found
}

/**
 * {@link planMerge}'s merge as a commit no ref names, with `head` the first parent. The commit takes
 * its identity from the clone's `user.*`, written when the clone is provisioned.
 */
export async function commitMerge(
  git: SimpleGit,
  plan: Extract<MergePlan, { kind: 'planned' }>,
  { head, other, message }: { head: string; other: string; message: string },
): Promise<BuiltMerge> {
  const { tree, gitTree: _gitTree, kind: _kind, ...rest } = plan
  const sha = (
    await git.raw(['commit-tree', '-p', head, '-p', other, '-m', message, '--end-of-options', tree])
  ).trim()
  return { kind: 'built', sha, ...rest }
}

/** Whether `plan` is git's own merge with nothing for a person. */
export const mergesAsGitDoes = (plan: MergePlan): boolean =>
  plan.kind === 'planned' && plan.asGitDoes

/**
 * Whether `merged` holds exactly what `from` and `other` merge to cleanly, and so nothing else, the
 * item keys of entries under `contentRoot` aside: a re-key ({@link buildRekey}) changes no content.
 * A conflict counts as no: whoever settled it chose what `merged` holds.
 */
export async function isCleanMergeOf(
  git: SimpleGit,
  merged: string,
  from: string,
  other: string,
  contentRoot: string,
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
  const mergedTree = (
    await git.revparse(['--verify', '--end-of-options', `${merged}^{tree}`])
  ).trim()
  if (mergedTree === tree) return true
  for (const { before, after } of await changedFiles(git, tree, mergedTree)) {
    if (!before || !after || !(await differsInItemKeysOnly(git, before, after, contentRoot))) {
      return false
    }
  }
  return true
}

/**
 * A commit on `tip` that gives the items of every entry a merge on the branch's own line in
 * `from..tip` (first parents: never the base's history) brought in the keys the field merge of
 * that merge's two parents gives them, where it holds what git merged
 * (field-merge.ts `rekeyOnly`) and `tip` still holds the merge's version. Git keeps each item under
 * the key its side's copy held, which can name another item once the other side changed it; the
 * field merge's are the keys a later merge reads correctly. Null when no item needs a new key.
 */
export async function buildRekey(
  git: SimpleGit,
  clonePath: string,
  args: {
    from: string
    tip: string
    contentRoot: string
    timeoutMs: number
    message: string
    /**
     * Only entries `head` holds as `since` held them: a merge of `head` with the re-key reads an
     * entry `head` changed against `since`'s keys, which git's merge keeps and a re-key would not.
     */
    unchangedIn?: { head: string; since: string }
  },
): Promise<BuiltMerge | null> {
  const { from, tip, contentRoot, timeoutMs, message, unchangedIn } = args
  const merges = (
    await git.raw([
      'rev-list',
      '--first-parent',
      '--merges',
      '--reverse',
      '--end-of-options',
      `${from}..${tip}`,
    ])
  )
    .split('\n')
    .filter((line) => OBJECT_ID.test(line))
  if (merges.length === 0) return null
  const flatSchema = await readSchemaSnapshot(clonePath)
  const updates = new Map<string, { mode: string; oid: string }>()
  const keyRemaps: BuiltMerge['keyRemaps'] = []
  for (const merge of merges) {
    const parents = (await git.raw(['rev-list', '--parents', '-n', '1', '--end-of-options', merge]))
      .trim()
      .split(' ')
      .slice(1)
    if (parents.length !== 2) continue
    const bases = (await git.raw(['merge-base', '--all', '--end-of-options', ...parents]))
      .split('\n')
      .filter((line) => OBJECT_ID.test(line))
    if (bases.length !== 1) continue
    const field = await resolveFieldMerge({
      git,
      clonePath,
      ancestor: bases[0],
      head: parents[0],
      other: parents[1],
      mergedTree: (await git.revparse(['--verify', '--end-of-options', `${merge}^{tree}`])).trim(),
      conflicted: new Set(),
      contentRoot,
      flatSchema,
      collectionIdOf: (file) => conflictFilesToContentIds([file], contentRoot)[0],
      timeoutMs,
      rekeyOnly: true,
    })
    const applied = new Set<string>()
    for (const [file, blob] of field.updates) {
      // A later commit that changed the entry again decided its keys itself.
      if (!blob || (await blobAt(git, merge, file)) !== (await blobAt(git, tip, file))) continue
      if (
        unchangedIn &&
        (await blobAt(git, unchangedIn.head, file)) !== (await blobAt(git, unchangedIn.since, file))
      ) {
        continue
      }
      updates.set(file, blob)
      const id = parseTypedFilename(path.posix.basename(file))?.id
      if (id !== undefined) applied.add(id)
    }
    keyRemaps.push(
      ...field.keyRemaps.filter((r) => r.contentId !== undefined && applied.has(r.contentId)),
    )
  }
  if (updates.size === 0) return null
  const tipTree = (await git.revparse(['--verify', '--end-of-options', `${tip}^{tree}`])).trim()
  const tree = await withUpdates(clonePath, { gitTree: tipTree, updates, timeoutMs })
  const sha = (
    await git.raw(['commit-tree', '-p', tip, '-m', message, '--end-of-options', tree])
  ).trim()
  return {
    kind: 'built',
    sha,
    gitConflicted: [],
    conflicts: [],
    keptPaths: [],
    asGitDoes: false,
    keyRemaps,
    paths: new Map(),
  }
}

/** The blob `commit` holds at `file`, or null for none. */
async function blobAt(git: SimpleGit, commit: string, file: string): Promise<string | null> {
  const out = await git
    .raw(['rev-parse', '--verify', '--quiet', '--end-of-options', `${commit}:${file}`])
    .catch(() => '')
  const oid = out.trim()
  return OBJECT_ID.test(oid) ? oid : null
}

/** `gitTree` with each of `updates` in place, through a throwaway index. */
async function withUpdates(
  clonePath: string,
  args: {
    gitTree: string
    updates: ReadonlyMap<string, { mode: string; oid: string } | null>
    timeoutMs: number
  },
): Promise<string> {
  const { gitTree, updates, timeoutMs } = args
  const shared = sharedRepoProcessOptions(clonePath, 'worktree')
  const indexFile = path.join(clonePath, '.git', `canopy-merge-index-${randomUUID()}`)
  const options = {
    ...shared,
    env: { ...shared.env, GIT_INDEX_FILE: indexFile },
    inactivityTimeoutMs: timeoutMs,
  }
  // Mode 0 removes a path.
  const zeros = '0'.repeat(gitTree.length)
  const entries = [...updates].map(
    ([file, blob]) => `${blob?.mode ?? '0'} ${blob?.oid ?? zeros}\t${file}\0`,
  )
  try {
    await runGit(['read-tree', '--end-of-options', gitTree], options)
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
function conflictFilesToContentIds(
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
