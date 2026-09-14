/**
 * Git operations for branch workspaces.
 *
 * `status()` divides two halves that share only a class name: above it,
 * `static` workspace PROVISIONING holding no instance state; below it, INSTANCE
 * methods on one already-provisioned workspace, needing
 * `repoPath`/`baseBranch`/`remote`.
 *
 * Every git invocation is argv-based with `--end-of-options`, and `gitChildEnv`
 * forces `LC_ALL=C`/`LANG=C` so git's own message text stays English — several
 * callers classify errors by matching it (see `utils/git.ts`'s
 * `isNonFastForwardRejection`). Do not remove that.
 *
 * Module map: ./AGENTS.md. Locking rules: ../../../docs/concurrency.md.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  simpleGit,
  type ConfigListSummary,
  type SimpleGit,
  type SimpleGitOptions,
  type StatusResult,
} from 'simple-git'

import { invalidateContentIndexesForRoot } from './content-index-registry'
import { invalidateBranchContentCaches } from './content-index-generation'
import type { OperatingMode } from './operating-mode'
import { createDebugLogger } from './utils/debug'
import { getErrorMessage, isNotFoundError } from './utils/error'
import { isMissingRemoteRefFailure, isNetworkRemoteUrl, resolveBaseBranch } from './utils/git'
import { acquireProvisioningLock } from './utils/provisioning-lock'

const log = createDebugLogger({ prefix: 'GitManager' })

/**
 * Child environment for spawned git processes: a deterministic ALLOWLIST of
 * process basics plus the author/tracing families. simple-git's `.env()`
 * REPLACES the child env entirely, and a spawn that loses the runtime's git
 * variables fails with "dubious ownership" against uid-mismatched EFS clones;
 * spreading all of process.env instead trips simple-git's unsafe-variable
 * blocklist on hosts that set GIT_EDITOR/GIT_SSH_COMMAND.
 *
 * GIT_CONFIG_* stays out: simple-git hard-blocks env-based git config
 * (allowUnsafeConfigEnvCount) since it can inject arbitrary settings. Host
 * config such as the safe.directory workaround for uid-mismatched EFS clones
 * belongs in the image's SYSTEM gitconfig — Dockerfile.cms.template's
 * `git config --system` line.
 */
const GIT_ENV_PASSTHROUGH =
  /^(PATH|HOME|USER|LANG|LC_[A-Z]+|TZ|TMPDIR|GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)|GIT_TERMINAL_PROMPT|GIT_TRACE[0-9A-Z_]*)$/
/**
 * Forces the "C" locale on every `gitChildEnv` caller. Push-rejection
 * classification (`utils/git.ts`'s `isNonFastForwardRejection`) matches git's
 * literal English rejection strings (`[rejected]`, `non-fast-forward`, the
 * "Updates were rejected because" hint), all of them gettext-translated: a host
 * that sets a LANG/LC_* of its own would silently turn that classifier into a
 * permanent no-op. LC_ALL outranks LANG and every other LC_* category in
 * gettext's resolution order, so both are pinned. Applied AFTER the passthrough
 * loop so it beats any LANG/LC_* carried through from process.env, and BEFORE
 * `overrides` so an explicit override still wins.
 */
const FORCE_C_LOCALE = { LC_ALL: 'C', LANG: 'C' }
export function gitChildEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && GIT_ENV_PASSTHROUGH.test(key)) env[key] = value
  }
  return { ...env, ...FORCE_C_LOCALE, ...overrides }
}

/**
 * Child env for git commands that talk to a NETWORK remote (the worker's
 * GitHub fetch/push).
 *
 * Deliberately NOT `gitChildEnv`: that allowlist is for LOCAL operations and
 * drops `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`/`GIT_SSL_*`/`GIT_SSH_COMMAND`,
 * which on the GitHub calls would break every adopter who reaches GitHub
 * through a corporate proxy or a custom CA bundle.
 *
 * So this inherits the ambient environment and forces only the locale, which
 * is all the push-rejection classifier (isNonFastForwardRejection in
 * utils/git.ts) needs: git's `[rejected] … (non-fast-forward)` text is
 * gettext-translated, and a non-English host would silently turn that
 * classifier into a no-op.
 *
 * `GIT_SSH_COMMAND` stays out even though it is a "network" variable:
 * simple-git hard-blocks it (`allowUnsafeSshCommand`), and `buildGitHubUrl()`
 * produces an `https://` URL, so the worker never reaches GitHub over SSH.
 */
const GIT_NETWORK_ENV_PASSTHROUGH =
  /^((HTTPS?|ALL)_PROXY|(https?|all)_proxy|NO_PROXY|no_proxy|GIT_SSL_(CAINFO|CAPATH|NO_VERIFY|VERSION)|CURL_CA_BUNDLE|SSL_CERT_(FILE|DIR)|REQUESTS_CA_BUNDLE|NODE_EXTRA_CA_CERTS)$/

export function gitNetworkChildEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (GIT_ENV_PASSTHROUGH.test(key) || GIT_NETWORK_ENV_PASSTHROUGH.test(key)) env[key] = value
  }
  return { ...env, ...FORCE_C_LOCALE }
}

// In-memory lock to prevent concurrent remote.git initialization
const remoteInitLocks = new Map<string, Promise<void>>()

/**
 * Remote-tracking namespace that `syncGit()`'s GitHub fetch lands refs in
 * (`+refs/heads/*:${GITHUB_TRACKING_REF_PREFIX}*`), instead of writing
 * directly into `refs/heads/*`.
 *
 * `remote.git`'s `refs/heads/*` is NOT a throwaway mirror: it is the
 * deployment's local origin. `GitManager.push()` writes editor work into it,
 * branch-workspace clones are cloned FROM it, and the worker pushes it on to
 * GitHub. A fetch that force-writes GitHub's refs straight into `refs/heads/*`
 * therefore destroys work that reached `remote.git` but not GitHub yet: with
 * `--prune` a not-yet-pushed branch is deleted outright, and a branch where
 * `remote.git` is ahead is force-rewound to GitHub's older tip, so the worker's
 * next push no-ops and the editor's commit never arrives while the branch still
 * reports `synced`. Confining `+`/`--prune` to this namespace keeps them off
 * those local heads; `reconcileTrackedBranches()` (worker/git-sync.ts) is what
 * subsequently, and non-destructively, brings `refs/heads/*` toward what is
 * tracked here.
 */
export const GITHUB_TRACKING_REF_PREFIX = 'refs/remotes/github/'

