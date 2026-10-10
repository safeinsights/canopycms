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
import {
  githubBoundGitOptions,
  mirrorGitOptions,
  pinnedReceivePack,
  pinnedUploadPack,
} from './shared-repo-git'

/**
 * The worker's private bare mirror of the GitHub repository, on storage the CMS Lambda cannot
 * reach: the only repository in which git ever runs with the GitHub credential. Every
 * credentialed fetch and push reads config and hooks from here, never from `remote.git` or a
 * branch clone, whose config the Lambda can write (see worker/shared-repo-git.ts for why `-c`
 * cannot neutralize that). Objects cross to and from `remote.git` only by local fetch and push,
 * through the pinned `upload-pack`/`receive-pack` commands. The credential reaches git only as a
 * per-command config file ({@link withCredentialConfig}).
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
   * mirror first if it is missing, and checks again after any session that failed. First deletes
   * any credential file a killed or failed cleanup left: no session is running, so none is in use.
   */
  exclusive<T>(fn: (session: MirrorSession) => Promise<T>): Promise<T> {
    const start = async () => {
      if (!this.ready) {
        await this.create()
        this.ready = true
      }
      await sweepCredentialConfigs(path.dirname(this.gitDir))
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
    const stateDirectory = path.dirname(this.gitDir)
    await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 })
    await assertOwnDirectory(stateDirectory)
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
 * What a GitHub-bound git command authenticates with: the GitHub fetch, the `ls-remote` that reads
 * GitHub's default branch, and the push to GitHub.
 */
export interface GitHubCredential {
  /** GitHub's bare https URL, or a test's stand-in for it. Never carries the token. */
  readonly url: string
  readonly token: string
  /** Told of each GitHub-bound command that fails, except on a lock of the mirror's own. */
  onFailure(): void
}

/** The origin a credential's header is scoped to when its URL has none of its own. */
const GITHUB_ORIGIN = 'https://github.com'

/** `mkdtemp`'s prefix for a credential file's directory; nothing else in the state directory starts so. */
const CREDENTIAL_DIR_PREFIX = '.canopy-github-credential-'
const CREDENTIAL_DIR_PATTERN = /^\.canopy-github-credential-[A-Za-z0-9]{6}$/

/**
 * The global-scope config a GitHub-bound command gets: the token as an `Authorization` header for
 * the remote's origin only, and an empty credential-helper list, so a 401 asks no helper (a
 * developer's keychain included) and git's prompt is off besides. A URL without an http(s) origin
 * (a test's local fixture) gets GitHub's, which it can never match. Every value is base64 or an
 * origin, so no byte of the token can end a line or a quoted section name.
 */
function credentialConfig(credential: GitHubCredential): string {
  let origin = GITHUB_ORIGIN
  try {
    const url = new URL(credential.url)
    if (url.protocol === 'https:' || url.protocol === 'http:') origin = url.origin
  } catch {
    // Not a URL: a local path.
  }
  const basic = Buffer.from(`x-access-token:${credential.token}`).toString('base64')
  return (
    `[http "${origin}/"]\n\textraheader = AUTHORIZATION: basic ${basic}\n` +
    `[credential]\n\thelper =\n`
  )
}

/**
 * Run `fn` with the path of a fresh config file holding the credential, then delete it. The file
 * is created exclusively, `0600`, in a new `mkdtemp` directory inside the state directory, which
 * {@link assertOwnDirectory} proves only this user can write: a path nobody else could have
 * created first or swapped for a link. A file a crash or a failed delete leaves behind is swept
 * before the next session ({@link GitHubMirror.exclusive}).
 */
async function withCredentialConfig<T>(
  stateDirectory: string,
  credential: GitHubCredential,
  fn: (configPath: string) => Promise<T>,
): Promise<T> {
  await assertOwnDirectory(stateDirectory)
  const dir = await fs.mkdtemp(path.join(stateDirectory, CREDENTIAL_DIR_PREFIX))
  try {
    const configPath = path.join(dir, 'config')
    const file = await fs.open(configPath, 'wx', 0o600)
    try {
      await file.writeFile(credentialConfig(credential))
    } finally {
      await file.close()
    }
    return await fn(configPath)
  } finally {
    // Never thrown: it would replace the command's own failure.
    await fs
      .rm(dir, { recursive: true, force: true })
      .catch((err: unknown) =>
        workerLogWarn(`Could not delete a credential file in ${dir}: ${getErrorMessage(err)}`),
      )
  }
}

/** Delete every credential directory {@link withCredentialConfig} left in `stateDirectory`. */
async function sweepCredentialConfigs(stateDirectory: string): Promise<void> {
  for (const name of await fs.readdir(stateDirectory)) {
    if (CREDENTIAL_DIR_PATTERN.test(name)) {
      await fs.rm(path.join(stateDirectory, name), { recursive: true, force: true })
    }
  }
}

/**
 * Whether git's own output, not a `remote:` line relayed from GitHub, says a lock file was
 * already there: the mirror's own housekeeping holds it, which says nothing about the credential.
 * @internal Exported for tests.
 */
