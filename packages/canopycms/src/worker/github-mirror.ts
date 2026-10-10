import fs from 'node:fs/promises'
import path from 'node:path'
import { simpleGit, type SimpleGit } from 'simple-git'

import {
  GITHUB_TRACKING_REF_PREFIX,
  gitNetworkChildEnv,
  repackBareRemoteIfNeeded,
  type BareRemoteRepackResult,
} from '../git-manager'
import { sanitizeBranchName } from '../paths/branch-name'
import { getErrorMessage, redactCredentials } from '../utils/error'
import { workerLogWarn } from './log'
import { mirrorGitOptions, pinnedReceivePack, pinnedUploadPack } from './shared-repo-git'

/**
 * The worker's private bare mirror of the GitHub repository, on storage the CMS Lambda cannot
 * reach: the only repository in which git ever runs with the GitHub credential. Every
 * token-bearing fetch and push reads config and hooks from here, never from `remote.git` or a
 * branch clone, whose config the Lambda can write (see worker/shared-repo-git.ts for why `-c`
 * cannot neutralize that). Objects cross to and from `remote.git` only by local fetch and push,
 * through the pinned `upload-pack`/`receive-pack` commands.
 *
 * `refs/heads/*` mirrors GitHub as of the last fetch. `refs/canopy/outgoing/<branch>` holds a
 * commit being pushed for the length of that push. A cache: deleting it costs a fetch, from
 * `remote.git` where it can and GitHub for the rest.
 *
 * One process owns it, and {@link GitHubMirror.exclusive} runs one session at a time, so a fetch's
 * `--prune` never meets a push half way. A repack runs beside them, which is safe because it
 * expires no cruft, so no object a session is using disappears (git-manager.ts
 * `repackBareRemoteIfNeeded`); expiring it would mean repacking inside a session.
 *
 * Every transfer runs with `--progress`: simple-git's timeout is inactivity, and a quiet fetch of a
 * whole repository would otherwise be killed for its size. The connectivity walk after a fetch
 * still prints nothing (.claude/future-tasks/worker-github-mirror-limits.md).
 */
export class GitHubMirror {
  readonly gitDir: string
  private tail: Promise<unknown> = Promise.resolve()
  private warnedSize = false
  private ready = false

  constructor(
    stateDirectory: string,
    private readonly remoteGitPath: string,
    private readonly timeoutMs: number,
  ) {
    this.gitDir = path.join(stateDirectory, 'github.git')
  }

  /**
   * Run `fn` with the mirror to itself, after every session started before it. Creates the
   * mirror first if it is missing, and checks again after any session that failed.
   */
  exclusive<T>(fn: (session: MirrorSession) => Promise<T>): Promise<T> {
    const start = async () => {
      if (!this.ready) {
        await this.create()
        this.ready = true
      }
      try {
        return await fn(new MirrorSession(this.gitDir, this.remoteGitPath, this.timeoutMs))
      } catch (err) {
        this.ready = false
        throw err
      }
    }
    const run = this.tail.then(start, start)
    this.tail = run.catch(() => undefined)
    return run
  }

  /** Create the mirror now rather than at its first use. */
  ensure(): Promise<void> {
    return this.exclusive(async () => undefined)
  }

  /**
   * Create the mirror, or recreate one that is not a readable bare repository, and drop staging
   * refs a killed push left: one at `<branch>` blocks a later `<branch>/<x>`.
   */
  private async create(): Promise<void> {
    await fs.mkdir(path.dirname(this.gitDir), { recursive: true, mode: 0o700 })
    await assertOwnDirectory(path.dirname(this.gitDir))
    if (!(await isBareRepository(this.gitDir))) {
      await fs.rm(this.gitDir, { recursive: true, force: true })
      await fs.mkdir(this.gitDir, { mode: 0o700 })
      await simpleGit({ baseDir: this.gitDir, ...mirrorGitOptions() })
        .env(mirrorEnv(this.gitDir))
        .raw(['init', '--quiet', '--bare'])
    }
    await assertOwnDirectory(this.gitDir)
    const git = simpleGit({ baseDir: this.gitDir, ...mirrorGitOptions() }).env(
      mirrorEnv(this.gitDir),
    )
    const staged = (await git.raw(['for-each-ref', '--format=%(refname)', STAGING_PREFIX]))
      .split('\n')
      .filter(Boolean)
    for (const ref of staged) await git.raw(['update-ref', '-d', '--end-of-options', ref])
  }

