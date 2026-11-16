/**
 * Who may change a branch's access list, and what a change does to it. Pure: the API resolves
 * users and reads files, then applies these rules inside the branch.json lock
 * (`api/branch-access.ts`).
 *
 * The owner is the branch's creator while the list admits them. Owners and admins remove people,
 * restrict or open the branch and set who may add; listed members add people when the branch's
 * `addBy` allows it, and remove only the entries they added. `addBy: 'admins'` leaves the list to
 * admins alone. An owner's or admin's removal of a user or group records an exclusion, so a member
 * cannot add them back; an excluded user can't open the branch unless an admin or reviewer.
 */

import type {
  BranchSharingConfig,
  CanopyConfig,
  DefaultBranchAccess,
  PathPermission,
} from '../config'
import type {
  BranchAccessControl,
  BranchAddBy,
  BranchMetadata,
  CanopyGroupId,
  CanopyUserId,
} from '../types'
import type { CanopyUser } from '../user'
import { isNobody } from '../system-users'
import { isAdmin, isExcludedFrom, isReservedGroup } from './helpers'

/** {@link BranchSharingConfig} with its defaults applied. */
export type ResolvedBranchSharing = Required<BranchSharingConfig>

export function resolveBranchSharing(
  config: Pick<CanopyConfig, 'branchSharing'>,
): ResolvedBranchSharing {
  return {
    whoCanAdd: config.branchSharing?.whoCanAdd ?? 'members',
    searchable: config.branchSharing?.searchable ?? 'cms-users',
    addableByEmail: config.branchSharing?.addableByEmail ?? 'all-users',
  }
}

const entryKey = (kind: 'user' | 'group', id: string): string => `${kind}:${id}`

/** Whether the list decides who may open the branch, rather than the creator rule and default. */
export function hasAccessList(access: BranchAccessControl): boolean {
  return !!access.restricted || !!access.allowedUsers?.length || !!access.allowedGroups?.length
}

function isListedMember(
  access: BranchAccessControl,
  user: Pick<CanopyUser, 'userId' | 'groups'>,
): boolean {
  if (isExcludedFrom(access, user.userId)) return false
  return (
    !!access.allowedUsers?.includes(user.userId) ||
    !!user.groups?.some((group) => access.allowedGroups?.includes(group))
  )
}

export interface BranchSharingRights {
  isOwner: boolean
  isMember: boolean
  /** May add people. */
  canAdd: boolean
  /** May remove the entries they added. */
  canRemoveOwn: boolean
  /** May remove anyone, restrict or open the branch, set who may add, and lift exclusions. */
  canManage: boolean
}

const NO_RIGHTS: BranchSharingRights = {
  isOwner: false,
  isMember: false,
  canAdd: false,
  canRemoveOwn: false,
  canManage: false,
}

/**
 * What `user` may do to the branch's list. Membership is read from the list itself, never from
 * the access check's reason, which reports a reviewer as privileged whether or not they are listed.
 * The base branch takes no list. The lockdown, archiving, `addBy: 'admins'` and a system-owned
 * branch leave the list to admins.
 */
export function branchSharingRights(
  user: Pick<CanopyUser, 'userId' | 'groups'>,
  branch: Pick<BranchMetadata, 'access' | 'createdBy' | 'status'>,
  options: { isProtected: boolean; whoCanAdd: ResolvedBranchSharing['whoCanAdd'] },
): BranchSharingRights {
  if (options.isProtected) return NO_RIGHTS
  const access = branch.access
  const isMember = isListedMember(access, user)
  const isOwner =
    branch.createdBy === user.userId &&
    !isExcludedFrom(access, user.userId) &&
    (!hasAccessList(access) || isMember)
  if (isAdmin(user.groups)) {
    return { isOwner, isMember, canAdd: true, canRemoveOwn: true, canManage: true }
  }
  if (access.managerOrAdminAllowed || isNobody(branch.createdBy) || branch.status === 'archived') {
    return { ...NO_RIGHTS, isOwner, isMember }
  }
  // 'admins' hands the whole list to admins, its owner included. Under 'owner' a member still
  // takes back what they added.
  const addBy = access.addBy ?? options.whoCanAdd
  if (addBy === 'admins') return { ...NO_RIGHTS, isOwner, isMember }
  return {
    isOwner,
    isMember,
    canAdd: isOwner || (isMember && addBy === 'members'),
    canRemoveOwn: isOwner || isMember,
    canManage: isOwner,
  }
}

