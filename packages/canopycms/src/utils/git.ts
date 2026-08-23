import fs from 'node:fs/promises'
import path from 'node:path'
import type { Stats } from 'node:fs'
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
 * (see worker/task-runner.ts's `isPermanentTaskFailure`, which treats git
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

// git's message when `git fetch <remote> <branch>` names a ref the remote does
// not have. Both spellings occur: modern git prints the lowercase form, older
// versions and some transports capitalize it.
const MISSING_REMOTE_REF_REASONS = ["couldn't find remote ref", "Couldn't find remote ref"]

/**
 * Whether a `git fetch <remote> <branch>` failure is specifically "that ref
 * doesn't exist on the remote" -- the ONLY benign fetch outcome, meaning the
 * branch has never been pushed.
 *
 * Narrow on purpose, and the narrowness is the whole point. This predicate
 * exists because a bare `catch` around the fetch classified EVERY failure --
 * unreachable remote, auth denial, permission error on the workspace, corrupt
 * object store -- as "nothing to pull", which callers then logged as normal
 * and proceeded past. Anything this does not recognize must reach the caller
 * as the genuine error it is.
 *
 * Same locale caveat as the predicates above: the text is gettext-translated,
 * so callers MUST run git with a locale-pinning env (`gitChildEnv`).
 */
export function isMissingRemoteRefFailure(message: string): boolean {
  return MISSING_REMOTE_REF_REASONS.some((reason) => message.includes(reason))
}

/**
 * Resolve a repository's git directory from its working-tree root, handling
 * both layouts: a real `.git` directory, and a `.git` FILE containing a
 * `gitdir: <path>` pointer (linked worktrees, submodules).
 *
 * Deliberately fs-only rather than `git rev-parse --git-dir`: the callers are
 * a per-branch sync loop and an admin-facing health scan that already walk
 * every branch directory, and neither should pay a subprocess per branch just
 * to find a path.
 */
async function resolveGitDir(repoPath: string): Promise<string | null> {
  const dotGit = path.join(repoPath, '.git')
  let stat: Stats
  try {
    stat = await fs.stat(dotGit)
  } catch {
    return null
  }
  if (stat.isDirectory()) return dotGit
  try {
    const pointer = await fs.readFile(dotGit, 'utf-8')
    const match = /^gitdir:\s*(.+)$/m.exec(pointer)
    if (!match) return null
    const target = match[1].trim()
    return path.isAbsolute(target) ? target : path.resolve(repoPath, target)
  } catch {
    return null
  }
}

/**
 * Whether a repository has an INTERRUPTED rebase on disk — the `rebase-merge`
 * (interactive/merge backend) or `rebase-apply` (am backend) state directory
 * git leaves behind when a rebase stops for conflicts or the process dies
 * mid-way.
 *
 * This state is invisible to every other check the worker makes: a clone left
 * mid-rebase reports uncommitted changes, so the sync loop's dirty check skips
 * it as `skippedDirty` on every cycle forever, and `branch-health` sees valid
 * branch.json and scans it as healthy. Nothing self-heals, and recovery
 * previously meant an operator running `git rebase --abort` on EFS by hand.
 *
 * Never throws — a missing or unreadable repo is reported as "no rebase",
 * which is the safe direction for both callers (the worker only ever uses a
 * `true` to justify an abort it holds the content-write lock for).
 */
export async function isRebaseInProgress(repoPath: string): Promise<boolean> {
  const gitDir = await resolveGitDir(repoPath)
  if (!gitDir) return false
  const results = await Promise.all(
    ['rebase-merge', 'rebase-apply'].map((dir) =>
      fs
        .stat(path.join(gitDir, dir))
        .then(() => true)
        .catch(() => false),
    ),
  )
  return results.some(Boolean)
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
