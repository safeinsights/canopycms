import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MockApiClient } from '../../api/__test__/mock-client'
import { mockSuccess } from '../../api/__test__/mock-client'
import { setupMockApiClient, createApiClientWrapper } from '../hooks/__test__/test-utils'
import { CanopyCMSProvider } from '../theme'
import { SystemHealthPanel } from './SystemHealthPanel'
import type { AdminStatusData, AdminTasksData } from '../../api/admin'
import type { Task } from '../../task-queue'
import type { BranchHealthEntry } from '../../branch-health'

// Mock the API client module (both useApiClient() and useSystemHealth() must
// resolve to the same mock client instance) -- same pattern as
// media/MediaLibrary.test.tsx.
vi.mock('../../api', async () => {
  const actual = await vi.importActual('../../api')
  return {
    ...actual,
    createApiClient: vi.fn(),
  }
})

// Auto-confirm modals -- mirrors MediaLibrary.test.tsx / useBranchManager.test.tsx.
vi.mock('@mantine/modals', () => ({
  ModalsProvider: ({ children }: { children: React.ReactNode }) => children,
  modals: {
    openConfirmModal: vi.fn((options: { onConfirm?: () => void }) => {
      options.onConfirm?.()
    }),
  },
}))

function makeStatus(overrides: Partial<AdminStatusData> = {}): AdminStatusData {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: 'prod',
    queue: { pending: 0, processing: 0, completed: 0, failed: 0, corrupt: 0 },
    worker: { state: 'alive' },
    workerStatus: null,
    ...overrides,
  }
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    action: 'sync',
    payload: {},
    status: 'failed',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/** Text content of the last modals.openConfirmModal() call's `children` prop. */
async function lastConfirmText(): Promise<string> {
  const { modals } = await import('@mantine/modals')
  const call = vi.mocked(modals.openConfirmModal).mock.calls.at(-1)
  const children = call?.[0]?.children as React.ReactElement<{ children: string }> | undefined
  return children?.props.children ?? ''
}