  /** Repack when it needs it, and say once if it has grown past {@link MIRROR_SIZE_WARN_KIB}. */
  async maintain(): Promise<BareRemoteRepackResult> {
    await this.ensure()
    const result = await repackBareRemoteIfNeeded(
      this.gitDir,
      simpleGit({ baseDir: this.gitDir, ...mirrorGitOptions() }).env(mirrorEnv(this.gitDir)),
    )
    if (!this.warnedSize) {
      const kib = await objectStoreKiB(this.gitDir)
      if (kib > MIRROR_SIZE_WARN_KIB) {
        this.warnedSize = true
        workerLogWarn(
          `The worker's GitHub mirror (${this.gitDir}) holds ${Math.round(kib / 1024)} MiB of ` +
            `objects, on the instance's root volume. See "The worker instance" in ` +
            `docs/deploying-to-aws.md for the headroom it assumes.`,
        )
      }
    }
    return result
  }
}

/**
 * Past this the mirror is using a large share of the worker's default 8 GiB root volume, which
 * also holds the OS, Node and the log.
 */
const MIRROR_SIZE_WARN_KIB = 2 * 1024 * 1024

const STAGING_PREFIX = 'refs/canopy/outgoing/'

/**
 * Refuse a directory the worker does not own outright: another local user could have created a
 * predictable path (the `os.tmpdir()` default) first, with a mirror config of their own.
 */
async function assertOwnDirectory(dir: string): Promise<void> {
  const stat = await fs.lstat(dir)
  // Windows has no POSIX owner or mode bits to check.
  const uid = process.getuid?.()
  if (
    !stat.isDirectory() ||
    (uid !== undefined && (stat.uid !== uid || (stat.mode & 0o022) !== 0))
  ) {
    throw new Error(
      `${dir} must be a directory this worker owns and no one else can write, for the GitHub ` +
        `credential is used in the repository there`,
    )
  }
}

/**
 * A push the worker never makes: to a name that is not a plain branch name, to the base branch, or
 * to GitHub's default branch. No CanopyCMS flow asks for any of these, so a task that does was not
 * written by CanopyCMS.
 */
export class RefusedPushError extends Error {
  constructor(
    readonly branch: string,
    reason: 'invalid' | 'protected',
  ) {
    super(
      reason === 'invalid'
        ? `Refusing to push ${JSON.stringify(branch)} to GitHub: it is not a valid branch name.`
        : `Refusing to push "${branch}" to GitHub: it is the base branch or GitHub's default ` +
            `branch, which the CanopyCMS worker never pushes. Nothing in CanopyCMS queues such a ` +
            `push; find out what wrote this task.`,
    )
    this.name = 'RefusedPushError'
  }
}

/**
 * Throw {@link RefusedPushError} unless `branch` is a plain branch name: one
 * `git check-ref-format --branch` accepts unchanged. That rules out a `:` (git would read what
 * follows it in a refspec as another destination), `..`, `^`, `~`, `@{`, spaces and a leading
 * `-`, so `refs/heads/<branch>` is exactly the ref a push names.
 */
export async function assertPlainBranchName(branch: string): Promise<void> {
  let normalized: string
  try {
    normalized = (await simpleGit().raw(['check-ref-format', '--branch', branch])).trim()
  } catch (err) {
    // Only git's own verdict is a refusal; a failure to run git at all is transient.
    if (/is not a valid branch name/.test(getErrorMessage(err))) {
      throw new RefusedPushError(branch, 'invalid')
    }
    throw err
  }
  // `@{-1}` and the like resolve to some other name.
  if (normalized !== branch) throw new RefusedPushError(branch, 'invalid')
}

/** What one {@link GitHubMirror.exclusive} call may do. */
export class MirrorSession {
  constructor(
    private readonly gitDir: string,
    private readonly remoteGitPath: string,
    private readonly timeoutMs: number,
  ) {}

  private git(signal?: AbortSignal): SimpleGit {
    return simpleGit({
      baseDir: this.gitDir,
      ...mirrorGitOptions(),
      timeout: { block: this.timeoutMs },
      abort: signal,
    }).env(mirrorEnv(this.gitDir))
  }

