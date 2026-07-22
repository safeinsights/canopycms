import type { BranchContext } from '../types'
import type { AuthPlugin } from '../auth/plugin'
import type { CanopyServices } from '../services'
import type { CanopyUser } from '../user'
import type { AssetStore } from '../assets/types'
import type { CanopyRequest } from '../http/types'

export interface ApiContext {
  services: CanopyServices
  assetStore?: AssetStore
  /**
   * Load a branch context for the requested branch name.
   * Can be backed by BranchRegistry + BranchMetadataFileManager.
   *
   * @param branchName - Name of the branch to load
   * @param options - Optional configuration
   * @param options.loadSchema - If true, loads per-branch schema into context.flatSchema
   */
  getBranchContext: (
    branchName: string,
    options?: { loadSchema?: boolean },
  ) => Promise<BranchContext | null>
  /**
   * Auth plugin for user/group search (optional)
   */
  authPlugin?: AuthPlugin
}

export interface ApiRequest<TBody = unknown> {
  branch?: string
  body?: TBody
  query?: Record<string, string | string[] | undefined>
  user: CanopyUser
  /**
   * The underlying framework-agnostic request, for handlers that must bypass
   * the default JSON body parsing (e.g. multipart/form-data uploads - see
   * `bodyFormat: 'multipart'` in route-builder.ts and `rawRequest.formData()`
   * / `rawRequest.rawBody()`). Always populated by the core handler; optional
   * only so hand-built `ApiRequest` test fixtures that don't need it keep
   * compiling.
   */
  rawRequest?: CanopyRequest
}

export interface ApiResponse<TData = unknown> {
  ok: boolean
  status: number
  data?: TData
  error?: string
  /**
   * Structured per-field validation errors accompanying a 422 rejection
   * (schema validation at the content write boundary). `fieldPath` uses the
   * canonical CanopyCMS path format (e.g. `blocks[0].title`) so the editor can
   * surface each error next to its form field.
   */
  fieldErrors?: Array<{ fieldPath: string; message: string }>
}
