/**
 * Groups module exports
 */

export { GroupsFileSchema, createDefaultGroupsFile, type GroupsFile, type InternalGroup } from './schema'
export { loadGroupsFile, loadInternalGroups, saveInternalGroups } from './loader'
