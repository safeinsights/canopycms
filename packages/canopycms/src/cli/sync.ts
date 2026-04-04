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
import { filePathExists } from '../utils/fs'

/** Validate that a resolved path stays within the expected parent directory. */
function assertWithinDir(resolved: string, parent: string, label: string): void {
  const normalizedResolved = path.resolve(resolved)
  const normalizedParent = path.resolve(parent)
  if (
    !normalizedResolved.startsWith(normalizedParent + path.sep) &&
    normalizedResolved !== normalizedParent
  ) {
    throw new Error(`${label} escapes the expected directory: ${resolved}`)
  }
}

export interface SyncOptions {
  projectDir: string
  direction: 'push' | 'pull' | 'both' | 'abort'
  /** Which branch workspace to push to / pull from */
  branch?: string
  contentRoot?: string
  /** Skip confirmation prompts (for testing or scripts). */
  force?: boolean
}

const SYNC_BASE_TAG = 'canopycms-sync-base'

/** Recursively list all file paths relative to `dir`. Skips .git and symlinks. */
async function listFilesRecursive(dir: string, prefix = ''): Promise<string[]> {
  const results: string[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    if (entry.name === '.git') continue
    if (entry.isSymbolicLink()) continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      results.push(...(await listFilesRecursive(path.join(dir, entry.name), rel)))
    } else {
      results.push(rel)
    }
  }
  return results
}

/** Recursively copy a directory, creating the destination if needed. Skips .git directories and symlinks. */
async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === '.git') continue
    if (entry.isSymbolicLink()) continue
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath)
    } else {
      await fs.copyFile(srcPath, destPath)
    }
  }
}

/**
 * Select a branch workspace. Auto-selects if only one exists, prompts if
 * multiple, or uses the --branch flag. Returns null if cancelled or not found.
 */
async function selectBranch(
  options: Pick<SyncOptions, 'branch'>,
  branchesDir: string,
): Promise<string | null> {
  let branches: string[] = []
  if (await filePathExists(branchesDir)) {
    const entries = await fs.readdir(branchesDir, { withFileTypes: true })
    branches = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  }

  if (branches.length === 0) {
    p.log.error('No branch workspaces found. Create a branch in the editor first.')
    return null
  }

  let branchName = options.branch
  if (!branchName) {
    if (branches.length === 1) {
      branchName = branches[0]
    } else {
      const result = await p.select({
        message: 'Which branch?',
        options: branches.map((b) => ({ value: b, label: b })),
      })
      if (p.isCancel(result)) {
        p.cancel('Sync cancelled.')
        return null
      }
      branchName = result
    }
  }

  if (!branches.includes(branchName)) {
    p.log.error(`Branch workspace "${branchName}" not found.`)
    p.log.info(`Available branches: ${branches.join(', ')}`)
    return null
  }

  return branchName
}

/**
 * Push: copy working-tree content into a branch workspace and commit.
 * Tags the resulting commit as the sync base for future merges.
 */
