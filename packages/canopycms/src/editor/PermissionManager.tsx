'use client'

/**
 * PermissionManager - Re-export from permission-manager module.
 *
 * This file maintains backward compatibility for imports.
 * The actual implementation is in ./permission-manager/
 */

export { PermissionManager, usePermissionTree, useGroupsAndUsers } from './permission-manager'

export type { PermissionManagerProps, ContentNode, TreeNode } from './permission-manager'
