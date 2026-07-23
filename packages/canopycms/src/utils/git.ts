import { simpleGit } from 'simple-git'

import type { OperatingMode } from '../operating-mode'

// Matches scheme://... URLs (http, https, ssh, git — case-insensitive).
const NETWORK_SCHEME_PATTERN = /^(https?|ssh|git):\/\//i
// Matches scp-like remote syntax, e.g. `git@github.com:owner/repo.git`.
// Requires an `@` before the colon so plain Windows-style paths (`C:\path`)
// and bare filesystem paths never match.
const SCP_LIKE_PATTERN = /^[^/\s]+@[^/\s]+:/

/**
 * Whether a git remote URL points at a network location (http(s)://, ssh://,
 * git://, or scp-like `user@host:path`) rather than a local filesystem path.
 *
 * `file://` URLs and plain filesystem paths are LOCAL — this is the
 * distinction GitManager's prod-mode network-remote guard relies on (see
 * `resolveRemoteUrl`): the intended prod topology only ever resolves a local
 * path (an auto-detected/auto-initialized `remote.git`), so anything network
 * flowing in via an explicit param, config, or env var is almost always a
 * misconfiguration in prod.
 */
export function isNetworkRemoteUrl(url: string): boolean {
  if (/^file:\/\//i.test(url)) return false
  if (NETWORK_SCHEME_PATTERN.test(url)) return true
  return SCP_LIKE_PATTERN.test(url)
}

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
