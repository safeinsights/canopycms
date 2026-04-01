/**
 * CLI command: npx canopycms sync
 *
 * Bidirectional sync between the developer's working repo and the
 * .canopy-dev local remote used by the CMS editor.
 *
 * - Push: updates the local remote with current working-tree content
 *   (including uncommitted changes), then fetches in all branch workspaces
 *   so the editor sees the latest content.
 *
 * - Pull: copies published content from a branch workspace back into the
 *   working repo's content directory so the developer can review and commit.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import * as p from '@clack/prompts'
import { GitManager } from '../git-manager'
import { detectHeadBranch } from '../utils/git'
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
  direction: 'push' | 'pull' | 'both'
  /** For pull: which branch workspace to pull from */
  branch?: string
  contentRoot?: string
  /** Skip confirmation prompts (for testing or scripts). */
  force?: boolean
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
 * Push: update the local bare remote (.canopy-dev/remote.git) with the
 * current working-tree content, then fetch in all existing branch workspaces.
 *
 * Uses a temp clone of the bare remote to stage and push content without
 * touching the developer's repo git state at all.
 */
async function syncPush(options: SyncOptions): Promise<{ fileCount: number }> {
  const { projectDir } = options
  const contentRoot = options.contentRoot || 'content'
  const remotePath = path.join(projectDir, '.canopy-dev', 'remote.git')
  const branchesDir = path.join(projectDir, '.canopy-dev', 'content-branches')

  // Detect the current branch in the source repo
  const baseBranch = await detectHeadBranch(projectDir)

  // Auto-initialize the local remote if it doesn't exist
  if (!(await filePathExists(remotePath))) {
    p.log.step('Initializing local remote...')
    await GitManager.ensureLocalSimulatedRemote({
      remotePath,
      sourcePath: projectDir,
      baseBranch,
    })
    p.log.success('Created .canopy-dev/remote.git')
  }

  p.log.step(`Pushing content to local remote (branch: ${baseBranch})`)

  const srcContentDir = path.join(projectDir, contentRoot)
  assertWithinDir(srcContentDir, projectDir, '--content-root')
  if (!(await filePathExists(srcContentDir))) {
    p.log.warn(`Content directory not found: ${contentRoot}/`)
    return { fileCount: 0 }
  }

  // Clone the bare remote into a temp directory.
  // If the target branch doesn't exist in the remote (e.g., developer switched
  // git branches since the remote was first seeded), clone the default branch
  // and create the target branch from it.
  const tmpDir = path.join(
    projectDir,
    '.canopy-dev',
    `.sync-tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  try {
    let clonedBranch: string
    try {
      await simpleGit().clone(remotePath, tmpDir, ['--branch', baseBranch, '--single-branch'])
      clonedBranch = baseBranch
    } catch (err) {
      // Target branch doesn't exist in remote — clone whatever default branch exists
      const msg = err instanceof Error ? err.message : String(err)
      p.log.info(`Branch "${baseBranch}" not in remote (${msg}), cloning default branch`)
      await simpleGit().clone(remotePath, tmpDir)
      clonedBranch = (
        await simpleGit({ baseDir: tmpDir }).revparse(['--abbrev-ref', 'HEAD'])
      ).trim()
    }

    const tmpGit = simpleGit({ baseDir: tmpDir })
    await tmpGit.addConfig('user.name', 'CanopyCMS Sync')
    await tmpGit.addConfig('user.email', 'sync@canopycms.local')

    // If we cloned a different branch, create the target branch
    if (clonedBranch !== baseBranch) {
      await tmpGit.checkoutLocalBranch(baseBranch)
    }

    // Replace content in the temp clone with the working-tree content
    const dstContentDir = path.join(tmpDir, contentRoot)
    await fs.rm(dstContentDir, { recursive: true, force: true })
    await copyDir(srcContentDir, dstContentDir)

    // Stage and check for changes
    await tmpGit.add('-A')
    const status = await tmpGit.status()

    if (status.files.length === 0) {
      p.log.info('Content is already up to date — nothing to push')
      return { fileCount: 0 }
    }

    await tmpGit.commit('sync: update content from working tree')
    await tmpGit.push('origin', `${baseBranch}:${baseBranch}`, ['--set-upstream'])

    p.log.success(`Pushed ${status.files.length} file change(s) to local remote`)

    // Fetch in existing branch workspaces so they see the updated base
    if (await filePathExists(branchesDir)) {
      const entries = await fs.readdir(branchesDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const branchPath = path.join(branchesDir, entry.name)
        try {
          await simpleGit({ baseDir: branchPath }).fetch('origin')
          p.log.info(`  Fetched in branch workspace: ${entry.name}`)
        } catch {
          // Skip branches that can't be fetched (e.g., missing .git)
        }
      }
    }

    return { fileCount: status.files.length }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
}

/**
 * Pull: copy published content from a branch workspace back into the
 * working repo's content directory.
 */
async function syncPull(options: SyncOptions): Promise<{ fileCount: number }> {
  const { projectDir } = options
  const contentRoot = options.contentRoot || 'content'
  const branchesDir = path.join(projectDir, '.canopy-dev', 'content-branches')

  // List available branch workspaces
  let branches: string[] = []
  if (await filePathExists(branchesDir)) {
    const entries = await fs.readdir(branchesDir, { withFileTypes: true })
    branches = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  }

  if (branches.length === 0) {
    p.log.error('No branch workspaces found. Create a branch in the editor first.')
    return { fileCount: 0 }
  }

  // Select which branch to pull from
  let branchName = options.branch
  if (!branchName) {
    if (branches.length === 1) {
      branchName = branches[0]
    } else {
      const result = await p.select({
        message: 'Which branch to pull content from?',
        options: branches.map((b) => ({ value: b, label: b })),
      })
      if (p.isCancel(result)) {
        p.cancel('Sync cancelled.')
        return { fileCount: 0 }
      }
      branchName = result
    }
  }

  if (!branches.includes(branchName)) {
    p.log.error(`Branch workspace "${branchName}" not found.`)
    p.log.info(`Available branches: ${branches.join(', ')}`)
    return { fileCount: 0 }
  }

  const branchContentDir = path.join(branchesDir, branchName, contentRoot)
  assertWithinDir(branchContentDir, branchesDir, '--content-root')
  if (!(await filePathExists(branchContentDir))) {
    p.log.error(`Content directory not found in branch workspace: ${branchName}/${contentRoot}`)
    return { fileCount: 0 }
  }

  p.log.step(`Pulling content from branch: ${branchName}`)

  const destContentDir = path.join(projectDir, contentRoot)
  assertWithinDir(destContentDir, projectDir, '--content-root')

  // Check for uncommitted changes in the content directory before overwriting
  const sourceGit = simpleGit({ baseDir: projectDir })
  const status = await sourceGit.status()
  const uncommittedContent = status.files.filter(
    (f) => f.path.startsWith(contentRoot + '/') || f.path === contentRoot,
  )

  if (uncommittedContent.length > 0 && !options.force) {
    p.log.warn(
      `You have ${uncommittedContent.length} uncommitted change(s) in ${contentRoot}/ that will be overwritten:`,
    )
    for (const file of uncommittedContent.slice(0, 10)) {
      p.log.warn(`  ${file.path}`)
    }
    if (uncommittedContent.length > 10) {
      p.log.warn(`  ... and ${uncommittedContent.length - 10} more`)
    }
    const confirm = await p.confirm({
      message: 'Overwrite uncommitted content changes?',
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
 * Run the sync command.
 *
 * @returns Summary of what was synced
 */
export async function sync(options: SyncOptions): Promise<{ pushed: number; pulled: number }> {
  p.intro('CanopyCMS sync')

  let pushed = 0
  let pulled = 0

  if (options.direction === 'push' || options.direction === 'both') {
    const result = await syncPush(options)
    pushed = result.fileCount
  }

  if (options.direction === 'pull' || options.direction === 'both') {
    const result = await syncPull(options)
    pulled = result.fileCount
  }

  p.outro('Done!')
  return { pushed, pulled }
}
