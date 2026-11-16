import type { AuthPlugin } from './plugin'
import type { UserSearchResult } from './types'
import { personName } from './person-name'
import { isSystemUserId } from '../system-users'
import { ANONYMOUS_USER } from '../user'

/** How many `searchUsers` results a plugin without `findUserByEmail` is searched for the match. */
const FALLBACK_SEARCH_LIMIT = 50

/**
 * The user whose email address is exactly `email`, ignoring case and surrounding space, or null.
 * Never a partial match: matching part of an address would let a searcher spell addresses out a
 * letter at a time. The name is normalized as every other lookup's is (user-metadata-lookup.ts).
 */
export async function findUserByEmail(
  plugin: AuthPlugin,
  email: string,
): Promise<UserSearchResult | null> {
  const wanted = email.trim().toLowerCase()
  if (!wanted) return null
  const found = plugin.findUserByEmail
    ? await plugin.findUserByEmail(wanted)
    : ((await plugin.searchUsers(wanted, FALLBACK_SEARCH_LIMIT)).find(
        (user) => typeof user.email === 'string' && user.email.trim().toLowerCase() === wanted,
      ) ?? null)
  if (!found || isSystemUserId(found.id) || found.id === ANONYMOUS_USER.userId) return null
  return { ...found, name: personName(found.id, found.name) ?? '' }
}
