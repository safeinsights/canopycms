import type { BranchContext } from '../types'
import type { PermissionLevel } from '../config'
import type { CanopyServices } from '../services'
import type { CanopyUser } from '../user'

export interface ApiContext {
  services: CanopyServices
  // TODO DRY this definition up in terms of AssetStore interface
  assetStore?: {
    list(prefix?: string): Promise<{ key: string; url?: string }[]>
    upload(key: string, data: Buffer | Uint8Array, contentType?: string): Promise<{ key: string; url?: string }>
    delete(key: string): Promise<void>
  }
  /**
   * Load a branch context for the requested branch name.
   * Can be backed by BranchRegistry + BranchMetadataFileManager.
   */
  getBranchContext: (branchName: string) => Promise<BranchContext | null>
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
