import fs from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import type { Octokit, RestEndpointMethodTypes } from '@octokit/rest'

import type { BareRemoteRepackResult } from '../git-manager'
import {
  createCanopyOctokit,
  createOrUpdatePullRequest,
  type CreateOrUpdatePullRequestParams,
} from '../github-service'
import { getErrorMessage, redactCredentials } from '../utils/error'
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
import { workerLog, workerLogError, workerLogWarn } from './log'

/** What a {@link GitHubGateway.fetch} brought back. */
interface GitHubFetchResult {
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
  /** Branches no push may name; GitHub's default branch is always added. */
  protectedBranches: readonly string[]
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
type GitHubPullRequest = Pick<
  RestEndpointMethodTypes['pulls']['get']['response']['data'],
  'merged' | 'merged_at' | 'state' | 'node_id'
>

type GitHubCreateOrUpdatePullRequest = Omit<
  CreateOrUpdatePullRequestParams,
  'octokit' | 'owner' | 'repo'
>

/**
 * Everything the worker does with GitHub, and the only place the credential and Octokit are used.
 * Octokit errors propagate unchanged (status, headers, response data), so the task runner's
 * classifiers read them as they would Octokit's own. The gateway re-reads its own credential after
 * a failure (`LocalGitHubGateway.credentialed`); the worker never asks it to.
 */
export interface GitHubGateway {
  /**
   * At startup, before anything uses the credential: prove a GitHub App credential works, refuse
   * a state directory the Lambda could write, and create the mirror.
   */
  prepare(): Promise<void>
  /** GitHub's default branch. */
  defaultBranch(signal?: AbortSignal): Promise<string>
  /**
   * Fetch every GitHub branch, and answer with all of them and a bundle of the commits `have`
   * lacks. `have` is the caller's own tips, at most {@link MAX_FETCH_HAVE} object IDs; any the
   * gateway does not hold as a commit is ignored. A new fetch replaces a bundle not yet opened.
   */
  fetch(request: { have: readonly string[] }, signal?: AbortSignal): Promise<GitHubFetchResult>
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
  ): Promise<{ number: number; url: string; created: boolean }>
  convertPullRequestToDraft(number: number, signal?: AbortSignal): Promise<void>
  deleteBranch(branch: string, signal?: AbortSignal): Promise<void>
  /** Mirror upkeep. */
  maintain(): Promise<BareRemoteRepackResult>
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
  /** The largest pushed bundle taken in, in bytes. Default 1 GiB. */
  maxBundleBytes?: number
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
  /** The credential re-read in flight, which every credentialed operation joins. */
  private refreshing: Promise<void> | null = null

  constructor(private readonly options: LocalGitHubGatewayOptions) {
    this.mirror = new GitHubMirror(options.stateDirectory, options.timeoutMs)
    this.octokit = options.octokit ?? createCanopyOctokit(options.auth.octokitAuth)
  }

  private get repo(): { owner: string; repo: string } {
    return { owner: this.options.githubOwner, repo: this.options.githubRepo }
  }

