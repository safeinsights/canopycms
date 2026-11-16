/**
 * Changing who may open a branch: the I/O around `authorization/branch-sharing.ts`'s rules. Users
 * are resolved and the caller's scope checked before the branch.json lock; `applyAccessChange` and
 * the caller's rights then run again inside it, against the list on disk, so a concurrent change
 * is never overwritten.
 */

import type { ApiContext, ApiErrorCode } from './types'
import type {
  BranchAccessControl,
  BranchAddBy,
  BranchContext,
  BranchMetadata,
  CanopyUserId,
} from '../types'
import type { CanopyUser } from '../user'
import {
  applyAccessChange,
  branchSharingRights,
  effectiveAddBy,
  getBranchProtection,
  hasAccessList,
  isAdmin,
  resolveBranchSharing,
  type BranchAccessChange,
  type BranchAccessChangeResult,
  type BranchAccessRefusal,
  type BranchSharingRights,
} from '../authorization'
import { isNobody } from '../system-users'
import { getBranchMetadataFileManager } from '../branch-metadata'
import { lookupUsersMetadata } from '../auth/user-metadata-lookup'
import { logBranchAccessChange } from '../utils/access-log'
import { getErrorMessage } from '../utils/error'
import { canopyLogWarn } from '../utils/logger'
import { branchAccessDenial } from './guards'
import { addsAnyKnownAccount, loadCmsUserIds, lookupEmails, RATE_LIMITED_MESSAGE } from './people'

export interface AccessRefused {
  status: 400 | 403 | 409 | 429
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
    refusal.code === 'ACCESS_CHANGE_INVALID' || refusal.code === 'EXCLUSION_CAP' ? 400 : 403,
    refusal.code,
    refusal.message,
    refusal.ids,
  )

/** Thrown inside the branch.json lock to abandon the write; carries the refusal out. */
class AccessChangeRefusedError extends Error {
  constructor(readonly refused: AccessRefused) {
    super(refused.error)
  }
}

/** The ids the sign-in provider does not know; none when no auth plugin can say. */
async function unknownUsers(
  ctx: ApiContext,
  userIds: readonly CanopyUserId[],
): Promise<CanopyUserId[]> {
  if (userIds.length === 0 || !ctx.authPlugin) return []
  const found = await lookupUsersMetadata(ctx.authPlugin, userIds)
  return userIds.filter((id) => !found.get(id))
}

/**
 * Refuses users the sign-in provider does not know, and, unless `actor` may add any account it
 * knows ({@link addsAnyKnownAccount}), users who don't work in this CMS ({@link loadCmsUserIds})
 * unless `vouched`. An id learned elsewhere (a listing, a pull request) therefore adds no one
 * `actor`'s name search could not find, bar someone this branch's list once held.
 */
async function checkUsersToAdd(
  ctx: ApiContext,
  actor: CanopyUser,
  userIds: readonly CanopyUserId[],
  vouched: ReadonlySet<CanopyUserId> = new Set(),
): Promise<AccessRefused | null> {
  if (userIds.length === 0) return null
  const unknown = await unknownUsers(ctx, userIds)
  if (unknown.length > 0) {
    return refused(400, 'USER_NOT_FOUND', 'Some of these people could not be found.', unknown)
  }
  if (addsAnyKnownAccount(ctx, actor)) return null
  const cmsUsers = await loadCmsUserIds(ctx)
  const outside = userIds.filter((id) => !cmsUsers.has(id) && !vouched.has(id))
  return outside.length > 0
    ? refused(
        403,
        'USER_OUT_OF_SCOPE',
        "You can't add people who don't work in this editor.",
        outside,
      )
    : null
}

/** Who besides admins may add people to `branch` ({@link effectiveAddBy}). */
export const addByFor = (
  ctx: ApiContext,
  branch: Pick<BranchMetadata, 'access' | 'createdBy' | 'status' | 'name' | 'baseBranch'>,
): BranchAddBy =>
  effectiveAddBy(branch, {
    isProtected: getBranchProtection(ctx.services.config, branch.name, branch.baseBranch)
      .isProtected,
    whoCanAdd: resolveBranchSharing(ctx.services.config).whoCanAdd,
  })