  /**
   * Bring `refs/heads/*` to exactly what GitHub holds. `githubUrl` carries the credential. An empty
   * mirror (every new instance) first takes what `remote.git` already has, so GitHub sends only the
   * difference; the GitHub fetch then overwrites and prunes every ref that seeding set.
   */
  async fetchFromGitHub(githubUrl: string, signal?: AbortSignal): Promise<void> {
    const git = this.git(signal)
    if ((await git.raw(['for-each-ref', '--count=1', 'refs/heads/'])).trim() === '') {
      await this.seedFromRemoteGit(signal)
    }
    await git.raw([
      'fetch',
      '--prune',
      '--progress',
      '--no-write-fetch-head',
      '--end-of-options',
      githubUrl,
      '+refs/heads/*:refs/heads/*',
    ])
  }

  /**
   * Best-effort: a `remote.git` that does not exist yet (the first boot) or that fails the object
   * check costs only a full fetch from GitHub.
   */
  private async seedFromRemoteGit(signal?: AbortSignal): Promise<void> {
    if (!(await fs.stat(this.remoteGitPath).catch(() => null))) return
    try {
      await this.fetchFromRemoteGit([`+${GITHUB_TRACKING_REF_PREFIX}*:refs/heads/*`], signal)
    } catch (err) {
      workerLogWarn(
        `Could not seed the GitHub mirror from remote.git, fetching all of it from GitHub: ` +
          redactCredentials(getErrorMessage(err)),
      )
    }
  }

  /**
   * Fetch from `remote.git` through {@link pinnedUploadPack}, checking every object: these are the
   * objects the Lambda can write.
   */
  private async fetchFromRemoteGit(refspecs: string[], signal?: AbortSignal): Promise<void> {
    await this.git(signal).raw([
      '-c',
      'fetch.fsckObjects=true',
      'fetch',
      '--progress',
      '--no-write-fetch-head',
      `--upload-pack=${pinnedUploadPack()}`,
      '--end-of-options',
      this.remoteGitPath,
      ...refspecs,
    ])
  }

  /**
   * The branch GitHub's HEAD names, or null for a repository with none (empty, or HEAD unborn). A
   * failure to reach GitHub throws, so a push that cannot learn it does not happen.
   */
  private async githubDefaultBranch(
    githubUrl: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const out = await this.git(signal).raw([
      'ls-remote',
      '--symref',
      '--end-of-options',
      githubUrl,
      'HEAD',
    ])
    const match = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(out)
    return match ? match[1] : null
  }

  /** The mirror's tip for `branch`, or null when GitHub had no such branch at the last fetch. */
  async branchTip(branch: string): Promise<string | null> {
    try {
      const sha = (
        await this.git().raw(['rev-parse', '--verify', '--end-of-options', `refs/heads/${branch}`])
      ).trim()
      return sha.length > 0 ? sha : null
    } catch {
      return null
    }
  }

  /**
   * Whether a branch GitHub had at the last fetch contains the commit `id`, or the commit an
   * annotated tag `id` points at. False for an object the mirror does not have, or one git cannot
   * read as a commit.
   */
  async isOnGitHub(id: string): Promise<boolean> {
    if (!isObjectId(id)) return false
    try {
      const found = await this.git().raw([
        'for-each-ref',
        '--count=1',
        '--format=%(refname)',
        `--contains=${id}`,
        'refs/heads/',
      ])
      return found.trim() !== ''
    } catch {
      return false
    }
  }

  /**
   * Copy GitHub's branches into `remote.git`'s tracking namespace, pruning the ones GitHub no
   * longer has. `reconcileTrackedBranches` (worker/git-sync.ts) moves `refs/heads/*` from there.
   */
  async publishTrackingRefs(signal?: AbortSignal): Promise<void> {
    await this.pushToRemoteGit(
      this.remoteGitPath,
      [`+refs/heads/*:${GITHUB_TRACKING_REF_PREFIX}*`],
      signal,
      true,
    )
  }

  /** Seed a new, empty bare repository at `gitDir` with every GitHub branch. */
  async seedBareRepository(gitDir: string, signal?: AbortSignal): Promise<void> {
    await this.pushToRemoteGit(gitDir, ['+refs/heads/*:refs/heads/*'], signal, false)
  }

