/**
 * Dev-mode content divergence detection.
 *
 * In dev, the editor and dev server read content from a branch clone under
 * `.canopy-dev/content-branches/<branch>/`, while the static build reads the working tree directly.
 * When a developer edits working-tree `content/**` outside the editor, the dev server silently serves
 * stale content until `canopycms sync push` runs. This watcher surfaces that divergence:
 *
 * - 'warn' (default): log a warning naming the diverged files (on startup and on content changes).
 * - 'off': do nothing.
 *
 * There is intentionally NO auto-push mode: overwriting the branch clone from the working tree would
 * silently clobber uncommitted editor "Save" state with no Canopy-level recovery for the editor.
 * Reconciliation goes through the interactive `canopycms sync push` (conflict-aware) instead.
 *
 * All logic lives here in the core package; framework adapters just call startDevContentWatcher() once
 * at dev startup. See packages/canopycms-next/src/context-wrapper.ts for the Next wiring.
 *
 * ## Divergence is a CONDITION, not an event
 *
 * It stays true until someone runs `sync push`, so the two things this module has to get right are
 * (a) not re-printing the same condition into a scrolling request log, and (b) making the one printing
 * of it hard to scroll past. Both are handled below by `reportOnce` + the gutter formatting; see
 * `.claude/future-tasks/dev-divergence-in-app-surface.md` for the in-app surface that would replace
 * the terminal as the primary home for this.
 */

import fsSync from 'node:fs'
import path from 'node:path'
import chokidar from 'chokidar'
import pc from 'picocolors'
import type { CanopyServices } from './services'
import type { DevContentSyncMode } from './config/types'
import { operatingStrategy } from './operating-mode'
import { getErrorMessage } from './utils/error'
import { diffContentTrees, isContentTreeDiffEmpty, type ContentTreeDiff } from './sync-core'

export interface StartDevContentWatcherOptions {
  /** 'warn' (default) | 'off'. */
  mode?: DevContentSyncMode
  /** Branch clone to compare against. Defaults to the served active branch, re-resolved each check. */
  branch?: string
  /** Project root. Defaults to config.sourceRoot ?? process.cwd(). */
  sourceRoot?: string
  /** Warning sink. Defaults to console.warn. */
  warn?: (message: string) => void
}

/**
 * Per-category cap on listed files. Deliberately small: the block is a prompt to run `sync push`,
 * not a diff viewer, and a 30-line wall of paths is exactly as easy to scroll past as a 1-line
 * warning. Each list carries its true count, so nothing is hidden -- only elided.
 */
const MAX_LISTED_FILES = 5

/**
 * Cross-module-instance state for one working-tree content directory.
 *
 * `lastMessage`/`reportedDivergence` MUST outlive `dispose`: an HMR restart tears the watcher down
 * and immediately arms a new one, whose startup check re-finds the same divergence. Dropping the
 * state with the watcher is what makes the identical block print again.
 */
interface DevWatcherState {
  /** Disposer for the currently-armed watcher, or null when none is armed. */
  dispose: (() => void) | null
  /** Last message handed to `warn`, so a verbatim repeat is suppressed. */
  lastMessage: string | null
  /** True while a divergence has been reported and not since observed clean. */
  reportedDivergence: boolean
}

/**
 * The registry lives on `globalThis`, NOT in module scope.
 *
 * Next's dev server compiles the server graph per route bundle and evaluates each copy in its own
 * module scope, so a module-level `Map` is re-created empty per bundle -- every copy then believes it
 * is the first watcher, arms its own, and re-prints the startup warning. (The duplicated
 * "CanopyCMS dev-auth: Auto-configured ..." line in a dev log is the same effect on a different
 * module-level latch.) A `globalThis` property is the one thing shared across those evaluations.
 */
const REGISTRY_KEY = '__canopycmsDevContentWatchers__'

interface DevWatcherRegistryHost {
  [REGISTRY_KEY]?: Map<string, DevWatcherState>
}

function watcherRegistry(): Map<string, DevWatcherState> {
  const host = globalThis as typeof globalThis & DevWatcherRegistryHost
  const existing = host[REGISTRY_KEY]
  if (existing) return existing
  const created = new Map<string, DevWatcherState>()
  host[REGISTRY_KEY] = created
  return created
}

/** Test-only: dispose every armed watcher and drop all cross-module dedupe state. */
export function resetDevContentWatchersForTests(): void {
  const registry = watcherRegistry()
  for (const state of registry.values()) state.dispose?.()
  registry.clear()
}

/**
 * One body line of the notice block. The left gutter (rather than a full box) is deliberate: content
 * paths are long and unpredictable, and a right border would force either wrapping math or truncation
 * of the very filenames the block exists to name.
 */
function body(line: string): string {
  const gutter = pc.yellow('|')
  return line ? `${gutter} ${line}` : gutter
}

