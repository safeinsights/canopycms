/**
 * A branch create the server never answers in time (create-branch-request.ts), through the
 * hook: the editor ends up on the branch when it was created after all, and otherwise says
 * plainly what happened.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { notifications } from '@mantine/notifications'

import type { MockApiClient } from '../../api/__test__/mock-client'
import { CanopyApiClient } from '../../api/client'
import { CREATE_BRANCH_DEADLINE_MS, CREATE_TIMED_OUT_MESSAGE } from './create-branch-request'
import { useBranchActions } from './useBranchActions'
import {
  createApiClientWrapper,
  setupMockApiClient,
  setupMockHistory,
  setupMockLocation,
} from './__test__/test-utils'

vi.mock('../../api', async () => {
  const actual = await vi.importActual('../../api')
  return { ...actual, createApiClient: vi.fn() }
})

vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }))

vi.mock('@mantine/modals', () => ({ modals: { openConfirmModal: vi.fn() } }))

const listedBranch = {
  name: 'feature-x',
  status: 'editing' as const,
  access: {},
  createdBy: 'user1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

describe('useBranchActions create past the deadline', () => {
  let mockClient: MockApiClient
  const options = {
    branchName: 'main',
    setBranchName: vi.fn(),
    isAnyDirty: () => false,
    onReloadBranches: vi.fn().mockResolvedValue(undefined),
    onBranchCreated: vi.fn(),
    onBranchSwitch: vi.fn(),
    userId: 'user1',
  }

  beforeEach(async () => {
    vi.useFakeTimers({ now: Date.parse(listedBranch.createdAt) })
    mockClient = await setupMockApiClient()
    setupMockLocation()
    setupMockHistory()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  async function createAfterDeadline(): Promise<boolean | undefined> {
    const { result } = renderHook(() => useBranchActions(options), {
      wrapper: createApiClientWrapper(mockClient),
    })
    let created: boolean | undefined
    await act(async () => {
      const pending = result.current.handleCreateBranch({ name: 'feature/x' })
      await vi.advanceTimersByTimeAsync(CREATE_BRANCH_DEADLINE_MS)
      created = await pending
    })
    return created
  }

  it('switches to the branch when the list shows it was created', async () => {
    mockClient.branches.create.mockReturnValue(new Promise(() => {}))
    mockClient.branches.list.mockResolvedValue({
      ok: true,
      status: 200,
      data: { branches: [listedBranch] },
    })

    expect(await createAfterDeadline()).toBe(true)
    expect(options.onBranchCreated).toHaveBeenCalledWith(listedBranch)
    expect(options.setBranchName).toHaveBeenCalledWith('feature-x')
    expect(options.onBranchSwitch).toHaveBeenCalledWith('feature-x')
  })

  it("stays put and reports a conflict when the listed branch is another user's", async () => {
    mockClient.branches.create.mockReturnValue(new Promise(() => {}))
    mockClient.branches.list.mockResolvedValue({
      ok: true,
      status: 200,
      data: { branches: [{ ...listedBranch, createdBy: 'someone-else' }] },
    })

    expect(await createAfterDeadline()).toBe(false)
    expect(notifications.show).toHaveBeenCalledWith({
      message: 'A branch named "feature-x" already exists',
      color: 'red',
    })
    expect(options.onBranchCreated).not.toHaveBeenCalled()
    expect(options.setBranchName).not.toHaveBeenCalled()
    expect(options.onBranchSwitch).not.toHaveBeenCalled()
  })

  it('says the create did not finish when the branch is not there', async () => {
    mockClient.branches.create.mockReturnValue(new Promise(() => {}))
    mockClient.branches.list.mockResolvedValue({ ok: true, status: 200, data: { branches: [] } })

    expect(await createAfterDeadline()).toBe(false)
    expect(notifications.show).toHaveBeenCalledWith({
      message: CREATE_TIMED_OUT_MESSAGE,
      color: 'red',
    })
    expect(options.setBranchName).not.toHaveBeenCalled()
  })

  it('looks for the branch after a gateway timeout page and switches to it', async () => {
    const gateway = new CanopyApiClient({
      fetch: vi.fn().mockResolvedValue({
        ok: false,
        status: 504,
        headers: new Headers(),
        json: async () => {
          throw new SyntaxError('Unexpected token <')
        },
      }),
    })
    mockClient.branches.create.mockResolvedValue(
      await gateway.branches.create({ branch: 'feature/x' }),
    )
    mockClient.branches.list.mockResolvedValue({
      ok: true,
      status: 200,
      data: { branches: [listedBranch] },
    })

    expect(await createAfterDeadline()).toBe(true)
    expect(mockClient.branches.list).toHaveBeenCalledTimes(1)
    expect(options.setBranchName).toHaveBeenCalledWith('feature-x')
  })
})