/**
 * Add a pattern to a repo's .git/info/exclude (a per-repository gitignore that
 * never gets committed) so runtime metadata like .canopy-meta/ can't be staged
 * by broad `git add` calls. Idempotent. Standalone so workspace-creating code
 * that doesn't hold a GitManager (e.g. CLI sync auto-create) can use it too.
 */
export async function ensureGitExcludePattern(repoPath: string, pattern: string): Promise<void> {
  const excludePath = path.join(repoPath, '.git', 'info', 'exclude')

  await fs.mkdir(path.dirname(excludePath), { recursive: true })

  let content = ''
  try {
    content = await fs.readFile(excludePath, 'utf-8')
  } catch (err: unknown) {
    if (!isNotFoundError(err)) throw err
  }

  const lines = content.split('\n')
  if (lines.some((line) => line.trim() === pattern)) {
    log.debug('git', 'Pattern already in .git/info/exclude', { pattern })
    return
  }

  const needsLeadingNewline = content.length > 0 && !content.endsWith('\n')
  const newContent = content + (needsLeadingNewline ? '\n' : '') + pattern + '\n'

  await fs.writeFile(excludePath, newContent, 'utf-8')
  log.debug('git', 'Added pattern to .git/info/exclude', { pattern })
}

export interface GitManagerOptions {
  repoPath: string
  baseBranch?: string
  remote?: string
  /**
   * Skip writing the on-disk content-index generation marker after working-tree
   * mutations. Set for settings workspaces: no ContentStore is ever rooted at
   * one, and the marker file would sit untracked in the settings repo.
   * In-process index invalidation still runs (it is free and harmless).
   */
  skipIndexMarker?: boolean
}

export type GitStatus = Pick<StatusResult, 'files' | 'ahead' | 'behind' | 'current' | 'tracking'>

/** @internal Exported for tests. */
export class GitConflictError extends Error {
  constructor(public readonly conflictedFiles: string[]) {
    super(`Git conflict in ${conflictedFiles.length} file(s): ${conflictedFiles.join(', ')}`)
    this.name = 'GitConflictError'
  }
}

/**
 * The branch has no ref on the remote yet, so there is nothing to pull.
 *
 * The ONLY benign outcome of `pullCurrentBranch`: callers that shrug it off (a
 * settings branch's first-ever commit — services.ts `commitToSettingsBranch`)
 * must not shrug off anything else with it. A merge that cannot proceed, a
 * corrupt workspace and an unreachable remote are genuine errors to surface.
 */
export class GitRemoteRefMissingError extends Error {
  constructor(
    public readonly branch: string,
    public readonly remote: string,
    /**
     * The underlying git failure. A separate field rather than `Error.cause`:
     * the build targets ES2021, whose `Error` constructor takes no options bag.
     */
    public readonly gitError?: unknown,
  ) {
    super(`Remote '${remote}' has no ref for branch '${branch}' yet`)
    this.name = 'GitRemoteRefMissingError'
  }
}

export interface ResolveRemoteUrlOptions {
  mode: OperatingMode
  remoteUrl?: string
  defaultRemoteUrl?: string
  baseBranch: string
  sourceRoot?: string
  /**
   * Escape hatch: allow a resolved NETWORK remote URL (from remoteUrl/
   * defaultRemoteUrl/the strategy env var) in prod mode. See CanopyConfig's
   * `allowNetworkRemoteInProd` doc comment. Has no effect in dev mode.
   */
  allowNetworkRemoteInProd?: boolean
}

export interface InitializeWorkspaceOptions {
  workspacePath: string
  branchName: string
  mode: OperatingMode
  baseBranch?: string
  sourceRoot?: string
  defaultRemoteUrl?: string
  remoteUrl?: string
  remoteName?: string
  /**
   * Escape hatch: allow a resolved NETWORK remote URL in prod mode. Threaded
   * through to `resolveRemoteUrl` — see its option of the same name and
   * CanopyConfig's `allowNetworkRemoteInProd` doc comment.
   */
  allowNetworkRemoteInProd?: boolean
  branchType: 'content' | 'orphan' // Determines checkout vs createOrphan
  /** Git author name for internal commits (e.g., orphan branch init). */
  gitBotAuthorName: string
  /** Git author email for internal commits (e.g., orphan branch init). */
  gitBotAuthorEmail: string
  /**
   * Pattern added to `.git/info/exclude` so runtime metadata (e.g.
   * `.canopy-meta/`) never enters the workspace's git history. Content branches
   * only; settings workspaces commit by explicit path and don't need it.
   */
  gitExcludePattern?: string
}

export class GitManager {
  private readonly git: SimpleGit
  private readonly repoPath: string
  private readonly baseBranch: string
  private readonly remote: string
  private readonly skipIndexMarker: boolean

  constructor(options: GitManagerOptions, gitOptions?: Partial<SimpleGitOptions>) {
    this.repoPath = path.resolve(options.repoPath)
    this.baseBranch = options.baseBranch ?? 'main'
    this.remote = options.remote ?? 'origin'
    this.skipIndexMarker = options.skipIndexMarker ?? false
    this.git = simpleGit({ baseDir: this.repoPath, ...gitOptions })
    // `this.git` is for LOCAL working-tree ops: in the intended prod topology
    // `origin` resolves to a local path (an auto-detected/initialized
    // `remote.git`), so its env is gitChildEnv's allowlist, which drops
    // HTTPS_PROXY/GIT_SSL_*/GIT_SSH_COMMAND — network git I/O uses
    // gitNetworkChildEnv instead. Under the `allowNetworkRemoteInProd` escape
    // hatch `this.remote` CAN be a network URL, and these calls do hit it with
    // that restricted env: a known limitation of the escape hatch, tracked in
    // .claude/future-tasks/network-escape-hatch-git-env.md.
    //
    // GIT_CEILING_DIRECTORIES stops git traversing above repoPath to a parent
    // .git: a corrupt or missing workspace .git must fail, never silently
    // operate on the host repo above.
    this.git.env(gitChildEnv({ GIT_CEILING_DIRECTORIES: path.dirname(this.repoPath) }))
  }

  static async cloneRepo(
    remoteUrl: string,
    targetPath: string,
    baseBranch = 'main',
  ): Promise<void> {
    log.debug('git', 'Cloning repository', {
      remoteUrl,
      targetPath,
      baseBranch,
    })
    const git = simpleGit()
    await git.clone(remoteUrl, targetPath, ['--branch', baseBranch, '--single-branch'])
    log.debug('git', 'Clone complete')
  }

