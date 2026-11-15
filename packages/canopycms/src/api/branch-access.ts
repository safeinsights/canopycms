/**
 * Changing who may open a branch: the I/O around `authorization/branch-sharing.ts`'s rules. Users
 * are resolved and the caller's scope checked before the branch.json lock; the rules then run
 * again inside it, against the list on disk, so a concurrent change is never overwritten.
 */

import type { ApiContext, ApiErrorCode } from './types'
import type { BranchAccessControl, BranchContext, BranchMetadata, CanopyUserId } from '../types'
import type { CanopyUser } from '../user'
import {
  applyAccessChange,
  branchSharingRights,
  collectCmsUserIds,
  getBranchProtection,
  hasAccessList,
  isAdmin,
  isLockedOutOfBranch,
  loadInternalGroups,
  loadPathPermissions,
  resolveBranchSharing,
  type BranchAccessChange,
  type BranchAccessChangeResult,
  type BranchAccessRefusal,
  type BranchSharingRights,
} from '../authorization'
import { isSystemUserId } from '../system-users'
import { getBranchMetadataFileManager } from '../branch-metadata'
import { lookupUsersMetadata } from '../auth/user-metadata-lookup'
import { canopyLog } from '../utils/logger'

export interface AccessRefused {
  status: 400 | 403
  error: string
  code: ApiErrorCode
  ids?: string[]
}

const refused = (
  status: AccessRefused['status'],
  code: ApiErrorCode,
  error: string,
  ids?: string[],
): AccessRefused => ({ status, code, error, ...(ids && { ids }) })

const fromRefusal = (refusal: BranchAccessRefusal): AccessRefused =>
  refused(
    refusal.code === 'ACCESS_CHANGE_INVALID' ? 400 : 403,
    refusal.code,
    refusal.message,
    refusal.ids,
  )

/** Thrown inside the branch.json lock to abandon the write; carries the refusal out. */
class AccessChangeRefusedError extends Error {
  constructor(readonly refusal: BranchAccessRefusal) {
    super(refusal.message)
  }
}

/** {@link collectCmsUserIds} over the settings files and the branch registry. */
async function loadCmsUserIds(ctx: ApiContext): Promise<Set<CanopyUserId>> {
  const { config, bootstrapAdminIds, registry } = ctx.services
  const settingsRoot = await ctx.services.getSettingsBranchRoot()
  const [pathPermissions, internalGroups, branches] = await Promise.all([
    loadPathPermissions(settingsRoot, config.mode),
    loadInternalGroups(settingsRoot, config.mode, bootstrapAdminIds),
    registry ? registry.list() : Promise.resolve([]),
  ])
  return collectCmsUserIds({
    pathPermissions,
    internalGroups,
    branches: branches.map((context) => context.branch),
  })
}

/**
 * Refuses users the sign-in provider does not know, and, for anyone but an admin, users outside
 * the people they may find. Checking here, not only in the people finder, stops an id learned
 * elsewhere (a listing, a pull request) from adding someone the caller could not have found.
 */
async function checkUsersToAdd(
  ctx: ApiContext,
  actor: CanopyUser,
  userIds: readonly CanopyUserId[],
): Promise<AccessRefused | null> {
  if (userIds.length === 0) return null
  if (ctx.authPlugin) {
    const found = await lookupUsersMetadata(ctx.authPlugin, userIds)
    const unknown = userIds.filter((id) => !found.get(id))
    if (unknown.length > 0) {
      return refused(400, 'USER_NOT_FOUND', 'Some of these people could not be found.', unknown)
    }
  }
  if (isAdmin(actor.groups)) return null
  const cmsUsers = await loadCmsUserIds(ctx)
  const outside = userIds.filter((id) => !cmsUsers.has(id))
  return outside.length > 0
    ? refused(
        403,
        'USER_OUT_OF_SCOPE',
        "You can't add people who don't work in this editor.",
        outside,
      )
    : null
}

const rightsFor = (
  ctx: ApiContext,
  actor: CanopyUser,
  branch: Pick<BranchMetadata, 'access' | 'createdBy' | 'status' | 'name' | 'baseBranch'>,
): BranchSharingRights =>
  branchSharingRights(actor, branch, {
    isProtected: getBranchProtection(ctx.services.config, branch.name, branch.baseBranch)
      .isProtected,
    whoCanAdd: resolveBranchSharing(ctx.services.config).whoCanAdd,
  })

/**
 * A refusal for a caller the branch's access check turns away: a lockdown is named only to someone
 * the list would otherwise admit, so it tells no one else anything about the branch.
 */
function branchAccessRefusal(
  ctx: ApiContext,
  actor: CanopyUser,
  context: BranchContext,
): AccessRefused | null {
  if (ctx.services.checkBranchAccess(context, actor).allowed) return null
  const unlocked: BranchContext = {
    ...context,
    branch: {
      ...context.branch,
      access: { ...context.branch.access, managerOrAdminAllowed: false },
    },
  }
  return isLockedOutOfBranch(context.branch.access, actor.groups) &&
    ctx.services.checkBranchAccess(unlocked, actor).allowed
    ? refused(
        403,
        'BRANCH_LOCKED_DOWN',
        'An admin has limited this branch to admins and reviewers.',
      )
    : refused(403, 'BRANCH_ACCESS_DENIED', "You don't have access to this branch.")
}

