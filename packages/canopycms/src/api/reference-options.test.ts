/**
 * The reference-options endpoint through `createCanopyRequestHandler({ config })`, the path that
 * builds its own services from config: `config.seo` must reach the `noindex` marker, and the
 * sort params must reach the resolver.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createTestWorkspace,
  type TestWorkspace,
} from '../__integration__/test-utils/test-workspace'
import { createMockAuthPlugin } from '../__integration__/test-utils/multi-user'
import { flattenSchema, type CanopyConfig } from '../config'
import { createCanopyRequestHandler } from '../http/handler'
import type { CanopyRequest } from '../http/types'
import type { BranchContextWithSchema } from '../types'
import type { ReferenceOptionsResponse } from './reference-options'

const schema = {
  collections: [
    {
      name: 'posts',
      path: 'posts',
      entries: [
        {
          name: 'post',
          format: 'json' as const,
          schema: [
            { name: 'title', type: 'string' as const },
            { name: 'publishedAt', type: 'string' as const },
            {
              name: 'seo',
              type: 'object' as const,
              fields: [{ name: 'noindex', type: 'boolean' as const, label: 'Hide from search' }],
            },
          ],
        },
      ],
    },
  ],
}

const posts: Array<[string, Record<string, unknown>]> = [
  ['pAAAAAAAAAA1', { title: 'Alpha', publishedAt: '2026-01-01' }],
  ['pAAAAAAAAAA2', { title: 'Bravo', publishedAt: '2026-03-01', seo: { noindex: true } }],
  ['pAAAAAAAAAA3', { title: 'Charlie', publishedAt: '2026-02-01' }],
]

describe('GET /:branch/reference-options through the { config } handler path', () => {
  let workspace: TestWorkspace
  let branchRoot: string

  beforeEach(async () => {
    workspace = await createTestWorkspace({ schema })
    branchRoot = path.join(workspace.tmpRoot, 'branch')
    const dir = path.join(branchRoot, 'content', 'posts')
    await fs.mkdir(dir, { recursive: true })
    for (const [id, data] of posts) {
      const slug = String(data.title).toLowerCase()
      await fs.writeFile(path.join(dir, `post.${slug}.${id}.json`), JSON.stringify(data))
    }
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  const get = async (config: CanopyConfig, query: string) => {
    const now = new Date().toISOString()
    const branchContext: BranchContextWithSchema = {
      baseRoot: branchRoot,
      branchRoot,
      branch: {
        name: 'main',
        status: 'editing',
        access: {},
        createdBy: 'tester',
        createdAt: now,
        updatedAt: now,
      },
      flatSchema: flattenSchema(schema, 'content'),
    }
    const handler = createCanopyRequestHandler({
      config,
      authPlugin: createMockAuthPlugin('editor'),
      getBranchContext: async (branch) => (branch === 'main' ? branchContext : null),
    })
    const req: CanopyRequest = {
      method: 'GET',
      url: `http://localhost/api/canopycms/main/reference-options?${query}`,
      header: () => null,
      json: async () => ({}),
    }
    return (await handler(req, ['main', 'reference-options'])) as {
      status: number
      body: ReferenceOptionsResponse
    }
  }

  it('marks noindex at config.seo and sorts by the requested field', async () => {
    const response = await get(
      { ...workspace.config, seo: { group: 'seo' } },
      'collections=posts&sort=field&sortField=publishedAt&sortDir=desc',
    )

    expect(response.status).toBe(200)
    expect(response.body.data?.options).toEqual([
      expect.objectContaining({ label: 'Bravo', noindex: { fieldLabel: 'Hide from search' } }),
      expect.objectContaining({ label: 'Charlie' }),
      expect.objectContaining({ label: 'Alpha' }),
    ])
    expect(response.body.data?.options.filter((o) => o.noindex)).toHaveLength(1)
  }, 60_000)

  it('does not see a grouped flag without config.seo', async () => {
    const response = await get(workspace.config, 'collections=posts')
    expect(response.body.data?.options.map((o) => o.label)).toEqual(['Alpha', 'Bravo', 'Charlie'])
    expect(response.body.data?.options.some((o) => o.noindex)).toBe(false)
  }, 60_000)

  it.each([
    ['sort=field', 'sortField'],
    ['sortField=publishedAt', 'sortField'],
    ['sort=label&sortDir=desc', 'sortDir'],
    ['sort=newest', 'newest'],
    ['sort=field&sortField=a..b', 'dotted path'],
  ])(
    'refuses %s with a 400',
    async (params, message) => {
      const response = await get(workspace.config, `collections=posts&${params}`)
      expect(response.status).toBe(400)
      expect(response.body.error).toContain(message)
    },
    60_000,
  )
})
