/**
 * CLI command: npx canopycms sync
 *
 * Bidirectional sync between the developer's working tree and
 * CMS branch workspaces in .canopy-dev/content-branches/.
 *
 * - Push: copies working-tree content into a branch workspace and commits.
 *
 * - Pull: copies content from a branch workspace back into the working tree
 *   so the developer can review and commit.
 *
 * - Both: merges working-tree changes with editor changes in the workspace
 *   using a 3-way git merge, then pulls the merged result back.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import * as p from '@clack/prompts'
import { z } from 'zod'
import { resolveBranchParam, type BranchParamConfig } from '../branch-param'
import { readBranchMetadataFile } from '../branch-metadata-file'
import { namesNoWorkspace, resolveBranchPath } from '../paths/branch'
import {
  exactBranchName,
  exactBranchSegment,
  isExactBranchForm,
  parseBranchRef,
} from '../paths/validation'
import { getErrorMessage } from '../utils/error'
import { filePathExists } from '../utils/fs'
import { detectHeadBranch, isCanopyInternalPath, stageAllExceptCanopyState } from '../utils/git'
import {
  assertWithinDir,
  copyDir,
  listFilesRecursive,
  pushContentToWorkspace,
  safeReplaceDir,
  SYNC_BASE_TAG,
} from '../sync-core'
import { invalidateBranchContentCaches } from '../content-index-generation'
import { ContentWriteLockBusyError, withContentWriteLock } from '../utils/content-write-lock'
import { ensureGitExcludePattern } from '../git-manager'
import { operatingStrategy } from '../operating-mode'
import { importSiteServerConfig } from './site-config'

export interface SyncOptions {
  projectDir: string
  direction: 'push' | 'pull' | 'both' | 'abort'
  /** Which branch workspace to push to / pull from */
  branch?: string
  contentRoot?: string
  /** Skip confirmation prompts (for testing or scripts). */
  force?: boolean
}

/**
 * Sync precondition failure (missing content dir, unknown branch, …).
 * Thrown so the CLI exits non-zero — scripts/CI must not sail past a
 * push that synced nothing.
 */
class SyncError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SyncError'
  }
}

/**
 * [SYNC-C1] Every sync step that rewrites a branch workspace (content replace, checkout, merge,
 * merge abort) runs under the workspace's content-write lock, which the dev server's saves and
 * the worker's rebase also take. Contention becomes a `SyncError`, so the CLI exits non-zero.
 */
function lockBusyAsSyncError(err: unknown, branchName: string): unknown {
  if (!(err instanceof ContentWriteLockBusyError)) return err
  return new SyncError(
    err.outcome === 'not-run'
      ? `Branch workspace "${branchName}" is busy (the worker is syncing it, or an editor save is in flight); nothing was changed. Try again in a moment.`
      : `Branch workspace "${branchName}" was being synced during this run, so it may be partly updated. Check its state before running sync again.`,
  )
}

async function withWorkspaceLock<T>(
  branchPath: string,
  branchName: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await withContentWriteLock(branchPath, fn)
  } catch (err: unknown) {
    throw lockBusyAsSyncError(err, branchName)
  }
}

/**
 * `git merge --abort` in a workspace left mid-merge, re-checking under the lock that it still is.
 * Returns whether a merge was aborted.
 */
async function abortWorkspaceMerge(branchPath: string, branchName: string): Promise<boolean> {
  return withWorkspaceLock(branchPath, branchName, async () => {
    const wsGit = simpleGit({ baseDir: branchPath })
    if ((await wsGit.status()).conflicted.length === 0) return false
    await wsGit.merge(['--abort'])
    // The abort rewrote the clone's working tree — tell ContentStore ID
    // indexes (the dev server is a separate process; on-disk marker).
    await invalidateBranchContentCaches(branchPath)
    return true
  })
}

/** Detect the current git branch name from the working tree. */
async function detectCurrentBranch(projectDir: string): Promise<string> {
  const git = simpleGit({ baseDir: projectDir })
  const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim()
  if (branch === 'HEAD') throw new Error('Detached HEAD — use --branch to specify a branch name')
  return branch
}

/** The branch workspace a sync step works on: its ref, for messages, and its directory. */
interface SyncWorkspace {
  branchName: string
  branchPath: string
}

