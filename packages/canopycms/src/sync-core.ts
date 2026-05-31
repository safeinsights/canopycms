/**
 * Prompt-free core of the content sync between the working tree and CMS branch workspaces in
 * `.canopy-dev/content-branches/`. The interactive CLI (cli/sync.ts) wraps these with prompts; the
 * dev content watcher (dev-content-watcher.ts) reuses them for divergence detection and auto-sync.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { filePathExists } from './utils/fs'

/** Git tag marking the last known sync point, used as the merge base for `sync both` 3-way merges. */
export const SYNC_BASE_TAG = 'canopycms-sync-base'

/** Validate that a resolved path stays within the expected parent directory. */
export function assertWithinDir(resolved: string, parent: string, label: string): void {
  const normalizedResolved = path.resolve(resolved)
  const normalizedParent = path.resolve(parent)
  if (
    !normalizedResolved.startsWith(normalizedParent + path.sep) &&
    normalizedResolved !== normalizedParent
  ) {
    throw new Error(`${label} escapes the expected directory: ${resolved}`)
  }
}

/**
 * Safely replace a directory by renaming the old one to a backup, renaming
 * the new one into place, then deleting the backup. If interrupted between
 * steps, at least one copy always exists on disk.
 */
export async function safeReplaceDir(oldDir: string, newDir: string): Promise<void> {
  const backupDir = `${oldDir}.sync-backup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const oldExists = await filePathExists(oldDir)
  if (oldExists) {
    await fs.rename(oldDir, backupDir)
  }
  try {
    await fs.rename(newDir, oldDir)
  } catch (err) {
    // Restore backup if the rename failed
    if (oldExists) {
      await fs.rename(backupDir, oldDir).catch(() => {})
    }
    throw err
  }
  if (oldExists) {
    await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Recursively list all file paths relative to `dir`. Skips .git and symlinks. */
export async function listFilesRecursive(dir: string, prefix = ''): Promise<string[]> {
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
export async function copyDir(src: string, dest: string): Promise<void> {
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

/** Difference between two content directories, by relative file path. */
export interface ContentTreeDiff {
  /** Files present in the working tree but not the branch clone. */
  added: string[]
  /** Files present in the branch clone but not the working tree. */
  removed: string[]
  /** Files present in both but with differing content. */
  changed: string[]
}

/** True when the diff contains no added/removed/changed files. */
export function isContentTreeDiffEmpty(diff: ContentTreeDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0
}

async function readFileSafe(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file)
  } catch {
    return null
  }
}

/**
 * Compare two content directories by file presence and exact content (byte comparison — robust to
 * mtime differences, which `fs.copyFile` does not preserve). Missing directories list as empty.
 */
export async function diffContentTrees(
  workingTreeDir: string,
  branchDir: string,
): Promise<ContentTreeDiff> {
  const [wtFiles, brFiles] = await Promise.all([
    listFilesRecursive(workingTreeDir),
    listFilesRecursive(branchDir),
  ])
  const wtSet = new Set(wtFiles)
  const brSet = new Set(brFiles)

  const added = wtFiles.filter((f) => !brSet.has(f)).sort()
  const removed = brFiles.filter((f) => !wtSet.has(f)).sort()
  const common = wtFiles.filter((f) => brSet.has(f))

  const changed: string[] = []
  for (const rel of common) {
    const [a, b] = await Promise.all([
      readFileSafe(path.join(workingTreeDir, rel)),
      readFileSafe(path.join(branchDir, rel)),
    ])
    if (!a || !b) continue
    if (!a.equals(b)) changed.push(rel)
  }
  changed.sort()

  return { added, removed, changed }
}

export interface PushContentToWorkspaceOptions {
  /** Working-tree content directory (source). */
  srcContentDir: string
  /** Branch workspace root (a git repo). */
  branchPath: string
  /** Content directory name within the workspace (e.g. 'content'). */
  contentRoot: string
  /** Commit message for the content update. */
  commitMessage?: string
  /** When set, (re)tag the resulting commit as the sync base (used by `sync both` 3-way merges). */
  baseTag?: string
}

/**
 * Copy working-tree content into a branch workspace and commit it. Prompt-free — the interactive CLI
 * and the dev watcher both call this for the actual copy + commit + tag step.
 *
 * Returns the number of changed files committed (0 when content was already up to date).
 */
export async function pushContentToWorkspace(
  options: PushContentToWorkspaceOptions,
): Promise<{ fileCount: number }> {
  const { srcContentDir, branchPath, contentRoot, commitMessage, baseTag } = options

  if (!(await filePathExists(srcContentDir))) {
    return { fileCount: 0 }
  }

  const wsContentDir = path.join(branchPath, contentRoot)
  assertWithinDir(wsContentDir, branchPath, 'content-root')

  // Copy into a temp dir, then atomically swap it into place.
  const tmpDir = `${wsContentDir}.sync-tmp-${Date.now()}`
  try {
    await copyDir(srcContentDir, tmpDir)
    await safeReplaceDir(wsContentDir, tmpDir)
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    throw err
  }

  const wsGit = simpleGit({ baseDir: branchPath })
  await wsGit.add('-A')
  const postStatus = await wsGit.status()

  if (postStatus.files.length === 0) {
    if (baseTag) await wsGit.tag(['-f', baseTag])
    return { fileCount: 0 }
  }

  await wsGit.commit(commitMessage ?? 'sync: update content from working tree')
  if (baseTag) await wsGit.tag(['-f', baseTag])

  return { fileCount: postStatus.files.length }
}
