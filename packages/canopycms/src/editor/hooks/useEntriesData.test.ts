import { describe, expect, it, vi } from 'vitest'

import type { ApiClient } from '../context'
import { mockSuccess } from '../../api/__test__/mock-client'
import { fetchEntriesAndSchema } from './useEntriesData'
import {
  unsafeAsContentId,
  unsafeAsLogicalPath,
  unsafeAsPhysicalPath,
  unsafeAsSlug,
} from '../../paths/test-utils'

const unavailable = {
  reason: 'unknown-schema' as const,
  schemaRef: 'widgetSchema',
  metaFile: 'content/widgets/.collection.json',
}

function clientWithUnavailableWidget() {
  return {
    schema: {
      get: vi.fn().mockResolvedValue(
        mockSuccess({
          flatSchema: [
            {
              type: 'collection',
              logicalPath: unsafeAsLogicalPath('widgets'),
              name: 'widgets',
              entries: [{ name: 'widget', format: 'json', schemaRef: 'widgetSchema', unavailable }],
            },
            {
              type: 'entry-type',
              logicalPath: unsafeAsLogicalPath('widgets/widget'),
              name: 'widget',
              parentPath: unsafeAsLogicalPath('widgets'),
              format: 'json',
              schemaRef: 'widgetSchema',
              unavailable,
            },
          ],
          entrySchemas: {},
        }),
      ),
    },
    entries: {
      list: vi.fn().mockResolvedValue(
        mockSuccess({
          entries: [
            {
              logicalPath: unsafeAsLogicalPath('widgets/first'),
              contentId: unsafeAsContentId('firstxxxxxxx'),
              slug: unsafeAsSlug('first'),
              collectionPath: unsafeAsLogicalPath('widgets'),
              collectionName: 'Widgets',
              format: 'json',
              entryType: 'widget',
              physicalPath: unsafeAsPhysicalPath('content/widgets/first.json'),
              exists: true,
            },
          ],
          pagination: { hasMore: false, limit: 200 },
        }),
      ),
    },
  } as unknown as Pick<ApiClient, 'schema' | 'entries'>
}

describe('fetchEntriesAndSchema: unavailable entry types', () => {
  it('carries unavailable to the collection entry type and to the entries of that type', async () => {
    const data = await fetchEntriesAndSchema(clientWithUnavailableWidget(), 'main', {
      resolvePreviewSrc: () => undefined,
    })

    expect(data.collections[0].entryTypes?.[0].unavailable).toEqual(unavailable)
    expect(data.entries[0].unavailable).toEqual(unavailable)
    expect(data.entries[0].schema).toEqual([])
  })
})