/** The site config fields that decide which workspace a branch name names. */
const branchConfigSchema = z.object({
  branchNamespace: z.string().optional(),
  deploymentName: z.string().optional(),
  defaultBaseBranch: z.string().optional(),
  defaultActiveBranch: z.string().optional(),
})

/** {@link branchConfigSchema}'s fields from the site config: none, with a warning, when unusable. */
async function readBranchConfigFields(
  projectDir: string,
): Promise<z.infer<typeof branchConfigSchema>> {
  if (!(await filePathExists(path.join(projectDir, 'canopycms.config.ts')))) return {}
  let why: string
  try {
    const parsed = branchConfigSchema.safeParse((await importSiteServerConfig(projectDir)).server)
    if (parsed.success) return parsed.data
    why = parsed.error.message
  } catch (err: unknown) {
    why = getErrorMessage(err)
  }
  p.log.warn(
    `Could not use canopycms.config.ts (${why}); branch names resolve against the default branch settings.`,
  )
  return {}
}

/**
 * The config {@link resolveBranchParam} resolves names against, built as the dev server builds
 * it: dev mode, the site config's branch fields, and an unset base or active branch taken from the
 * project's git HEAD (services.ts).
 */
async function loadBranchParamConfig(projectDir: string): Promise<BranchParamConfig> {
  const fields = await readBranchConfigFields(projectDir)
  const head = await detectHeadBranch(projectDir, fields.defaultBaseBranch ?? 'main')
  return {
    ...fields,
    mode: 'dev',
    defaultBaseBranch: fields.defaultBaseBranch ?? head,
    defaultActiveBranch: fields.defaultActiveBranch ?? head,
  }
}

/**
 * Refuses a directory that is not the top of its own git repository. Git run there would walk up
 * to the developer's own repository and commit and tag in it.
 */
async function assertOwnRepository(branchPath: string): Promise<void> {
  const top = await simpleGit({ baseDir: branchPath })
    .revparse(['--show-toplevel'])
    .then((out) => out.trim())
    .catch(() => '')
  if (top && (await fs.realpath(top)) === (await fs.realpath(branchPath))) return
  throw new SyncError(
    `"${path.basename(branchPath)}" under content-branches/ is not a branch workspace: it has no git repository of its own.`,
  )
}

/** The branch a workspace's HEAD is on (an unborn one included), or null when it is detached. */
async function workspaceHead(branchPath: string): Promise<string | null> {
  return simpleGit({ baseDir: branchPath })
    .raw(['symbolic-ref', '--short', '-q', 'HEAD'])
    .then((out) => out.trim() || null)
    .catch(() => null)
}

/** The workspace at directory `key` under content-branches/, named by its branch.json or HEAD. */
async function keyWorkspace(key: string, projectDir: string): Promise<SyncWorkspace> {
  const branchPath = path.join(operatingStrategy('dev').getContentBranchesRoot(projectDir), key)
  await assertOwnRepository(branchPath)
  const meta = await readBranchMetadataFile(branchPath)
  return { branchName: meta?.branch.name ?? (await workspaceHead(branchPath)) ?? key, branchPath }
}

/** The ref `name` gives: decoded from the exact form (`~fix~x`), else `name` itself. */
function refOf(name: string): string {
  if (!isExactBranchForm(name)) return name
  const ref = exactBranchName(name)
  if (ref === null) throw new SyncError(`"${name}" is not a valid branch name.`)
  return ref
}

/**
 * The workspace `name` names, as the dev server resolves it, or null:
 * 1. what the runtime resolves it to (`resolveBranchParam`): the ref, a namespace branch's short
 *    name, or the exact form;
 * 2. a workspace key, the directory itself;
 * 3. the directory the ref keys to, when it holds a workspace sync built (no branch.json) on that
 *    ref. Two refs can sanitize to one key, so one whose branch.json or HEAD names another branch
 *    is refused.
 * A `name` read from git HEAD (`byRef`) is a ref, never a short name or key: it resolves in its
 * exact form and skips step 2, so a local branch never lands in an editor's branch or in another
 * ref's workspace that shares its key.
 */
