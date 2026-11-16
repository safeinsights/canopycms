/**
 * The share dialog's reads: who has access to a branch, and finding people to add to it or to a
 * branch about to be created. The rules for finding are in api/people.ts; changing a list is
 * `PATCH /:branch/access` (api/branch.ts).
 */

import { z } from 'zod'

import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { BranchAddBy, BranchContext, CanopyGroupId, CanopyUserId } from '../types'
import type { BranchSharingConfig, DefaultBranchAccess } from '../config'
import type { UserSearchResult } from '../auth/types'
import { accessForViewer, hasAccessList, isAdmin, resolveBranchSharing } from '../authorization'
import { lookupUsersMetadata } from '../auth/user-metadata-lookup'
import { getErrorMessage } from '../utils/error'
import { canopyLogWarn } from '../utils/logger'
import { defineEndpoint } from './route-builder'
import { branchParamSchema } from './validators'
import { addByFor, rightsFor } from './branch-access'
import { branchCreatePermission } from './branch'
import {
  externalGroupName,
  findPeople,
  loadPeopleSources,
  personFor,
  RATE_LIMITED_MESSAGE,
  type FindPeopleResult,
} from './people'

/** Shown for a person or group the sign-in provider can't name. */
const NAME_UNAVAILABLE = 'Name unavailable'

interface BranchAccessEntry {
  kind: 'user' | 'group'
  id: string
  name: string
  avatarUrl?: string
  /** Admins and reviewers only. */
  email?: string
  /** Everyone else, and only for people who work in this CMS. */
  maskedEmail?: string
  /** Who added the entry, when the viewer may see it: owners and admins, or the one who added it. */
  addedBy?: { id: CanopyUserId; name: string }
  addedAt?: string
}

/** Someone the branch's owner or an admin removed, whom members cannot add back. */
interface BranchAccessExcludedEntry {
  kind: 'user' | 'group'
  id: string
  name: string
  by: { id: CanopyUserId; name: string }
  at: string
  /** Only an admin can allow them back. */
  byAdmin: boolean
}

interface BranchAccessData {
  entries: BranchAccessEntry[]
  /** Owners and admins only. */
  excluded?: BranchAccessExcludedEntry[]
  /** The list decides who may open the branch, even when empty. */
  restricted: boolean
  /** No list or lockdown is in force, and the site default lets everyone who can sign in open it. */
  openToEveryone: boolean
  defaultAccess: DefaultBranchAccess
  addBy: BranchAddBy
  /**
   * Who besides admins may add people now: `addBy`, unless the server's rules leave it to admins
   * alone (authorization/branch-sharing.ts `effectiveAddBy`).
   */
  whoCanAdd: BranchAddBy
  rights: { isOwner: boolean; canAdd: boolean; canManage: boolean }
  /** Whose names the viewer's search finds (`branchSharing.searchable`). */
  searchable: NonNullable<BranchSharingConfig['searchable']>
  /** Whom an exact email address finds for the viewer: `'all-users'` for an admin. */
  addableByEmail: NonNullable<BranchSharingConfig['addableByEmail']>
}

export type BranchAccessResponse = ApiResponse<BranchAccessData>

/** What a branch not yet created takes from the site: the branchless finder's answer carries it. */
export interface NewBranchSharing {
  defaultAccess: DefaultBranchAccess
  searchable: BranchAccessData['searchable']
  addableByEmail: BranchAccessData['addableByEmail']
}

export type FindPeopleResponse = ApiResponse<FindPeopleResult & { newBranch?: NewBranchSharing }>

const findPeopleBodySchema = z.object({ query: z.string().max(320) }).strict()

export interface FindPeopleBody {
  /** Empty for suggestions, a whole email address, or the start of a name. */
  query: string
}

/** The users behind `ids`, looked up at once; a failed lookup costs the names, never the answer. */
async function usersById(
  ctx: ApiContext,
  ids: readonly CanopyUserId[],
): Promise<Map<CanopyUserId, UserSearchResult>> {
  const users = new Map<CanopyUserId, UserSearchResult>()
  if (!ctx.authPlugin || ids.length === 0) return users
  try {
    for (const [id, user] of await lookupUsersMetadata(ctx.authPlugin, ids)) {
      if (user && user.id === id) users.set(id, user)
    }
  } catch (err: unknown) {
    canopyLogWarn('[canopy] Could not look up the people on a branch:', getErrorMessage(err))
  }
  return users
}

