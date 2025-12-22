import config from '../../../../canopycms.config'
import { BranchWorkspaceManager, loadBranchState } from 'canopycms'
import { createCanopyHandler } from 'canopycms/next'
import { createClerkAuthPlugin } from 'canopycms-auth-clerk'
import type { NextRequest } from 'next/server'

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

// Initialize Clerk auth plugin
const authPlugin = createClerkAuthPlugin({
  secretKey: process.env.CLERK_SECRET_KEY,
  roleMetadataKey: 'canopyRole',
  useOrganizationsAsGroups: true,
})

const getUser = async (req: NextRequest) => {
  try {
    const result = await authPlugin.verifyToken(req)
    if (!result.valid || !result.user) {
      // Fallback for development
      return { userId: 'demo-editor', role: 'admin' }
    }
    return {
      userId: result.user.userId,
      role: result.user.role ?? 'editor',
      groups: result.user.groups,
    }
  } catch (err) {
    console.error('Auth failed, using demo user:', err)
    return { userId: 'demo-editor', role: 'admin' }
  }
}

const handler = createCanopyHandler({
  config,
  getUser,
  getBranchState: ensureBranchState,
  authPlugin,
})

export const GET = handler
export const POST = handler
export const PUT = handler
export const DELETE = handler
