import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import matter from 'gray-matter'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { STATIC_DEPLOY_USER } from './build-mode'
import { createTestServices } from './config-test'
import { createCanopyContext } from './context'
import { generateId } from './id'
import { findDuplicateUrlPaths } from './static'
import { buildProbeUrls, collectUrlExclusivityReport } from './url-exclusivity-fixtures'
import type { EntryTypeConfig, RootCollectionConfig } from './config'
import type { BranchContext } from './types'

// ---------------------------------------------------------------------------
// Enumeration and resolution answer at the SAME set of URLs
// ---------------------------------------------------------------------------
//
// `listEntries` publishes exactly one `urlPath` per entry; `readByUrlPath` is supposed to resolve
// that URL and no other. Historically it resolved more, and each extra URL was found separately,
// by an adopter, a release apart: the `.../index` spelling first
// (resolved/url-resolver-index-entry-extra-url.md), then `/<collection>/<entryTypeName>`
// (resolved/readbyurlpath-entry-type-candidate-phantom-url.md). The adopter who reported the
// second one asked for this file rather than another one-off regression test, and they were
// right to: writing it immediately surfaced a THIRD family nobody had reported,
// `/<collection>/<entryTypeName>/<slug>`, which needs no index entry and so applies to every
// entry in every collection.
//
// So these tests assert the invariant, not the instances: enumerate, round-trip every published
// URL, then probe every adjacent URL the resolver would actually attempt and require a miss.
// See url-exclusivity-fixtures.ts for the probe families and why entry-type names are appended
// with their declared casing.

const tmpDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-url-exclusivity-'))

const buildBranchContext = (branchRoot: string, name = 'main'): BranchContext => {
  const now = new Date().toISOString()
  return {
    baseRoot: branchRoot,
    branchRoot,
    branch: {
      name,
      status: 'editing',
      access: {},
      createdBy: 'tester',
      createdAt: now,
      updatedAt: now,
    },
  }
}

let testBranchContext: BranchContext
vi.mock('./branch-workspace', () => ({
  loadOrCreateBranchContext: async () => testBranchContext,
  loadBranchContext: async () => testBranchContext,
}))

const titleField = [{ name: 'title', type: 'string' as const }]
const entryType = (name: string, extra: Partial<EntryTypeConfig> = {}): EntryTypeConfig =>
  ({ name, format: 'json' as const, schema: titleField, ...extra }) as EntryTypeConfig

