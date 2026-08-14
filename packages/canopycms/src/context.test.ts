import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import matter from 'gray-matter'
import { stringify as yamlStringify } from 'yaml'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTestServices } from './config-test'
import { createCanopyContext } from './context'
import { STATIC_DEPLOY_USER } from './build-mode'
import { RESERVED_GROUPS } from './authorization/helpers'
import { parsePhysicalPath } from './paths'
import type { BranchContext } from './types'

const tmpDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-context-'))

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

// Mock branch-workspace to return our test branch context
let testBranchContext: BranchContext
// Set by a test to simulate a raw (non-ContentStoreError) failure surfacing while
// readByUrlPath probes candidates, to verify such errors still propagate instead of
// being swallowed as "not found".
let injectNonContentStoreError = false
vi.mock('./branch-workspace', () => ({
  loadOrCreateBranchContext: async () => {
    if (injectNonContentStoreError) {
      throw new Error('simulated non-ContentStoreError failure')
    }
    return testBranchContext
  },
  loadBranchContext: async () => testBranchContext,
}))

// Schema with a flat docs collection and a nested guides subcollection
const testSchema = {
  collections: [
    {
      name: 'docs',
      path: 'docs',
      entries: [
        {
          name: 'doc',
          format: 'json' as const,
          default: true,
          schema: [{ name: 'title', type: 'string' as const }],
        },
      ],
      collections: [
        {
          name: 'guides',
          path: 'docs/guides',
          entries: [
            {
              name: 'guide',
              format: 'md' as const,
              default: true,
              schema: [
                { name: 'title', type: 'string' as const },
                { name: 'body', type: 'markdown' as const, isBody: true },
              ],
            },
          ],
        },
      ],
    },
    {
      name: 'posts',
      path: 'posts',
      entries: [
        {
          name: 'post',
          format: 'md' as const,
          default: true,
          schema: [
            { name: 'title', type: 'string' as const },
            { name: 'body', type: 'markdown' as const, isBody: true },
          ],
        },
      ],
    },
  ],
}

