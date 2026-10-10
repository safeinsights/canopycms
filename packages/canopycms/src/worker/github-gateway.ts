import fs from 'node:fs/promises'
import path from 'node:path'
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
  RefusedPushError,
  type GitHubCredential,
  type MirrorSession,
} from './github-mirror'
import { workerLog, workerLogError, workerLogWarn } from './log'

/** What a {@link GitHubGateway.fetch} brought back. */
interface GitHubFetchResult {
  /** The objects the caller lacks, as a bundle to download; always null in-process. */
  bundleId: string | null
}

const inMirrorSession = Symbol('inMirrorSession')

/**
 * Which GitHub branches reached each of a list of commits, at the last fetch, asked inside a
 * mirror session that is already held. Branded so the gateway itself, whose own `onGitHub` takes
 * that session, cannot be passed in its place: the session is not re-entrant.
 */
export interface GitHubReachability {
  readonly [inMirrorSession]: true
  onGitHub(ids: readonly string[]): Promise<ReadonlySet<string>>
}

interface GitHubPushRequest {
  branch: string
  /** The commit to put at `refs/heads/<branch>` on GitHub, already in remote.git. */
  sha: string
  /** The commit GitHub must still be at for the push to replace it (`--force-with-lease`). */
  lease?: string
  /** Branches no push may name; GitHub's default branch is always added. */
  protectedBranches: readonly string[]
}

export type GitHubPushOutcome = 'pushed' | 'pushed-past-stale-lease'

/**
 * A push to GitHub failed: `rejected` on the first attempt, `rejected-after-stale-lease` on the
 * plain retry after GitHub refused a stale lease. The message is the failure's own (git's output,
 * for a refusal); `cause` is the error itself. A {@link RefusedPushError} from the first attempt is
 * thrown as itself.
 */
export class GitHubPushError extends Error {
  constructor(
    readonly kind: 'rejected' | 'rejected-after-stale-lease',
    readonly cause: unknown,
  ) {
    super(getErrorMessage(cause))
    this.name = 'GitHubPushError'
  }
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
   * Fetch every GitHub branch, and copy them into remote.git's tracking namespace in the same
   * mirror session, pruning the ones GitHub no longer has. `have` is ignored.
   */
  fetch(request: { have: readonly string[] }, signal?: AbortSignal): Promise<GitHubFetchResult>
  /** Of `ids`, the ones a GitHub branch contained at the last fetch. */
  onGitHub(ids: readonly string[]): Promise<ReadonlySet<string>>
  /**
   * Seed the bare repository at `gitDir` with every GitHub branch, in one mirror session: fetch
   * GitHub, run `beforeSeed` (whose throw stops the seed), require `baseBranch` on GitHub, run
   * `createRepository` to make the empty repository at `gitDir`, then push into it. `beforeSeed`
   * runs inside that session, so it asks GitHub only through the object it is given, never
   * through the gateway.
   */
  seedBareRepository(
    gitDir: string,
    options: {
      baseBranch: string
      beforeSeed?: (github: GitHubReachability) => Promise<void>
      createRepository: () => Promise<void>
    },
  ): Promise<void>
  /**
   * Push `sha` to GitHub's `refs/heads/<branch>`. A refused lease is retried once without one,
   * which succeeds only as a fast-forward. Throws {@link RefusedPushError} for a push the worker
   * never makes, {@link GitHubPushError} when the push fails, and anything else as is.
   */
  push(request: GitHubPushRequest, signal?: AbortSignal): Promise<GitHubPushOutcome>
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
  remoteGitPath: string
  /** simple-git's inactivity timeout, and the bound on a credential re-read. */
  timeoutMs: number
  /**
   * Test seam: the repository standing in for GitHub, resolved once per operation. Default:
   * `https://github.com/<owner>/<repo>.git`, which never carries the token.
   */
  remoteUrl?: string | (() => string | Promise<string>)
  /** Test seam: the Octokit client. Default: built from `auth`. */
  octokit?: Octokit
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
    this.mirror = new GitHubMirror(options.stateDirectory, options.remoteGitPath, options.timeoutMs)
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
   * (`RefusedPushError`, an invalid object ID), anything else local, and a lock file the mirror's
   * own housekeeping holds (`isOwnLockFailure`). What bounds a caller that fails on purpose is the
   * floors behind `auth.refreshCredential`: `refreshGitHubTokenMinIntervalMs` (github-auth.ts) and
   * the provider's own. On the GitHub App path a re-read is a no-op.
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

