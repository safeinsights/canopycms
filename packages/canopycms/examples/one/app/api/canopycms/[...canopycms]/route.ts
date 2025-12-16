import config from '../../../../canopycms.config'
import { BranchWorkspaceManager, loadBranchState } from 'canopycms'
import { createCanopyHandler } from 'canopycms/next'

const branchMode = config.mode ?? 'local-simple'
const defaultBranch = config.defaultBaseBranch ?? 'main'
const workspaceManager = new BranchWorkspaceManager(config)

const ensureBranchState = async (branch: string) => {
  const existing = await loadBranchState({ branchName: branch, mode: branchMode })
  if (existing) return existing
  const workspace = await workspaceManager.openOrCreateBranch({
    branchName: branch,
    mode: branchMode,
    createdBy: 'demo-editor',
  })
  return workspace.state
}

await ensureBranchState(defaultBranch)

const handler = createCanopyHandler({
  config,
  getUser: async () => ({ userId: 'demo-editor', role: 'admin' }),
  getBranchState: ensureBranchState,
})

export const GET = handler
export const POST = handler
export const PUT = handler
export const DELETE = handler
