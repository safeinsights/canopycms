import { useState, useCallback } from 'react'
import { notifications } from '@mantine/notifications'
import { useApiClient } from '../context'
import type {
  CreateCollectionInput,
  UpdateCollectionInput,
  CreateEntryTypeInput,
  UpdateEntryTypeInput,
} from '../../api'
import type { EntryReferencedBy } from '../../api/entries'
import type { LogicalPath, ContentId } from '../../paths/types'
import { getErrorMessage } from '../../utils/error'
import { isGatewayFailure, isUnanswered, UnansweredError } from '../unanswered'

export interface UseSchemaManagerOptions {
  branchName: string
  onSchemaChange?: () => void
}

/**
 * Result of a schema mutation that has no success payload. Callers branch on
 * `ok` to get a real error message instead of a bare `false`/`null`: every
 * operation returns a result object rather than throwing, so a failure is
 * surfaced per call site instead of collapsing into one generic toast.
 * Result objects (rather than rethrowing) also keep fire-and-forget call
 * sites (e.g. `updateOrder` from a reorder click) compiling without turning
 * them into unhandled rejections.
 */
export type SchemaOpResult = { ok: true } | SchemaOpFailure

/**
 * `unanswered`: the write timed out or got a gateway's 5xx page, so it may have landed
 * (`editor/unanswered.ts`); `onSchemaChange` has been called so the content tree shows which.
 */
type SchemaOpFailure = { ok: false; error: string; unanswered?: true }

const SCHEMA_OUTCOME_UNKNOWN_TOAST_ID = 'canopy-schema-outcome-unknown'
const CHECK_CONTENT_PANEL = 'Check the "Content" panel'

/** @internal Exported for tests. */
export const schemaChangeOutcomeUnknown = (action: string, check: string) =>
  `${action} may have gone through even though the server didn't answer. ${check} before trying again.`

/**
 * {@link SchemaOpResult}, or a refusal because other entries reference the one being deleted.
 * That refusal shows no toast: the caller asks the user, then retries with `confirmReferenced`.
 */
type DeleteEntryResult =
  | SchemaOpResult
  | { ok: false; error: string; referencedBy: EntryReferencedBy }

/** Same shape as {@link SchemaOpResult}, plus a payload on success. */
type CreateCollectionResult =
  | { ok: true; data: { collectionPath: LogicalPath; contentId: ContentId } }
  | SchemaOpFailure

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
  deleteEntry: (
    entryPath: LogicalPath,
    options?: { confirmReferenced?: boolean },
  ) => Promise<DeleteEntryResult>

  // State
  isLoading: boolean
}

/**
 * Hook for managing schema operations (collections, entry types, ordering).
 *
 * All operations require admin permissions on the server.
 */
