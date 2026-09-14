import fs from 'node:fs/promises'
import path from 'node:path'
import type { Stats } from 'node:fs'
import { simpleGit } from 'simple-git'

import type { OperatingMode } from '../operating-mode'

const NETWORK_SCHEME_PATTERN = /^(https?|ssh|git):\/\//i
// git's "transport helper" syntax (`ext::sh -c ...`, `fd::7`): any `scheme::` prefix hands the
// URL to `git-remote-<scheme>`, which can run arbitrary commands — always network/untrusted.
const TRANSPORT_HELPER_PATTERN = /^[a-z][a-z0-9+.-]*::/i
// A leading `-` makes git parse the "URL" as a command-line option (`--upload-pack=/evil`) —
// argument injection, not a real remote.
const LEADING_OPTION_PATTERN = /^-/
// Windows drive paths (`C:\...`, `C:/...`) are the one local form carrying a colon before any
// slash; everything else with a colon before the first slash is scp-like remote syntax
// (`git@github.com:owner/repo.git`, or bare `github.com:owner/repo.git` — git treats `host:path`
// as ssh with no `@` required).
const WINDOWS_DRIVE_PATTERN = /^[a-zA-Z]:[\\/]/
const COLON_BEFORE_SLASH_PATTERN = /^[^/\\\s]+:/

/**
 * Whether a git remote URL points at a network location rather than a local filesystem path. Only
 * `file://` URLs, plain filesystem paths and Windows drive paths are LOCAL; the patterns above
 * enumerate the network forms.
 *
 * The distinction GitManager's prod-mode network-remote guard relies on (see `resolveRemoteUrl`):
 * the intended prod topology only ever resolves a local path (an auto-detected/auto-initialized
 * `remote.git`), so anything network arriving via an explicit param, config, or env var is almost
 * always a prod misconfiguration. Catching that is the job, not being a strict URL parser, so
 * anything git could read as a network transport, a transport helper, or a command-line option
 * counts as "network".
 */