async function resolveSyncWorkspace(
  name: string,
  projectDir: string,
  keys: string[],
  byRef: boolean,
): Promise<SyncWorkspace | null> {
  const config = await loadBranchParamConfig(projectDir)
  const param = byRef ? exactBranchSegment(name) : name
  const resolved = await resolveBranchParam(param, config, { basePathOverride: projectDir }).catch(
    (err: unknown) => {
      if (namesNoWorkspace(err)) return null
      throw err
    },
  )
  if (resolved) {
    // The base and active branch resolve by directory alone, without branch.json's name.
    const ref = refOf(name)
    if (resolved.branch.name !== ref && resolved.branchRoot === refKeyPath(ref, projectDir)) {
      throw holdsAnotherBranch(resolved.branchRoot, resolved.branch.name, ref)
    }
    await assertOwnRepository(resolved.branchRoot)
    return { branchName: resolved.branch.name, branchPath: resolved.branchRoot }
  }

  if (!byRef && keys.includes(name)) return keyWorkspace(name, projectDir)

  const ref = refOf(name)
  const branchPath = refKeyPath(ref, projectDir)
  const present = await filePathExists(branchPath).catch((err: unknown) => {
    if (namesNoWorkspace(err)) throw new SyncError(`"${ref}" cannot name a branch workspace.`)
    throw err
  })
  if (!present) return null
  await assertOwnRepository(branchPath)
  const meta = await readBranchMetadataFile(branchPath)
  const holder = meta ? meta.branch.name : await workspaceHead(branchPath)
  if (holder !== ref) throw holdsAnotherBranch(branchPath, holder, ref)
  return { branchName: ref, branchPath }
}

/** The refusal for a workspace another ref, sharing `ref`'s key, holds (`holder`; null: detached). */
function holdsAnotherBranch(branchPath: string, holder: string | null, ref: string): SyncError {
  return new SyncError(
    `Branch workspace "${path.basename(branchPath)}" holds ${holder === null ? 'a detached HEAD' : `branch "${holder}"`}, not "${ref}".`,
  )
}

/** The workspace directory the runtime keys ref `name` to (`resolveBranchPath`). */
function refKeyPath(name: string, projectDir: string): string {
  try {
    return resolveBranchPath({ mode: 'dev', branchName: name, basePathOverride: projectDir })
      .branchRoot
  } catch (err: unknown) {
    if (namesNoWorkspace(err)) throw new SyncError(`"${name}" cannot name a branch workspace.`)
    throw err
  }
}

/**
 * Auto-create a minimal workspace for the branch `name` gives (git init + empty commit) so push
 * can copy content in, at the directory the dev server reads for that ref. This is lighter than
 * BranchWorkspaceManager's clone-based setup -- no remote config, content structure or
 * branch.json -- and the dev server adopts it in place when it provisions that ref
 * (BranchWorkspaceManager.provisionBranch).
 */
async function createSyncWorkspace(name: string, projectDir: string): Promise<SyncWorkspace> {
  const ref = refOf(name)
  const parsed = parseBranchRef(ref)
  if (!parsed.ok) throw new SyncError(`"${ref}" is not a valid branch name: ${parsed.error}`)
  const branchPath = refKeyPath(ref, projectDir)
  await fs.mkdir(branchPath, { recursive: true })
  const wsGit = simpleGit({ baseDir: branchPath })
  await wsGit.init()
  await wsGit.checkoutLocalBranch(ref)
  await wsGit.raw(['commit', '--allow-empty', '-m', 'init: workspace created by sync'])
  // Runtime metadata (.canopy-meta/: branch metadata, comments, content-index
  // marker) must never be staged by sync's `add -A`. Fully provisioned workspaces
  // get this exclude from GitManager.initializeWorkspace; this minimal one needs it
  // too. Sync is dev-mode-only, so this asks the dev strategy for the pattern
  // rather than hardcoding it.
  await ensureGitExcludePattern(branchPath, operatingStrategy('dev').getGitExcludePattern())
  p.log.info(`Created branch workspace: ${path.basename(branchPath)}`)
  return { branchName: ref, branchPath }
}

/**
 * Select a branch workspace. Uses the --branch flag (defaulting to the current git branch),
 * resolved as the dev server resolves it ({@link resolveSyncWorkspace}); else auto-selects the
 * only workspace directory, or prompts for one. When autoCreate is true, creates a new workspace
 * if a named branch has none.
 */
