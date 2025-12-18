import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GitHubService, createGitHubService } from './github-service'
import type { CanopyConfig } from './config'

describe('GitHubService', () => {
  describe('parseRemoteUrl', () => {
    it('should parse HTTPS URL with .git suffix', () => {
      const result = GitHubService.parseRemoteUrl('https://github.com/owner/repo.git')
      expect(result).toEqual({ owner: 'owner', repo: 'repo' })
    })

    it('should parse HTTPS URL without .git suffix', () => {
      const result = GitHubService.parseRemoteUrl('https://github.com/owner/repo')
      expect(result).toEqual({ owner: 'owner', repo: 'repo' })
    })

    it('should parse SSH URL with .git suffix', () => {
      const result = GitHubService.parseRemoteUrl('git@github.com:owner/repo.git')
      expect(result).toEqual({ owner: 'owner', repo: 'repo' })
    })

    it('should parse SSH URL without .git suffix', () => {
      const result = GitHubService.parseRemoteUrl('git@github.com:owner/repo')
      expect(result).toEqual({ owner: 'owner', repo: 'repo' })
    })

    it('should handle HTTP (non-secure) URLs', () => {
      const result = GitHubService.parseRemoteUrl('http://github.com/owner/repo.git')
      expect(result).toEqual({ owner: 'owner', repo: 'repo' })
    })

    it('should throw error for invalid URL format', () => {
      expect(() => GitHubService.parseRemoteUrl('invalid-url')).toThrow('Unable to parse GitHub remote URL')
    })

    it('should throw error for non-GitHub URL', () => {
      expect(() => GitHubService.parseRemoteUrl('https://gitlab.com/owner/repo.git')).toThrow(
        'Unable to parse GitHub remote URL'
      )
    })
  })

  describe('createGitHubService', () => {
    const mockConfig: CanopyConfig = {
      schema: [
        {
          type: 'collection',
          name: 'posts',
          path: 'posts',
          format: 'json',
          fields: [{ name: 'title', type: 'string' }],
        },
      ],
      gitBotAuthorName: 'Bot',
      gitBotAuthorEmail: 'bot@example.com',
      defaultBaseBranch: 'main',
      mode: 'local-prod-sim',
      contentRoot: 'content',
    }

    beforeEach(() => {
      // Clear environment variables
      delete process.env.GITHUB_BOT_TOKEN
      delete process.env.CANOPYCMS_GITHUB_TOKEN
    })

    it('should return null for local-simple mode', () => {
      const config = { ...mockConfig, mode: 'local-simple' as const }
      const service = createGitHubService(config, 'https://github.com/owner/repo.git')
      expect(service).toBeNull()
    })

    it('should return null when token is missing', () => {
      const service = createGitHubService(mockConfig, 'https://github.com/owner/repo.git')
      expect(service).toBeNull()
    })

    it('should return null when remoteUrl is missing', () => {
      process.env.GITHUB_BOT_TOKEN = 'test-token'
      const service = createGitHubService(mockConfig)
      expect(service).toBeNull()
    })

    it('should create service with GITHUB_BOT_TOKEN', () => {
      process.env.GITHUB_BOT_TOKEN = 'test-token'
      const service = createGitHubService(mockConfig, 'https://github.com/owner/repo.git')
      expect(service).toBeInstanceOf(GitHubService)
    })

    it('should create service with CANOPYCMS_GITHUB_TOKEN', () => {
      process.env.CANOPYCMS_GITHUB_TOKEN = 'test-token'
      const service = createGitHubService(mockConfig, 'https://github.com/owner/repo.git')
      expect(service).toBeInstanceOf(GitHubService)
    })

    it('should create service with custom token env var', () => {
      process.env.CUSTOM_TOKEN = 'test-token'
      const config = { ...mockConfig, githubTokenEnvVar: 'CUSTOM_TOKEN' }
      const service = createGitHubService(config, 'https://github.com/owner/repo.git')
      expect(service).toBeInstanceOf(GitHubService)
    })

    it('should return null for invalid remote URL', () => {
      process.env.GITHUB_BOT_TOKEN = 'test-token'
      const service = createGitHubService(mockConfig, 'invalid-url')
      expect(service).toBeNull()
    })

    it('should use config baseBranch', () => {
      process.env.GITHUB_BOT_TOKEN = 'test-token'
      const config = { ...mockConfig, defaultBaseBranch: 'develop' }
      const service = createGitHubService(config, 'https://github.com/owner/repo.git')
      expect(service).toBeInstanceOf(GitHubService)
      // baseBranch is private, but we can verify the service was created successfully
    })
  })

  describe('GitHubService methods', () => {
    let service: GitHubService
    let mockOctokit: any

    beforeEach(() => {
      // Create a mock Octokit instance
      mockOctokit = {
        pulls: {
          create: vi.fn(),
          update: vi.fn(),
          get: vi.fn(),
        },
        graphql: vi.fn(),
        git: {
          deleteRef: vi.fn(),
        },
      }

      service = new GitHubService({
        token: 'test-token',
        owner: 'test-owner',
        repo: 'test-repo',
        baseBranch: 'main',
      })

      // Replace the internal octokit instance with our mock
      ;(service as any).octokit = mockOctokit
    })

    describe('createPullRequest', () => {
      it('should create a pull request', async () => {
        mockOctokit.pulls.create.mockResolvedValue({
          data: {
            number: 123,
            html_url: 'https://github.com/test-owner/test-repo/pull/123',
          },
        })

        const result = await service.createPullRequest({
          branchName: 'feature-branch',
          title: 'Test PR',
          body: 'Test description',
        })

        expect(result).toEqual({
          number: 123,
          url: 'https://github.com/test-owner/test-repo/pull/123',
        })

        expect(mockOctokit.pulls.create).toHaveBeenCalledWith({
          owner: 'test-owner',
          repo: 'test-repo',
          title: 'Test PR',
          body: 'Test description',
          head: 'feature-branch',
          base: 'main',
          draft: false,
        })
      })

      it('should create a draft pull request', async () => {
        mockOctokit.pulls.create.mockResolvedValue({
          data: {
            number: 123,
            html_url: 'https://github.com/test-owner/test-repo/pull/123',
          },
        })

        await service.createPullRequest({
          branchName: 'feature-branch',
          title: 'Test PR',
          body: 'Test description',
          draft: true,
        })

        expect(mockOctokit.pulls.create).toHaveBeenCalledWith(
          expect.objectContaining({
            draft: true,
          })
        )
      })
    })

    describe('updatePullRequest', () => {
      it('should update a pull request', async () => {
        mockOctokit.pulls.update.mockResolvedValue({ data: {} })

        await service.updatePullRequest(123, {
          title: 'Updated title',
          body: 'Updated body',
        })

        expect(mockOctokit.pulls.update).toHaveBeenCalledWith({
          owner: 'test-owner',
          repo: 'test-repo',
          pull_number: 123,
          title: 'Updated title',
          body: 'Updated body',
        })
      })
    })

    describe('getPullRequest', () => {
      it('should get pull request details', async () => {
        mockOctokit.pulls.get.mockResolvedValue({
          data: {
            number: 123,
            html_url: 'https://github.com/test-owner/test-repo/pull/123',
            state: 'open',
            merged: false,
            draft: false,
          },
        })

        const result = await service.getPullRequest(123)

        expect(result).toEqual({
          number: 123,
          url: 'https://github.com/test-owner/test-repo/pull/123',
          state: 'open',
          merged: false,
          draft: false,
        })
      })
    })

    describe('convertToDraft', () => {
      it('should convert PR to draft', async () => {
        mockOctokit.pulls.get.mockResolvedValue({
          data: {
            node_id: 'PR_node_123',
          },
        })
        mockOctokit.graphql.mockResolvedValue({})

        await service.convertToDraft(123)

        expect(mockOctokit.graphql).toHaveBeenCalledWith(
          expect.stringContaining('convertPullRequestToDraft'),
          { pullRequestId: 'PR_node_123' }
        )
      })
    })

    describe('convertToReady', () => {
      it('should convert draft PR to ready', async () => {
        mockOctokit.pulls.get.mockResolvedValue({
          data: {
            node_id: 'PR_node_123',
          },
        })
        mockOctokit.graphql.mockResolvedValue({})

        await service.convertToReady(123)

        expect(mockOctokit.graphql).toHaveBeenCalledWith(
          expect.stringContaining('markPullRequestReadyForReview'),
          { pullRequestId: 'PR_node_123' }
        )
      })
    })

    describe('closePullRequest', () => {
      it('should close a pull request', async () => {
        mockOctokit.pulls.update.mockResolvedValue({ data: {} })

        await service.closePullRequest(123)

        expect(mockOctokit.pulls.update).toHaveBeenCalledWith({
          owner: 'test-owner',
          repo: 'test-repo',
          pull_number: 123,
          state: 'closed',
        })
      })
    })

    describe('deleteBranch', () => {
      it('should delete a remote branch', async () => {
        mockOctokit.git.deleteRef.mockResolvedValue({ data: {} })

        await service.deleteBranch('feature-branch')

        expect(mockOctokit.git.deleteRef).toHaveBeenCalledWith({
          owner: 'test-owner',
          repo: 'test-repo',
          ref: 'heads/feature-branch',
        })
      })
    })
  })
})
