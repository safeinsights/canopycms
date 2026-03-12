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
 *
 * ## Module Structure
 *
 * - `content.ts` - Combined branch + path access (main entry point)
 * - `branch.ts` - Branch-level access control
 * - `path.ts` - Path-level permissions
 * - `helpers.ts` - Utility functions (isAdmin, isReviewer, etc.)
 * - `permissions/` - Permissions file schema and loader
 * - `groups/` - Groups file schema and loader
 */

// Types
export type {
  BranchAccessResult,
  PathPermissionResult,
  ContentAccessResult,
  ContentAccessDeps,
  PermissionPath,
} from './types'

// Validation
export { parsePermissionPath } from './validation'

// Main content access (recommended for most cases)
export { checkContentAccess, createCheckContentAccess } from './content'

// Branch-level access
export {
  checkBranchAccessWithDefault,
  createCheckBranchAccess,
  canPerformWorkflowAction,
} from './branch'

// Path-level access
export { checkPathAccess, createCheckPathAccess } from './path'

// Helper functions
export {
  RESERVED_GROUPS,
  type ReservedGroupId,
  isReservedGroup,
  isAdmin,
  isReviewer,
  isPrivileged,
} from './helpers'

// Permissions file handling
export {
  PermissionsFileSchema,
  createDefaultPermissionsFile,
  type PermissionsFile,
  loadPermissionsFile,
  loadPathPermissions,
  savePathPermissions,
  ensurePermissionsFile,
} from './permissions'

// Groups file handling
export {
  GroupsFileSchema,
  createDefaultGroupsFile,
  type GroupsFile,
  type InternalGroup,
  loadGroupsFile,
  loadInternalGroups,
  saveInternalGroups,
} from './groups'