async function selectBranch(
  options: Pick<SyncOptions, 'branch' | 'force'> & { projectDir: string; autoCreate?: boolean },
): Promise<SyncWorkspace | null> {
  const branchesDir = operatingStrategy('dev').getContentBranchesRoot(options.projectDir)
  let branches: string[] = []
  if (await filePathExists(branchesDir)) {
    const entries = await fs.readdir(branchesDir, { withFileTypes: true })
    // Dot-prefixed dirs are never branch workspaces (.canopy-meta, plus
    // .trash-*/.{dirName}.init.lock from the admin branch-health recovery
    // surface) — same skip rule as BranchRegistry.scanBranchDirectories.
    branches = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
  }

  let branchName = options.branch
  const byRef = !branchName
  if (!branchName) {
    try {
      branchName = await detectCurrentBranch(options.projectDir)
    } catch {
      // Can't detect — fall back to existing selection behavior
    }
  }

  if (!branchName) {
    if (branches.length === 0) {
      throw new SyncError(
        'No branch workspaces found and could not detect current git branch. Use --branch to specify.',
      )
    }
    if (branches.length === 1) return keyWorkspace(branches[0], options.projectDir)
    const result = await p.select({
      message: 'Which branch?',
      options: branches.map((b) => ({ value: b, label: b })),
    })
    if (p.isCancel(result)) {
      p.cancel('Sync cancelled.')
      return null
    }
    return keyWorkspace(result, options.projectDir)
  }

  const existing = await resolveSyncWorkspace(branchName, options.projectDir, branches, byRef)
  if (existing) return existing
  if (options.autoCreate) return createSyncWorkspace(branchName, options.projectDir)
  const available = branches.length > 0 ? ` Available branches: ${branches.join(', ')}` : ''
  throw new SyncError(`Branch workspace "${branchName}" not found.${available}`)
}

/**
 * Push: copy working-tree content into a branch workspace and commit.
 * Tags the resulting commit as the sync base for future merges.
 */
async function syncPush(options: SyncOptions): Promise<{ fileCount: number }> {
  const { projectDir } = options
  const contentRoot = options.contentRoot || 'content'
  // Validate source content BEFORE selectBranch, which may create a workspace —
  // a push with nothing to push must not leave side effects behind.
  const srcContentDir = path.join(projectDir, contentRoot)
  assertWithinDir(srcContentDir, projectDir, '--content-root')
  if (!(await filePathExists(srcContentDir))) {
    throw new SyncError(
      `Content directory not found: ${contentRoot}/ (expected at ${srcContentDir})`,
    )
  }

  const ws = await selectBranch({ ...options, projectDir, autoCreate: true })
  if (!ws) return { fileCount: 0 }
  const { branchName, branchPath } = ws
  const wsGit = simpleGit({ baseDir: branchPath })

  const status = await wsGit.status()
  if (status.conflicted.length > 0) {
    p.log.error('Branch workspace has unresolved merge conflicts.')
    if (!options.force) {
      const shouldAbort = await p.confirm({
        message: 'Abort the merge and restore workspace to pre-merge state?',
        initialValue: false,
      })
      if (!p.isCancel(shouldAbort) && shouldAbort) {
        if (await abortWorkspaceMerge(branchPath, branchName)) {
          p.log.success('Merge aborted. Workspace restored to pre-merge state.')
        }
      }
    }
    return { fileCount: 0 }
  }

  const editorChanges = status.files.filter((f) => !isCanopyInternalPath(f.path))
  if (editorChanges.length > 0 && !options.force) {
    p.log.warn(
      `Branch workspace has ${editorChanges.length} uncommitted change(s) that will be committed to history then overwritten:`,
    )
    for (const file of editorChanges.slice(0, 10)) {
      p.log.warn(`  ${file.path}`)
    }
    if (editorChanges.length > 10) {
      p.log.warn(`  ... and ${editorChanges.length - 10} more`)
    }
    const confirm = await p.confirm({
      message: 'Continue? Editor changes will be preserved in git history.',
      initialValue: false,
    })
    if (p.isCancel(confirm) || !confirm) {
      p.cancel('Push cancelled.')
      return { fileCount: 0 }
    }
  }

  p.log.step(`Pushing content to branch workspace: ${branchName}`)

  // Commit any editor changes (re-read under the lock, so a save landing after
  // the listing above is preserved too), copy working-tree content → workspace
  // content dir, commit, and tag the sync base.
  let fileCount: number
  try {
    const result = await pushContentToWorkspace({
      srcContentDir,
      branchPath,
      contentRoot,
      baseTag: SYNC_BASE_TAG,
      saveEditorStateMessage: 'sync: save editor state before push',
    })
    fileCount = result.fileCount
    if (result.savedEditorState) p.log.info('Committed editor changes to history before push')
  } catch (err: unknown) {
    throw lockBusyAsSyncError(err, branchName)
  }

  if (fileCount === 0) {
    p.log.info('Content is already up to date — nothing to push')
  } else {
    p.log.success(`Pushed ${fileCount} file change(s) to branch "${branchName}"`)
  }
  return { fileCount }
}