export function isNetworkRemoteUrl(url: string): boolean {
  if (/^file:\/\//i.test(url)) return false
  if (NETWORK_SCHEME_PATTERN.test(url)) return true
  if (TRANSPORT_HELPER_PATTERN.test(url)) return true
  if (LEADING_OPTION_PATTERN.test(url)) return true
  if (WINDOWS_DRIVE_PATTERN.test(url)) return false
  return COLON_BEFORE_SLASH_PATTERN.test(url)
}

// git's per-ref push-status summary marking a ref as rejected. Present verbatim in BOTH output
// shapes CanopyCMS's push sites produce -- the plain CLI form and the `--porcelain` form
// simple-git's `.push()` requests -- because `--porcelain` changes only the summary's leading
// fields, not this trailing bracket text.
const REJECTED_MARKER = '[rejected]'
// git's two names for the SAME condition: `non-fast-forward` when the pusher's remote-tracking ref
// is present but stale, `fetch first` when no local knowledge of the remote ref exists at all.
// Both mean the remote has commits this side does not, so the identical push can never succeed
// until the caller fetches and integrates (or picks a different branch name).
const NON_FAST_FORWARD_REASONS = ['non-fast-forward', 'fetch first']
// git prints this stderr hint immediately after a rejected push, `--porcelain` or not -- a second,
// independent signal for the same condition.
const REJECTION_HINT = 'Updates were rejected because'

/**
 * Whether a git push failure message is git's non-fast-forward rejection -- the remote has
 * diverged, so retrying the IDENTICAL push can never succeed. In CanopyCMS that means two
 * deployments sharing one GitHub repo and picking the same content-branch name, or someone pushing
 * directly to GitHub.
 *
 * Deliberately narrow: ordinary transient push failures -- network drops, auth/permission denial,
 * lock contention -- must keep retrying with backoff (worker/task-runner.ts's
 * `isPermanentTaskFailure` treats git failures as transient precisely so they do). Only this
 * structurally-unretryable shape fails fast (worker) or returns 409 (API).
 *
 * Matches git's literal English rejection text, which is gettext-translated: callers MUST run the
 * git command with a locale-pinning env (`gitChildEnv` in `../git-manager.ts`), or an ambient
 * LANG/LC_ALL silently turns this into a permanent no-op.
 */
export function isNonFastForwardRejection(message: string): boolean {
  const hasNonFastForwardRejection =
    message.includes(REJECTED_MARKER) &&
    NON_FAST_FORWARD_REASONS.some((reason) => message.includes(reason))
  return hasNonFastForwardRejection || message.includes(REJECTION_HINT)
}

// git's reason text when a `--force-with-lease=<ref>:<sha>` push is refused because the remote is
// not at `<sha>`.
const STALE_LEASE_REASON = 'stale info'

/**
 * Whether a git push failure message is a refused `--force-with-lease` -- the remote ref is NOT at
 * the commit the pusher expected, so the forced update was declined and nothing overwritten.
 *
 * A SEPARATE predicate from `isNonFastForwardRejection` because git's output for the two is
 * disjoint: a refused lease prints `(stale info)` and emits NEITHER `non-fast-forward`/`fetch
 * first` NOR the `Updates were rejected because` hint. Without it every lease refusal is
 * classified transient and retried -- identical, guaranteed-to-fail force attempts -- instead of
 * surfacing as the permanent, human-actionable state it is. Same locale caveat as above.
 */
export function isStaleLeaseRejection(message: string): boolean {
  return message.includes(REJECTED_MARKER) && message.includes(STALE_LEASE_REASON)
}

// git's message when `git fetch <remote> <branch>` names a ref the remote does not have. Both
// spellings occur: modern git prints the lowercase form, older versions and some transports
// capitalize it.
const MISSING_REMOTE_REF_REASONS = ["couldn't find remote ref", "Couldn't find remote ref"]

/**
 * Whether a `git fetch <remote> <branch>` failure is specifically "that ref doesn't exist on the
 * remote" -- the ONLY benign fetch outcome, meaning the branch has never been pushed.
 *
 * Narrow on purpose, and the narrowness is the point: a bare `catch` around the fetch classifies
 * EVERY failure -- unreachable remote, auth denial, permission error on the workspace, corrupt
 * object store -- as "nothing to pull", which callers then log as normal and proceed past.
 * Anything this does not recognize must reach the caller as the genuine error it is. Same locale
 * caveat as the predicates above.
 */
export function isMissingRemoteRefFailure(message: string): boolean {
  return MISSING_REMOTE_REF_REASONS.some((reason) => message.includes(reason))
}

/**
 * Resolve a repository's git directory from its working-tree root, handling both layouts: a real
 * `.git` directory, and a `.git` FILE holding a `gitdir: <path>` pointer (linked worktrees,
 * submodules). Deliberately fs-only rather than `git rev-parse --git-dir`: the callers are a
 * per-branch sync loop and an admin-facing health scan that already walk every branch directory,
 * and neither should pay a subprocess per branch just to find a path.
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
 * Whether a repository has an INTERRUPTED rebase on disk — the `rebase-merge` (interactive/merge
 * backend) or `rebase-apply` (am backend) state directory git leaves when a rebase stops for
 * conflicts or the process dies mid-way. Invisible to every other check the worker makes: a clone
 * left mid-rebase reports uncommitted changes, so the sync loop's dirty check skips it as
 * `skippedDirty` on every cycle forever, and `branch-health` sees valid branch.json and scans it
 * as healthy. Nothing self-heals without it.
 *
 * Never throws — a missing or unreadable repo is reported as "no rebase", the safe direction for
 * both callers (the worker only uses a `true` to justify an abort it holds the content-write lock
 * for).
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
 * The repository's current HEAD branch name, or `fallback` when detection fails or HEAD is
 * detached.
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
 * Resolve the base branch — the fork point for CMS editing branches and the branch workspace
 * clones are seeded from. The single definition of base-branch behavior (see ARCHITECTURE.md
 * "Branch Identity"): a configured `defaultBaseBranch` always wins in both modes; dev mode
 * otherwise detects the current git HEAD, so workspaces fork from the developer's checked-out
 * branch; otherwise 'main'.
 *
 * Static deployments never reach git operations, so callers on static paths must short-circuit
 * before calling this (see createCanopyServices).
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