/** Why `actor` may not touch this branch's list at all, before any change is weighed. */
function refuseOutright(
  ctx: ApiContext,
  actor: CanopyUser,
  context: BranchContext,
): AccessRefused | null {
  const denied = branchAccessRefusal(ctx, actor, context)
  if (denied) return denied
  const { branch } = context
  const admin = isAdmin(actor.groups)
  if (getBranchProtection(ctx.services.config, branch.name, branch.baseBranch).isProtected) {
    return refused(
      403,
      'BRANCH_NOT_SHAREABLE',
      'The base branch does not take an access list. Create a branch to share work.',
    )
  }
  if (!admin && (isSystemUserId(branch.createdBy) || branch.createdBy === 'unknown')) {
    return refused(403, 'BRANCH_NOT_SHAREABLE', 'Only an admin can share this branch.')
  }
  if (!admin && branch.status === 'archived') {
    return refused(403, 'BRANCH_ARCHIVED', "Archived branches can't be shared.")
  }
  return null
}

export type BranchAccessOutcome =
  | { ok: true; branch: BranchMetadata; result: BranchAccessChangeResult | null }
  | { ok: false; refused: AccessRefused }

/**
 * Applies `change` to the branch's list for `actor`. A change already in effect writes nothing and
 * answers with the branch as it is, so a retry after a lost answer is safe.
 */
export async function changeBranchAccess(
  ctx: ApiContext,
  actor: CanopyUser,
  context: BranchContext,
  change: BranchAccessChange,
): Promise<BranchAccessOutcome> {
  const outright = refuseOutright(ctx, actor, context)
  if (outright) return { ok: false, refused: outright }

  const now = new Date().toISOString()
  const defaultAccess = ctx.services.config.defaultBranchAccess ?? 'deny'
  const apply = (branch: BranchMetadata) =>
    applyAccessChange(branch.access, change, {
      actor,
      rights: rightsFor(ctx, actor, branch),
      creator: branch.createdBy,
      defaultAccess,
      now,
    })

  // A dry run first, so a change the rules refuse costs no user lookup and no lock.
  const dryRun = apply(context.branch)
  if ('refusal' in dryRun) return { ok: false, refused: fromRefusal(dryRun.refusal) }
  // Every requested id, not only the dry run's additions: the list on disk may differ from the
  // copy the dry run read, and an id added there must have passed the same check.
  const requested = [...new Set(change.add?.users ?? [])].filter((id) => id !== actor.userId)
  const scope = await checkUsersToAdd(ctx, actor, requested)
  if (scope) return { ok: false, refused: scope }

  const metadata = getBranchMetadataFileManager(context.branchRoot, context.baseRoot)
  // The last attempt's verdict against the list on disk: an OCC retry re-applies the change.
  const outcome: { applied: BranchAccessChangeResult | null; current: BranchMetadata } = {
    applied: null,
    current: context.branch,
  }
  let saved: BranchMetadata | undefined
  try {
    const written = await metadata.update((existing) => {
      if (!existing) return null
      outcome.current = existing.branch
      const applied = apply(existing.branch)
      if ('refusal' in applied) throw new AccessChangeRefusedError(applied.refusal)
      outcome.applied = applied.changed ? applied : null
      return applied.changed ? { branch: { access: applied.access } } : null
    })
    saved = written?.branch
  } catch (err: unknown) {
    if (err instanceof AccessChangeRefusedError) {
      return { ok: false, refused: fromRefusal(err.refusal) }
    }
    throw err
  }

  if (outcome.applied) logAccessChange(context.branch.name, actor.userId, outcome.applied)
  return { ok: true, branch: saved ?? outcome.current, result: outcome.applied }
}

/**
 * The list a new branch starts with when its creator shares it at once: the same rules as a change,
 * applied by its owner-to-be to an empty list. Undefined when nobody is added.
 */
export async function initialBranchAccess(
  ctx: ApiContext,
  actor: CanopyUser,
  add: BranchAccessChange['add'],
): Promise<
  { ok: true; access: BranchAccessControl | undefined } | { ok: false; refused: AccessRefused }
> {
  if (!add?.users?.length && !add?.groups?.length) return { ok: true, access: undefined }
  const applied = applyAccessChange(
    {},
    { add },
    {
      actor,
      rights: { isOwner: true, isMember: false, canAdd: true, canManage: true },
      creator: actor.userId,
      defaultAccess: ctx.services.config.defaultBranchAccess ?? 'deny',
      now: new Date().toISOString(),
    },
  )
  if ('refusal' in applied) return { ok: false, refused: fromRefusal(applied.refusal) }
  const scope = await checkUsersToAdd(ctx, actor, applied.added.users)
  if (scope) return { ok: false, refused: scope }
  return { ok: true, access: applied.access }
}

/** One line per change, for the administrator: who changed which branch's list, and how. */
function logAccessChange(
  branch: string,
  actor: CanopyUserId,
  result: BranchAccessChangeResult,
): void {
  canopyLog(
    JSON.stringify({
      event: 'branch-access',
      branch,
      actor,
      added: result.added,
      removed: result.removed,
      restricted: hasAccessList(result.access),
      ...(result.addBy && { addBy: result.addBy }),
      ...(result.unexcluded.length > 0 && { unexcluded: result.unexcluded }),
      ...(result.excluded.length > 0 && { excluded: result.excluded }),
    }),
  )
}
