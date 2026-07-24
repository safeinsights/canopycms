/**
 * Groups module exports
 */

export {
  GroupsFileSchema,
  createDefaultGroupsFile,
  type GroupsFile,
  type InternalGroup,
} from './schema'
export {
  loadGroupsFile,
  loadInternalGroups,
  deriveInternalGroups,
  mutateGroupsFile,
} from './loader'