function formatList(label: string, files: string[]): string[] {
  if (files.length === 0) return []
  const shown = files.slice(0, MAX_LISTED_FILES)
  const lines = [body(pc.bold(`${label} (${files.length})`)), ...shown.map((f) => body(`  ${f}`))]
  if (files.length > shown.length) {
    lines.push(body(pc.dim(`  +${files.length - shown.length} more`)))
  }
  return lines
}

function formatDivergenceWarning(branch: string, diff: ContentTreeDiff): string {
  const total = diff.changed.length + diff.added.length + diff.removed.length
  // Blank lines top and bottom: the block's job is to be findable in a scrolling request log, and
  // whitespace separation does more for that than any amount of in-block decoration.
  return [
    '',
    `${pc.bgYellow(pc.black(' CanopyCMS '))} ${pc.bold(pc.yellow('working-tree content has diverged'))}`,
    body(`The dev server is serving ${pc.bold('stale content')}: ${total} file(s) differ from the`),
    body(`dev branch clone "${branch}".`),
    body(''),
    ...formatList('changed', diff.changed),
    ...formatList('only in working tree', diff.added),
    ...formatList('only in branch clone', diff.removed),
    body(''),
    body(`Fix:     ${pc.bold('npx canopycms sync push')}`),
    body(pc.dim("Silence: set dev.contentSync: 'off' in your Canopy config")),
    '',
  ].join('\n')
}

function formatResolvedNotice(branch: string): string {
  return [
    '',
    `${pc.bgGreen(pc.black(' CanopyCMS '))} ${pc.green(`working-tree content is back in sync with "${branch}"`)}`,
    '',
  ].join('\n')
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
  const strategy = operatingStrategy('dev')
  // Must pass the resolved contentRoot local above -- getContentRoot has no
  // default of its own (by design: a default here is what let this watcher
  // silently no-op for a non-default contentRoot before this fix).
  const workingTreeContentDir = strategy.getContentRoot(contentRoot, sourceRoot)
  const warn = options.warn ?? ((message: string) => console.warn(message))

  // Nothing to watch if the working tree has no content directory (e.g. unit-test configs).
  if (!fsSync.existsSync(workingTreeContentDir)) return noop

  // Resolve the branch fresh each check: the dev server silently follows git-HEAD switches
  // (services.refreshActiveBranch reassigns config.defaultActiveBranch), so the comparison target
  // must track whatever branch is currently being served. An explicit options.branch pins it.
  const resolveBranch = () =>
    options.branch ??
    services.config.defaultActiveBranch ??
    services.config.defaultBaseBranch ??
    'main'

  const registry = watcherRegistry()
  let state = registry.get(workingTreeContentDir)
  if (!state) {
    state = { dispose: null, lastMessage: null, reportedDivergence: false }
    registry.set(workingTreeContentDir, state)
  }
  const watcherState = state
  // Dispose any prior watcher for this dir (HMR re-start) before creating a new one. The registry
  // ENTRY deliberately survives, carrying lastMessage/reportedDivergence into the new watcher.
  watcherState.dispose?.()

  /**
   * Emit `message` unless it is verbatim what was emitted last for this directory. Covers the
   * divergence block, the resolved notice and the error paths alike: in every case a repeat means
   * "the condition is unchanged", which the reader already knows.
   */
  const reportOnce = (message: string): void => {
    if (watcherState.lastMessage === message) return
    watcherState.lastMessage = message
    warn(message)
  }

  let running = false
  let pending = false
  const check = async (): Promise<void> => {
    if (running) {
      pending = true
      return
    }
    running = true
    try {
      const branch = resolveBranch()
      const branchContentDir = path.join(
        strategy.getContentBranchRoot(branch, sourceRoot),
        contentRoot,
      )
      // No branch clone yet (e.g. before the first editor/dev request created it) -> nothing to
      // compare. Deliberately leaves reportedDivergence alone: "cannot tell" is not "resolved".
      if (!fsSync.existsSync(branchContentDir)) return
      const diff = await diffContentTrees(workingTreeContentDir, branchContentDir)
      if (isContentTreeDiffEmpty(diff)) {
        // Close the loop: a condition that was announced needs its retraction announced too, or the
        // reader is left believing the dev server is still serving stale content.
        if (watcherState.reportedDivergence) {
          watcherState.reportedDivergence = false
          reportOnce(formatResolvedNotice(branch))
        }
        return
      }
      // Set BEFORE reporting so a deduped repeat still leaves the condition marked as outstanding.
      watcherState.reportedDivergence = true
      reportOnce(formatDivergenceWarning(branch, diff))
    } catch (err) {
      reportOnce(`CanopyCMS: dev content-sync check failed: ${getErrorMessage(err)}`)
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
  // Handle watcher errors (e.g. inotify ENOSPC/EMFILE) so an unhandled 'error' event can't crash dev.
  watcher.on('error', (err) =>
    reportOnce(`CanopyCMS: dev content-sync watcher error: ${getErrorMessage(err)}`),
  )

  // Initial divergence check at startup.
  void check()

  const dispose = () => {
    void watcher.close()
    if (watcherState.dispose === dispose) watcherState.dispose = null
  }
  watcherState.dispose = dispose
  return dispose
}
