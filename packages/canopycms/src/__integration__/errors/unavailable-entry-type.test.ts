/**
 * An entry type whose entry schema the running code lacks (content synced ahead of the image
 * defining it) costs only that entry type: every operation on it answers a retriable 503 with
 * code SCHEMA_UNAVAILABLE, and the rest of the branch works. Through the HTTP API.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { createTestWorkspace, type TestWorkspace } from '../test-utils/test-workspace'
import { createMockAuthPlugin } from '../test-utils/multi-user'
import { createApiClient } from '../test-utils/api-client'
import type { ApiResponse } from '../../api/types'
import type { EntryTypeConfig, FieldConfig, RootCollectionConfig } from '../../config'

const BRANCH = 'feature-unavailable'
const nameFields: FieldConfig[] = [{ name: 'name', type: 'string' }]
const entrySchemaRegistry = { nameSchema: nameFields }

const contributor = (available: boolean): EntryTypeConfig =>
  available
    ? { name: 'contributor', format: 'json', schema: nameFields, schemaRef: 'nameSchema' }
    : {
        name: 'contributor',
        format: 'json',
        schema: [],
        schemaRef: 'contributorSchema',
        unavailable: {
          reason: 'unknown-schema',
          schemaRef: 'contributorSchema',
          metaFile: 'people/.collection.json',
        },
      }

const schemaWith = (available: boolean): RootCollectionConfig => ({
  collections: [
    {
      name: 'people',
      path: 'people',
      entries: [
        {
          name: 'staff',
          format: 'json',
          schema: nameFields,
          schemaRef: 'nameSchema',
          default: true,
        },
        contributor(available),
      ],
    },
  ],
})

describe('an unavailable entry type, through the API', () => {
  let workspace: TestWorkspace
  let degraded: Awaited<ReturnType<typeof createApiClient>>

  const url = (route: string, entry: string) =>
    `/api/canopycms/${BRANCH}/${route}/content/people/${entry}`

  const expectUnavailable = (res: { status: number; body: unknown }) => {
    expect(res.status).toBe(503)
    const body = res.body as ApiResponse
    expect(body.code).toBe('SCHEMA_UNAVAILABLE')
    expect(body.error).toMatch(/doesn't know yet \("contributorSchema"/)
  }

  beforeEach(async () => {
    workspace = await createTestWorkspace({ schema: schemaWith(true) })
    const healthy = await createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('admin'),
      schema: schemaWith(true),
    })
    expect(
      (await healthy.post('/api/canopycms/branches', { branch: BRANCH, title: 'U' })).status,
    ).toBe(200)
    const ada = await healthy.put(`${url('content', 'ada')}?entryType=contributor`, {
      format: 'json',
      data: { name: 'Ada' },
      expectedVersion: null,
    })
    expect(ada.status).toBe(200)
    const grace = await healthy.put(`${url('content', 'grace')}?entryType=staff`, {
      format: 'json',
      data: { name: 'Grace' },
      expectedVersion: null,
    })
    expect(grace.status).toBe(200)

    degraded = await createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('admin'),
      schema: schemaWith(false),
      entrySchemaRegistry,
    })
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('answers a read, save, create, rename or delete of one with the retriable 503', async () => {
    expectUnavailable(await degraded.get(url('content', 'ada')))
    expectUnavailable(
      await degraded.put(url('content', 'ada'), { format: 'json', data: { name: 'X' } }),
    )
    expectUnavailable(
      await degraded.put(`${url('content', 'new')}?entryType=contributor`, {
        format: 'json',
        data: { name: 'New' },
        expectedVersion: null,
      }),
    )
    expectUnavailable(await degraded.patch(url('rename-entry', 'ada'), { newSlug: 'lovelace' }))
    expectUnavailable(await degraded.delete(url('entries', 'ada')))
  })

  it('leaves the rest of the branch working', async () => {
    const grace = await degraded.get(url('content', 'grace'))
    expect(grace.status).toBe(200)

    const list = await degraded.get(`/api/canopycms/${BRANCH}/entries`)
    expect(list.status).toBe(200)

    const schema = await degraded.get(`/api/canopycms/${BRANCH}/schema`)
    expect(schema.status).toBe(200)
    const flat = (schema.body as ApiResponse<{ flatSchema: Array<Record<string, unknown>> }>).data
      ?.flatSchema
    expect(flat?.find((item) => item.name === 'contributor')).toMatchObject({
      schemaRef: 'contributorSchema',
      unavailable: { reason: 'unknown-schema', schemaRef: 'contributorSchema' },
    })
  })
})
