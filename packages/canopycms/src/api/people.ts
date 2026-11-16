/**
 * Finding people to share a branch with: who works in this CMS, the exact-email lookup and its
 * limit, matching on names, and what a searcher may see of an address. The endpoints live in
 * api/branch-people.ts; a change to a list resolves its emails here (api/branch-access.ts).
 */

import type { ApiContext } from './types'
import type { BranchMetadata, CanopyGroupId, CanopyUserId } from '../types'
import type { CanopyUser } from '../user'
import type { UserSearchResult } from '../auth/types'
import type { InternalGroup } from '../authorization'
import {
  collectCmsUserIds,
  isAdmin,
  isPrivileged,
  isReservedGroup,
  loadInternalGroups,
  RESERVED_GROUPS,
  loadPathPermissions,
  resolveBranchSharing,
} from '../authorization'
import { CachingAuthPlugin } from '../auth/caching-auth-plugin'
import { findUserByEmail } from '../auth/find-user-by-email'
import { personName } from '../auth/person-name'
import { lookupUsersMetadata } from '../auth/user-metadata-lookup'
import { isSystemUserId } from '../system-users'
import { ANONYMOUS_USER } from '../user'
import { logEmailLookup } from '../utils/access-log'
import { getErrorMessage } from '../utils/error'
import { canopyLogWarn } from '../utils/logger'

/** The most people, and the most groups, one find answers with. */
const FIND_LIMIT = 8
/** The shortest name query answered: one letter would page through the directory. */
const MIN_NAME_QUERY_LENGTH = 2
/**
 * Email lookups one person may make per {@link EMAIL_LOOKUP_WINDOW_MS}.
 * @internal Exported for tests.
 */
export const EMAIL_LOOKUP_LIMIT = 20
const EMAIL_LOOKUP_WINDOW_MS = 10 * 60 * 1000
export const RATE_LIMITED_MESSAGE = 'Too many email lookups. Try again in a few minutes.'
const OVER_FETCH = 50

interface PeopleSources {
  cmsUsers: Set<CanopyUserId>
  internalGroups: InternalGroup[]
}

/** Whether this process has logged an unreadable seen set while reading a branch's list. */
let reportedUnreadableSeen = false

/**
 * {@link collectCmsUserIds} over the settings files, the branch registry and the seen set, plus
 * the internal groups read on the way. Rejects when any of them can't be read, so finding and
 * adding people fail closed. `seenMayFail` is for a read where the set only decides which emails
 * are masked: there an unreadable seen set counts as empty, logged once per process, which shows
 * fewer masked emails and never more.
 */
export async function loadPeopleSources(
  ctx: ApiContext,
  options?: { seenMayFail?: boolean },
): Promise<PeopleSources> {
  const { config, bootstrapAdminIds, registry, peopleStore } = ctx.services
  const settingsRoot = await ctx.services.getSettingsBranchRoot()
  const seen = async (): Promise<Set<CanopyUserId>> => {
    if (!peopleStore) return new Set()
    if (!options?.seenMayFail) return peopleStore.listSeen()
    try {
      return await peopleStore.listSeen()
    } catch (err: unknown) {
      if (!reportedUnreadableSeen) {
        reportedUnreadableSeen = true
        canopyLogWarn('[canopy] Could not read who has opened the editor:', getErrorMessage(err))
      }
      return new Set()
    }
  }
  const [pathPermissions, internalGroups, branches, seenIds] = await Promise.all([
    loadPathPermissions(settingsRoot, config.mode),
    loadInternalGroups(settingsRoot, config.mode, bootstrapAdminIds),
    registry ? registry.list() : Promise.resolve([]),
    seen(),
  ])
  return {
    cmsUsers: collectCmsUserIds({
      pathPermissions,
      internalGroups,
      branches: branches.map((context) => context.branch),
      seen: seenIds,
    }),
    internalGroups,
  }
}

/** The ids of people who work in this CMS ({@link loadPeopleSources}). */
export async function loadCmsUserIds(ctx: ApiContext): Promise<Set<CanopyUserId>> {
  return (await loadPeopleSources(ctx)).cmsUsers
}

/**
 * Records `user` in the seen set when they hold an internal group other than Admins and
 * Reviewers, or a provider group some path permission names, so they can be found before they
 * have saved anything. Best effort. Until this process has recorded them, each visit by someone
 * with groups reads the settings files; once it has, a visit costs no fs call.
 */
