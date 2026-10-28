/**
 * The Clerk refresher over the REAL `fetchClerkSnapshot`, with only `@clerk/backend` mocked:
 * `clerk-refresh.test.ts` mocks the cache writer whole, so it cannot see whether a refusal
 * absorbed inside the fetch ever reaches the key re-read gate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { getUserList, getOrganizationList, getInstanceOrganizationMembershipList } = vi.hoisted(
  () => ({
    getUserList: vi.fn(),
    getOrganizationList: vi.fn(),
    getInstanceOrganizationMembershipList: vi.fn(),
  }),
)

// The copy canopycms-auth-clerk resolves: this package does not depend on `@clerk/backend` itself.
vi.mock('../../canopycms-auth-clerk/node_modules/@clerk/backend', () => ({
  createClerkClient: vi.fn(() => ({
    users: { getUserList },
    organizations: { getOrganizationList, getInstanceOrganizationMembershipList },
  })),
}))

import { createClerkSnapshotFetcher } from './clerk-refresh'
import type { ReactiveSecret } from './credential-refresh'

function fakeSecret(initial: string, rotated: string) {
  const refresh = vi.fn(async () => rotated)
  return { current: () => initial, refresh } satisfies ReactiveSecret
}

const forbidden = () => Object.assign(new Error('Forbidden'), { status: 403 })

beforeEach(() => {
  vi.resetAllMocks()
  getUserList.mockResolvedValue({ data: [{ id: 'user_1', fullName: 'One' }] })
})

describe('createClerkSnapshotFetcher over the real snapshot fetch', () => {
  it('keeps the users and does not re-read the key when Clerk refuses the Organizations API', async () => {
    getOrganizationList.mockRejectedValue(forbidden())
    const secret = fakeSecret('sk_live_good', 'sk_live_other')
    const log = { warn: vi.fn(), error: vi.fn() }
    const fetcher = createClerkSnapshotFetcher({ secret, useOrganizationsAsGroups: true, log })!

    const snapshot = await fetcher()

    expect(snapshot.users.map((u) => u.id)).toEqual(['user_1'])
    expect(snapshot.groups).toEqual([])
    expect(snapshot.memberships).toEqual({})
    expect(secret.refresh).not.toHaveBeenCalled()
    expect(getUserList).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('re-reads the key when Clerk refuses the user list', async () => {
    getUserList.mockRejectedValueOnce(forbidden())
    getOrganizationList.mockResolvedValue({ data: [] })
    getInstanceOrganizationMembershipList.mockResolvedValue({ data: [] })
    const secret = fakeSecret('sk_live_good', 'sk_live_other')
    const log = { warn: vi.fn(), error: vi.fn() }
    const fetcher = createClerkSnapshotFetcher({ secret, useOrganizationsAsGroups: true, log })!

    await fetcher()

    expect(secret.refresh).toHaveBeenCalledTimes(1)
  })
})