  /**
   * Initializes a local bare git repository to simulate a remote for dev mode,
   * seeded with the current state of baseBranch. Idempotent: an existing remote
   * is never recreated, and a branch already in it is never refreshed from the
   * source repo — the CMS pushes editor state into this remote, so a refresh
   * would clobber it. A baseBranch the remote lacks is pushed on demand.
   *
   * @throws Error if not a git repo, no commits, or baseBranch doesn't exist
   */
  static async ensureLocalSimulatedRemote(options: {
    remotePath: string
    sourcePath: string
    baseBranch: string
    subdirectory?: string
  }): Promise<void> {
    // Serialize per remote path so concurrent requests cannot both initialize
    // the same remote. After waiting, still proceed: the finished
    // initialization may have seeded a different baseBranch than this caller
    // needs.
    const existingLock = remoteInitLocks.get(options.remotePath)
    if (existingLock) {
      log.debug('git', 'Waiting for existing remote initialization', {
        remotePath: options.remotePath,
      })
      await existingLock
    }

    const lockPromise = log.timed('git', 'ensureLocalSimulatedRemote', async () => {
      // The in-memory lock above only serializes within one process; a
      // cross-process lock keeps two processes provisioning the same workspace
      // root from both creating the bare remote ("cannot mkdir remote.git:
      // File exists"). Released in the finally below.
      let releaseLock: (() => Promise<void>) | undefined
      try {
        log.debug('git', 'Initializing local simulated remote', {
          remotePath: options.remotePath,
          baseBranch: options.baseBranch,
        })

        // Take the cross-process lock before checking/creating the bare remote.
        const remoteParent = path.dirname(options.remotePath)
        releaseLock = await acquireProvisioningLock(remoteParent, '.remote-init.lock')

        // Check if already exists — another process may have finished
        // provisioning while we waited for the lock.
        let remoteExists = false
        try {
          const stat = await fs.stat(options.remotePath)
          remoteExists = stat.isDirectory()
        } catch (err: unknown) {
          if (!isNotFoundError(err)) throw err
        }

        if (
          remoteExists &&
          (await GitManager.bareRemoteHasBranch(options.remotePath, options.baseBranch))
        ) {
          log.debug('git', 'Remote already has base branch, skipping')
          return
        }

        // Find the actual git root directory — the subdirectory snapshot path
        // (`<branch>:<subdirectory>`) is relative to the repository toplevel
        let gitRoot = options.sourcePath
        try {
          const sourceGit = simpleGit({ baseDir: options.sourcePath })
          const result = await sourceGit.raw(['rev-parse', '--show-toplevel'])
          gitRoot = result.trim()
        } catch {
          gitRoot = options.sourcePath
        }

        const sourceGit = simpleGit({ baseDir: gitRoot })

        try {
          await sourceGit.status()
        } catch {
          throw new Error(
            'Cannot initialize local simulated remote: current directory is not a git repository. ' +
              'Please initialize git or provide an explicit remoteUrl.',
          )
        }

        let hasCommits = false
        try {
          const log = await sourceGit.log(['-1'])
          hasCommits = log.total > 0
        } catch {
          // Log command fails if no commits exist
          hasCommits = false
        }

        if (!hasCommits) {
          throw new Error(
            'Cannot initialize local simulated remote: repository has no commits. ' +
              'Please make an initial commit or provide an explicit remoteUrl.',
          )
        }

        const branches = await sourceGit.branchLocal()
        if (!branches.all.includes(options.baseBranch)) {
          throw new Error(
            `Cannot initialize local simulated remote: base branch '${options.baseBranch}' does not exist locally. ` +
              `Please checkout '${options.baseBranch}' first or provide an explicit remoteUrl.`,
          )
        }

        if (remoteExists) {
          // Refresh path: the remote predates this base branch. Push just the
          // missing branch; existing branches are never touched.
          log.debug('git', 'Existing remote is missing base branch — pushing it from source', {
            remotePath: options.remotePath,
            baseBranch: options.baseBranch,
          })
        } else {
          // Create bare remote (parent dir already ensured above, under the lock)
          log.debug('git', 'Creating bare remote repository')
          await simpleGit().raw([
            'init',
            '--bare',
            `--initial-branch=${options.baseBranch}`,
            options.remotePath,
          ])
        }

        // Push baseBranch to remote (not current HEAD)
        await GitManager.pushBranchToLocalRemote({
          sourceGit,
          remotePath: options.remotePath,
          baseBranch: options.baseBranch,
          subdirectory: options.subdirectory,
        })

        log.debug('git', 'Remote initialization complete')
      } finally {
        // Release the cross-process lock first, then clear the in-memory lock.
        if (releaseLock) {
          try {
            await releaseLock()
          } catch (err: unknown) {
            log.debug('git', 'Failed to release remote-init lock', { err })
          }
        }
        remoteInitLocks.delete(options.remotePath)
      }
    })

    remoteInitLocks.set(options.remotePath, lockPromise)

    await lockPromise
  }

