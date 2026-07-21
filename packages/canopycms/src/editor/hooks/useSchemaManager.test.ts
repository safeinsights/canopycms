// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSchemaManager } from './useSchemaManager'
import type { MockApiClient } from '../../api/__test__/mock-client'
import { setupMockApiClient, createApiClientWrapper } from './__test__/test-utils'
import { mockSuccess, mockError } from '../../api/__test__/mock-client'
import { unsafeAsLogicalPath, unsafeAsContentId } from '../../paths/test-utils'
import { mockConsole } from '../../test-utils/console-spy'

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
