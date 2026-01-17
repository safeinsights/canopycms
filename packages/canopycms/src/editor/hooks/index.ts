// Barrel export for all custom hooks
// Export hooks as they are created
// Note: resetApiClient functions are not exported - they're test-only utilities

export * from './useEditorLayout'
export { useBranchManager, type UseBranchManagerOptions } from './useBranchManager'
export { useEntryManager } from './useEntryManager'
export * from './useDraftManager'
export { useCommentSystem } from './useCommentSystem'
export { useGroupManager } from './useGroupManager'
export { usePermissionManager } from './usePermissionManager'
export { useBranchActions } from './useBranchActions'
export { useUserContext, type UseUserContextReturn } from './useUserContext'
export { useReferenceResolution, type UseReferenceResolutionOptions, type UseReferenceResolutionResult } from './useReferenceResolution'