/**
 * The branch's list as `req.user` may see it (`accessForViewer`), with names. Anyone who may open
 * the branch sees who is on it; owners and admins also see who added each entry and who was
 * removed. Full emails reach only admins and reviewers.
 */
const getBranchAccessHandler = async (
  gc: { branchContext: BranchContext },
  ctx: ApiContext,
  req: ApiRequest,
): Promise<BranchAccessResponse> => {
  const { branch } = gc.branchContext
  const viewer = req.user
  const { config } = ctx.services
  const access = branch.access ?? {}
  const rights = rightsFor(ctx, viewer, branch)
  const visible = accessForViewer(access, viewer, rights, isAdmin(viewer.groups))
  const meta = visible.entryMeta ?? {}
  const excludedUsers = Object.entries(visible.excluded ?? {})
  const excludedGroups = Object.entries(visible.excludedGroups ?? {})

  const { cmsUsers, internalGroups } = await loadPeopleSources(ctx, { seenMayFail: true })
  const users = await usersById(ctx, [
    ...(visible.allowedUsers ?? []),
    ...Object.values(meta).map((entry) => entry.addedBy),
    ...excludedUsers.flatMap(([id, exclusion]) => [id, exclusion.by]),
    ...excludedGroups.map(([, exclusion]) => exclusion.by),
  ])
  const internalNames = new Map(internalGroups.map((group) => [group.id, group.name]))
  const groupIds = [
    ...new Set([...(visible.allowedGroups ?? []), ...excludedGroups.map(([id]) => id)]),
  ]
  const groupNames = new Map<CanopyGroupId, string>(
    await Promise.all(
      groupIds.map(
        async (id): Promise<[CanopyGroupId, string]> => [
          id,
          internalNames.get(id) || (await externalGroupName(ctx, id)) || NAME_UNAVAILABLE,
        ],
      ),
    ),
  )
  const userName = (id: CanopyUserId) => users.get(id)?.name || NAME_UNAVAILABLE
  const added = (key: string): Pick<BranchAccessEntry, 'addedBy' | 'addedAt'> => {
    const entry = Object.prototype.hasOwnProperty.call(meta, key) ? meta[key] : undefined
    return entry
      ? { addedBy: { id: entry.addedBy, name: userName(entry.addedBy) }, addedAt: entry.addedAt }
      : {}
  }

  const entries: BranchAccessEntry[] = [
    ...(visible.allowedUsers ?? []).map((id): BranchAccessEntry => {
      const user = users.get(id)
      const person = user ? personFor(viewer, user, cmsUsers) : undefined
      return {
        kind: 'user',
        id,
        name: person?.name || NAME_UNAVAILABLE,
        ...(person?.avatarUrl && { avatarUrl: person.avatarUrl }),
        ...(person?.email && { email: person.email }),
        ...(person?.maskedEmail && { maskedEmail: person.maskedEmail }),
        ...added(`user:${id}`),
      }
    }),
    ...(visible.allowedGroups ?? []).map(
      (id): BranchAccessEntry => ({
        kind: 'group',
        id,
        name: groupNames.get(id) ?? NAME_UNAVAILABLE,
        ...added(`group:${id}`),
      }),
    ),
  ]
  const excluded =
    visible.excluded || visible.excludedGroups
      ? [
          ...excludedUsers.map(
            ([id, exclusion]): BranchAccessExcludedEntry => ({
              kind: 'user',
              id,
              name: userName(id),
              by: { id: exclusion.by, name: userName(exclusion.by) },
              at: exclusion.at,
              byAdmin: exclusion.byAdmin,
            }),
          ),
          ...excludedGroups.map(
            ([id, exclusion]): BranchAccessExcludedEntry => ({
              kind: 'group',
              id,
              name: groupNames.get(id) ?? NAME_UNAVAILABLE,
              by: { id: exclusion.by, name: userName(exclusion.by) },
              at: exclusion.at,
              byAdmin: exclusion.byAdmin,
            }),
          ),
        ]
      : undefined

  const restricted = hasAccessList(access)
  const sharing = resolveBranchSharing(config)
  return {
    ok: true,
    status: 200,
    data: {
      entries,
      ...(excluded && { excluded }),
      restricted,
      openToEveryone:
        !restricted && config.defaultBranchAccess === 'allow' && !access.managerOrAdminAllowed,
      defaultAccess: config.defaultBranchAccess ?? 'deny',
      addBy: access.addBy ?? sharing.whoCanAdd,
      whoCanAdd: addByFor(ctx, branch),
      rights: { isOwner: rights.isOwner, canAdd: rights.canAdd, canManage: rights.canManage },
      searchable: sharing.searchable,
      addableByEmail: isAdmin(viewer.groups) ? 'all-users' : sharing.addableByEmail,
    },
  }
}