async function syncPush(options: SyncOptions): Promise<{ fileCount: number }> {
  const { projectDir } = options
  const contentRoot = options.contentRoot || 'content'
  const branchesDir = path.join(projectDir, '.canopy-dev', 'content-branches')

  const branchName = await selectBranch(options, branchesDir)
  if (!branchName) return { fileCount: 0 }

  const branchPath = path.join(branchesDir, branchName)
  const wsGit = simpleGit({ baseDir: branchPath })

  // Validate source content
  const srcContentDir = path.join(projectDir, contentRoot)
  assertWithinDir(srcContentDir, projectDir, '--content-root')
  if (!(await filePathExists(srcContentDir))) {
    p.log.warn(`Content directory not found: ${contentRoot}/`)
    return { fileCount: 0 }
  }

  // Check workspace health
  const status = await wsGit.status()
  if (status.conflicted.length > 0) {
    p.log.error('Branch workspace has unresolved merge conflicts.')
    if (!options.force) {
      const shouldAbort = await p.confirm({
        message: 'Abort the merge and restore workspace to pre-merge state?',
        initialValue: false,
      })
      if (!p.isCancel(shouldAbort) && shouldAbort) {
        await wsGit.merge(['--abort'])
        p.log.success('Merge aborted. Workspace restored to pre-merge state.')
      }
    }
    return { fileCount: 0 }
  }

  // Warn about uncommitted workspace changes (editor saves)
  if (status.files.length > 0 && !options.force) {
    p.log.warn(
      `Branch workspace has ${status.files.length} uncommitted change(s) that will be committed to history then overwritten:`,
    )
    for (const file of status.files.slice(0, 10)) {
      p.log.warn(`  ${file.path}`)
    }
    if (status.files.length > 10) {
      p.log.warn(`  ... and ${status.files.length - 10} more`)
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

  // Auto-commit uncommitted workspace changes to preserve in history
  if (status.files.length > 0) {
    await wsGit.add('-A')
    await wsGit.commit('sync: save editor state before push')
    p.log.info('Committed editor changes to history before push')
  }

  p.log.step(`Pushing content to branch workspace: ${branchName}`)

  // Atomic copy: working-tree content → workspace content dir
  const wsContentDir = path.join(branchPath, contentRoot)
  assertWithinDir(wsContentDir, branchPath, '--content-root')
  const tmpDir = `${wsContentDir}.sync-tmp-${Date.now()}`
  try {
    await copyDir(srcContentDir, tmpDir)
    await fs.rm(wsContentDir, { recursive: true, force: true })
    await fs.rename(tmpDir, wsContentDir)
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    throw err
  }

  // Stage and check for changes
  await wsGit.add('-A')
  const postStatus = await wsGit.status()

  if (postStatus.files.length === 0) {
    p.log.info('Content is already up to date — nothing to push')
    // Still tag as sync base — marks this as a known sync point for future merges
    await wsGit.tag(['-f', SYNC_BASE_TAG])
    return { fileCount: 0 }
  }

  await wsGit.commit('sync: update content from working tree')

  // Tag as sync base for future merges
  await wsGit.tag(['-f', SYNC_BASE_TAG])

  p.log.success(`Pushed ${postStatus.files.length} file change(s) to branch "${branchName}"`)
  return { fileCount: postStatus.files.length }
}

/**
 * Pull: copy content from a branch workspace back into the working tree.
 */
async function syncPull(options: SyncOptions): Promise<{ fileCount: number }> {
  const { projectDir } = options
  const contentRoot = options.contentRoot || 'content'
  const branchesDir = path.join(projectDir, '.canopy-dev', 'content-branches')

  const branchName = await selectBranch(options, branchesDir)
  if (!branchName) return { fileCount: 0 }

  const branchContentDir = path.join(branchesDir, branchName, contentRoot)
  assertWithinDir(branchContentDir, branchesDir, '--content-root')
  if (!(await filePathExists(branchContentDir))) {
    p.log.error(`Content directory not found in branch workspace: ${branchName}/${contentRoot}`)
    return { fileCount: 0 }
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

  // Replace the working-tree content with the branch workspace content.
  // Use a temp directory + rename for atomicity: if copyDir fails midway,
  // the original content directory is preserved.
  const tmpDestDir = `${destContentDir}.sync-tmp-${Date.now()}`
  try {
    await copyDir(branchContentDir, tmpDestDir)
    await fs.rm(destContentDir, { recursive: true, force: true })
    await fs.rename(tmpDestDir, destContentDir)
  } catch (err) {
    // Clean up temp dir on failure, preserve original
    await fs.rm(tmpDestDir, { recursive: true, force: true }).catch(() => {})
    throw err
  }

  // Show what changed using git status (re-check after copy)
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
  const branchesDir = path.join(projectDir, '.canopy-dev', 'content-branches')

  const branchName = await selectBranch(options, branchesDir)
  if (!branchName) return { pushed: 0, pulled: 0 }

  const branchPath = path.join(branchesDir, branchName)
  const wsGit = simpleGit({ baseDir: branchPath })

  // Validate source content
  const srcContentDir = path.join(projectDir, contentRoot)
  assertWithinDir(srcContentDir, projectDir, '--content-root')
  if (!(await filePathExists(srcContentDir))) {
    p.log.warn(`Content directory not found: ${contentRoot}/`)
    return { pushed: 0, pulled: 0 }
  }

  // Check workspace health
  const status = await wsGit.status()
  if (status.conflicted.length > 0) {
    p.log.error('Branch workspace has unresolved merge conflicts.')
    if (!options.force) {
      const shouldAbort = await p.confirm({
        message: 'Abort the merge and restore workspace to pre-merge state?',
        initialValue: false,
      })
      if (!p.isCancel(shouldAbort) && shouldAbort) {
        await wsGit.merge(['--abort'])
        p.log.success('Merge aborted. Workspace restored to pre-merge state.')
      }
    }
    return { pushed: 0, pulled: 0 }
  }

  // Auto-commit uncommitted workspace changes (preserves editor work for the merge)
  if (status.files.length > 0) {
    await wsGit.add('-A')
    await wsGit.commit('sync: save editor state before merge')
    p.log.info('Committed editor changes before merge')
  }

  // Determine merge base
  let baseRef: string
  try {
    await wsGit.raw(['rev-parse', SYNC_BASE_TAG])
    baseRef = SYNC_BASE_TAG
  } catch {
    // First time: no tag exists. Use current HEAD as base.
    baseRef = 'HEAD'
  }

  // Remember the current branch to switch back after merge
  const currentBranch = (await wsGit.revparse(['--abbrev-ref', 'HEAD'])).trim()

  // Create temp branch from the merge base
  const incomingBranch = `sync-incoming-${Date.now()}`
  await wsGit.raw(['checkout', '-b', incomingBranch, baseRef])

  // Replace content on temp branch with working-tree content
  const wsContentDir = path.join(branchPath, contentRoot)
  assertWithinDir(wsContentDir, branchPath, '--content-root')
  const tmpDir = `${wsContentDir}.sync-tmp-${Date.now()}`
  try {
    await copyDir(srcContentDir, tmpDir)
    await fs.rm(wsContentDir, { recursive: true, force: true })
    await fs.rename(tmpDir, wsContentDir)
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    // Switch back to workspace branch before re-throwing
    await wsGit.checkout(currentBranch)
    await wsGit.raw(['branch', '-D', incomingBranch]).catch(() => {})
    throw err
  }

  await wsGit.add('-A')
  const incomingStatus = await wsGit.status()

  // No working-tree changes — skip merge, just pull editor changes
  if (incomingStatus.files.length === 0) {
    await wsGit.checkout(currentBranch)
    await wsGit.raw(['branch', '-D', incomingBranch])
    p.log.info('No working-tree changes to merge — pulling editor changes only')
    const pullResult = await syncPull({ ...options, branch: branchName, force: true })
    return { pushed: 0, pulled: pullResult.fileCount }
  }

  await wsGit.commit('sync: incoming working-tree changes')

  // Switch back to workspace branch and merge
  await wsGit.checkout(currentBranch)

  p.log.step('Merging working-tree changes with editor changes...')

  try {
    await wsGit.merge([incomingBranch, '--no-edit'])
  } catch {
    // Check if it's a merge conflict
    const mergeStatus = await wsGit.status()
    if (mergeStatus.conflicted.length > 0) {
      p.log.error('Merge conflicts detected in the following files:')
      for (const file of mergeStatus.conflicted) {
        p.log.error(`  ${file}`)
      }
      p.log.info('The branch workspace is now in a merge state.')
      p.log.info('Resolve the conflicts in the workspace, then run: canopycms sync --pull')
      p.log.info('Or abort the merge with: canopycms sync --abort')
      // Clean up the incoming branch (leave merge state for user resolution)
      await wsGit.raw(['branch', '-D', incomingBranch]).catch(() => {})
      return { pushed: 0, pulled: 0 }
    }
    // Not a conflict — clean up and re-throw
    await wsGit.raw(['branch', '-D', incomingBranch]).catch(() => {})
    throw mergeStatus
  }

  // Clean merge succeeded
  await wsGit.raw(['branch', '-D', incomingBranch])
  await wsGit.tag(['-f', SYNC_BASE_TAG])
  p.log.success('Merged working-tree changes with editor changes')

  // Pull merged result back to working tree
  const pullResult = await syncPull({ ...options, branch: branchName, force: true })
  return { pushed: incomingStatus.files.length, pulled: pullResult.fileCount }
}

/**
 * Abort: cancel a failed merge in a branch workspace by running `git merge --abort`.
 * Restores the workspace to its pre-merge state.
 */
async function syncAbort(options: SyncOptions): Promise<void> {
  const { projectDir } = options
  const branchesDir = path.join(projectDir, '.canopy-dev', 'content-branches')

  const branchName = await selectBranch(options, branchesDir)
  if (!branchName) return

  const branchPath = path.join(branchesDir, branchName)
  const wsGit = simpleGit({ baseDir: branchPath })

  const status = await wsGit.status()
  if (status.conflicted.length === 0) {
    p.log.info(`Branch workspace "${branchName}" is not in a merge state — nothing to abort.`)
    return
  }

  await wsGit.merge(['--abort'])
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
