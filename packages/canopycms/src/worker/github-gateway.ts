import fs from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import type { Octokit, RestEndpointMethodTypes } from '@octokit/rest'

import {
  createCanopyOctokit,
  createOrUpdatePullRequest,
  type CreateOrUpdatePullRequestParams,
} from '../github-service'
import { getErrorMessage } from '../utils/error'
import { isStaleLeaseRejection, workflowPushRefusalFile } from '../utils/git'
import { isTransientAuthFailure, type ResolvedGitHubAuth } from './github-auth'
import {
  GitHubMirror,
  GitHubTransientError,
  RefusedPushError,
  assertPlainBranchName,
  isObjectId,
  type GitHubCredential,
  type GitHubRefUpdate,
  type MirrorSession,
  type ReceivedBundle,
} from './github-mirror'
import { BranchPolicy, GatewayRefusalError, assertPullRequestText } from './branch-policy'
import {
  gatewayLog,
  gatewayLogError,
  gatewayLogWarn,
  redactEgress,
  redactError,
  redactValue,
  registerLiveSecret,
} from './gateway-egress'

/** What a {@link GitHubGateway.fetch} brought back. */
export interface GitHubFetchResult {
  /** Every GitHub branch, mapped to its tip, as this fetch left the mirror. */
  refs: ReadonlyMap<string, string>
  /**
   * Opens ({@link GitHubGateway.openBundle}) a bundle of every branch, less the commits in the
   * request's `have` and their history; null when that leaves nothing to send.
   */
  bundleId: string | null
}

/** The most `have` IDs one fetch takes. */
export const MAX_FETCH_HAVE = 10_000

/** How long a completed GitHub fetch is reused: one sync cycle's fetch, reconcile and settings push. */
const FETCH_COALESCE_MS = 30_000

/**
 * What a GitHub fetch's session saw, so a later session can tell whether the mirror still holds
 * GitHub as that fetch left it: the mirror's {@link GitHubMirror.generation} once it fetched, and
 * how many pushes the gateway had started when it began.
 */
interface FetchSnapshot {
  generation: number
  pushes: number
}

/** A GitHub fetch operations join ({@link LocalGitHubGateway.joinGitHubFetch}). */
interface GitHubFetchJob {
  readonly done: Promise<FetchSnapshot>
  failed: boolean
  /** When it succeeded; null while it runs. */
  completedAt: number | null
  /** Set when it succeeded. */
  snapshot: FetchSnapshot | null
}

/**
 * The longest an operation waits for a credential re-read in flight before it goes on with the
 * credential it has. A provider can take 87 s for one `getSecret`, and an operation that waited it
 * out would die at the task deadline for nothing; the task's retry still sees a rotated token, and
 * a re-read a hostile worker armed cannot hold every push for its length.
 */
const REFRESH_JOIN_CAP_MS = 15_000

/** The most prerequisites one push names. */
const MAX_PUSH_PREREQUISITES = 3

/** The default cap on a pushed bundle, in bytes. */
const DEFAULT_MAX_BUNDLE_BYTES = 1024 * 1024 * 1024

export interface GitHubPushRequest {
  branch: string
  /** The commit to put at `refs/heads/<branch>` on GitHub, already in remote.git. */
  sha: string
  /** The commit GitHub must still be at for the push to replace it (`--force-with-lease`). */
  lease?: string
  /**
   * At most {@link MAX_PUSH_PREREQUISITES} commits the caller would build a bundle of the branch
   * on, so an answer of `need-objects` can say which of them the gateway can use.
   */
  prerequisites: readonly string[]
}

/**
 * What a push did to GitHub's ref, and whether it got there by the plain retry after GitHub
 * refused a stale lease, which proves GitHub was not at the lease's commit.
 */
export type GitHubPushOutcome = GitHubRefUpdate & { pastStaleLease: boolean }

/**
 * A push's answer: `pushed`, or `need-objects` when no GitHub branch contains `sha` and the caller
 * must send it as a bundle built on `usable`, the request's prerequisites a GitHub branch
 * contains (none, when empty).
 */
export type GitHubPushAnswer =
  | ({ kind: 'pushed' } & GitHubPushOutcome)
  | { kind: 'need-objects'; usable: readonly string[] }

/**
 * A push to GitHub failed: `rejected` on the first attempt, `rejected-after-stale-lease` on the
 * plain retry after GitHub refused a stale lease. The message is the failure's own: git's output,
 * for a refusal, which the task runner classifies. A {@link RefusedPushError} from the first
 * attempt is thrown as itself.
 */
export class GitHubPushError extends Error {
  constructor(
    readonly kind: 'rejected' | 'rejected-after-stale-lease',
    message: string,
  ) {
    super(message)
    this.name = 'GitHubPushError'
  }
}

/** A moved ref for a log line: `<old7>..<new7>`, or `new branch at <new7>`. */
export function describeMove(update: Extract<GitHubRefUpdate, { moved: true }>): string {
  const to = update.to.slice(0, 7)
  return update.from === null ? `new branch at ${to}` : `${update.from.slice(0, 7)}..${to}`
}