  private async pushToRemoteGit(
    target: string,
    refspecs: string[],
    signal: AbortSignal | undefined,
    prune: boolean,
  ): Promise<void> {
    await this.git(signal).raw([
      'push',
      '--progress',
      ...(prune ? ['--prune'] : []),
      `--receive-pack=${pinnedReceivePack()}`,
      '--end-of-options',
      target,
      ...refspecs,
    ])
  }

  /**
   * Push exactly `sha`, which `remote.git` held for `branch` when the caller read it, to GitHub's
   * `refs/heads/<branch>`. `lease` is the commit GitHub must still be at for the push to replace
   * it (`--force-with-lease`); without one the push is an ordinary fast-forward. Fetching the
   * commit from `remote.git` first is the step that brings the Lambda's objects across, through
   * the pinned `upload-pack`.
   */
  async pushToGitHub(
    githubUrl: string,
    branch: string,
    sha: string,
    options: { lease?: string; signal?: AbortSignal; protectedBranches: readonly string[] },
  ): Promise<void> {
    for (const id of [sha, ...(options.lease === undefined ? [] : [options.lease])]) {
      if (!isObjectId(id)) throw new Error(`Not a commit ID: ${JSON.stringify(id)}`)
    }
    // Here, at the one place every GitHub push (plain or under a lease) goes through, so no caller
    // can skip it, and before any git runs with `branch` in a refspec. The task queue, remote.git
    // and the lease marker are all Lambda-writable, and the worker's base branch comes from
    // Lambda-writable state when it is not configured (`CmsWorker.resolveBaseBranch`); GitHub's default branch is read from GitHub
    // itself, per push.
    await assertPlainBranchName(branch)
    const protectedNames = [...options.protectedBranches]
    const githubDefault = await this.githubDefaultBranch(githubUrl, options.signal)
    if (githubDefault !== null) protectedNames.push(githubDefault)
    const target = sanitizeBranchName(branch)
    if (protectedNames.some((name) => name === branch || sanitizeBranchName(name) === target)) {
      throw new RefusedPushError(branch, 'protected')
    }
    const staging = `${STAGING_PREFIX}${branch}`
    const git = this.git(options.signal)
    try {
      await this.fetchFromRemoteGit([`+${sha}:${staging}`], options.signal)
      await git.raw([
        'push',
        '--progress',
        ...(options.lease ? [`--force-with-lease=refs/heads/${branch}:${options.lease}`] : []),
        '--end-of-options',
        githubUrl,
        `${sha}:refs/heads/${branch}`,
      ])
    } finally {
      // A deleted branch's leftover ref would block a later `<branch>/<x>` (a directory/file
      // conflict in the ref namespace).
      await this.git()
        .raw(['update-ref', '-d', '--end-of-options', staging])
        .catch(() => undefined)
    }
  }
}

/**
 * The network env (proxies, CA bundles, the C locale the push-rejection classifier needs), with
 * the repository named outright: a bare repository found from the working directory is refused
 * where `safe.bareRepository=explicit` is set.
 */
function mirrorEnv(gitDir: string): Record<string, string> {
  return { ...gitNetworkChildEnv(), GIT_DIR: gitDir }
}

/** A full SHA-1 or SHA-256 object ID, so nothing else can reach a refspec. */
function isObjectId(value: string): boolean {
  return (value.length === 40 || value.length === 64) && /^[0-9a-f]+$/.test(value)
}

async function isBareRepository(gitDir: string): Promise<boolean> {
  try {
    await fs.access(gitDir)
    // Without the mirror's pins, whose `core.bare=true` would answer this question for git.
    const out = await simpleGit({ baseDir: gitDir }).raw([
      '--git-dir',
      gitDir,
      'rev-parse',
      '--is-bare-repository',
    ])
    return out.trim() === 'true'
  } catch {
    return false
  }
}

async function objectStoreKiB(gitDir: string): Promise<number> {
  const output = await simpleGit({ baseDir: gitDir, ...mirrorGitOptions() }).raw([
    '--git-dir',
    gitDir,
    'count-objects',
    '-v',
  ])
  let total = 0
  for (const line of output.split('\n')) {
    const [name, value] = line.split(': ')
    if (name === 'size' || name === 'size-pack') total += Number(value) || 0
  }
  return total
}
