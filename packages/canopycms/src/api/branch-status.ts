import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { BranchState } from '../types'
import { BranchMetadata } from '../branch-metadata'
import { resolveBranchWorkspace } from '../paths'

export const getBranchStatus = async (
  ctx: ApiContext,
  params: { branch: string },
): Promise<ApiResponse<{ branch: BranchState }>> => {
  const state = await ctx.getBranchState(params.branch)
  if (!state) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }
  return { ok: true, status: 200, data: { branch: state } }
}

export const submitBranchForMerge = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: { branch: string },
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
  const meta = new BranchMetadata(branchPaths.metadataRoot)

  const gitFactory = ctx.services.createGitManagerFor
  if (!gitFactory) {
    return { ok: false, status: 500, error: 'Git manager unavailable' }
  }

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

  await meta.update({
    branch: { name: state.branch.name, status: 'submitted' },
  })
  const updated = await ctx.getBranchState(params.branch)
  if (!updated) {
    return { ok: false, status: 500, error: 'Failed to update branch' }
  }
  return { ok: true, status: 200, data: { branch: updated } }
}