/**
 * Who, besides admins, may add people to `branch` as {@link branchSharingRights} decides it:
 * `'admins'` wherever it leaves no one else (a lockdown, an archived or unowned branch, `addBy:
 * 'admins'`, or `'owner'` with no owner standing), else the branch's own `addBy`. The creator
 * stands as owner unless excluded, and only listed by id once the branch has a list.
 */
export function effectiveAddBy(
  branch: Pick<BranchMetadata, 'access' | 'createdBy' | 'status'>,
  options: { isProtected: boolean; whoCanAdd: ResolvedBranchSharing['whoCanAdd'] },
): BranchAddBy {
  const access = branch.access
  if (
    options.isProtected ||
    access.managerOrAdminAllowed ||
    isNobody(branch.createdBy) ||
    branch.status === 'archived'
  ) {
    return 'admins'
  }
  const addBy = access.addBy ?? options.whoCanAdd
  if (addBy !== 'owner') return addBy
  const ownerStands =
    !isExcludedFrom(access, branch.createdBy) &&
    (!hasAccessList(access) || !!access.allowedUsers?.includes(branch.createdBy))
  return ownerStands ? 'owner' : 'admins'
}

export interface BranchAccessChange {
  add?: { users?: CanopyUserId[]; groups?: CanopyGroupId[] }
  remove?: { users?: CanopyUserId[]; groups?: CanopyGroupId[] }
  /** true: only listed people may open the branch. false: back to the site default ('allow' only). */
  restricted?: boolean
  addBy?: BranchAddBy
  /** Users and groups whose exclusion to lift. */
  unexclude?: { users?: CanopyUserId[]; groups?: CanopyGroupId[] }
}

/** Why a change was refused; each maps to an `ApiErrorCode` of the same name. */
export type BranchAccessRefusalCode =
  | 'ACCESS_CHANGE_INVALID'
  | 'ACCESS_ADD_FORBIDDEN'
  | 'ACCESS_MANAGE_FORBIDDEN'
  | 'USER_EXCLUDED'
  | 'GROUP_EXCLUDED'
  | 'GROUP_NOT_YOURS'
  | 'RESERVED_GROUP'
  | 'OPEN_NOT_ALLOWED'
  | 'EXCLUSION_CAP'

export interface BranchAccessRefusal {
  code: BranchAccessRefusalCode
  message: string
  ids?: string[]
}

export interface BranchAccessChangeResult {
  access: BranchAccessControl
  /** False when the change was already in effect, so nothing need be written. */
  changed: boolean
  added: { users: CanopyUserId[]; groups: CanopyGroupId[] }
  removed: { users: CanopyUserId[]; groups: CanopyGroupId[] }
  /** Exclusions lifted, by an unexclude or by an owner adding the person or group back: user ids, and groups as `group:<id>`. */
  unexcluded: string[]
  /** Exclusions this change recorded, in the same form. */
  excluded: string[]
  /** Set only when the change moved who may add people. */
  addBy?: BranchAddBy
}

export interface ApplyAccessChangeContext {
  actor: Pick<CanopyUser, 'userId' | 'groups'>
  rights: BranchSharingRights
  creator: CanopyUserId
  defaultAccess: DefaultBranchAccess
  now: string
}

const refuse = (
  code: BranchAccessRefusalCode,
  message: string,
  ids?: string[],
): { refusal: BranchAccessRefusal } => ({ refusal: { code, message, ...(ids && { ids }) } })

const unique = <T>(values: readonly T[] | undefined): T[] => [...new Set(values ?? [])]

/** A map's own entry for `key`, never an inherited property such as `constructor`. */
const ownEntry = <T>(map: Record<string, T> | undefined, key: string): T | undefined =>
  map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined

/** Exclusions one branch may hold, so its branch.json and every listing of it stay small. */
const MAX_EXCLUSIONS = 500

/**
 * `access` with `change` applied by `ctx.actor`, or why it may not be. Applying a change already in
 * effect reports `changed: false` and keeps each entry's original `addedBy`, so a retried request
 * is harmless.
 */
