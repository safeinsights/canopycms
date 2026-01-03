import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { BranchState } from '../types'
import { getBranchMetadata } from '../branch-metadata'
import { resolveBranchWorkspace } from '../paths'

export const getBranchStatus = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: { branch: string }
): Promise<ApiResponse<{ branch: BranchState }>> => {
  const state = await ctx.getBranchState(params.branch)
  if (!state) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }
  const access = ctx.services.checkBranchAccess(state, req.user)
  if (!access.allowed) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }
  return { ok: true, status: 200, data: { branch: state } }
}

export const submitBranchForMerge = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: { branch: string }
): Promise<ApiResponse<{ branch: BranchState }>> => {
  const state = await ctx.getBranchState(params.branch)
  if (!state) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }
  const access = ctx.services.checkBranchAccess(state, req.user)
  if (!access.allowed) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }

  const branchMode = ctx.services.config.mode ?? 'local-simple'
  const branchPaths = resolveBranchWorkspace(state, branchMode)
  const meta = getBranchMetadata(branchPaths.metadataRoot, branchPaths.baseRoot)

  const gitFactory = ctx.services.createGitManagerFor
  if (!gitFactory) {
    return { ok: false, status: 500, error: 'Git manager unavailable' }
  }

  // Commit and push changes
  try {
    const git = gitFactory(branchPaths.branchRoot)
    await git.checkoutBranch(state.branch.name)
    const status = await git.status()
    if (status.files.length > 0) {
      await git.add(['.'])
      await git.commit(`Submit ${state.branch.name}`)
      await git.push(state.branch.name)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to push branch changes'
    return {
      ok: false,
      status: 500,
      error: `Failed to push branch changes (${branchPaths.branchRoot}): ${message}`,
    }
  }

  // Create or update PR if GitHub service is available
  const githubService = ctx.services.githubService
  let prUrl = state.pullRequestUrl
  let prNumber = state.pullRequestNumber

  if (githubService && branchMode !== 'local-simple') {
    try {
      const baseBranch = ctx.services.config.defaultBaseBranch ?? 'main'
      const prTitle = state.branch.title || `Submit ${state.branch.name}`
      const prBody = state.branch.description || ''

      if (state.pullRequestNumber) {
        // Update existing PR
        await githubService.updatePullRequest(state.pullRequestNumber, {
          title: prTitle,
          body: prBody,
        })
        // Convert to ready if it was draft
        const pr = await githubService.getPullRequest(state.pullRequestNumber)
        if (pr.draft) {
          await githubService.convertToReady(state.pullRequestNumber)
        }
        // Keep existing URL and number
        prUrl = state.pullRequestUrl
        prNumber = state.pullRequestNumber
      } else {
        // Create new PR
        const result = await githubService.createPullRequest({
          branchName: state.branch.name,
          title: prTitle,
          body: prBody,
          draft: false,
        })
        prUrl = result.url
        prNumber = result.number
      }
    } catch (err) {
      // Log error but don't fail submission - code is already pushed
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error(`CanopyCMS: Failed to create/update PR for ${state.branch.name}:`, message)
    }
  }

  // Update metadata with status and PR info
  await meta.save({
    branch: { name: state.branch.name, status: 'submitted' },
    pullRequestUrl: prUrl,
    pullRequestNumber: prNumber,
  })

  const updated = await ctx.getBranchState(params.branch)
  if (!updated) {
    return { ok: false, status: 500, error: 'Failed to update branch' }
  }
  return { ok: true, status: 200, data: { branch: updated } }
}
