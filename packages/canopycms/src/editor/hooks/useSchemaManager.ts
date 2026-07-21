import { useState, useCallback } from 'react'
import { notifications } from '@mantine/notifications'
import { useApiClient } from '../context'
import type {
  CreateCollectionInput,
  UpdateCollectionInput,
  CreateEntryTypeInput,
  UpdateEntryTypeInput,
} from '../../api'
import type { LogicalPath, ContentId } from '../../paths/types'
import { getErrorMessage } from '../../utils/error'

export interface UseSchemaManagerOptions {
  branchName: string
  onSchemaChange?: () => void
}

/**
 * Result of a schema mutation that has no success payload. Callers branch on
 * `ok` to get a real error message instead of a bare `false`/`null` — see
 * PR #106 review follow-up item 7: `useSchemaManager` used to swallow every
 * failure into a toast, leaving catch blocks in `Editor`/`CollectionEditor`
 * with nothing but a hardcoded generic message (or no inline error at all).
 * Result objects (rather than rethrowing) keep fire-and-forget call sites
 * (e.g. `updateOrder` from a reorder click) compiling without turning them
 * into unhandled rejections.
 */
export type SchemaOpResult = { ok: true } | { ok: false; error: string }

/** Same shape as {@link SchemaOpResult}, plus a payload on success. */
export type CreateCollectionResult =
  | { ok: true; data: { collectionPath: LogicalPath; contentId: ContentId } }
  | { ok: false; error: string }

export interface UseSchemaManagerReturn {
  // Collection operations
  createCollection: (input: CreateCollectionInput) => Promise<CreateCollectionResult>
  updateCollection: (
    collectionPath: LogicalPath,
    updates: UpdateCollectionInput,
  ) => Promise<SchemaOpResult>
  deleteCollection: (collectionPath: LogicalPath) => Promise<SchemaOpResult>

  // Entry type operations
  addEntryType: (
    collectionPath: LogicalPath,
    entryType: CreateEntryTypeInput,
  ) => Promise<SchemaOpResult>
  updateEntryType: (
    collectionPath: LogicalPath,
    entryTypeName: string,
    updates: UpdateEntryTypeInput,
  ) => Promise<SchemaOpResult>
  removeEntryType: (collectionPath: LogicalPath, entryTypeName: string) => Promise<SchemaOpResult>

  // Order operations
  updateOrder: (collectionPath: LogicalPath, order: string[]) => Promise<SchemaOpResult>

  // Delete entry
  deleteEntry: (entryPath: LogicalPath) => Promise<SchemaOpResult>

  // State
  isLoading: boolean
}

/**
 * Hook for managing schema operations (collections, entry types, ordering).
 *
 * Provides methods to create, update, and delete collections and entry types.
 * All operations require admin permissions on the server.
 *
 * @example
 * ```tsx
 * const {
 *   createCollection,
 *   deleteCollection,
 *   addEntryType,
 *   updateOrder,
 *   isLoading
 * } = useSchemaManager({ branchName: 'main', onSchemaChange: refreshEntries })
 *
 * // Create a new collection
 * await createCollection({
 *   name: 'posts',
 *   label: 'Blog Posts',
 *   entries: [{ name: 'post', format: 'mdx', schema: 'postSchema' }]
 * })
 * ```
 */
