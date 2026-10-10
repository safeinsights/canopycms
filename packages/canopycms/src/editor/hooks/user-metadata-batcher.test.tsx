import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { SWRConfig } from 'swr'
import { GroupManager } from '../GroupManager'
import { UserBadge } from '../components/UserBadge'
import { createUserMetadataBatcher } from './user-metadata-batcher'
import type { ApiClient } from '../context'
import type { InternalGroup } from '../../authorization'
import type { UserSearchResult } from '../../auth/types'
import { MAX_USER_METADATA_BATCH } from '../../api/users-constants'
import {
  createMockApiClient,
  mockError,
  mockSuccess,
  type MockApiClient,
} from '../../api/__test__/mock-client'
import { mockConsole } from '../../test-utils/console-spy'

beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList) as typeof window.matchMedia
  }
  if (!window.ResizeObserver) {
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    ;(window as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
      ResizeObserver as typeof ResizeObserver
  }
})

afterEach(() => cleanup())

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 2000 }}>
    <MantineProvider>{children}</MantineProvider>
  </SWRConfig>
)

const userFor = (id: string): UserSearchResult => ({
  id,
  name: `Name of ${id}`,
  email: `${id}@example.com`,
})

/** A mock client whose batch endpoint knows every id except those starting `ghost-`. */
function mockClientKnowingUsers(): MockApiClient {
  const client = createMockApiClient()
  client.permissions.batchGetUserMetadata.mockImplementation(async ({ userIds }) =>
    mockSuccess({ users: userIds.filter((id) => !id.startsWith('ghost-')).map(userFor) }),
  )
  return client
}

const asApiClient = (client: MockApiClient) => client as unknown as ApiClient

const requestedIdCounts = (client: MockApiClient) =>
  client.permissions.batchGetUserMetadata.mock.calls.map(([body]) => body.userIds.length)

describe('user metadata batching', () => {
  it('renders a groups panel of N members with one batch request and no single lookups', async () => {
    const client = mockClientKnowingUsers()
    const members = Array.from({ length: 30 }, (_, i) => `user-${i}`)
    const groups: InternalGroup[] = [
      { id: 'a', name: 'A', members: members.slice(0, 20) },
      // user-10..19 sit in both groups, so they render twice.
      { id: 'b', name: 'B', members: members.slice(10) },
    ]

    render(
      <GroupManager
        internalGroups={groups}
        canEdit={true}
        onGetUserMetadata={createUserMetadataBatcher(asApiClient(client))}
      />,
      { wrapper },
    )

    expect(await screen.findAllByText('Name of user-29')).toHaveLength(1)
    expect(screen.getAllByText('Name of user-15')).toHaveLength(2)
    expect(client.permissions.batchGetUserMetadata).toHaveBeenCalledTimes(1)
    // Each badge's SWR key dedupes, so the shared members are asked for once.
    const [{ userIds }] = client.permissions.batchGetUserMetadata.mock.calls[0]
    expect([...userIds].sort()).toEqual([...members].sort())
    expect(client.permissions.getUserMetadata).not.toHaveBeenCalled()
  })

  it('splits a panel larger than the batch cap into ceil(N / cap) requests', async () => {
    const client = mockClientKnowingUsers()
    const n = MAX_USER_METADATA_BATCH * 2 + 50
    const members = Array.from({ length: n }, (_, i) => `user-${i}`)

    render(
      <GroupManager
        internalGroups={[{ id: 'big', name: 'Big', members }]}
        canEdit={true}
        onGetUserMetadata={createUserMetadataBatcher(asApiClient(client))}
      />,
      { wrapper },
    )

    await screen.findByText(`Name of user-${n - 1}`)
    expect(requestedIdCounts(client)).toEqual([
      MAX_USER_METADATA_BATCH,
      MAX_USER_METADATA_BATCH,
      50,
    ])
  })

  it('shows an id the server does not know as not found', async () => {
    const client = mockClientKnowingUsers()
    const getUserMetadata = createUserMetadataBatcher(asApiClient(client))

    render(
      <>
        <UserBadge userId="user-1" getUserMetadata={getUserMetadata} />
        <UserBadge userId="ghost-1" getUserMetadata={getUserMetadata} />
      </>,
      { wrapper },
    )

    await screen.findByText('Name of user-1')
    expect(screen.getByText('ghost-1')).toBeTruthy()
    expect(client.permissions.batchGetUserMetadata).toHaveBeenCalledTimes(1)
  })

  it('resolves every id in a failed request to null rather than rejecting', async () => {
    const client = createMockApiClient()
    client.permissions.batchGetUserMetadata
      .mockResolvedValueOnce(mockError(403, 'Forbidden'))
      .mockRejectedValueOnce(new Error('offline'))
    const getUserMetadata = createUserMetadataBatcher(asApiClient(client))
    const consoleSpy = mockConsole()

    await expect(Promise.all([getUserMetadata('a'), getUserMetadata('b')])).resolves.toEqual([
      null,
      null,
    ])
    await expect(getUserMetadata('c')).resolves.toBeNull()
    expect(consoleSpy).toHaveErrored('Batch get user metadata failed')
    consoleSpy.restore()
  })
})
