import { isAdmin } from '../../authorization/helpers'
import { isSystemUserId } from '../../system-users'
import type { BranchSummary, UserContext } from '../BranchManager'

type SharedBranch = Pick<BranchSummary, 'sharing' | 'isProtected' | 'status' | 'createdBy'>

/**
 * Whether `user` sees sharing on `b` at all: never on the base branch, and on an archived or
 * system-owned branch only as an admin, since for anyone else it can never apply there.
 */
const sharingShownOn = (b: SharedBranch, user: UserContext | undefined): boolean =>
  !!user &&
  !b.isProtected &&
  (isAdmin(user.groups) ||
    (b.status !== 'archived' && !!b.createdBy && !isSystemUserId(b.createdBy)))

/** Whether `user` is offered Share… for `b`: the server's rights, where sharing shows at all. */
export const canShareBranch = (b: SharedBranch, user: UserContext | undefined): boolean =>
  !!b.sharing && (b.sharing.canAdd || b.sharing.canManage) && sharingShownOn(b, user)

/**
 * What the open branch's sharing control offers `user`: Share…, the list read-only ("Who has
 * access"), or nothing.
 */
export const sharingMode = (
  b: SharedBranch,
  user: UserContext | undefined,
): 'share' | 'view' | undefined =>
  !b.sharing || !sharingShownOn(b, user) ? undefined : canShareBranch(b, user) ? 'share' : 'view'
