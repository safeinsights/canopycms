import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { defineCanopyTestConfig } from '../config-test'
import { flattenSchema } from '../config'
import { createCheckBranchAccess } from '../authorization'
import { createCheckContentAccess } from '../authorization'
import type { PathPermission } from '../config'
import { listEntriesHandler } from './entries'
import { createMockApiContext, createMockBranchContext } from '../test-utils'
import { loadCollectionMetaFiles, resolveCollectionReferences } from '../schema'

const tmpDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-entries-'))

describe('listEntries', () => {
  it('lists entries with access filtering and pagination', async () => {
    const root = await tmpDir()
    await fs.mkdir(path.join(root, 'content/posts'), { recursive: true })
    await fs.writeFile(
      path.join(root, 'content/posts/entry.first.abc123def456.json'),
      JSON.stringify({ title: 'First Post' }),
      'utf8',
    )
    await fs.writeFile(
      path.join(root, 'content/posts/entry.hidden.xyz789abcDEF.json'),
      JSON.stringify({ title: 'Hidden Post' }),
      'utf8',
    )
    await fs.writeFile(
      path.join(root, 'content/settings.abc123XYZ789.json'),
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
            entries: [
              { name: 'entry', format: 'json', fields: [{ name: 'title', type: 'string' }] },
            ],
          },
        ],
      },
    })

    // Mock loadPathPermissions to return rules that hide 'entry.hidden.xyz789abcDEF.json' from user 'u1'
    // Use 'read' access restriction to actually hide the file from listing
    const pathRules: PathPermission[] = [
      { path: 'content/posts/entry.hidden.xyz789abcDEF.json', read: { allowedUsers: ['other'] } },
    ]
    const mockLoadPermissions = vi.fn().mockResolvedValue(pathRules)

    const checkBranchAccess = createCheckBranchAccess('allow')
    const checkContentAccess = createCheckContentAccess({
      checkBranchAccess,
      loadPathPermissions: mockLoadPermissions,
      defaultPathAccess: 'allow',
      mode: 'dev',
    })

    const ctx = createMockApiContext({
      services: {
        config,
        flatSchema: flattenSchema(config.schema!, config.contentRoot),
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

    // Request limit=2 to get entries
    const res = await listEntriesHandler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'main', limit: 2 },
    )

    expect(res.ok).toBe(true)
    // Should include posts but not hidden.json (restricted by permission)
    expect(res.data?.entries.some((e) => e.slug === 'first')).toBe(true)
    expect(res.data?.entries.some((e) => e.slug === 'hidden')).toBe(false)
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

    // Create 3-level nested structure with embedded IDs: docs/api/v2
    // This mirrors the real example1 structure
    const docsId = 'bChqT78gcaLd'
    const apiId = 'meiuwxTSo7UN'
    const v2Id = 'muwmyafM6mEJ'

    await fs.mkdir(path.join(root, `content/docs.${docsId}`), { recursive: true })
    await fs.mkdir(path.join(root, `content/docs.${docsId}/api.${apiId}`), { recursive: true })
    await fs.mkdir(path.join(root, `content/docs.${docsId}/api.${apiId}/v2.${v2Id}`), {
      recursive: true,
    })

    // Create entries at each level with embedded IDs in filenames
    const overviewId = 'gnVmHnnMjWrD'
    const introId = 'k396pBDVP8tC'
    const authId = 'kmtzTh2k9Axq'
    const usersId = 'ppqJw61uKkV5'

    await fs.writeFile(
      path.join(root, `content/docs.${docsId}/entry.overview.${overviewId}.json`),
      JSON.stringify({ title: 'Overview' }),
      'utf8',
    )
    await fs.writeFile(
      path.join(root, `content/docs.${docsId}/api.${apiId}/entry.intro.${introId}.json`),
      JSON.stringify({ title: 'API Introduction' }),
      'utf8',
    )
    await fs.writeFile(
      path.join(root, `content/docs.${docsId}/api.${apiId}/v2.${v2Id}/entry.auth.${authId}.json`),
      JSON.stringify({ title: 'Authentication' }),
      'utf8',
    )
    await fs.writeFile(
      path.join(root, `content/docs.${docsId}/api.${apiId}/v2.${v2Id}/entry.users.${usersId}.json`),
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
            entries: [
              { name: 'entry', format: 'json', fields: [{ name: 'title', type: 'string' }] },
            ],
            collections: [
              {
                name: 'api',
                path: 'api',
                entries: [
                  { name: 'entry', format: 'json', fields: [{ name: 'title', type: 'string' }] },
                ],
                collections: [
                  {
                    name: 'v2',
                    path: 'v2',
                    entries: [
                      {
                        name: 'entry',
                        format: 'json',
                        fields: [{ name: 'title', type: 'string' }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    })

    const checkBranchAccess = createCheckBranchAccess('allow')
    const checkContentAccess = createCheckContentAccess({
      checkBranchAccess,
      loadPathPermissions: vi.fn().mockResolvedValue([]),
      defaultPathAccess: 'allow',
      mode: 'dev',
    })

    const ctx = createMockApiContext({
      services: {
        config,
        flatSchema: flattenSchema(config.schema!, config.contentRoot),
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

  it('returns entries with schemas using new schema format', async () => {
    const root = await tmpDir()
    await fs.mkdir(path.join(root, 'content/pages'), { recursive: true })
    await fs.writeFile(
      path.join(root, 'content/pages/page.home.abc123XYZ789.json'),
      JSON.stringify({ title: 'Home Page', tagline: 'Welcome' }),
      'utf8',
    )

    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'allow',
      contentRoot: 'content',
      schema: {
        collections: [
          {
            name: 'pages',
            label: 'Pages',
            path: 'pages',
            entries: [
              {
                name: 'page',
                format: 'json',
                fields: [
                  { name: 'title', type: 'string' },
                  { name: 'tagline', type: 'string' },
                ],
              },
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
      mode: 'dev',
    })

    const ctx = createMockApiContext({
      services: {
        config,
        flatSchema: flattenSchema(config.schema!, config.contentRoot),
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

    // Verify entry is returned
    const homeEntry = res.data?.entries.find((e) => e.slug === 'home')
    expect(homeEntry).toBeDefined()
    expect(homeEntry?.collectionId).toBe('content/pages')

    // Verify collection is in collections array with schema
    const pagesCollection = res.data?.collections.find((c) => c.logicalPath === 'content/pages')
    expect(pagesCollection).toBeDefined()
    expect(pagesCollection?.type).toBe('collection')
    expect(pagesCollection?.schema).toHaveLength(2)
    expect(pagesCollection?.schema[0].name).toBe('title')
    expect(pagesCollection?.schema[1].name).toBe('tagline')
  })

  it('includes canEdit flag based on edit permissions', async () => {
    const root = await tmpDir()
    await fs.mkdir(path.join(root, 'content/posts'), { recursive: true })
    await fs.writeFile(
      path.join(root, 'content/posts/entry.public.abc123XYZ789.json'),
      JSON.stringify({ title: 'Public Post' }),
      'utf8',
    )
    await fs.writeFile(
      path.join(root, 'content/posts/entry.readonly.def456UVW012.json'),
      JSON.stringify({ title: 'Read-Only Post' }),
      'utf8',
    )

    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'allow',
      schema: {
        collections: [
          {
            name: 'posts',
            path: 'posts',
            entries: [
              { name: 'entry', format: 'json', fields: [{ name: 'title', type: 'string' }] },
            ],
          },
        ],
      },
    })

    // Mock loadPathPermissions: 'entry.readonly.def456UVW012.json' is read-only for user 'u1'
    const pathRules: PathPermission[] = [
      {
        path: 'content/posts/entry.readonly.def456UVW012.json',
        read: { allowedUsers: ['u1'] },
        edit: { allowedUsers: ['admin'] }, // u1 cannot edit
      },
    ]
    const mockLoadPermissions = vi.fn().mockResolvedValue(pathRules)

    const checkBranchAccess = createCheckBranchAccess('allow')
    const checkContentAccess = createCheckContentAccess({
      checkBranchAccess,
      loadPathPermissions: mockLoadPermissions,
      defaultPathAccess: 'allow',
      mode: 'dev',
    })

    const ctx = createMockApiContext({
      services: {
        config,
        flatSchema: flattenSchema(config.schema!, config.contentRoot),
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
    expect(res.data?.entries).toHaveLength(2)

    // Check canEdit flag on entries
    const publicEntry = res.data?.entries.find((e) => e.slug === 'public')
    const readonlyEntry = res.data?.entries.find((e) => e.slug === 'readonly')

    expect(publicEntry?.canEdit).toBe(true) // u1 can edit public post (default allow)
    expect(readonlyEntry?.canEdit).toBe(false) // u1 cannot edit readonly post (restricted to admin)
  })

  it('lists entries with embedded IDs in filenames', async () => {
    const root = await tmpDir()

    // Create content directory
    await fs.mkdir(path.join(root, 'content'), { recursive: true })

    // Create collection folder with ID (like authors.q52DCVPuH4ga)
    const authorsId = 'q52DCVPuH4ga'
    await fs.mkdir(path.join(root, `content/authors.${authorsId}`), { recursive: true })

    // Create .collection.json file (matching example1's approach)
    await fs.writeFile(
      path.join(root, `content/authors.${authorsId}/.collection.json`),
      JSON.stringify({
        name: 'authors',
        label: 'Authors',
        entries: [
          {
            name: 'author',
            format: 'json',
            fields: 'authorSchema',
          },
        ],
      }),
      'utf8',
    )

    // Create entry files with embedded IDs: {type}.{slug}.{id}.{ext}
    const aliceId = '5NVkkrB1MJUv'
    const bobId = 'jm6FYVAtJie8'
    await fs.writeFile(
      path.join(root, `content/authors.${authorsId}/author.alice.${aliceId}.json`),
      JSON.stringify({ name: 'Alice', bio: 'Developer' }),
      'utf8',
    )
    await fs.writeFile(
      path.join(root, `content/authors.${authorsId}/author.bob.${bobId}.json`),
      JSON.stringify({ name: 'Bob', bio: 'Designer' }),
      'utf8',
    )

    // Load schema from .collection.json files (like services do)
    const schemaRegistry = {
      authorSchema: [
        { name: 'name', type: 'string' },
        { name: 'bio', type: 'string' },
      ],
    }

    const metaFiles = await loadCollectionMetaFiles(path.join(root, 'content'))
    const schema = resolveCollectionReferences(metaFiles, schemaRegistry)

    // Create config with the loaded schema
    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'allow',
      contentRoot: 'content',
      schema,
    })

    const checkBranchAccess = createCheckBranchAccess('allow')
    const checkContentAccess = createCheckContentAccess({
      checkBranchAccess,
      loadPathPermissions: vi.fn().mockResolvedValue([]),
      defaultPathAccess: 'allow',
      mode: 'dev',
    })

    const ctx = createMockApiContext({
      services: {
        config,
        flatSchema: flattenSchema(config.schema!, config.contentRoot),
        schemaRegistry,
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
    expect(res.data?.entries).toHaveLength(2) // alice + bob

    // Verify slugs are extracted correctly (without IDs) for collection entries
    const aliceEntry = res.data?.entries.find((e) => e.slug === 'alice')
    const bobEntry = res.data?.entries.find((e) => e.slug === 'bob')

    expect(aliceEntry).toBeDefined()
    expect(aliceEntry?.slug).toBe('alice')
    expect(aliceEntry?.title).toBe('Alice')
    expect(aliceEntry?.collectionId).toBe('content/authors') // Logical path, no ID

    expect(bobEntry).toBeDefined()
    expect(bobEntry?.slug).toBe('bob')
    expect(bobEntry?.title).toBe('Bob')
    expect(bobEntry?.collectionId).toBe('content/authors') // Logical path, no ID
  })

  it.skip('lists root-level entry types with maxItems: 1', async () => {
    const root = await tmpDir()

    // Create content directory
    await fs.mkdir(path.join(root, 'content'), { recursive: true })

    // Create root .collection.json with entries (not singletons)
    await fs.writeFile(
      path.join(root, 'content/.collection.json'),
      JSON.stringify({
        entries: [
          {
            name: 'home',
            label: 'Home',
            format: 'json',
            fields: 'homeSchema',
            maxItems: 1,
          },
          {
            name: 'settings',
            label: 'Settings',
            format: 'json',
            fields: 'settingsSchema',
            maxItems: 1,
          },
        ],
      }),
      'utf8',
    )

    // Create root-level entry files (pattern: {name}.{id}.{ext})
    const homeId = 'agfzDt2RLpSn'
    const settingsId = 'Xp7qR2sL9mKn'
    await fs.writeFile(
      path.join(root, `content/home.${homeId}.json`),
      JSON.stringify({ title: 'Welcome Home', hero: 'Hello World' }),
      'utf8',
    )
    await fs.writeFile(
      path.join(root, `content/settings.${settingsId}.json`),
      JSON.stringify({ siteName: 'My Site', theme: 'dark' }),
      'utf8',
    )

    // Also create a collection to verify both work together
    const postsId = '916jXZabYCxu'
    await fs.mkdir(path.join(root, `content/posts.${postsId}`), { recursive: true })
    await fs.writeFile(
      path.join(root, `content/posts.${postsId}/.collection.json`),
      JSON.stringify({
        name: 'posts',
        label: 'Posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      }),
      'utf8',
    )
    await fs.writeFile(
      path.join(root, `content/posts.${postsId}/first.abc123.json`),
      JSON.stringify({ title: 'First Post' }),
      'utf8',
    )

    // Load schema from .collection.json files
    const schemaRegistry = {
      homeSchema: [
        { name: 'title', type: 'string' },
        { name: 'hero', type: 'string' },
      ],
      settingsSchema: [
        { name: 'siteName', type: 'string' },
        { name: 'theme', type: 'string' },
      ],
      postSchema: [{ name: 'title', type: 'string' }],
    }

    const metaFiles = await loadCollectionMetaFiles(path.join(root, 'content'))
    const schema = resolveCollectionReferences(metaFiles, schemaRegistry)

    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'allow',
      contentRoot: 'content',
      schema,
    })

    const checkBranchAccess = createCheckBranchAccess('allow')
    const checkContentAccess = createCheckContentAccess({
      checkBranchAccess,
      loadPathPermissions: vi.fn().mockResolvedValue([]),
      defaultPathAccess: 'allow',
      mode: 'dev',
    })

    const ctx = createMockApiContext({
      services: {
        config,
        flatSchema: flattenSchema(config.schema!, config.contentRoot),
        schemaRegistry,
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
    // Should have 3 entries: home, settings (root-level) + first post (collection)
    expect(res.data?.entries).toHaveLength(3)

    // Check root-level entry types
    const homeEntry = res.data?.entries.find(
      (e) => e.slug === 'home' && e.collectionId === 'content',
    )
    expect(homeEntry).toBeDefined()
    expect(homeEntry?.slug).toBe('home') // Name acts as slug
    expect(homeEntry?.title).toBe('Welcome Home')
    expect(homeEntry?.collectionId).toBe('content') // Parent path, not full path
    expect(homeEntry?.entryType).toBe('home')

    const settingsEntry = res.data?.entries.find(
      (e) => e.slug === 'settings' && e.collectionId === 'content',
    )
    expect(settingsEntry).toBeDefined()
    expect(settingsEntry?.slug).toBe('settings') // Name acts as slug
    expect(settingsEntry?.title).toBe('Settings') // Falls back to label since siteName isn't title
    expect(settingsEntry?.collectionId).toBe('content') // Parent path, not full path
    expect(settingsEntry?.entryType).toBe('settings')

    // Check collection entry still works
    const postEntry = res.data?.entries.find((e) => e.slug === 'first')
    expect(postEntry).toBeDefined()
    expect(postEntry?.collectionId).toBe('content/posts')
  })
})
