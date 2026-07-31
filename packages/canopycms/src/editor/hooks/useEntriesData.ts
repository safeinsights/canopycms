'use client'

/**
 * Fetch/key/type pieces for a branch's schema + entry list (GET
 * /:branch/schema, GET /:branch/entries, paginated) -- consumed by
 * useEntryManager.ts, which owns BOTH the automatic useSWR call (with its
 * tagged cache values, see the note at the bottom of this file) and the
 * imperative reload path (`refreshEntries`) with its out-of-order-response
 * guard.
 *
 * Combines schema and entries into one fetch because building EditorEntry/
 * EditorCollection objects requires the hydrated flatSchema either way (see
 * `fetchEntriesAndSchema`). This is also the single source of truth for
 * `availableSchemas` (the entry-type schema names, keyed off the same
 * schema response) -- Editor.tsx used to fetch schema a second time on its
 * own just to compute this list; it now reads it off useEntryManager's
 * return value instead, eliminating that duplicate request.
 */

import { notifications } from '@mantine/notifications'
import { MAX_ENTRIES_PER_PAGE } from '../../api/entries-constants'
import type { CollectionItem, ListEntriesResponse } from '../../api/entries'
import type { ApiClient } from '../context'
import type { EditorEntry, EditorCollection } from '../Editor'
import { buildEntriesFromListResponse } from '../editor-utils'

/** Page size for entry list requests -- the server's per-page cap, imported to avoid drift. */
const ENTRIES_PAGE_LIMIT = MAX_ENTRIES_PER_PAGE
/** Safety cap on pagination: 50 pages x 200 = 10,000 entries. */
const MAX_ENTRY_PAGES = 50

/** Cache key for a branch's combined schema + entries data. */
export const entriesKey = (branch: string): string => `canopy:entries:${branch}`

export interface EntriesData {
  collections: EditorCollection[]
  entries: EditorEntry[]
  /** Entry-type schema names available on this branch (from entrySchemas' keys). */
  availableSchemas: string[]
}

export interface FetchEntriesParams {
  resolvePreviewSrc: (entry: Partial<EditorEntry>) => string | undefined
  contentRoot?: string
}

/**
 * Fetch every entry on a branch by following the list endpoint's pagination
 * cursor. Deduped by logicalPath: the cursor is offset-based, so an item can
 * repeat across pages if content changes between requests.
 *
 * Exported for direct unit testing.
 */
export async function listAllEntries(
  apiClient: { entries: Pick<ApiClient['entries'], 'list'> },
  branch: string,
): Promise<{ entries: CollectionItem[]; truncated: boolean }> {
  const byPath = new Map<string, CollectionItem>()
  let cursor: string | undefined
  for (let page = 0; page < MAX_ENTRY_PAGES; page++) {
    const result = await apiClient.entries.list({
      branch,
      limit: String(ENTRIES_PAGE_LIMIT),
      ...(cursor !== undefined ? { cursor } : {}),
    })
    if (!result.ok || !result.data) throw new Error(`Refresh failed: ${result.status}`)
    const data = result.data as ListEntriesResponse
    for (const entry of data.entries) byPath.set(entry.logicalPath, entry)
    if (!data.pagination?.hasMore || !data.pagination.cursor) {
      return { entries: [...byPath.values()], truncated: false }
    }
    cursor = data.pagination.cursor
  }
  return { entries: [...byPath.values()], truncated: true }
}

/**
 * Fetch a branch's schema and full entry list, and build the EditorEntry/
 * EditorCollection objects the editor renders. Exported for direct testing
 * and for the imperative reload path (useEntryManager.refreshEntries).
 */
export async function fetchEntriesAndSchema(
  apiClient: Pick<ApiClient, 'schema' | 'entries'>,
  branch: string,
  params: FetchEntriesParams,
): Promise<EntriesData> {
  // Fetch schema from schema API
  const schemaResult = await apiClient.schema.get({ branch })
  if (!schemaResult.ok || !schemaResult.data) {
    throw new Error(`Schema fetch failed: ${schemaResult.status}`)
  }

  // Hydrate wire flatSchema: resolve schemaRef -> schema from entrySchemas dict
  const { entrySchemas } = schemaResult.data
  const hydratedFlatSchema = schemaResult.data.flatSchema.map((item) =>
    item.type === 'entry-type' ? { ...item, schema: entrySchemas[item.schemaRef] ?? [] } : item,
  ) as import('../../config').FlatSchemaItem[]

  // Build editor collections from hydrated flatSchema
  // Dynamic import: lazy-load heavier editor config; only needed after API data arrives
  const { buildEditorCollections } = await import('../editor-config')
  const collections = buildEditorCollections(hydratedFlatSchema)

  // Fetch ALL entries, following the pagination cursor
  const { entries: allEntries, truncated } = await listAllEntries(apiClient, branch)
  if (truncated) {
    console.warn(
      `Entry list truncated at ${MAX_ENTRY_PAGES * ENTRIES_PAGE_LIMIT} entries for branch "${branch}"`,
    )
    notifications.show({
      title: 'Entry list truncated',
      message: `Showing the first ${(MAX_ENTRY_PAGES * ENTRIES_PAGE_LIMIT).toLocaleString()} entries.`,
      color: 'yellow',
    })
  }

  // Build entries with resolved schemas from flatSchema
  const entries = buildEntriesFromListResponse({
    response: {
      entries: allEntries,
      pagination: { hasMore: false, limit: ENTRIES_PAGE_LIMIT },
    },
    branchName: branch,
    resolvePreviewSrc: (entry) => params.resolvePreviewSrc(entry) ?? '',
    contentRoot: params.contentRoot || 'content',
    flatSchema: hydratedFlatSchema,
  })

  return { collections, entries, availableSchemas: Object.keys(entrySchemas) }
}

// NOTE: there is deliberately NO generic `useEntriesData(apiClient, branch)`
// wrapper hook here (there briefly was one, never mounted by anything).
// useEntryManager owns the only useSWR call for `entriesKey` slots, and it
// stores TAGGED values there — `{ fetched, seq, branch }`, not bare
// EntriesData (see its refreshSeqRef doc comment). A second hook fetching
// the same key with an untagged fetcher would overwrite the tagged slot
// with a value the commit effect silently ignores.