const findResponse = async (
  ctx: ApiContext,
  req: ApiRequest,
  query: string,
  context?: BranchContext,
): Promise<FindPeopleResponse> => {
  const outcome = await findPeople(ctx, req.user, query, context?.branch)
  return outcome.ok
    ? { ok: true, status: 200, data: outcome.result }
    : { ok: false, status: 429, error: RATE_LIMITED_MESSAGE, code: 'RATE_LIMITED' }
}

/** People to add to a branch, for someone who may add people to it. */
const findPeopleHandler = async (
  gc: { branchContext: BranchContext },
  ctx: ApiContext,
  req: ApiRequest,
  _params: z.infer<typeof branchParamSchema>,
  body: FindPeopleBody,
): Promise<FindPeopleResponse> => {
  if (!rightsFor(ctx, req.user, gc.branchContext.branch).canAdd) {
    return {
      ok: false,
      status: 403,
      error: "You can't add people to this branch.",
      code: 'ACCESS_ADD_FORBIDDEN',
    }
  }
  return findResponse(ctx, req, body.query, gc.branchContext)
}

/** People to share a branch with as it is created, for someone who may create branches. */
const findPeopleForNewBranchHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  body: FindPeopleBody,
): Promise<FindPeopleResponse> => {
  if (!(await branchCreatePermission(ctx, req.user)).allowed) {
    return {
      ok: false,
      status: 403,
      error: 'You do not have permission to create branches',
      code: 'BRANCH_CREATE_FORBIDDEN',
    }
  }
  const found = await findResponse(ctx, req, body.query)
  if (!found.data) return found
  const { config } = ctx.services
  const sharing = resolveBranchSharing(config)
  return {
    ...found,
    data: {
      ...found.data,
      newBranch: {
        defaultAccess: config.defaultBranchAccess ?? 'deny',
        searchable: sharing.searchable,
        addableByEmail: isAdmin(req.user.groups) ? 'all-users' : sharing.addableByEmail,
      },
    },
  }
}

const getBranchAccess = defineEndpoint({
  namespace: 'branches',
  name: 'getAccess',
  method: 'GET',
  path: '/:branch/access',
  params: branchParamSchema,
  responseType: 'BranchAccessResponse',
  response: {} as BranchAccessResponse,
  defaultMockData: {
    entries: [],
    restricted: false,
    openToEveryone: false,
    defaultAccess: 'deny',
    addBy: 'members',
    whoCanAdd: 'members',
    rights: { isOwner: false, canAdd: false, canManage: false },
    searchable: 'cms-users',
    addableByEmail: 'all-users',
  },
  guards: ['branchAccess'] as const,
  handler: getBranchAccessHandler,
})

/** POST so an email address in the query stays out of URLs and access logs. */
const findPeopleForBranch = defineEndpoint({
  namespace: 'branches',
  name: 'findPeople',
  method: 'POST',
  readOnly: true,
  path: '/:branch/access/find',
  params: branchParamSchema,
  body: findPeopleBodySchema,
  bodyType: 'FindPeopleBody',
  responseType: 'FindPeopleResponse',
  response: {} as FindPeopleResponse,
  defaultMockData: { people: [], groups: [] },
  guards: ['branchAccess'] as const,
  handler: findPeopleHandler,
})

const findPeopleForNewBranch = defineEndpoint({
  namespace: 'branches',
  name: 'findPeopleForNewBranch',
  method: 'POST',
  readOnly: true,
  path: '/branches/access/find',
  body: findPeopleBodySchema,
  bodyType: 'FindPeopleBody',
  responseType: 'FindPeopleResponse',
  response: {} as FindPeopleResponse,
  defaultMockData: { people: [], groups: [] },
  handler: findPeopleForNewBranchHandler,
})

export const BRANCH_PEOPLE_ROUTES = {
  getAccess: getBranchAccess,
  findPeople: findPeopleForBranch,
  findPeopleForNewBranch,
} as const
