import { useState, useCallback } from 'react'
import { notifications } from '@mantine/notifications'
import { useApiClient } from '../context'
import type {
  CreateCollectionInput,
  UpdateCollectionInput,
  CreateEntryTypeInput,
  UpdateEntryTypeInput,
} from '../../api'

export interface UseSchemaManagerOptions {
  branchName: string
  onSchemaChange?: () => void
}

export interface UseSchemaManagerReturn {
  // Collection operations
  createCollection: (input: CreateCollectionInput) => Promise<{ collectionPath: string; contentId: string } | null>
  updateCollection: (collectionPath: string, updates: UpdateCollectionInput) => Promise<boolean>
  deleteCollection: (collectionPath: string) => Promise<boolean>

  // Entry type operations
  addEntryType: (collectionPath: string, entryType: CreateEntryTypeInput) => Promise<boolean>
  updateEntryType: (collectionPath: string, entryTypeName: string, updates: UpdateEntryTypeInput) => Promise<boolean>
  removeEntryType: (collectionPath: string, entryTypeName: string) => Promise<boolean>

  // Order operations
  updateOrder: (collectionPath: string, order: string[]) => Promise<boolean>

  // Delete entry
  deleteEntry: (entryPath: string) => Promise<boolean>

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
 *   entries: [{ name: 'post', format: 'mdx', fields: 'postSchema' }]
 * })
 * ```
 */
export function useSchemaManager(options: UseSchemaManagerOptions): UseSchemaManagerReturn {
  const apiClient = useApiClient()
  const [isLoading, setIsLoading] = useState(false)

  const handleError = useCallback((message: string, error: unknown) => {
    console.error(message, error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    notifications.show({
      title: 'Error',
      message: `${message}: ${errorMessage}`,
      color: 'red',
    })
  }, [])

  const createCollection = useCallback(
    async (input: CreateCollectionInput) => {
      setIsLoading(true)
      try {
        const result = await apiClient.schema.createCollection(
          { branch: options.branchName },
          input
        )
        if (!result.ok || !result.data) {
          throw new Error(result.error || 'Failed to create collection')
        }
        notifications.show({
          message: `Collection "${input.name}" created`,
          color: 'green',
        })
        options.onSchemaChange?.()
        return result.data
      } catch (error) {
        handleError('Failed to create collection', error)
        return null
      } finally {
        setIsLoading(false)
      }
    },
    [apiClient, options.branchName, options.onSchemaChange, handleError]
  )

  const updateCollection = useCallback(
    async (collectionPath: string, updates: UpdateCollectionInput) => {
      setIsLoading(true)
      try {
        const result = await apiClient.schema.updateCollection(
          { branch: options.branchName, collectionPath },
          updates
        )
        if (!result.ok) {
          throw new Error(result.error || 'Failed to update collection')
        }
        notifications.show({
          message: 'Collection updated',
          color: 'green',
        })
        await options.onSchemaChange?.()
        return true
      } catch (error) {
        handleError('Failed to update collection', error)
        return false
      } finally {
        setIsLoading(false)
      }
    },
    [apiClient, options.branchName, options.onSchemaChange, handleError]
  )

  const deleteCollection = useCallback(
    async (collectionPath: string) => {
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
        return true
      } catch (error) {
        handleError('Failed to delete collection', error)
        return false
      } finally {
        setIsLoading(false)
      }
    },
    [apiClient, options.branchName, options.onSchemaChange, handleError]
  )

  const addEntryType = useCallback(
    async (collectionPath: string, entryType: CreateEntryTypeInput) => {
      setIsLoading(true)
      try {
        const result = await apiClient.schema.addEntryType(
          { branch: options.branchName, collectionPath },
          entryType
        )
        if (!result.ok) {
          throw new Error(result.error || 'Failed to add entry type')
        }
        notifications.show({
          message: `Entry type "${entryType.name}" added`,
          color: 'green',
        })
        options.onSchemaChange?.()
        return true
      } catch (error) {
        handleError('Failed to add entry type', error)
        return false
      } finally {
        setIsLoading(false)
      }
    },
    [apiClient, options.branchName, options.onSchemaChange, handleError]
  )

  const updateEntryType = useCallback(
    async (collectionPath: string, entryTypeName: string, updates: UpdateEntryTypeInput) => {
      setIsLoading(true)
      try {
        const result = await apiClient.schema.updateEntryType(
          { branch: options.branchName, collectionPath, entryTypeName },
          updates
        )
        if (!result.ok) {
          throw new Error(result.error || 'Failed to update entry type')
        }
        notifications.show({
          message: 'Entry type updated',
          color: 'green',
        })
        options.onSchemaChange?.()
        return true
      } catch (error) {
        handleError('Failed to update entry type', error)
        return false
      } finally {
        setIsLoading(false)
      }
    },
    [apiClient, options.branchName, options.onSchemaChange, handleError]
  )

  const removeEntryType = useCallback(
    async (collectionPath: string, entryTypeName: string) => {
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
        return true
      } catch (error) {
        handleError('Failed to remove entry type', error)
        return false
      } finally {
        setIsLoading(false)
      }
    },
    [apiClient, options.branchName, options.onSchemaChange, handleError]
  )

  const updateOrder = useCallback(
    async (collectionPath: string, order: string[]) => {
      setIsLoading(true)
      try {
        const result = await apiClient.schema.updateOrder(
          { branch: options.branchName, collectionPath },
          { order }
        )
        if (!result.ok) {
          throw new Error(result.error || 'Failed to update order')
        }
        // Silent success for order updates (common operation)
        options.onSchemaChange?.()
        return true
      } catch (error) {
        handleError('Failed to update order', error)
        return false
      } finally {
        setIsLoading(false)
      }
    },
    [apiClient, options.branchName, options.onSchemaChange, handleError]
  )

  const deleteEntry = useCallback(
    async (entryPath: string) => {
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
        return true
      } catch (error) {
        handleError('Failed to delete entry', error)
        return false
      } finally {
        setIsLoading(false)
      }
    },
    [apiClient, options.branchName, options.onSchemaChange, handleError]
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
