import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MockApiClient } from '../../api/__test__/mock-client'
import { mockSuccess } from '../../api/__test__/mock-client'
import { setupMockApiClient, createApiClientWrapper } from '../hooks/__test__/test-utils'
import { CanopyCMSProvider } from '../theme'
import { SystemHealthPanel } from './SystemHealthPanel'
import type { AdminStatusData, AdminTasksData } from '../../api/admin'
import type { Task } from '../../task-queue'
import type { BranchHealthEntry, DuplicateIdScan } from '../../branch-health'
import type { BranchHealthData } from '../../api/admin-branch-health'
import type {
  BaseRefreshReport,
  BaseSchemaHold,
  UnpublishableBranch,
  WorkerStatusReport,
} from '../../types'
import { unsafeAsContentId, unsafeAsPhysicalPath } from '../../paths/test-utils'
import { formatRelativeTime } from '../relative-time'

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
    build: { canopycmsVersion: '1.2.3', sourceRevision: 'abcdef0123456789abcdef' },
    assetStore: { configured: true },
    imageProcessing: { available: true },
    branchNamespace: { ok: true, namespace: 'canopycms/prod/' },
    ...overrides,
  }
}

/** A status whose last git sync carries `baseRefresh` (omitted when undefined). */
function makeStatusWithSync(baseRefresh?: BaseRefreshReport): AdminStatusData {
  const workerStatus: WorkerStatusReport = {
    version: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: new Date().toISOString(),
    lastGitSyncAt: '2026-01-01T00:25:54.000Z',
    lastGitSync: {
      durationMs: 1200,
      rebased: [],
      skippedDirty: baseRefresh?.outcome === 'skipped-dirty' ? ['main'] : [],
      failed: [],
      ...(baseRefresh ? { baseRefresh } : {}),
    },
  }
  return makeStatus({ workerStatus })
}

