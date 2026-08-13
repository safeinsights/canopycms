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

// Matches git's per-ref push-status summary line marking a ref as rejected.
// Present verbatim in BOTH output shapes CanopyCMS's push call sites produce:
// the plain CLI form (`GitManager.push()`'s `.raw(['push', ...])`, e.g.
// ` ! [rejected]        branch -> branch (non-fast-forward)`) and the
// machine-readable `--porcelain` form simple-git's `.push()` wrapper requests
// (`CmsWorker.pushBranchToGitHub`/`pushSettingsBranches`, e.g.
// `!\trefs/heads/branch:refs/heads/branch\t[rejected] (non-fast-forward)`) --
// `--porcelain` only changes the per-ref summary's leading fields, not this
// trailing human-readable bracket text.
const REJECTED_MARKER = '[rejected]'
// git's two names for the SAME underlying condition: `non-fast-forward` fires
// when the pusher's own remote-tracking ref is present but stale;
// `fetch first` fires when no local knowledge of the remote ref exists at all
// (e.g. it was never fetched). Both mean the remote has commits this side
// doesn't have -- retrying the identical push can never succeed until the
// caller fetches and integrates (or picks a different branch name).
const NON_FAST_FORWARD_REASONS = ['non-fast-forward', 'fetch first']
// git always prints this stderr hint immediately after a rejected push,
// regardless of --porcelain (porcelain only affects the machine-readable
// summary line, not the human hint text that follows it) -- a second,
// independent signal for the same condition.
const REJECTION_HINT = 'Updates were rejected because'

/**
 * Whether a git push failure message is git's non-fast-forward rejection --
 * the remote has diverged (moved ahead with commits this side never fetched),
 * so retrying the IDENTICAL push can never succeed. In CanopyCMS this is the
 * signature of two CanopyCMS deployments sharing one GitHub repo and picking
 * the same content-branch name, or someone pushing directly to GitHub.
 *
 * Deliberately narrow: ordinary transient push failures -- network drops,
 * auth/permission denial, lock contention -- must keep retrying with backoff
 * (see worker/cms-worker.ts's `isPermanentTaskFailure`, which treats git
 * failures as transient precisely so those cases still get retried). Only
 * this specific, structurally-unretryable shape should fail fast (worker) or
 * return 409 (API) instead.
 *
 * Matches git's literal (English) rejection text, which is gettext-
 * translated -- callers MUST run the underlying git command with a
 * locale-pinning env (see `gitChildEnv` in `../git-manager.ts`) or an ambient
 * LANG/LC_ALL could silently turn this into a permanent no-op.
 */
export function isNonFastForwardRejection(message: string): boolean {
  const hasNonFastForwardRejection =
    message.includes(REJECTED_MARKER) &&
    NON_FAST_FORWARD_REASONS.some((reason) => message.includes(reason))
  return hasNonFastForwardRejection || message.includes(REJECTION_HINT)
}

// git's reason text when a `--force-with-lease=<ref>:<sha>` push is refused
// because the remote is not at `<sha>`.
const STALE_LEASE_REASON = 'stale info'

/**
 * Whether a git push failure message is a refused `--force-with-lease` --
 * the remote ref is NOT at the commit the pusher expected, so the forced
 * update was declined and nothing was overwritten.
 *
 * A SEPARATE predicate from `isNonFastForwardRejection` because git's output
 * for the two is disjoint: a refused lease prints
 * ` ! [rejected]        branch -> branch (stale info)` and, unlike an
 * ordinary rejection, emits NEITHER `non-fast-forward`/`fetch first` NOR the
 * `Updates were rejected because` hint. Without this predicate every lease
 * refusal would be classified transient and retried -- three identical,
 * guaranteed-to-fail force attempts -- instead of surfacing as the permanent,
 * human-actionable state it is.
 *
 * Same locale caveat as above: the reason text is gettext-translated, so
 * callers MUST pin the locale (`gitChildEnv`/`gitNetworkChildEnv`).
 */
export function isStaleLeaseRejection(message: string): boolean {
  return message.includes(REJECTED_MARKER) && message.includes(STALE_LEASE_REASON)
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