  /**
   * Whether a bare repository already has a branch of the given name, in
   * EITHER the local-heads namespace (`refs/heads/<branch>`) or the GitHub
   * tracking namespace (`GITHUB_TRACKING_REF_PREFIX<branch>`).
   *
   * Both namespaces matter to api/branch.ts's create-time collision guard: a
   * branch another CanopyCMS deployment sharing this repo (or a direct push to
   * GitHub) just created sits in the tracking namespace before, or without
   * ever, gaining a local head here (see GITHUB_TRACKING_REF_PREFIX above), so
   * checking `refs/heads/*` alone would miss exactly the
   * two-deployments-one-repo collision that guard exists to catch.
   *
   * Runs git with an explicit `--git-dir` instead of a cwd inside the repo:
   * environments with `safe.bareRepository=explicit` (sandboxed/CI git setups)
   * refuse cwd-based discovery of bare repos but expressly allow `--git-dir`.
   * A single `for-each-ref` call checks both candidate refs at once, without
   * exception-based control flow — it exits 0 whether or not either ref
   * exists, whereas `rev-parse --verify --quiet` suppresses the stderr output
   * that is the only thing simple-git fails a task on. `--end-of-options`
   * guards the ref-name positionals the same way `push` below does, since
   * `branch` here is sanitized but otherwise caller-influenced.
   *
   * A failure here therefore means the remote itself is unreadable and is
   * surfaced, NOT treated as "branch absent" — that would route
   * `ensureLocalSimulatedRemote` to the push path against a repo it couldn't
   * even read, and would silently skip api/branch.ts's collision check
   * instead of letting that caller distinguish "unreadable" from "absent".
   */
  static async bareRemoteHasBranch(
    remotePath: string,
    branch: string,
    options: { namespaces?: 'both' | 'tracking' } = {},
  ): Promise<boolean> {
    let output: string
    try {
      output = await simpleGit().raw([
        '--git-dir',
        remotePath,
        'for-each-ref',
        '--format=%(refname)',
        '--end-of-options',
        `refs/heads/${branch}`,
        `${GITHUB_TRACKING_REF_PREFIX}${branch}`,
      ])
    } catch (err) {
      throw new Error(`Cannot inspect remote mirror at ${remotePath}: ${getErrorMessage(err)}`)
    }
    // Compare full refnames rather than trusting the pattern to have matched
    // exactly: `for-each-ref <pattern>` matches "completely, or from the
    // beginning up to a slash", so `refs/heads/feature` also matches
    // `refs/heads/feature/foo`. Since syncGit mirrors EVERY GitHub branch into
    // the tracking namespace, a repo containing `feature/*`, `release/*`,
    // `dependabot/*` would otherwise report a collision for a branch named
    // literally `feature`, blocking a legitimate name.
    const refs = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if (options.namespaces === 'tracking') {
      // GitHub's view only. Local heads in `remote.git` are NOT evidence of a
      // collision for branch CREATION: nothing ever removes them (deleting a
      // branch in the editor unlinks its metadata and rm -rf's the clone, and
      // reconcileTrackedBranches deliberately never deletes a local head), so
      // an ordinary create -> publish -> merge -> delete -> reuse-the-name
      // cycle would otherwise report a permanent, untrue collision on a name
      // the user just deleted. This deployment's own live branches are already
      // covered by the branch registry check that runs before this one.
      return refs.includes(`${GITHUB_TRACKING_REF_PREFIX}${branch}`)
    }
    return (
      refs.includes(`refs/heads/${branch}`) ||
      refs.includes(`${GITHUB_TRACKING_REF_PREFIX}${branch}`)
    )
  }