describe('SystemHealthPanel', () => {
  let mockClient: MockApiClient
  let wrapper: ReturnType<typeof createApiClientWrapper>

  beforeEach(async () => {
    mockClient = await setupMockApiClient()
    wrapper = createApiClientWrapper(mockClient)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  const renderPanel = (onClose = vi.fn()) => {
    const Wrapper = wrapper
    return render(
      <CanopyCMSProvider>
        <Wrapper>
          <SystemHealthPanel opened onClose={onClose} />
        </Wrapper>
      </CanopyCMSProvider>,
    )
  }

  describe('Overview tab', () => {
    it('renders all three tabs and the worker liveness badge from status', async () => {
      mockClient.admin.status.mockResolvedValueOnce(
        mockSuccess(makeStatus({ worker: { state: 'stale' } })),
      )

      renderPanel()

      expect(screen.getByText('Overview')).toBeTruthy()
      expect(screen.getByText('Tasks')).toBeTruthy()
      expect(screen.getByText('Branches')).toBeTruthy()
      await waitFor(() => expect(screen.getByText('Worker: stale (possible crash)')).toBeTruthy())
    })

    it('shows a muted dev-mode note instead of alarming colors', async () => {
      mockClient.admin.status.mockResolvedValueOnce(
        mockSuccess(makeStatus({ mode: 'dev', worker: { state: 'absent' } })),
      )

      renderPanel()

      await waitFor(() => expect(screen.getByText('No worker runs in dev mode')).toBeTruthy())
    })

    it('shows the crash-loop alert for a recent lastFatalError even when liveness is alive', async () => {
      mockClient.admin.status.mockResolvedValueOnce(
        mockSuccess(
          makeStatus({
            worker: { state: 'alive' },
            workerStatus: {
              version: 1,
              startedAt: '2026-01-01T00:00:00.000Z',
              updatedAt: new Date().toISOString(),
              lastFatalError: {
                message: 'Worker crashed on boot',
                at: new Date().toISOString(),
                phase: 'startup',
              },
            },
          }),
        ),
      )

      renderPanel()

      await waitFor(() => expect(screen.getByText('Worker: alive')).toBeTruthy())
      expect(screen.getByText('Worker crash detected')).toBeTruthy()
      expect(screen.getByText('Worker crashed on boot')).toBeTruthy()
    })
  })

  describe('Tasks tab', () => {
    const failedTask = makeTask({ id: 'task-failed-1', status: 'failed', error: 'boom' })
    const pendingTask = makeTask({ id: 'task-pending-1', status: 'pending', action: 'publish' })

    beforeEach(() => {
      mockClient.admin.listTasks.mockImplementation(async (params: Record<string, string>) => {
        if (params.status === 'failed') {
          const data: AdminTasksData = { tasks: [failedTask] }
          return mockSuccess(data)
        }
        if (params.status === 'pending') {
          const data: AdminTasksData = { tasks: [pendingTask] }
          return mockSuccess(data)
        }
        return mockSuccess({ tasks: [] } satisfies AdminTasksData)
      })
    })

    it('defaults to the failed status and retry requeues the task after confirming', async () => {
      renderPanel()
      await userEvent.click(screen.getByText('Tasks'))

      await waitFor(() =>
        expect(mockClient.admin.listTasks).toHaveBeenCalledWith({ status: 'failed' }),
      )
      const retryButton = await screen.findByTestId(`retry-task-${failedTask.id}`)

      await userEvent.click(retryButton)

      expect(await lastConfirmText()).toContain('duplicate work')
      await waitFor(() =>
        expect(mockClient.admin.retryTask).toHaveBeenCalledWith({ taskId: failedTask.id }),
      )
    })

    it('delete from pending warns that the task may already be running', async () => {
      renderPanel()
      await userEvent.click(screen.getByText('Tasks'))
      await userEvent.click(screen.getByText('Pending'))

      const deleteButton = await screen.findByTestId(`delete-task-${pendingTask.id}`)
      await userEvent.click(deleteButton)

      expect(await lastConfirmText()).toContain('does not guarantee it never runs')
      await waitFor(() =>
        expect(mockClient.admin.deleteTask).toHaveBeenCalledWith({
          status: 'pending',
          fileName: `${pendingTask.id}.json`,
        }),
      )
    })
  })

  describe('Branches tab', () => {
    const editingWithRebaseFailure: BranchHealthEntry = {
      dirName: 'feature-a',
      kind: 'healthy',
      branch: {
        name: 'feature-a',
        status: 'editing',
        access: {},
        createdBy: 'user-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        rebaseFailure: {
          message: 'merge conflict',
          firstAt: '2026-01-01T00:00:00.000Z',
          lastAt: '2026-01-02T00:00:00.000Z',
        },
      },
    }
    const submittedWithStaleRebaseFailure: BranchHealthEntry = {
      dirName: 'feature-b',
      kind: 'healthy',
      branch: {
        name: 'feature-b',
        status: 'submitted',
        access: {},
        createdBy: 'user-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        pullRequestNumber: 42,
        pullRequestUrl: 'https://github.com/org/repo/pull/42',
        pullRequestState: 'open',
        // Stale record: real branch was resubmitted/cleared server-side, but
        // the panel still belt-and-suspenders suppresses the icon here.
        rebaseFailure: {
          message: 'stale',
          firstAt: '2026-01-01T00:00:00.000Z',
          lastAt: '2026-01-01T00:00:00.000Z',
        },
      },
    }
    const lockedWithRebaseFailure: BranchHealthEntry = {
      dirName: 'feature-c',
      kind: 'healthy',
      branch: {
        name: 'feature-c',
        status: 'locked',
        access: {},
        createdBy: 'user-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        // [LOW-3] The worker still rebases locked branches, so a locked
        // branch failing to rebase must surface the icon just like editing.
        rebaseFailure: {
          message: 'merge conflict',
          firstAt: '2026-01-01T00:00:00.000Z',
          lastAt: '2026-01-02T00:00:00.000Z',
        },
      },
    }
    const corruptEntry: BranchHealthEntry = {
      dirName: 'broken-branch',
      kind: 'corrupt-metadata',
      parseError: 'Unexpected token in JSON',
    }
    const corruptWithFreshLock: BranchHealthEntry = {
      dirName: 'broken-locked',
      kind: 'corrupt-metadata',
      parseError: 'Unexpected token in JSON',
      provisioningLock: { mtime: '2026-01-01T00:00:00.000Z', ageMs: 60_000 },
    }
    const baseBranchCorrupt: BranchHealthEntry = {
      dirName: 'main',
      kind: 'corrupt-metadata',
      isBaseBranch: true,
      parseError: 'Unexpected token in JSON',
    }
    const youngOrphan: BranchHealthEntry = {
      dirName: 'orphan-young',
      kind: 'orphan',
      hasGitDir: false,
      ageMs: 60_000,
    }
    const oldOrphan: BranchHealthEntry = {
      dirName: 'orphan-old',
      kind: 'orphan',
      hasGitDir: true,
      ageMs: 20 * 60_000,
    }
    const baseBranchOrphan: BranchHealthEntry = {
      dirName: 'main-orphan',
      kind: 'orphan',
      isBaseBranch: true,
      hasGitDir: false,
      ageMs: 20 * 60_000,
    }

    beforeEach(() => {
      mockClient.admin.branchHealth.mockResolvedValue(
        mockSuccess({
          entries: [
            editingWithRebaseFailure,
            submittedWithStaleRebaseFailure,
            lockedWithRebaseFailure,
            corruptEntry,
            corruptWithFreshLock,
            baseBranchCorrupt,
            youngOrphan,
            oldOrphan,
            baseBranchOrphan,
          ],
          generatedAt: '2026-01-01T00:00:00.000Z',
        }),
      )
    })

    it('renders healthy, corrupt-metadata, and orphan rows', async () => {
      renderPanel()
      await userEvent.click(screen.getByText('Branches'))

      await waitFor(() => expect(screen.getByText('feature-a')).toBeTruthy())
      expect(screen.getByText('feature-b')).toBeTruthy()
      expect(screen.getByText('broken-branch')).toBeTruthy()
      // Multiple corrupt-metadata fixtures are seeded in this describe block
      // (broken-branch, broken-locked, main) -- assert count, not identity.
      expect(screen.getAllByText('corrupt metadata').length).toBeGreaterThanOrEqual(1)
      expect(screen.getByText('orphan-young')).toBeTruthy()
      expect(screen.getByText('orphan-old')).toBeTruthy()
    })

    it('shows Mark merged only for submitted/approved branches with a PR, and confirms the prod verification gap', async () => {
      renderPanel()
      await userEvent.click(screen.getByText('Branches'))
      await waitFor(() => expect(screen.getByText('feature-a')).toBeTruthy())

      expect(screen.queryByTestId('mark-merged-feature-a')).toBeNull()
      const markMergedButton = screen.getByTestId('mark-merged-feature-b')
      expect(markMergedButton).toBeTruthy()

      await userEvent.click(markMergedButton)
      expect(await lastConfirmText()).toContain('cannot verify the PR actually merged')
      await waitFor(() =>
        expect(mockClient.workflow.markMerged).toHaveBeenCalledWith({ branch: 'feature-b' }),
      )
    })

    it('shows the rebaseFailure icon for editing and locked branches, suppresses it for submitted (LOW-3)', async () => {
      renderPanel()
      await userEvent.click(screen.getByText('Branches'))
      await waitFor(() => expect(screen.getByText('feature-a')).toBeTruthy())

      expect(screen.getByTestId('rebase-failure-feature-a')).toBeTruthy() // editing
      expect(screen.getByTestId('rebase-failure-feature-c')).toBeTruthy() // locked
      expect(screen.queryByTestId('rebase-failure-feature-b')).toBeNull() // submitted
    })

    it('disables purge for a young orphan and confirms the 30-day trash retention for an old one', async () => {
      renderPanel()
      await userEvent.click(screen.getByText('Branches'))
      await waitFor(() => expect(screen.getByText('orphan-young')).toBeTruthy())

      const youngPurgeButton = screen.getByTestId('purge-dir-orphan-young')
      expect(youngPurgeButton).toHaveProperty('disabled', true)

      const oldPurgeButton = screen.getByTestId('purge-dir-orphan-old')
      expect(oldPurgeButton).toHaveProperty('disabled', false)

      await userEvent.click(oldPurgeButton)
      expect(await lastConfirmText()).toContain('30 days')
      await waitFor(() =>
        expect(mockClient.admin.purgeBranchDir).toHaveBeenCalledWith({ dirName: 'orphan-old' }),
      )
    })

    it('disables purge for a corrupt-metadata row while its provisioning lock is fresh (LOW-2)', async () => {
      renderPanel()
      await userEvent.click(screen.getByText('Branches'))
      await waitFor(() => expect(screen.getByText('broken-branch')).toBeTruthy())

      expect(screen.getByTestId('purge-dir-broken-branch')).toHaveProperty('disabled', false)
      expect(screen.getByTestId('purge-dir-broken-locked')).toHaveProperty('disabled', true)
    })

    it('disables purge for the base branch even when corrupt or orphaned (LOW-2)', async () => {
      renderPanel()
      await userEvent.click(screen.getByText('Branches'))
      await waitFor(() => expect(screen.getByText('main')).toBeTruthy())

      const corruptBasePurge = screen.getByTestId('purge-dir-main')
      expect(corruptBasePurge).toHaveProperty('disabled', true)

      const orphanBasePurge = screen.getByTestId('purge-dir-main-orphan')
      expect(orphanBasePurge).toHaveProperty('disabled', true)
    })
  })
})
