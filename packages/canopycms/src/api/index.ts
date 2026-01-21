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
  CollectionItem,
  EntryCollectionSummary,
  ListEntriesParams,
  DeleteEntryResponse,
} from './entries'
export type {
  PermissionsResponse,
  UpdatePermissionsBody,
  SearchUsersParams,
  GetUserMetadataResponse,
  GetUserMetadataParams,
} from './permissions'
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
export type { ResolveReferencesResponse } from './resolve-references'
export type {
  SchemaResponse,
  CollectionResponse,
  CreateCollectionResponse,
  UpdateCollectionResponse,
  DeleteCollectionResponse,
  AddEntryTypeResponse,
  UpdateEntryTypeResponse,
  RemoveEntryTypeResponse,
  UpdateOrderResponse,
  GetSchemaApiResponse,
  GetCollectionApiResponse,
  CreateCollectionApiResponse,
  UpdateCollectionApiResponse,
  DeleteCollectionApiResponse,
  AddEntryTypeApiResponse,
  UpdateEntryTypeApiResponse,
  RemoveEntryTypeApiResponse,
  UpdateOrderApiResponse,
} from './schema'
export type {
  CreateCollectionInput,
  UpdateCollectionInput,
  CreateEntryTypeInput,
  UpdateEntryTypeInput,
} from '../schema/schema-store-types'
export type { EntryTypeSummary } from './entries'
// Content API uses path-based routing now - no separate params/body types exported

// Export route definitions
export { USER_ROUTES } from './user'
// Note: SCHEMA_ROUTES is not exported here because it imports server-only code (fs module).
// Import it directly from './schema' in server-side code when needed.

// Export client
export { CanopyApiClient, createApiClient } from './client'
export type { ApiClientOptions } from './client'
