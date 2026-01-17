'use client'

/**
 * GroupManager - Re-exports from the group-manager module.
 * This file maintains backward compatibility with existing imports.
 */

export { GroupManager, useGroupState, useUserSearch, useExternalGroupSearch } from './group-manager'
export type { GroupManagerProps, InternalGroup } from './group-manager'
