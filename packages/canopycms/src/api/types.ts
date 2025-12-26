import type { BranchState } from '../types'
import type { CanopyConfig } from '../config'
import type { GitHubService } from '../github-service'

export interface RequestUser {
  userId: string
  groups?: string[]
}

export interface ApiContext {
  // TODO DRY this services entry up by using a Partial<CanopyServices> or similar
  services: {
    config: CanopyConfig
    checkBranchAccess: (state: BranchState, user: RequestUser) => { allowed: boolean; reason: string }
    checkContentAccess: (
      branchState: BranchState,
      relativePath: string,
      user: RequestUser
    ) => { allowed: boolean; branch: any; path: any }
    createGitManagerFor?: (repoPath: string, opts?: { baseBranch?: string; remote?: string }) => any
    githubService?: GitHubService
    /** Bootstrap admin user IDs that are always treated as Admins */
    bootstrapAdminIds: Set<string>
  }
  // TODO DRY this definition up in terms of AssetStore interface
  assetStore?: {
    list(prefix?: string): Promise<{ key: string; url?: string }[]>
    upload(key: string, data: Buffer | Uint8Array, contentType?: string): Promise<{ key: string; url?: string }>
    delete(key: string): Promise<void>
  }
  /**
   * Load a branch state for the requested branch name.
   * Can be backed by BranchRegistry + BranchMetadata.
   */
  getBranchState: (branchName: string) => Promise<BranchState | null>
  /**
   * Auth plugin for user/group search (optional)
   */
  authPlugin?: any
}

export interface ApiRequest<TBody = unknown> {
  branch?: string
  body?: TBody
  user: RequestUser
}

export interface ApiResponse<TData = unknown> {
  ok: boolean
  status: number
  data?: TData
  error?: string
}
