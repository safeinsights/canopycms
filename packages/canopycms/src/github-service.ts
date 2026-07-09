import { Octokit } from '@octokit/rest'
import type { CanopyConfig } from './config'
import { operatingStrategy } from './operating-mode'

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

/**
 * Service for interacting with GitHub API (pull requests, branches, etc.)
 */
export class GitHubService {
  private octokit: Octokit
  private owner: string
  private repo: string
  private baseBranch: string

  constructor(options: GitHubServiceOptions) {
    this.octokit = new Octokit({ auth: options.token })
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
   * If an open PR already exists from head to base, update it and return its
   * number/url instead of erroring. This makes PR submission safely
   * retryable: if a caller crashes after GitHub creates the PR but before it
   * persists the returned PR number, calling this again recovers the
   * existing PR instead of hitting the 422 that `createPullRequest` would
   * throw on a duplicate, which previously wedged the branch in
   * 'sync-failed' permanently.
   */
  async createOrUpdatePR(options: {
    head: string
    base: string
    title: string
    body: string
  }): Promise<{ number: number; url: string }> {
    // Check if an open PR already exists for this head/base
    const existingPRs = await this.octokit.pulls.list({
      owner: this.owner,
      repo: this.repo,
      head: `${this.owner}:${options.head}`,
      base: options.base,
      state: 'open',
    })

    if (existingPRs.data.length > 0) {
      // GIT-M5: GitHub disallows more than one open PR for a given
      // head+base pair, so this should always be a single match. Guard
      // against blindly trusting array order anyway — if more than one is
      // ever returned, warn and prefer the most recently updated instead of
      // an arbitrary one.
      let pr = existingPRs.data[0]
      if (existingPRs.data.length > 1) {
        pr = [...existingPRs.data].sort(
          (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
        )[0]
        console.warn(
          `CanopyCMS: Found ${existingPRs.data.length} open PRs for ${options.head} -> ${options.base}; updating the most recently updated (#${pr.number})`,
        )
      }
      await this.octokit.pulls.update({
        owner: this.owner,
        repo: this.repo,
        pull_number: pr.number,
        title: options.title,
        body: options.body,
      })
      return { number: pr.number, url: pr.html_url }
    }

    // Create new PR
    const pr = await this.octokit.pulls.create({
      owner: this.owner,
      repo: this.repo,
      head: options.head,
      base: options.base,
      title: options.title,
      body: options.body,
    })

    return { number: pr.data.number, url: pr.data.html_url }
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
    console.warn(`CanopyCMS: GitHub token not found in ${tokenEnvVar} or CANOPYCMS_GITHUB_TOKEN`)
    return null
  }

  // Need remote URL to determine owner/repo
  if (!remoteUrl) {
    console.warn('CanopyCMS: GitHub service requires remoteUrl to determine repository')
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
    console.warn('CanopyCMS: Failed to parse GitHub remote URL:', err)
    return null
  }
}
