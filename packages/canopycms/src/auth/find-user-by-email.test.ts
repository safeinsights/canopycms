import { describe, expect, it, vi } from 'vitest'

import { findUserByEmail } from './find-user-by-email'
import type { AuthPlugin } from './plugin'
import type { UserSearchResult } from './types'
import { SYSTEM_USER_ID } from '../system-users'

const users: UserSearchResult[] = [
  { id: 'ana', name: 'Ana Lee', email: 'ana@example.org' },
  { id: 'anabel', name: 'Anabel Ruiz', email: 'ana@example.org.uk' },
  { id: 'ben', name: '  ', email: 'Ben@Example.org' },
]

const plugin = (extra: Partial<AuthPlugin> = {}): AuthPlugin => ({
  authenticate: async () => ({ success: false }),
  // Matches parts of names and addresses, as providers' searches do.
  searchUsers: vi.fn(async (query: string) =>
    users.filter((u) => u.email.toLowerCase().includes(query) || u.name.includes(query)),
  ),
  getUserMetadata: async () => null,
  getGroupMetadata: async () => null,
  listGroups: async () => [],
  ...extra,
})

describe('findUserByEmail', () => {
  it("asks the plugin's own lookup, trimmed and lower-cased, when it has one", async () => {
    const find = vi.fn(async () => users[0])
    const withLookup = plugin({ findUserByEmail: find })

    expect((await findUserByEmail(withLookup, '  ANA@example.org '))?.id).toBe('ana')
    expect(find).toHaveBeenCalledWith('ana@example.org')
    expect(withLookup.searchUsers).not.toHaveBeenCalled()
  })

  it('falls back to an exact match among search results, never a partial one', async () => {
    const fallback = plugin()

    expect((await findUserByEmail(fallback, 'Ana@Example.org'))?.id).toBe('ana')
    expect(fallback.searchUsers).toHaveBeenCalledWith('ana@example.org', 50)
    expect(await findUserByEmail(fallback, 'example.org')).toBeNull()
    expect(await findUserByEmail(fallback, 'na@example.org')).toBeNull()
  })

  it('normalizes the name as other lookups do, and finds no system user', async () => {
    expect(await findUserByEmail(plugin(), 'ben@example.org')).toMatchObject({
      id: 'ben',
      name: '',
    })
    const system = plugin({
      findUserByEmail: async () => ({ id: SYSTEM_USER_ID, name: 'Bot', email: 'bot@example.org' }),
    })
    expect(await findUserByEmail(system, 'bot@example.org')).toBeNull()
  })

  it('looks nothing up for a blank address', async () => {
    const blank = plugin()

    expect(await findUserByEmail(blank, '   ')).toBeNull()
    expect(blank.searchUsers).not.toHaveBeenCalled()
  })
})