export function applyAccessChange(
  access: BranchAccessControl,
  change: BranchAccessChange,
  ctx: ApplyAccessChangeContext,
): BranchAccessChangeResult | { refusal: BranchAccessRefusal } {
  const { actor, rights } = ctx
  const actorIsAdmin = isAdmin(actor.groups)
  const addUsers = unique(change.add?.users)
  const addGroups = unique(change.add?.groups)
  const removeUsers = unique(change.remove?.users)
  const removeGroups = unique(change.remove?.groups)
  const unexclude = unique(change.unexclude?.users)
  const unexcludeGroups = unique(change.unexclude?.groups)
  const adding = addUsers.length > 0 || addGroups.length > 0

  const both = [
    ...addUsers.filter((id) => removeUsers.includes(id)),
    ...addGroups.filter((id) => removeGroups.includes(id)),
    ...removeUsers.filter((id) => unexclude.includes(id)),
    ...removeGroups.filter((id) => unexcludeGroups.includes(id)),
  ]
  if (both.length > 0) {
    return refuse('ACCESS_CHANGE_INVALID', 'An entry cannot be changed two ways at once.', [
      ...new Set(both),
    ])
  }
  if (
    change.restricted === false &&
    (adding ||
      removeUsers.length + removeGroups.length + unexclude.length + unexcludeGroups.length > 0 ||
      change.addBy)
  ) {
    return refuse(
      'ACCESS_CHANGE_INVALID',
      'Opening a branch cannot be combined with other changes.',
    )
  }

  if (adding && !rights.canAdd) {
    return refuse('ACCESS_ADD_FORBIDDEN', "You can't add people to this branch.")
  }
  const managing =
    change.restricted !== undefined ||
    change.addBy !== undefined ||
    unexclude.length + unexcludeGroups.length > 0
  if (managing && !rights.canManage) {
    return refuse('ACCESS_MANAGE_FORBIDDEN', "You can't change who has access to this branch.")
  }
  if (change.addBy === 'admins' && !actorIsAdmin) {
    return refuse('ACCESS_MANAGE_FORBIDDEN', 'Only an admin can change who may add people here.')
  }
  const exclusionOf = (id: CanopyUserId) =>
    isExcludedFrom(access, id) ? access.excluded?.[id] : undefined
  const adminExclusions = [
    ...unexclude.filter((id) => exclusionOf(id)?.byAdmin),
    ...unexcludeGroups.filter((id) => ownEntry(access.excludedGroups, id)?.byAdmin),
  ]
  if (!actorIsAdmin && adminExclusions.length > 0) {
    return refuse(
      'ACCESS_MANAGE_FORBIDDEN',
      'Only an admin can allow back someone an admin removed.',
      adminExclusions,
    )
  }

  const meta = access.entryMeta ?? {}
  // Entries already gone need no right to remove, so a retried removal is harmless.
  const removals = [
    ...removeUsers
      .filter((id) => access.allowedUsers?.includes(id))
      .map((id) => entryKey('user', id)),
    ...removeGroups
      .filter((id) => access.allowedGroups?.includes(id))
      .map((id) => entryKey('group', id)),
  ]
  if (!rights.canManage && removals.length > 0) {
    if (!rights.canRemoveOwn) {
      return refuse('ACCESS_MANAGE_FORBIDDEN', "You can't change who has access to this branch.")
    }
    const notTheirs = removals.filter((key) => meta[key]?.addedBy !== actor.userId)
    if (notTheirs.length > 0) {
      return refuse(
        'ACCESS_MANAGE_FORBIDDEN',
        'You can remove only the people you added.',
        notTheirs.map((key) => key.slice(key.indexOf(':') + 1)),
      )
    }
  }
  if (!actorIsAdmin && removeUsers.includes(ctx.creator)) {
    return refuse('ACCESS_MANAGE_FORBIDDEN', "A branch's owner can't be removed from it.", [
      ctx.creator,
    ])
  }

  const reserved = addGroups.filter((id) => isReservedGroup(id))
  if (reserved.length > 0) {
    return refuse('RESERVED_GROUP', 'Admins and reviewers already have access.', reserved)
  }
  const actorGroups: readonly string[] = actor.groups ?? []
  const notYours = actorIsAdmin ? [] : addGroups.filter((id) => !actorGroups.includes(id))
  if (notYours.length > 0) {
    return refuse('GROUP_NOT_YOURS', 'You can add only groups you belong to.', notYours)
  }
  const blockedGroups = addGroups.filter((id) => {
    const exclusion = ownEntry(access.excludedGroups, id)
    return !!exclusion && !(rights.canManage && (actorIsAdmin || !exclusion.byAdmin))
  })
  if (blockedGroups.length > 0) {
    return refuse(
      'GROUP_EXCLUDED',
      'A group removed from this branch was added again.',
      blockedGroups,
    )
  }
  // An owner adding someone they removed allows them back; a member cannot.
  const blocked = addUsers.filter((id) => {
    const exclusion = exclusionOf(id)
    if (!exclusion) return false
    return !(rights.canManage && (actorIsAdmin || !exclusion.byAdmin))
  })
  if (blocked.length > 0) {
    return refuse('USER_EXCLUDED', 'Someone removed from this branch was added again.', blocked)
  }

  if (change.restricted === false) {
    if (ctx.defaultAccess !== 'allow') {
      return refuse('OPEN_NOT_ALLOWED', 'Branches on this site are open only to listed people.')
    }
    const wasOpen = !hasAccessList(access)
    const next: BranchAccessControl = {
      ...access,
      allowedUsers: undefined,
      allowedGroups: undefined,
      entryMeta: undefined,
      restricted: undefined,
    }
    return {
      access: next,
      changed: !wasOpen,
      added: { users: [], groups: [] },
      removed: { users: access.allowedUsers ?? [], groups: access.allowedGroups ?? [] },
      unexcluded: [],
      excluded: [],
    }
  }

  const users = [...(access.allowedUsers ?? [])]
  const groups = [...(access.allowedGroups ?? [])]
  const nextMeta = { ...meta }
  const excluded = { ...access.excluded }
  const excludedGroups = { ...access.excludedGroups }
  const added = { users: [] as CanopyUserId[], groups: [] as CanopyGroupId[] }
  const removed = { users: [] as CanopyUserId[], groups: [] as CanopyGroupId[] }
  const unexcluded: string[] = []
  const newlyExcluded: string[] = []
  const isExcluded = (id: CanopyUserId) => Object.prototype.hasOwnProperty.call(excluded, id)
  let changed = false

  // The first share of an unlisted branch, or restricting it, keeps its owner on the list.
  const restricting = !hasAccessList(access) && (adding || change.restricted === true)
  if (restricting && (rights.isOwner || actorIsAdmin)) {
    if (!isNobody(ctx.creator) && !isExcluded(ctx.creator) && !users.includes(ctx.creator)) {
      users.push(ctx.creator)
      nextMeta[entryKey('user', ctx.creator)] = { addedBy: actor.userId, addedAt: ctx.now }
    }
  }

  for (const id of addUsers) {
    if (isExcluded(id)) {
      delete excluded[id]
      unexcluded.push(id)
    }
    if (users.includes(id)) continue
    users.push(id)
    nextMeta[entryKey('user', id)] = { addedBy: actor.userId, addedAt: ctx.now }
    added.users.push(id)
  }
  for (const id of addGroups) {
    if (ownEntry(excludedGroups, id)) {
      delete excludedGroups[id]
      unexcluded.push(entryKey('group', id))
    }
    if (groups.includes(id)) continue
    groups.push(id)
    nextMeta[entryKey('group', id)] = { addedBy: actor.userId, addedAt: ctx.now }
    added.groups.push(id)
  }
  for (const id of removeUsers) {
    const at = users.indexOf(id)
    if (at !== -1) {
      users.splice(at, 1)
      delete nextMeta[entryKey('user', id)]
      removed.users.push(id)
    }
    // An owner's or admin's removal excludes the person, even one reaching the branch through a
    // group; a member undoing their own add leaves no exclusion. An admin's removal of someone an
    // owner excluded makes it an admin's, which the owner can't lift.
    const asAdmin = actorIsAdmin && isExcluded(id) && !excluded[id].byAdmin
    if (rights.canManage && (!isExcluded(id) || asAdmin)) {
      excluded[id] = { by: actor.userId, at: ctx.now, byAdmin: actorIsAdmin }
      newlyExcluded.push(id)
    }
  }
  for (const id of removeGroups) {
    const at = groups.indexOf(id)
    if (at === -1) continue
    groups.splice(at, 1)
    delete nextMeta[entryKey('group', id)]
    removed.groups.push(id)
    if (rights.canManage && !ownEntry(excludedGroups, id)) {
      excludedGroups[id] = { by: actor.userId, at: ctx.now, byAdmin: actorIsAdmin }
      newlyExcluded.push(entryKey('group', id))
    }
  }

  for (const id of unexclude) {
    if (!isExcluded(id)) continue
    delete excluded[id]
    unexcluded.push(id)
  }
  for (const id of unexcludeGroups) {
    if (!ownEntry(excludedGroups, id)) continue
    delete excludedGroups[id]
    unexcluded.push(entryKey('group', id))
  }
  if (
    newlyExcluded.length > 0 &&
    Object.keys(excluded).length + Object.keys(excludedGroups).length > MAX_EXCLUSIONS
  ) {
    return refuse(
      'EXCLUSION_CAP',
      'Too many people and groups have been removed from this branch. Allow some back first.',
    )
  }

  const restricted = hasAccessList(access) || restricting || undefined
  const addBy = change.addBy ?? access.addBy
  changed ||=
    added.users.length + added.groups.length + removed.users.length + removed.groups.length > 0 ||
    unexcluded.length + newlyExcluded.length > 0 ||
    users.length !== (access.allowedUsers?.length ?? 0) ||
    restricted !== access.restricted ||
    addBy !== access.addBy

  return {
    access: {
      ...access,
      allowedUsers: users.length > 0 ? users : undefined,
      allowedGroups: groups.length > 0 ? groups : undefined,
      restricted,
      addBy,
      excluded: Object.keys(excluded).length > 0 ? excluded : undefined,
      excludedGroups: Object.keys(excludedGroups).length > 0 ? excludedGroups : undefined,
      entryMeta: Object.keys(nextMeta).length > 0 ? nextMeta : undefined,
    },
    changed,
    added,
    removed,
    unexcluded,
    excluded: newlyExcluded,
    ...(addBy !== access.addBy && addBy && { addBy }),
  }
}