export async function enrolSeenUser(ctx: ApiContext, user: CanopyUser): Promise<void> {
  const store = ctx.services.peopleStore
  if (!store || user.type !== 'authenticated' || user.groups.length === 0) return
  if (store.hasRecordedSeen(user.userId) || isSystemUserId(user.userId)) return
  try {
    const { config, bootstrapAdminIds } = ctx.services
    const settingsRoot = await ctx.services.getSettingsBranchRoot()
    const [internalGroups, pathPermissions] = await Promise.all([
      loadInternalGroups(settingsRoot, config.mode, bootstrapAdminIds),
      loadPathPermissions(settingsRoot, config.mode),
    ])
    const internal = new Set(internalGroups.map((group) => group.id))
    const named = new Set(
      pathPermissions.flatMap((rule) =>
        [rule.read, rule.edit, rule.review].flatMap((level) => level?.allowedGroups ?? []),
      ),
    )
    const qualifies = user.groups.some((group) =>
      internal.has(group) ? !isReservedGroup(group) : named.has(group),
    )
    if (qualifies) await store.recordSeen(user.userId)
  } catch (err: unknown) {
    canopyLogWarn('[canopy] Could not record who opened the editor:', getErrorMessage(err))
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Whether a query reads as one whole email address, which finds by exact match only. */
const looksLikeEmail = (query: string): boolean => EMAIL_PATTERN.test(query.trim())

/**
 * `b•••@example.org` for `ben@example.org`: enough to tell two people of one name apart, never
 * enough to write to them. Undefined for anything that is not an address.
 */
function maskEmail(email: string | undefined): string | undefined {
  if (!email) return undefined
  const at = email.lastIndexOf('@')
  if (at < 1 || at === email.length - 1) return undefined
  return `${Array.from(email)[0]}•••${email.slice(at)}`
}

const WORD_START = /[\s\-'.(]/

/** Whether `query` starts `name` or one of its words, ignoring case. */
function matchesName(name: string, query: string): boolean {
  const wanted = query.trim().replace(/\s+/g, ' ').toLowerCase()
  const lower = name.toLowerCase()
  if (!wanted || !lower) return false
  for (let i = 0; i <= lower.length - wanted.length; i++) {
    if ((i === 0 || WORD_START.test(lower[i - 1])) && lower.startsWith(wanted, i)) return true
  }
  return false
}

/**
 * Email lookups by person in this process. Each server process counts on its own, so on a fleet
 * of warm Lambdas the limit holds per process: a bound on how fast one person can test addresses,
 * not an exact quota.
 */
const emailLookups = new Map<CanopyUserId, number[]>()

/** Takes `count` lookups from `actor`'s allowance, or takes none and answers false. */
function takeEmailLookups(actor: CanopyUserId, count: number, now = Date.now()): boolean {
  const since = now - EMAIL_LOOKUP_WINDOW_MS
  if (emailLookups.size > 10_000) {
    for (const [id, times] of emailLookups) {
      if (times.every((time) => time <= since)) emailLookups.delete(id)
    }
  }
  const recent = (emailLookups.get(actor) ?? []).filter((time) => time > since)
  if (recent.length + count > EMAIL_LOOKUP_LIMIT) {
    emailLookups.set(actor, recent)
    return false
  }
  emailLookups.set(actor, [...recent, ...Array.from({ length: count }, () => now)])
  return true
}

/** @internal Exported for tests. */
export function resetEmailLookupLimits(): void {
  emailLookups.clear()
}

/**
 * The user each address finds for `actor`, or null: an exact match, within `addableByEmail` for
 * anyone but an admin. False, looking nothing up, when the lookups would pass `actor`'s limit.
 * Each lookup logs the actor and what they were shown, never the address.
 */
export async function lookupEmails(
  ctx: ApiContext,
  actor: CanopyUser,
  emails: readonly string[],
  cmsUsers?: Set<CanopyUserId>,
): Promise<Array<UserSearchResult | null> | false> {
  if (emails.length === 0) return []
  if (!takeEmailLookups(actor.userId, emails.length)) return false
  const scoped =
    !isAdmin(actor.groups) &&
    resolveBranchSharing(ctx.services.config).addableByEmail === 'cms-users'
  const inScope = scoped ? (cmsUsers ?? (await loadCmsUserIds(ctx))) : undefined
  const found: Array<UserSearchResult | null> = []
  for (const email of emails) {
    const user = ctx.authPlugin ? await findUserByEmail(ctx.authPlugin, email) : null
    const shown = user && (!inScope || inScope.has(user.id)) ? user : null
    logEmailLookup({ actor: actor.userId, result: shown?.id ?? 'not found' })
    found.push(shown)
  }
  return found
}

export interface FoundPerson {
  id: CanopyUserId
  name: string
  avatarUrl?: string
  /** Admins and reviewers only. */
  email?: string
  /** Everyone else, and only for people who work in this CMS. */
  maskedEmail?: string
  /**
   * Found by exact address for a finder whose add of this person by id would be refused as out of
   * scope (api/branch-access.ts `checkUsersToAdd`): not an admin, and they don't work in this CMS.
   * Only that address, sent with the add, vouches for them.
   */
  addByAddress?: true
}

interface FoundGroup {
  id: CanopyGroupId
  name: string
}

export interface FindPeopleResult {
  people: FoundPerson[]
  groups: FoundGroup[]
}

/**
 * What `viewer` may see of `user`: an admin or reviewer the address, anyone else a masked one,
 * and that only for someone who works in this CMS.
 */
export function personFor(
  viewer: CanopyUser,
  user: UserSearchResult,
  cmsUsers: ReadonlySet<CanopyUserId>,
): FoundPerson {
  const person: FoundPerson = { id: user.id, name: user.name }
  if (user.avatarUrl) person.avatarUrl = user.avatarUrl
  if (isPrivileged(viewer.groups)) {
    if (user.email) person.email = user.email
  } else if (cmsUsers.has(user.id)) {
    const masked = maskEmail(user.email)
    if (masked) person.maskedEmail = masked
  }
  return person
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
const isPerson = (id: CanopyUserId) => !isSystemUserId(id) && id !== ANONYMOUS_USER.userId

/** Users found for `ids`, in the order given, dropping ids the provider doesn't know. */
async function usersFor(
  ctx: ApiContext,
  ids: readonly CanopyUserId[],
): Promise<UserSearchResult[]> {
  if (!ctx.authPlugin || ids.length === 0) return []
  const found = await lookupUsersMetadata(ctx.authPlugin, ids)
  return ids.flatMap((id) => {
    const user = found.get(id)
    return user && user.id === id ? [user] : []
  })
}

/**
 * Names matching `query` among the people the sign-in provider knows: a caching plugin's whole
 * list, else the first 50 its search returns. Never an email match.
 */
async function searchAllUsers(ctx: ApiContext, query: string): Promise<UserSearchResult[]> {
  const plugin = ctx.authPlugin
  if (!plugin) return []
  const pool =
    plugin instanceof CachingAuthPlugin
      ? await plugin.getAllUsers()
      : await plugin.searchUsers(query, OVER_FETCH)
  return pool
    .map((user) => ({ ...user, name: personName(user.id, user.name) ?? '' }))
    .filter((user) => matchesName(user.name, query))
}

/** The groups `actor` may add: their own, bar Admins and Reviewers; an admin, any internal group too. */
async function groupsFor(
  ctx: ApiContext,
  actor: CanopyUser,
  internalGroups: readonly InternalGroup[],
): Promise<FoundGroup[]> {
  const internal = new Map(internalGroups.map((group) => [group.id, group.name]))
  const ids = new Set(actor.groups.filter((id) => !isReservedGroup(id)))
  if (isAdmin(actor.groups)) {
    for (const group of internalGroups) if (!isReservedGroup(group.id)) ids.add(group.id)
  }
  const groups = await Promise.all(
    [...ids].map(async (id): Promise<FoundGroup | null> => {
      const name = internal.get(id) ?? (await externalGroupName(ctx, id))
      return name ? { id, name } : null
    }),
  )
  return groups.filter((group): group is FoundGroup => group !== null)
}

/** A provider group's name, or undefined when the provider can't say. */
export async function externalGroupName(
  ctx: ApiContext,
  id: CanopyGroupId,
): Promise<string | undefined> {
  if (!ctx.authPlugin) return undefined
  try {
    return (await ctx.authPlugin.getGroupMetadata(id))?.name || undefined
  } catch {
    return undefined
  }
}

export type FindPeopleOutcome = { ok: true; result: FindPeopleResult } | { ok: false }

/**
 * People and groups `actor` might add, for `query`; `branch` is the branch being shared, absent
 * for a branch not yet created. Nobody already listed or excluded there, nor `actor`, is offered.
 *
 * - An empty query suggests whom `actor` recently shared with, then the branch's editors.
 * - A whole email address finds its owner by exact match, counted against the email limit
 *   (`ok: false` past it) and scoped by `branchSharing.addableByEmail`.
 * - Otherwise a query of at least two characters matches the start of a name or of a word in it,
 *   among the people `branchSharing.searchable` names.
 *
 * Only people who work in this CMS are suggested, and only they carry a masked email.
 */
export async function findPeople(
  ctx: ApiContext,
  actor: CanopyUser,
  query: string,
  branch?: Pick<BranchMetadata, 'access' | 'editors'>,
): Promise<FindPeopleOutcome> {
  const trimmed = query.trim()
  const empty: FindPeopleResult = { people: [], groups: [] }
  const isEmail = looksLikeEmail(trimmed)
  if (trimmed !== '' && !isEmail && trimmed.length < MIN_NAME_QUERY_LENGTH) {
    return { ok: true, result: empty }
  }

  const access = branch?.access ?? {}
  const skip = new Set<CanopyUserId>([
    actor.userId,
    ...(access.allowedUsers ?? []),
    ...Object.keys(access.excluded ?? {}),
  ])
  const skipGroups = new Set<CanopyGroupId>([
    ...(access.allowedGroups ?? []),
    ...Object.keys(access.excludedGroups ?? {}),
  ])
  const { cmsUsers, internalGroups } = await loadPeopleSources(ctx)
  // Admins, bootstrap admins included, open and manage every branch, so listing one changes
  // nothing. A reviewer listed becomes a member, who may add people where members can.
  const admins = new Set(
    internalGroups
      .filter((group) => group.id === RESERVED_GROUPS.ADMINS)
      .flatMap((group) => group.members),
  )
  const offered = (user: UserSearchResult) =>
    isPerson(user.id) && !skip.has(user.id) && !admins.has(user.id)
  const shown = (users: UserSearchResult[]) =>
    users
      .filter(offered)
      .slice(0, FIND_LIMIT)
      .map((user) => personFor(actor, user, cmsUsers))

  if (isEmail) {
    const found = await lookupEmails(ctx, actor, [trimmed], cmsUsers)
    if (found === false) return { ok: false }
    const vouches = !isAdmin(actor.groups)
    const people = shown(found.flatMap((user) => (user ? [user] : []))).map((person) =>
      vouches && !cmsUsers.has(person.id) ? { ...person, addByAddress: true as const } : person,
    )
    return { ok: true, result: { people, groups: [] } }
  }

  let people: UserSearchResult[]
  if (trimmed === '') {
    const store = ctx.services.peopleStore
    const recent = store
      ? await store.recentShares(actor.userId).catch((err: unknown) => {
          canopyLogWarn('[canopy] Could not read recent shares:', getErrorMessage(err))
          return []
        })
      : []
    const ids = [...new Set([...recent.map((share) => share.userId), ...(branch?.editors ?? [])])]
    people = await usersFor(
      ctx,
      ids.filter((id) => cmsUsers.has(id) && !skip.has(id)),
    )
  } else {
    const { searchable } = resolveBranchSharing(ctx.services.config)
    if (searchable === 'cms-users') {
      const pool = await usersFor(
        ctx,
        [...cmsUsers].filter((id) => !skip.has(id)),
      )
      people = pool.filter((user) => matchesName(user.name, trimmed)).sort(byName)
    } else if (searchable === 'all-users') {
      people = (await searchAllUsers(ctx, trimmed)).sort(byName)
    } else {
      people = []
    }
  }

  const groups = (await groupsFor(ctx, actor, internalGroups))
    .filter((group) => !skipGroups.has(group.id))
    .filter((group) => trimmed === '' || matchesName(group.name, trimmed))
    .sort(byName)
    .slice(0, FIND_LIMIT)
  return { ok: true, result: { people: shown(people), groups } }
}