export function isOwnLockFailure(message: string): boolean {
  return message
    .split('\n')
    .some(
      (line) => !/^\s*remote:/.test(line) && /Unable to create '.*\.lock': File exists/.test(line),
    )
}

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
   * Run one GitHub-bound command, `args` naming `credential.url` where git expects the remote. The
   * credential reaches it only through {@link withCredentialConfig}'s file, named by
   * `GIT_CONFIG_GLOBAL`, so it is in no argv and in no process's environment. No trace variable
   * reaches this git: trace2 prints config values. Its failure is reported to the credential
   * unless {@link isOwnLockFailure}.
   */
  private async githubBound(
    credential: GitHubCredential,
    args: string[],
    signal?: AbortSignal,
  ): Promise<string> {
    return withCredentialConfig(path.dirname(this.gitDir), credential, async (configPath) => {
      try {
        return await simpleGit({
          baseDir: this.gitDir,
          ...githubBoundGitOptions(),
          timeout: { block: this.timeoutMs },
          abort: signal,
        })
          .env({ ...githubBoundEnv(this.gitDir), GIT_CONFIG_GLOBAL: configPath })
          .raw(args)
      } catch (err) {
        if (!isOwnLockFailure(getErrorMessage(err))) credential.onFailure()
        throw err
      }
    })
  }

  /**
   * Bring `refs/heads/*` to exactly what GitHub holds. An empty mirror (every new instance) first
   * takes what `remote.git` already has, so GitHub sends only the difference; the GitHub fetch then
   * overwrites and prunes every ref that seeding set.
   */
  async fetchFromGitHub(credential: GitHubCredential, signal?: AbortSignal): Promise<void> {
    if ((await this.git(signal).raw(['for-each-ref', '--count=1', 'refs/heads/'])).trim() === '') {
      await this.seedFromRemoteGit(signal)
    }
    await this.githubBound(
      credential,
      [
        'fetch',
        '--prune',
        '--progress',
        '--no-write-fetch-head',
        '--end-of-options',
        credential.url,
        '+refs/heads/*:refs/heads/*',
      ],
      signal,
    )
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
    credential: GitHubCredential,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const out = await this.githubBound(
      credential,
      ['ls-remote', '--symref', '--end-of-options', credential.url, 'HEAD'],
      signal,
    )
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
   * the pinned `upload-pack`. Resolves with what the push did to GitHub's ref.
   */
  async pushToGitHub(
    credential: GitHubCredential,
    branch: string,
    sha: string,
    options: { lease?: string; signal?: AbortSignal; protectedBranches: readonly string[] },
  ): Promise<GitHubRefUpdate> {
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
    const githubDefault = await this.githubDefaultBranch(credential, options.signal)
    if (githubDefault !== null) protectedNames.push(githubDefault)
    const target = sanitizeBranchName(branch)
    if (protectedNames.some((name) => name === branch || sanitizeBranchName(name) === target)) {
      throw new RefusedPushError(branch, 'protected')
    }
    const staging = `${STAGING_PREFIX}${branch}`
    try {
      await this.fetchFromRemoteGit([`+${sha}:${staging}`], options.signal)
      const status = await this.githubBound(
        credential,
        [
          'push',
          '--porcelain',
          '--progress',
          ...(options.lease ? [`--force-with-lease=refs/heads/${branch}:${options.lease}`] : []),
          '--end-of-options',
          credential.url,
          `${sha}:refs/heads/${branch}`,
        ],
        options.signal,
      )
      return parsePushStatus(status, branch, sha)
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
 * What a push did to GitHub's `refs/heads/<branch>`. `from` is git's abbreviation of the old tip,
 * null for a new branch; `to` is the full SHA pushed.
 */
export type GitHubRefUpdate = { moved: false } | { moved: true; from: string | null; to: string }

/**
 * Read `refs/heads/<branch>`'s line from `git push --porcelain`'s stdout: `=` up to date, ` ` a
 * fast-forward (`old..new`), `+` a forced update (`old...new`), `*` a new branch. A rejected ref
 * (`!`) makes git exit non-zero before this runs. Output with no such line throws, rather than
 * report a push this did not see.
 * @internal Exported for tests.
 */
export function parsePushStatus(stdout: string, branch: string, sha: string): GitHubRefUpdate {
  for (const line of stdout.split('\n')) {
    const [flag, refs, summary] = line.split('\t')
    if (summary === undefined || !refs.endsWith(`:refs/heads/${branch}`)) continue
    if (flag === '=') return { moved: false }
    if (flag === '*') return { moved: true, from: null, to: sha }
    const range = /^([0-9a-f]+)\.\.\.?[0-9a-f]+/.exec(summary)
    if ((flag === ' ' || flag === '+') && range) return { moved: true, from: range[1], to: sha }
  }
  throw new Error(`git push reported no readable status for refs/heads/${branch}`)
}

/**
 * The network env (proxies, CA bundles, the C locale the push-rejection classifier needs), with
 * the repository named outright: a bare repository found from the working directory is refused
 * where `safe.bareRepository=explicit` is set.
 */
function mirrorEnv(gitDir: string): Record<string, string> {
  return { ...gitNetworkChildEnv(), GIT_DIR: gitDir }
}

/**
 * {@link mirrorEnv} for a GitHub-bound command: without any `GIT_TRACE*` variable, and with git's
 * terminal prompt off, so a refused credential fails rather than asking a developer's terminal.
 */
function githubBoundEnv(gitDir: string): Record<string, string> {
  const env = Object.entries(mirrorEnv(gitDir)).filter(([key]) => !key.startsWith('GIT_TRACE'))
  return { ...Object.fromEntries(env), GIT_TERMINAL_PROMPT: '0' }
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