export function useSchemaManager(options: UseSchemaManagerOptions): UseSchemaManagerReturn {
  const apiClient = useApiClient()
  const [isLoading, setIsLoading] = useState(false)

  // Toasts on every failure (relied on by fire-and-forget callers that ignore
  // the returned result) and returns the underlying message so callers that
  // do inspect the result can also surface it inline (e.g. in a modal).
  const handleError = useCallback((message: string, error: unknown): string => {
    console.error(message, error)
    const errorMessage = getErrorMessage(error)
    notifications.show({
      title: 'Error',
      message: `${message}: ${errorMessage}`,
      color: 'red',
    })
    return errorMessage
  }, [])

  const createCollection = useCallback(
    async (input: CreateCollectionInput): Promise<CreateCollectionResult> => {
      setIsLoading(true)
      try {
        const result = await apiClient.schema.createCollection(
          { branch: options.branchName },
          input,
        )
        if (!result.ok || !result.data) {
          throw new Error(result.error || 'Failed to create collection')
        }
        notifications.show({
          message: `Collection "${input.name}" created`,
          color: 'green',
        })
        options.onSchemaChange?.()
        return { ok: true, data: result.data }
      } catch (error) {
        return { ok: false, error: handleError('Failed to create collection', error) }
      } finally {
        setIsLoading(false)
      }
    },
    [apiClient, options.branchName, options.onSchemaChange, handleError],
  )

  const updateCollection = useCallback(
    async (
      collectionPath: LogicalPath,
      updates: UpdateCollectionInput,
    ): Promise<SchemaOpResult> => {
      setIsLoading(true)
      try {
        const result = await apiClient.schema.updateCollection(
          { branch: options.branchName, collectionPath },
          updates,
        )
        if (!result.ok) {
          throw new Error(result.error || 'Failed to update collection')
        }
        notifications.show({
          message: 'Collection updated',
          color: 'green',
        })
        await options.onSchemaChange?.()
        return { ok: true }
      } catch (error) {
        return { ok: false, error: handleError('Failed to update collection', error) }
      } finally {
        setIsLoading(false)
      }
    },
    [apiClient, options.branchName, options.onSchemaChange, handleError],
  )

  const deleteCollection = useCallback(
    async (collectionPath: LogicalPath): Promise<SchemaOpResult> => {
      setIsLoading(true)
      try {
        const result = await apiClient.schema.deleteCollection({
          branch: options.branchName,
          collectionPath,
        })
        if (!result.ok) {
          throw new Error(result.error || 'Failed to delete collection')
        }
        notifications.show({
          message: 'Collection deleted',
          color: 'green',
        })
        options.onSchemaChange?.()
        return { ok: true }
      } catch (error) {
        return { ok: false, error: handleError('Failed to delete collection', error) }
      } finally {
        setIsLoading(false)
      }
    },
    [apiClient, options.branchName, options.onSchemaChange, handleError],
  )

  const addEntryType = useCallback(
    async (
      collectionPath: LogicalPath,
      entryType: CreateEntryTypeInput,
    ): Promise<SchemaOpResult> => {
      setIsLoading(true)
      try {
        const result = await apiClient.schema.addEntryType(
          { branch: options.branchName, collectionPath },
          entryType,
        )
        if (!result.ok) {
          throw new Error(result.error || 'Failed to add entry type')
        }
        notifications.show({
          message: `Entry type "${entryType.name}" added`,
          color: 'green',
        })
        options.onSchemaChange?.()
        return { ok: true }
      } catch (error) {
        return { ok: false, error: handleError('Failed to add entry type', error) }
      } finally {
        setIsLoading(false)
      }
    },
    [apiClient, options.branchName, options.onSchemaChange, handleError],
  )

  const updateEntryType = useCallback(
    async (
      collectionPath: LogicalPath,
      entryTypeName: string,
      updates: UpdateEntryTypeInput,
    ): Promise<SchemaOpResult> => {
      setIsLoading(true)
      try {
        const result = await apiClient.schema.updateEntryType(
          { branch: options.branchName, collectionPath, entryTypeName },
          updates,
        )
        if (!result.ok) {
          throw new Error(result.error || 'Failed to update entry type')
        }
        notifications.show({
          message: 'Entry type updated',
          color: 'green',
        })
        options.onSchemaChange?.()
        return { ok: true }
      } catch (error) {
        return { ok: false, error: handleError('Failed to update entry type', error) }
      } finally {
        setIsLoading(false)
      }
    },
    [apiClient, options.branchName, options.onSchemaChange, handleError],
  )

  const removeEntryType = useCallback(
    async (collectionPath: LogicalPath, entryTypeName: string): Promise<SchemaOpResult> => {
      setIsLoading(true)
      try {
        const result = await apiClient.schema.removeEntryType({
          branch: options.branchName,
          collectionPath,
          entryTypeName,
        })
        if (!result.ok) {
          throw new Error(result.error || 'Failed to remove entry type')
        }
        notifications.show({
          message: `Entry type "${entryTypeName}" removed`,
          color: 'green',
        })
        options.onSchemaChange?.()
        return { ok: true }
      } catch (error) {
        return { ok: false, error: handleError('Failed to remove entry type', error) }
      } finally {
        setIsLoading(false)
      }
    },
    [apiClient, options.branchName, options.onSchemaChange, handleError],
  )

  const updateOrder = useCallback(
    async (collectionPath: LogicalPath, order: string[]): Promise<SchemaOpResult> => {
      setIsLoading(true)
      try {
        const result = await apiClient.schema.updateOrder(
          { branch: options.branchName, collectionPath },
          { order },
        )
        if (!result.ok) {
          throw new Error(result.error || 'Failed to update order')
        }
        // Silent success for order updates (common operation)
        options.onSchemaChange?.()
        return { ok: true }
      } catch (error) {
        return { ok: false, error: handleError('Failed to update order', error) }
      } finally {
        setIsLoading(false)
      }
    },
    [apiClient, options.branchName, options.onSchemaChange, handleError],
  )

  const deleteEntry = useCallback(
    async (entryPath: LogicalPath): Promise<SchemaOpResult> => {
      setIsLoading(true)
      try {
        const result = await apiClient.entries.delete({
          branch: options.branchName,
          entryPath,
        })
        if (!result.ok) {
          throw new Error(result.error || 'Failed to delete entry')
        }
        notifications.show({
          message: 'Entry deleted',
          color: 'green',
        })
        options.onSchemaChange?.()
        return { ok: true }
      } catch (error) {
        return { ok: false, error: handleError('Failed to delete entry', error) }
      } finally {
        setIsLoading(false)
      }
    },
    [apiClient, options.branchName, options.onSchemaChange, handleError],
  )

  return {
    createCollection,
    updateCollection,
    deleteCollection,
    addEntryType,
    updateEntryType,
    removeEntryType,
    updateOrder,
    deleteEntry,
    isLoading,
  }
}
