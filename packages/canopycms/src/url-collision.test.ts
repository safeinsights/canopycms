import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { findUrlPathClaimant, findIndexEntryIn, findEntryBySlugIn } from './url-collision'

/**
 * Direct tests for the claimant scan. It was previously exercised only through its two consumers,
 * which meant the one thing most worth pinning — WHICH FILES COUNT as claimants — was tested only
 * incidentally, and the over-blocking bug below shipped.
 */
describe('url-collision', () => {
  let root: string
  let content: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-url-collision-'))
    content = path.join(root, 'content')
    await fs.mkdir(content, { recursive: true })
  })

  /** A real entry file: `{type}.{slug}.{id}.{ext}`. */
  const entry = async (dir: string, type: string, slug: string, ext = 'json') => {
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, `${type}.${slug}.aB3cD4eF5gH6.${ext}`)
    await fs.writeFile(file, '{}')
    return file
  }

  /** A collection directory: `{name}.{id}`. */
  const collection = async (parent: string, name: string) => {
    const dir = path.join(parent, `${name}.zZ9yY8xX7wW6`)
    await fs.mkdir(dir, { recursive: true })
    return dir
  }

  describe('what counts as a claimant', () => {
    // The set must match what `listEntries` publishes a urlPath for, because that is the set the
    // build-time half of this invariant checks. Anything looser OVER-BLOCKS: it refuses a write
    // the build would have accepted, and tells the author to remove a "index entry" that Canopy
    // does not consider an entry at all.
    it('ignores a hand-authored index.md with no content ID', async () => {
      const guides = await collection(content, 'guides')
      await fs.writeFile(path.join(guides, 'index.md'), '# Guides')

      expect(await findIndexEntryIn(guides)).toBeNull()
      expect(
        await findUrlPathClaimant({ collectionDir: content, slug: 'guides', contentRoot: content }),
      ).toBeNull()
    })

    it('ignores an editor backup file', async () => {
      const guides = await collection(content, 'guides')
      await fs.writeFile(path.join(guides, 'doc.index.aB3cD4eF5gH6.md~'), 'stale')

      expect(await findIndexEntryIn(guides)).toBeNull()
    })

    it('ignores a dotfile', async () => {
      const guides = await collection(content, 'guides')
      await fs.writeFile(path.join(guides, '.index.aB3cD4eF5gH6.md'), 'hidden')

      expect(await findIndexEntryIn(guides)).toBeNull()
    })

    it('ignores a colocated asset that shares the slug', async () => {
      await fs.writeFile(path.join(content, 'guides.png'), 'not an entry')

      const guides = await collection(content, 'guides')
      expect(
        await findUrlPathClaimant({ collectionDir: guides, slug: 'index', contentRoot: content }),
      ).toBeNull()
    })

    it('DOES count a real entry file', async () => {
      const guides = await collection(content, 'guides')
      const indexFile = await entry(guides, 'doc', 'index')

      expect(await findIndexEntryIn(guides)).toBe(indexFile)
    })

    it('counts an index entry of ANY entry type — the URL does not care what serves it', async () => {
      const guides = await collection(content, 'guides')
      const indexFile = await entry(guides, 'landingPage', 'index', 'md')

      expect(await findIndexEntryIn(guides)).toBe(indexFile)
    })
  })

  describe('the two contested shapes', () => {
    it('finds a sibling collection index for a plain entry', async () => {
      const guides = await collection(content, 'guides')
      const indexFile = await entry(guides, 'doc', 'index')

      expect(
        await findUrlPathClaimant({ collectionDir: content, slug: 'guides', contentRoot: content }),
      ).toEqual({ kind: 'sibling-collection-index', physicalPath: indexFile, name: 'guides' })
    })

    it('finds a parent entry for an index entry', async () => {
      const parentEntry = await entry(content, 'doc', 'guides')
      const guides = await collection(content, 'guides')

      expect(
        await findUrlPathClaimant({ collectionDir: guides, slug: 'index', contentRoot: content }),
      ).toEqual({ kind: 'parent-entry', physicalPath: parentEntry, name: 'guides' })
    })

    it('allows the landing-page-beside-a-collection shape (no index entry)', async () => {
      const guides = await collection(content, 'guides')
      await entry(guides, 'doc', 'getting-started')

      expect(
        await findUrlPathClaimant({ collectionDir: content, slug: 'guides', contentRoot: content }),
      ).toBeNull()
    })

    it('is case-insensitive in both directions', async () => {
      const guides = await collection(content, 'Guides')
      await entry(guides, 'doc', 'INDEX')

      expect(
        await findUrlPathClaimant({ collectionDir: content, slug: 'GUIDES', contentRoot: content }),
      ).not.toBeNull()
      expect(
        await findUrlPathClaimant({ collectionDir: guides, slug: 'Index', contentRoot: content }),
      ).toBeNull() // no parent entry named "guides" exists
    })
  })

  describe('edges', () => {
    it('never contests a root index entry — it claims "/", which nothing above it can hold', async () => {
      await entry(content, 'page', 'content')

      expect(
        await findUrlPathClaimant({ collectionDir: content, slug: 'index', contentRoot: content }),
      ).toBeNull()
    })

    it('handles a multi-segment content root', async () => {
      const nested = path.join(root, 'cms', 'content')
      await fs.mkdir(nested, { recursive: true })
      const parentEntry = await entry(nested, 'doc', 'guides')
      const guides = await collection(nested, 'guides')

      expect(
        await findUrlPathClaimant({ collectionDir: guides, slug: 'index', contentRoot: nested }),
      ).toEqual({ kind: 'parent-entry', physicalPath: parentEntry, name: 'guides' })
    })

    it('treats a missing directory as empty rather than throwing', async () => {
      expect(await findIndexEntryIn(path.join(content, 'nope'))).toBeNull()
      expect(await findEntryBySlugIn(path.join(content, 'nope'), 'x')).toBeNull()
      expect(
        await findUrlPathClaimant({ collectionDir: content, slug: 'absent', contentRoot: content }),
      ).toBeNull()
    })

    it('ignores a directory when looking for an entry, and vice versa', async () => {
      // A collection named `guides` is not an entry claiming /guides.
      await collection(content, 'guides')
      expect(await findEntryBySlugIn(content, 'guides')).toBeNull()
    })
  })
})