  /**
   * Delete `refs/heads/<branch>` from a bare local mirror, if present. A
   * no-op (not an error) when the ref doesn't exist.
   *
   * The explicit path for removing a deleted branch's local head, which the
   * sync loop deliberately is not (reconcileTrackedBranches never deletes a
   * head — see GITHUB_TRACKING_REF_PREFIX). Called by api/branch.ts's
   * deleteBranchHandler: a head left in `remote.git` forever makes the
   * create -> publish -> squash-merge -> delete -> reuse-the-name cycle reject
   * the reused branch's first publish non-fast-forward against the stale head
   * (`GitManager.push()` pushes `branch:branch`, and a squash-merged old tip is
   * not an ancestor of the new branch), and a retried submit then skips the
   * local push on a clean tree and enqueues the worker push of the STALE head,
   * resurrecting the deleted branch's content on GitHub as an apparent success.
   *
   * Leaves the tracking ref (`GITHUB_TRACKING_REF_PREFIX<branch>`) alone: that
   * namespace mirrors GitHub's view, so while the branch still exists there the
   * create-time collision check SHOULD keep reporting it.
   *
   * Same `--git-dir` invocation style as bareRemoteHasBranch above (works under
   * `safe.bareRepository=explicit`). The existence pre-check makes "absent"
   * deterministic instead of parsing update-ref's locale-dependent failure
   * text, and its captured SHA is passed to `update-ref -d` as the expected old
   * value, so a concurrent push re-creating or moving this branch between the
   * read and the delete makes update-ref throw instead of silently deleting a
   * just-pushed commit. No `--end-of-options` on update-ref (older gits reject
   * it there); the ref argument always begins with the literal `refs/heads/`
   * prefix, so it can never parse as an option.
   */
  static async deleteBareRemoteHead(remotePath: string, branch: string): Promise<void> {
    const ref = `refs/heads/${branch}`
    const output = await simpleGit().raw([
      '--git-dir',
      remotePath,
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      '--end-of-options',
      ref,
    ])
    const match = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(' '))
      .find(([refname]) => refname === ref)
    if (!match) return
    const [, sha] = match
    await simpleGit().raw(['--git-dir', remotePath, 'update-ref', '-d', ref, sha])
  }

  /**
   * Push baseBranch from the source repo into the local bare remote via a
   * temporary remote. With `subdirectory`, pushes a single snapshot commit of
   * that subdirectory's tree at baseBranch instead of the full history:
   * `git subtree split` forks subprocesses per commit (minutes on large
   * repos), and the simulated remote never needs history — branches already
   * present are never updated, and editor state is committed on top of the
   * seed.
   */
  private static async pushBranchToLocalRemote(options: {
    sourceGit: SimpleGit
    remotePath: string
    baseBranch: string
    subdirectory?: string
  }): Promise<void> {
    const { sourceGit } = options
    const tempRemoteName = `__canopycms_init_${Date.now()}__`
    try {
      await sourceGit.addRemote(tempRemoteName, options.remotePath)

      if (options.subdirectory) {
        // Snapshot the subdirectory tree at baseBranch (not HEAD) and push it
        // as a single root commit.
        const tree = (
          await sourceGit.raw(['rev-parse', `${options.baseBranch}:${options.subdirectory}`])
        ).trim()
        const commit = (
          await sourceGit.raw([
            '-c',
            'user.name=CanopyCMS',
            '-c',
            'user.email=canopycms@localhost',
            'commit-tree',
            tree,
            '-m',
            `CanopyCMS dev base snapshot of ${options.baseBranch}:${options.subdirectory}`,
          ])
        ).trim()
        // --no-verify: this is internal plumbing into the simulated remote;
        // the adopter's pre-push hooks (husky etc.) must not block it
        await sourceGit.raw([
          'push',
          '--no-verify',
          tempRemoteName,
          `${commit}:refs/heads/${options.baseBranch}`,
        ])
      } else {
        // Normal push of entire repo (--no-verify: see above)
        await sourceGit.raw([
          'push',
          '--no-verify',
          tempRemoteName,
          `${options.baseBranch}:${options.baseBranch}`,
        ])
      }
    } finally {
      try {
        await sourceGit.removeRemote(tempRemoteName)
      } catch {
        // ignore cleanup errors
      }
    }
  }

  /**
   * @returns Path to git root, or cwd if not in a git repo
   */
  static async findGitRoot(): Promise<string> {
    let gitRoot = process.cwd()
    try {
      const git = simpleGit({ baseDir: process.cwd() })
      const result = await git.raw(['rev-parse', '--show-toplevel'])
      gitRoot = result.trim()
    } catch {
      // Fall back to cwd if not in a git repo
    }
    return gitRoot
  }

  /**
   * @throws Error if git repo doesn't exist
   */
  static async validateGitRepoExists(repoPath: string): Promise<void> {
    try {
      const stat = await fs.stat(path.join(repoPath, '.git'))
      if (!stat.isDirectory()) {
        throw new Error(`Expected git repo at ${repoPath}`)
      }
    } catch (err: unknown) {
      if (isNotFoundError(err)) {
        throw new Error(`Expected git repo at ${repoPath}`)
      }
      throw err
    }
  }

  /**
   * Guards prod mode against pointing git operations at a NETWORK remote
   * (http(s)://, ssh://, git://, or scp-like `user@host:path`): the prod CMS
   * Lambda has no internet access and would hang until timeout trying to
   * clone/fetch/push one. Fires only for `mode === 'prod'`, and only for the
   * three resolvable sources (explicit param, config, env var) — `file://`
   * URLs, plain filesystem paths and `resolveRemoteUrl`'s auto-detect step
   * (local by construction) are always allowed.
   *
   * @param source - Where `url` came from, for the thrown error message only.
   */
  private static assertRemoteUrlAllowedInMode(
    mode: OperatingMode,
    url: string,
    source: string,
    allowNetworkRemoteInProd: boolean | undefined,
  ): void {
    if (mode !== 'prod') return
    if (allowNetworkRemoteInProd) return
    if (!isNetworkRemoteUrl(url)) return

    throw new Error(
      `CanopyCMS: refusing to use a network remote URL in prod mode (from ${source}: "${url}"). ` +
        `The standard AWS Lambda+EC2-worker topology runs the CMS Lambda with no internet ` +
        `access — the EC2 worker owns all network git I/O, and the Lambda is expected to reach ` +
        `the EFS-local bare repo ({workspace}/remote.git) via auto-detect instead. Pointing a ` +
        `network URL here would make the internet-less Lambda try to clone/fetch/push it ` +
        `directly and hang until timeout. If this prod host genuinely has internet access and ` +
        `intentionally runs git against a network remote (e.g. a single-VM deployment), set ` +
        `config.allowNetworkRemoteInProd: true to acknowledge this.`,
    )
  }

  /**
   * Resolves the remote URL for git operations following the priority:
   * 1. Explicit remoteUrl parameter
   * 2. Config defaultRemoteUrl
   * 3. Environment variable (mode-specific)
   * 4. Auto-initialized local remote (for dev mode)
   *
   * In prod mode a resolved network URL from any of the first three sources is
   * rejected unless `options.allowNetworkRemoteInProd` is set — see
   * `assertRemoteUrlAllowedInMode`.
   *
   * @param options.sourceRoot - Source directory for monorepos, relative to the
   *   git root; the source for the simulated remote. Defaults to process.cwd().
   * @returns Remote URL or undefined if no remote is needed
   */
  static async resolveRemoteUrl(options: ResolveRemoteUrlOptions): Promise<string | undefined> {
    // Dynamic import: operating-mode contains Node-only code; deferring the
    // import keeps git-manager loadable in non-Node evaluation contexts
    const { operatingStrategy } = await import('./operating-mode')
    const strategy = operatingStrategy(options.mode)
    const config = strategy.getRemoteUrlConfig()

    if (options.remoteUrl) {
      this.assertRemoteUrlAllowedInMode(
        options.mode,
        options.remoteUrl,
        'the explicit remoteUrl parameter',
        options.allowNetworkRemoteInProd,
      )
      return options.remoteUrl
    }
    if (options.defaultRemoteUrl) {
      this.assertRemoteUrlAllowedInMode(
        options.mode,
        options.defaultRemoteUrl,
        'config.defaultRemoteUrl',
        options.allowNetworkRemoteInProd,
      )
      return options.defaultRemoteUrl
    }
    const envUrl = process.env[config.envVarName]
    if (envUrl) {
      this.assertRemoteUrlAllowedInMode(
        options.mode,
        envUrl,
        `the ${config.envVarName} environment variable`,
        options.allowNetworkRemoteInProd,
      )
      return envUrl
    }

    // Auto-detect a pre-existing remote.git at the expected path (in prod,
    // created by the EC2 worker on EFS)
    if (config.autoDetectRemotePath) {
      try {
        const stat = await fs.stat(config.autoDetectRemotePath)
        if (stat.isDirectory()) {
          log.debug('git', 'Auto-detected local remote', {
            path: config.autoDetectRemotePath,
          })
          return config.autoDetectRemotePath
        }
      } catch {
        // Path doesn't exist — fall through to next resolution step
      }
    }

    if (config.shouldAutoInitLocal) {
      const gitRoot = await this.findGitRoot()
      const sourceRoot = options.sourceRoot
      const sourcePath = sourceRoot ? path.resolve(gitRoot, sourceRoot) : gitRoot
      const localRemotePath = path.join(sourcePath, config.defaultRemotePath)

      await this.ensureLocalSimulatedRemote({
        remotePath: localRemotePath,
        sourcePath: gitRoot,
        baseBranch: options.baseBranch,
        subdirectory: sourceRoot,
      })

      return localRemotePath
    }

    return undefined
  }

  /**
   * Check whether a git repository is already initialized at `workspacePath`.
   *
   * Uses `rev-parse --git-dir` with `GIT_CEILING_DIRECTORIES` pinned to the
   * parent directory so a corrupt/missing `.git` can't make git silently
   * traverse upward and report a false positive from an ancestor repo.
   *
   * Shared by `initializeWorkspace` (clone-vs-reuse decision) and
   * `SettingsWorkspaceManager`'s rename guard (settings-workspace.ts), which
   * must know whether a settings workspace ALREADY exists before touching it —
   * re-initializing one under a different name wipes permissions.json/groups.json.
   */
  static async repoExistsAt(workspacePath: string): Promise<boolean> {
    try {
      const checkGit = simpleGit({ baseDir: workspacePath })
      checkGit.env(gitChildEnv({ GIT_CEILING_DIRECTORIES: path.dirname(workspacePath) }))
      await checkGit.raw(['rev-parse', '--git-dir'])
      return true
    } catch {
      return false
    }
  }

  /**
   * Ensures a git workspace is initialized and ready for use.
   * Handles cloning, remote configuration, and branch checkout/creation.
   *
   * Note: Does NOT configure git author - that should be done before commits, not during init.
   */
  static async initializeWorkspace(options: InitializeWorkspaceOptions): Promise<GitManager> {
    // Resolve the fork point through the shared resolver (dev mode detects the
    // current HEAD when baseBranch is not explicitly set).
    const baseBranch = await resolveBaseBranch({
      defaultBaseBranch: options.baseBranch,
      mode: options.mode,
      detectFrom: options.sourceRoot
        ? path.resolve(process.cwd(), options.sourceRoot)
        : process.cwd(),
    })
    const remoteName = options.remoteName ?? 'origin'

    const repoExists = await GitManager.repoExistsAt(options.workspacePath)
    if (!repoExists) {
      // Not a valid git repo — clean up corrupt .git if present so clone can proceed
      const gitPath = path.join(options.workspacePath, '.git')
      try {
        const stat = await fs.stat(gitPath)
        if (stat.isDirectory()) {
          log.debug('git', 'Removing corrupt .git directory', {
            workspacePath: options.workspacePath,
          })
          await fs.rm(gitPath, { recursive: true })
        }
      } catch (cleanupErr: unknown) {
        if (!isNotFoundError(cleanupErr)) throw cleanupErr
      }
    }

    let justCloned = false
    if (!repoExists) {
      const remoteUrl = await GitManager.resolveRemoteUrl({
        mode: options.mode,
        remoteUrl: options.remoteUrl,
        defaultRemoteUrl: options.defaultRemoteUrl,
        baseBranch,
        sourceRoot: options.sourceRoot,
        allowNetworkRemoteInProd: options.allowNetworkRemoteInProd,
      })

      if (!remoteUrl) {
        throw new Error(
          'CanopyCMS: defaultRemoteUrl (or CANOPYCMS_REMOTE_URL) is required to initialize workspace',
        )
      }

      try {
        await GitManager.cloneRepo(remoteUrl, options.workspacePath, baseBranch)
      } catch (err) {
        // The raw git error ("Cloning into <workspace>… branch <base> not found")
        // mixes the workspace name and the base branch — spell both out.
        throw new Error(
          `Failed to clone branch workspace at ${options.workspacePath} ` +
            `from ${remoteUrl} (base branch '${baseBranch}'): ${getErrorMessage(err)}`,
        )
      }
      justCloned = true

      // Mark as managed immediately after clone so ensureRemote's guard works,
      // and set a fallback author identity: GIT_CEILING_DIRECTORIES blocks
      // global gitconfig, and internal commits (e.g. orphan branch init) need
      // one. ensureAuthor() sets the real bot author before user-facing commits.
      const freshGit = simpleGit({ baseDir: options.workspacePath })
      freshGit.env(gitChildEnv({ GIT_CEILING_DIRECTORIES: path.dirname(options.workspacePath) }))
      await freshGit.addConfig('canopycms.managed', 'true')
      await freshGit.addConfig('user.name', options.gitBotAuthorName)
      await freshGit.addConfig('user.email', options.gitBotAuthorEmail)
    }

    // Settings (orphan) workspaces never host ContentStores, so they skip the
    // on-disk content-index generation marker.
    const git = new GitManager({
      repoPath: options.workspacePath,
      baseBranch,
      remote: remoteName,
      skipIndexMarker: options.branchType === 'orphan',
    })

    // The managed marker and fallback identity must be set before ensureRemote
    // (which checks the marker) and before createOrphanSettingsBranch (which
    // commits and needs an author). Idempotent — the clone above may have set them.
    await git.git.addConfig('canopycms.managed', 'true')
    await git.git.addConfig('user.name', options.gitBotAuthorName)
    await git.git.addConfig('user.email', options.gitBotAuthorEmail)
    log.debug('git', 'Marked workspace as CanopyCMS-managed', {
      workspacePath: options.workspacePath,
    })

    // Configure the remote only if we didn't just clone (clone sets up 'origin')
    if (!justCloned) {
      const remoteUrl = await GitManager.resolveRemoteUrl({
        mode: options.mode,
        remoteUrl: options.remoteUrl,
        defaultRemoteUrl: options.defaultRemoteUrl,
        baseBranch,
        sourceRoot: options.sourceRoot,
        allowNetworkRemoteInProd: options.allowNetworkRemoteInProd,
      })
      if (remoteUrl) {
        await git.ensureRemote(remoteUrl)
      }
    }

    if (options.branchType === 'orphan') {
      await git.createOrphanSettingsBranch(options.branchName, {})
      // Settings mutations hold an OCC lockfile (<file>.lock, see
      // authorization/settings-file-store.ts) inside this git-committed
      // workspace. Commits here stage explicit paths, but a crash-orphaned lock
      // dir must never be committable by a future broad stage either. Runs on
      // every init, so existing clones pick it up.
      await git.ensureGitExclude('*.lock')
    } else {
      await git.checkoutBranch(options.branchName)
      // Excludes runtime metadata (.canopy-meta/) from git tracking on content
      // branches. Settings workspaces don't need it: they stage explicit file
      // paths at the workspace root and skip the index marker entirely
      // (skipIndexMarker), so nothing under .canopy-meta/ is ever staged.
      if (options.gitExcludePattern) {
        await git.ensureGitExclude(options.gitExcludePattern)
      }
    }

    return git
  }

  async status(): Promise<GitStatus> {
    const s = await this.git.status()
    return {
      files: s.files,
      ahead: s.ahead,
      behind: s.behind,
      current: s.current,
      tracking: s.tracking,
    }
  }

  /**
   * Mark ContentStore ID indexes AND the resolved-schema cache rooted at (or
   * under) this repo as stale, so ID→path lookups and `.collection.json`
   * schemas don't stay pinned to the pre-mutation tree. Called in `finally`
   * blocks around every working-tree mutation (checkout/merge/rebase) because
   * even a failed merge may have touched the tree; over-invalidating is safe.
   *
   * Covers in-process stores/caches via their registries and other processes
   * sharing the filesystem (worker vs Lambda on EFS) via the on-disk generation
   * markers — except on a settings workspace (skipIndexMarker), where only the
   * free in-process content-index invalidation runs and NEITHER marker is
   * bumped (such workspaces have no schema cache of their own either).
   */
  private async invalidateContentIndexes(): Promise<void> {
    if (this.skipIndexMarker) {
      invalidateContentIndexesForRoot(this.repoPath)
      return
    }
    await invalidateBranchContentCaches(this.repoPath)
  }

  async checkoutBranch(branch: string): Promise<void> {
    try {
      await this.checkoutBranchInner(branch)
    } finally {
      await this.invalidateContentIndexes()
    }
  }

  private async checkoutBranchInner(branch: string): Promise<void> {
    const branches = await this.git.branch()
    if (branches.all.includes(branch)) {
      // No `--`/`--end-of-options` separator here: a bare `--` switches
      // `git checkout` into pathspec-restore mode instead of switching
      // branches, and `--end-of-options` is not honored by `git checkout` on
      // git versions still in the field (Apple's bundled 2.39.5 treats it as a
      // literal, unmatched pathspec). Safety instead relies on
      // parseBranchName() rejecting a leading hyphen before `branch` gets here.
      await this.git.checkout(branch)
      return
    }

    const remoteRef = `${this.remote}/${this.baseBranch}`
    try {
      await this.git.fetch(this.remote, this.baseBranch)
    } catch {
      // Best-effort; will fall back to local base branch below if fetch fails
    }
    try {
      // `-b`/`-B` consume the very next token as their literal branch-name
      // value (not subject to option re-scanning), and git independently
      // rejects a leading-hyphen value there ("... is not a valid branch
      // name"). So `branch` needs no separator here either.
      await this.git.checkoutBranch(branch, remoteRef)
      return
    } catch {
      const baseExists = branches.all.includes(this.baseBranch)
      if (baseExists) {
        await this.git.checkout(['-B', branch, this.baseBranch])
        return
      }
      await this.git.checkoutLocalBranch(branch)
    }
  }

  async pullBase(): Promise<void> {
    try {
      await this.pullBaseInner()
    } finally {
      await this.invalidateContentIndexes()
    }
  }

  private async pullBaseInner(): Promise<void> {
    await this.git.fetch(this.remote, this.baseBranch)
    // Merge the just-fetched tip pinned to a SHA, not <remote>/<base>:
    // workspaces are cloned --single-branch, so the remote-tracking ref for any
    // branch other than the cloned one never exists (same constraint as the
    // worker's rebase loop, worker/rebase.ts), and FETCH_HEAD is a shared
    // mutable file any other fetch in this clone can repoint.
    const fetchedTip = (await this.git.revparse(['FETCH_HEAD'])).trim()
    try {
      await this.git.merge([fetchedTip])
    } catch (err) {
      // Capture conflicted files before aborting — abort clears them from status.
      // If status() itself fails (e.g. corrupted .git), still abort and re-throw
      // the original error so the workspace is left as clean as possible.
      try {
        const status = await this.git.status()
        await this.git.merge(['--abort']).catch(() => {})
        if (status.conflicted.length > 0) throw new GitConflictError(status.conflicted)
      } catch (recoveryErr) {
        if (recoveryErr instanceof GitConflictError) throw recoveryErr
        await this.git.merge(['--abort']).catch(() => {})
      }
      throw err
    }
  }

  async pullCurrentBranch(): Promise<void> {
    try {
      await this.pullCurrentBranchInner()
    } finally {
      await this.invalidateContentIndexes()
    }
  }

  private async pullCurrentBranchInner(): Promise<void> {
    const branches = await this.git.branch()
    const currentBranch = branches.current
    try {
      await this.git.fetch(this.remote, currentBranch)
    } catch (err) {
      // The only benign failure here: the branch has never been pushed, so the
      // remote has no ref to fetch ("couldn't find remote ref"). Typed so
      // callers can tell it apart from a genuine pull failure instead of
      // catch-all-ing both (see services.ts commitToSettingsBranch).
      //
      // CLASSIFIED, not assumed: a type whose docstring promises a narrow
      // condition must only be constructed for that condition. Wrapping every
      // fetch failure would hand commitToSettingsBranch an unreachable remote,
      // an auth denial or a corrupt object store as "nothing to pull", which it
      // logs as normal for a first settings commit and carries on past.
      if (!isMissingRemoteRefFailure(getErrorMessage(err))) throw err
      throw new GitRemoteRefMissingError(currentBranch, this.remote, err)
    }
    // Merge the just-fetched tip pinned to a SHA, not <remote>/<current> — the
    // pullBaseInner constraint, harder here: a settings workspace is cloned
    // --single-branch at the BASE branch and then checked out onto its orphan
    // settings branch, so `<remote>/<current>` is a ref that can never exist
    // and merging it makes the settings pull a permanent no-op. Pin FETCH_HEAD
    // immediately after the fetch that populated it; any other fetch in this
    // clone can repoint that shared file.
    const fetchedTip = (await this.git.revparse(['FETCH_HEAD'])).trim()
    try {
      await this.git.merge([fetchedTip])
    } catch (err) {
      try {
        const status = await this.git.status()
        await this.git.merge(['--abort']).catch(() => {})
        if (status.conflicted.length > 0) throw new GitConflictError(status.conflicted)
      } catch (recoveryErr) {
        if (recoveryErr instanceof GitConflictError) throw recoveryErr
        await this.git.merge(['--abort']).catch(() => {})
      }
      throw err
    }
  }

  async rebaseOntoBase(): Promise<void> {
    try {
      await this.rebaseOntoBaseInner()
    } finally {
      await this.invalidateContentIndexes()
    }
  }

  private async rebaseOntoBaseInner(): Promise<void> {
    await this.git.fetch(this.remote, this.baseBranch)
    // Pinned just-fetched tip, not <remote>/<base> — see pullBaseInner.
    const fetchedTip = (await this.git.revparse(['FETCH_HEAD'])).trim()
    try {
      await this.git.rebase([fetchedTip])
    } catch (err) {
      try {
        const status = await this.git.status()
        await this.git.rebase(['--abort']).catch(() => {})
        if (status.conflicted.length > 0) throw new GitConflictError(status.conflicted)
      } catch (recoveryErr) {
        if (recoveryErr instanceof GitConflictError) throw recoveryErr
        await this.git.rebase(['--abort']).catch(() => {})
      }
      throw err
    }
  }

  async add(files: string | string[]): Promise<void> {
    const fileArray = Array.isArray(files) ? files : [files]
    await this.git.add(fileArray)
  }

  async commit(message: string): Promise<void> {
    await this.git.commit(message)
  }

  async push(branch?: string): Promise<void> {
    const target = branch ?? (await this.git.revparse(['--abbrev-ref', 'HEAD']))
    // Explicit refspec (local:remote) so push works for branches not yet in the
    // remote (e.g. orphan settings branches). Built via raw() rather than the
    // push() wrapper so `--end-of-options` sits immediately before the
    // positional remote/refspec, guarding against a refspec starting with '-'
    // being parsed as a git option (e.g. --receive-pack=...). Real flags must
    // precede it, since everything after it is treated as positional.
    await this.git.raw([
      'push',
      '--set-upstream',
      '--end-of-options',
      this.remote,
      `${target}:${target}`,
    ])
  }

  /**
   * Whether the local branch has commits the remote mirror doesn't -- i.e.
   * whether push() would move the remote ref forward.
   *
   * Callers (services.ts submitBranch) gate pushing on this rather than on "is
   * the working tree dirty": committing cleans the tree, so a dirty-tree gate
   * around commit+push skips the push entirely when retried after a failed
   * push, even though the commit never reached the remote.
   *
   * Fetches the specific branch directly and pins FETCH_HEAD's SHA immediately
   * after, rather than trusting `<remote>/<branch>` -- the pullBaseInner
   * constraint: single-branch clones have no remote-tracking ref for any other
   * branch, and FETCH_HEAD is shared mutable state.
   *
   * A branch never pushed has no ref on the remote, so `git fetch` fails
   * ("couldn't find remote ref"); that counts as "ahead", not an error.
   */
  async hasUnpushedCommits(branch?: string): Promise<boolean> {
    // `--end-of-options` before every caller-influenced ref name, as in push()
    // above: names are sanitized upstream, but this file's rule is that a
    // positional is guarded where it is passed, not where it was validated.
    const target = branch ?? (await this.git.revparse(['--abbrev-ref', '--end-of-options', 'HEAD']))
    const localSha = (await this.git.revparse(['--end-of-options', target])).trim()
    let fetchedTip: string
    try {
      await this.git.raw(['fetch', '--end-of-options', this.remote, target])
      fetchedTip = (await this.git.revparse(['--end-of-options', 'FETCH_HEAD'])).trim()
    } catch {
      // No ref on the remote yet -- the branch has never been pushed.
      return true
    }
    if (fetchedTip === localSha) return false
    // Commits reachable from the local tip but not the remote's -- unlike a
    // bare SHA-inequality check, this holds for a diverged mirror too.
    const aheadCount = (
      await this.git.raw(['rev-list', '--count', `${fetchedTip}..${localSha}`])
    ).trim()
    return aheadCount !== '0'
  }

  async ensureAuthor(author: { name: string; email: string }): Promise<void> {
    const config = (await this.git.listConfig()) as ConfigListSummary

    // Verify this is a CanopyCMS-managed workspace before setting author
    const isManaged = config.all['canopycms.managed'] === 'true'
    if (!isManaged) {
      throw new Error(
        `Cannot set git bot author in non-managed repository (${this.repoPath}). ` +
          `Bot identity should only be set in CanopyCMS branch clones or test workspaces. ` +
          `If this is a test workspace, add "git config canopycms.managed true" to mark it as managed.`,
      )
    }

    const currentName = config.all['user.name']
    const currentEmail = config.all['user.email']
    if (currentName !== author.name) {
      await this.git.addConfig('user.name', author.name)
    }
    if (currentEmail !== author.email) {
      await this.git.addConfig('user.email', author.email)
    }
  }

  async ensureRemote(remoteUrl: string): Promise<void> {
    // Safety: verify this is a managed workspace before modifying remotes.
    // Prevents accidentally overwriting the host repo's origin if git
    // traversed up from a corrupt workspace .git directory.
    const config = (await this.git.listConfig()) as ConfigListSummary
    const isManaged = config.all['canopycms.managed'] === 'true'
    if (!isManaged) {
      throw new Error(
        `Cannot modify remote in non-managed repository (${this.repoPath}). ` +
          `This likely means git traversed to a parent repository. ` +
          `Expected a CanopyCMS workspace.`,
      )
    }

    const remotes = await this.git.getRemotes(true)
    const existing = remotes.find((r) => r.name === this.remote)
    if (!existing) {
      await this.git.addRemote(this.remote, remoteUrl)
      return
    }
    const currentUrl = existing.refs.push ?? existing.refs.fetch
    if (currentUrl && currentUrl !== remoteUrl) {
      await this.git.remote(['set-url', this.remote, remoteUrl])
    }
  }

  async hasUncommittedChanges(): Promise<boolean> {
    const status = await this.status()
    return status.files.length > 0
  }

  async getUncommittedFiles(): Promise<string[]> {
    const status = await this.status()
    return status.files.map((f) => f.path)
  }

  async getRemoteUrl(): Promise<string | undefined> {
    const remotes = await this.git.getRemotes(true)
    const remote = remotes.find((r) => r.name === this.remote)
    return remote?.refs.push || remote?.refs.fetch
  }

  /**
   * Excludes `pattern` (e.g. `.canopy-meta/`) from this workspace's git, so it
   * can never be committed or pushed. See {@link ensureGitExcludePattern}.
   */
  async ensureGitExclude(pattern: string): Promise<void> {
    await ensureGitExcludePattern(this.repoPath, pattern)
  }

  /**
   * Create an orphan branch (no shared history) for settings, so
   * deployment-specific settings never pollute content history. It holds only
   * settings files committed by explicit path (permissions.json, groups.json at
   * the workspace root).
   */
  async createOrphanSettingsBranch(
    branchName: string,
    initialFiles: Record<string, string>,
  ): Promise<void> {
    try {
      await this.createOrphanSettingsBranchInner(branchName, initialFiles)
    } finally {
      // Both branches of Inner swap the working tree (checkout / checkout --orphan)
      await this.invalidateContentIndexes()
    }
  }

  private async createOrphanSettingsBranchInner(
    branchName: string,
    initialFiles: Record<string, string>,
  ): Promise<void> {
    log.debug('git', 'Creating orphan settings branch', { branchName })

    const branches = await this.git.branch()
    if (branches.all.includes(branchName)) {
      log.debug('git', 'Orphan branch already exists', { branchName })
      // No separator here — see checkoutBranch() above for why plain
      // `git checkout <branch>` can't safely take one. branchName is always an
      // internal/config-derived settings-branch name, never user input.
      await this.git.checkout(branchName)
      return
    }

    // branchName is consumed as --orphan's literal argument value (like -b/-B
    // above), so it can't be reinterpreted as a flag; git's own ref-name
    // validation additionally rejects a leading-hyphen value here.
    await this.git.raw(['checkout', '--orphan', branchName])

    // Remove all files from index (orphan checkout keeps working tree)
    try {
      await this.git.raw(['rm', '-rf', '.'])
    } catch {
      // Ignore errors (might fail if index is already empty)
    }

    for (const [filePath, content] of Object.entries(initialFiles)) {
      const absolutePath = path.join(this.repoPath, filePath)
      await fs.mkdir(path.dirname(absolutePath), { recursive: true })
      await fs.writeFile(absolutePath, content, 'utf-8')
      await this.git.add(filePath)
    }

    await this.git.commit('Initialize settings branch', ['--allow-empty'])

    log.debug('git', 'Orphan settings branch created', { branchName })
  }
}
