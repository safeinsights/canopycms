// Re-export all response types
export type { ApiResponse, ApiRequest, ApiContext } from './types'
export type {
  BranchResponse,
  BranchListResponse,
  BranchDeleteResponse,
  CreateBranchBody,
  UpdateBranchAccessBody,
} from './branch'
export type { BranchMergeResponse } from './branch-merge'
export type {
  CommentsResponse,
  AddCommentResponse,
  ResolveCommentResponse,
  ListCommentsResponse,
} from './comments'
export type {
  EntriesResponse,
  ListEntriesResponse,
  EntryListItem,
  EntryCollectionSummary,
  ListEntriesParams,
} from './entries'
export type { PermissionsResponse, UpdatePermissionsBody, SearchUsersParams } from './permissions'
export type { UserInfoResponse } from './user'
export type {
  AssetsListResponse,
  AssetUploadResponse,
  UploadAssetBody,
  DeleteAssetBody,
  ListAssetsParams,
} from './assets'
export type {
  InternalGroupsResponse,
  ExternalGroupsResponse,
  UpdateInternalGroupsBody,
  SearchExternalGroupsParams,
  ExternalGroup,
} from './groups'
export type { ReferenceOptionsResponse } from './reference-options'
// Content API uses path-based routing now - no separate params/body types exported

// Export route definitions
export { USER_ROUTES } from './user'

// Export client
export { CanopyApiClient, createApiClient } from './client'
export type { ApiClientOptions } from './client'