/** The fields of a pull request the worker reads. */
export type GitHubPullRequest = Pick<
  RestEndpointMethodTypes['pulls']['get']['response']['data'],
  'merged' | 'merged_at' | 'state' | 'node_id'
>

export type GitHubCreateOrUpdatePullRequest = Omit<
  CreateOrUpdatePullRequestParams,
  'octokit' | 'owner' | 'repo' | 'signal'
>

/**
 * Everything the worker does with GitHub, and the only place the credential and Octokit are used.
 * Octokit errors propagate with their status, headers and response data, so the task runner's
 * classifiers read them as they would Octokit's own; what it returns, throws and logs is first
 * scrubbed of the credential (worker/gateway-egress.ts, which names its exceptions). What it
 * refuses to do, whatever it is asked, is worker/branch-policy.ts's, and throws
 * `GatewayRefusalError`. The gateway re-reads its own credential after a failure
 * (`LocalGitHubGateway.credentialed`); the worker never asks it to.
 */
export interface GitHubGateway {
  /**
   * At startup, before anything uses the credential: prove a GitHub App credential works, refuse
   * a state directory the Lambda could write, and create the mirror. Runs once; every later call
   * answers the first one's outcome, a failure being the gateway's fatal error.
   */
  prepare(): Promise<void>
  /**
   * Whether the gateway is ready, waiting for a `prepare()` under way (until `signal` aborts), and
   * what the worker reports of it.
   */
  health(signal?: AbortSignal): Promise<GitHubGatewayHealth>
  /** GitHub's default branch. */
  defaultBranch(signal?: AbortSignal): Promise<string>
  /** Whether `branch` is in the gateway's protected set (worker/branch-policy.ts). */
  isProtectedBranch(branch: string, signal?: AbortSignal): Promise<boolean>
  /**
   * Fetch every GitHub branch, and answer with all of them and a bundle of the commits `have`
   * lacks. `have` is the caller's own tips, at most {@link MAX_FETCH_HAVE} object IDs; any the
   * gateway does not hold as a commit is ignored. A new fetch replaces a bundle not yet opened.
   * `onProgress` is told of each sign of life from the gateway's git while the caller waits.
   */
  fetch(
    request: { have: readonly string[] },
    signal?: AbortSignal,
    onProgress?: () => void,
  ): Promise<GitHubFetchResult>
  /**
   * The bundle a fetch answered with, readable once. Throws {@link GitHubTransientError}
   * (`bundle-gone`) when a later fetch replaced it or it was already opened.
   */
  openBundle(bundleId: string): Promise<Readable>
  /**
   * Push `sha` to GitHub's `refs/heads/<branch>`, after fetching GitHub. Without `bundle`, it
   * pushes when a GitHub branch already contains `sha`, and otherwise answers `need-objects`.
   * With one (exactly one head, `<sha> refs/heads/<branch>`, built on commits a GitHub branch
   * contains), it takes the bundle into a quarantine, checking every object, and pushes from
   * there; pushed objects never enter the mirror. A refused lease is retried once without one,
   * which succeeds only as a fast-forward. Throws {@link RefusedPushError} for a push the worker
   * never makes (an object that is not a commit included), {@link GitHubPushError} when GitHub
   * refuses it, {@link GitHubTransientError} for what a later attempt can clear, and anything
   * else as is.
   */
  push(
    request: GitHubPushRequest,
    bundle?: Readable,
    signal?: AbortSignal,
  ): Promise<GitHubPushAnswer>
  createPullRequest(
    request: { head: string; base: string; title: string; body: string },
    signal?: AbortSignal,
  ): Promise<{ number: number; url: string }>
  updatePullRequest(
    number: number,
    update: { title?: string; body?: string; state?: 'closed' },
    signal?: AbortSignal,
  ): Promise<void>
  getPullRequest(number: number, signal?: AbortSignal): Promise<GitHubPullRequest>
  createOrUpdatePullRequest(
    request: GitHubCreateOrUpdatePullRequest,
    signal?: AbortSignal,
  ): Promise<{ number: number; url: string; created: boolean }>
  convertPullRequestToDraft(number: number, signal?: AbortSignal): Promise<void>
  deleteBranch(branch: string, signal?: AbortSignal): Promise<void>
}

/** What {@link GitHubGateway.health} reports. */
export interface GitHubGatewayHealth {
  /** `prepare()` has succeeded. */
  ready: boolean
  /** `prepare()`'s failure, scrubbed: the gateway's fatal error. Null before it or after a success. */
  fatalError: string | null
  /**
   * The GitHub App check at `prepare()`: `not-an-app` on the token path, `verified`, `unverified`
   * when it failed in a way that looked transient (the credential is minted again on first use),
   * or `pending` before it has run.
   */
  preflight: 'not-an-app' | 'verified' | 'unverified' | 'pending'
  /** Whether the gateway holds a Clerk secret key. */
  clerkConfigured: boolean
  /** The protected set (worker/branch-policy.ts): configured names and globs, and GitHub's default as last read. */
  protectedBranches: { configured: string[]; githubDefault: string | null }
}

