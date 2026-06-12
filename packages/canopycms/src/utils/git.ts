import { simpleGit } from 'simple-git'

import type { OperatingMode } from '../operating-mode'

/**
 * Detect the current HEAD branch name for a given repository root.
 * Returns the branch name, or the provided fallback (default 'main')
 * if detection fails or HEAD is detached.
 */
export async function detectHeadBranch(
  repoRoot: string,
  fallback: string = 'main',
): Promise<string> {
  try {
    const git = simpleGit({ baseDir: repoRoot })
    const head = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim()
    return head && head !== 'HEAD' ? head : fallback
  } catch {
    return fallback
  }
}

/**
 * Resolve the base branch — the fork point for CMS editing branches and the
 * branch used to seed workspace clones.
 *
 * This is the single definition of base-branch behavior (see ARCHITECTURE.md
 * "Branch Identity"):
 * - An explicitly configured `defaultBaseBranch` always wins, in both modes.
 * - In dev mode it is detected from the current git HEAD, so workspaces fork
 *   from the branch the developer has checked out.
 * - Otherwise it is 'main'.
 *
 * Static deployments never reach git operations, so callers in static paths
 * must short-circuit before calling this (see createCanopyServices).
 */
export async function resolveBaseBranch(options: {
  defaultBaseBranch?: string
  mode: OperatingMode
  /** Repo root used for dev-mode HEAD detection. Defaults to process.cwd(). */
  detectFrom?: string
}): Promise<string> {
  if (options.defaultBaseBranch) return options.defaultBaseBranch
  if (options.mode === 'dev') {
    return detectHeadBranch(options.detectFrom ?? process.cwd())
  }
  return 'main'
}
