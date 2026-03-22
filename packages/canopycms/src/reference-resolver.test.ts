import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { CanopyConfig } from './config'
import { flattenSchema } from './config'
import { ContentIdIndex } from './content-id-index'
import { ContentStore } from './content-store'
import { ReferenceResolver } from './reference-resolver'
import { unsafeAsLogicalPath } from './paths/test-utils'

describe('ReferenceResolver', () => {
  let tempDir: string
  let store: ContentStore
  let idIndex: ContentIdIndex
  let resolver: ReferenceResolver

  beforeEach(async () => {
    // Create temp directory with content structure
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-test-'))
    await fs.mkdir(path.join(tempDir, 'content', 'authors'), {
      recursive: true,
    })

    // Create test author files with embedded IDs: {type}.{slug}.{id}.{ext}
    const aliceId = 'aXice123ABC4' // 12 chars, valid Base58
    const bobId = 'bob456XYZ789' // 12 chars, valid Base58

    await fs.writeFile(
      path.join(tempDir, 'content', 'authors', `author.alice.${aliceId}.json`),
      JSON.stringify({ slug: 'alice', name: 'Alice' }),
    )
    await fs.writeFile(
      path.join(tempDir, 'content', 'authors', `author.bob.${bobId}.json`),
      JSON.stringify({ slug: 'bob', name: 'Bob' }),
    )

    // Initialize store and index
    const schema = {
      collections: [
        {
          name: 'authors',
          path: 'authors',
          entries: [
            {
              name: 'author',
              format: 'json' as const,
              schema: [{ name: 'name', type: 'string' as const, label: 'Name' }],
            },
          ],
        },
      ],
    } as const

    const config: CanopyConfig = {
      contentRoot: 'content',
      gitBotAuthorName: 'Test Bot',
      gitBotAuthorEmail: 'test@example.com',
      mode: 'prod',
    }

    store = new ContentStore(tempDir, flattenSchema(schema, config.contentRoot))
    idIndex = await store.idIndex()
    resolver = new ReferenceResolver(store, idIndex)
  })

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  describe('loadReferenceOptions', () => {
    it('loads options when collection path does not include content/ prefix', async () => {
      // REGRESSION TEST: ID index stores "content/authors" but schema specifies "authors"
      // This ensures the collection path normalization works correctly
      const options = await resolver.loadReferenceOptions([unsafeAsLogicalPath('authors')], 'name')

      expect(options).toHaveLength(2)
      const labels = options.map((o) => o.label).sort()
      expect(labels).toEqual(['Alice', 'Bob'])
      expect(options.every((o) => o.id && o.collection)).toBe(true)
    })

    it('loads options when collection path includes content/ prefix', async () => {
      // REGRESSION TEST: Should also work if "content/authors" is explicitly specified
      const options = await resolver.loadReferenceOptions(
        [unsafeAsLogicalPath('content/authors')],
        'name',
      )

      expect(options).toHaveLength(2)
      const labels = options.map((o) => o.label).sort()
      expect(labels).toEqual(['Alice', 'Bob'])
    })

    it('returns empty array for non-existent collection', async () => {
      const options = await resolver.loadReferenceOptions(
        [unsafeAsLogicalPath('nonexistent')],
        'name',
      )

      expect(options).toHaveLength(0)
    })
  })
})