describe('createCanopyContext - build context', () => {
  let root: string

  beforeEach(async () => {
    root = await tmpDir()
    testBranchContext = buildBranchContext(root)
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('getContext returns a working context with STATIC_DEPLOY_USER', async () => {
    const docsDir = path.join(root, 'content/docs')
    await fs.mkdir(docsDir, { recursive: true })
    await fs.writeFile(path.join(docsDir, 'intro.json'), JSON.stringify({ title: 'Intro' }))

    const services = await createTestServices(
      {
        defaultBranchAccess: 'allow',
        defaultPathAccess: 'allow',
        schema: testSchema,
      },
      { getSettingsBranchRoot: () => Promise.resolve(root) },
    )
    const canopyCtx = createCanopyContext({
      services,
      extractUser: async () => STATIC_DEPLOY_USER,
    })
    const ctx = await canopyCtx.getContext()

    expect(ctx.user).toBe(STATIC_DEPLOY_USER)

    // read should work with the synthetic admin user
    const result = await ctx.read<{ title: string }>({ entryPath: 'content/docs', slug: 'intro' })
    expect(result.data.title).toBe('Intro')
  })

  it('getContext refreshes the active branch before resolving readers', async () => {
    const docsDir = path.join(root, 'content/docs')
    await fs.mkdir(docsDir, { recursive: true })
    await fs.writeFile(path.join(docsDir, 'intro.json'), JSON.stringify({ title: 'Intro' }))

    const services = await createTestServices(
      {
        defaultBranchAccess: 'allow',
        defaultPathAccess: 'allow',
        schema: testSchema,
      },
      { getSettingsBranchRoot: () => Promise.resolve(root) },
    )
    // Simulate a dev-mode git branch switch surfaced by refreshActiveBranch
    const refreshSpy = vi.fn(async () => {
      services.config = { ...services.config, defaultActiveBranch: 'flipped' }
    })
    services.refreshActiveBranch = refreshSpy

    const canopyCtx = createCanopyContext({
      services,
      extractUser: async () => STATIC_DEPLOY_USER,
    })
    const ctx = await canopyCtx.getContext()

    expect(refreshSpy).toHaveBeenCalled()
    // Default-branch reads must target the freshly detected branch
    const result = await ctx.read<{ title: string }>({ entryPath: 'content/docs', slug: 'intro' })
    expect(result.path).toBe('/docs/intro?branch=flipped')
  })
})

describe('listEntries / buildContentTree path ACLs', () => {
  let root: string

  beforeEach(async () => {
    root = await tmpDir()
    testBranchContext = buildBranchContext(root)
    vi.unstubAllEnvs()
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await fs.rm(root, { recursive: true, force: true })
  })

  const REGULAR_USER = {
    type: 'authenticated' as const,
    userId: 'regular-user',
    name: 'Regular User',
    email: 'user@example.com',
    groups: [],
  }

  /**
   * Two entries in the same collection plus a nested index entry, so a single fixture
   * covers the flat listing, the tree's entry nodes, and the tree's `meta.indexEntry`.
   */
  const writeContent = async () => {
    const docsDir = path.join(root, 'content/docs')
    const guidesDir = path.join(root, 'content/docs/guides')
    await fs.mkdir(guidesDir, { recursive: true })
    await fs.writeFile(
      path.join(docsDir, 'doc.public.RRMDbToFJNTf.json'),
      JSON.stringify({ title: 'Public' }),
    )
    await fs.writeFile(
      path.join(docsDir, 'doc.secret.aB3cD4eF5gH6.json'),
      JSON.stringify({ title: 'Secret' }),
    )
    await fs.writeFile(
      path.join(guidesDir, 'guide.index.cD5eF6gH7jK8.md'),
      matter.stringify('Guides landing', { title: 'Guides Index' }),
    )
  }

  /** Deny `read` on the secret doc and on the nested guides collection, for everyone but 'other'. */
  const writePermissions = async () => {
    await fs.writeFile(
      path.join(root, 'permissions.json'),
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        updatedBy: 'tester',
        pathPermissions: [
          {
            path: 'content/docs/doc.secret.aB3cD4eF5gH6.json',
            read: { allowedUsers: ['other'] },
          },
          { path: 'content/docs/guides/**', read: { allowedUsers: ['other'] } },
        ],
      }),
    )
  }

  const createServices = async () =>
    createTestServices(
      { defaultBranchAccess: 'allow', defaultPathAccess: 'allow', schema: testSchema },
      { getSettingsBranchRoot: () => Promise.resolve(root) },
    )

  it('omits entries the request user cannot read from listEntries', async () => {
    await writeContent()
    await writePermissions()

    const ctx = await createCanopyContext({
      services: await createServices(),
      extractUser: async () => REGULAR_USER,
    }).getContext()

    const items = await ctx.listEntries()
    const slugs = items.map((i) => i.slug)
    expect(slugs).toContain('public')
    expect(slugs).not.toContain('secret')
    // The denied entry's data must not leak through `data` either.
    expect(JSON.stringify(items)).not.toContain('Secret')
  })

  it('omits denied entries from buildContentTree, including via meta.indexEntry', async () => {
    await writeContent()
    await writePermissions()

    const ctx = await createCanopyContext({
      services: await createServices(),
      extractUser: async () => REGULAR_USER,
    }).getContext()

    // The index entry of a denied collection is surfaced to `extract` as meta.indexEntry
    // even though no node is emitted for it — so assert on what extract actually sees.
    const seenIndexTitles: unknown[] = []
    const tree = await ctx.buildContentTree({
      extract: (data, meta) => {
        if (meta.kind === 'collection' && meta.indexEntry) {
          seenIndexTitles.push((meta.indexEntry.data as { title?: string }).title)
        }
        return data
      },
    })

    const flatten = (nodes: typeof tree): typeof tree =>
      nodes.flatMap((n) => [n, ...flatten(n.children ?? [])])
    const slugs = flatten(tree).map((n) => n.entry?.slug)
    expect(slugs).toContain('public')
    expect(slugs).not.toContain('secret')
    expect(seenIndexTitles).not.toContain('Guides Index')
  })

  it('does not filter for an admin user', async () => {
    await writeContent()
    await writePermissions()

    const ctx = await createCanopyContext({
      services: await createServices(),
      extractUser: async () => ({ ...REGULAR_USER, groups: [RESERVED_GROUPS.ADMINS] }),
    }).getContext()

    const slugs = (await ctx.listEntries()).map((i) => i.slug)
    expect(slugs).toEqual(expect.arrayContaining(['public', 'secret']))
  })

  it('builds no access checker at build time (no settings-branch round trip)', async () => {
    await writeContent()
    await writePermissions()

    const services = await createServices()
    const checkerSpy = vi.spyOn(services, 'createContentAccessChecker')

    // isBuildMode() reads this env var; the build context runs as a synthetic admin, so
    // filtering would be a no-op — but building the checker would add a
    // getSettingsBranchRoot() call (an EFS round trip in prod) to every build-time listing.
    vi.stubEnv('CANOPY_BUILD_MODE', 'true')

    const ctx = await createCanopyContext({
      services,
      extractUser: async () => STATIC_DEPLOY_USER,
    }).getContext()

    const slugs = (await ctx.listEntries()).map((i) => i.slug)
    expect(slugs).toEqual(expect.arrayContaining(['public', 'secret']))
    expect(checkerSpy).not.toHaveBeenCalled()
  })

  it('propagates a failing access checker instead of returning an unfiltered listing', async () => {
    await writeContent()

    const services = await createServices()
    services.createContentAccessChecker = vi
      .fn()
      .mockRejectedValue(new Error('settings branch unavailable'))

    const ctx = await createCanopyContext({
      services,
      extractUser: async () => REGULAR_USER,
    }).getContext()

    await expect(ctx.listEntries()).rejects.toThrow('settings branch unavailable')
    await expect(ctx.buildContentTree()).rejects.toThrow('settings branch unavailable')
  })
})

