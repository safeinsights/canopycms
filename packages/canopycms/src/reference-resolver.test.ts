import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { CanopyConfig } from './config'
import { ContentIdIndex } from './content-id-index'
import { ContentStore } from './content-store'
import { ReferenceResolver } from './reference-resolver'

describe('ReferenceResolver', () => {
  let tempDir: string
  let store: ContentStore
  let idIndex: ContentIdIndex
  let resolver: ReferenceResolver

  beforeEach(async () => {
    // Create temp directory with content structure
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-test-'))
    await fs.mkdir(path.join(tempDir, 'content', 'authors'), { recursive: true })
    await fs.mkdir(path.join(tempDir, 'content', '_ids_'), { recursive: true })

    // Create test author files
    await fs.writeFile(
      path.join(tempDir, 'content', 'authors', 'alice.json'),
      JSON.stringify({ slug: 'alice', name: 'Alice' }),
    )
    await fs.writeFile(
      path.join(tempDir, 'content', 'authors', 'bob.json'),
      JSON.stringify({ slug: 'bob', name: 'Bob' }),
    )

    // Create symlinks for IDs (must be valid short-uuid Base58 format - no 'l')
    const aliceId = 'aXice123ABC456def789gh' // Changed 'l' to 'X'
    const bobId = 'bob456XYZ789abc123def4'

    const aliceSymlink = path.join(tempDir, 'content', '_ids_', aliceId)
    const bobSymlink = path.join(tempDir, 'content', '_ids_', bobId)

    await fs.symlink(path.join('..', 'authors', 'alice.json'), aliceSymlink, 'file')
    await fs.symlink(path.join('..', 'authors', 'bob.json'), bobSymlink, 'file')

    // Initialize store and index
    const config: CanopyConfig = {
      contentRoot: 'content',
      gitBotAuthorName: 'Test Bot',
      gitBotAuthorEmail: 'test@example.com',
      schema: [
        {
          type: 'collection',
          name: 'authors',
          path: 'authors',
          format: 'json',
          fields: [{ name: 'name', type: 'string', label: 'Name' }],
        },
      ],
    }

    store = new ContentStore(tempDir, config)
    idIndex = await store.idIndex()
    const contentRoot = config.contentRoot ?? 'content'
    resolver = new ReferenceResolver(store, idIndex, contentRoot)
  })

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  describe('loadReferenceOptions', () => {
    it('loads options when collection path does not include content/ prefix', async () => {
      // REGRESSION TEST: ID index stores "content/authors" but schema specifies "authors"
      // This ensures the collection path normalization works correctly
      const options = await resolver.loadReferenceOptions(['authors'], 'name')

      expect(options).toHaveLength(2)
      const labels = options.map((o) => o.label).sort()
      expect(labels).toEqual(['Alice', 'Bob'])
      expect(options.every((o) => o.id && o.collection)).toBe(true)
    })

    it('loads options when collection path includes content/ prefix', async () => {
      // REGRESSION TEST: Should also work if "content/authors" is explicitly specified
      const options = await resolver.loadReferenceOptions(['content/authors'], 'name')

      expect(options).toHaveLength(2)
      const labels = options.map((o) => o.label).sort()
      expect(labels).toEqual(['Alice', 'Bob'])
    })

    it('returns empty array for non-existent collection', async () => {
      const options = await resolver.loadReferenceOptions(['nonexistent'], 'name')

      expect(options).toHaveLength(0)
    })
  })
})
