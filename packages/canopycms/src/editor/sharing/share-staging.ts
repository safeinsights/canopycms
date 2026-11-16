/**
 * The Share dialog's staged changes and the one `PATCH /:branch/access` body they become. The
 * rules each change must pass are the server's (authorization/branch-sharing.ts).
 */

import type { UpdateBranchAccessBody } from '../../api/branch'
import type { BranchAccessResponse } from '../../api/branch-people'
import type { FoundPerson } from '../../api/people'
import type { BranchAddBy } from '../../types'
import { isSystemUserId } from '../../system-users'
import { isEmailAddress } from '../../utils/email-address'

export type BranchAccess = NonNullable<BranchAccessResponse['data']>
export type AccessEntry = BranchAccess['entries'][number]
export type ExcludedEntry = NonNullable<BranchAccess['excluded']>[number]
type Kind = AccessEntry['kind']

/**
 * A person to add: by id, else by `email`, which the server looks up again. An address goes for one
 * whose find threw or was refused other than by the rate limit or a lockout (PeoplePicker's
 * `addByEmail`), and with the id for one found by it, as `personToAdd` decides.
 */
export type PersonToAdd = {
  kind: 'user'
  name: string
  avatarUrl?: string
  shownEmail?: string
} & ({ id: string; email?: string } | { id?: undefined; email: string })
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

/**
 * `person` to add, found by `address` when given. One the server would refuse by id (its
 * `addByAddress`) goes by that address, which vouches for them; anyone else goes by id, sparing the
 * email lookup the address would cost again.
 */
export const personToAdd = (person: FoundPerson, address?: string): PersonToAdd => ({
  kind: 'user',
  id: person.id,
  name: person.name,
  avatarUrl: person.avatarUrl,
  shownEmail: person.email ?? person.maskedEmail,
  ...(address && person.addByAddress && { email: address }),
})

/** Whether a query finds by exact address, as the server tests it (utils/email-address.ts). */
export const looksLikeEmail = isEmailAddress

const idsOf = (items: ReadonlyArray<{ kind: Kind; id?: string }>, kind: Kind): string[] =>
  items.flatMap((item) => (item.kind === kind && item.id !== undefined ? [item.id] : []))

const nonEmpty = <T extends Record<string, unknown[]>>(lists: T): Partial<T> | undefined => {
  const kept = Object.fromEntries(Object.entries(lists).filter(([, list]) => list.length > 0))
  return Object.keys(kept).length > 0 ? (kept as Partial<T>) : undefined
}

/** `add` as a request sends it: people by address where they have one, else by id. */
export const additionsBody = (
  add: readonly Addition[],
): NonNullable<UpdateBranchAccessBody['add']> | undefined =>
  nonEmpty({
    users: add.flatMap((item) =>
      item.kind === 'user' && item.id !== undefined && !item.email ? [item.id] : [],
    ),
    groups: idsOf(add, 'group'),
    emails: add.flatMap((item) => (item.kind === 'user' && item.email ? [item.email] : [])),
  })

/** The one request that makes every staged change; empty when nothing would change. */
export function accessChangeBody(
  staged: StagedAccess,
  current: BranchAccess,
): UpdateBranchAccessBody {
  if (staged.restricted === false) return current.restricted ? { restricted: false } : {}
  const add = additionsBody(staged.add)
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
 * Whether every address `body` added shows in `fresh`, read again after the update got no answer:
 * an address can't be matched to anyone listed, so this counts people `viewer` added there who
 * neither `before` listed nor `body` added by id.
 */
export function addressesLanded(
  body: UpdateBranchAccessBody,
  before: BranchAccess,
  fresh: BranchAccess,
  viewer: string,
): boolean {
  const emails = body.add?.emails?.length ?? 0
  if (emails === 0) return true
  const was = new Set(before.entries.map(entryKey))
  const byId = new Set(body.add?.users ?? [])
  const added = fresh.entries.filter(
    (entry) =>
      entry.kind === 'user' &&
      !was.has(entryKey(entry)) &&
      !byId.has(entry.id) &&
      entry.addedBy?.id === viewer,
  )
  return added.length >= emails
}

/**
 * Whether `access`, read again after an update got no answer, already shows `body` applied, its
 * addresses as `addressesLanded` judged them.
 */
export function changeLanded(
  body: UpdateBranchAccessBody,
  access: BranchAccess,
  addressesIn = false,
): boolean {
  if (body.add?.emails?.length && !addressesIn) return false
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
const isPersonId = (id: string | undefined): id is string =>
  !!id && id !== 'unknown' && !isSystemUserId(id)

/**
 * Whether the owner shows as a row though the list doesn't name them: an unlisted branch admits its
 * owner, which matters on a closed site, or once staged changes limit it to its list (`narrowing`).
 */
export const showsUnlistedOwner = (
  access: BranchAccess,
  owner: string | undefined,
  narrowing = false,
): owner is string =>
  !access.restricted &&
  isPersonId(owner) &&
  (access.defaultAccess !== 'allow' || narrowing) &&
  ![...access.entries, ...(access.excluded ?? [])].some(
    (entry) => entry.kind === 'user' && entry.id === owner,
  )

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