/**
 * Pull: copy content from a branch workspace back into the working tree.
 */
async function syncPull(options: SyncOptions): Promise<{ fileCount: number }> {
  const ws = await selectBranch({ ...options, projectDir: options.projectDir })
  if (!ws) return { fileCount: 0 }
  return pullFromWorkspace(options, ws)
}

/** The body of {@link syncPull}, once its workspace is chosen. */
async function pullFromWorkspace(
  options: SyncOptions,
  ws: SyncWorkspace,
): Promise<{ fileCount: number }> {
  const { projectDir } = options
  const contentRoot = options.contentRoot || 'content'
  const { branchName, branchPath } = ws
  const branchContentDir = path.join(branchPath, contentRoot)
  assertWithinDir(branchContentDir, branchPath, '--content-root')
  if (!(await filePathExists(branchContentDir))) {
    throw new SyncError(
      `Content directory not found in branch workspace: ${path.basename(branchPath)}/${contentRoot}`,
    )
  }

  p.log.step(`Pulling content from branch: ${branchName}`)

  const destContentDir = path.join(projectDir, contentRoot)
  assertWithinDir(destContentDir, projectDir, '--content-root')

  // Check for uncommitted changes AND untracked files in the content directory
  // before overwriting. The pull replaces the entire content directory, so any
  // file not in the branch workspace will be lost.
  const sourceGit = simpleGit({ baseDir: projectDir })
  const status = await sourceGit.status()
  const uncommittedContent = status.files.filter(
    (f) => f.path.startsWith(contentRoot + '/') || f.path === contentRoot,
  )

  // Also detect untracked files that git status doesn't report (e.g., new files
  // in subdirectories that haven't been staged). Walk the content directory and
  // compare against the branch workspace to find files that would be deleted.
  const untrackedLosses: string[] = []
  if (await filePathExists(destContentDir)) {
    const localFiles = await listFilesRecursive(destContentDir)
    const branchFiles = new Set(await listFilesRecursive(branchContentDir))
    for (const file of localFiles) {
      if (!branchFiles.has(file)) {
        const relativePath = contentRoot + '/' + file
        // Only flag files not already captured by git status
        if (!uncommittedContent.some((f) => f.path === relativePath)) {
          untrackedLosses.push(relativePath)
        }
      }
    }
  }

  const totalWarnings = uncommittedContent.length + untrackedLosses.length
  if (totalWarnings > 0 && !options.force) {
    if (uncommittedContent.length > 0) {
      p.log.warn(`You have ${uncommittedContent.length} uncommitted change(s) in ${contentRoot}/:`)
      for (const file of uncommittedContent.slice(0, 10)) {
        p.log.warn(`  ${file.path}`)
      }
      if (uncommittedContent.length > 10) {
        p.log.warn(`  ... and ${uncommittedContent.length - 10} more`)
      }
    }
    if (untrackedLosses.length > 0) {
      p.log.warn(
        `${untrackedLosses.length} file(s) in ${contentRoot}/ not present in branch "${branchName}" will be deleted:`,
      )
      for (const file of untrackedLosses.slice(0, 10)) {
        p.log.warn(`  ${file}`)
      }
      if (untrackedLosses.length > 10) {
        p.log.warn(`  ... and ${untrackedLosses.length - 10} more`)
      }
    }
    const confirm = await p.confirm({
      message: 'Overwrite content directory? Files listed above will be lost.',
      initialValue: false,
    })
    if (p.isCancel(confirm) || !confirm) {
      p.cancel('Pull cancelled. Commit or stash your changes first.')
      return { fileCount: 0 }
    }
  }

  // Uses backup-rename pattern: if interrupted, at least one copy always exists.
  const tmpDestDir = `${destContentDir}.sync-tmp-${Date.now()}`
  try {
    await copyDir(branchContentDir, tmpDestDir)
    await safeReplaceDir(destContentDir, tmpDestDir)
  } catch (err) {
    // Clean up temp dir on failure, preserve original
    await fs.rm(tmpDestDir, { recursive: true, force: true }).catch(() => {})
    throw err
  }

  const postStatus = await sourceGit.status()
  const contentChanges = postStatus.files.filter(
    (f) => f.path.startsWith(contentRoot + '/') || f.path === contentRoot,
  )

  if (contentChanges.length === 0) {
    p.log.info('Content is already up to date — nothing to pull')
  } else {
    p.log.success(`Pulled ${contentChanges.length} changed file(s) from branch "${branchName}"`)
    for (const file of contentChanges.slice(0, 20)) {
      const indicator = file.working_dir === '?' ? 'A' : file.working_dir || file.index
      p.log.info(`  ${indicator} ${file.path}`)
    }
    if (contentChanges.length > 20) {
      p.log.info(`  ... and ${contentChanges.length - 20} more`)
    }
    p.log.info('\nReview the changes, then git add and commit when ready.')
  }

  return { fileCount: contentChanges.length }
}