export interface LocalGitHubGatewayOptions {
  githubOwner: string
  githubRepo: string
  auth: ResolvedGitHubAuth
  /** Whether `auth` is a GitHub App's, which `prepare()` proves before anything uses it. */
  githubApp: boolean
  /** Holds the mirror; see `CmsWorkerConfig.stateDirectory`. */
  stateDirectory: string
  workspacePath: string
  /** simple-git's inactivity timeout, and the bound on a credential re-read. */
  timeoutMs: number
  /**
   * Test seam: the repository standing in for GitHub, resolved once per operation. Default:
   * `https://github.com/<owner>/<repo>.git`, which never carries the token.
   */
  remoteUrl?: string | (() => string | Promise<string>)
  /** Test seam: the Octokit client. Default: built from `auth`. */
  octokit?: Octokit
  /** The configured base branch, which the gateway never pushes, deletes or opens a PR from. */
  baseBranch?: string
  /** Further branches it protects alike: names and `*` globs (worker/branch-policy.ts). */
  protectedBranches?: readonly string[]
  /** Whether a Clerk secret key is configured, for `health()`. Default false. */
  clerkConfigured?: boolean
  /** The largest pushed bundle taken in, in bytes. Default 1 GiB. */
  maxBundleBytes?: number
  /**
   * Test seam: how long a completed GitHub fetch is reused (default {@link FETCH_COALESCE_MS}), so
   * a test can change "GitHub" between two operations and have the second see it.
   */
  fetchCoalesceMs?: number
  /** Test seam: how long an operation waits for a re-read in flight (default {@link REFRESH_JOIN_CAP_MS}). */
  refreshJoinCapMs?: number
  /**
   * Test seam: whether `prepare()` starts the first GitHub fetch (default true), for a test that
   * counts the gateway's own fetches or sessions from its first operation. A served gateway is
   * prepared as its server starts.
   */
  prefetch?: boolean
}

/** The in-process {@link GitHubGateway}. */
export function createLocalGitHubGateway(options: LocalGitHubGatewayOptions): GitHubGateway {
  return new LocalGitHubGateway(options)
}

/** Whether one operation's attempt to reach GitHub failed: see `LocalGitHubGateway.credentialed`. */
interface GitHubReach {
  failed: boolean
}

class LocalGitHubGateway implements GitHubGateway {
  private readonly mirror: GitHubMirror
  // Built here, where the gateway is created inside start()'s try: an App strategy that throws
  // on first touch is then recorded as a startup failure.
  private readonly octokit: Octokit
  private readonly policy: BranchPolicy
  /** The credential re-read in flight, which every credentialed operation joins. */
  private refreshing: Promise<void> | null = null
  /** The GitHub fetch that operations join: in flight, or completed and still reusable. */
  private githubFetch: GitHubFetchJob | null = null
  /** Pushes about to run and branch deletions settled at GitHub: each ends reuse of an earlier fetch. */
  private pushes = 0
  private preparing: Promise<void> | null = null
  private preflight: GitHubGatewayHealth['preflight'] = 'pending'

  constructor(private readonly options: LocalGitHubGatewayOptions) {
    this.mirror = new GitHubMirror(options.stateDirectory, options.timeoutMs)
    this.octokit = options.octokit ?? createCanopyOctokit(options.auth.octokitAuth, gatewayLogWarn)
    this.policy = new BranchPolicy({
      baseBranch: options.baseBranch,
      protectedBranches: options.protectedBranches,
    })
  }

  private get repo(): { owner: string; repo: string } {
    return { owner: this.options.githubOwner, repo: this.options.githubRepo }
  }

  /**
   * Run one operation that uses the credential.
   *
   * It first JOINS a re-read in flight, bounded by its own `signal` and by
   * {@link REFRESH_JOIN_CAP_MS}, so the 5s/10s/20s task retries see a rotated token. Then, if the operation fails after any of its GitHub-bound git
   * commands or Octokit calls failed, it ARMS a re-read. Not gated on the failure looking
   * auth-shaped: a dead token's git failure is a plain exit 128 with no HTTP status, and a token
   * that lost access fails as a 404 or a 403. What never arms it: a refusal of the gateway's own
   * (`GatewayRefusalError`, whatever came before it; an invalid object ID), anything else local, a lock file the mirror's own
   * housekeeping holds (`isOwnLockFailure`), and an Octokit 422 (`api`). A 404 does arm it, the
   * branch-already-gone one `deleteBranch` callers tolerate included. What bounds a caller that
   * fails on purpose is the floors behind `auth.refreshCredential`:
   * `refreshGitHubTokenMinIntervalMs` (github-auth.ts) and the provider's own. On the GitHub App
   * path a re-read is a no-op.
   *
   * The re-read starts detached, after the failure has been delivered: a provider can take 87s for
   * one `getSecret`, longer than a task's whole deadline.
   *
   * What it returns or throws leaves the gateway, so it is scrubbed here (worker/gateway-egress.ts).
   */
  private async credentialed<T>(
    signal: AbortSignal | undefined,
    operation: (reach: GitHubReach) => Promise<T>,
  ): Promise<T> {
    try {
      await this.joinRefresh(signal)
      const reach: GitHubReach = { failed: false }
      try {
        return redactValue(await operation(reach))
      } catch (err) {
        if (reach.failed && !(err instanceof GatewayRefusalError)) this.armRefresh()
        throw err
      }
    } catch (err) {
      throw redactError(err)
    }
  }

