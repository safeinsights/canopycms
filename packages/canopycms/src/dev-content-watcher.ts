/**
 * Dev-mode content divergence detection.
 *
 * In dev, the editor and dev server read content from a branch clone under
 * `.canopy-dev/content-branches/<branch>/`, while the static build reads the working tree directly.
 * When a developer edits working-tree `content/**` outside the editor, the dev server silently serves
 * stale content until `canopycms sync push` runs. This watcher surfaces that divergence:
 *
 * - 'warn' (default): log a warning naming the diverged files (on startup and on content changes).
 * - 'auto': push working-tree content into the branch clone automatically (no manual sync).
 * - 'off': do nothing.
 *
 * All logic lives here in the core package; framework adapters just call startDevContentWatcher() once
 * at dev startup. See packages/canopycms-next/src/context-wrapper.ts for the Next wiring.
 */

import fsSync from 'node:fs'
import path from 'node:path'
import chokidar from 'chokidar'
import type { CanopyServices } from './services'
import type { DevContentSyncMode } from './config/types'
import { operatingStrategy } from './operating-mode'
import { getErrorMessage } from './utils/error'
import {
  diffContentTrees,
  isContentTreeDiffEmpty,
  pushContentToWorkspace,
  SYNC_BASE_TAG,
  type ContentTreeDiff,
} from './sync-core'

export interface StartDevContentWatcherOptions {
  /** 'warn' (default) | 'auto' | 'off'. */
  mode?: DevContentSyncMode
  /** Branch clone to compare against. Defaults to defaultActiveBranch ?? defaultBaseBranch ?? 'main'. */
  branch?: string
  /** Project root. Defaults to config.sourceRoot ?? process.cwd(). */
  sourceRoot?: string
  /** Warning sink. Defaults to console.warn. */
  warn?: (message: string) => void
}

const MAX_LISTED_FILES = 10

function formatList(label: string, files: string[]): string | null {
  if (files.length === 0) return null
  const shown = files.slice(0, MAX_LISTED_FILES).join(', ')
  const extra =
    files.length > MAX_LISTED_FILES ? `, …(+${files.length - MAX_LISTED_FILES} more)` : ''
  return `  ${label}: ${shown}${extra}`
}

function formatDivergenceWarning(branch: string, diff: ContentTreeDiff): string {
  const lines = [
    `CanopyCMS: working-tree content has diverged from the dev branch clone "${branch}" — the dev ` +
      'server is serving stale content. Run `npx canopycms sync push` to update it ' +
      "(set dev.contentSync: 'auto' to auto-sync, or 'off' to silence this).",
    formatList('changed', diff.changed),
    formatList('only in working tree', diff.added),
    formatList('only in branch clone', diff.removed),
  ].filter((line): line is string => line !== null)
  return lines.join('\n')
}

/**
 * Start watching the working-tree content directory for divergence from the served dev branch clone.
 * Returns a disposer that stops the watcher. A no-op (returns immediately) when mode is 'off', when
 * not in dev mode, or when the working-tree content directory does not exist.
 */
export function startDevContentWatcher(
  services: CanopyServices,
  options: StartDevContentWatcherOptions = {},
): () => void {
  const noop = () => {}
  const mode = options.mode ?? 'warn'
  if (mode === 'off' || services.config.mode !== 'dev') return noop

  const sourceRoot = options.sourceRoot ?? services.config.sourceRoot ?? process.cwd()
  const contentRoot = services.config.contentRoot || 'content'
  const branch =
    options.branch ??
    services.config.defaultActiveBranch ??
    services.config.defaultBaseBranch ??
    'main'

  const strategy = operatingStrategy('dev')
  const workingTreeContentDir = strategy.getContentRoot(sourceRoot)
  const branchPath = strategy.getContentBranchRoot(branch, sourceRoot)
  const branchContentDir = path.join(branchPath, contentRoot)
  const warn = options.warn ?? ((message: string) => console.warn(message))

  // Nothing to watch if the working tree has no content directory (e.g. unit-test configs).
  if (!fsSync.existsSync(workingTreeContentDir)) return noop

  let running = false
  let pending = false
  const check = async (): Promise<void> => {
    if (running) {
      pending = true
      return
    }
    running = true
    try {
      // No branch clone yet (e.g. before the first editor/dev request created it) → nothing to compare.
      if (!fsSync.existsSync(branchContentDir)) return
      const diff = await diffContentTrees(workingTreeContentDir, branchContentDir)
      if (isContentTreeDiffEmpty(diff)) return

      if (mode === 'auto') {
        const { fileCount } = await pushContentToWorkspace({
          srcContentDir: workingTreeContentDir,
          branchPath,
          contentRoot,
          commitMessage: 'sync: auto-push from dev content watcher',
          baseTag: SYNC_BASE_TAG,
        })
        if (fileCount > 0) {
          warn(
            `CanopyCMS: auto-synced ${fileCount} content change(s) to dev branch clone "${branch}".`,
          )
        }
        return
      }

      warn(formatDivergenceWarning(branch, diff))
    } catch (err) {
      warn(`CanopyCMS: dev content-sync check failed: ${getErrorMessage(err)}`)
    } finally {
      running = false
      if (pending) {
        pending = false
        void check()
      }
    }
  }

  const watcher = chokidar.watch(workingTreeContentDir, { ignoreInitial: true })
  watcher.on('add', () => void check())
  watcher.on('change', () => void check())
  watcher.on('unlink', () => void check())

  // Initial divergence check at startup.
  void check()

  return () => {
    void watcher.close()
  }
}
