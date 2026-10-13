// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { ApiTimeoutError, WRITE_TIMED_OUT_MESSAGE } from '../../api/request-deadline'
import { renderHook, act } from '@testing-library/react'
import { useSchemaManager, schemaChangeOutcomeUnknown } from './useSchemaManager'
import type { MockApiClient } from '../../api/__test__/mock-client'
import { setupMockApiClient, createApiClientWrapper, gatewayPage } from './__test__/test-utils'
import { mockSuccess, mockError } from '../../api/__test__/mock-client'
import { unsafeAsLogicalPath, unsafeAsContentId } from '../../paths/test-utils'
import { mockConsole } from '../../test-utils/console-spy'
import { notifications } from '@mantine/notifications'

// Mock the API client module
vi.mock('../../api', async () => {
  const actual = await vi.importActual('../../api')
  return {
    ...actual,
    createApiClient: vi.fn(),
  }
})

// Mock notifications
vi.mock('@mantine/notifications', () => ({
  notifications: {
    show: vi.fn(),
    hide: vi.fn(),
  },
}))

describe('useSchemaManager', () => {
  let mockClient: MockApiClient
  let wrapper: ReturnType<typeof createApiClientWrapper>

  beforeEach(async () => {
    mockConsole()
    vi.clearAllMocks()
    mockClient = await setupMockApiClient()
    wrapper = createApiClientWrapper(mockClient)
  })

  describe('createCollection', () => {
    it('creates collection successfully', async () => {
      mockClient.schema.createCollection.mockResolvedValueOnce(
        mockSuccess({
          collectionPath: unsafeAsLogicalPath('posts'),
          contentId: unsafeAsContentId('abc123def456'),
        }),
      )

      const onSchemaChange = vi.fn()
      const { result } = renderHook(
        () => useSchemaManager({ branchName: 'main', onSchemaChange }),
        { wrapper },
      )

      let createResult: Awaited<ReturnType<typeof result.current.createCollection>> | null = null
      await act(async () => {
        createResult = await result.current.createCollection({
          name: 'posts',
          label: 'Posts',
          entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
        })
      })

      expect(createResult).toEqual({
        ok: true,
        data: {
          collectionPath: unsafeAsLogicalPath('posts'),
          contentId: 'abc123def456',
        },
      })
      expect(mockClient.schema.createCollection).toHaveBeenCalledWith(
        { branch: 'main' },
        {
          name: 'posts',
          label: 'Posts',
          entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
        },
      )
      expect(onSchemaChange).toHaveBeenCalled()
    })

    it('returns a failure result with the underlying error message', async () => {
      mockClient.schema.createCollection.mockResolvedValueOnce(
        mockError(400, 'Collection already exists'),
      )

      const { result } = renderHook(() => useSchemaManager({ branchName: 'main' }), { wrapper })

      let createResult: Awaited<ReturnType<typeof result.current.createCollection>> | null = null
      await act(async () => {
        createResult = await result.current.createCollection({
          name: 'posts',
          entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
        })
      })

      expect(createResult).toEqual({ ok: false, error: 'Collection already exists' })
      expect(notifications.show).toHaveBeenCalledTimes(1)
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({
          color: 'red',
          message: 'Failed to create collection: Collection already exists',
        }),
      )
    })
  })

  describe('updateCollection', () => {
    it('updates collection successfully', async () => {
      mockClient.schema.updateCollection.mockResolvedValueOnce(mockSuccess({ success: true }))

      const onSchemaChange = vi.fn()
      const { result } = renderHook(
        () => useSchemaManager({ branchName: 'main', onSchemaChange }),
        { wrapper },
      )

      let updateResult: Awaited<ReturnType<typeof result.current.updateCollection>> = {
        ok: false,
        error: 'not called',
      }
      await act(async () => {
        updateResult = await result.current.updateCollection(unsafeAsLogicalPath('posts'), {
          label: 'Blog Posts',
        })
      })

      expect(updateResult).toEqual({ ok: true })
      expect(mockClient.schema.updateCollection).toHaveBeenCalledWith(
        { branch: 'main', collectionPath: 'posts' },
        { label: 'Blog Posts' },
      )
      expect(onSchemaChange).toHaveBeenCalled()
    })

    it('reports a landed save as saved when the content tree refresh fails', async () => {
      mockClient.schema.updateCollection.mockResolvedValueOnce(mockSuccess({ success: true }))
      const onSchemaChange = vi.fn(() =>
        Promise.reject(new ApiTimeoutError('GET', '/main/schema', 75_000)),
      )
      const { result } = renderHook(
        () => useSchemaManager({ branchName: 'main', onSchemaChange }),
        { wrapper },
      )

      let updateResult: Awaited<ReturnType<typeof result.current.updateCollection>> = {
        ok: false,
        error: 'not called',
      }
      await act(async () => {
        updateResult = await result.current.updateCollection(unsafeAsLogicalPath('posts'), {
          label: 'Blog Posts',
        })
      })

      expect(updateResult).toEqual({ ok: true })
      expect(onSchemaChange).toHaveBeenCalledTimes(1)
      expect(notifications.show).toHaveBeenCalledTimes(1)
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Collection updated', color: 'green' }),
      )
    })

    it('returns a failure result with the underlying error message', async () => {
      mockClient.schema.updateCollection.mockResolvedValueOnce(
        mockError(404, 'Collection not found'),
      )

      const { result } = renderHook(() => useSchemaManager({ branchName: 'main' }), { wrapper })

      let updateResult: Awaited<ReturnType<typeof result.current.updateCollection>> = { ok: true }
      await act(async () => {
        updateResult = await result.current.updateCollection(unsafeAsLogicalPath('nonexistent'), {
          label: 'Test',
        })
      })

      expect(updateResult).toEqual({ ok: false, error: 'Collection not found' })
    })
  })

  describe('deleteCollection', () => {
    it('deletes collection successfully', async () => {
      mockClient.schema.deleteCollection.mockResolvedValueOnce(mockSuccess({ success: true }))

      const onSchemaChange = vi.fn()
      const { result } = renderHook(
        () => useSchemaManager({ branchName: 'main', onSchemaChange }),
        { wrapper },
      )

      let deleteResult: Awaited<ReturnType<typeof result.current.deleteCollection>> = {
        ok: false,
        error: 'not called',
      }
      await act(async () => {
        deleteResult = await result.current.deleteCollection(unsafeAsLogicalPath('posts'))
      })

      expect(deleteResult).toEqual({ ok: true })
      expect(mockClient.schema.deleteCollection).toHaveBeenCalledWith({
        branch: 'main',
        collectionPath: 'posts',
      })
      expect(onSchemaChange).toHaveBeenCalled()
    })

    it('returns a failure result when collection is not empty', async () => {
      mockClient.schema.deleteCollection.mockResolvedValueOnce(
        mockError(400, 'Collection must be empty'),
      )

      const { result } = renderHook(() => useSchemaManager({ branchName: 'main' }), { wrapper })

      let deleteResult: Awaited<ReturnType<typeof result.current.deleteCollection>> = { ok: true }
      await act(async () => {
        deleteResult = await result.current.deleteCollection(unsafeAsLogicalPath('posts'))
      })

      expect(deleteResult).toEqual({ ok: false, error: 'Collection must be empty' })
    })
  })

  describe('addEntryType', () => {
    it('adds entry type successfully', async () => {
      mockClient.schema.addEntryType.mockResolvedValueOnce(mockSuccess({ success: true }))

      const onSchemaChange = vi.fn()
      const { result } = renderHook(
        () => useSchemaManager({ branchName: 'main', onSchemaChange }),
        { wrapper },
      )

      let addResult: Awaited<ReturnType<typeof result.current.addEntryType>> = {
        ok: false,
        error: 'not called',
      }
      await act(async () => {
        addResult = await result.current.addEntryType(unsafeAsLogicalPath('posts'), {
          name: 'featured',
          format: 'mdx',
          schema: 'postSchema',
        })
      })

      expect(addResult).toEqual({ ok: true })
      expect(mockClient.schema.addEntryType).toHaveBeenCalledWith(
        { branch: 'main', collectionPath: 'posts' },
        { name: 'featured', format: 'mdx', schema: 'postSchema' },
      )
      expect(onSchemaChange).toHaveBeenCalled()
      expect(notifications.show).not.toHaveBeenCalled()
    })

    it('returns a failure result without a toast', async () => {
      mockClient.schema.addEntryType.mockResolvedValueOnce(mockError(400, 'Name already used'))

      const { result } = renderHook(() => useSchemaManager({ branchName: 'main' }), { wrapper })

      let addResult: Awaited<ReturnType<typeof result.current.addEntryType>> = { ok: true }
      await act(async () => {
        addResult = await result.current.addEntryType(unsafeAsLogicalPath('posts'), {
          name: 'featured',
          format: 'mdx',
          schema: 'postSchema',
        })
      })

      expect(addResult).toEqual({ ok: false, error: 'Name already used' })
      expect(notifications.show).not.toHaveBeenCalled()
    })
  })

  describe('updateEntryType', () => {
    it('updates entry type successfully', async () => {
      mockClient.schema.updateEntryType.mockResolvedValueOnce(mockSuccess({ success: true }))

      const { result } = renderHook(() => useSchemaManager({ branchName: 'main' }), { wrapper })

      let updateResult: Awaited<ReturnType<typeof result.current.updateEntryType>> = {
        ok: false,
        error: 'not called',
      }
      await act(async () => {
        updateResult = await result.current.updateEntryType(unsafeAsLogicalPath('posts'), 'post', {
          label: 'Blog Post',
          maxItems: 100,
        })
      })

      expect(updateResult).toEqual({ ok: true })
      expect(mockClient.schema.updateEntryType).toHaveBeenCalledWith(
        { branch: 'main', collectionPath: 'posts', entryTypeName: 'post' },
        { label: 'Blog Post', maxItems: 100 },
      )
      expect(notifications.show).not.toHaveBeenCalled()
    })

    it('returns a failure result without a toast', async () => {
      mockClient.schema.updateEntryType.mockResolvedValueOnce(mockError(400, 'Schema is locked'))

      const { result } = renderHook(() => useSchemaManager({ branchName: 'main' }), { wrapper })

      let updateResult: Awaited<ReturnType<typeof result.current.updateEntryType>> = { ok: true }
      await act(async () => {
        updateResult = await result.current.updateEntryType(unsafeAsLogicalPath('posts'), 'post', {
          label: 'Blog Post',
        })
      })

      expect(updateResult).toEqual({ ok: false, error: 'Schema is locked' })
      expect(notifications.show).not.toHaveBeenCalled()
    })
  })

  describe('removeEntryType', () => {
    it('removes entry type successfully', async () => {
      mockClient.schema.removeEntryType.mockResolvedValueOnce(mockSuccess({ success: true }))

      const { result } = renderHook(() => useSchemaManager({ branchName: 'main' }), { wrapper })

      let removeResult: Awaited<ReturnType<typeof result.current.removeEntryType>> = {
        ok: false,
        error: 'not called',
      }
      await act(async () => {
        removeResult = await result.current.removeEntryType(
          unsafeAsLogicalPath('posts'),
          'featured',
        )
      })

      expect(removeResult).toEqual({ ok: true })
      expect(mockClient.schema.removeEntryType).toHaveBeenCalledWith({
        branch: 'main',
        collectionPath: 'posts',
        entryTypeName: 'featured',
      })
      expect(notifications.show).not.toHaveBeenCalled()
    })

    it('returns a failure result when removing the last entry type', async () => {
      mockClient.schema.removeEntryType.mockResolvedValueOnce(
        mockError(400, 'Cannot remove last entry type'),
      )

      const { result } = renderHook(() => useSchemaManager({ branchName: 'main' }), { wrapper })

      let removeResult: Awaited<ReturnType<typeof result.current.removeEntryType>> = { ok: true }
      await act(async () => {
        removeResult = await result.current.removeEntryType(unsafeAsLogicalPath('posts'), 'post')
      })

      expect(removeResult).toEqual({ ok: false, error: 'Cannot remove last entry type' })
      expect(notifications.show).not.toHaveBeenCalled()
    })
  })

  describe('updateOrder', () => {
    it('updates order successfully', async () => {
      mockClient.schema.updateOrder.mockResolvedValueOnce(mockSuccess({ success: true }))

      const onSchemaChange = vi.fn()
      const { result } = renderHook(
        () => useSchemaManager({ branchName: 'main', onSchemaChange }),
        { wrapper },
      )

      let updateResult: Awaited<ReturnType<typeof result.current.updateOrder>> = {
        ok: false,
        error: 'not called',
      }
      await act(async () => {
        updateResult = await result.current.updateOrder(unsafeAsLogicalPath('posts'), [
          'id3',
          'id1',
          'id2',
        ])
      })

      expect(updateResult).toEqual({ ok: true })
      expect(mockClient.schema.updateOrder).toHaveBeenCalledWith(
        { branch: 'main', collectionPath: 'posts' },
        { order: ['id3', 'id1', 'id2'] },
      )
      expect(onSchemaChange).toHaveBeenCalled()
    })
  })

  describe('deleteEntry', () => {
    it('deletes entry successfully', async () => {
      mockClient.entries.delete.mockResolvedValueOnce(mockSuccess({ deleted: true }))

      const onSchemaChange = vi.fn()
      const { result } = renderHook(
        () => useSchemaManager({ branchName: 'main', onSchemaChange }),
        { wrapper },
      )

      let deleteResult: Awaited<ReturnType<typeof result.current.deleteEntry>> = {
        ok: false,
        error: 'not called',
      }
      await act(async () => {
        deleteResult = await result.current.deleteEntry(unsafeAsLogicalPath('posts/hello-world'))
      })

      expect(deleteResult).toEqual({ ok: true })
      expect(mockClient.entries.delete).toHaveBeenCalledWith({
        branch: 'main',
        entryPath: 'posts/hello-world',
      })
      expect(onSchemaChange).toHaveBeenCalled()
    })

    it('returns a failure result when lacking permission', async () => {
      mockClient.entries.delete.mockResolvedValueOnce(mockError(403, 'Edit permission required'))

      const { result } = renderHook(() => useSchemaManager({ branchName: 'main' }), { wrapper })

      let deleteResult: Awaited<ReturnType<typeof result.current.deleteEntry>> = { ok: true }
      await act(async () => {
        deleteResult = await result.current.deleteEntry(unsafeAsLogicalPath('posts/protected'))
      })

      expect(deleteResult).toEqual({ ok: false, error: 'Edit permission required' })
    })

    it('returns the referencing entries on a referenced-entry refusal, without a toast', async () => {
      const referencedBy = {
        entries: [
          {
            entryPath: unsafeAsLogicalPath('posts/by-alice'),
            contentId: unsafeAsContentId('pst1pst1pst1'),
            title: 'By Alice',
            fields: ['author'],
            links: [],
          },
        ],
        hiddenCount: 2,
      }
      mockClient.entries.delete.mockResolvedValueOnce({
        ok: false,
        status: 409,
        error: 'Entry is referenced by 3 other entries',
        data: { deleted: false, referencedBy },
      })
      const onSchemaChange = vi.fn()
      const { result } = renderHook(
        () => useSchemaManager({ branchName: 'main', onSchemaChange }),
        { wrapper },
      )
      vi.mocked(notifications.show).mockClear()

      let deleteResult: Awaited<ReturnType<typeof result.current.deleteEntry>> = { ok: true }
      await act(async () => {
        deleteResult = await result.current.deleteEntry(unsafeAsLogicalPath('people/alice'))
      })

      expect(deleteResult).toEqual({
        ok: false,
        error: 'Entry is referenced by 3 other entries',
        referencedBy,
      })
      expect(notifications.show).not.toHaveBeenCalled()
      expect(onSchemaChange).not.toHaveBeenCalled()
    })

    it('sends the confirm flag only when asked to', async () => {
      mockClient.entries.delete.mockResolvedValueOnce(mockSuccess({ deleted: true }))
      const { result } = renderHook(() => useSchemaManager({ branchName: 'main' }), { wrapper })

      await act(async () => {
        await result.current.deleteEntry(unsafeAsLogicalPath('people/alice'), {
          confirmReferenced: true,
        })
      })

      expect(mockClient.entries.delete).toHaveBeenCalledWith({
        branch: 'main',
        entryPath: 'people/alice',
        confirmReferenced: 'true',
      })
    })
  })

  describe.each<{
    op: string
    mock: (client: MockApiClient) => Mock
    call: (hook: ReturnType<typeof useSchemaManager>) => Promise<{ ok: boolean }>
    unknownToast: string | null
    failureToast: string | null
    /** The unknown-outcome toast's id, when not the shared one. */
    unknownToastId?: string
  }>([
    {
      op: 'createCollection',
      mock: (c) => c.schema.createCollection as Mock,
      call: (h) =>
        h.createCollection({
          name: 'posts',
          entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
        }),
      unknownToast: schemaChangeOutcomeUnknown(
        'Creating the collection',
        'Check the "Content" panel',
      ),
      unknownToastId: 'canopy-collection-outcome-unknown',
      failureToast: 'Failed to create collection: x',
    },
    {
      op: 'updateCollection',
      mock: (c) => c.schema.updateCollection as Mock,
      call: (h) => h.updateCollection(unsafeAsLogicalPath('posts'), { label: 'Blog' }),
      unknownToast: schemaChangeOutcomeUnknown(
        'Saving collection details',
        'Reopen the collection to check',
      ),
      unknownToastId: 'canopy-collection-outcome-unknown',
      failureToast: 'Failed to update collection: x',
    },
    {
      op: 'deleteCollection',
      mock: (c) => c.schema.deleteCollection as Mock,
      call: (h) => h.deleteCollection(unsafeAsLogicalPath('posts')),
      unknownToast: schemaChangeOutcomeUnknown(
        'Deleting the collection',
        'Check the "Content" panel',
      ),
      failureToast: 'Failed to delete collection: x',
    },
    {
      op: 'updateOrder',
      mock: (c) => c.schema.updateOrder as Mock,
      call: (h) => h.updateOrder(unsafeAsLogicalPath('posts'), ['id2', 'id1']),
      unknownToast: schemaChangeOutcomeUnknown('Reordering entries', 'Check the "Content" panel'),
      failureToast: 'Failed to update order: x',
    },
    {
      op: 'deleteEntry',
      mock: (c) => c.entries.delete as Mock,
      call: (h) => h.deleteEntry(unsafeAsLogicalPath('posts/a')),
      unknownToast: schemaChangeOutcomeUnknown('Deleting the entry', 'Check the "Content" panel'),
      failureToast: 'Failed to delete entry: x',
    },
    {
      op: 'addEntryType',
      mock: (c) => c.schema.addEntryType as Mock,
      call: (h) =>
        h.addEntryType(unsafeAsLogicalPath('posts'), {
          name: 'featured',
          format: 'mdx',
          schema: 'postSchema',
        }),
      unknownToast: null,
      failureToast: null,
    },
    {
      op: 'updateEntryType',
      mock: (c) => c.schema.updateEntryType as Mock,
      call: (h) => h.updateEntryType(unsafeAsLogicalPath('posts'), 'post', { label: 'Post' }),
      unknownToast: null,
      failureToast: null,
    },
    {
      op: 'removeEntryType',
      mock: (c) => c.schema.removeEntryType as Mock,
      call: (h) => h.removeEntryType(unsafeAsLogicalPath('posts'), 'post'),
      unknownToast: null,
      failureToast: null,
    },
  ])(
    '$op outcome handling',
    ({
      mock,
      call,
      unknownToast,
      failureToast,
      unknownToastId = 'canopy-schema-outcome-unknown',
    }) => {
      const run = async (onSchemaChange: () => unknown) => {
        const { result } = renderHook(
          () => useSchemaManager({ branchName: 'main', onSchemaChange }),
          { wrapper },
        )
        let outcome: Awaited<ReturnType<typeof call>> = { ok: true }
        await act(async () => {
          outcome = await call(result.current)
        })
        return outcome
      }

      // An unanswered write may have landed, so it is neither a plain failure nor a success.
      const expectUnanswered = (outcome: unknown) => {
        expect(outcome).toEqual({ ok: false, error: WRITE_TIMED_OUT_MESSAGE, unanswered: true })
        expect(notifications.show).not.toHaveBeenCalledWith(
          expect.objectContaining({ color: 'red' }),
        )
        if (unknownToast) {
          expect(notifications.show).toHaveBeenCalledTimes(1)
          expect(notifications.show).toHaveBeenCalledWith(
            expect.objectContaining({
              id: unknownToastId,
              message: unknownToast,
              color: 'yellow',
              autoClose: false,
            }),
          )
        } else {
          expect(notifications.show).not.toHaveBeenCalled()
        }
      }

      it('reloads the content tree and reports a client timeout as unanswered', async () => {
        mock(mockClient).mockRejectedValueOnce(new ApiTimeoutError('POST', '/main/schema', 75_000))
        const onSchemaChange = vi.fn()

        expectUnanswered(await run(onSchemaChange))
        expect(onSchemaChange).toHaveBeenCalledTimes(1)
      })

      it("reloads the content tree and reports a gateway's 5xx page as unanswered", async () => {
        mock(mockClient).mockResolvedValueOnce(await gatewayPage(504))
        const onSchemaChange = vi.fn()

        expectUnanswered(await run(onSchemaChange))
        expect(onSchemaChange).toHaveBeenCalledTimes(1)
      })

      it('stays unanswered when the content tree reload rejects', async () => {
        mock(mockClient).mockResolvedValueOnce(await gatewayPage(502))
        // Not a `vi.fn`, which handles the rejection of a promise it returns.
        let reloads = 0
        const onSchemaChange = () => {
          reloads += 1
          return Promise.reject(new Error('still down'))
        }
        const unhandled: unknown[] = []
        const record = (reason: unknown) => unhandled.push(reason)
        process.on('unhandledRejection', record)

        try {
          expectUnanswered(await run(onSchemaChange))
          await new Promise((resolve) => setTimeout(resolve, 0))
        } finally {
          process.off('unhandledRejection', record)
        }

        expect(reloads).toBe(1)
        expect(unhandled).toEqual([])
      })

      it('reports a plain failure without reloading the content tree or marking it unanswered', async () => {
        mock(mockClient).mockResolvedValueOnce(mockError(400, 'x'))
        const onSchemaChange = vi.fn()

        const outcome = await run(onSchemaChange)

        expect(outcome).toEqual({ ok: false, error: 'x' })
        expect(outcome).not.toHaveProperty('unanswered')
        expect(onSchemaChange).not.toHaveBeenCalled()
        if (failureToast) {
          expect(notifications.show).toHaveBeenCalledTimes(1)
          expect(notifications.show).toHaveBeenCalledWith(
            expect.objectContaining({ color: 'red', message: failureToast }),
          )
        } else {
          expect(notifications.show).not.toHaveBeenCalled()
        }
      })
    },
  )

  it('replaces an earlier outcome-unknown toast instead of stacking another', async () => {
    mockClient.schema.updateOrder.mockRejectedValue(
      new ApiTimeoutError('PATCH', '/main/schema/order', 75_000),
    )
    const { result } = renderHook(() => useSchemaManager({ branchName: 'main' }), { wrapper })

    await act(async () => {
      await result.current.updateOrder(unsafeAsLogicalPath('posts'), ['a'])
    })
    await act(async () => {
      await result.current.updateOrder(unsafeAsLogicalPath('posts'), ['b'])
    })

    expect(notifications.hide).toHaveBeenCalledTimes(2)
    expect(notifications.hide).toHaveBeenCalledWith('canopy-schema-outcome-unknown')
  })

  describe('isLoading state', () => {
    it('sets isLoading during operations', async () => {
      let resolvePromise: (value: unknown) => void
      const promise = new Promise((resolve) => {
        resolvePromise = resolve
      })
      mockClient.schema.createCollection.mockReturnValueOnce(promise as any)

      const { result } = renderHook(() => useSchemaManager({ branchName: 'main' }), { wrapper })

      expect(result.current.isLoading).toBe(false)

      // Start operation
      let createPromise: Promise<unknown>
      act(() => {
        createPromise = result.current.createCollection({
          name: 'posts',
          entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
        })
      })

      // Should be loading
      expect(result.current.isLoading).toBe(true)

      // Complete the operation
      await act(async () => {
        resolvePromise!(
          mockSuccess({
            collectionPath: unsafeAsLogicalPath('posts'),
            contentId: unsafeAsContentId('abc123'),
          }),
        )
        await createPromise
      })

      // Should no longer be loading
      expect(result.current.isLoading).toBe(false)
    })
  })
})
