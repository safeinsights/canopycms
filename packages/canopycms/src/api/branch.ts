import type { BranchState } from '../types'
import { BranchWorkspaceManager } from '../branch-workspace'
import { BranchRegistry } from '../branch-registry'
import type { ApiContext, ApiRequest, ApiResponse } from './types'
import { getDefaultBranchBase } from '../paths'

export interface CreateBranchBody {
  branch: string
  title?: string
  description?: string
  access?: BranchState['branch']['access']
}

export const createBranch = async (
  ctx: ApiContext,
  req: ApiRequest<CreateBranchBody>
): Promise<ApiResponse<{ branch: BranchState }>> => {
  const branchName = req.body?.branch
  if (!branchName) {
    return { ok: false, status: 400, error: 'branch is required' }
  }
  const branchMode = ctx.services.config.mode ?? 'local-simple'
  const manager = new BranchWorkspaceManager(ctx.services.config)
  const workspace = await manager.openOrCreateBranch({
    branchName,
    mode: branchMode,
    createdBy: req.user.userId,
    title: req.body?.title,
    description: req.body?.description,
    access: req.body?.access,
  })
  return { ok: true, status: 200, data: { branch: workspace.state } }
}

export const listBranches = async (ctx: ApiContext): Promise<ApiResponse<{ branches: BranchState[] }>> => {
  const branchMode = ctx.services.config.mode ?? 'local-simple'
  const registry = new BranchRegistry(getDefaultBranchBase(branchMode))
  const branches = await registry.list()
  return { ok: true, status: 200, data: { branches } }
}
