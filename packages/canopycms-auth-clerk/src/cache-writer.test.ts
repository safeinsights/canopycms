import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const mockGetUserList = vi.fn()
const mockGetUserMembershipList = vi.fn()
const mockGetInstanceMembershipList = vi.fn()
const mockGetOrganizationList = vi.fn()

vi.mock('@clerk/backend', () => ({
  createClerkClient: vi.fn(() => ({
    users: {
      getUserList: mockGetUserList,
      getOrganizationMembershipList: mockGetUserMembershipList,
    },
    organizations: {
      getOrganizationList: mockGetOrganizationList,
      getInstanceOrganizationMembershipList: mockGetInstanceMembershipList,
    },
  })),
}))

import { FileBasedAuthCache } from 'canopycms/auth/cache'
import { fetchClerkSnapshot, refreshClerkCache } from './cache-writer'

const secretKey = 'sk_test_cache_writer'

function membership(userId: string, orgId: string) {
  return { organization: { id: orgId }, publicUserData: { userId } }
}

/** What `ClerkAPIResponseError` carries: a `status` and `errors: [{ code, message }]`. */
function clerkError(status: number, code?: string) {
  return Object.assign(new Error('Forbidden'), {
    status,
    errors: code ? [{ code, message: 'm' }] : [],
  })
}

function pageOfUsers(count: number, from: number) {
  return Array.from({ length: count }, (_, i) => ({ id: `user_${from + i}`, fullName: 'N' }))
}

beforeEach(() => {
  vi.resetAllMocks()
  mockGetOrganizationList.mockResolvedValue({ data: [] })
  mockGetInstanceMembershipList.mockResolvedValue({ data: [] })
})

