import type { BranchListItem } from '../../api/branch'
import type { BranchSummary } from '../BranchManager'

/**
 * A branch as a create answered it, in the shape the branch list gives the editor, for what
 * offers to share it before any listing includes it.
 */
export const createdSummary = (branch: BranchListItem): BranchSummary => ({
  name: branch.name,
  shortName: branch.shortName,
  status: branch.status,
  createdBy: branch.createdBy,
  access: {
    users: branch.access.allowedUsers,
    groups: branch.access.allowedGroups,
    managerOrAdminAllowed: branch.access.managerOrAdminAllowed,
  },
  editors: branch.editors,
  sharing: branch.sharing,
  isProtected: branch.isProtected,
})
