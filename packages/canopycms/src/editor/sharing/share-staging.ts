/**
 * The Share dialog's staged changes and the one `PATCH /:branch/access` body they become. The
 * rules each change must pass are the server's (authorization/branch-sharing.ts).
 */

import type { UpdateBranchAccessBody } from '../../api/branch'
import type { BranchAccessResponse } from '../../api/branch-people'
import type { FoundPerson } from '../../api/people'
import type { BranchAddBy } from '../../types'
import { isSystemUserId } from '../../system-users'

export type BranchAccess = NonNullable<BranchAccessResponse['data']>
export type AccessEntry = BranchAccess['entries'][number]
export type ExcludedEntry = NonNullable<BranchAccess['excluded']>[number]
type Kind = AccessEntry['kind']

/** A person to add: by the id a find returned, else by an address no find has looked up. */
export type PersonToAdd = {
  kind: 'user'
  name: string
  avatarUrl?: string
  shownEmail?: string
} & ({ id: string; email?: undefined } | { id?: undefined; email: string })
export type Addition = PersonToAdd | { kind: 'group'; id: string; name: string }

export interface StagedAccess {
  add: Addition[]
  remove: Array<{ kind: Kind; id: string }>
  unexclude: Array<{ kind: Kind; id: string }>
  addBy?: BranchAddBy
  /** false opens the branch to everyone who can sign in; true limits it to its list. */
  restricted?: boolean
}

export const NOTHING_STAGED: StagedAccess = { add: [], remove: [], unexclude: [] }

export const entryKey = (entry: { kind: Kind; id?: string; email?: string }): string =>
  entry.id !== undefined ? `${entry.kind}:${entry.id}` : `email:${entry.email?.toLowerCase()}`

export const personToAdd = (person: FoundPerson): PersonToAdd => ({
  kind: 'user',
  id: person.id,
  name: person.name,
  avatarUrl: person.avatarUrl,
  shownEmail: person.email ?? person.maskedEmail,
})

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The server's test for a query that finds by exact address (api/people.ts). */
export const looksLikeEmail = (query: string): boolean => EMAIL_PATTERN.test(query.trim())

const idsOf = (items: Array<{ kind: Kind; id?: string }>, kind: Kind): string[] =>
  items.flatMap((item) => (item.kind === kind && item.id !== undefined ? [item.id] : []))

const nonEmpty = <T extends Record<string, unknown[]>>(lists: T): Partial<T> | undefined => {
  const kept = Object.fromEntries(Object.entries(lists).filter(([, list]) => list.length > 0))
  return Object.keys(kept).length > 0 ? (kept as Partial<T>) : undefined
}

/** The one request that makes every staged change; empty when nothing would change. */
export function accessChangeBody(
  staged: StagedAccess,
  current: BranchAccess,
): UpdateBranchAccessBody {
  if (staged.restricted === false) return current.restricted ? { restricted: false } : {}
  const add = nonEmpty({
    users: idsOf(staged.add, 'user'),
    groups: idsOf(staged.add, 'group'),
    emails: staged.add.flatMap((item) => (item.kind === 'user' && item.email ? [item.email] : [])),
  })
  const remove = nonEmpty({
    users: idsOf(staged.remove, 'user'),
    groups: idsOf(staged.remove, 'group'),
  })
  const unexclude = nonEmpty({
    users: idsOf(staged.unexclude, 'user'),
    groups: idsOf(staged.unexclude, 'group'),
  })
  return {
    ...(add && { add }),
    ...(remove && { remove }),
    ...(unexclude && { unexclude }),
    ...(staged.addBy && staged.addBy !== current.addBy && { addBy: staged.addBy }),
    ...(staged.restricted && !current.restricted && { restricted: true }),
  }
}

/**
 * Whether `access`, read again after an update got no answer, already shows `body` applied. An
 * address can't be matched to anyone listed, so a change adding one never reads as landed.
 */
export function changeLanded(body: UpdateBranchAccessBody, access: BranchAccess): boolean {
  if (body.add?.emails?.length) return false
  const listed = new Set(access.entries.map(entryKey))
  const excluded = new Set((access.excluded ?? []).map(entryKey))
  const keys = (ids: string[] | undefined, kind: Kind) => (ids ?? []).map((id) => `${kind}:${id}`)
  return (
    [...keys(body.add?.users, 'user'), ...keys(body.add?.groups, 'group')].every((key) =>
      listed.has(key),
    ) &&
    [...keys(body.remove?.users, 'user'), ...keys(body.remove?.groups, 'group')].every(
      (key) => !listed.has(key),
    ) &&
    [...keys(body.unexclude?.users, 'user'), ...keys(body.unexclude?.groups, 'group')].every(
      (key) => !excluded.has(key),
    ) &&
    (body.restricted === undefined || body.restricted === access.restricted) &&
    (body.addBy === undefined || body.addBy === access.addBy)
  )
}

/** Whether the staged changes would limit an open branch to its list. */
export const narrows = (staged: StagedAccess, current: BranchAccess): boolean =>
  current.openToEveryone &&
  staged.restricted !== false &&
  (staged.restricted === true || staged.add.length > 0)

/** Whether `id` is a person's: not a system user's, nor the placeholder of a branch with no creator. */
export const isPersonId = (id: string | undefined): id is string =>
  !!id && id !== 'unknown' && !isSystemUserId(id)

/**
 * The branch's editors who would lose access once it is limited to its list: people neither
 * listed, staged to be added, removed already, nor its owner, whom limiting a branch keeps.
 */
export function editorsLosingAccess(
  editors: readonly string[],
  owner: string | undefined,
  staged: StagedAccess,
  current: BranchAccess,
): string[] {
  const kept = new Set([
    ...current.entries.filter((entry) => entry.kind === 'user').map((entry) => entry.id),
    ...(current.excluded ?? []).filter((entry) => entry.kind === 'user').map((entry) => entry.id),
    ...idsOf(staged.add, 'user'),
    ...(owner ? [owner] : []),
  ])
  return [...new Set(editors)].filter((id) => isPersonId(id) && !kept.has(id))
}

/** `add` with `addition`, unless it or an entry `listed` already has its key. */
export function withAddition(
  add: readonly Addition[],
  addition: Addition,
  listed: ReadonlySet<string> = new Set(),
): Addition[] {
  const key = entryKey(addition)
  return listed.has(key) || add.some((item) => entryKey(item) === key)
    ? [...add]
    : [...add, addition]
}

/** "Ana", "Ana and Ben", "Ana, Ben and Chen". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