const dirtyBaseRefresh: BaseRefreshReport = {
  outcome: 'skipped-dirty',
  dirtyFiles: ['content/home.md'],
  message: '1 uncommitted tracked file(s) in the base branch workspace',
  trackedCanopyMeta: ['.canopy-meta/schema-cache.json'],
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

    describe('Build section', () => {
      /** A status whose worker reports `workerVersion` (omitted when undefined). */
      const statusWithWorkerVersion = (
        workerVersion: string | undefined,
        overrides: Partial<AdminStatusData> = {},
      ): AdminStatusData =>
        makeStatus({
          workerStatus: {
            version: 1,
            ...(workerVersion !== undefined ? { workerVersion } : {}),
            startedAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          ...overrides,
        })

      it('renders the API version, truncated source revision and worker version', async () => {
        mockClient.admin.status.mockResolvedValueOnce(mockSuccess(statusWithWorkerVersion('1.2.3')))

        renderPanel()

        await waitFor(() => expect(screen.getByTestId('build-api-version')).toBeTruthy())
        expect(screen.getByTestId('build-api-version').textContent).toContain('1.2.3')
        const revision = screen.getByTestId('build-source-revision').textContent
        expect(revision).toContain('abcdef012345')
        expect(revision).not.toContain('abcdef0123456')
        expect(screen.getByTestId('build-worker-version').textContent).toContain('1.2.3')
      })

      it('keeps "Worker: " unique to the liveness badge, which the e2e page object selects by it', async () => {
        mockClient.admin.status.mockResolvedValueOnce(mockSuccess(statusWithWorkerVersion('1.2.3')))

        renderPanel()

        await waitFor(() => expect(screen.getByTestId('build-worker-version')).toBeTruthy())
        expect(screen.getAllByText(/^Worker: /)).toHaveLength(1)
      })

      it('shows "not set" with the env var name when the source revision is absent', async () => {
        mockClient.admin.status.mockResolvedValueOnce(
          mockSuccess(makeStatus({ build: { canopycmsVersion: '1.2.3' } })),
        )

        renderPanel()

        await waitFor(() => expect(screen.getByTestId('build-source-revision')).toBeTruthy())
        const text = screen.getByTestId('build-source-revision').textContent ?? ''
        expect(text).toContain('not set')
        expect(text).toContain('CANOPY_SOURCE_SHA')
      })

      it('shows how the previous worker shut down, in orange when its drain hit the deadline', async () => {
        const base = statusWithWorkerVersion('1.2.3')
        mockClient.admin.status.mockResolvedValueOnce(
          mockSuccess({
            ...base,
            workerStatus: {
              ...base.workerStatus!,
              lastShutdown: {
                reason: 'ASG termination',
                at: '2026-01-01T00:00:00.000Z',
                workerStartedAt: '2025-12-31T00:00:00.000Z',
                outcome: 'deadline',
                drainMs: 90_000,
                abandoned: ['task queue'],
              },
            },
          }),
        )

        renderPanel()

        await waitFor(() => expect(screen.getByTestId('build-last-shutdown')).toBeTruthy())
        const text = screen.getByTestId('build-last-shutdown').textContent ?? ''
        expect(text).toContain('ASG termination')
        expect(text).toContain('drain deadline hit, aborted task queue')
      })

      it('says when the previous worker stopped without draining', async () => {
        const base = statusWithWorkerVersion('1.2.3')
        mockClient.admin.status.mockResolvedValueOnce(
          mockSuccess({
            ...base,
            workerStatus: {
              ...base.workerStatus!,
              lastShutdown: {
                reason: 'stopped without draining',
                at: '2026-01-01T00:00:00.000Z',
                workerStartedAt: '2025-12-31T00:00:00.000Z',
                outcome: 'not-drained',
              },
            },
          }),
        )

        renderPanel()

        await waitFor(() => expect(screen.getByTestId('build-last-shutdown')).toBeTruthy())
        const text = screen.getByTestId('build-last-shutdown').textContent ?? ''
        expect(text).toContain('stopped without draining')
        expect(text).toContain('a crash or a forced stop')
        expect(text).not.toContain('drained in')
      })

      it('shows the last drained shutdown and, separately, a failed start after it', async () => {
        const base = statusWithWorkerVersion('1.2.3')
        mockClient.admin.status.mockResolvedValueOnce(
          mockSuccess({
            ...base,
            workerStatus: {
              ...base.workerStatus!,
              lastShutdown: {
                reason: 'SIGTERM',
                at: '2026-01-01T00:00:00.000Z',
                workerStartedAt: '2025-12-31T00:00:00.000Z',
                outcome: 'drained',
                drainMs: 1_500,
              },
              lastFatalError: {
                message: 'clone failed',
                at: '2026-01-02T00:00:05.000Z',
                phase: 'startup',
              },
            },
          }),
        )

        renderPanel()

        await waitFor(() => expect(screen.getByTestId('build-last-shutdown')).toBeTruthy())
        const shutdown = screen.getByTestId('build-last-shutdown').textContent ?? ''
        expect(shutdown).toContain('SIGTERM at 2026-01-01T00:00:00.000Z')
        expect(shutdown).toContain('drained in 1.5s')
        expect(shutdown).not.toContain('a crash or a forced stop')
        expect(screen.getByTestId('build-failed-start').textContent).toBe(
          'Last start failed at 2026-01-02T00:00:05.000Z',
        )
      })

      it('shows no failed-start line for a failure while running', async () => {
        const base = statusWithWorkerVersion('1.2.3')
        mockClient.admin.status.mockResolvedValueOnce(
          mockSuccess({
            ...base,
            workerStatus: {
              ...base.workerStatus!,
              lastFatalError: {
                message: 'lost lock',
                at: '2026-01-02T00:00:05.000Z',
                phase: 'run',
              },
            },
          }),
        )

        renderPanel()

        await waitFor(() => expect(screen.getByTestId('build-worker-version')).toBeTruthy())
        expect(screen.queryByTestId('build-failed-start')).toBeNull()
      })

      it('shows no shutdown line when the status file has none', async () => {
        mockClient.admin.status.mockResolvedValueOnce(mockSuccess(statusWithWorkerVersion('1.2.3')))

        renderPanel()

        await waitFor(() => expect(screen.getByTestId('build-worker-version')).toBeTruthy())
        expect(screen.queryByTestId('build-last-shutdown')).toBeNull()
      })

      it('shows the worker version as unknown when the worker did not report one', async () => {
        mockClient.admin.status.mockResolvedValueOnce(
          mockSuccess(statusWithWorkerVersion(undefined)),
        )

        renderPanel()

        await waitFor(() => expect(screen.getByTestId('build-worker-version')).toBeTruthy())
        expect(screen.getByTestId('build-worker-version').textContent).toContain('unknown')
      })

      it('warns when the API and worker versions differ', async () => {
        mockClient.admin.status.mockResolvedValueOnce(mockSuccess(statusWithWorkerVersion('1.2.2')))

        renderPanel()

        await waitFor(() => expect(screen.getByTestId('version-skew-warning')).toBeTruthy())
        const text = screen.getByTestId('version-skew-warning').textContent ?? ''
        expect(text).toContain('API and worker versions differ')
        expect(text).toContain('1.2.3')
        expect(text).toContain('1.2.2')
      })

      it('does not warn when the API and worker versions match', async () => {
        mockClient.admin.status.mockResolvedValueOnce(mockSuccess(statusWithWorkerVersion('1.2.3')))

        renderPanel()

        await waitFor(() => expect(screen.getByTestId('build-worker-version')).toBeTruthy())
        expect(screen.queryByTestId('version-skew-warning')).toBeNull()
      })

      it('does not warn when the worker version is absent', async () => {
        mockClient.admin.status.mockResolvedValueOnce(
          mockSuccess(statusWithWorkerVersion(undefined)),
        )

        renderPanel()

        await waitFor(() => expect(screen.getByTestId('build-worker-version')).toBeTruthy())
        expect(screen.queryByTestId('version-skew-warning')).toBeNull()
      })

      it.each(['stale', 'absent'] as const)(
        'does not warn when the worker is %s, since its version is not a running build',
        async (state) => {
          mockClient.admin.status.mockResolvedValueOnce(
            mockSuccess(statusWithWorkerVersion('1.2.2', { worker: { state } })),
          )

          renderPanel()

          await waitFor(() => expect(screen.getByTestId('build-worker-version')).toBeTruthy())
          expect(screen.getByTestId('build-worker-version').textContent).toContain('1.2.2')
          expect(screen.queryByTestId('version-skew-warning')).toBeNull()
        },
      )

      it('treats an empty worker version as unknown, not as skew', async () => {
        mockClient.admin.status.mockResolvedValueOnce(mockSuccess(statusWithWorkerVersion('')))

        renderPanel()

        await waitFor(() => expect(screen.getByTestId('build-worker-version')).toBeTruthy())
        expect(screen.getByTestId('build-worker-version').textContent).toContain('unknown')
        expect(screen.queryByTestId('version-skew-warning')).toBeNull()
      })

      it('shows media storage as configured', async () => {
        mockClient.admin.status.mockResolvedValueOnce(mockSuccess(makeStatus()))

        renderPanel()

        await waitFor(() => expect(screen.getByTestId('build-media')).toBeTruthy())
        expect(screen.getByTestId('build-media').textContent).toContain('configured')
        expect(screen.getByTestId('build-media').textContent).not.toContain('not configured')
      })

      it('says uploads are disabled when media storage is not configured', async () => {
        mockClient.admin.status.mockResolvedValueOnce(
          mockSuccess(makeStatus({ assetStore: { configured: false } })),
        )

        renderPanel()

        await waitFor(() => expect(screen.getByTestId('build-media')).toBeTruthy())
        expect(screen.getByTestId('build-media').textContent).toContain(
          'not configured — uploads are disabled',
        )
      })

      it('shows image processing as available', async () => {
        mockClient.admin.status.mockResolvedValueOnce(mockSuccess(makeStatus()))

        renderPanel()

        await waitFor(() => expect(screen.getByTestId('build-image-processing')).toBeTruthy())
        expect(screen.getByTestId('build-image-processing').textContent).toBe(
          'Image processing: available',
        )
      })

      it('shows image processing as unavailable with the error text', async () => {
        mockClient.admin.status.mockResolvedValueOnce(
          mockSuccess(
            makeStatus({ imageProcessing: { available: false, error: 'libvips missing' } }),
          ),
        )

        renderPanel()

        await waitFor(() => expect(screen.getByTestId('build-image-processing')).toBeTruthy())
        const text = screen.getByTestId('build-image-processing').textContent
        expect(text).toContain('unavailable')
        expect(text).toContain('libvips missing')
        expect(text).not.toContain('Image processing: available')
      })
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
      expect(screen.getByText('The worker failed to start')).toBeTruthy()
      expect(screen.getByText('Worker crashed on boot')).toBeTruthy()
    })

    it('says the worker stopped while running for a failure after startup', async () => {
      mockClient.admin.status.mockResolvedValueOnce(
        mockSuccess(
          makeStatus({
            worker: { state: 'absent' },
            workerStatus: {
              version: 1,
              startedAt: '2026-01-01T00:00:00.000Z',
              updatedAt: new Date().toISOString(),
              lastFatalError: {
                message: 'The worker lost its lock on the shared workspace and stopped',
                at: new Date().toISOString(),
                phase: 'run',
              },
            },
          }),
        ),
      )

      renderPanel()

      await waitFor(() => expect(screen.getByText('The worker stopped while running')).toBeTruthy())
      expect(screen.queryByText('The worker failed to start')).toBeNull()
    })
  })

  describe('Overview tab: settings workspace', () => {
    it('alerts with the reason when the settings workspace cannot be provisioned', async () => {
      mockClient.admin.status.mockResolvedValueOnce(
        mockSuccess(makeStatus({ settingsWorkspaceError: 'settings branch shares no history' })),
      )

      renderPanel()

      await waitFor(() =>
        expect(
          screen.getByText('Settings workspace unavailable: groups and path rules are not loading'),
        ).toBeTruthy(),
      )
      expect(screen.getByText('settings branch shares no history')).toBeTruthy()
    })

    it('shows no settings alert while the settings workspace is healthy', async () => {
      mockClient.admin.status.mockResolvedValueOnce(mockSuccess(makeStatus()))

      renderPanel()

      await waitFor(() => expect(screen.getByText('Worker: alive')).toBeTruthy())
      expect(screen.queryByText(/Settings workspace unavailable/)).toBeNull()
    })
  })

  describe('Overview tab: schema issues', () => {
    it('lists each issue under a title naming the content types this editor does not know', async () => {
      mockClient.admin.status.mockResolvedValueOnce(
        mockSuccess(
          makeStatus({
            schemaIssues: [
              {
                kind: 'unknown-schema',
                collectionPath: 'widgets',
                entryType: 'widget',
                schemaRef: 'widgetSchema',
                metaFile: 'content/widgets/.collection.json',
                message: 'unused for this kind',
              },
              {
                kind: 'reference-entry-type',
                message:
                  'field "related" points at entry type "gadget", which no collection declares',
              },
            ],
          }),
        ),
      )

      renderPanel()

      const alert = await screen.findByTestId('schema-issues-alert')
      expect(alert.textContent).toContain("Content types this editor version doesn't know")
      expect(alert.textContent).toContain(
        'content/widgets/.collection.json names widgetSchema, so entry type widget is unavailable',
      )
      expect(alert.textContent).toContain(
        'field "related" points at entry type "gadget", which no collection declares',
      )
    })

    it('shows no schema alert when the status reports no issues', async () => {
      mockClient.admin.status.mockResolvedValueOnce(mockSuccess(makeStatus({ schemaIssues: [] })))

      renderPanel()

      await waitFor(() => expect(screen.getByText('Worker: alive')).toBeTruthy())
      expect(screen.queryByTestId('schema-issues-alert')).toBeNull()
    })
  })

  describe('Overview tab: base branch held for an editor deploy', () => {
    const hold: BaseSchemaHold = {
      since: '2026-01-01T00:20:00.000Z',
      firstSeen: {
        personSchema: '2026-01-01T00:20:00.000Z',
        teamSchema: '2026-01-01T00:22:00.000Z',
      },
      incomingSha: 'f00dfeed',
      missingSchemas: ['personSchema', 'teamSchema'],
      files: ['content/people/.collection.json'],
      fileCount: 1,
      editorBuild: { canopycmsVersion: '1.2.3', sourceRevision: 'abcdef0123456789abcdef' },
      editorRecordedAt: '2026-01-01T00:00:00.000Z',
    }
    const statusWithHold = (baseHold: BaseSchemaHold): AdminStatusData => {
      const status = makeStatusWithSync()
      if (!status.workerStatus) throw new Error('expected a worker status')
      status.workerStatus.baseHold = baseHold
      return status
    }

    it('says the worker is waiting, naming the schemas, the editor build and the files', async () => {
      mockClient.admin.status.mockResolvedValueOnce(mockSuccess(statusWithHold(hold)))

      renderPanel()

      const alert = await screen.findByTestId('base-hold-alert')
      expect(alert.textContent).toContain('Waiting for editor deploy')
      expect(alert.textContent).toContain(
        'Newly merged content names personSchema, teamSchema, which the running editor (built from abcdef012345) does not define.',
      )
      expect(alert.textContent).toContain('keeps the base branch at its current version')
      expect(alert.textContent).toContain('content/people/.collection.json')
    })

    it('counts the files past the first ten it lists', async () => {
      mockClient.admin.status.mockResolvedValueOnce(
        mockSuccess(statusWithHold({ ...hold, fileCount: 13 })),
      )

      renderPanel()

      const alert = await screen.findByTestId('base-hold-alert')
      expect(alert.textContent).toContain('content/people/.collection.json and 12 more')
    })

    it('says the worker stopped waiting once the hold expired', async () => {
      mockClient.admin.status.mockResolvedValueOnce(
        mockSuccess(statusWithHold({ ...hold, expired: true })),
      )

      renderPanel()

      const alert = await screen.findByTestId('base-hold-alert')
      expect(alert.textContent).toContain('Stopped waiting for the editor deploy')
      expect(alert.textContent).toContain('updated the base branch anyway')
    })

    it('shows no hold alert when the last sync held nothing', async () => {
      mockClient.admin.status.mockResolvedValueOnce(mockSuccess(makeStatusWithSync()))

      renderPanel()

      await waitFor(() => expect(screen.getByText('Worker: alive')).toBeTruthy())
      expect(screen.queryByTestId('base-hold-alert')).toBeNull()
    })
  })

  describe('Overview tab: diverged branches', () => {
    const statusWithDiverged = (diverged: string[]): AdminStatusData => {
      const status = makeStatusWithSync()
      if (!status.workerStatus?.lastGitSync) throw new Error('expected a last git sync')
      status.workerStatus.lastGitSync.tracked = {
        created: [],
        fastForwarded: [],
        ahead: [],
        diverged,
      }
      return status
    }

    it('lists each diverged branch, says what it means and what to do', async () => {
      mockClient.admin.status.mockResolvedValueOnce(
        mockSuccess(statusWithDiverged(['feature-a', 'feature-b'])),
      )

      renderPanel()

      const alert = await screen.findByTestId('diverged-branches-alert')
      expect(alert.textContent).toContain('2 branches diverged from GitHub')
      expect(alert.textContent).toContain(
        'holds editor work that conflicts with the branch on GitHub',
      )
      expect(alert.textContent).toContain('first push it to a new branch name on GitHub')
      expect(alert.textContent).toContain('"Delete branch" in the editor')
      expect(alert.textContent).toContain('withdraw it from review first')
      expect(alert.textContent).not.toContain('purge')
      expect(alert.textContent).toContain('feature-a')
      expect(alert.textContent).toContain('feature-b')
    })

    it('shows a hostile branch name escaped, never as markup or hidden characters', async () => {
      const markup = '<img src=x onerror="alert(1)">'
      mockClient.admin.status.mockResolvedValueOnce(
        mockSuccess(statusWithDiverged([markup, 'feature-\u202eevil\u200b'])),
      )

      renderPanel()

      const alert = await screen.findByTestId('diverged-branches-alert')
      expect(alert.querySelector('img')).toBeNull()
      expect(alert.textContent).toContain(markup)
      expect(alert.textContent).toContain('feature-\\u{202e}evil\\u{200b}')
      expect(alert.textContent).not.toMatch(/[\u202e\u200b]/)
    })

    it('shows no alert when nothing diverged', async () => {
      mockClient.admin.status.mockResolvedValueOnce(mockSuccess(statusWithDiverged([])))

      renderPanel()

      await waitFor(() => expect(screen.getByText('Worker: alive')).toBeTruthy())
      expect(screen.queryByTestId('diverged-branches-alert')).toBeNull()
    })
  })

  describe('Overview tab: branch namespace', () => {
    const statusWithGateway = (
      gateway: string | undefined,
      own: AdminStatusData['branchNamespace'] = { ok: true, namespace: 'canopycms/prod/' },
    ): AdminStatusData => {
      const status = makeStatusWithSync()
      if (!status.workerStatus) throw new Error('expected a worker status')
      if (gateway !== undefined) status.workerStatus.gatewayBranchNamespace = gateway
      return { ...status, branchNamespace: own }
    }

    it('says new branches cannot be published when the gateway writes another namespace', async () => {
      mockClient.admin.status.mockResolvedValueOnce(mockSuccess(statusWithGateway('editor-prod/')))

      renderPanel()

      const alert = await screen.findByTestId('branch-namespace-alert')
      expect(alert.textContent).toContain('New branches cannot be published')
      expect(alert.textContent).toContain('creates branches starting canopycms/prod/')
      expect(alert.textContent).toContain('writes only branches starting editor-prod/')
      expect(alert.textContent).toContain('CANOPYCMS_BRANCH_NAMESPACE')
    })

    it("says why this process's namespace is not valid", async () => {
      mockClient.admin.status.mockResolvedValueOnce(
        mockSuccess(
          statusWithGateway('canopycms/prod/', { ok: false, error: 'it must end with "/"' }),
        ),
      )

      renderPanel()

      const alert = await screen.findByTestId('branch-namespace-alert')
      expect(alert.textContent).toContain('The branch namespace is not valid')
      expect(alert.textContent).toContain('it must end with "/"')
    })

    it('shows nothing for a status from an API that does not report its namespace', async () => {
      const { branchNamespace: _omitted, ...older } = statusWithGateway('editor-prod/')
      mockClient.admin.status.mockResolvedValueOnce(mockSuccess(older))

      renderPanel()

      await waitFor(() => expect(screen.getByText('Worker: alive')).toBeTruthy())
      expect(screen.queryByTestId('branch-namespace-alert')).toBeNull()
    })

    it.each([
      ['the gateway writes the same namespace', 'canopycms/prod/'],
      ['the gateway has not said yet', undefined],
    ])('shows nothing when %s', async (_label, gateway) => {
      mockClient.admin.status.mockResolvedValueOnce(mockSuccess(statusWithGateway(gateway)))

      renderPanel()

      await waitFor(() => expect(screen.getByText('Worker: alive')).toBeTruthy())
      expect(screen.queryByTestId('branch-namespace-alert')).toBeNull()
    })
  })

  describe('Overview tab: unpublishable branches', () => {
    const twoHoursAgo = () => new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const statusWithUnpublishable = (
      names: (string | UnpublishableBranch)[],
      count = names.length,
      namespace: string | null = 'canopycms/prod/',
      at = twoHoursAgo(),
    ): AdminStatusData => {
      const status = makeStatusWithSync()
      if (!status.workerStatus) throw new Error('expected a worker status')
      status.workerStatus.unpublishableBranches = {
        branches: names.map((name) => (typeof name === 'string' ? { name } : name)),
        count,
        at,
      }
      if (namespace === null) delete status.workerStatus.gatewayBranchNamespace
      else status.workerStatus.gatewayBranchNamespace = namespace
      return status
    }

    it('lists each branch by its full ref, says why and what to do', async () => {
      mockClient.admin.status.mockResolvedValueOnce(
        mockSuccess(statusWithUnpublishable(['spring', 'cms/old/fix-typos'])),
      )

      renderPanel()

      const alert = await screen.findByTestId('unpublishable-branches-alert')
      expect(alert.textContent).toContain('2 branches cannot be published')
      expect(alert.textContent).toContain('outside the branch namespace canopycms/prod/')
      expect(alert.textContent).toContain('legacyBranches does not list it')
      expect(alert.textContent).toContain(
        "the base branch, GitHub's default branch, or a match for an entry in protectedBranches",
      )
      expect(alert.textContent).toContain('CANOPYCMS_LEGACY_BRANCHES on the GitHub gateway')
      expect(alert.textContent).toContain('new branch, which is created inside the namespace')
      expect(alert.textContent).toContain('spring')
      expect(alert.textContent).toContain('cms/old/fix-typos')
      expect(alert.textContent).not.toContain('more')
      expect(screen.queryByTestId('unpublishable-blocking')).toBeNull()
      expect(screen.queryByTestId('unpublishable-unlistable')).toBeNull()
    })

    it('says when the report was made, relative, with the absolute time for a tooltip', async () => {
      const at = twoHoursAgo()
      mockClient.admin.status.mockResolvedValueOnce(
        mockSuccess(statusWithUnpublishable(['spring'], 1, 'canopycms/prod/', at)),
      )

      renderPanel()

      const alert = await screen.findByTestId('unpublishable-branches-alert')
      expect(alert.textContent).toContain('As of 2h ago')
      expect(alert.textContent).toContain(new Date(at).toLocaleString())
    })

    it('tells a developer to rename a branch the namespace sits under, which blocks it all', async () => {
      mockClient.admin.status.mockResolvedValueOnce(
        mockSuccess(
          statusWithUnpublishable(['spring', { name: 'canopycms<b>', reason: 'blocks-namespace' }]),
        ),
      )

      renderPanel()

      const alert = await screen.findByTestId('unpublishable-branches-alert')
      const blocking = await screen.findByTestId('unpublishable-blocking')
      expect(blocking.textContent).toContain(
        'Rename or delete each of these branches on GitHub: while one exists, no branch in the namespace can be published.',
      )
      expect(blocking.nextElementSibling?.textContent).toBe('canopycms<b>')
      expect(alert.querySelector('b')).toBeNull()
      // The plain remedy still covers the other branch, and only it.
      expect(screen.getByTestId('unpublishable-listable').nextElementSibling?.textContent).toBe(
        'spring',
      )
      expect(screen.queryByTestId('unpublishable-unlistable')).toBeNull()
    })

    it('tells an editor to re-enter the changes of a branch legacyBranches cannot list', async () => {
      mockClient.admin.status.mockResolvedValueOnce(
        mockSuccess(statusWithUnpublishable([{ name: 'a,b\u202e', reason: 'unlistable' }])),
      )

      renderPanel()

      const alert = await screen.findByTestId('unpublishable-branches-alert')
      const unlistable = await screen.findByTestId('unpublishable-unlistable')
      expect(unlistable.textContent).toContain('legacyBranches cannot hold these names')
      expect(unlistable.textContent).toContain('re-enters each branch')
      expect(unlistable.nextElementSibling?.textContent).toBe('a,b\\u{202e}')
      // No branch is one a legacyBranches entry would publish.
      expect(alert.textContent).not.toContain('CANOPYCMS_LEGACY_BRANCHES')
      expect(screen.queryByTestId('unpublishable-blocking')).toBeNull()
    })

    it('still says why when the gateway has not named its namespace', async () => {
      mockClient.admin.status.mockResolvedValueOnce(
        mockSuccess(statusWithUnpublishable(['spring'], 1, null)),
      )

      renderPanel()

      const alert = await screen.findByTestId('unpublishable-branches-alert')
      expect(alert.textContent).toContain('1 branch cannot be published')
      expect(alert.textContent).toContain('outside the branch namespace and legacyBranches')
    })

    it('says how many more there are than it lists', async () => {
      mockClient.admin.status.mockResolvedValueOnce(
        mockSuccess(statusWithUnpublishable(['spring'], 51)),
      )

      renderPanel()

      const alert = await screen.findByTestId('unpublishable-branches-alert')
      expect(alert.textContent).toContain('51 branches cannot be published')
      expect(alert.textContent).toContain('And 50 more.')
    })

    it('shows a hostile branch name or namespace escaped, never as markup or hidden characters', async () => {
      const markup = '<img src=x onerror="alert(1)">'
      mockClient.admin.status.mockResolvedValueOnce(
        mockSuccess(statusWithUnpublishable([markup, 'spring-\u202eevil'], 2, 'ns\u200b/')),
      )

      renderPanel()

      const alert = await screen.findByTestId('unpublishable-branches-alert')
      expect(alert.querySelector('img')).toBeNull()
      expect(alert.textContent).toContain(markup)
      expect(alert.textContent).toContain('spring-\\u{202e}evil')
      expect(alert.textContent).toContain('ns\\u{200b}/')
      expect(alert.textContent).not.toMatch(/[\u202e\u200b]/)
    })

    it('shows no alert when every branch publishes', async () => {
      mockClient.admin.status.mockResolvedValueOnce(mockSuccess(makeStatusWithSync()))

      renderPanel()

      await waitFor(() => expect(screen.getByText('Worker: alive')).toBeTruthy())
      expect(screen.queryByTestId('unpublishable-branches-alert')).toBeNull()
    })
  })

  describe('Overview tab: base branch refresh', () => {
    it('shows a skipped base refresh, its dirty files, and the tracked-state fix', async () => {
      mockClient.admin.status.mockResolvedValueOnce(
        mockSuccess(makeStatusWithSync(dirtyBaseRefresh)),
      )

      renderPanel()

      await waitFor(() =>
        expect(screen.getByTestId('base-refresh-outcome').textContent).toBe(
          'Base branch: refresh skipped (uncommitted changes)',
        ),
      )
      expect(screen.getByText(/1 skipped \(dirty\)/)).toBeTruthy()
      const warning = screen.getByTestId('base-refresh-warning').textContent ?? ''
      expect(warning).toContain('Uncommitted: content/home.md')
      expect(warning).toContain('.canopy-meta/schema-cache.json')
      expect(warning).toContain('git rm -r --cached .canopy-meta')
    })

    it('shows a healthy base refresh without a warning', async () => {
      mockClient.admin.status.mockResolvedValueOnce(
        mockSuccess(makeStatusWithSync({ outcome: 'up-to-date' })),
      )

      renderPanel()

      await waitFor(() =>
        expect(screen.getByTestId('base-refresh-outcome').textContent).toBe(
          'Base branch: up to date',
        ),
      )
      expect(screen.queryByTestId('base-refresh-warning')).toBeNull()
    })

    it('renders the git sync summary as before when the worker reports no baseRefresh', async () => {
      mockClient.admin.status.mockResolvedValueOnce(mockSuccess(makeStatusWithSync()))

      renderPanel()

      await waitFor(() => expect(screen.getByText(/0 skipped \(dirty\)/)).toBeTruthy())
      expect(screen.queryByTestId('base-refresh-outcome')).toBeNull()
      expect(screen.queryByTestId('base-refresh-warning')).toBeNull()
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
    const archivedWithStaleRebaseFailure: BranchHealthEntry = {
      dirName: 'feature-c',
      kind: 'healthy',
      branch: {
        name: 'feature-c',
        status: 'archived',
        access: {},
        createdBy: 'user-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        // 'archived' is in rebaseActiveBranches' skip list alongside
        // 'submitted'/'approved', so the worker never rebases it and a leftover
        // failure record must stay suppressed.
        rebaseFailure: {
          message: 'merge conflict',
          firstAt: '2026-01-01T00:00:00.000Z',
          lastAt: '2026-01-02T00:00:00.000Z',
        },
      },
    }
    const healthyWithDuplicateIds: BranchHealthEntry = {
      dirName: 'feature-dupes',
      kind: 'healthy',
      branch: {
        name: 'feature-dupes',
        status: 'editing',
        access: {},
        createdBy: 'user-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    }
    const duplicateFound: DuplicateIdScan = {
      state: 'found',
      duplicates: [
        {
          id: unsafeAsContentId('a1b2c3d4e5f6'),
          keptPath: unsafeAsPhysicalPath('content/posts/post.one.a1b2c3d4e5f6.json'),
          droppedPaths: [unsafeAsPhysicalPath('content/posts/post.two.a1b2c3d4e5f6.json')],
        },
      ],
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
            archivedWithStaleRebaseFailure,
            healthyWithDuplicateIds,
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
      expect(screen.getAllByText('Corrupt metadata').length).toBeGreaterThanOrEqual(1)
      expect(screen.getByText('orphan-young')).toBeTruthy()
      expect(screen.getByText('orphan-old')).toBeTruthy()
    })

    describe('duplicate content IDs', () => {
      /**
       * Answers the plain request with `entries` and the `duplicates=1` scan
       * with each healthy entry's `scans[dirName]` (omitted when absent).
       */
      const mockScan = (
        entries: BranchHealthEntry[],
        scans: Record<string, DuplicateIdScan>,
        truncated = false,
      ) => {
        mockClient.admin.branchHealth.mockImplementation(async (params) => {
          const data: BranchHealthData =
            params?.duplicates === '1'
              ? {
                  entries: entries.map((e) =>
                    scans[e.dirName] ? { ...e, duplicateIdScan: scans[e.dirName] } : e,
                  ),
                  generatedAt: '2026-01-01T00:00:00.000Z',
                  duplicateIdScan: { budgetMs: 20_000, truncated },
                }
              : { entries, generatedAt: '2026-01-01T00:00:00.000Z' }
          return mockSuccess(data)
        })
      }
      const summary = () => screen.getByTestId('duplicate-id-summary').textContent

      it('opens its own confirmation from the badge, showing kept and archived paths, and confirm runs only the repair', async () => {
        const { modals } = await import('@mantine/modals')
        mockScan([healthyWithDuplicateIds, oldOrphan], { 'feature-dupes': duplicateFound })
        renderPanel()
        await userEvent.click(screen.getByText('Branches'))

        const badge = await screen.findByTestId('duplicate-content-ids-feature-dupes')
        expect(badge.textContent).toBe('1 duplicate ID')
        expect(summary()).toBe('Duplicate content IDs found on 1 branch.')

        await userEvent.click(badge)

        const options = vi.mocked(modals.openConfirmModal).mock.calls.at(-1)?.[0]
        expect(options?.title).toBe('Fix duplicate content IDs')
        expect(options?.labels).toEqual({ confirm: 'Archive duplicates', cancel: 'Cancel' })
        cleanup()
        render(<CanopyCMSProvider>{options?.children}</CanopyCMSProvider>)
        expect(screen.getByText('content/posts/post.one.a1b2c3d4e5f6.json')).toBeTruthy()
        expect(screen.getByText('content/posts/post.two.a1b2c3d4e5f6.json')).toBeTruthy()
        expect(screen.getByText(/Nothing is deleted/)).toBeTruthy()

        await waitFor(() =>
          expect(mockClient.admin.repairContentDuplicates).toHaveBeenCalledWith({
            dirName: 'feature-dupes',
          }),
        )
        expect(mockClient.admin.purgeBranchDir).not.toHaveBeenCalled()
      })

      it('says not checked, never clean, for a branch the scan could not finish or did not include', async () => {
        const late: BranchHealthEntry = { ...healthyWithDuplicateIds, dirName: 'feature-late' }
        const added: BranchHealthEntry = { ...healthyWithDuplicateIds, dirName: 'feature-new' }
        mockScan(
          [healthyWithDuplicateIds, late, added],
          {
            'feature-dupes': { state: 'none' },
            'feature-late': { state: 'unknown', reason: 'out-of-time' },
          },
          true,
        )
        renderPanel()
        await userEvent.click(screen.getByText('Branches'))

        await screen.findByTestId('duplicate-ids-unchecked-feature-late')
        expect(screen.getByTestId('duplicate-ids-unchecked-feature-new')).toBeTruthy()
        expect(screen.queryByTestId('duplicate-ids-unchecked-feature-dupes')).toBeNull()
        expect(screen.queryByTestId('duplicate-content-ids-feature-late')).toBeNull()
        expect(summary()).toBe('Could not check 2 branches.')

        await userEvent.hover(screen.getByTestId('duplicate-ids-unchecked-feature-late'))
        expect((await screen.findByRole('tooltip')).textContent).toBe(
          'The duplicate ID check ran out of time before reaching this branch.',
        )
      })

      it('says clean only when every healthy branch was scanned clean', async () => {
        mockScan([healthyWithDuplicateIds, corruptEntry], { 'feature-dupes': { state: 'none' } })
        renderPanel()
        await userEvent.click(screen.getByText('Branches'))

        await waitFor(() => expect(summary()).toBe('No duplicate content IDs found.'))
        expect(screen.queryByTestId('duplicate-content-ids-feature-dupes')).toBeNull()
        expect(screen.queryByTestId('duplicate-ids-unchecked-feature-dupes')).toBeNull()
      })

      it('reports a failed scan request as not checked', async () => {
        mockClient.admin.branchHealth.mockImplementation(async (params) =>
          params?.duplicates === '1'
            ? { ok: false, status: 500, error: 'Lambda timed out' }
            : mockSuccess({
                entries: [healthyWithDuplicateIds],
                generatedAt: '2026-01-01T00:00:00.000Z',
              }),
        )
        renderPanel()
        await userEvent.click(screen.getByText('Branches'))

        await waitFor(() =>
          expect(summary()).toBe('Could not check for duplicate content IDs: Lambda timed out'),
        )
      })

      it('Check again re-runs the scan', async () => {
        mockScan([healthyWithDuplicateIds], { 'feature-dupes': { state: 'none' } })
        renderPanel()
        await userEvent.click(screen.getByText('Branches'))
        await waitFor(() => expect(summary()).toBe('No duplicate content IDs found.'))

        mockScan([healthyWithDuplicateIds], { 'feature-dupes': duplicateFound })
        await userEvent.click(screen.getByRole('button', { name: 'Check again' }))

        await screen.findByTestId('duplicate-content-ids-feature-dupes')
      })
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

    it('shows the rebaseFailure icon for rebased branches, suppresses it for skip-listed ones (LOW-3)', async () => {
      renderPanel()
      await userEvent.click(screen.getByText('Branches'))
      await waitFor(() => expect(screen.getByText('feature-a')).toBeTruthy())

      expect(screen.getByTestId('rebase-failure-feature-a')).toBeTruthy() // editing: rebased
      expect(screen.queryByTestId('rebase-failure-feature-b')).toBeNull() // submitted: skipped
      expect(screen.queryByTestId('rebase-failure-feature-c')).toBeNull() // archived: skipped
    })

    it('reaches the rebase failure by keyboard: a named focusable icon described by the message', async () => {
      renderPanel()
      await userEvent.click(screen.getByText('Branches'))
      await waitFor(() => expect(screen.getByText('feature-a')).toBeTruthy())

      const icon = screen.getByTestId('rebase-failure-feature-a')
      const trigger = icon.closest('[tabindex="0"]') as HTMLElement
      expect(trigger.tagName).toBe('SPAN')
      expect(screen.getByRole('img', { name: 'Rebase failing' })).toBe(trigger)
      act(() => trigger.focus())
      expect(document.activeElement).toBe(trigger)
      const detail = `merge conflict (first failed ${formatRelativeTime('2026-01-01T00:00:00.000Z')}, ${new Date('2026-01-01T00:00:00.000Z').toLocaleString()})`
      expect(document.getElementById(trigger.getAttribute('aria-describedby')!)?.textContent).toBe(
        detail,
      )
      // The tooltip names the icon, which is all a sighted user sees.
      expect((await screen.findByRole('tooltip')).textContent).toBe(`Rebase failing: ${detail}`)
    })

    describe('base branch row', () => {
      const healthyBase: BranchHealthEntry = {
        dirName: 'main',
        kind: 'healthy',
        isBaseBranch: true,
        branch: {
          name: 'main',
          status: 'editing',
          access: {},
          createdBy: 'user-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      }

      beforeEach(() => {
        mockClient.admin.branchHealth.mockResolvedValue(
          mockSuccess({
            entries: [healthyBase, editingWithRebaseFailure],
            generatedAt: '2026-01-01T00:00:00.000Z',
          }),
        )
      })

      it('carries the base refresh warning, with its detail in the tooltip', async () => {
        mockClient.admin.status.mockResolvedValue(mockSuccess(makeStatusWithSync(dirtyBaseRefresh)))

        renderPanel()
        await userEvent.click(screen.getByText('Branches'))
        const icon = await screen.findByTestId('base-refresh-warning-main')

        expect(screen.queryByTestId('base-refresh-warning-feature-a')).toBeNull()
        await userEvent.hover(icon)
        // Scoped to the tooltip: the Overview panel stays mounted and repeats the text.
        expect((await screen.findByRole('tooltip')).textContent).toMatch(
          /Uncommitted: content\/home\.md/,
        )
      })

      it('reaches the base refresh warning by keyboard: a named focusable icon described by it', async () => {
        mockClient.admin.status.mockResolvedValue(mockSuccess(makeStatusWithSync(dirtyBaseRefresh)))

        renderPanel()
        await userEvent.click(screen.getByText('Branches'))
        const icon = await screen.findByTestId('base-refresh-warning-main')

        const trigger = icon.closest('[tabindex="0"]') as HTMLElement
        expect(trigger.tagName).toBe('SPAN')
        expect(screen.getByRole('img', { name: 'Base branch refresh failing' })).toBe(trigger)
        act(() => trigger.focus())
        expect(document.activeElement).toBe(trigger)
        const description = document.getElementById(
          trigger.getAttribute('aria-describedby')!,
        )?.textContent
        expect(description).toMatch(/Uncommitted: content\/home\.md/)
        expect((await screen.findByRole('tooltip')).textContent).toBe(
          `Base branch refresh failing: ${description}`,
        )
      })

      it('carries no warning when the worker reports no baseRefresh', async () => {
        mockClient.admin.status.mockResolvedValue(mockSuccess(makeStatusWithSync()))

        renderPanel()
        await userEvent.click(screen.getByText('Branches'))
        await waitFor(() => expect(screen.getByText('feature-a')).toBeTruthy())

        expect(screen.queryByTestId('base-refresh-warning-main')).toBeNull()
      })
    })

    it('shows the recorded syncFailureReason in the sync-failed tooltip', async () => {
      mockClient.admin.branchHealth.mockResolvedValueOnce(
        mockSuccess({
          entries: [
            {
              dirName: 'feature-d',
              kind: 'healthy',
              branch: {
                name: 'feature-d',
                status: 'editing',
                access: {},
                createdBy: 'user-1',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-02T00:00:00.000Z',
                syncStatus: 'sync-failed',
                syncFailureReason: 'Push rejected for branch "feature-d": it has moved on GitHub',
              },
            },
          ],
          generatedAt: '2026-01-01T00:00:00.000Z',
        }),
      )

      renderPanel()
      await userEvent.click(screen.getByText('Branches'))
      await waitFor(() => expect(screen.getByText('feature-d')).toBeTruthy())

      await userEvent.hover(screen.getByText('Sync failed'))
      expect((await screen.findByRole('tooltip')).textContent).toMatch(/moved on GitHub/)
    })

    it('reaches the sync-failed reason by keyboard: a focusable trigger described by the reason', async () => {
      mockClient.admin.branchHealth.mockResolvedValueOnce(
        mockSuccess({
          entries: [
            {
              dirName: 'feature-d',
              kind: 'healthy',
              branch: {
                name: 'feature-d',
                status: 'editing',
                access: {},
                createdBy: 'user-1',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-02T00:00:00.000Z',
                syncStatus: 'sync-failed',
                syncFailureReason: 'Push rejected for branch "feature-d": it has moved on GitHub',
              },
            },
          ],
          generatedAt: '2026-01-01T00:00:00.000Z',
        }),
      )

      renderPanel()
      await userEvent.click(screen.getByText('Branches'))
      await waitFor(() => expect(screen.getByText('feature-d')).toBeTruthy())

      expect(screen.queryByRole('button', { name: /sync/i })).toBeNull()
      const trigger = screen.getByText('Sync failed').closest('[tabindex="0"]') as HTMLElement
      expect(trigger.tagName).toBe('SPAN')
      act(() => trigger.focus())
      expect(document.activeElement).toBe(trigger)
      const describedBy = trigger.getAttribute('aria-describedby')
      expect(document.getElementById(describedBy!)?.textContent).toBe(
        'Push rejected for branch "feature-d": it has moved on GitHub — retry from the "Tasks" tab',
      )
      expect((await screen.findByRole('tooltip')).textContent).toMatch(/moved on GitHub/)
    })

    it('disables purge for a young orphan and confirms the 30-day trash retention for an old one', async () => {
      renderPanel()
      await userEvent.click(screen.getByText('Branches'))
      await waitFor(() => expect(screen.getByText('orphan-young')).toBeTruthy())

      const youngPurgeButton = screen.getByTestId('purge-dir-orphan-young')
      expect(youngPurgeButton.getAttribute('aria-disabled')).toBe('true')
      // Blocked, it stays focusable and says why on keyboard focus, and its click does nothing.
      expect(youngPurgeButton.hasAttribute('disabled')).toBe(false)
      act(() => youngPurgeButton.focus())
      expect(
        await screen.findByText('This may be a clone in progress. Try again in a few minutes.'),
      ).toBeTruthy()
      await userEvent.click(youngPurgeButton)
      expect(mockClient.admin.purgeBranchDir).not.toHaveBeenCalled()

      const oldPurgeButton = screen.getByTestId('purge-dir-orphan-old')
      expect(oldPurgeButton.getAttribute('aria-disabled')).toBeNull()

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

      expect(screen.getByTestId('purge-dir-broken-branch').getAttribute('aria-disabled')).toBeNull()
      expect(screen.getByTestId('purge-dir-broken-locked').getAttribute('aria-disabled')).toBe(
        'true',
      )
    })

    it('disables purge for the base branch even when corrupt or orphaned (LOW-2)', async () => {
      renderPanel()
      await userEvent.click(screen.getByText('Branches'))
      await waitFor(() => expect(screen.getByText('main')).toBeTruthy())

      const corruptBasePurge = screen.getByTestId('purge-dir-main')
      expect(corruptBasePurge.getAttribute('aria-disabled')).toBe('true')

      const orphanBasePurge = screen.getByTestId('purge-dir-main-orphan')
      expect(orphanBasePurge.getAttribute('aria-disabled')).toBe('true')
    })
  })
})
