import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { RESOLVE_REFERENCES_ROUTES } from './resolve-references'
import { flattenSchema, type RootCollectionConfig } from '../config'
import { ContentStore } from '../content-store'
import { createMockApiContext, createMockBranchContext } from '../test-utils'
import { unsafeAsBranchName, unsafeAsLogicalPath, unsafeAsSlug } from '../paths/test-utils'

const endpoint = RESOLVE_REFERENCES_ROUTES.post

// Valid Base58 content IDs (12 chars, alphabet excludes 0/O/I/l).
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const makeId = (n: number): string =>
  Array.from({ length: 12 }, (_, i) => BASE58[(n + i) % BASE58.length]).join('')

describe('resolveReferences params/body bounds (API-M1)', () => {
  it('accepts an ids array at the maximum allowed size', () => {
    const ids = Array.from({ length: 100 }, (_, i) => makeId(i))
    const result = endpoint.validate({ params: { branch: 'main' }, body: { ids } })
    expect(result.ok).toBe(true)
  })

  it('rejects an ids array over the maximum allowed size', () => {
    const ids = Array.from({ length: 101 }, (_, i) => makeId(i))
    const result = endpoint.validate({ params: { branch: 'main' }, body: { ids } })
    expect(result.ok).toBe(false)
  })

  it('rejects an empty ids array', () => {
    const result = endpoint.validate({ params: { branch: 'main' }, body: { ids: [] } })
    expect(result.ok).toBe(false)
  })
})

describe('resolveReferences for a json/yaml target', () => {
  const schema: RootCollectionConfig = {
    collections: [
      {
        name: 'library',
        path: 'library',
        entries: [
          {
            name: 'article',
            format: 'yaml',
            schema: [
              { name: 'title', type: 'string' },
              { name: 'prose', type: 'mdx', isBody: true },
            ],
          },
        ],
      },
    ],
  }
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-resolve-references-'))
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it("resolves as a link-only reference does, without the target's isBody field", async () => {
    const flatSchema = flattenSchema(schema, 'content')
    const store = new ContentStore(root, flatSchema)
    const library = unsafeAsLogicalPath('content/library')
    await store.write(library, unsafeAsSlug('long-read'), {
      format: 'yaml',
      data: { title: 'A long read', prose: 'THE ARTICLE PROSE' },
    })
    const id = await store.getIdForEntry(library, unsafeAsSlug('long-read'))
    if (!id) throw new Error('expected an id for the article')

    const ctx = createMockApiContext({
      branchContext: {
        ...createMockBranchContext({ branchName: 'main', baseRoot: root, branchRoot: root }),
        flatSchema,
      },
    })
    const res = await endpoint.handler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('main') },
      { ids: [id] },
    )

    expect(res.ok).toBe(true)
    expect(res.data?.resolved[id]).toMatchObject({
      title: 'A long read',
      urlPath: '/library/long-read',
    })
    expect(res.data?.resolved[id]).not.toHaveProperty('unavailable')
    expect(res.data?.resolved[id]).not.toHaveProperty('prose')
  })
})
