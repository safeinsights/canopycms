import { Octokit } from '@octokit/rest'
import { throttling } from '@octokit/plugin-throttling'
import type { CanopyConfig } from './config'
import { operatingStrategy } from './operating-mode'
import { getErrorMessage } from './utils/error'
// canopyLogWarn, not console.warn: the PR create/update path below runs as a
// worker task, and every worker line must carry worker/log.ts's ISO-8601 prefix
// or CloudWatch folds it into the previous event. Under Lambda/dev the helper
// is plain console. See utils/logger.ts.
import { canopyLogWarn } from './utils/logger'

const ThrottledOctokit = Octokit.plugin(throttling)

/**
 * Retry primary rate limits at most twice and only for short waits; beyond
 * that, task-level retry/backoff (worker) or the caller's error path takes
 * over, since the worker's task timeout would abort a longer in-request wait.
 */
export const shouldRetryRateLimit = (retryAfter: number, retryCount: number): boolean =>
  retryCount < 2 && retryAfter <= 60

/**
 * Secondary (abuse-detection) rate limits are stricter to trip and usually
 * signal we're hammering the API too fast — retry at most once, and only for
 * a short wait.
 */
export const shouldRetrySecondaryRateLimit = (retryAfter: number, retryCount: number): boolean =>
  retryCount < 1 && retryAfter <= 60

/**
 * Octokit's pluggable-auth options, typed STRUCTURALLY.
 *
 * `@octokit/core` calls `authStrategy(…)` once in its constructor and wraps the
 * returned object's `.hook` into its request chain, so handing it a strategy is
 * the whole of "authenticate every request some other way".
 *
 * The shape is declared, never imported: this module is reachable from
 * `services.ts` and so lands in every adopter's Next.js server bundle, and
 * importing `@octokit/auth-app` here would pull that package (plus
 * `universal-github-app-jwt`) into the bundle of every adopter, including the
 * majority who authenticate with a personal access token and never register a
 * GitHub App. `pnpm lint:bundle` guards the *client* boundary only and would
 * not catch it, so the structural typing IS the guard.
 *
 * A deployment using an App constructs the strategy and passes it through here
 * — see `packages/canopycms-cdk/worker/github-app-auth.ts` and
 * `docs/adopter-migration.md` for a hand-written entrypoint.
 */
export interface OctokitAuthStrategyOptions {
  /**
   * Octokit calls this with `{ request, log, octokit, octokitOptions }`, the
   * fields of `auth` below merged over them, and expects an object carrying a
   * `.hook`. `createAppAuth(…)`'s return value satisfies that; so does a
   * closure returning an already-constructed one, which is how one auth
   * instance — and so one installation-token cache — is shared with a caller
   * that also mints tokens outside Octokit.
   */
  authStrategy: (options: Record<string, unknown>) => unknown
  /** Merged into the strategy's options by Octokit. */
  auth: unknown
}

/** Either a bare token (the PAT path) or a pluggable auth strategy. */
export type CanopyOctokitAuthOptions = { auth: string } | OctokitAuthStrategyOptions

/**
 * Create an Octokit instance with the throttling plugin attached, so it
 * proactively respects GitHub's `retry-after` guidance on rate limits
 * instead of failing immediately (see worker/task-runner.ts's isPermanentTaskFailure
 * for the safety net this doesn't cover: exhausted plugin retries and
 * errors the plugin never sees, like non-403 network failures).
 */
export function createCanopyOctokit(options: CanopyOctokitAuthOptions): Octokit {
  // Pick the two auth fields out EXPLICITLY, never spread: `baseUrl`,
  // `request`, `log` and `userAgent` are all live `OctokitOptions`, and a
  // non-literal argument slips past TypeScript's excess-property check. The
  // contract is "our Octokit, authenticated the way you say", not "configured
  // however you like".
  const auth =
    'authStrategy' in options
      ? { authStrategy: options.authStrategy, auth: options.auth }
      : { auth: options.auth }
  return new ThrottledOctokit({
    ...auth,
    throttle: {
      onRateLimit: (retryAfter, requestOptions, _octokit, retryCount) => {
        canopyLogWarn(
          `CanopyCMS: GitHub primary rate limit hit for ${requestOptions.method} ${requestOptions.url} ` +
            `(retryAfter=${retryAfter}s, retryCount=${retryCount})`,
        )
        return shouldRetryRateLimit(retryAfter, retryCount)
      },
      onSecondaryRateLimit: (retryAfter, requestOptions, _octokit, retryCount) => {
        canopyLogWarn(
          `CanopyCMS: GitHub secondary rate limit hit for ${requestOptions.method} ${requestOptions.url} ` +
            `(retryAfter=${retryAfter}s, retryCount=${retryCount})`,
        )
        return shouldRetrySecondaryRateLimit(retryAfter, retryCount)
      },
    },
  })
}

export interface GitHubServiceOptions {
  token: string
  owner: string
  repo: string
  baseBranch?: string
}