describe('fetchClerkSnapshot', () => {
  it('maps camelCase and snake_case user fields', async () => {
    mockGetUserList.mockResolvedValue({
      data: [
        {
          id: 'user_camel',
          fullName: 'Camel Case',
          imageUrl: 'https://img/camel',
          primaryEmailAddress: { emailAddress: 'camel@test.com' },
        },
        {
          id: 'user_snake',
          full_name: 'Snake Case',
          image_url: 'https://img/snake',
          email_addresses: [{ email_address: 'snake@test.com' }],
        },
        { id: 'user_bare', username: 'barely' },
        { id: 'user_nameless' },
      ],
    })

    const snapshot = await fetchClerkSnapshot({ secretKey })

    expect(snapshot.users).toEqual([
      {
        id: 'user_camel',
        name: 'Camel Case',
        email: 'camel@test.com',
        avatarUrl: 'https://img/camel',
      },
      {
        id: 'user_snake',
        name: 'Snake Case',
        email: 'snake@test.com',
        avatarUrl: 'https://img/snake',
      },
      { id: 'user_bare', name: 'barely', email: '', avatarUrl: undefined },
      { id: 'user_nameless', name: '', email: '', avatarUrl: undefined },
    ])
  })

  it('names a user by the same rule as the live lookups, never by the id or the email', async () => {
    mockGetUserList.mockResolvedValue({
      data: [
        { id: 'user_full', fullName: '  Full Name  ', username: 'ignored' },
        { id: 'user_blank_full', fullName: '   ', full_name: '', username: ' handle ' },
        { id: 'user_none', email_addresses: [{ email_address: 'private.person@test.com' }] },
      ],
    })

    const { users } = await fetchClerkSnapshot({ secretKey })

    expect(users.map((u) => u.name)).toEqual(['Full Name', 'handle', ''])
    const nameless = users[2]
    expect(nameless.name).not.toBe('user_none')
    expect(nameless.name).not.toContain('private')
    expect(nameless.email).toBe('private.person@test.com')
  })

  it('fetches a second page when the first is full', async () => {
    mockGetUserList
      .mockResolvedValueOnce(pageOfUsers(500, 0))
      .mockResolvedValueOnce(pageOfUsers(3, 500))

    const snapshot = await fetchClerkSnapshot({ secretKey, useOrganizationsAsGroups: false })

    expect(snapshot.users).toHaveLength(503)
    expect(mockGetUserList).toHaveBeenCalledTimes(2)
    expect(mockGetUserList).toHaveBeenNthCalledWith(1, { limit: 500, offset: 0 })
    expect(mockGetUserList).toHaveBeenNthCalledWith(2, { limit: 500, offset: 500 })
  })

  it('maps organizations to groups and memberships to group ids', async () => {
    mockGetUserList.mockResolvedValue([
      { id: 'user_1', fullName: 'One' },
      { id: 'user_2', fullName: 'Two' },
    ])
    mockGetOrganizationList.mockResolvedValue({
      data: [
        { id: 'org_a', name: 'Alpha', membersCount: 4 },
        { id: 'org_b', name: 'Beta', members_count: 2 },
      ],
    })
    mockGetInstanceMembershipList.mockResolvedValue({
      data: [membership('user_1', 'org_a'), membership('user_1', 'org_b')],
    })

    const snapshot = await fetchClerkSnapshot({ secretKey })

    expect(snapshot.groups).toEqual([
      { id: 'org_a', name: 'Alpha', memberCount: 4 },
      { id: 'org_b', name: 'Beta', memberCount: 2 },
    ])
    expect(snapshot.memberships).toEqual({ user_1: ['org_a', 'org_b'] })
  })

  it("de-duplicates a user's organizations and skips a membership with no user or organization", async () => {
    mockGetUserList.mockResolvedValue([{ id: 'user_1' }])
    mockGetInstanceMembershipList.mockResolvedValue({
      data: [
        membership('user_1', 'org_a'),
        membership('user_1', 'org_a'),
        membership('user_2', 'org_a'),
        { organization: { id: 'org_b' } },
        { organization: { id: 'org_c' }, publicUserData: {} },
        { publicUserData: { userId: 'user_3' } },
      ],
    })

    const snapshot = await fetchClerkSnapshot({ secretKey })

    expect(snapshot.memberships).toEqual({ user_1: ['org_a'], user_2: ['org_a'] })
  })

  it('pages the instance membership list until a short page, oldest first', async () => {
    mockGetUserList.mockResolvedValue([{ id: 'user_1' }])
    const full = Array.from({ length: 500 }, (_, i) => membership(`user_${i}`, 'org_a'))
    mockGetInstanceMembershipList
      .mockResolvedValueOnce({ data: full })
      .mockResolvedValueOnce({ data: [membership('user_last', 'org_b')] })

    const snapshot = await fetchClerkSnapshot({ secretKey })

    expect(mockGetInstanceMembershipList).toHaveBeenCalledTimes(2)
    expect(mockGetInstanceMembershipList).toHaveBeenNthCalledWith(1, {
      limit: 500,
      offset: 0,
      orderBy: '+created_at',
    })
    expect(mockGetInstanceMembershipList).toHaveBeenNthCalledWith(2, {
      limit: 500,
      offset: 500,
      orderBy: '+created_at',
    })
    expect(Object.keys(snapshot.memberships)).toHaveLength(501)
    expect(snapshot.memberships.user_last).toEqual(['org_b'])
  })

  it('pages the organization list at 500', async () => {
    mockGetUserList.mockResolvedValue([{ id: 'user_1' }])
    mockGetOrganizationList
      .mockResolvedValueOnce({
        data: Array.from({ length: 500 }, (_, i) => ({ id: `org_${i}`, name: `O${i}` })),
      })
      .mockResolvedValueOnce({ data: [{ id: 'org_last', name: 'Last' }] })

    const snapshot = await fetchClerkSnapshot({ secretKey })

    expect(snapshot.groups).toHaveLength(501)
    expect(mockGetOrganizationList).toHaveBeenNthCalledWith(1, { limit: 500, offset: 0 })
    expect(mockGetOrganizationList).toHaveBeenNthCalledWith(2, { limit: 500, offset: 500 })
  })

  it('never fetches memberships per user', async () => {
    mockGetUserList.mockResolvedValue([{ id: 'user_1' }, { id: 'user_2' }])

    await fetchClerkSnapshot({ secretKey })

    expect(mockGetUserMembershipList).not.toHaveBeenCalled()
  })

  it('does not fetch organizations when they are not groups', async () => {
    mockGetUserList.mockResolvedValue([{ id: 'user_1' }])

    const snapshot = await fetchClerkSnapshot({ secretKey, useOrganizationsAsGroups: false })

    expect(snapshot.groups).toEqual([])
    expect(snapshot.memberships).toEqual({})
    expect(mockGetOrganizationList).not.toHaveBeenCalled()
    expect(mockGetInstanceMembershipList).not.toHaveBeenCalled()
  })

  describe('when Clerk refuses the Organizations API', () => {
    const users = [{ id: 'user_1', fullName: 'One' }]

    it('keeps the users, writes no groups and warns once on a 403 from the organization list', async () => {
      mockGetUserList.mockResolvedValue(users)
      mockGetOrganizationList.mockRejectedValue(clerkError(403))
      const warn = vi.fn()

      const snapshot = await fetchClerkSnapshot({ secretKey, warn })

      expect(snapshot.users.map((u) => u.id)).toEqual(['user_1'])
      expect(snapshot.groups).toEqual([])
      expect(snapshot.memberships).toEqual({})
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain('403')
      expect(String(warn.mock.calls[0][0])).toContain('Organizations')
      expect(String(warn.mock.calls[0][0])).not.toContain(secretKey)
    })

    it('does the same on a 403 from the membership list, dropping the groups it fetched', async () => {
      mockGetUserList.mockResolvedValue(users)
      mockGetOrganizationList.mockResolvedValue({ data: [{ id: 'org_a', name: 'Alpha' }] })
      mockGetInstanceMembershipList.mockRejectedValue(clerkError(403))
      const warn = vi.fn()

      const snapshot = await fetchClerkSnapshot({ secretKey, warn })

      expect(snapshot.users).toHaveLength(1)
      expect(snapshot.groups).toEqual([])
      expect(snapshot.memberships).toEqual({})
      expect(warn).toHaveBeenCalledTimes(1)
    })

    it('names the Clerk error code in the warning', async () => {
      mockGetUserList.mockResolvedValue(users)
      mockGetOrganizationList.mockRejectedValue(clerkError(403, 'organizations_disabled'))
      const warn = vi.fn()

      await fetchClerkSnapshot({ secretKey, warn })

      expect(String(warn.mock.calls[0][0])).toContain('organizations_disabled')
    })

    it.each([
      [401, 'organization list'],
      [404, 'organization list'],
      [429, 'organization list'],
      [500, 'organization list'],
      [401, 'membership list'],
      [500, 'membership list'],
    ])('rethrows a %i from the %s', async (status, which) => {
      mockGetUserList.mockResolvedValue(users)
      const failure = clerkError(status)
      if (which === 'organization list') mockGetOrganizationList.mockRejectedValue(failure)
      else mockGetInstanceMembershipList.mockRejectedValue(failure)
      const warn = vi.fn()

      await expect(fetchClerkSnapshot({ secretKey, warn })).rejects.toBe(failure)
      expect(warn).not.toHaveBeenCalled()
    })

    it('rethrows an error with no status', async () => {
      mockGetUserList.mockResolvedValue(users)
      mockGetOrganizationList.mockRejectedValue(new Error('socket hang up'))

      await expect(fetchClerkSnapshot({ secretKey, warn: vi.fn() })).rejects.toThrow(
        'socket hang up',
      )
    })

    it('does not absorb a 403 from the user list', async () => {
      const failure = clerkError(403)
      mockGetUserList.mockRejectedValue(failure)

      await expect(fetchClerkSnapshot({ secretKey, warn: vi.fn() })).rejects.toBe(failure)
      expect(mockGetOrganizationList).not.toHaveBeenCalled()
    })
  })
})

