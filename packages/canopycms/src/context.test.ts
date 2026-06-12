import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import matter from 'gray-matter'
import { stringify as yamlStringify } from 'yaml'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTestServices } from './config-test'
import { createCanopyContext } from './context'
import { ContentStoreError } from './content-store'
import { STATIC_DEPLOY_USER } from './build-mode'
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
vi.mock('./branch-workspace', () => ({
  loadOrCreateBranchContext: async () => testBranchContext,
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

  it('re-throws non-lookup errors (e.g., permission errors)', async () => {
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
    await expect(ctx.readByUrlPath('/docs/secret')).rejects.toThrow(ContentStoreError)
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
})