export function useSchemaManager(options: UseSchemaManagerOptions): UseSchemaManagerReturn {
  const apiClient = useApiClient()
  const [isLoading, setIsLoading] = useState(false)

  // Collection, order and entry operations toast each failure that reaches here
  // (relied on by fire-and-forget callers that ignore the returned result).
  // Entry-type operations pass `toast: false`: their only caller,
  // CollectionEditor, shows each result inline. Both return the underlying
  // message for callers that surface it themselves.
  const handleError = useCallback(
    (message: string, error: unknown, { toast = true }: { toast?: boolean } = {}): string => {
      console.error(message, error)
      const errorMessage = getErrorMessage(error)
      if (toast) {
        notifications.show({
          title: 'Error',
          message: `${message}: ${errorMessage}`,
          color: 'red',
        })
      }
      return errorMessage
    },
    [],
  )

  /**
   * The failure result for a write. An unanswered one may have landed, so the content tree
   * reloads, and its toast (only with `unknown`) says to check rather than that it failed.
   */
  const fail = useCallback(
    (
      error: unknown,
      message: string,
      { toast = true, unknown }: { toast?: boolean; unknown?: string } = {},
    ): SchemaOpFailure => {
      if (!isUnanswered(error)) return { ok: false, error: handleError(message, error, { toast }) }
      console.error(message, error)
      void Promise.resolve(options.onSchemaChange?.()).catch(console.error)
      if (unknown) {
        notifications.hide(SCHEMA_OUTCOME_UNKNOWN_TOAST_ID)
        notifications.show({
          id: SCHEMA_OUTCOME_UNKNOWN_TOAST_ID,
          message: unknown,
          color: 'yellow',
          autoClose: false,
          withCloseButton: true,
        })
      }
      return { ok: false, error: getErrorMessage(error), unanswered: true }
    },
    [options.onSchemaChange, handleError],
  )

  const createCollection = useCallback(
    async (input: CreateCollectionInput): Promise<CreateCollectionResult> => {
      setIsLoading(true)
      try {
        const result = await apiClient.schema.createCollection(
          { branch: options.branchName },
          input,
        )
        if (isGatewayFailure(result)) throw new UnansweredError()
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
        return fail(error, 'Failed to create collection', {
          unknown: schemaChangeOutcomeUnknown('Creating the collection', CHECK_CONTENT_PANEL),
        })
      } finally {
        setIsLoading(false)
      }
    },
    [apiClient, options.branchName, options.onSchemaChange, fail],
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
        if (isGatewayFailure(result)) throw new UnansweredError()
        if (!result.ok) {
          throw new Error(result.error || 'Failed to update collection')
        }
        notifications.show({
          message: 'Collection updated',
          color: 'green',
        })
        // The write landed, so a failed refresh is logged rather than reported as its failure.
        await Promise.resolve(options.onSchemaChange?.()).catch(console.error)
        return { ok: true }
      } catch (error) {
        return fail(error, 'Failed to update collection', {
          unknown: schemaChangeOutcomeUnknown(
            'Saving collection details',
            'Reopen the collection to check',
          ),
        })
      } finally {
        setIsLoading(false)
      }
    },
    [apiClient, options.branchName, options.onSchemaChange, fail],
  )

  const deleteCollection = useCallback(
    async (collectionPath: LogicalPath): Promise<SchemaOpResult> => {
      setIsLoading(true)
      try {
        const result = await apiClient.schema.deleteCollection({
          branch: options.branchName,
          collectionPath,
        })
        if (isGatewayFailure(result)) throw new UnansweredError()
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
        return fail(error, 'Failed to delete collection', {
          unknown: schemaChangeOutcomeUnknown('Deleting the collection', CHECK_CONTENT_PANEL),
        })
      } finally {
        setIsLoading(false)
      }
    },
    [apiClient, options.branchName, options.onSchemaChange, fail],
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
        if (isGatewayFailure(result)) throw new UnansweredError()
        if (!result.ok) {
          throw new Error(result.error || 'Failed to add entry type')
        }
        options.onSchemaChange?.()
        return { ok: true }
      } catch (error) {
        return fail(error, 'Failed to add entry type', { toast: false })
      } finally {
        setIsLoading(false)
      }
    },
    [apiClient, options.branchName, options.onSchemaChange, fail],
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
        if (isGatewayFailure(result)) throw new UnansweredError()
        if (!result.ok) {
          throw new Error(result.error || 'Failed to update entry type')
        }
        options.onSchemaChange?.()
        return { ok: true }
      } catch (error) {
        return fail(error, 'Failed to update entry type', { toast: false })
      } finally {
        setIsLoading(false)
      }
    },
    [apiClient, options.branchName, options.onSchemaChange, fail],
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
        if (isGatewayFailure(result)) throw new UnansweredError()
        if (!result.ok) {
          throw new Error(result.error || 'Failed to remove entry type')
        }
        options.onSchemaChange?.()
        return { ok: true }
      } catch (error) {
        return fail(error, 'Failed to remove entry type', { toast: false })
      } finally {
        setIsLoading(false)
      }
    },
    [apiClient, options.branchName, options.onSchemaChange, fail],
  )

  const updateOrder = useCallback(
    async (collectionPath: LogicalPath, order: string[]): Promise<SchemaOpResult> => {
      setIsLoading(true)
      try {
        const result = await apiClient.schema.updateOrder(
          { branch: options.branchName, collectionPath },
          { order },
        )
        if (isGatewayFailure(result)) throw new UnansweredError()
        if (!result.ok) {
          throw new Error(result.error || 'Failed to update order')
        }
        // Silent success for order updates (common operation)
        options.onSchemaChange?.()
        return { ok: true }
      } catch (error) {
        return fail(error, 'Failed to update order', {
          unknown: schemaChangeOutcomeUnknown('Reordering entries', CHECK_CONTENT_PANEL),
        })
      } finally {
        setIsLoading(false)
      }
    },
    [apiClient, options.branchName, options.onSchemaChange, fail],
  )

  const deleteEntry = useCallback(
    async (
      entryPath: LogicalPath,
      deleteOptions?: { confirmReferenced?: boolean },
    ): Promise<DeleteEntryResult> => {
      setIsLoading(true)
      try {
        const result = await apiClient.entries.delete({
          branch: options.branchName,
          entryPath,
          ...(deleteOptions?.confirmReferenced ? { confirmReferenced: 'true' } : {}),
        })
        const referencedBy = result.data?.referencedBy
        if (!result.ok && referencedBy) {
          return { ok: false, error: result.error ?? 'Entry is referenced', referencedBy }
        }
        if (isGatewayFailure(result)) throw new UnansweredError()
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
        return fail(error, 'Failed to delete entry', {
          unknown: schemaChangeOutcomeUnknown('Deleting the entry', CHECK_CONTENT_PANEL),
        })
      } finally {
        setIsLoading(false)
      }
    },
    [apiClient, options.branchName, options.onSchemaChange, fail],
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
