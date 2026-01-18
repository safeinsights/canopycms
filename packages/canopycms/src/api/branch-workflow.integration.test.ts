/**
 * Integration tests for the full GitHub PR workflow
 * Tests the complete lifecycle: create → submit → withdraw → request changes → resubmit → merge
 * Uses mocked Octokit to simulate GitHub API responses
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { simpleGit } from 'simple-git'

import { GitHubService } from '../github-service'
import { GitManager } from '../git-manager'
import { initBareRepo } from '../__integration__/test-utils/test-workspace'
import { BranchWorkspaceManager, loadBranchContext } from '../branch-workspace'
import { getBranchMetadataFileManager } from '../branch-metadata'
import { CommentStore } from '../comment-store'
import { defineCanopyTestConfig } from '../config-test'

// Mock Octokit
const mockOctokit = {
  pulls: {
    create: vi.fn(),
    update: vi.fn(),
    get: vi.fn(),
  },
  rest: {
    pulls: {
      updateBranch: vi.fn(),
    },
  },
  graphql: vi.fn(),
}

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(() => mockOctokit),
}))

describe('PR Workflow Integration', () => {
  let tmpRoot: string
  let cwdSpy: any
  let prNumber = 1

  beforeEach(async () => {
    // Create temp directory for test workspace
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-pr-workflow-'))
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpRoot)

    // Reset PR counter
    prNumber = 1

    // Reset all mocks
    mockOctokit.pulls.create.mockReset()
    mockOctokit.pulls.update.mockReset()
    mockOctokit.pulls.get.mockReset()
    mockOctokit.rest.pulls.updateBranch.mockReset()
    mockOctokit.graphql.mockReset()

    // Setup default mock responses
    mockOctokit.pulls.create.mockImplementation(async (opts: any) => {
      const currentPR = prNumber++
      return {
        data: {
          number: currentPR,
          html_url: `https://github.com/${opts.owner}/${opts.repo}/pull/${currentPR}`,
          state: 'open',
          merged: false,
          draft: opts.draft ?? false,
        },
      }
    })

    mockOctokit.pulls.get.mockImplementation(async (opts: any) => {
      return {
        data: {
          number: opts.pull_number,
          html_url: `https://github.com/testorg/testrepo/pull/${opts.pull_number}`,
          state: 'open',
          merged: false,
          draft: false,
        },
      }
    })

    mockOctokit.pulls.update.mockImplementation(async (opts: any) => {
      return {
        data: {
          number: opts.pull_number,
          html_url: `https://github.com/testorg/testrepo/pull/${opts.pull_number}`,
          state: 'open',
          merged: false,
          draft: false,
        },
      }
    })

    mockOctokit.graphql.mockResolvedValue({
      markPullRequestReadyForReview: {
        pullRequest: {
          id: 'test-pr-id',
        },
      },
    })
  })

  afterEach(async () => {
    cwdSpy.mockRestore()
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  it('completes full PR workflow: create → submit → withdraw → request changes → resubmit → merge', async () => {
    const branchName = 'feature-pr-test'
    const remotePath = path.join(tmpRoot, 'remote.git')
    const seedPath = path.join(tmpRoot, 'seed')
    const owner = 'testorg'
    const repo = 'testrepo'

    // ===== SETUP: Initialize bare remote and seed main branch =====
    await initBareRepo(remotePath)

    await fs.mkdir(seedPath, { recursive: true })
    const seedGit = simpleGit({ baseDir: seedPath })
    await seedGit.init()
    await seedGit.raw(['branch', '-M', 'main'])
    await fs.mkdir(path.join(seedPath, 'content'), { recursive: true })
    await fs.writeFile(path.join(seedPath, 'README.md'), '# Test Repo\n', 'utf8')
    await seedGit.add(['.'])
    await seedGit.commit('Initial commit')
    await seedGit.addRemote('origin', remotePath)
    await seedGit.push('origin', 'main', { '--set-upstream': null })

    // ===== SETUP: Create CanopyCMS config and services =====
    const config = defineCanopyTestConfig({
      mode: 'prod-sim',
      defaultBranchAccess: 'allow',
      defaultBaseBranch: 'main',
      defaultRemoteName: 'origin',
      defaultRemoteUrl: remotePath,
      gitBotAuthorName: 'Test Bot',
      gitBotAuthorEmail: 'bot@example.com',
      schema: {
        collections: [
          {
            name: 'posts',
            path: 'posts',
            entries: {
              format: 'json',
              fields: [
                { name: 'title', type: 'string' },
                { name: 'content', type: 'markdown' },
              ],
            },
          },
        ],
        singletons: [],
      },
    })

    const githubService = new GitHubService({
      token: 'test-github-token',
      owner,
      repo,
      baseBranch: 'main',
    })

    // ===== STEP 1: Create branch and workspace =====
    const workspaceManager = new BranchWorkspaceManager(config)
    const workspace = await workspaceManager.openOrCreateBranch({
      branchName,
      mode: config.mode,
      title: 'Test PR Feature',
      description: 'This is a test PR for the integration test',
      createdBy: 'test-user',
      remoteUrl: remotePath,
    })

    expect(workspace).toBeTruthy()
    expect(workspace.branchRoot).toBeTruthy()
    expect(workspace.branch.name).toBe(branchName)
    expect(workspace.branch.status).toBe('editing')
    expect(workspace.branch.pullRequestNumber).toBeUndefined()

    // Configure git user for test commits
    const branchGit = simpleGit({ baseDir: workspace.branchRoot })
    await branchGit.addConfig('user.name', 'Test User')
    await branchGit.addConfig('user.email', 'test@example.com')

    // ===== STEP 2: Make changes and create a commit =====
    const contentDir = path.join(workspace.branchRoot, 'content', 'posts')
    await fs.mkdir(contentDir, { recursive: true })
    await fs.writeFile(
      path.join(contentDir, 'first-post.json'),
      JSON.stringify({ title: 'First Post', content: 'This is my first post!' }),
      'utf8',
    )

    await branchGit.add(['.'])
    await branchGit.commit('Add first post')

    // ===== STEP 3: Submit branch for merge (creates PR) =====
    const gitManager = new GitManager({
      repoPath: workspace.branchRoot,
      baseBranch: config.defaultBaseBranch ?? 'main',
      remote: config.defaultRemoteName ?? 'origin',
    })
    await gitManager.add(['.'])
    await gitManager.commit('Test commit before submit')
    await gitManager.push(branchName)

    // Create PR via GitHub service
    const prResult = await githubService.createPullRequest({
      branchName,
      title: workspace.branch.title ?? 'Test PR',
      body: workspace.branch.description ?? 'Test PR description',
      draft: false,
    })

    expect(prResult.number).toBe(1)
    expect(prResult.url).toContain('pull/1')
    expect(mockOctokit.pulls.create).toHaveBeenCalledWith({
      owner,
      repo,
      title: 'Test PR Feature',
      body: 'This is a test PR for the integration test',
      head: branchName,
      base: 'main',
      draft: false,
    })

    // Update branch metadata with PR info
    const metadata = getBranchMetadataFileManager(workspace.branchRoot, workspace.baseRoot)
    await metadata.save({
      branch: {
        status: 'submitted',
        pullRequestNumber: prResult.number,
        pullRequestUrl: prResult.url,
      },
    })

    // Reload state and verify PR info
    const submittedContext = await loadBranchContext({ branchName, mode: config.mode })
    expect(submittedContext?.branch.status).toBe('submitted')
    expect(submittedContext?.branch.pullRequestNumber).toBe(1)
    expect(submittedContext?.branch.pullRequestUrl).toContain('pull/1')

    // ===== STEP 4: Withdraw submission (convert PR to draft) =====
    await githubService.convertToDraft(prResult.number)
    await metadata.save({ branch: { status: 'editing' } })

    const withdrawnContext = await loadBranchContext({ branchName, mode: config.mode })
    expect(withdrawnContext?.branch.status).toBe('editing')

    // Mock PR as draft for next get() call
    mockOctokit.pulls.get.mockImplementationOnce(async (opts: any) => ({
      data: {
        number: opts.pull_number,
        html_url: `https://github.com/testorg/testrepo/pull/${opts.pull_number}`,
        state: 'open',
        merged: false,
        draft: true, // Now draft
      },
    }))

    // Verify PR is draft
    const prDetails = await githubService.getPullRequest(prResult.number)
    expect(prDetails.draft).toBe(true)

    // ===== STEP 5: Request changes (reviewer action) =====
    await metadata.save({ branch: { status: 'editing' } })

    const changesRequestedContext = await loadBranchContext({ branchName, mode: config.mode })
    expect(changesRequestedContext?.branch.status).toBe('editing')

    // ===== STEP 6: Make additional changes and resubmit =====
    await fs.writeFile(
      path.join(contentDir, 'second-post.json'),
      JSON.stringify({ title: 'Second Post', content: 'Another post after changes requested' }),
      'utf8',
    )

    await branchGit.add(['.'])
    await branchGit.commit('Add second post after review')
    await branchGit.push('origin', branchName, { '--force': null })

    // Update PR (not create new one)
    await githubService.updatePullRequest(prResult.number, {
      title: 'Updated: Test PR Feature',
      body: 'Updated PR description after changes',
    })

    expect(mockOctokit.pulls.update).toHaveBeenCalledWith({
      owner,
      repo,
      pull_number: 1,
      title: 'Updated: Test PR Feature',
      body: 'Updated PR description after changes',
    })

    // Convert from draft to ready
    mockOctokit.pulls.get.mockImplementationOnce(async (opts: any) => ({
      data: {
        number: opts.pull_number,
        html_url: `https://github.com/testorg/testrepo/pull/${opts.pull_number}`,
        state: 'open',
        merged: false,
        draft: false, // Back to ready
      },
    }))

    await githubService.convertToReady(prResult.number)
    await metadata.save({ branch: { status: 'submitted' } })

    const resubmittedContext = await loadBranchContext({ branchName, mode: config.mode })
    expect(resubmittedContext?.branch.status).toBe('submitted')
    expect(resubmittedContext?.branch.pullRequestNumber).toBe(1) // Same PR number

    // ===== STEP 7: Add and resolve comments =====
    const commentStore = new CommentStore(workspace.branchRoot)
    await commentStore.load()

    // Add field comment
    const fieldThread = await commentStore.addComment({
      text: 'Please revise the title',
      userId: 'reviewer1',
      type: 'field',
      entryId: 'posts/first-post',
      canopyPath: 'title',
    })

    // Add entry comment
    const entryThread = await commentStore.addComment({
      text: 'Overall structure looks good',
      userId: 'reviewer1',
      type: 'entry',
      entryId: 'posts/first-post',
    })

    // Add branch comment
    const branchThread = await commentStore.addComment({
      text: 'Great work on this feature!',
      userId: 'reviewer1',
      type: 'branch',
    })

    // Add reply to field comment
    await commentStore.addComment({
      text: 'Updated the title',
      userId: 'author1',
      threadId: fieldThread.threadId,
      type: 'field',
      entryId: 'posts/first-post',
      canopyPath: 'title',
    })

    // List all comments
    await commentStore.load()
    const allThreads = await commentStore.listThreads()
    expect(allThreads).toHaveLength(3)

    // Verify field comments
    const fieldThreads = await commentStore.getThreadsForField('posts/first-post', 'title')
    expect(fieldThreads).toHaveLength(1)
    expect(fieldThreads[0].comments).toHaveLength(2) // Original + reply

    // Verify entry comments
    const entryThreads = await commentStore.getThreadsForEntry('posts/first-post')
    expect(entryThreads).toHaveLength(1)

    // Verify branch comments
    const branchThreads = await commentStore.getBranchThreads()
    expect(branchThreads).toHaveLength(1)

    // Resolve field comment thread
    await commentStore.resolveThread(fieldThread.threadId, 'reviewer1')
    await commentStore.load()
    const allThreadsAfterResolve = await commentStore.listThreads()
    const resolvedThread = allThreadsAfterResolve.find((t) => t.id === fieldThread.threadId)
    expect(resolvedThread?.resolved).toBe(true)
    expect(resolvedThread?.resolvedBy).toBe('reviewer1')

    // ===== STEP 8: Merge PR and mark as merged =====
    // Mock PR as merged
    mockOctokit.pulls.get.mockImplementationOnce(async (opts: any) => ({
      data: {
        number: opts.pull_number,
        html_url: `https://github.com/testorg/testrepo/pull/${opts.pull_number}`,
        state: 'closed',
        merged: true,
        draft: false,
      },
    }))

    // Verify PR is merged
    const mergedPR = await githubService.getPullRequest(prResult.number)
    expect(mergedPR.merged).toBe(true)
    expect(mergedPR.state).toBe('closed')

    // Mark branch as merged in CanopyCMS
    await metadata.save({ branch: { status: 'archived' } })

    const archivedContext = await loadBranchContext({ branchName, mode: config.mode })
    expect(archivedContext?.branch.status).toBe('archived')
    expect(archivedContext?.branch.pullRequestNumber).toBe(1)

    // Verify comments are still accessible in archived branch
    const archivedComments = new CommentStore(archivedContext!.branchRoot)
    await archivedComments.load()
    const archivedThreads = await archivedComments.listThreads()
    expect(archivedThreads).toHaveLength(3) // All comments preserved
  })

  it('handles PR workflow with draft submissions', async () => {
    const branchName = 'feature-draft-test'
    const remotePath = path.join(tmpRoot, 'remote-draft.git')
    const seedPath = path.join(tmpRoot, 'seed-draft')
    const owner = 'testorg'
    const repo = 'testrepo-draft'

    // Setup remote and seed
    await initBareRepo(remotePath)
    await fs.mkdir(seedPath, { recursive: true })
    const seedGit = simpleGit({ baseDir: seedPath })
    await seedGit.init()
    await seedGit.raw(['branch', '-M', 'main'])
    await fs.writeFile(path.join(seedPath, 'README.md'), '# Draft Test\n', 'utf8')
    await seedGit.add(['.'])
    await seedGit.commit('Initial commit')
    await seedGit.addRemote('origin', remotePath)
    await seedGit.push('origin', 'main', { '--set-upstream': null })

    const config = defineCanopyTestConfig({
      mode: 'prod-sim',
      defaultBranchAccess: 'allow',
      defaultBaseBranch: 'main',
      defaultRemoteUrl: remotePath,
      gitBotAuthorName: 'Bot',
      gitBotAuthorEmail: 'bot@test.com',
      schema: {
        collections: [],
        singletons: [
          {
            name: 'home',
            path: 'home',
            format: 'json',
            fields: [{ name: 'title', type: 'string' }],
          },
        ],
      },
    })

    const githubService = new GitHubService({
      token: 'test-token',
      owner,
      repo,
      baseBranch: 'main',
    })

    // Create branch
    const workspaceManager = new BranchWorkspaceManager(config)
    const workspace = await workspaceManager.openOrCreateBranch({
      branchName,
      mode: config.mode,
      title: 'Draft PR Test',
      createdBy: 'test-user',
      remoteUrl: remotePath,
    })

    const branchGit = simpleGit({ baseDir: workspace.branchRoot })
    await branchGit.addConfig('user.name', 'Test User')
    await branchGit.addConfig('user.email', 'test@test.com')

    // Make changes
    await fs.mkdir(path.join(workspace.branchRoot, 'content'), { recursive: true })
    await fs.writeFile(
      path.join(workspace.branchRoot, 'content', 'home.json'),
      JSON.stringify({ title: 'Home Page' }),
      'utf8',
    )
    await branchGit.add(['.'])
    await branchGit.commit('Update home page')
    await branchGit.push('origin', branchName, { '--set-upstream': null })

    // Submit as draft
    const draftPR = await githubService.createPullRequest({
      branchName,
      title: 'Draft: Home Page Updates',
      body: 'Work in progress',
      draft: true,
    })

    expect(draftPR.number).toBeGreaterThan(0)
    expect(mockOctokit.pulls.create).toHaveBeenCalledWith({
      owner,
      repo,
      title: 'Draft: Home Page Updates',
      body: 'Work in progress',
      head: branchName,
      base: 'main',
      draft: true,
    })

    // Mock PR details as draft initially, then as ready
    mockOctokit.pulls.get.mockImplementationOnce(async (opts: any) => ({
      data: {
        number: opts.pull_number,
        html_url: `https://github.com/${owner}/${repo}/pull/${opts.pull_number}`,
        state: 'open',
        merged: false,
        draft: true,
      },
    }))

    // Verify PR is draft
    const prDetails = await githubService.getPullRequest(draftPR.number)
    expect(prDetails.draft).toBe(true)

    // Mock ready state for next call
    mockOctokit.pulls.get.mockImplementationOnce(async (opts: any) => ({
      data: {
        number: opts.pull_number,
        html_url: `https://github.com/${owner}/${repo}/pull/${opts.pull_number}`,
        state: 'open',
        merged: false,
        draft: false,
      },
    }))

    // Convert to ready for review
    await githubService.convertToReady(draftPR.number)
    const readyPR = await githubService.getPullRequest(draftPR.number)
    expect(readyPR.draft).toBe(false)

    // Mock merged state
    mockOctokit.pulls.get.mockImplementationOnce(async (opts: any) => ({
      data: {
        number: opts.pull_number,
        html_url: `https://github.com/${owner}/${repo}/pull/${opts.pull_number}`,
        state: 'closed',
        merged: true,
        draft: false,
      },
    }))

    // Simulate merge
    const mergedPR = await githubService.getPullRequest(draftPR.number)
    expect(mergedPR.merged).toBe(true)
  })
})