  /** One Octokit call inside {@link credentialed}: any failure of it reached, or tried to reach, GitHub. */
  private async api<T>(reach: GitHubReach, call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    } catch (err) {
      reach.failed = true
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

  fetch(_request: { have: readonly string[] }, signal?: AbortSignal): Promise<GitHubFetchResult> {
    return this.credentialed(signal, async (reach) => {
      const credential = await this.credential(reach)
      await this.mirror.exclusive(async (mirror) => {
        await mirror.fetchFromGitHub(credential, signal)
        await mirror.publishTrackingRefs(signal)
      })
      return { bundleId: null }
    })
  }

  onGitHub(ids: readonly string[]): Promise<ReadonlySet<string>> {
    return this.mirror.exclusive((mirror) => idsOnGitHub(mirror, ids))
  }

  seedBareRepository(
    gitDir: string,
    options: {
      baseBranch: string
      beforeSeed?: (github: GitHubReachability) => Promise<void>
      createRepository: () => Promise<void>
    },
  ): Promise<void> {
    return this.credentialed(undefined, async (reach) => {
      const credential = await this.credential(reach)
      await this.mirror.exclusive(async (mirror) => {
        await mirror.fetchFromGitHub(credential)
        await options.beforeSeed?.({
          [inMirrorSession]: true,
          onGitHub: (ids) => idsOnGitHub(mirror, ids),
        })
        if ((await mirror.branchTip(options.baseBranch)) === null) {
          throw new Error(`GitHub has no branch '${options.baseBranch}'`)
        }
        await options.createRepository()
        await mirror.seedBareRepository(gitDir)
      })
    })
  }

  push(request: GitHubPushRequest, signal?: AbortSignal): Promise<GitHubPushOutcome> {
    return this.credentialed(signal, (reach) => this.pushOnce(request, reach, signal))
  }

  private async pushOnce(
    request: GitHubPushRequest,
    reach: GitHubReach,
    signal?: AbortSignal,
  ): Promise<GitHubPushOutcome> {
    // Both attempts carry this one credential (see credential()).
    const credential = await this.credential(reach)
    // One mirror session for the whole exchange; the mirror kills its git when `signal` aborts.
    // GitHub moves the ref only after receiving the whole pack, so a killed push changes nothing
    // or is found already done by the re-run.
    return this.mirror.exclusive(async (mirror) => {
      const attempt = (lease?: string) =>
        mirror.pushToGitHub(credential, request.branch, request.sha, {
          lease,
          signal,
          protectedBranches: request.protectedBranches,
        })
      try {
        await attempt(request.lease)
        return 'pushed'
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
          try {
            await attempt()
          } catch (retryErr) {
            throw new GitHubPushError('rejected-after-stale-lease', retryErr)
          }
          return 'pushed-past-stale-lease'
        }
        throw new GitHubPushError('rejected', err)
      }
    })
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

/** Of `ids`, the ones a GitHub branch contained at the last fetch, asked one at a time. */
async function idsOnGitHub(
  mirror: MirrorSession,
  ids: readonly string[],
): Promise<ReadonlySet<string>> {
  const found = new Set<string>()
  for (const id of ids) {
    if (await mirror.isOnGitHub(id)) found.add(id)
  }
  return found
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