/** What `actor` may do to `branch`'s list (authorization/branch-sharing.ts). */
export const rightsFor = (
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
 * Why `actor` may not touch this branch's list at all, before any change is weighed. The finder
 * asks it first too (api/branch-people.ts), so both answer one refusal with one code.
 */
export function refuseOutright(
  ctx: ApiContext,
  actor: CanopyUser,
  context: BranchContext,
): AccessRefused | null {
  const denied = branchAccessDenial(ctx, context, actor)
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
  if (!admin && isNobody(branch.createdBy)) {
    return refused(403, 'BRANCH_NOT_SHAREABLE', 'Only an admin can share this branch.')
  }
  if (!admin && branch.status === 'archived') {
    return refused(403, 'BRANCH_ARCHIVED', "Archived branches can't be shared.")
  }
  return null
}

const NO_SUCH_ADDRESS = 'No account uses one of these email addresses.'

/** A change as a request states it: people to add may also be named by exact email address. */
export type BranchAccessRequest = Omit<BranchAccessChange, 'add'> & {
  add?: NonNullable<BranchAccessChange['add']> & { emails?: string[] }
}

/**
 * `request` with each email replaced by the id of the user it finds (api/people.ts
 * `lookupEmails`), and those ids. They need no further scope check: the lookup applied
 * `branchSharing.addableByEmail`, which may reach people outside this CMS. An address that finds
 * no one refuses the whole request, naming no address; so does passing the email limit.
 */
async function resolveEmailAdds(
  ctx: ApiContext,
  actor: CanopyUser,
  request: BranchAccessRequest,
): Promise<
  | { ok: true; change: BranchAccessChange; byEmail: Set<CanopyUserId> }
  | { ok: false; refused: AccessRefused }
> {
  const { add: requested, ...rest } = request
  const { emails, ...add } = requested ?? {}
  const change: BranchAccessChange = requested ? { ...rest, add } : rest
  if (!emails?.length) return { ok: true, change, byEmail: new Set() }
  const found = await lookupEmails(ctx, actor, emails)
  if (found === false) {
    return { ok: false, refused: refused(429, 'RATE_LIMITED', RATE_LIMITED_MESSAGE) }
  }
  const ids = found.flatMap((user) => (user ? [user.id] : []))
  if (ids.length < found.length) {
    return {
      ok: false,
      refused: refused(400, 'USER_NOT_FOUND', NO_SUCH_ADDRESS),
    }
  }
  return {
    ok: true,
    change: { ...change, add: { ...add, users: [...(add.users ?? []), ...ids] } },
    byEmail: new Set(ids),
  }
}

/**
 * Remembers whom `actor` just shared with, for their suggestions (people-store.ts). Best effort:
 * a busy lock or a failure skips the record with one log line rather than delaying the share.
 * Called only once the branch.json lock is released: the two locks never nest.
 */
export async function recordRecentShares(
  ctx: ApiContext,
  actor: CanopyUser,
  userIds: readonly CanopyUserId[],
): Promise<void> {
  const store = ctx.services.peopleStore
  const others = userIds.filter((id) => id !== actor.userId)
  if (!store || others.length === 0) return
  try {
    await store.recordShares(actor.userId, others)
  } catch (err: unknown) {
    canopyLogWarn('[canopy] Could not record recent shares:', getErrorMessage(err))
  }
}

/**
 * `refusal` without the ids an address in the request resolved to: the caller typed the address,
 * and the id behind it is no business of theirs.
 */
function hidingEmailIds(refusal: AccessRefused, byEmail: ReadonlySet<CanopyUserId>): AccessRefused {
  if (!refusal.ids || byEmail.size === 0) return refusal
  const { ids, ...rest } = refusal
  const shown = ids.filter((id) => !byEmail.has(id))
  return shown.length > 0 ? { ...rest, ids: shown } : rest
}

export type BranchAccessOutcome =
  | { ok: true; branch: BranchMetadata; result: BranchAccessChangeResult | null }
  | { ok: false; refused: AccessRefused }

/**
 * Applies `request` to the branch's list for `actor`. A change already in effect writes nothing
 * and answers with the branch as it is, so a retry after a lost answer is safe.
 */
export async function changeBranchAccess(
  ctx: ApiContext,
  actor: CanopyUser,
  context: BranchContext,
  request: BranchAccessRequest,
): Promise<BranchAccessOutcome> {
  const outright = refuseOutright(ctx, actor, context)
  if (outright) return { ok: false, refused: outright }
  // Before any address is looked up, so someone who can't add learns nothing from one.
  if (request.add?.emails?.length && !rightsFor(ctx, actor, context.branch).canAdd) {
    return {
      ok: false,
      refused: refused(403, 'ACCESS_ADD_FORBIDDEN', "You can't add people to this branch."),
    }
  }
  const resolved = await resolveEmailAdds(ctx, actor, request)
  if (!resolved.ok) return resolved
  const { change, byEmail } = resolved
  // Find skips removed people, so to someone who can't see the list's removals an address that
  // finds one answers as an unknown address does: here, and again on the list on disk, before
  // any rule that could answer differently.
  const findsSomeoneRemoved = (branch: BranchMetadata): boolean => {
    const excluded = branch.access.excluded ?? {}
    return (
      !rightsFor(ctx, actor, branch).canManage &&
      [...byEmail].some((id) => Object.prototype.hasOwnProperty.call(excluded, id))
    )
  }
  const noSuchAddress = refused(400, 'USER_NOT_FOUND', NO_SUCH_ADDRESS)
  if (findsSomeoneRemoved(context.branch)) return { ok: false, refused: noSuchAddress }
  const refuse = (refusal: AccessRefused): BranchAccessOutcome => ({
    ok: false,
    refused: hidingEmailIds(refusal, byEmail),
  })

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
  if ('refusal' in dryRun) return refuse(fromRefusal(dryRun.refusal))
  // Ids already listed are a no-op and skip the check. The list on disk may have dropped one
  // since; an id added there that this check never saw is refused inside the lock.
  const listed = new Set(context.branch.access.allowedUsers ?? [])
  const checked = new Set(
    (change.add?.users ?? []).filter((id) => id !== actor.userId && !listed.has(id)),
  )
  // An exclusion records someone this list held, someone in this CMS (the removal check below), or,
  // when an admin made it, anyone; `byAdmin` exclusions only an admin lifts
  // (authorization/branch-sharing.ts `applyAccessChange`). So allowing back by id needs no scope.
  const excludedHere = new Set(Object.keys(context.branch.access.excluded ?? {}))
  const scope = await checkUsersToAdd(
    ctx,
    actor,
    [...checked].filter((id) => !byEmail.has(id)),
    excludedHere,
  )
  if (scope) return refuse(scope)
  // Excluding someone not on the list records an id nothing else vouches for, so it must be a real
  // person, never an arbitrary string. Only exclusions this change records are looked up.
  const newlyExcluded = new Set(dryRun.excluded)
  const unlisted = (change.remove?.users ?? []).filter(
    (id) => !listed.has(id) && newlyExcluded.has(id),
  )
  const vouched = new Set([...listed, ...unlisted])
  const unknown = await unknownUsers(ctx, unlisted)
  if (unknown.length > 0) {
    return refuse(
      refused(400, 'USER_NOT_FOUND', 'Some of these people could not be found.', unknown),
    )
  }
  if (unlisted.length > 0 && !isAdmin(actor.groups)) {
    const cmsUsers = await loadCmsUserIds(ctx)
    const outside = unlisted.filter((id) => !cmsUsers.has(id))
    if (outside.length > 0) {
      return refuse(
        refused(
          403,
          'USER_OUT_OF_SCOPE',
          "You can't remove people who don't work in this editor.",
          outside,
        ),
      )
    }
  }

  const metadata = getBranchMetadataFileManager(context.branchRoot, context.baseRoot)
  // The last attempt's verdict against the list on disk: an OCC retry re-applies the change.
  const outcome: { applied: BranchAccessChangeResult | null; current: BranchMetadata } = {
    applied: null,
    current: context.branch,
  }
  let saved: BranchMetadata | undefined
  try {
    const written = await metadata.update((existing) => {
      outcome.applied = null
      if (!existing) return null
      outcome.current = existing.branch
      if (findsSomeoneRemoved(existing.branch)) throw new AccessChangeRefusedError(noSuchAddress)
      const applied = apply(existing.branch)
      if ('refusal' in applied) throw new AccessChangeRefusedError(fromRefusal(applied.refusal))
      const unchecked = isAdmin(actor.groups)
        ? []
        : applied.added.users.filter((id) => id !== actor.userId && !checked.has(id))
      // A removal the dry run didn't record as an exclusion, but the list on disk does, was never
      // looked up.
      const unvouched = applied.excluded.filter(
        (id) => (change.remove?.users ?? []).includes(id) && !vouched.has(id),
      )
      if (unchecked.length + unvouched.length > 0) {
        throw new AccessChangeRefusedError(
          refused(409, 'LIST_CHANGED', 'The list changed while this was being saved. Try again.', [
            ...unchecked,
            ...unvouched,
          ]),
        )
      }
      outcome.applied = applied.changed ? applied : null
      return applied.changed ? { branch: { access: applied.access } } : null
    })
    saved = written?.branch
  } catch (err: unknown) {
    if (err instanceof AccessChangeRefusedError) return refuse(err.refused)
    throw err
  }

  if (outcome.applied) {
    logAccessChange(context.branch.name, actor.userId, outcome.applied)
    await recordRecentShares(ctx, actor, outcome.applied.added.users)
  }
  return { ok: true, branch: saved ?? outcome.current, result: outcome.applied }
}

/**
 * The list a new branch starts with when its creator shares it at once: the same rules as a change,
 * applied by its owner-to-be to an empty list, and the people it adds. Undefined when nobody is
 * added.
 */
export async function initialBranchAccess(
  ctx: ApiContext,
  actor: CanopyUser,
  add: BranchAccessRequest['add'],
): Promise<
  | { ok: true; access: BranchAccessControl | undefined; added: CanopyUserId[] }
  | { ok: false; refused: AccessRefused }
> {
  if (!add?.users?.length && !add?.groups?.length && !add?.emails?.length) {
    return { ok: true, access: undefined, added: [] }
  }
  const resolved = await resolveEmailAdds(ctx, actor, { add })
  if (!resolved.ok) return resolved
  const refuse = (refusal: AccessRefused) => ({
    ok: false as const,
    refused: hidingEmailIds(refusal, resolved.byEmail),
  })
  const applied = applyAccessChange({}, resolved.change, {
    actor,
    rights: { isOwner: true, isMember: false, canAdd: true, canRemoveOwn: true, canManage: true },
    creator: actor.userId,
    defaultAccess: ctx.services.config.defaultBranchAccess ?? 'deny',
    now: new Date().toISOString(),
  })
  if ('refusal' in applied) return refuse(fromRefusal(applied.refusal))
  const scope = await checkUsersToAdd(
    ctx,
    actor,
    applied.added.users.filter((id) => !resolved.byEmail.has(id)),
  )
  if (scope) return refuse(scope)
  return { ok: true, access: applied.access, added: applied.added.users }
}

/** Who changed which branch's list, and how: what the change did, not what was asked. */
function logAccessChange(
  branch: string,
  actor: CanopyUserId,
  result: BranchAccessChangeResult,
): void {
  logBranchAccessChange({
    branch,
    actor,
    added: result.added,
    removed: result.removed,
    restricted: hasAccessList(result.access),
    ...(result.addBy && { addBy: result.addBy }),
    ...(result.unexcluded.length > 0 && { unexcluded: result.unexcluded }),
    ...(result.excluded.length > 0 && { excluded: result.excluded }),
  })
}
