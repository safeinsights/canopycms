import type { BranchContext } from '../types'
import type { PermissionLevel } from '../config'
import type { CanopyServices } from '../services'
import type { CanopyUser } from '../user'
import type { AssetStore } from '../asset-store'

export interface ApiContext {
  services: CanopyServices
  assetStore?: AssetStore
  /**
   * Load a branch context for the requested branch name.
   * Can be backed by BranchRegistry + BranchMetadataFileManager.
   *
   * @param branchName - Name of the branch to load
   * @param options - Optional configuration
   * @param options.loadSchema - If true, loads per-branch schema into context.schema and context.flatSchema
   */
  getBranchContext: (
    branchName: string,
    options?: { loadSchema?: boolean },
  ) => Promise<BranchContext | null>
  /**
   * Auth plugin for user/group search (optional)
   */
  authPlugin?: any
}

export interface ApiRequest<TBody = unknown> {
  branch?: string
  body?: TBody
  query?: Record<string, string | string[] | undefined>
  user: CanopyUser
}

export interface ApiResponse<TData = unknown> {
  ok: boolean
  status: number
  data?: TData
  error?: string
}