/**
 * Both: merge working-tree changes with editor changes in the workspace
 * using a 3-way git merge, then pull the merged result back.
 *
 * Uses a `canopycms-sync-base` tag as the merge base — this tag is set
 * by push after each successful sync.
 */
async function syncBoth(options: SyncOptions): Promise<{ pushed: number; pulled: number }> {
  const { projectDir } = options
  const contentRoot = options.contentRoot || 'content'

  // Validate source content BEFORE selectBranch, which may create a workspace
  const srcContentDir = path.join(projectDir, contentRoot)
  assertWithinDir(srcContentDir, projectDir, '--content-root')
  if (!(await filePathExists(srcContentDir))) {
    throw new SyncError(
      `Content directory not found: ${contentRoot}/ (expected at ${srcContentDir})`,
    )
  }

  const ws = await selectBranch({ ...options, projectDir, autoCreate: true })
  if (!ws) return { pushed: 0, pulled: 0 }
  const { branchName, branchPath } = ws
  const wsGit = simpleGit({ baseDir: branchPath })

  const status = await wsGit.status()
  if (status.conflicted.length > 0) {
    p.log.error('Branch workspace has unresolved merge conflicts.')
    if (!options.force) {
      const shouldAbort = await p.confirm({
        message: 'Abort the merge and restore workspace to pre-merge state?',
        initialValue: false,
      })
      if (!p.isCancel(shouldAbort) && shouldAbort) {
        if (await abortWorkspaceMerge(branchPath, branchName)) {
          p.log.success('Merge aborted. Workspace restored to pre-merge state.')
        }
      }
    }
    return { pushed: 0, pulled: 0 }
  }

  return withWorkspaceLock(branchPath, branchName, () =>
    mergeIntoWorkspace(options, { branchName, branchPath, srcContentDir, contentRoot }),
  )
}

