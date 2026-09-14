/**
 * Authorization module for CanopyCMS
 *
 * This module provides a unified API for checking user access to branches and content.
 *
 * ## Quick Start
 *
 * For most use cases, use `checkContentAccess` which handles both branch and path permissions:
 *
 * ```ts
 * import { checkContentAccess } from './authorization'
 *
 * const result = await checkContentAccess(deps, context, branchRoot, 'content/posts/post.mdx', user, 'edit')
 * if (result.allowed) {
 *   // User can edit the file
 * }
 * ```
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
