import { Octokit } from '@octokit/rest'
import { throttling } from '@octokit/plugin-throttling'
import type { CanopyConfig } from './config'
import { operatingStrategy } from './operating-mode'
import { getErrorMessage } from './utils/error'
// canopyLogWarn, not console.warn: this module runs inside the WORKER process
// (its Octokit is the worker's own, and the PR create/update path below is a
// worker task), where every line must carry worker/log.ts's ISO-8601 prefix or
// CloudWatch folds it into the previous event. Under Lambda/dev the helper is
// plain console. See utils/logger.ts.
import { canopyLogWarn } from './utils/logger'

const ThrottledOctokit = Octokit.plugin(throttling)

/**
 * Retry primary rate limits at most twice and only for short waits; beyond
 * that, task-level retry/backoff (worker) or the caller's error path takes
 * over. The worker's task timeout would abort a longer in-request wait
 * anyway.
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
 * Create an Octokit instance with the throttling plugin attached, so it
 * proactively respects GitHub's `retry-after` guidance on rate limits
 * instead of failing immediately (see worker/task-runner.ts's isPermanentTaskFailure
 * for the safety net this doesn't cover: exhausted plugin retries and
 * errors the plugin never sees, like non-403 network failures).
 */
export function createCanopyOctokit(options: { auth: string }): Octokit {
  return new ThrottledOctokit({
    auth: options.auth,
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
 * Create or update a pull request (idempotent — GIT-H1).
 *
 * If an open PR already exists from head to base, update it and return its
 * number/url instead of erroring. This makes PR submission safely
 * retryable: if a caller crashes after GitHub creates the PR but before it
 * persists the returned PR number, calling this again recovers the
 * existing PR instead of hitting the 422 that a blind create would throw on
 * a duplicate, which previously wedged the branch in 'sync-failed'
 * permanently.
 *
 * Shared by `GitHubService.createOrUpdatePR` (direct-API callers) and the
 * worker's `push-and-create-or-update-pr` task, so the list->tiebreak->
 * update/create logic and the draft->ready conversion live in one place.
 */
export async function createOrUpdatePullRequest(
  params: CreateOrUpdatePullRequestParams,
): Promise<{ number: number; url: string; created: boolean }> {
  const { octokit, owner, repo, head, base, title, body, markReadyIfDraft, signal } = params
  // CONDITIONAL spread: when no signal is passed, request objects below are
  // byte-identical to the pre-refactor call sites (exact toHaveBeenCalledWith
  // assertions in github-service.test.ts depend on this).
  const requestOption = signal ? { request: { signal } } : {}

  // Check if an open PR already exists for this head/base
  const existingPRs = await octokit.pulls.list({
    owner,
    repo,
    head: `${owner}:${head}`,
    base,
    state: 'open',
    ...requestOption,
  })

  if (existingPRs.data.length > 0) {
    // GIT-M5: GitHub disallows more than one open PR for a given
    // head+base pair, so this should always be a single match. Guard
    // against blindly trusting array order anyway — if more than one is
    // ever returned, warn and prefer the most recently updated instead of
    // an arbitrary one.
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
      // Use GraphQL API for draft conversion (not available in REST API).
      // Read the node id straight off the list payload — no extra pulls.get.
      //
      // Best-effort: the push + pulls.update above already succeeded, so the
      // submit itself is done. A fine-grained token that can update PRs but
      // lacks this mutation's scope throws a GraphqlResponseError, which
      // carries no numeric HTTP status (the GraphQL endpoint responds 200
      // even for a mutation-level failure) — the worker's
      // isPermanentTaskFailure would classify that as transient and retry
      // the whole re-push until the retry cap, wedging the branch in
      // 'sync-failed' even though the PR already exists and is current.
      // Warn and continue instead of letting this sink an already-succeeded
      // submit.
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

  // Create new PR
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

/**
 * Service for interacting with GitHub API (pull requests, branches, etc.)
 */
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

  /**
   * Create a new pull request
   */
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

  /**
   * Update an existing pull request
   */
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
   * Create or update a pull request (idempotent — GIT-H1).
   *
   * Thin delegate to the module-level `createOrUpdatePullRequest` helper
   * (shared with the worker's `push-and-create-or-update-pr` task) bound to
   * this instance's octokit/owner/repo. See that function's doc comment for
   * the idempotency rationale.
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

  /**
   * Get pull request details
   */
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

  /**
   * Convert a pull request to draft
   */
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

  /**
   * Convert a draft pull request to ready for review
   */
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

  /**
   * Close a pull request
   */
  async closePullRequest(prNumber: number): Promise<void> {
    await this.octokit.pulls.update({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      state: 'closed',
    })
  }

  /**
   * Delete a remote branch
   */
  async deleteBranch(branchName: string): Promise<void> {
    await this.octokit.git.deleteRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${branchName}`,
    })
  }

  /**
   * Get the GraphQL node ID for a pull request (needed for draft operations)
   */
  private async getPullRequestNodeId(prNumber: number): Promise<string> {
    const response = await this.octokit.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
    })
    return response.data.node_id
  }

  /**
   * Parse GitHub remote URL to extract owner and repo
   * Supports both HTTPS and SSH formats:
   * - https://github.com/owner/repo.git
   * - https://github.com/owner/repo
   * - git@github.com:owner/repo.git
   * - git@github.com:owner/repo
   */
  static parseRemoteUrl(remoteUrl: string): { owner: string; repo: string } {
    // Remove .git suffix if present
    const urlWithoutGit = remoteUrl.replace(/\.git$/, '')

    // Try HTTPS format first
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
 * Create a GitHub service instance from config and remote URL
 * Returns null if not applicable (missing token, not GitHub, etc.)
 */
export const createGitHubService = (
  config: CanopyConfig,
  remoteUrl?: string,
): GitHubService | null => {
  // Only create service for modes that support pull requests
  const mode = config.mode
  if (!operatingStrategy(mode).supportsPullRequests()) {
    return null
  }

  // Get token from environment
  const tokenEnvVar = config.githubTokenEnvVar ?? 'GITHUB_BOT_TOKEN'
  const token = process.env[tokenEnvVar] ?? process.env.CANOPYCMS_GITHUB_TOKEN

  if (!token) {
    canopyLogWarn(`CanopyCMS: GitHub token not found in ${tokenEnvVar} or CANOPYCMS_GITHUB_TOKEN`)
    return null
  }

  // Need remote URL to determine owner/repo
  if (!remoteUrl) {
    canopyLogWarn('CanopyCMS: GitHub service requires remoteUrl to determine repository')
    return null
  }

  // Parse remote URL
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