describe('readByUrlPath resolves exactly the URLs listEntries publishes', () => {
  let root: string

  beforeEach(async () => {
    root = await tmpDir()
    testBranchContext = buildBranchContext(root)
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  const createContext = async (schema: RootCollectionConfig) => {
    const services = await createTestServices(
      { defaultBranchAccess: 'allow', defaultPathAccess: 'allow', schema },
      { getSettingsBranchRoot: () => Promise.resolve(root) },
    )
    return createCanopyContext({
      services,
      extractUser: async () => STATIC_DEPLOY_USER,
    }).getContext()
  }

  /**
   * Write a real entry file: `{type}.{slug}.{id}.{ext}`.
   *
   * The grammar is load-bearing here, unlike in context.test.ts where most fixtures are untyped
   * (`overview.json`). `listEntries` parses filenames with `parseTypedFilename`, which rejects a
   * name with fewer than three dot-separated segments before the extension -- and
   * `looksLikeMalformedEntry` does not flag those either, so they are dropped silently. An
   * untyped fixture is therefore INVISIBLE to enumeration, and every assertion below would run
   * over an empty list and pass. The `published` pin in each test is what catches that.
   */
  const writeEntry = async (
    dir: string,
    type: string,
    slug: string,
    data: Record<string, unknown> & { body?: string },
    format: 'json' | 'md' = 'json',
  ) => {
    await fs.mkdir(dir, { recursive: true })
    const id = generateId()
    const { body, ...frontmatter } = data
    await fs.writeFile(
      path.join(dir, `${type}.${slug}.${id}.${format}`),
      format === 'md' ? matter.stringify(body ?? '', frontmatter) : JSON.stringify(data),
    )
    return id
  }

  /**
   * Assert the invariant, plus the three ways this test could pass without checking anything:
   * the fixture being invisible to enumeration, the probe generator emitting nothing, and the
   * probe loop skipping every probe as "already published".
   */
  const expectExclusive = async (
    ctx: Awaited<ReturnType<typeof createContext>>,
    schema: RootCollectionConfig,
    pins: { published: string[]; phantomsClosed: string[] },
  ) => {
    const report = await collectUrlExclusivityReport(ctx, schema)

    // Anti-vacuity: the fixture is visible to listEntries, and is exactly what we think it is.
    expect(report.published).toEqual([...pins.published].sort())
    // Precondition: no two entries contest a URL. The deliberately-ambiguous shape is EXCLUDED
    // from this suite rather than silently failing it -- see the duplicate-URL test below.
    expect(report.duplicates).toEqual([])
    // Anti-vacuity: the probe generator really emitted the URLs this fixture exists to close.
    expect(pins.phantomsClosed.length).toBeGreaterThan(0)
    expect(report.probes).toEqual(expect.arrayContaining(pins.phantomsClosed))

    // The invariant itself.
    expect(report.unresolved).toEqual([])
    expect(report.mismatched).toEqual([])
    expect(report.phantoms).toEqual([])
  }

  it('a root index entry answers at "/" only, not at every entry-type name beside it', async () => {
    // The adopter's own shape, reproduced from their report: a home singleton modelled as a root
    // `index` entry (what README recommends) with two more entry types declared beside it, and a
    // blog collection with its own index entry. Before the fix all ten phantoms below resolved,
    // so an app with a root catch-all served duplicate homepages at /page and /landing.
    const schema: RootCollectionConfig = {
      entries: [
        entryType('home', { default: true, maxItems: 1 }),
        entryType('page'),
        entryType('landing'),
      ],
      collections: [
        {
          name: 'blog',
          path: 'blog',
          entries: [entryType('blogIndex'), entryType('article', { default: true })],
        },
      ],
    }

    const content = path.join(root, 'content')
    await writeEntry(content, 'home', 'index', { title: 'Home' })
    await writeEntry(content, 'page', 'about', { title: 'About' })
    await writeEntry(path.join(content, 'blog'), 'blogIndex', 'index', { title: 'Blog' })
    await writeEntry(path.join(content, 'blog'), 'article', 'hello', { title: 'Hello' })

    await expectExclusive(await createContext(schema), schema, {
      published: ['/', '/about', '/blog', '/blog/hello'],
      phantomsClosed: [
        // Family 1 -- the index-fallback candidate landing on an entry-type item.
        '/home',
        '/page',
        '/landing',
        '/blog/blogIndex',
        '/blog/article',
        // Family 2 -- the direct-entry candidate doing the same thing one level up. Needs no
        // index entry, which is why it reaches /about and /blog/hello as well.
        '/home/about',
        '/page/about',
        '/landing/about',
        '/blog/article/hello',
        '/blog/blogIndex/hello',
      ],
    })
  })

  it('a collection literally named "index" still resolves, and is not re-shadowed', async () => {
    // The shape that makes resolveUrlPathCandidates' index-fallback candidate a SKIP rather than
    // a removal: `defaultBuildPath` hands a collection named `index` the path /docs/index, and
    // that candidate is the only one that can answer it. The forward round-trip below (published
    // URL -> same entryId) is what proves the collection gate did not shadow it again.
    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'docs',
          path: 'docs',
          entries: [entryType('doc', { default: true })],
          collections: [
            { name: 'index', path: 'docs/index', entries: [entryType('doc', { default: true })] },
          ],
        },
      ],
    }

    const docs = path.join(root, 'content/docs')
    await writeEntry(docs, 'doc', 'index', { title: 'Docs Home' })
    await writeEntry(docs, 'doc', 'overview', { title: 'Overview' })
    await writeEntry(path.join(docs, 'index'), 'doc', 'index', { title: 'The Index Collection' })

    await expectExclusive(await createContext(schema), schema, {
      published: ['/docs', '/docs/index', '/docs/overview'],
      phantomsClosed: ['/docs/doc', '/docs/doc/overview', '/docs/index/doc'],
    })
  })

  it('a landing entry beside a same-named collection keeps precedence over its children', async () => {
    // The LEGITIMATE beside-a-collection shape: a landing page plus a folder of children, no
    // index entry, nothing contested. It resolves through the direct-entry candidate, so it is
    // the case a collection gate could plausibly break -- it does not, because the candidate's
    // entryPath (content/docs) is a collection either way.
    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'docs',
          path: 'docs',
          entries: [entryType('doc', { default: true })],
          collections: [
            {
              name: 'guides',
              path: 'docs/guides',
              entries: [
                entryType('guide', {
                  default: true,
                  format: 'md',
                  schema: [...titleField, { name: 'body', type: 'markdown', isBody: true }],
                }),
              ],
            },
          ],
        },
      ],
    }

    const docs = path.join(root, 'content/docs')
    await writeEntry(docs, 'doc', 'guides', { title: 'Guides' })
    await writeEntry(
      path.join(docs, 'guides'),
      'guide',
      'getting-started',
      { title: 'Getting Started', body: '# Hello' },
      'md',
    )

    await expectExclusive(await createContext(schema), schema, {
      published: ['/docs/guides', '/docs/guides/getting-started'],
      phantomsClosed: ['/docs/doc/guides', '/docs/guides/guide/getting-started'],
    })
  })

  it('an entry whose type the collection does not declare is neither listed nor resolvable', async () => {
    // The third disagreement, and the only one the probe generator cannot express: it is keyed on
    // a type name that exists on DISK but not in the schema, so nothing derives it. An entry type
    // renamed in the schema without renaming the files gets here, as does hand-authored or
    // merge-delivered content. `listEntries` has always skipped these (parseTypedFilename
    // validates the type against the collection's `entries`); resolution used to serve them,
    // because buildPaths' directory scan matches on slug alone.
    const schema: RootCollectionConfig = {
      collections: [{ name: 'docs', path: 'docs', entries: [entryType('doc', { default: true })] }],
    }

    const docs = path.join(root, 'content/docs')
    await writeEntry(docs, 'doc', 'overview', { title: 'Overview' })
    await writeEntry(docs, 'oldtype', 'legacy', { title: 'Legacy' })

    const ctx = await createContext(schema)
    expect((await ctx.listEntries()).map((i) => i.urlPath)).toEqual(['/docs/overview'])
    // The declared one still resolves -- this is not a general tightening of the scan.
    expect((await ctx.readByUrlPath<{ title: string }>('/docs/overview'))!.data.title).toBe(
      'Overview',
    )
    expect(await ctx.readByUrlPath('/docs/legacy')).toBeNull()
  })

  it('does not resolve content in a collection that declares no entry types', async () => {
    // A collections-only container is legal (the schema requires `entries` OR `collections`), and
    // `listCollectionEntries` returns [] outright for one -- so it publishes nothing, no matter
    // what sits in its directory. A file there cannot have been created by the CMS, since there is
    // no entry type to create it as; it arrived by hand, by merge or by retrofit. Resolution used
    // to serve it anyway, which is the same disagreement as the undeclared-token case above with
    // the type list empty rather than mismatched.
    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'docs',
          path: 'docs',
          collections: [
            {
              name: 'guides',
              path: 'docs/guides',
              entries: [entryType('guide', { default: true })],
            },
          ],
        },
      ],
    }

    const docs = path.join(root, 'content/docs')
    await writeEntry(docs, 'doc', 'overview', { title: 'Orphan' })
    await writeEntry(path.join(docs, 'guides'), 'guide', 'getting-started', { title: 'Guide' })

    const ctx = await createContext(schema)
    // The container publishes nothing...
    expect((await ctx.listEntries()).map((i) => i.urlPath)).toEqual([
      '/docs/guides/getting-started',
    ])
    expect(await ctx.readByUrlPath('/docs/overview')).toBeNull()
    // ...while its child collection, which does declare a type, is untouched.
    expect(
      (await ctx.readByUrlPath<{ title: string }>('/docs/guides/getting-started'))!.data.title,
    ).toBe('Guide')
  })

  it('still resolves a legacy untyped file, which carries no type token to check', async () => {
    // The undeclared-type rule reads the entry type buildPaths resolved, which for a legacy
    // `{slug}.{ext}` file is not a token from the filename at all -- extractEntryTypeFromFilename
    // returns null for it and the collection's DEFAULT type is substituted. So legacy files pass
    // the check by construction. Pinned because that is a load-bearing accident of the fallback,
    // not something the rule says out loud: tightening it into a filename-grammar check would
    // silently 404 every legacy entry. (They remain invisible to listEntries -- a separate,
    // tracked gap: .claude/future-tasks/legacy-untyped-files-url-addressable.md.)
    const schema: RootCollectionConfig = {
      collections: [{ name: 'docs', path: 'docs', entries: [entryType('doc', { default: true })] }],
    }

    const docs = path.join(root, 'content/docs')
    await fs.mkdir(docs, { recursive: true })
    await fs.writeFile(path.join(docs, 'overview.json'), JSON.stringify({ title: 'Legacy' }))

    const ctx = await createContext(schema)
    expect((await ctx.readByUrlPath<{ title: string }>('/docs/overview'))!.data.title).toBe(
      'Legacy',
    )
  })

  it('reports a contested URL rather than quietly excluding it (the precondition is live)', async () => {
    // expectExclusive asserts report.duplicates is empty. That assertion is only meaningful if
    // findDuplicateUrlPaths can actually see this suite's fixtures -- and it cannot see untyped
    // ones, which is how the equivalent test in context.test.ts would prove nothing. Written with
    // the real grammar so it does.
    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'docs',
          path: 'docs',
          entries: [entryType('doc', { default: true })],
          collections: [
            {
              name: 'guides',
              path: 'docs/guides',
              entries: [entryType('guide', { default: true })],
            },
          ],
        },
      ],
    }

    const docs = path.join(root, 'content/docs')
    await writeEntry(docs, 'doc', 'guides', { title: 'Guides' })
    await writeEntry(path.join(docs, 'guides'), 'guide', 'index', { title: 'Guides Index' })

    const ctx = await createContext(schema)
    const duplicates = findDuplicateUrlPaths(await ctx.listEntries())
    expect(duplicates.map((d) => d.urlPath)).toEqual(['/docs/guides'])
  })

  it('generates a probe for every collection x entry-type pair, with declared casing', async () => {
    // buildProbeUrls is the part of this suite that can silently stop working: if it emitted
    // nothing, every phantom assertion above would pass. The arrayContaining pins in each test
    // guard their own URLs; this one pins the generator's shape directly, including the casing
    // rule -- a lowercased `/blog/blogindex` misses the entry-type schema item entirely and would
    // return null for the wrong reason.
    const schema: RootCollectionConfig = {
      entries: [entryType('home', { default: true })],
      collections: [
        { name: 'blog', path: 'blog', entries: [entryType('blogIndex'), entryType('article')] },
      ],
    }

    const probes = buildProbeUrls(schema, [])
    expect(probes.sort()).toEqual(['/blog/article', '/blog/blogIndex', '/home'])
  })
})
