/**
 * Authorization for CanopyCMS: checking user access to branches and content.
 * Most callers want `checkContentAccess(deps, context, branchRoot, path, user,
 * level)`, which covers both the branch and the path layer.
 */

export type {
  BranchAccessResult,
  PathPermissionResult,
  ContentAccessResult,
  ContentAccessDeps,
  PermissionPath,
} from './types'

export { parsePermissionPath } from './validation'

export {
  checkContentAccess,
  createCheckContentAccess,
  createContentAccessChecker,
  type ContentAccessChecker,
} from './content'

export {
  checkBranchAccessWithDefault,
  createCheckBranchAccess,
  canPerformWorkflowAction,
} from './branch'

export {
  getBranchProtection,
  getBranchWriteProtection,
  type BranchProtection,
  type BranchWriteProtection,
} from './protected-branch'

export { checkPathAccess, createCheckPathAccess, resolveDefaultPathAccess } from './path'

export {
  RESERVED_GROUPS,
  type ReservedGroupId,
  isReservedGroup,
  stripReservedGroups,
  isAdmin,
  isReviewer,
  isPrivileged,
} from './helpers'

export {
  PermissionsFileSchema,
  createDefaultPermissionsFile,
  type PermissionsFile,
  loadPermissionsFile,
  loadPathPermissions,
  mutatePermissionsFile,
  ensurePermissionsFile,
} from './permissions'

export {
  GroupsFileSchema,
  createDefaultGroupsFile,
  type GroupsFile,
  type InternalGroup,
  loadGroupsFile,
  loadInternalGroups,
  deriveInternalGroups,
  mutateGroupsFile,
} from './groups'

export {
  mutateSettingsJsonFile,
  SettingsFileConflictError,
  SettingsVersionConflictError,
  type MutateSettingsFileOptions,
} from './settings-file-store'