describe('refreshClerkCache', () => {
  let cachePath: string

  beforeEach(async () => {
    cachePath = await fs.mkdtemp(path.join(os.tmpdir(), 'clerk-cache-writer-'))
  })

  afterEach(async () => {
    await fs.rm(cachePath, { recursive: true, force: true })
  })

  it('writes files FileBasedAuthCache reads back and returns the counts', async () => {
    mockGetUserList.mockResolvedValue({
      data: [
        { id: 'user_1', fullName: 'One', primaryEmailAddress: { emailAddress: 'one@test.com' } },
        { id: 'user_2', fullName: 'Two' },
      ],
    })
    mockGetOrganizationList.mockResolvedValue({
      data: [{ id: 'org_a', name: 'Alpha', membersCount: 1 }],
    })
    mockGetInstanceMembershipList.mockResolvedValue({ data: [membership('user_1', 'org_a')] })

    const result = await refreshClerkCache({ secretKey, cachePath })

    expect(result).toEqual({ userCount: 2, groupCount: 1, membershipCount: 1 })
    const cache = new FileBasedAuthCache(cachePath)
    expect((await cache.getAllUsers()).map((u) => u.id)).toEqual(['user_1', 'user_2'])
    expect(await cache.getUser('user_1')).toMatchObject({ name: 'One', email: 'one@test.com' })
    expect(await cache.getAllGroups()).toEqual([{ id: 'org_a', name: 'Alpha', memberCount: 1 }])
    expect(await cache.getUserExternalGroups('user_1')).toEqual(['org_a'])
    expect(await cache.getUserExternalGroups('user_2')).toEqual([])
  })

  it('writes the users with no groups when Clerk refuses the Organizations API', async () => {
    mockGetUserList.mockResolvedValue({ data: [{ id: 'user_1', fullName: 'One' }] })
    mockGetOrganizationList.mockRejectedValue(clerkError(403))

    const result = await refreshClerkCache({ secretKey, cachePath, warn: vi.fn() })

    expect(result).toEqual({ userCount: 1, groupCount: 0, membershipCount: 0 })
    const cache = new FileBasedAuthCache(cachePath)
    expect((await cache.getAllUsers()).map((u) => u.id)).toEqual(['user_1'])
    expect(await cache.getAllGroups()).toEqual([])
    expect(await cache.getUserExternalGroups('user_1')).toEqual([])
  })
})
