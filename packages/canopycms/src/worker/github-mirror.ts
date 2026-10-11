import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { simpleGit, type SimpleGit } from 'simple-git'

import { gitNetworkChildEnv } from '../git-manager'
import { getErrorMessage } from '../utils/error'
import {
  BundleHeaderError,
  BundleHeaderReader,
  hasOnlyHead,
  type BundleHeader,
} from './bundle-header'
import { runGit } from './git-process'
import {
  MaintenanceMutex,
  findCorruption,
  maintainMirror,
  objectStoreKiB,
  rebuildPaths,
  recoverRebuild,
  sweepLocksAndTemporaries,
  type MirrorCorruption,
} from './github-mirror-upkeep'
import {
  BranchPolicy,
  GatewayRefusalError,
  MAX_BRANCH_NAME_LENGTH,
  branchNameProblem,
} from './branch-policy'
import { gatewayLog, gatewayLogError, gatewayLogWarn, redactEgress } from './gateway-egress'
import {
  githubBoundGitOptions,
  mirrorGitOptions,
  mirrorPins,
  quarantinePins,
} from './shared-repo-git'

/**
 * The worker's private bare mirror of the GitHub repository, in a state directory the CMS Lambda
 * cannot reach. It and the quarantines beside it are the only repositories in which git ever runs
 * with the GitHub credential, and the state directory the only place the GitHub gateway runs git
 * at all. Every gateway git names a repository inside it, by `GIT_DIR` and working directory
 * alike, so no config or hook the Lambda writes is ever read by it; Lambda-written objects reach
 * it only inside a pushed bundle, checked in a quarantine. The credential reaches git only as a
 * per-command config file ({@link withCredentialConfig}).
 *
 * Objects cross the boundary as git bundles, never by a fetch or push against `remote.git`:
 * - **out:** a fetch bundles what the caller's `have` lacks into `outgoing/`, one pending bundle
 *   at a time ({@link GitHubMirror.openBundle});
 * - **in:** a pushed bundle is written to `incoming/`, its header read in node
 *   (worker/bundle-header.ts), and fetched, object-checked, into a fresh quarantine repository
 *   that borrows the mirror's objects through `objects/info/alternates`. The push to GitHub goes
 *   out from there. Pushed objects therefore never enter the mirror, whose objects come only
 *   from GitHub; the quarantine is deleted whole.
 *
 * `refs/heads/*` mirrors GitHub as of the last fetch. A cache: deleting it costs one fetch of the
 * whole repository from GitHub.
 *
 * One process owns it, and {@link GitHubMirror.exclusive} runs one session at a time, so a fetch's
 * `--prune` never meets a push half way, and the mirror's heads cannot move between a push's
 * reachability test and the push. It sweeps what a killed git left, rebuilds itself from GitHub
 * when it would lie, and runs maintenance beside sessions under a mutex of its own
 * (worker/github-mirror-upkeep.ts, whose module doc holds the lock order).
 *
 * Every transfer runs with `--progress`: the timeout is inactivity, and a quiet fetch of a whole
 * repository would otherwise be killed for its size. The connectivity walk after a fetch still
 * prints nothing (.claude/future-tasks/worker-github-mirror-limits.md).
 */
export class GitHubMirror {
  readonly gitDir: string
  private readonly incomingDir: string
  private readonly outgoingDir: string
  private tail: Promise<unknown> = Promise.resolve()
  private ingestTail: Promise<unknown> = Promise.resolve()
  private warnedSize = false
  private ready = false
  private swept = false
  private transferDirs: Promise<void> | null = null
  private pendingBundle: { id: string; file: string } | null = null
  private readonly maintenance = new MaintenanceMutex()
  private lastMaintenanceAt: number
  private corruption: MirrorCorruption = null
  /**
   * Changes whenever the mirror stops holding what the last GitHub fetch put there: it was
   * created anew, found corrupt, or a rebuild replaced it. A GitHub fetch is reused only within
   * the generation it completed in.
   */
  generation = 0
  private rebuildFailedAt = 0
  /** A sweep the maintenance mutex prevented, done at the next session start that can take it. */
  private sweepOwed = false

  /**
   * `maintenanceIntervalMs` (default {@link MAINTENANCE_INTERVAL_MS}) also delays the first run:
   * a mirror just fetched is in few packs.
   */
  constructor(
    private readonly stateDirectory: string,
    private readonly timeoutMs: number,
    private readonly maintenanceIntervalMs = MAINTENANCE_INTERVAL_MS,
  ) {
    this.lastMaintenanceAt = Date.now()
    this.gitDir = path.join(stateDirectory, 'github.git')
    this.incomingDir = path.join(stateDirectory, 'incoming')
    this.outgoingDir = path.join(stateDirectory, 'outgoing')
  }

