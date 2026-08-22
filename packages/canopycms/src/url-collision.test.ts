import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { findUrlPathClaimant, findIndexEntryIn, findEntryBySlugIn } from './url-collision'
import { getFormatExtension } from './utils/format'
import type { ContentFormat } from './config'

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

    it('ignores an uppercase extension, exactly as listCollectionEntries does', async () => {
      // The listing's extension filter is case-SENSITIVE (`d.name.endsWith(ext)`), and it runs
      // BEFORE the parse — so a `.MD` file is skipped silently, publishing no URL and raising no
      // build error. A case-insensitive guard was therefore looser than the listing and blocked a
      // write the build would have accepted.
      const guides = await collection(content, 'guides')
      await fs.writeFile(path.join(guides, 'doc.index.aB3cD4eF5gH6.MD'), '# Guides')

      expect(await findIndexEntryIn(guides)).toBeNull()
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

    // A collection literally NAMED "index" collapses onto ITS OWN path (`<parent>/index`), not
    // onto `<parent>` -- see `computeEntryUrl`/`isIndexSlug`. The lookup used to reuse the
    // collection's own name ("index") as the slug to search for in the parent, which happened to
    // match the PARENT's own index/landing entry (also slug "index", but collapsing onto
    // `<parent>` itself -- a different URL). That is a false collision: nothing actually contests
    // `<parent>/index`.
    it('does not false-positive when the collection itself is named "index"', async () => {
      const docs = await collection(content, 'docs')
      await entry(docs, 'doc', 'index') // docs' own landing page -> "/docs"
      const docsIndex = await collection(docs, 'index') // child collection literally named "index"

      expect(
        await findUrlPathClaimant({
          collectionDir: docsIndex,
          slug: 'index',
          contentRoot: content,
        }),
      ).toBeNull()
    })
  })

  // Drift tripwire for CONTENT_EXTENSIONS, which is a literal in url-collision.ts because that
  // module cannot reach the ContentFormat union.
  //
  // Adding a format to `ContentFormat` stops the compile-time check below from typechecking
  // (verified: TS2322 under `pnpm typecheck`, which includes this file).
  //
  // The runtime half needs the DISTINCTNESS assertion, not just the per-format fixture. An
  // earlier version of this comment claimed a fixture per format would catch a missing extension;
  // it would not, because `getFormatExtension` is an if-chain with `return '.json'` as its
  // FALLBACK — a new format silently maps to `.json`, the fixture is then written as `.json`, and
  // every test passes. The distinctness check is what actually goes red on that.
  describe('every content format is recognised', () => {
    const ALL_FORMATS = ['md', 'mdx', 'json', 'yaml'] as const
    // If a new ContentFormat is added, this stops compiling until it is listed above.
    type Unhandled = Exclude<ContentFormat, (typeof ALL_FORMATS)[number]>
    const _exhaustive: Unhandled extends never ? true : never = true
    void _exhaustive

    it("maps every format to a DISTINCT extension — catches getFormatExtension's silent fallback", () => {
      const exts = ALL_FORMATS.map((f) => getFormatExtension(f as ContentFormat))
      expect(new Set(exts).size).toBe(ALL_FORMATS.length)
    })

    it.each(ALL_FORMATS)('recognises an index entry written as %s', async (format) => {
      const guides = await collection(content, `guides-${format}`)
      const ext = getFormatExtension(format as ContentFormat).slice(1)
      const file = await entry(guides, 'doc', 'index', ext)

      expect(await findIndexEntryIn(guides)).toBe(file)
    })
  })

  describe('edges', () => {
    it('never contests a root index entry — it claims "/", which nothing above it can hold', async () => {
      // The claimant must sit in content/'s PARENT, or this passes because the parent scan finds
      // nothing rather than because the root-stop fired — which is what it did before round 3.
      await entry(root, 'page', 'content')

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