export interface PullRequestOptions {
  branchName: string
  title: string
  body: string
  draft?: boolean
}

export interface PullRequestDetails {
  number: number
  url: string
  state: 'open' | 'closed'
  merged: boolean
  draft: boolean
}

export interface CreateOrUpdatePullRequestParams {
  octokit: Octokit
  owner: string
  repo: string
  head: string
  base: string
  title: string
  body: string
  /** Convert a pre-existing draft PR to ready-for-review after updating it. */
  markReadyIfDraft?: boolean
  /** Forwarded to all GitHub requests (worker task-timeout abort). */
  signal?: AbortSignal
}

/**
 * Create or update a pull request, idempotently: an open PR from head to base
 * is updated and returned rather than erroring. That keeps PR submission
 * retryable — a caller that crashes after GitHub creates the PR but before it
 * persists the number recovers the existing PR instead of hitting the 422 a
 * blind create throws on a duplicate, which wedges the branch in 'sync-failed'.
 *
 * Shared by `GitHubService.createOrUpdatePR` (direct-API callers) and the
 * worker's `push-and-create-or-update-pr` task, so the list->tiebreak->
 * update/create logic and the draft->ready conversion live in one place.
 */
export async function createOrUpdatePullRequest(
  params: CreateOrUpdatePullRequestParams,
): Promise<{ number: number; url: string; created: boolean }> {
  const { octokit, owner, repo, head, base, title, body, markReadyIfDraft, signal } = params
  // CONDITIONAL spread: with no signal, the request objects below carry no
  // `request` key at all (github-service.test.ts asserts on their exact shape).
  const requestOption = signal ? { request: { signal } } : {}

  const existingPRs = await octokit.pulls.list({
    owner,
    repo,
    head: `${owner}:${head}`,
    base,
    state: 'open',
    ...requestOption,
  })

  if (existingPRs.data.length > 0) {
    // GitHub disallows more than one open PR for a head+base pair, so this is
    // normally a single match. Don't trust array order anyway: if more than one
    // comes back, warn and take the most recently updated.
    let existing = existingPRs.data[0]
    if (existingPRs.data.length > 1) {
      existing = [...existingPRs.data].sort(
        (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      )[0]
      canopyLogWarn(
        `CanopyCMS: Found ${existingPRs.data.length} open PRs for ${head} -> ${base}; updating the most recently updated (#${existing.number})`,
      )
    }
    await octokit.pulls.update({
      owner,
      repo,
      pull_number: existing.number,
      title,
      body,
      ...requestOption,
    })

    // Only a pre-existing PR can be a draft on this path — pulls.create
    // above is never called with draft: true, so a newly created PR is
    // never draft and needs no conversion.
    if (markReadyIfDraft && existing.draft) {
      // GraphQL: draft conversion has no REST equivalent. The node id comes
      // straight off the list payload — no extra pulls.get.
      //
      // Best-effort, because the push and pulls.update above already succeeded:
      // a fine-grained token lacking this mutation's scope throws a
      // GraphqlResponseError with no numeric HTTP status (GraphQL answers 200
      // even for a mutation-level failure), which the worker's
      // isPermanentTaskFailure reads as transient and retries the whole re-push
      // to the cap, wedging the branch in 'sync-failed' even though the PR
      // exists and is current.
      try {
        await octokit.graphql(
          `
          mutation($pullRequestId: ID!) {
            markPullRequestReadyForReview(input: {pullRequestId: $pullRequestId}) {
              pullRequest {
                id
              }
            }
          }
        `,
          {
            pullRequestId: existing.node_id,
            ...requestOption,
          },
        )
      } catch (err) {
        canopyLogWarn(
          `CanopyCMS: Failed to convert PR #${existing.number} to ready for review (the PR update itself succeeded; continuing):`,
          getErrorMessage(err),
        )
      }
    }

    return { number: existing.number, url: existing.html_url, created: false }
  }

  const pr = await octokit.pulls.create({
    owner,
    repo,
    head,
    base,
    title,
    body,
    ...requestOption,
  })

  return { number: pr.data.number, url: pr.data.html_url, created: true }
}

export class GitHubService {
  private octokit: Octokit
  private owner: string
  private repo: string
  private baseBranch: string

  constructor(options: GitHubServiceOptions) {
    this.octokit = createCanopyOctokit({ auth: options.token })
    this.owner = options.owner
    this.repo = options.repo
    this.baseBranch = options.baseBranch ?? 'main'
  }

  async createPullRequest(options: PullRequestOptions): Promise<{ number: number; url: string }> {
    const response = await this.octokit.pulls.create({
      owner: this.owner,
      repo: this.repo,
      title: options.title,
      body: options.body,
      head: options.branchName,
      base: this.baseBranch,
      draft: options.draft ?? false,
    })

    return {
      number: response.data.number,
      url: response.data.html_url,
    }
  }

  async updatePullRequest(
    prNumber: number,
    options: Partial<Pick<PullRequestOptions, 'title' | 'body'>>,
  ): Promise<void> {
    await this.octokit.pulls.update({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      title: options.title,
      body: options.body,
    })
  }

  /**
   * Idempotent create-or-update, bound to this instance's octokit/owner/repo.
   * See {@link createOrUpdatePullRequest}.
   */
  async createOrUpdatePR(options: {
    head: string
    base: string
    title: string
    body: string
    /** Convert a pre-existing draft PR to ready-for-review after updating it. */
    markReadyIfDraft?: boolean
  }): Promise<{ number: number; url: string }> {
    const result = await createOrUpdatePullRequest({
      octokit: this.octokit,
      owner: this.owner,
      repo: this.repo,
      head: options.head,
      base: options.base,
      title: options.title,
      body: options.body,
      markReadyIfDraft: options.markReadyIfDraft,
    })
    return { number: result.number, url: result.url }
  }

  async getPullRequest(prNumber: number): Promise<PullRequestDetails> {
    const response = await this.octokit.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
    })

    return {
      number: response.data.number,
      url: response.data.html_url,
      state: response.data.state as 'open' | 'closed',
      merged: response.data.merged ?? false,
      draft: response.data.draft ?? false,
    }
  }

  async convertToDraft(prNumber: number): Promise<void> {
    // Use GraphQL API for draft conversion (not available in REST API)
    await this.octokit.graphql(
      `
      mutation($pullRequestId: ID!) {
        convertPullRequestToDraft(input: {pullRequestId: $pullRequestId}) {
          pullRequest {
            id
          }
        }
      }
    `,
      {
        pullRequestId: await this.getPullRequestNodeId(prNumber),
      },
    )
  }

  async convertToReady(prNumber: number): Promise<void> {
    // Use GraphQL API for draft conversion (not available in REST API)
    await this.octokit.graphql(
      `
      mutation($pullRequestId: ID!) {
        markPullRequestReadyForReview(input: {pullRequestId: $pullRequestId}) {
          pullRequest {
            id
          }
        }
      }
    `,
      {
        pullRequestId: await this.getPullRequestNodeId(prNumber),
      },
    )
  }

  async closePullRequest(prNumber: number): Promise<void> {
    await this.octokit.pulls.update({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      state: 'closed',
    })
  }

  async deleteBranch(branchName: string): Promise<void> {
    await this.octokit.git.deleteRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${branchName}`,
    })
  }

  private async getPullRequestNodeId(prNumber: number): Promise<string> {
    const response = await this.octokit.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
    })
    return response.data.node_id
  }

  /**
   * Extract owner and repo from a GitHub remote URL, in either HTTPS
   * (`https://github.com/owner/repo[.git]`) or SSH
   * (`git@github.com:owner/repo[.git]`) form.
   */
  static parseRemoteUrl(remoteUrl: string): { owner: string; repo: string } {
    const urlWithoutGit = remoteUrl.replace(/\.git$/, '')

    const httpsMatch = urlWithoutGit.match(/https?:\/\/github\.com\/([^/]+)\/([^/]+)/)
    if (httpsMatch) {
      return {
        owner: httpsMatch[1],
        repo: httpsMatch[2],
      }
    }

    // String parsing instead of regex to avoid polynomial ReDoS on crafted inputs
    const sshPrefix = 'git@github.com:'
    if (urlWithoutGit.startsWith(sshPrefix)) {
      const ownerRepo = urlWithoutGit.slice(sshPrefix.length)
      const slashIdx = ownerRepo.indexOf('/')
      if (slashIdx > 0) {
        return {
          owner: ownerRepo.slice(0, slashIdx),
          repo: ownerRepo.slice(slashIdx + 1),
        }
      }
    }

    throw new Error(`Unable to parse GitHub remote URL: ${remoteUrl}`)
  }
}