/**
 * The ids of people who already work in this CMS: anyone a path permission names, every internal
 * group's members, every branch's creator and saving editors, and everyone `seen` (people-store.ts).
 * Being on a branch's list is not enough, so
 * adding someone never makes them searchable by other sharers.
 */
export function collectCmsUserIds(input: {
  pathPermissions: readonly PathPermission[]
  internalGroups: readonly { members: readonly CanopyUserId[] }[]
  branches: readonly Pick<BranchMetadata, 'createdBy' | 'editors'>[]
  seen?: Iterable<CanopyUserId>
}): Set<CanopyUserId> {
  const ids = new Set<CanopyUserId>()
  for (const rule of input.pathPermissions) {
    for (const level of [rule.read, rule.edit, rule.review]) {
      for (const id of level?.allowedUsers ?? []) ids.add(id)
    }
  }
  for (const group of input.internalGroups) for (const id of group.members) ids.add(id)
  for (const branch of input.branches) {
    ids.add(branch.createdBy)
    for (const id of branch.editors ?? []) ids.add(id)
  }
  for (const id of input.seen ?? []) ids.add(id)
  for (const id of ids) if (isNobody(id)) ids.delete(id)
  return ids
}

/** What a viewer who may open the branch sees of its list: owners and admins see everything. */
export function accessForViewer(
  access: BranchAccessControl,
  viewer: Pick<CanopyUser, 'userId' | 'groups'>,
  rights: BranchSharingRights,
  viewerIsAdmin: boolean,
): BranchAccessControl {
  const seen: BranchAccessControl = {
    ...(access.allowedUsers && { allowedUsers: access.allowedUsers }),
    ...(access.allowedGroups && { allowedGroups: access.allowedGroups }),
    ...(access.managerOrAdminAllowed !== undefined && {
      managerOrAdminAllowed: access.managerOrAdminAllowed,
    }),
    ...(access.restricted !== undefined && { restricted: access.restricted }),
    ...(access.addBy && { addBy: access.addBy }),
  }
  if (viewerIsAdmin || rights.canManage) {
    return {
      ...seen,
      ...(access.excluded && { excluded: access.excluded }),
      ...(access.excludedGroups && { excludedGroups: access.excludedGroups }),
      ...(access.entryMeta && { entryMeta: access.entryMeta }),
    }
  }
  const theirs = Object.entries(access.entryMeta ?? {}).filter(
    ([, meta]) => meta.addedBy === viewer.userId,
  )
  return theirs.length > 0 ? { ...seen, entryMeta: Object.fromEntries(theirs) } : seen
}
