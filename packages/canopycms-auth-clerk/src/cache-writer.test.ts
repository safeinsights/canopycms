import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const mockGetUserList = vi.fn()
const mockGetOrganizationMembershipList = vi.fn()
const mockGetOrganizationList = vi.fn()

vi.mock('@clerk/backend', () => ({
  createClerkClient: vi.fn(() => ({
    users: {
      getUserList: mockGetUserList,
      getOrganizationMembershipList: mockGetOrganizationMembershipList,
    },
    organizations: { getOrganizationList: mockGetOrganizationList },
  })),
}))

import { FileBasedAuthCache } from 'canopycms/auth/cache'
import { fetchClerkSnapshot, refreshClerkCache } from './cache-writer'

const secretKey = 'sk_test_cache_writer'

function pageOfUsers(count: number, from: number) {
  return Array.from({ length: count }, (_, i) => ({ id: `user_${from + i}`, fullName: 'N' }))
}

beforeEach(() => {
  vi.resetAllMocks()
  mockGetOrganizationList.mockResolvedValue({ data: [] })
  mockGetOrganizationMembershipList.mockResolvedValue({ data: [] })
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
    mockGetOrganizationMembershipList.mockImplementation(async ({ userId }: { userId: string }) =>
      userId === 'user_1'
        ? { data: [{ organization: { id: 'org_a' } }, { organization: { id: 'org_b' } }] }
        : { data: [] },
    )

    const snapshot = await fetchClerkSnapshot({ secretKey })

    expect(snapshot.groups).toEqual([
      { id: 'org_a', name: 'Alpha', memberCount: 4 },
      { id: 'org_b', name: 'Beta', memberCount: 2 },
    ])
    expect(snapshot.memberships).toEqual({ user_1: ['org_a', 'org_b'] })
  })

  it('does not fetch organizations when they are not groups', async () => {
    mockGetUserList.mockResolvedValue([{ id: 'user_1' }])

    const snapshot = await fetchClerkSnapshot({ secretKey, useOrganizationsAsGroups: false })

    expect(snapshot.groups).toEqual([])
    expect(snapshot.memberships).toEqual({})
    expect(mockGetOrganizationList).not.toHaveBeenCalled()
    expect(mockGetOrganizationMembershipList).not.toHaveBeenCalled()
  })

  it('warns and continues when one user membership fetch fails', async () => {
    mockGetUserList.mockResolvedValue([{ id: 'user_bad' }, { id: 'user_good' }])
    mockGetOrganizationMembershipList.mockImplementation(async ({ userId }: { userId: string }) => {
      if (userId === 'user_bad') throw new Error('rate limited')
      return { data: [{ organization: { id: 'org_a' } }] }
    })
    const warn = vi.fn()

    const snapshot = await fetchClerkSnapshot({ secretKey, warn })

    expect(snapshot.memberships).toEqual({ user_good: ['org_a'] })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      'Failed to fetch memberships for user user_bad:',
      'rate limited',
    )
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
    mockGetOrganizationMembershipList.mockImplementation(async ({ userId }: { userId: string }) =>
      userId === 'user_1' ? { data: [{ organization: { id: 'org_a' } }] } : { data: [] },
    )

    const result = await refreshClerkCache({ secretKey, cachePath })

    expect(result).toEqual({ userCount: 2, groupCount: 1, membershipCount: 1 })
    const cache = new FileBasedAuthCache(cachePath)
    expect((await cache.getAllUsers()).map((u) => u.id)).toEqual(['user_1', 'user_2'])
    expect(await cache.getUser('user_1')).toMatchObject({ name: 'One', email: 'one@test.com' })
    expect(await cache.getAllGroups()).toEqual([{ id: 'org_a', name: 'Alpha', memberCount: 1 }])
    expect(await cache.getUserExternalGroups('user_1')).toEqual(['org_a'])
    expect(await cache.getUserExternalGroups('user_2')).toEqual([])
  })
})