  /**
   * Run `fn` with the mirror to itself, after every session started before it. The first session
   * of a gateway first clears what a killed one left ({@link sweepAtStart}), and any session first
   * does a sweep that is owed ({@link sweepIfOwed}). Creates the mirror if it is missing, and
   * checks it again (for corruption too) after any session that failed. Deletes any credential
   * file a killed or failed cleanup left: no session is running, so none is in use.
   */
  exclusive<T>(fn: (session: MirrorSession) => Promise<T>): Promise<T> {
    const start = async () => {
      try {
        if (!this.swept) {
          await this.sweepAtStart()
          this.swept = true
        }
        await this.sweepIfOwed()
        if (!this.ready) {
          await this.create()
          this.ready = true
        }
        await sweepCredentialConfigs(this.stateDirectory)
        await this.ensureTransferDirs()
        return await fn(new MirrorSession(this.gitDir, this.stateDirectory, this.timeoutMs))
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
   * Clear what a killed gateway left, before any git runs: finish or undo an interrupted rebuild,
   * then every lock and temporary in the mirror. Nothing in this process writes it yet:
   * maintenance starts only after a session. A git a stopped dev worker left running is not
   * covered (.claude/future-tasks/worker-mirror-detached-work-drain.md).
   */
  private async sweepAtStart(): Promise<void> {
    await fs.mkdir(this.stateDirectory, { recursive: true, mode: 0o700 })
    await assertOwnDirectory(this.stateDirectory)
    await recoverRebuild(this.gitDir)
    const removed = await sweepLocksAndTemporaries(this.gitDir)
    if (removed.length > 0) {
      gatewayLogWarn(
        `Removed what a stopped gateway left in the GitHub mirror: ${removed.join(', ')}`,
      )
    }
  }

  /**
   * Create the mirror, or recreate one that is not a readable bare repository, and record whether
   * an existing one is corrupt ({@link findCorruption}), which the next GitHub fetch's session
   * repairs ({@link heal}); until then the generation change keeps every caller off it.
   */
  private async create(): Promise<void> {
    await fs.mkdir(this.stateDirectory, { recursive: true, mode: 0o700 })
    await assertOwnDirectory(this.stateDirectory)
    if (!(await isBareRepository(this.gitDir))) {
      await fs.rm(this.gitDir, { recursive: true, force: true })
      await initMirror(this.gitDir)
      this.generation++
    }
    await assertOwnDirectory(this.gitDir)
    this.corruption = await findCorruption(this.gitDir, (args, stdin) =>
      runInRepo(this.gitDir, this.timeoutMs, args, { stdin }),
    )
    // No fetch's snapshot vouches for a corrupt mirror, so no caller uses it until a fetch rebuilds it.
    if (this.corruption !== null) this.generation++
  }

  /**
   * Refuse a session that cannot repair the mirror while it is corrupt: one without the credential
   * a rebuild fetches with.
   */
  assertUsable(): void {
    if (this.corruption !== null) {
      throw new GitHubTransientError(
        'mirror-corrupt',
        `The GitHub mirror needs rebuilding (${this.corruption}); the next fetch from GitHub does it`,
      )
    }
  }

  /**
   * Inside a GitHub fetch's session, rebuild a mirror {@link create} found corrupt, as a plain
   * call (the session is not re-entrant), waiting for maintenance to finish: the lock order is session, then the
   * maintenance mutex. The replacement is fetched whole from GitHub into `github.git.rebuild`, and
   * swapped in only once complete: the mirror is renamed to `.old`, `.rebuild` into its place, and
   * `.old` deleted ({@link recoverRebuild} finishes or undoes a swap a crash interrupted). No
   * quarantine is live while the session is held, so moving the objects it would borrow is safe.
   * After a failed rebuild, sessions answer transient for {@link REBUILD_BACKOFF_MS} rather than
   * fetch the whole repository again each.
   */
  async heal(session: MirrorSession, credential: GitHubCredential): Promise<void> {
    const reason = this.corruption
    if (reason === null) return
    if (Date.now() - this.rebuildFailedAt < REBUILD_BACKOFF_MS) this.assertUsable()
    const { rebuild, old } = rebuildPaths(this.gitDir)
    const release = await this.maintenance.acquire()
    try {
      await fs.rm(rebuild, { recursive: true, force: true })
      await initMirror(rebuild)
      await session.fetchFromGitHub(credential, undefined, rebuild)
      await fs.rm(old, { recursive: true, force: true })
      await fs.rename(this.gitDir, old)
      await fs.rename(rebuild, this.gitDir)
      await fs.rm(old, { recursive: true, force: true })
      this.corruption = null
      this.generation++
      gatewayLogWarn(`Rebuilt the GitHub mirror from GitHub: ${reason}`)
    } catch (err) {
      this.rebuildFailedAt = Date.now()
      await fs.rm(rebuild, { recursive: true, force: true }).catch(() => undefined)
      throw new GitHubTransientError(
        'mirror-corrupt',
        `The GitHub mirror needs rebuilding (${reason}), and the rebuild failed: ` +
          redactEgress(getErrorMessage(err)).trim(),
      )
    } finally {
      release()
    }
  }

  /**
   * The GitHub fetch, inside a session. A failure sweeps the mirror's locks and temporaries
   * ({@link sweepUnlessMaintained}), so it leaves no pack of its own behind; when git failed on
   * one of the mirror's own leftovers ({@link isOwnLockFailure}) and the sweep ran, the fetch is
   * tried once more. While maintenance runs, which holds such files live, nothing is swept, the
   * sweep is owed, and a leftover's failure is transient. Never waits for the mutex, so a push
   * never waits behind a repack.
   */
  async fetchFromGitHub(
    session: MirrorSession,
    credential: GitHubCredential,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await session.fetchFromGitHub(credential, signal)
      return
    } catch (err) {
      const swept = await this.sweepUnlessMaintained('Removed stale locks from the GitHub mirror')
      if (!isOwnLockFailure(getErrorMessage(err))) throw err
      if (!swept) {
        throw new GitHubTransientError(
          'github-fetch-failed',
          'The GitHub mirror is being maintained, and its fetch met a lock maintenance holds; ' +
            'retrying runs after it',
        )
      }
    }
    try {
      await session.fetchFromGitHub(credential, signal)
    } catch (err) {
      await this.sweepUnlessMaintained('Removed what a failed fetch left in the GitHub mirror')
      throw err
    }
  }

  /**
   * Inside a session, sweep the mirror's locks and temporaries ({@link sweepLocksAndTemporaries}),
   * logging what went under `label`, unless maintenance holds the mutex: then the sweep is owed.
   * Returns whether it swept.
   */
  private async sweepUnlessMaintained(label: string): Promise<boolean> {
    const release = this.maintenance.tryAcquire()
    if (release === null) {
      this.sweepOwed = true
      return false
    }
    try {
      const removed = await sweepLocksAndTemporaries(this.gitDir)
      if (removed.length > 0) gatewayLogWarn(`${label}: ${removed.join(', ')}`)
      this.sweepOwed = false
      return true
    } finally {
      release()
    }
  }

  /** At a session's start, the sweep a held mutex prevented, if it can take the mutex now. */
  private async sweepIfOwed(): Promise<void> {
    if (this.sweepOwed) {
      await this.sweepUnlessMaintained('Removed what an interrupted git left in the GitHub mirror')
    }
  }

  /**
   * After a completed GitHub fetch's session: warn once if the mirror has grown past
   * {@link MIRROR_SIZE_WARN_KIB}, and start maintenance, detached, at most once per maintenance
   * interval, unless the mutex is held (a rebuild, or maintenance itself).
   */
  async afterFetch(): Promise<void> {
    await this.warnIfLarge().catch((err: unknown) =>
      gatewayLogWarn(`Could not measure the GitHub mirror: ${getErrorMessage(err)}`),
    )
    if (Date.now() - this.lastMaintenanceAt < this.maintenanceIntervalMs) return
    const release = this.maintenance.tryAcquire()
    if (release === null) return
    this.lastMaintenanceAt = Date.now()
    void this.runMaintenance().finally(release)
  }

  /**
   * One maintenance run, holding the mutex; it never takes a session. A failed run owes a sweep
   * of what it left, and the next run waits a whole interval from this one's end.
   */
  private async runMaintenance(): Promise<void> {
    const started = Date.now()
    try {
      const { repacked } = await maintainMirror((args, { deadlineMs }) =>
        runInRepo(this.gitDir, deadlineMs, args, { deadlineMs }),
      )
      if (repacked) gatewayLog(`GitHub mirror repacked in ${Date.now() - started}ms`)
    } catch (err) {
      this.sweepOwed = true
      gatewayLogError(`GitHub mirror maintenance failed: ${getErrorMessage(err)}`)
    } finally {
      this.lastMaintenanceAt = Date.now()
    }
  }

  private async warnIfLarge(): Promise<void> {
    if (this.warnedSize) return
    const kib = await objectStoreKiB((args) => runInRepo(this.gitDir, this.timeoutMs, args))
    if (kib > MIRROR_SIZE_WARN_KIB) {
      this.warnedSize = true
      gatewayLogWarn(
        `The worker's GitHub mirror (${this.gitDir}) holds ${Math.round(kib / 1024)} MiB of ` +
          `objects, on the instance's root volume. See "The worker instance" in ` +
          `docs/deploying-to-aws.md for the headroom it assumes.`,
      )
    }
  }

  /**
   * Empty `incoming/` and `outgoing/` of what an earlier gateway left, once per gateway: after
   * that, everything in them belongs to a transfer of this one's, which removes its own, so a
   * later call only re-creates one that has gone (the state directory removed under it).
   */
  private async ensureTransferDirs(): Promise<void> {
    this.transferDirs ??= (async () => {
      await fs.mkdir(this.stateDirectory, { recursive: true, mode: 0o700 })
      await assertOwnDirectory(this.stateDirectory)
      for (const dir of [this.incomingDir, this.outgoingDir]) {
        await fs.rm(dir, { recursive: true, force: true })
      }
    })().catch((err: unknown) => {
      this.transferDirs = null
      throw err
    })
    await this.transferDirs
    for (const dir of [this.incomingDir, this.outgoingDir]) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    }
  }

  /**
   * git for `check-ref-format`, run in the state directory like every other gateway git. It reads
   * the repository's config, as any git does, and its refs only to expand `@{-N}`, which
   * `assertPlainBranchName` refuses.
   */
  async checkGit(): Promise<SimpleGit> {
    await this.ensureTransferDirs()
    return simpleGit({ baseDir: this.stateDirectory }).env(mirrorEnv(this.gitDir))
  }

  /** Where a session writes a new outgoing bundle: a fresh name, never a caller's. */
  async outgoingBundlePath(): Promise<string> {
    await this.ensureTransferDirs()
    return path.join(this.outgoingDir, `${randomBytes(16).toString('hex')}.bundle`)
  }

  /**
   * Make `file` the one pending outgoing bundle, or none, deleting the one it replaces (never an
   * opened one), so a loop of fetches never fills the state directory. Returns the id that opens it: a
   * key into this object, never a path.
   */
  async setPendingBundle(file: string | null): Promise<string | null> {
    const replaced = this.pendingBundle
    this.pendingBundle = file === null ? null : { id: randomBytes(16).toString('hex'), file }
    if (replaced !== null) await fs.rm(replaced.file, { force: true })
    return this.pendingBundle?.id ?? null
  }

  /**
   * The pending bundle `id` names, readable once: it is no longer pending once opened, so a later
   * fetch never deletes it, and its file is deleted when the stream closes.
   * Throws {@link GitHubTransientError} for an id that is not the pending bundle's.
   */
  async openBundle(id: string): Promise<Readable> {
    const pending = this.pendingBundle
    const gone = () =>
      new GitHubTransientError(
        'bundle-gone',
        `The bundle ${JSON.stringify(id.slice(0, 64))} is not available: a later fetch replaced ` +
          `it, or it was already read. Fetch again.`,
      )
    if (pending === null || pending.id !== id) throw gone()
    this.pendingBundle = null
    let handle: fs.FileHandle
    try {
      handle = await fs.open(pending.file, 'r')
    } catch {
      throw gone()
    }
    const stream = handle.createReadStream()
    stream.once('close', () => {
      void fs.rm(pending.file, { force: true }).catch(() => undefined)
    })
    return stream
  }

  /**
   * Receive a pushed bundle into a directory of its own under `incoming/`, refusing it as it
   * arrives (header, size), run `fn` with it, then delete the directory. One at a time, so pushed
   * bundles hold at most one cap's worth of disk, plus about as much again for the quarantine's
   * copy of the pack.
   */
  ingest<T>(
    body: Readable,
    expected: { sha: string; branch: string },
    maxBytes: number,
    fn: (bundle: ReceivedBundle) => Promise<T>,
  ): Promise<T> {
    const start = async () => {
      await this.ensureTransferDirs()
      const dir = await fs.mkdtemp(path.join(this.incomingDir, 'push-'))
      try {
        const file = path.join(dir, 'bundle')
        const header = await receiveBundle(body, file, expected, maxBytes)
        return await fn({ dir, file, header })
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    }
    const run = this.ingestTail.then(start, start)
    this.ingestTail = run.catch(() => undefined)
    return run
  }
}

/** A pushed bundle, received and its header read: {@link GitHubMirror.ingest}. */
export interface ReceivedBundle {
  /** The directory it and its quarantine live in, deleted after the push. */
  readonly dir: string
  readonly file: string
  readonly header: BundleHeader
}

/**
 * Past this the mirror is using a large share of the worker's default 8 GiB root volume, which
 * also holds the OS, Node and the log.
 */
const MIRROR_SIZE_WARN_KIB = 2 * 1024 * 1024

/** How often maintenance may run. */
const MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000

/** How long sessions answer transient after a failed rebuild, rather than retry it each. */
const REBUILD_BACKOFF_MS = 5 * 60 * 1000

/** Where a quarantine holds the pushed commit while it is checked and pushed. */
const STAGING_PREFIX = 'refs/canopy/outgoing/'

/**
 * A push or fetch the gateway could not complete for a reason a later attempt can clear: GitHub
 * unreachable, a bundle that did not arrive whole or valid, a prerequisite GitHub no longer has,
 * a bundle already gone. The task retries it. The code says where it failed, not whose doing it
 * was: a `github-fetch-failed` or a `mirror-corrupt` can each follow a GitHub-bound git that
 * failed, and only that arms a credential re-read (`LocalGitHubGateway.credentialed`).
 */
export class GitHubTransientError extends Error {
  constructor(
    readonly code:
      | 'github-fetch-failed'
      | 'bundle-rejected'
      | 'prerequisite-gone'
      | 'bundle-gone'
      | 'mirror-corrupt'
      | 'objects-still-needed'
      | 'ref-kept-moving'
      | 'default-branch-unread',
    message: string,
  ) {
    super(message)
    this.name = 'GitHubTransientError'
  }
}

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
 * (a test's local fixture) gets GitHub's, which it can never match. The token is written only
 * base64-encoded, so none of its bytes can end a line or a quoted section name.
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
        gatewayLogWarn(`Could not delete a credential file in ${dir}: ${getErrorMessage(err)}`),
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
 * Whether git's own output, not a `remote:` line relayed from GitHub, says a lock file or
 * `packed-refs.new` was already there: the mirror's own housekeeping holds it, or a killed git
 * left it, which says nothing about the credential.
 * @internal Exported for tests.
 */
export function isOwnLockFailure(message: string): boolean {
  return message
    .split('\n')
    .some(
      (line) =>
        !/^\s*remote:/.test(line) &&
        (/Unable to create '.*\.lock': File exists/.test(line) ||
          /unable to create file .*packed-refs\.new: File exists/.test(line)),
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
 * A push the worker never makes: to a name that is not a plain branch name, to a protected branch
 * (`BranchPolicy`), to a settings branch under a lease, or of an object that is not a commit.
 */
export class RefusedPushError extends GatewayRefusalError {
  constructor(
    branch: string,
    reason: 'invalid' | 'protected' | 'settings' | 'not-a-commit',
    sha?: string,
  ) {
    super(
      'push',
      branch,
      reason,
      reason === 'invalid'
        ? `Refusing to push ${JSON.stringify(branch)} to GitHub: it is not a valid branch name.`
        : reason === 'protected'
          ? `Refusing to push "${branch}" to GitHub: it is protected (the base branch, GitHub's ` +
            `default branch, or a name protectedBranches lists), which the CanopyCMS worker never ` +
            `pushes. Nothing in CanopyCMS queues such a push; find out what wrote this task.`
          : reason === 'settings'
            ? `Refusing to push "${branch}" to GitHub under a lease: a settings branch only ever ` +
              `fast-forwards. Find out what set a history-rewrite marker on it.`
            : `Refusing to push "${branch}" to GitHub: ${sha ?? 'the object asked for'} is not a ` +
              `commit, and a branch can only point at one. Find out what put it at ` +
              `refs/heads/${branch} in remote.git.`,
    )
    this.name = 'RefusedPushError'
  }
}

/**
 * Throw {@link RefusedPushError} (or, for another `operation`, {@link GatewayRefusalError}) unless
 * `branch` is a plain branch name: one `branchNameProblem` passes and
 * `git check-ref-format --branch` accepts unchanged. That rules out a `:` (git would read what
 * follows it in a refspec as another destination), `..`, `^`, `~`, `@{`, spaces and a leading
 * `-`, so `refs/heads/<branch>` is exactly the ref a push names. `check-ref-format --branch` takes
 * exactly one argument and refuses `--end-of-options`, which is why it alone goes without one.
 * `git` is the caller's instance: the gateway's runs in its state directory.
 */
export async function assertPlainBranchName(
  branch: string,
  git: SimpleGit = simpleGit(),
  operation: 'push' | 'delete' | 'pull-request' = 'push',
  /** False for a name the gateway only passes on, never acts on: git's rules, its length, no leading `-`. */
  shape = true,
): Promise<void> {
  const invalid = (why: string) =>
    operation === 'push'
      ? new RefusedPushError(branch, 'invalid')
      : new GatewayRefusalError(
          operation,
          branch,
          'invalid',
          `Refusing ${JSON.stringify(branch)}: it is not a valid branch name (${why}).`,
        )
  // A leading `-` is refused whatever `shape` says: git would read it as an option.
  const problem = shape
    ? branchNameProblem(branch)
    : branch.startsWith('-')
      ? "it starts with '-'"
      : branch.length > MAX_BRANCH_NAME_LENGTH
        ? `it is longer than ${MAX_BRANCH_NAME_LENGTH} characters`
        : null
  if (problem !== null) throw invalid(problem)
  let normalized: string
  try {
    normalized = (await git.raw(['check-ref-format', '--branch', branch])).trim()
  } catch (err) {
    // Only git's own verdict is a refusal; a failure to run git at all is transient.
    if (/is not a valid branch name/.test(getErrorMessage(err))) {
      throw invalid('git check-ref-format refuses it')
    }
    throw err
  }
  // `@{-1}` and the like resolve to some other name.
  if (normalized !== branch) throw invalid('git resolves it to another name')
}

/** What one {@link GitHubMirror.exclusive} call may do. */
export class MirrorSession {
  constructor(
    private readonly gitDir: string,
    private readonly stateDirectory: string,
    private readonly timeoutMs: number,
  ) {}

  /** simple-git in `repo`: the mirror, or a quarantine of this session's. */
  private git(signal?: AbortSignal, repo = this.gitDir): SimpleGit {
    return simpleGit({
      baseDir: repo,
      ...mirrorGitOptions(),
      timeout: { block: this.timeoutMs },
      abort: signal,
    }).env(mirrorEnv(repo))
  }

  /** git with `stdin` fed to it, in `repo` under `config` (the mirror's pins by default). */
  private run(
    args: readonly string[],
    options: { stdin?: string; repo?: string; config?: string[]; signal?: AbortSignal } = {},
  ): Promise<string> {
    return runInRepo(options.repo ?? this.gitDir, this.timeoutMs, args, options)
  }

  /**
   * Run one GitHub-bound command in `repo`, `args` naming `credential.url` where git expects the
   * remote. The credential reaches it only through {@link withCredentialConfig}'s file, named by
   * `GIT_CONFIG_GLOBAL`, so it is in no argv and in no process's environment. No trace variable
   * reaches this git: trace2 can print config values. Its failure is reported to the credential
   * unless {@link isOwnLockFailure}.
   */
  private async githubBound(
    credential: GitHubCredential,
    args: string[],
    signal?: AbortSignal,
    repo = this.gitDir,
  ): Promise<string> {
    return withCredentialConfig(this.stateDirectory, credential, async (configPath) => {
      try {
        return await simpleGit({
          baseDir: repo,
          ...githubBoundGitOptions(),
          timeout: { block: this.timeoutMs },
          abort: signal,
        })
          .env({ ...githubBoundEnv(repo), GIT_CONFIG_GLOBAL: configPath })
          .raw(args)
      } catch (err) {
        if (!isOwnLockFailure(getErrorMessage(err))) credential.onFailure()
        throw err
      }
    })
  }

  /**
   * Bring `refs/heads/*` of `repo` (the mirror, or a rebuild's replacement) to exactly what GitHub
   * holds. Sessions fetch through {@link GitHubMirror.fetchFromGitHub}, which cleans up after it.
   */
  async fetchFromGitHub(
    credential: GitHubCredential,
    signal?: AbortSignal,
    repo = this.gitDir,
  ): Promise<void> {
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
      repo,
    )
  }

  /** Every branch GitHub had at the last fetch, mapped to its tip. */
  async heads(): Promise<Map<string, string>> {
    const out = await this.git().raw([
      'for-each-ref',
      '--format=%(objectname) %(refname)',
      '--end-of-options',
      'refs/heads/',
    ])
    const heads = new Map<string, string>()
    for (const line of out.split('\n')) {
      const space = line.indexOf(' ')
      if (space === -1) continue
      heads.set(line.slice(space + 1 + 'refs/heads/'.length), line.slice(0, space))
    }
    return heads
  }

  /**
   * Bundle every branch into `file`, less what `have` already holds: each ID the mirror has as a
   * commit is excluded with its history, and any other ID is ignored. False, with no file, when
   * that leaves nothing to send. Each ID is validated before it reaches here, since rev-list's
   * `--stdin` honours a pseudo-option such as `--all`.
   */
  async createBundle(
    have: readonly string[],
    file: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const types = await this.objectTypes(have)
    const exclusions = have.filter((id) => types.get(id) === 'commit')
    try {
      await this.run(
        ['bundle', 'create', '--progress', '--end-of-options', file, '--branches', '--stdin'],
        { stdin: exclusions.map((id) => `^${id}\n`).join(''), signal },
      )
      return true
    } catch (err) {
      await fs.rm(file, { force: true })
      await fs.rm(`${file}.lock`, { force: true })
      if (/Refusing to create empty bundle/.test(getErrorMessage(err))) return false
      throw err
    }
  }

  /**
   * Each of `ids` mapped to its object type in `repo`, or to `missing`, from one
   * `cat-file --batch-check`, which prints `<id> missing` for an absent object where `cat-file -t`
   * shares exit 128 with every other failure. Every ID must already be validated.
   */
  async objectTypes(ids: readonly string[], repo = this.gitDir): Promise<Map<string, string>> {
    const types = new Map<string, string>()
    if (ids.length === 0) return types
    const lines = (
      await this.run(
        ['cat-file', '--batch-check=%(objectname) %(objecttype)', '--end-of-options'],
        {
          stdin: ids.map((id) => `${id}\n`).join(''),
          repo,
        },
      )
    ).split('\n')
    ids.forEach((id, i) => {
      const line = lines[i] ?? ''
      if (line === `${id} missing`) types.set(id, 'missing')
      else if (line.startsWith(`${id} `)) types.set(id, line.slice(id.length + 1))
      else throw new Error(`git cat-file printed no line for ${id}`)
    })
    return types
  }

  /**
   * Whether a GitHub branch contained the commit `sha` at the last fetch. Only for a commit:
   * `--contains` exits 129 on a missing or non-commit object.
   */
  async reachableFromHeads(sha: string): Promise<boolean> {
    const found = await this.git().raw([
      'for-each-ref',
      '--count=1',
      '--format=%(refname)',
      `--contains=${sha}`,
      '--end-of-options',
      'refs/heads/',
    ])
    return found.trim() !== ''
  }

  /** Of `prerequisites`, the commits a GitHub branch contained at the last fetch. */
  async usablePrerequisites(prerequisites: readonly string[]): Promise<string[]> {
    const unique = [...new Set(prerequisites)]
    const types = await this.objectTypes(unique)
    const usable: string[] = []
    for (const id of unique) {
      if (types.get(id) === 'commit' && (await this.reachableFromHeads(id))) usable.push(id)
    }
    return usable
  }

  /**
   * Whether every one of `commits` is reachable from one of `tips`, in ONE walk: rev-list fed the
   * commits and a `^<tip>` per tip lists what the tips do not reach, so empty output means all
   * are reached (several `--contains` would mean "any", not "all"). Only for commits: rev-list
   * passes a tree or blob ID silently.
   */
  private async allReachable(
    commits: readonly string[],
    tips: readonly string[],
  ): Promise<boolean> {
    if (commits.length === 0) return true
    const out = await this.run(['rev-list', '--stdin', '--max-count=1', '--end-of-options'], {
      stdin: [...commits, ...tips.map((tip) => `^${tip}`)].map((line) => `${line}\n`).join(''),
    })
    return out.trim() === ''
  }

  /**
   * The branch GitHub's HEAD names, or null for a repository with none (empty, or HEAD unborn). A
   * failure to reach GitHub throws, so a push that cannot learn it does not happen.
   */
  async githubDefaultBranch(
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

  /**
   * Take a received bundle into a fresh quarantine repository beside it, returning the
   * quarantine's path, with `sha` there as a commit. In order:
   * 1. each prerequisite must be a commit the mirror holds, reachable from one of `heads` (the
   *    branches GitHub had at this session's fetch): one `cat-file --batch-check`, then one walk;
   * 2. the quarantine borrows the mirror's objects through `objects/info/alternates`, with the
   *    mirror's pins except `core.alternateRefsCommand` ({@link quarantinePins});
   * 3. `fetch` of the bundle's one head into a staging ref, checking every object, by a refspec
   *    built from the validated branch, never from the bundle;
   * 4. the staging ref must be `sha`, and `sha` a commit.
   * A refusal is {@link GitHubTransientError} (`bundle-rejected`, or `prerequisite-gone` for a
   * prerequisite GitHub no longer has), except a non-commit `sha`, which is
   * {@link RefusedPushError}. Nothing here writes the mirror.
   */
  async quarantine(
    bundle: ReceivedBundle,
    expected: { sha: string; branch: string },
    heads: ReadonlyMap<string, string>,
    signal?: AbortSignal,
  ): Promise<string> {
    const { prerequisites } = bundle.header
    const types = await this.objectTypes(prerequisites)
    if (prerequisites.some((id) => types.get(id) === 'missing')) {
      throw new GitHubTransientError(
        'prerequisite-gone',
        `The bundle for ${expected.branch} builds on a commit GitHub no longer has. Retrying ` +
          `sends a new one.`,
      )
    }
    if (prerequisites.some((id) => types.get(id) !== 'commit')) {
      throw new GitHubTransientError(
        'bundle-rejected',
        'Refusing the bundle: a prerequisite is not a commit',
      )
    }
    if (!(await this.allReachable(prerequisites, [...heads.values()]))) {
      throw new GitHubTransientError(
        'prerequisite-gone',
        `The bundle for ${expected.branch} builds on a commit no GitHub branch contains any more. ` +
          `Retrying sends a new one.`,
      )
    }

    const repo = path.join(bundle.dir, 'repo.git')
    await fs.mkdir(repo, { mode: 0o700 })
    await this.run(['init', '--quiet', '--bare', '--end-of-options'], {
      repo,
      config: quarantinePins(),
    })
    await fs.writeFile(
      path.join(repo, 'objects', 'info', 'alternates'),
      `${path.join(this.gitDir, 'objects')}\n`,
      { mode: 0o600 },
    )
    const staging = `${STAGING_PREFIX}${expected.branch}`
    try {
      await this.run(
        [
          'fetch',
          '--progress',
          '--no-write-fetch-head',
          '--end-of-options',
          bundle.file,
          `refs/heads/${expected.branch}:${staging}`,
        ],
        {
          repo,
          // The severity pins are depth: index-pack already errors on these by default.
          config: [
            ...quarantinePins(),
            'fetch.fsckObjects=true',
            'fetch.fsck.hasDot=error',
            'fetch.fsck.hasDotdot=error',
            'fetch.fsck.hasDotgit=error',
          ],
          signal,
        },
      )
    } catch (err) {
      throw new GitHubTransientError(
        'bundle-rejected',
        `Refusing the bundle for ${expected.branch}: ${redactEgress(getErrorMessage(err)).trim()}`,
      )
    }
    const staged = (
      await this.git(signal, repo).raw(['rev-parse', '--verify', '--end-of-options', staging])
    ).split('\n')[0]
    if (staged !== expected.sha) {
      throw new GitHubTransientError(
        'bundle-rejected',
        `Refusing the bundle for ${expected.branch}: its head is not ${expected.sha}`,
      )
    }
    if ((await this.objectTypes([expected.sha], repo)).get(expected.sha) !== 'commit') {
      throw new RefusedPushError(expected.branch, 'not-a-commit', expected.sha)
    }
    return repo
  }

  /**
   * Push exactly `sha` from `repo` (the mirror, or a quarantine holding it) to GitHub's
   * `refs/heads/<branch>`. `lease` is the commit GitHub must still be at for the push to replace
   * it (`--force-with-lease`); without one the push is an ordinary fast-forward. Resolves with
   * what the push did to GitHub's ref.
   *
   * Validation and `policy` are here, at the one place every GitHub push (plain or under a lease)
   * goes through, so no caller can skip them. When `policy` needs GitHub's default branch read
   * afresh, it is read here, in this session, from the repository the push goes to. A bundle's quarantine fetch
   * names `branch` first, so the gateway validates it before the ingest too (`pushOnce`).
   */
  async pushToGitHub(
    credential: GitHubCredential,
    branch: string,
    sha: string,
    options: {
      lease?: string
      signal?: AbortSignal
      repo?: string
      policy: BranchPolicy
      /** Called once the push is allowed, just before git pushes. */
      onPushing?: () => void
    },
  ): Promise<GitHubRefUpdate> {
    for (const id of [sha, ...(options.lease === undefined ? [] : [options.lease])]) {
      if (!isObjectId(id)) throw new Error(`Not a commit ID: ${JSON.stringify(id)}`)
    }
    await assertPlainBranchName(branch, this.git())
    await options.policy.assertPushAllowed(
      branch,
      options.lease,
      // Unknown, the policy cannot decide: neither a refusal nor a rejected push, but transient.
      () =>
        this.githubDefaultBranch(credential, options.signal).catch((err: unknown) => {
          throw new GitHubTransientError(
            'default-branch-unread',
            `Could not read GitHub's default branch before pushing ${branch}: ` +
              redactEgress(getErrorMessage(err)).trim(),
          )
        }),
      (reason) => new RefusedPushError(branch, reason),
    )
    options.onPushing?.()
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
      options.repo,
    )
    return parsePushStatus(status, branch, sha)
  }
}

/**
 * Write a pushed bundle to `file` as it arrives, refusing it as soon as it cannot be accepted:
 * past `maxBytes`, or with a header that is not exactly one head, `<sha> refs/heads/<branch>`
 * (worker/bundle-header.ts). Holds at most the header's bounds, plus one chunk, in memory.
 */
async function receiveBundle(
  body: Readable,
  file: string,
  expected: { sha: string; branch: string },
  maxBytes: number,
): Promise<BundleHeader> {
  const rejected = (reason: string) =>
    new GitHubTransientError(
      'bundle-rejected',
      `Refusing the bundle for ${expected.branch}: ${reason}`,
    )
  const out = await fs.open(file, 'wx', 0o600)
  const reader = new BundleHeaderReader('refuse')
  let header: BundleHeader | null = null
  let total = 0
  try {
    for await (const chunk of body) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      total += bytes.length
      if (total > maxBytes) throw rejected(`it is larger than ${maxBytes} bytes`)
      if (header === null) {
        header = reader.push(bytes)?.header ?? null
        if (header !== null && !hasOnlyHead(header, expected.sha, expected.branch)) {
          throw rejected(`its one head must be ${expected.sha} refs/heads/${expected.branch}`)
        }
      }
      await out.write(bytes)
    }
  } catch (err) {
    if (err instanceof GitHubTransientError) throw err
    if (err instanceof BundleHeaderError)
      throw rejected(err.message.replace(/^Refusing the bundle: /, ''))
    throw rejected(`it did not arrive whole (${getErrorMessage(err)})`)
  } finally {
    await out.close()
  }
  if (header === null) throw rejected('it ends before its header does')
  return header
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
 * the repository named outright, since a bare repository found from the working directory is
 * refused where `safe.bareRepository=explicit` is set. No object is ever fetched lazily from a
 * promisor remote, and no `refs/replace/*` changes what any command sees.
 */
function mirrorEnv(gitDir: string): Record<string, string> {
  return {
    ...gitNetworkChildEnv(),
    GIT_DIR: gitDir,
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
  }
}

/**
 * {@link mirrorEnv} for a GitHub-bound command: without any `GIT_TRACE*` variable, and with git's
 * terminal prompt off, so a refused credential fails rather than asking a developer's terminal.
 */
function githubBoundEnv(gitDir: string): Record<string, string> {
  const env = Object.entries(mirrorEnv(gitDir)).filter(([key]) => !key.startsWith('GIT_TRACE'))
  return { ...Object.fromEntries(env), GIT_TERMINAL_PROMPT: '0' }
}

/** A full SHA-1 or SHA-256 object ID, so nothing else can reach a refspec or rev-list's stdin. */
export function isObjectId(value: string): boolean {
  return (value.length === 40 || value.length === 64) && /^[0-9a-f]+$/.test(value)
}

async function isBareRepository(gitDir: string): Promise<boolean> {
  try {
    await fs.access(gitDir)
    // rev-parse echoes `--end-of-options`, so only the first line is the answer.
    const out = await simpleGit({ baseDir: gitDir })
      .env(mirrorEnv(gitDir))
      .raw(['rev-parse', '--is-bare-repository', '--end-of-options'])
    return out.split('\n')[0] === 'true'
  } catch {
    return false
  }
}

/**
 * Create an empty bare repository at `gitDir` under the mirror's pins, with loose and packed refs
 * whatever a user's config defaults to: the sweeps know that format's leftovers.
 */
async function initMirror(gitDir: string): Promise<void> {
  await fs.mkdir(gitDir, { mode: 0o700 })
  await simpleGit({ baseDir: gitDir, ...mirrorGitOptions() })
    .env(mirrorEnv(gitDir))
    .raw(['-c', 'init.defaultRefFormat=files', 'init', '--quiet', '--bare', '--end-of-options'])
}

/** git in `repo`, one of the gateway's own, under `config` (the mirror's pins by default). */
function runInRepo(
  repo: string,
  timeoutMs: number,
  args: readonly string[],
  options: { stdin?: string; config?: string[]; signal?: AbortSignal; deadlineMs?: number } = {},
): Promise<string> {
  return runGit(args, {
    cwd: repo,
    env: mirrorEnv(repo),
    config: options.config ?? mirrorPins(),
    stdin: options.stdin,
    inactivityTimeoutMs: timeoutMs,
    deadlineMs: options.deadlineMs,
    signal: options.signal,
  })
}