  /**
   * One Octokit call inside {@link credentialed}, whose failure arms a re-read unless it is a 422.
   * A 422 is GitHub validating the request, never judging the credential, and the worker treats
   * two as success: a head branch GitHub already deleted after a merge (`isRefAlreadyGoneError`),
   * and a pull request with no commits between (`isNoCommitsBetweenError`). Arming on them would
   * spend the provider's floor on routine traffic and hold off the re-read a real rotation needs.
   */
  private async api<T>(reach: GitHubReach, call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    } catch (err) {
      if (!(typeof err === 'object' && err !== null && 'status' in err && err.status === 422)) {
        reach.failed = true
      }
      throw err
    }
  }

  /**
   * The credential for one operation's GitHub-bound git, resolved ONCE per operation, so every
   * command in it carries the same token and a resolution failure cannot replace a git failure
   * being classified. Async because a GitHub App's installation token is minted on demand and
   * lasts about an hour, so nothing may cache it. A mint failure propagates as thrown, carrying
   * the `.status` `isPermanentTaskFailure` classifies on.
   */
  private async credential(reach: GitHubReach): Promise<GitHubCredential> {
    const { remoteUrl, githubOwner, githubRepo } = this.options
    const url =
      remoteUrl === undefined
        ? `https://github.com/${githubOwner}/${githubRepo}.git`
        : typeof remoteUrl === 'string'
          ? remoteUrl
          : await remoteUrl()
    const token = await this.api(reach, () => this.options.auth.resolveGitToken())
    registerLiveSecret(token)
    return {
      url,
      token,
      onFailure: () => {
        reach.failed = true
      },
    }
  }

  /**
   * Wait for a re-read in flight, for at most {@link REFRESH_JOIN_CAP_MS}, unless `signal` aborts
   * first; past the cap the operation goes on with the credential as it stands.
   */
  private async joinRefresh(signal?: AbortSignal): Promise<void> {
    const inFlight = this.refreshing
    if (inFlight === null) return
    let timer: NodeJS.Timeout | undefined
    const capped = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.options.refreshJoinCapMs ?? REFRESH_JOIN_CAP_MS)
    })
    try {
      await untilAborted(Promise.race([inFlight, capped]), signal)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Bring the mirror up to GitHub, coalesced: join the GitHub fetch in flight, or reuse one that
   * completed less than {@link FETCH_COALESCE_MS} ago and is still current ({@link isCurrent}), or
   * else start one with the credential `resolve` gives, resolved only then, so a joining operation
   * mints no token. A failed fetch is never joined or reused. The fetch is
   * detached from every caller's `signal`, which ends only that caller's wait: a fetch of a whole
   * repository can outlast any one caller, and killing it on an abort would start it over each
   * time. Its own bound is the mirror's inactivity timeout. It runs in a mirror session of its
   * own, which repairs a corrupt mirror first ({@link GitHubMirror.heal}), and its failure re-reads
   * the credential when it reached GitHub, whoever started it.
   */
  private async joinGitHubFetch(
    resolve: () => Promise<GitHubCredential>,
    signal?: AbortSignal,
  ): Promise<FetchSnapshot> {
    const current = this.githubFetch
    const window = this.options.fetchCoalesceMs ?? FETCH_COALESCE_MS
    const reusable =
      current !== null &&
      !current.failed &&
      (current.completedAt === null ||
        (Date.now() - current.completedAt < window && this.isCurrent(current.snapshot)))
    const job = reusable ? current : this.startGitHubFetch(resolve)
    return untilAborted(job.done, signal)
  }

  /** Whether the mirror still holds GitHub as the fetch that saw `snapshot` left it. */
  private isCurrent(snapshot: FetchSnapshot | null): boolean {
    return (
      snapshot !== null &&
      snapshot.generation === this.mirror.generation &&
      snapshot.pushes === this.pushes
    )
  }

  /**
   * Run `fn` in a mirror session over what a GitHub fetch put in the mirror: `join` one, and
   * check inside the session that nothing has changed the mirror or GitHub since
   * ({@link isCurrent}). A session between the two may have re-created the mirror, leaving no
   * heads, which would read as GitHub having none, or pushed. When something has, `join` again,
   * which then fetches afresh; a second miss is transient.
   */
  private async afterGitHubFetch<T>(
    join: () => Promise<FetchSnapshot>,
    fn: (session: MirrorSession) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const snapshot = await join()
      const result = await this.mirror.exclusive(async (session) =>
        this.isCurrent(snapshot) ? { value: await fn(session) } : null,
      )
      if (result !== null) return result.value
      if (attempt === 2) {
        throw new GitHubTransientError(
          'github-fetch-failed',
          'The GitHub mirror or GitHub changed after each of two GitHub fetches',
        )
      }
    }
  }

  /** Start a GitHub fetch, taking its place at once, before the credential resolves. */
  private startGitHubFetch(resolve: () => Promise<GitHubCredential>): GitHubFetchJob {
    let reachedGitHub = false
    const run = async () => {
      const credential = await resolve()
      const own: GitHubCredential = {
        url: credential.url,
        token: credential.token,
        onFailure: () => {
          reachedGitHub = true
          credential.onFailure()
        },
      }
      const snapshot = await this.mirror.exclusive(async (mirror) => {
        const pushes = this.pushes
        await this.mirror.heal(mirror, own)
        await this.mirror.fetchFromGitHub(mirror, own)
        return { generation: this.mirror.generation, pushes }
      })
      await this.mirror.afterFetch()
      return snapshot
    }
    const job: GitHubFetchJob = { failed: false, completedAt: null, snapshot: null, done: run() }
    job.done.then(
      (snapshot) => {
        job.completedAt = Date.now()
        job.snapshot = snapshot
      },
      () => {
        job.failed = true
        if (reachedGitHub) this.armRefresh()
      },
    )
    this.githubFetch = job
    return job
  }

  /** A push or branch deletion at GitHub: every later read must come from a fetch after it. */
  private invalidateGitHubFetch(): void {
    this.pushes++
    this.githubFetch = null
  }

  /** Start a re-read on the next turn of the event loop, unless one is already in flight. */
  private armRefresh(): void {
    if (this.refreshing !== null) return
    const refreshing: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.refreshCredential())
      .finally(() => {
        if (this.refreshing === refreshing) this.refreshing = null
      })
    this.refreshing = refreshing
  }

  prepare(): Promise<void> {
    return (this.preparing ??= this.prepareOnce())
  }

  async health(signal?: AbortSignal): Promise<GitHubGatewayHealth> {
    let ready = false
    let fatalError: string | null = null
    if (this.preparing !== null) {
      try {
        await untilAborted(this.preparing, signal)
        ready = true
      } catch (err) {
        if (signal?.aborted) throw err
        fatalError = redactEgress(getErrorMessage(err))
      }
    }
    return {
      ready,
      fatalError,
      preflight: this.preflight,
      clerkConfigured: this.options.clerkConfigured ?? false,
      protectedBranches: this.policy.describe(),
    }
  }

  private async prepareOnce(): Promise<void> {
    try {
      // Before the mirror's first fetch, whose failure would otherwise blame the repository.
      await this.preflightGitHubAppAuth()
      await this.ensureStateDirectoryIsPrivate()
      await this.mirror.ensure()
    } catch (err) {
      throw redactError(err)
    }
    // The first GitHub fetch starts now, detached, so the first operation that needs one joins
    // it under way. Its failure surfaces to whoever joins it.
    if (this.options.prefetch === false) return
    void this.credentialed(undefined, (reach) =>
      this.joinGitHubFetch(() => this.credential(reach)),
    ).catch(() => undefined)
  }

  /**
   * Prove a GitHub App credential works, failing startup UNLESS THE FAILURE POSITIVELY LOOKS
   * TRANSIENT. Not always fatal, so the two credential paths degrade alike: on the token path a
   * GitHub 502 at boot is absorbed and the loops retry, where rethrowing would crash-loop an App
   * worker until GitHub recovered, each time telling the operator to check the key. Fail CLOSED,
   * through `isTransientAuthFailure` rather than the inverse of `isPermanentTaskFailure`, which
   * defaults a status-less error to transient: a key too mangled to sign with fails locally and
   * status-lessly, and would otherwise boot a worker on a dead credential with no
   * `lastFatalError`. No-op on the token path, where the first real request checks as much.
   */
  private async preflightGitHubAppAuth(): Promise<void> {
    if (!this.options.githubApp) {
      this.preflight = 'not-an-app'
      return
    }
    try {
      registerLiveSecret(await this.options.auth.resolveGitToken())
    } catch (err) {
      // [REDACT] Both messages below reach worker-status.json and the browser.
      const detail = redactEgress(getErrorMessage(err))
      if (isTransientAuthFailure(err)) {
        this.preflight = 'unverified'
        gatewayLogWarn(
          `Could not verify GitHub App authentication at startup: ${detail}. ` +
            'Continuing — this looks transient, and the credential is minted again on first use.',
        )
        return
      }
      // Re-thrown with context, unlike credential(): nothing classifies a startup failure.
      throw new Error(
        `GitHub App authentication failed: ${detail}. ` +
          'Check the app id, the installation id, and that the private key belongs to that app.',
      )
    }
    this.preflight = 'verified'
    gatewayLog('GitHub App authentication verified')
  }

  /**
   * Refuse a state directory on the shared filesystem: the mirror there would be as writable by
   * the Lambda as remote.git is.
   */
  private async ensureStateDirectoryIsPrivate(): Promise<void> {
    const workspace = await realpathOfNearest(this.options.workspacePath)
    const state = await realpathOfNearest(this.options.stateDirectory)
    const relative = path.relative(workspace, state)
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      throw new Error(
        `The worker's state directory (${this.options.stateDirectory}) is inside its shared workspace ` +
          `(${this.options.workspacePath}). It holds the repository the GitHub credential is used ` +
          `in, so it must be somewhere the CMS Lambda cannot write.`,
      )
    }
  }

  defaultBranch(signal?: AbortSignal): Promise<string> {
    return this.credentialed(signal, async (reach) => {
      const name = await this.policy.recordGitHubDefault(() =>
        this.readDefaultBranch(reach, signal),
      )
      if (name === null) throw new Error('GitHub reported no default branch')
      return name
    })
  }

  /** Reads GitHub's default branch with git, in a mirror session, never through Octokit. */
  isProtectedBranch(branch: string, signal?: AbortSignal): Promise<boolean> {
    return this.credentialed(signal, (reach) =>
      this.policy.isProtected(branch, async () => {
        const credential = await this.credential(reach)
        // A session can wait behind a whole-repository fetch; an abort ends only this wait.
        return untilAborted(
          this.mirror.exclusive((session) => session.githubDefaultBranch(credential, signal)),
          signal,
        )
      }),
    )
  }

  /**
   * GitHub's default branch, through the API, for the policy's operations outside a mirror
   * session; a push reads it with git, inside its session (`MirrorSession.pushToGitHub`).
   */
  private async readDefaultBranch(reach: GitHubReach, signal?: AbortSignal): Promise<string> {
    const { data } = await this.api(reach, () =>
      this.octokit.repos.get({ ...this.repo, ...(signal ? { request: { signal } } : {}) }),
    )
    return data.default_branch
  }

  /** Validate a pull request's head and base, and apply the policy to its head and text. */
  private async assertPullRequestAllowed(
    reach: GitHubReach,
    request: { head: string; base: string; title?: string; body?: string },
    signal?: AbortSignal,
  ): Promise<void> {
    const git = await this.mirror.checkGit()
    await assertPlainBranchName(request.head, git, 'pull-request')
    // The base is GitHub's to validate and the policy's to leave alone (BranchPolicy), and may be
    // a configured name outside branchNameProblem's narrower set: git's rules, the length cap and
    // no leading `-` only.
    await assertPlainBranchName(request.base, git, 'pull-request', false)
    await this.policy.assertPullRequestAllowed(request, () => this.readDefaultBranch(reach, signal))
  }

  async fetch(
    request: { have: readonly string[] },
    signal?: AbortSignal,
    onProgress?: () => void,
  ): Promise<GitHubFetchResult> {
    const stopWatching = onProgress === undefined ? null : this.mirror.watchActivity(onProgress)
    try {
      return await this.fetchOnce(request, signal)
    } finally {
      stopWatching?.()
    }
  }

  private fetchOnce(
    request: { have: readonly string[] },
    signal?: AbortSignal,
  ): Promise<GitHubFetchResult> {
    const have = [...new Set(request.have)]
    if (have.length > MAX_FETCH_HAVE) {
      throw new Error(`A fetch takes at most ${MAX_FETCH_HAVE} have IDs, not ${have.length}`)
    }
    for (const id of have) assertObjectId(id)
    return this.credentialed(signal, (reach) =>
      this.afterGitHubFetch(
        () => this.joinGitHubFetch(() => this.credential(reach), signal),
        async (mirror) => {
          this.mirror.assertUsable()
          const refs = await mirror.heads()
          const file = await this.mirror.outgoingBundlePath()
          const created = await mirror.createBundle(have, file, signal)
          const bundleId = await this.mirror.setPendingBundle(created ? file : null)
          return { refs, bundleId }
        },
      ),
    )
  }

  openBundle(bundleId: string): Promise<Readable> {
    return this.mirror.openBundle(bundleId)
  }

  push(
    request: GitHubPushRequest,
    bundle?: Readable,
    signal?: AbortSignal,
  ): Promise<GitHubPushAnswer> {
    return this.credentialed(signal, (reach) =>
      this.pushOnce(request, bundle, reach, signal),
    ).finally(
      // A refusal can come before the body is read: never leave its writer blocked.
      () => bundle?.destroy(),
    )
  }

  private async pushOnce(
    request: GitHubPushRequest,
    bundle: Readable | undefined,
    reach: GitHubReach,
    signal?: AbortSignal,
  ): Promise<GitHubPushAnswer> {
    assertObjectId(request.sha, 'a commit ID')
    if (request.lease !== undefined) assertObjectId(request.lease, 'a commit ID')
    if (request.prerequisites.length > MAX_PUSH_PREREQUISITES) {
      throw new Error(`A push names at most ${MAX_PUSH_PREREQUISITES} prerequisites`)
    }
    for (const id of request.prerequisites) assertObjectId(id, 'a commit ID')
    // Before `branch` reaches anything else: the bundle's expected head, a refspec.
    await assertPlainBranchName(request.branch, await this.mirror.checkGit())
    // Every attempt, and a GitHub fetch this push starts, carries this one credential (see
    // credential()), resolved once and only when first needed.
    let resolved: Promise<GitHubCredential> | null = null
    const credential = () => (resolved ??= this.credential(reach))
    // The join comes before the session, never inside it: the fetch takes a session of its own,
    // and sessions are not re-entrant. So does resolving the credential, so the session never
    // waits on GitHub's API. A body is read first, so its writer is not left waiting.
    const session = (received: ReceivedBundle | null) =>
      this.afterGitHubFetch(
        async () => {
          const snapshot = await this.joinGitHubFetchForPush(credential, request.branch, signal)
          await credential()
          return snapshot
        },
        async (mirror) => this.pushInSession(mirror, await credential(), request, received, signal),
      )
    return bundle === undefined
      ? session(null)
      : this.mirror.ingest(bundle, request, this.maxBundleBytes, session)
  }

  /**
   * The plan's step 2 (§3.2): the push goes ahead only once a GitHub fetch has SUCCEEDED, fresh or
   * reused, so the mirror's heads are GitHub's for the reachability test and the prerequisite
   * check; otherwise it is transient. A token mint GitHub refuses is the exception: it carries its HTTP
   * status through, so the task runner classifies it. That is the whole clause: a mirror with no heads after a
   * successful fetch means GitHub has none, a first push.
   */
  private async joinGitHubFetchForPush(
    credential: () => Promise<GitHubCredential>,
    branch: string,
    signal?: AbortSignal,
  ): Promise<FetchSnapshot> {
    try {
      return await this.joinGitHubFetch(credential, signal)
    } catch (err) {
      // An HTTP failure is the credential's own (a mint refused), classified by its status.
      if (err instanceof GitHubTransientError || hasHttpStatus(err)) throw err
      // [REDACT] The message reaches the task's lastError.
      throw new GitHubTransientError(
        'github-fetch-failed',
        `Could not fetch from GitHub before pushing ${branch}: ` +
          redactEgress(getErrorMessage(err)).trim(),
      )
    }
  }

  private get maxBundleBytes(): number {
    return this.options.maxBundleBytes ?? DEFAULT_MAX_BUNDLE_BYTES
  }

  /**
   * The push, in one mirror session, every call in it a plain call (the session is not
   * re-entrant), over the mirror a GitHub fetch just filled ({@link afterGitHubFetch}), so its
   * heads are GitHub's for the reachability test and the prerequisite check: find `sha`, in the
   * mirror or in the quarantine `received` goes into; push from there, which refuses a protected
   * branch first. The mirror kills its git when `signal` aborts, and GitHub moves the ref only
   * after receiving the whole pack, so a killed push changes nothing or is found already done by
   * the re-run, unless git's transport child outlives it
   * (.claude/future-tasks/worker-mirror-detached-work-drain.md).
   */
  private async pushInSession(
    mirror: MirrorSession,
    credential: GitHubCredential,
    request: GitHubPushRequest,
    received: ReceivedBundle | null,
    signal?: AbortSignal,
  ): Promise<GitHubPushAnswer> {
    const { branch, sha } = request
    // Never fires: finding corruption changes the generation, so afterGitHubFetch never runs this
    // over a mirror found corrupt after its fetch. It refuses rather than push from a corrupt one.
    this.mirror.assertUsable()
    const heads = await mirror.heads()

    let repo: string | undefined
    if (received === null) {
      const type = (await mirror.objectTypes([sha])).get(sha)
      if (type === 'missing') return this.needObjects(mirror, request)
      if (type !== 'commit') throw new RefusedPushError(branch, 'not-a-commit', sha)
      if (!(await mirror.reachableFromHeads(sha))) return this.needObjects(mirror, request)
    } else {
      repo = await mirror.quarantine(received, request, heads, signal)
    }

    const attempt = (lease?: string) =>
      mirror.pushToGitHub(credential, branch, sha, {
        lease,
        signal,
        repo,
        policy: this.policy,
        // Whatever the push does to GitHub, a fetch reused from before it may not show it.
        onPushing: () => this.invalidateGitHubFetch(),
      })
    try {
      return { kind: 'pushed', ...(await attempt(request.lease)), pastStaleLease: false }
    } catch (err) {
      if (err instanceof RefusedPushError || err instanceof GitHubTransientError) throw err
      const message = getErrorMessage(err)
      // A refused lease means GitHub is not at the commit the lease names, which is routine: a
      // task re-runs after a crash, and the marker it came from survives any failure to clear
      // it. So retry PLAIN and let git adjudicate: a non-forced push succeeds only as a
      // fast-forward, so it can destroy nothing. git evaluates a lease only when it has an
      // update to apply, so an up-to-date ref never gets here. A workflow refusal is final
      // whatever the lease, so it is not retried.
      if (
        request.lease &&
        isStaleLeaseRejection(message) &&
        workflowPushRefusalFile(message) === null
      ) {
        let update: GitHubRefUpdate
        try {
          update = await attempt()
        } catch (retryErr) {
          throw new GitHubPushError('rejected-after-stale-lease', getErrorMessage(retryErr))
        }
        return { kind: 'pushed', ...update, pastStaleLease: true }
      }
      throw new GitHubPushError('rejected', message)
    }
  }

  private async needObjects(
    mirror: MirrorSession,
    request: GitHubPushRequest,
  ): Promise<GitHubPushAnswer> {
    return { kind: 'need-objects', usable: await mirror.usablePrerequisites(request.prerequisites) }
  }

  createPullRequest(
    request: { head: string; base: string; title: string; body: string },
    signal?: AbortSignal,
  ): Promise<{ number: number; url: string }> {
    return this.credentialed(signal, async (reach) => {
      await this.assertPullRequestAllowed(reach, request, signal)
      const { data } = await this.api(reach, () =>
        this.octokit.pulls.create({ ...this.repo, ...request, request: { signal } }),
      )
      return { number: data.number, url: data.html_url }
    })
  }

  updatePullRequest(
    number: number,
    update: { title?: string; body?: string; state?: 'closed' },
    signal?: AbortSignal,
  ): Promise<void> {
    return this.credentialed(signal, async (reach) => {
      assertPullRequestText(`Refusing to update pull request #${number}`, `#${number}`, update)
      await this.api(reach, () =>
        this.octokit.pulls.update({
          ...this.repo,
          pull_number: number,
          ...update,
          request: { signal },
        }),
      )
    })
  }

  getPullRequest(number: number, signal?: AbortSignal): Promise<GitHubPullRequest> {
    return this.credentialed(signal, (reach) => this.pullRequest(reach, number, signal))
  }

  private async pullRequest(
    reach: GitHubReach,
    number: number,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequest> {
    const { data } = await this.api(reach, () =>
      this.octokit.pulls.get({ ...this.repo, pull_number: number, request: { signal } }),
    )
    return data
  }

  createOrUpdatePullRequest(
    request: GitHubCreateOrUpdatePullRequest,
    signal?: AbortSignal,
  ): Promise<{ number: number; url: string; created: boolean }> {
    return this.credentialed(signal, async (reach) => {
      await this.assertPullRequestAllowed(reach, request, signal)
      return this.api(reach, () =>
        createOrUpdatePullRequest({
          octokit: this.octokit,
          ...this.repo,
          ...request,
          signal,
          warn: gatewayLogWarn,
        }),
      )
    })
  }

  convertPullRequestToDraft(number: number, signal?: AbortSignal): Promise<void> {
    return this.credentialed(signal, async (reach) => {
      // The REST API cannot convert a PR to a draft; GraphQL can.
      const pr = await this.pullRequest(reach, number, signal)
      await this.api(reach, () =>
        this.octokit.graphql(
          `mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`,
          { id: pr.node_id, request: { signal } },
        ),
      )
    })
  }

  deleteBranch(branch: string, signal?: AbortSignal): Promise<void> {
    return this.credentialed(signal, async (reach) => {
      await assertPlainBranchName(branch, await this.mirror.checkGit(), 'delete')
      await this.policy.assertDeleteAllowed(branch, () => this.readDefaultBranch(reach, signal))
      // Once the call has settled, when GitHub may have acted: any fetch before then, a fetch whose
      // session ran during the call included, may still show the branch.
      try {
        await this.api(reach, () =>
          this.octokit.git.deleteRef({ ...this.repo, ref: `heads/${branch}`, request: { signal } }),
        )
      } finally {
        this.invalidateGitHubFetch()
      }
    })
  }

  /**
   * Re-read the credential, for {@link armRefresh}. Every consumer reads the credential per use,
   * so a re-read repairs all of them for their next use. Never throws: the failure that armed it
   * has already been reported. Bounded by the timeout, because every credentialed operation joins
   * it and a provider may have no bound of its own. A losing read is not cancelled, but
   * `auth.refreshCredential` discards a result older than one already applied.
   */
  private async refreshCredential(): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`the re-read did not settle within ${this.options.timeoutMs}ms`)),
        this.options.timeoutMs,
      )
    })
    try {
      await Promise.race([this.options.auth.refreshCredential(), timedOut])
    } catch (err) {
      logFailedCredentialRefresh(err)
    } finally {
      clearTimeout(timer)
    }
  }
}

function logFailedCredentialRefresh(err: unknown): void {
  // [REDACT] The message can name the secret and, on a malformed-secret path, quote what was read.
  gatewayLogError(
    'Failed to re-read the GitHub credential after a failure:',
    redactEgress(getErrorMessage(err)),
  )
}

/** `promise`, unless `signal` aborts first, which ends only this wait. */
async function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  signal.throwIfAborted()
  let onAbort = (): void => undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Refuse anything but a full object ID, before it can reach git. */
function assertObjectId(value: string, what = 'an object ID'): void {
  if (!isObjectId(value)) throw new Error(`Not ${what}: ${JSON.stringify(value.slice(0, 80))}`)
}

/** `target` with symlinks resolved as far as it exists, so a link cannot hide where it lands. */
async function realpathOfNearest(target: string): Promise<string> {
  const missing: string[] = []
  let current = path.resolve(target)
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...missing.reverse())
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(target)
      missing.push(path.basename(current))
      current = parent
    }
  }
}

/** Whether `err` carries an HTTP status, as an Octokit or a token mint's failure does. */
function hasHttpStatus(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number'
  )
}