/**
 * A GitHub service for this config and remote URL, or null when one cannot be
 * built (mode without PR support, missing token, unparseable remote).
 */
export const createGitHubService = (
  config: CanopyConfig,
  remoteUrl?: string,
): GitHubService | null => {
  const mode = config.mode
  if (!operatingStrategy(mode).supportsPullRequests()) {
    return null
  }

  const tokenEnvVar = config.githubTokenEnvVar ?? 'GITHUB_BOT_TOKEN'
  const token = process.env[tokenEnvVar] ?? process.env.CANOPYCMS_GITHUB_TOKEN

  if (!token) {
    canopyLogWarn(`CanopyCMS: GitHub token not found in ${tokenEnvVar} or CANOPYCMS_GITHUB_TOKEN`)
    return null
  }

  if (!remoteUrl) {
    canopyLogWarn('CanopyCMS: GitHub service requires remoteUrl to determine repository')
    return null
  }

  try {
    const { owner, repo } = GitHubService.parseRemoteUrl(remoteUrl)
    return new GitHubService({
      token,
      owner,
      repo,
      baseBranch: config.defaultBaseBranch ?? 'main',
    })
  } catch (err) {
    canopyLogWarn('CanopyCMS: Failed to parse GitHub remote URL:', err)
    return null
  }
}