/** The locked body of {@link syncBoth}: everything that rewrites the workspace. */
async function mergeIntoWorkspace(
  options: SyncOptions,
  ws: { branchName: string; branchPath: string; srcContentDir: string; contentRoot: string },
): Promise<{ pushed: number; pulled: number }> {
  const { branchPath, srcContentDir, contentRoot } = ws
  const wsGit = simpleGit({ baseDir: branchPath })
  const status = await wsGit.status()

  // Auto-commit uncommitted workspace changes (preserves editor work for the merge)
  if (status.files.some((f) => !isCanopyInternalPath(f.path))) {
    await stageAllExceptCanopyState(wsGit)
    await wsGit.commit('sync: save editor state before merge')
    p.log.info('Committed editor changes before merge')
  }

  let baseRef: string
  try {
    await wsGit.raw(['rev-parse', SYNC_BASE_TAG])
    baseRef = SYNC_BASE_TAG
  } catch {
    // First time: no tag exists. Use current HEAD as base.
    baseRef = 'HEAD'
  }

  const currentBranch = (await wsGit.revparse(['--abbrev-ref', 'HEAD'])).trim()

  // Everything from here mutates the branch clone's working tree (temp-branch
  // checkout, content replace, merge) — whatever the outcome, mark ContentStore
  // ID indexes stale in the finally below. The dev server is a separate
  // process, reached via the on-disk generation marker.
  try {
    const incomingBranch = `sync-incoming-${Date.now()}`
    await wsGit.raw(['checkout', '-b', incomingBranch, baseRef])

    const wsContentDir = path.join(branchPath, contentRoot)
    assertWithinDir(wsContentDir, branchPath, '--content-root')
    const tmpDir = `${wsContentDir}.sync-tmp-${Date.now()}`
    try {
      await copyDir(srcContentDir, tmpDir)
      await safeReplaceDir(wsContentDir, tmpDir)
    } catch (err) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      // Switch back to workspace branch before re-throwing
      await wsGit.checkout(currentBranch)
      await wsGit.raw(['branch', '-D', incomingBranch]).catch(() => {})
      throw err
    }

    await stageAllExceptCanopyState(wsGit)
    const incomingFiles = (await wsGit.status()).files.filter((f) => !isCanopyInternalPath(f.path))

    if (incomingFiles.length === 0) {
      await wsGit.checkout(currentBranch)
      await wsGit.raw(['branch', '-D', incomingBranch])
      p.log.info('No working-tree changes to merge — pulling editor changes only')
      const pullResult = await pullFromWorkspace({ ...options, force: true }, ws)
      return { pushed: 0, pulled: pullResult.fileCount }
    }

    await wsGit.commit('sync: incoming working-tree changes')

    await wsGit.checkout(currentBranch)

    p.log.step('Merging working-tree changes with editor changes...')

    try {
      await wsGit.merge([incomingBranch, '--no-edit'])
    } catch (mergeError) {
      let mergeStatus: Awaited<ReturnType<typeof wsGit.status>> | undefined
      try {
        mergeStatus = await wsGit.status()
      } catch {
        // status() failed — clean up incoming branch and re-throw original error
        await wsGit.raw(['branch', '-D', incomingBranch]).catch(() => {})
        throw mergeError
      }
      if (mergeStatus.conflicted.length > 0) {
        p.log.error('Merge conflicts detected in the following files:')
        for (const file of mergeStatus.conflicted) {
          p.log.error(`  ${file}`)
        }
        p.log.info('The branch workspace is now in a merge state.')
        p.log.info('Resolve the conflicts in the workspace, then run: canopycms sync pull')
        p.log.info('Or abort the merge with: canopycms sync abort')
        // Clean up the incoming branch (leave merge state for user resolution)
        await wsGit.raw(['branch', '-D', incomingBranch]).catch(() => {})
        return { pushed: 0, pulled: 0 }
      }
      await wsGit.raw(['branch', '-D', incomingBranch]).catch(() => {})
      throw mergeError
    }

    // Clean merge succeeded
    await wsGit.raw(['branch', '-D', incomingBranch])
    await wsGit.tag(['-f', SYNC_BASE_TAG])
    p.log.success('Merged working-tree changes with editor changes')

    const pullResult = await pullFromWorkspace({ ...options, force: true }, ws)
    return { pushed: incomingFiles.length, pulled: pullResult.fileCount }
  } finally {
    await invalidateBranchContentCaches(branchPath)
  }
}

/**
 * Abort: cancel a failed merge in a branch workspace by running `git merge --abort`.
 * Restores the workspace to its pre-merge state.
 */
async function syncAbort(options: SyncOptions): Promise<void> {
  const ws = await selectBranch({ ...options, projectDir: options.projectDir })
  if (!ws) return
  const { branchName, branchPath } = ws

  if (!(await abortWorkspaceMerge(branchPath, branchName))) {
    p.log.info(`Branch workspace "${branchName}" is not in a merge state — nothing to abort.`)
    return
  }

  p.log.success(
    `Merge aborted in branch workspace "${branchName}". Workspace restored to pre-merge state.`,
  )
}

/**
 * Run the sync command.
 *
 * @returns Summary of what was synced
 */
export async function sync(options: SyncOptions): Promise<{ pushed: number; pulled: number }> {
  p.intro('CanopyCMS sync')

  let pushed = 0
  let pulled = 0

  if (options.direction === 'abort') {
    await syncAbort(options)
  } else if (options.direction === 'both') {
    const result = await syncBoth(options)
    pushed = result.pushed
    pulled = result.pulled
  } else if (options.direction === 'push') {
    const result = await syncPush(options)
    pushed = result.fileCount
  } else {
    const result = await syncPull(options)
    pulled = result.fileCount
  }

  p.outro('Done!')
  return { pushed, pulled }
}