describe('readByUrlPath', () => {
  let root: string

  beforeEach(async () => {
    root = await tmpDir()
    testBranchContext = buildBranchContext(root)
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  const createContext = async (schema = testSchema) => {
    const services = await createTestServices(
      {
        defaultBranchAccess: 'allow',
        defaultPathAccess: 'allow',
        schema,
      },
      { getSettingsBranchRoot: () => Promise.resolve(root) },
    )
    const canopyCtx = createCanopyContext({
      services,
      extractUser: async () => STATIC_DEPLOY_USER,
    })
    return canopyCtx.getContext()
  }

  it('resolves a direct entry by URL path', async () => {
    const docsDir = path.join(root, 'content/docs')
    await fs.mkdir(docsDir, { recursive: true })
    await fs.writeFile(path.join(docsDir, 'overview.json'), JSON.stringify({ title: 'Overview' }))

    const ctx = await createContext()
    const result = await ctx.readByUrlPath<{ title: string }>('/docs/overview')
    expect(result).not.toBeNull()
    expect(result!.data.title).toBe('Overview')
  })

  it('falls back to index entry when direct match fails', async () => {
    const guidesDir = path.join(root, 'content/docs/guides')
    await fs.mkdir(guidesDir, { recursive: true })
    await fs.writeFile(
      path.join(guidesDir, 'index.md'),
      matter.stringify('Welcome to guides', { title: 'Guides Index' }),
    )

    const ctx = await createContext()
    // /docs/guides → tries content/docs + slug "guides" (not found) → falls back to content/docs/guides + slug "index"
    const result = await ctx.readByUrlPath<{ title: string }>('/docs/guides')
    expect(result).not.toBeNull()
    expect(result!.data.title).toBe('Guides Index')
  })

  it('resolves a nested path (collection + slug)', async () => {
    const guidesDir = path.join(root, 'content/docs/guides')
    await fs.mkdir(guidesDir, { recursive: true })
    await fs.writeFile(
      path.join(guidesDir, 'getting-started.md'),
      matter.stringify('# Hello', { title: 'Getting Started' }),
    )

    const ctx = await createContext()
    const result = await ctx.readByUrlPath<{ title: string; body: string }>(
      '/docs/guides/getting-started',
    )
    expect(result).not.toBeNull()
    expect(result!.data.title).toBe('Getting Started')
    expect(result!.data.body.trim()).toBe('# Hello')
  })

  it('returns null for non-existent path', async () => {
    await fs.mkdir(path.join(root, 'content/docs'), { recursive: true })

    const ctx = await createContext()
    const result = await ctx.readByUrlPath('/docs/missing')
    expect(result).toBeNull()
  })

  it('returns null for empty path', async () => {
    const ctx = await createContext()
    const result = await ctx.readByUrlPath('/')
    expect(result).toBeNull()
  })

  it('returns null (not throw) when a candidate read is FORBIDDEN, so pages can notFound()', async () => {
    const services = await createTestServices(
      {
        defaultBranchAccess: 'deny',
        defaultPathAccess: 'deny',
        schema: testSchema,
      },
      { getSettingsBranchRoot: () => Promise.resolve(root) },
    )

    const docsDir = path.join(root, 'content/docs')
    await fs.mkdir(docsDir, { recursive: true })
    await fs.writeFile(path.join(docsDir, 'secret.json'), JSON.stringify({ title: 'Secret' }))

    // Use a non-admin user to trigger permission checks
    const canopyCtx = createCanopyContext({
      services,
      extractUser: async () => ({
        type: 'authenticated' as const,
        userId: 'regular-user',
        name: 'Regular User',
        email: 'user@example.com',
        groups: [],
      }),
    })

    const ctx = await canopyCtx.getContext()
    await expect(ctx.readByUrlPath('/docs/secret')).resolves.toBeNull()
  })

  it('still rejects when a real (non-ContentStoreError) error surfaces while probing candidates', async () => {
    const services = await createTestServices(
      {
        defaultBranchAccess: 'allow',
        defaultPathAccess: 'allow',
        schema: testSchema,
      },
      { getSettingsBranchRoot: () => Promise.resolve(root) },
    )

    const ctx = await createCanopyContext({
      services,
      extractUser: async () => STATIC_DEPLOY_USER,
    }).getContext()

    injectNonContentStoreError = true
    try {
      await expect(ctx.readByUrlPath('/docs/whatever')).rejects.toThrow(
        'simulated non-ContentStoreError failure',
      )
    } finally {
      injectNonContentStoreError = false
    }
  })

  it('falls through when first candidate resolves to a non-collection schema item', async () => {
    // URL /docs/doc/overview generates candidates:
    //   1. { entryPath: 'content/docs/doc', slug: 'overview' } — 'content/docs/doc' is an entry-type, not a collection
    //   2. { entryPath: 'content/docs/doc/overview', slug: 'index' } — not in schema
    // Both should fall through gracefully, returning null (not throwing)
    await fs.mkdir(path.join(root, 'content/docs'), { recursive: true })

    const ctx = await createContext()
    const result = await ctx.readByUrlPath('/docs/doc/overview')
    expect(result).toBeNull()
  })

  describe('case sensitivity', () => {
    it('resolves lowercase URL to mixed-case filename', async () => {
      const docsDir = path.join(root, 'content/docs')
      await fs.mkdir(docsDir, { recursive: true })
      // File on disk has mixed case in the slug portion
      await fs.writeFile(
        path.join(docsDir, 'Getting-Started.json'),
        JSON.stringify({ title: 'Getting Started' }),
      )

      const ctx = await createContext()
      const result = await ctx.readByUrlPath<{ title: string }>('/docs/getting-started')
      expect(result).not.toBeNull()
      expect(result!.data.title).toBe('Getting Started')
    })

    it('resolves nested path with mixed-case filename', async () => {
      const guidesDir = path.join(root, 'content/docs/guides')
      await fs.mkdir(guidesDir, { recursive: true })
      await fs.writeFile(
        path.join(guidesDir, 'Getting-Started.md'),
        matter.stringify('Guide content', { title: 'Guide' }),
      )

      const ctx = await createContext()
      const result = await ctx.readByUrlPath<{ title: string }>('/docs/guides/getting-started')
      expect(result).not.toBeNull()
      expect(result!.data.title).toBe('Guide')
    })

    it('resolves mixed-case URL path to lowercase content', async () => {
      const docsDir = path.join(root, 'content/docs')
      await fs.mkdir(docsDir, { recursive: true })
      await fs.writeFile(path.join(docsDir, 'overview.json'), JSON.stringify({ title: 'Overview' }))

      const ctx = await createContext()
      // URL has mixed case — should still resolve since slug matching lowercases both sides
      const result = await ctx.readByUrlPath<{ title: string }>('/docs/Overview')
      expect(result).not.toBeNull()
      expect(result!.data.title).toBe('Overview')
    })
  })

  it('reads a yaml index entry via readByUrlPath', async () => {
    // Schema with a collection whose default is mdx but also has a yaml entry type
    const yamlSchema = {
      collections: [
        {
          name: 'catalog',
          path: 'catalog',
          entries: [
            {
              name: 'page',
              format: 'mdx' as const,
              default: true,
              schema: [
                { name: 'title', type: 'string' as const },
                { name: 'body', type: 'markdown' as const, isBody: true },
              ],
            },
            {
              name: 'catalogIndex',
              format: 'yaml' as const,
              schema: [{ name: 'source', type: 'string' as const }],
            },
          ],
        },
      ],
    }

    const catalogDir = path.join(root, 'content/catalog')
    await fs.mkdir(catalogDir, { recursive: true })
    // Write a YAML index entry with the standard filename pattern: type.slug.id.ext
    await fs.writeFile(
      path.join(catalogDir, 'catalogIndex.index.RRMDbToFJNTf.yaml'),
      yamlStringify({ source: 'NIH' }),
    )

    const services = await createTestServices(
      {
        defaultBranchAccess: 'allow',
        defaultPathAccess: 'allow',
        schema: yamlSchema,
      },
      { getSettingsBranchRoot: () => Promise.resolve(root) },
    )
    const canopyCtx = createCanopyContext({
      services,
      extractUser: async () => STATIC_DEPLOY_USER,
    })
    const ctx = await canopyCtx.getContext()
    const result = await ctx.readByUrlPath<{ source: string }>('/catalog')
    expect(result).not.toBeNull()
    expect(result!.data.source).toBe('NIH')
    // Should not have a body field — YAML is data-only
    expect('body' in result!.data).toBe(false)
  })

  describe('meta.physicalPath', () => {
    it('points at the resolved entry file (absolute) for a nested entry', async () => {
      const guidesDir = path.join(root, 'content/docs/guides')
      await fs.mkdir(guidesDir, { recursive: true })
      const filePath = path.join(guidesDir, 'getting-started.md')
      await fs.writeFile(filePath, matter.stringify('# Hello', { title: 'Getting Started' }))

      const ctx = await createContext()
      const result = await ctx.readByUrlPath<{ title: string }>('/docs/guides/getting-started')
      expect(result).not.toBeNull()
      expect(path.isAbsolute(result!.meta.physicalPath)).toBe(true)
      expect(result!.meta.physicalPath).toBe(filePath)
    })

    it('points at the index file for an index entry', async () => {
      const guidesDir = path.join(root, 'content/docs/guides')
      await fs.mkdir(guidesDir, { recursive: true })
      const indexPath = path.join(guidesDir, 'index.md')
      await fs.writeFile(indexPath, matter.stringify('Welcome', { title: 'Guides Index' }))

      const ctx = await createContext()
      // /docs/guides → falls back to content/docs/guides + slug "index"
      const result = await ctx.readByUrlPath<{ title: string }>('/docs/guides')
      expect(result).not.toBeNull()
      expect(path.isAbsolute(result!.meta.physicalPath)).toBe(true)
      expect(result!.meta.physicalPath).toBe(indexPath)
    })

    it('reflects the current on-disk file after a slug rename (no stale index)', async () => {
      // This is the symptom that drove the ask: a build-time urlPath→absPath map went
      // stale when a content slug was renamed (mars → mars-university). readByUrlPath
      // resolves the path fresh from disk every call, so the rename is reflected.
      const docsDir = path.join(root, 'content/docs')
      await fs.mkdir(docsDir, { recursive: true })
      // Real Canopy filenames embed a content ID: {type}.{slug}.{id}.{ext}
      const id = 'RRMDbToFJNTf'
      const before = path.join(docsDir, `doc.mars.${id}.json`)
      await fs.writeFile(before, JSON.stringify({ title: 'Mars' }))

      const ctx = await createContext()
      const first = await ctx.readByUrlPath<{ title: string }>('/docs/mars')
      expect(first).not.toBeNull()
      expect(first!.meta.physicalPath).toBe(before)

      // Rename the slug on disk, preserving the content ID — same ctx, no cache rebuild.
      const after = path.join(docsDir, `doc.mars-university.${id}.json`)
      await fs.rename(before, after)

      const second = await ctx.readByUrlPath<{ title: string }>('/docs/mars-university')
      expect(second).not.toBeNull()
      expect(second!.meta.physicalPath).toBe(after)
      expect(second!.meta.physicalPath).not.toContain('doc.mars.')
    })

    it('is a valid PhysicalPath for an ID-bearing entry file', async () => {
      const docsDir = path.join(root, 'content/docs')
      await fs.mkdir(docsDir, { recursive: true })
      await fs.writeFile(
        path.join(docsDir, 'doc.overview.RRMDbToFJNTf.json'),
        JSON.stringify({ title: 'Overview' }),
      )

      const ctx = await createContext()
      const result = await ctx.readByUrlPath<{ title: string }>('/docs/overview')
      expect(result).not.toBeNull()
      expect(parsePhysicalPath(result!.meta.physicalPath).ok).toBe(true)
    })
  })

  describe('meta.entryType / meta.entryId', () => {
    it('resolves the entry type and content ID for a direct entry match', async () => {
      const docsDir = path.join(root, 'content/docs')
      await fs.mkdir(docsDir, { recursive: true })
      // Real Canopy filenames embed the entry type and content ID: {type}.{slug}.{id}.{ext}
      await fs.writeFile(
        path.join(docsDir, 'doc.overview.RRMDbToFJNTf.json'),
        JSON.stringify({ title: 'Overview' }),
      )

      const ctx = await createContext()
      const result = await ctx.readByUrlPath<{ title: string }>('/docs/overview')
      expect(result).not.toBeNull()
      expect(result!.meta.entryType).toBe('doc')
      expect(result!.meta.entryId).toBe('RRMDbToFJNTf')
    })

    it('resolves the entry type and content ID for an index-entry fallback', async () => {
      const guidesDir = path.join(root, 'content/docs/guides')
      await fs.mkdir(guidesDir, { recursive: true })
      await fs.writeFile(
        path.join(guidesDir, 'guide.index.aB3cD4eF5gH6.md'),
        matter.stringify('Welcome', { title: 'Guides Index' }),
      )

      const ctx = await createContext()
      const result = await ctx.readByUrlPath<{ title: string }>('/docs/guides')
      expect(result).not.toBeNull()
      expect(result!.meta.entryType).toBe('guide')
      expect(result!.meta.entryId).toBe('aB3cD4eF5gH6')
    })
  })
})
