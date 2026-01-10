import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { defineCanopyTestConfig } from '../config-test'
import { flattenSchema } from '../config'
import { createCheckBranchAccess } from '../authz'
import { createCheckContentAccess } from '../content-access'
import type { PathPermission } from '../config'
import { listEntriesHandler } from './entries'
import { createMockApiContext, createMockBranchContext } from '../test-utils'

const tmpDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-entries-'))

describe('listEntries', () => {
  it('lists entries with access filtering and pagination', async () => {
    const root = await tmpDir()
    await fs.mkdir(path.join(root, 'content/posts'), { recursive: true })
    await fs.writeFile(
      path.join(root, 'content/posts/first.json'),
      JSON.stringify({ title: 'First Post' }),
      'utf8',
    )
    await fs.writeFile(
      path.join(root, 'content/posts/hidden.json'),
      JSON.stringify({ title: 'Hidden Post' }),
      'utf8',
    )
    await fs.writeFile(
      path.join(root, 'content/settings.json'),
      JSON.stringify({ siteName: 'CanopyCMS' }),
      'utf8',
    )

    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'allow',
      schema: {
        collections: [
          {
            name: 'posts',
            path: 'posts',
            entries: { format: 'json', fields: [{ name: 'title', type: 'string' }] },
          },
        ],
        singletons: [
          {
            name: 'settings',
            path: 'settings',
            format: 'json',
            fields: [{ name: 'siteName', type: 'string' }],
          },
        ],
      },
    })

    // Mock loadPathPermissions to return rules that hide 'hidden.json' from user 'u1'
    const pathRules: PathPermission[] = [
      { path: 'content/posts/hidden.json', edit: { allowedUsers: ['other'] } },
    ]
    const mockLoadPermissions = vi.fn().mockResolvedValue(pathRules)

    const checkBranchAccess = createCheckBranchAccess('allow')
    const checkContentAccess = createCheckContentAccess({
      checkBranchAccess,
      loadPathPermissions: mockLoadPermissions,
      defaultPathAccess: 'allow',
    })

    const ctx = createMockApiContext({
      services: {
        config,
        flatSchema: flattenSchema(config.schema, config.contentRoot),
        checkBranchAccess,
        checkContentAccess,
      },
      branchContext: createMockBranchContext({
        branchName: 'main',
        baseRoot: root,
        branchRoot: root,
        createdBy: 'u1',
      }),
    })

    // Request limit=2 to get both the singleton and at least one collection entry
    const res = await listEntriesHandler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'main', limit: 2 },
    )

    expect(res.ok).toBe(true)
    // Should include the singleton (settings) and the first post
    expect(
      res.data?.entries.some((e) => e.collectionName === 'settings' && e.itemType === 'singleton'),
    ).toBe(true)
    expect(res.data?.entries.some((e) => e.slug === 'first')).toBe(true)
    expect(res.data?.entries.some((e) => e.slug === 'hidden')).toBe(false)
    const summaries = res.data?.collections ?? []
    const flat = (nodes: typeof summaries): typeof summaries =>
      nodes.flatMap((n) => [n, ...(n.children ? flat(n.children) : [])])
    expect(flat(summaries).find((c) => c.name === 'settings')?.type).toBe('entry')
    expect(res.data?.pagination.hasMore).toBe(true)
  })

  it('returns 404 when branch is missing', async () => {
    const ctx = createMockApiContext({ branchContext: null })
    const res = await listEntriesHandler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'missing' },
    )
    expect(res.status).toBe(404)
    expect(res.ok).toBe(false)
  })

  it('lists entries recursively from deeply nested collections', async () => {
    const root = await tmpDir()

    // Create 3-level nested structure: docs/api/v2
    await fs.mkdir(path.join(root, 'content/docs'), { recursive: true })
    await fs.mkdir(path.join(root, 'content/docs/api'), { recursive: true })
    await fs.mkdir(path.join(root, 'content/docs/api/v2'), { recursive: true })

    // Create entries at each level
    await fs.writeFile(
      path.join(root, 'content/docs/overview.json'),
      JSON.stringify({ title: 'Overview' }),
      'utf8',
    )
    await fs.writeFile(
      path.join(root, 'content/docs/api/intro.json'),
      JSON.stringify({ title: 'API Introduction' }),
      'utf8',
    )
    await fs.writeFile(
      path.join(root, 'content/docs/api/v2/auth.json'),
      JSON.stringify({ title: 'Authentication' }),
      'utf8',
    )
    await fs.writeFile(
      path.join(root, 'content/docs/api/v2/users.json'),
      JSON.stringify({ title: 'Users API' }),
      'utf8',
    )

    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'allow',
      schema: {
        collections: [
          {
            name: 'docs',
            path: 'docs',
            entries: { format: 'json', fields: [{ name: 'title', type: 'string' }] },
            collections: [
              {
                name: 'api',
                path: 'api',
                entries: { format: 'json', fields: [{ name: 'title', type: 'string' }] },
                collections: [
                  {
                    name: 'v2',
                    path: 'v2',
                    entries: { format: 'json', fields: [{ name: 'title', type: 'string' }] },
                  },
                ],
              },
            ],
          },
        ],
        singletons: [],
      },
    })

    const checkBranchAccess = createCheckBranchAccess('allow')
    const checkContentAccess = createCheckContentAccess({
      checkBranchAccess,
      loadPathPermissions: vi.fn().mockResolvedValue([]),
      defaultPathAccess: 'allow',
    })

    const ctx = createMockApiContext({
      services: {
        config,
        flatSchema: flattenSchema(config.schema, config.contentRoot),
        checkBranchAccess,
        checkContentAccess,
      },
      branchContext: createMockBranchContext({
        branchName: 'main',
        baseRoot: root,
        branchRoot: root,
        createdBy: 'u1',
      }),
    })

    // Test 1: Without collectionId - lists entries from all collections (flat list)
    const allEntriesRes = await listEntriesHandler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'main' },
    )

    expect(allEntriesRes.ok).toBe(true)
    expect(allEntriesRes.data?.entries.length).toBe(4) // All entries from all collections
    expect(allEntriesRes.data?.entries.some((e) => e.slug === 'overview')).toBe(true)
    expect(allEntriesRes.data?.entries.some((e) => e.slug === 'intro')).toBe(true)
    expect(allEntriesRes.data?.entries.some((e) => e.slug === 'auth')).toBe(true)
    expect(allEntriesRes.data?.entries.some((e) => e.slug === 'users')).toBe(true)

    // Test 2: With collectionId, non-recursive - only gets entries from 'content/docs' collection (no children)
    const docsNonRecursiveRes = await listEntriesHandler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'main', collection: 'content/docs' },
    )

    expect(docsNonRecursiveRes.ok).toBe(true)
    expect(docsNonRecursiveRes.data?.entries.length).toBe(1) // Only 'overview' from docs
    expect(docsNonRecursiveRes.data?.entries.some((e) => e.slug === 'overview')).toBe(true)
    expect(docsNonRecursiveRes.data?.entries.some((e) => e.slug === 'intro')).toBe(false) // From child collection
    expect(docsNonRecursiveRes.data?.entries.some((e) => e.slug === 'auth')).toBe(false) // From grandchild collection

    // Test 3: With collectionId and recursive flag - gets entries from 'content/docs' and all children
    const docsRecursiveRes = await listEntriesHandler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'main', collection: 'content/docs', recursive: true },
    )

    expect(docsRecursiveRes.ok).toBe(true)
    expect(docsRecursiveRes.data?.entries.length).toBe(4) // All entries from docs tree
    expect(docsRecursiveRes.data?.entries.some((e) => e.slug === 'overview')).toBe(true)
    expect(docsRecursiveRes.data?.entries.some((e) => e.slug === 'intro')).toBe(true)
    expect(docsRecursiveRes.data?.entries.some((e) => e.slug === 'auth')).toBe(true)
    expect(docsRecursiveRes.data?.entries.some((e) => e.slug === 'users')).toBe(true)

    // Test 4: Nested collection with recursive - gets entries from 'content/docs/api' and its children
    const apiRecursiveRes = await listEntriesHandler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'main', collection: 'content/docs/api', recursive: true },
    )

    expect(apiRecursiveRes.ok).toBe(true)
    expect(apiRecursiveRes.data?.entries.length).toBe(3) // intro, auth, users (not overview)
    expect(apiRecursiveRes.data?.entries.some((e) => e.slug === 'overview')).toBe(false) // From parent
    expect(apiRecursiveRes.data?.entries.some((e) => e.slug === 'intro')).toBe(true)
    expect(apiRecursiveRes.data?.entries.some((e) => e.slug === 'auth')).toBe(true)
    expect(apiRecursiveRes.data?.entries.some((e) => e.slug === 'users')).toBe(true)

    // Verify collectionIds match the nested structure
    const authEntry = docsRecursiveRes.data?.entries.find((e) => e.slug === 'auth')
    expect(authEntry?.collectionId).toBe('content/docs/api/v2')
  })

  it('returns singletons with schemas using new schema format', async () => {
    const root = await tmpDir()
    await fs.mkdir(path.join(root, 'content'), { recursive: true })
    await fs.writeFile(
      path.join(root, 'content/home.json'),
      JSON.stringify({ title: 'Home Page', tagline: 'Welcome' }),
      'utf8',
    )

    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'allow',
      contentRoot: 'content',
      schema: {
        singletons: [
          {
            name: 'home',
            label: 'Home',
            path: 'home',
            format: 'json',
            fields: [
              { name: 'title', type: 'string' },
              { name: 'tagline', type: 'string' },
            ],
          },
        ],
      },
    })

    const checkBranchAccess = createCheckBranchAccess('allow')
    const checkContentAccess = createCheckContentAccess({
      checkBranchAccess,
      loadPathPermissions: async () => [],
      defaultPathAccess: 'allow',
    })

    const ctx = createMockApiContext({
      services: {
        config,
        flatSchema: flattenSchema(config.schema, config.contentRoot),
        checkBranchAccess,
        checkContentAccess,
      },
      branchContext: createMockBranchContext({
        branchName: 'main',
        baseRoot: root,
        branchRoot: root,
        createdBy: 'u1',
      }),
    })

    const res = await listEntriesHandler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'main' },
    )

    expect(res.ok).toBe(true)

    // Verify singleton entry is returned
    const homeEntry = res.data?.entries.find((e) => e.collectionId === 'content/home')
    expect(homeEntry).toBeDefined()
    expect(homeEntry?.itemType).toBe('singleton')
    expect(homeEntry?.slug).toBe('')

    // Verify singleton is in collections array with schema
    const homeCollection = res.data?.collections.find((c) => c.id === 'content/home')
    expect(homeCollection).toBeDefined()
    expect(homeCollection?.type).toBe('entry')
    expect(homeCollection?.schema).toHaveLength(2)
    expect(homeCollection?.schema[0].name).toBe('title')
    expect(homeCollection?.schema[1].name).toBe('tagline')
  })
})