  /**
   * Run one operation that uses the credential.
   *
   * It first JOINS a re-read in flight, bounded by its own `signal`, so the 5s/10s/20s task
   * retries see a rotated token. Then, if the operation fails after any of its GitHub-bound git
   * commands or Octokit calls failed, it ARMS a re-read. Not gated on the failure looking
   * auth-shaped: a dead token's git failure is a plain exit 128 with no HTTP status, and a token
   * that lost access fails as a 404 or a 403. What never arms it: a refusal of the gateway's own
   * (`RefusedPushError`, an invalid object ID), anything else local, a lock file the mirror's own
   * housekeeping holds (`isOwnLockFailure`), and an Octokit 422 (`api`). A 404 does arm it, the
   * branch-already-gone one `deleteBranch` callers tolerate included. What bounds a caller that
   * fails on purpose is the floors behind `auth.refreshCredential`:
   * `refreshGitHubTokenMinIntervalMs` (github-auth.ts) and the provider's own. On the GitHub App
   * path a re-read is a no-op.
   *
   * The re-read starts detached, after the failure has been delivered: a provider can take 87s for
   * one `getSecret`, longer than a task's whole deadline.
   */
  private async credentialed<T>(
    signal: AbortSignal | undefined,
    operation: (reach: GitHubReach) => Promise<T>,
  ): Promise<T> {
    await this.joinRefresh(signal)
    const reach: GitHubReach = { failed: false }
    try {
      return await operation(reach)
    } catch (err) {
      if (reach.failed) this.armRefresh()
      throw err
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
    return {
      url,
      token,
      onFailure: () => {
        reach.failed = true
      },
    }
  }

  /** Wait for a re-read in flight, unless `signal` aborts first. */
  private async joinRefresh(signal?: AbortSignal): Promise<void> {
    const inFlight = this.refreshing
    if (inFlight === null) return
    if (signal === undefined) return inFlight
    signal.throwIfAborted()
    let onAbort = (): void => undefined
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      await Promise.race([inFlight, aborted])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
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

  async prepare(): Promise<void> {
    // Before the mirror's first fetch, whose failure would otherwise blame the repository.
    await this.preflightGitHubAppAuth()
    await this.ensureStateDirectoryIsPrivate()
    await this.mirror.ensure()
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
    if (!this.options.githubApp) return
    try {
      await this.options.auth.resolveGitToken()
    } catch (err) {
      // [REDACT] Both messages below reach worker-status.json and the browser.
      const detail = redactCredentials(getErrorMessage(err))
      if (isTransientAuthFailure(err)) {
        workerLogWarn(
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
    workerLog('GitHub App authentication verified')
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
      const { data } = await this.api(reach, () =>
        this.octokit.repos.get({ ...this.repo, ...(signal ? { request: { signal } } : {}) }),
      )
      return data.default_branch
    })
  }

  fetch(request: { have: readonly string[] }, signal?: AbortSignal): Promise<GitHubFetchResult> {
    const have = [...new Set(request.have)]
    if (have.length > MAX_FETCH_HAVE) {
      throw new Error(`A fetch takes at most ${MAX_FETCH_HAVE} have IDs, not ${have.length}`)
    }
    for (const id of have) assertObjectId(id)
    return this.credentialed(signal, async (reach) => {
      const credential = await this.credential(reach)
      return this.mirror.exclusive(async (mirror) => {
        await mirror.fetchFromGitHub(credential, signal)
        const refs = await mirror.heads()
        const file = await this.mirror.outgoingBundlePath()
        const created = await mirror.createBundle(have, file, signal)
        const bundleId = await this.mirror.setPendingBundle(created ? file : null)
        return { refs, bundleId }
      })
    })
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
    // Every attempt carries this one credential (see credential()).
    const credential = await this.credential(reach)
    if (bundle === undefined) {
      return this.mirror.exclusive((mirror) =>
        this.pushInSession(mirror, credential, request, null, signal),
      )
    }
    return this.mirror.ingest(bundle, request, this.maxBundleBytes, (received) =>
      this.mirror.exclusive((mirror) =>
        this.pushInSession(mirror, credential, request, received, signal),
      ),
    )
  }

  private get maxBundleBytes(): number {
    return this.options.maxBundleBytes ?? DEFAULT_MAX_BUNDLE_BYTES
  }

  /**
   * The push, in one mirror session, every call in it a plain call (the session is not
   * re-entrant): fetch GitHub, so the mirror's heads are GitHub's for the reachability test and
   * the prerequisite check; find `sha`, in the mirror or in the quarantine `received` goes into;
   * push from there, which refuses a protected branch first. The mirror kills its git
   * when `signal` aborts, and GitHub moves the ref only after receiving the whole pack, so a
   * killed push changes nothing or is found already done by the re-run.
   */
  private async pushInSession(
    mirror: MirrorSession,
    credential: GitHubCredential,
    request: GitHubPushRequest,
    received: ReceivedBundle | null,
    signal?: AbortSignal,
  ): Promise<GitHubPushAnswer> {
    const { branch, sha } = request
    try {
      await mirror.fetchFromGitHub(credential, signal)
    } catch (err) {
      // [REDACT] The message reaches the task's lastError.
      throw new GitHubTransientError(
        'github-fetch-failed',
        `Could not fetch from GitHub before pushing ${branch}: ` +
          redactCredentials(getErrorMessage(err)).trim(),
      )
    }
    // Fetched in this session, so no heads means GitHub has none: a first push.
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
        protectedBranches: request.protectedBranches,
      })
    try {
      return { kind: 'pushed', ...(await attempt(request.lease)), pastStaleLease: false }
    } catch (err) {
      if (err instanceof RefusedPushError) throw err
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
  ): Promise<{ number: number; url: string; created: boolean }> {
    return this.credentialed(request.signal, (reach) =>
      this.api(reach, () =>
        createOrUpdatePullRequest({ octokit: this.octokit, ...this.repo, ...request }),
      ),
    )
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
      await this.api(reach, () =>
        this.octokit.git.deleteRef({ ...this.repo, ref: `heads/${branch}`, request: { signal } }),
      )
    })
  }

  maintain(): Promise<BareRemoteRepackResult> {
    return this.mirror.maintain()
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
  workerLogError(
    'Failed to re-read the GitHub credential after a failure:',
    redactCredentials(getErrorMessage(err)),
  )
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
