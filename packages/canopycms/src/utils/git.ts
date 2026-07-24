import { simpleGit } from 'simple-git'

import type { OperatingMode } from '../operating-mode'

// Matches scheme://... URLs (http, https, ssh, git — case-insensitive).
const NETWORK_SCHEME_PATTERN = /^(https?|ssh|git):\/\//i
// Matches git's "transport helper" syntax, e.g. `ext::sh -c ...` or `fd::7`.
// Any `scheme::` prefix hands the URL to `git-remote-<scheme>`, which can run
// arbitrary commands — always treat it as network/untrusted.
const TRANSPORT_HELPER_PATTERN = /^[a-z][a-z0-9+.-]*::/i
// A leading `-` means the "URL" would be parsed as a command-line option by
// git (e.g. `--upload-pack=/evil`) — argument injection, not a real remote.
const LEADING_OPTION_PATTERN = /^-/
// Windows drive paths (`C:\...`, `C:/...`) are the one local form that
// contains a colon before any slash; everything else with a colon before the
// first slash is scp-like remote syntax, e.g. `git@github.com:owner/repo.git`
// or the bare `github.com:owner/repo.git` (no `@` required — git still
// treats `host:path` as ssh).
const WINDOWS_DRIVE_PATTERN = /^[a-zA-Z]:[\\/]/
const COLON_BEFORE_SLASH_PATTERN = /^[^/\\\s]+:/

/**
 * Whether a git remote URL points at a network location — http(s)://,
 * ssh://, git://, scp-like `[user@]host:path`, a transport-helper `scheme::`
 * form, or a leading-`-` value git would parse as a command-line option —
 * rather than a local filesystem path.
 *
 * `file://` URLs and plain filesystem paths are LOCAL — this is the
 * distinction GitManager's prod-mode network-remote guard relies on (see
 * `resolveRemoteUrl`): the intended prod topology only ever resolves a local
 * path (an auto-detected/auto-initialized `remote.git`), so anything network
 * flowing in via an explicit param, config, or env var is almost always a
 * misconfiguration in prod. Because the guard's job is catching prod
 * misconfig (not being a strict URL parser), this classifier treats anything
 * git could interpret as a network transport, a transport helper, or a
 * command-line option as "network". The one local carve-out beyond `file://`
 * is a Windows drive path (`C:\...` / `C:/...`), which replaces the old
 * `@`-required heuristic for scp-like syntax.
 */
export function isNetworkRemoteUrl(url: string): boolean {
  if (/^file:\/\//i.test(url)) return false
  if (NETWORK_SCHEME_PATTERN.test(url)) return true
  if (TRANSPORT_HELPER_PATTERN.test(url)) return true
  if (LEADING_OPTION_PATTERN.test(url)) return true
  if (WINDOWS_DRIVE_PATTERN.test(url)) return false
  return COLON_BEFORE_SLASH_PATTERN.test(url)
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
