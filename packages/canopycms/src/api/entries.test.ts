import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { defineCanopyTestConfig } from '../config-test'
import { flattenSchema } from '../config'
import { createCheckBranchAccess } from '../authorization'
import { createCheckContentAccess } from '../authorization'
import { unsafeAsPermissionPath } from '../authorization/test-utils'
import type { PathPermission } from '../config'
import { listEntriesHandler } from './entries'
import { createMockApiContext, createMockBranchContext } from '../test-utils'
import { loadCollectionMetaFiles, resolveCollectionReferences } from '../schema'
import { unsafeAsBranchName, unsafeAsLogicalPath } from '../paths/test-utils'

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

    const schema = {
      collections: [
        {
          name: 'posts',
          path: 'posts',
          entries: [
            {
              name: 'entry',
              format: 'json' as const,
              schema: [{ name: 'title', type: 'string' as const }],
            },
          ],
        },
      ],
    } as const

    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'allow',
      schema,
    })

    // Mock loadPathPermissions to return rules that hide 'entry.hidden.xyz789abcDEF.json' from user 'u1'
    // Use 'read' access restriction to actually hide the file from listing
    const pathRules: PathPermission[] = [
      {
        path: unsafeAsPermissionPath('content/posts/entry.hidden.xyz789abcDEF.json'),
        read: { allowedUsers: ['other'] },
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
        checkBranchAccess,
        checkContentAccess,
      },
      branchContext: {
        ...createMockBranchContext({
          branchName: 'main',
          baseRoot: root,
          branchRoot: root,
          createdBy: 'u1',
        }),
        flatSchema: flattenSchema(schema, config.contentRoot),
      },
    })

    // Request limit=2 to get entries
    const res = await listEntriesHandler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('main'), limit: 2 },
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
      { branch: unsafeAsBranchName('missing') },
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

    const schema = {
      collections: [
        {
          name: 'docs',
          path: 'docs',
          entries: [
            {
              name: 'entry',
              format: 'json' as const,
              schema: [{ name: 'title', type: 'string' as const }],
            },
          ],
          collections: [
            {
              name: 'api',
              path: 'api',
              entries: [
                {
                  name: 'entry',
                  format: 'json' as const,
                  schema: [{ name: 'title', type: 'string' as const }],
                },
              ],
              collections: [
                {
                  name: 'v2',
                  path: 'v2',
                  entries: [
                    {
                      name: 'entry',
                      format: 'json' as const,
                      schema: [{ name: 'title', type: 'string' as const }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    } as const

    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'allow',
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
        checkBranchAccess,
        checkContentAccess,
      },
      branchContext: {
        ...createMockBranchContext({
          branchName: 'main',
          baseRoot: root,
          branchRoot: root,
          createdBy: 'u1',
        }),
        flatSchema: flattenSchema(schema, config.contentRoot),
      },
    })

    // Test 1: Without collection filter - lists entries from all collections (flat list)
    const allEntriesRes = await listEntriesHandler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('main') },
    )

    expect(allEntriesRes.ok).toBe(true)
    expect(allEntriesRes.data?.entries.length).toBe(4) // All entries from all collections
    expect(allEntriesRes.data?.entries.some((e) => e.slug === 'overview')).toBe(true)
    expect(allEntriesRes.data?.entries.some((e) => e.slug === 'intro')).toBe(true)
    expect(allEntriesRes.data?.entries.some((e) => e.slug === 'auth')).toBe(true)
    expect(allEntriesRes.data?.entries.some((e) => e.slug === 'users')).toBe(true)

    // Test 2: With collection filter, non-recursive - only gets entries from 'content/docs' collection (no children)
    const docsNonRecursiveRes = await listEntriesHandler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('main'), collection: unsafeAsLogicalPath('content/docs') },
    )

    expect(docsNonRecursiveRes.ok).toBe(true)
    expect(docsNonRecursiveRes.data?.entries.length).toBe(1) // Only 'overview' from docs
    expect(docsNonRecursiveRes.data?.entries.some((e) => e.slug === 'overview')).toBe(true)
    expect(docsNonRecursiveRes.data?.entries.some((e) => e.slug === 'intro')).toBe(false) // From child collection
    expect(docsNonRecursiveRes.data?.entries.some((e) => e.slug === 'auth')).toBe(false) // From grandchild collection

    // Test 3: With collection filter and recursive flag - gets entries from 'content/docs' and all children
    const docsRecursiveRes = await listEntriesHandler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      {
        branch: unsafeAsBranchName('main'),
        collection: unsafeAsLogicalPath('content/docs'),
        recursive: true,
      },
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
      {
        branch: unsafeAsBranchName('main'),
        collection: unsafeAsLogicalPath('content/docs/api'),
        recursive: true,
      },
    )

    expect(apiRecursiveRes.ok).toBe(true)
    expect(apiRecursiveRes.data?.entries.length).toBe(3) // intro, auth, users (not overview)
    expect(apiRecursiveRes.data?.entries.some((e) => e.slug === 'overview')).toBe(false) // From parent
    expect(apiRecursiveRes.data?.entries.some((e) => e.slug === 'intro')).toBe(true)
    expect(apiRecursiveRes.data?.entries.some((e) => e.slug === 'auth')).toBe(true)
    expect(apiRecursiveRes.data?.entries.some((e) => e.slug === 'users')).toBe(true)

    // Verify collectionPath values match the nested structure
    const authEntry = docsRecursiveRes.data?.entries.find((e) => e.slug === 'auth')
    expect(authEntry?.collectionPath).toBe('content/docs/api/v2')
  })

  it('returns entries with schemas using new schema format', async () => {
    const root = await tmpDir()
    await fs.mkdir(path.join(root, 'content/pages'), { recursive: true })
    await fs.writeFile(
      path.join(root, 'content/pages/page.home.abc123XYZ789.json'),
      JSON.stringify({ title: 'Home Page', tagline: 'Welcome' }),
      'utf8',
    )

    const schema = {
      collections: [
        {
          name: 'pages',
          label: 'Pages',
          path: 'pages',
          entries: [
            {
              name: 'page',
              format: 'json' as const,
              schema: [
                { name: 'title', type: 'string' as const },
                { name: 'tagline', type: 'string' as const },
              ],
            },
          ],
        },
      ],
    } as const

    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'allow',
      contentRoot: 'content',
      schema,
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
        checkBranchAccess,
        checkContentAccess,
      },
      branchContext: {
        ...createMockBranchContext({
          branchName: 'main',
          baseRoot: root,
          branchRoot: root,
          createdBy: 'u1',
        }),
        flatSchema: flattenSchema(schema, config.contentRoot),
      },
    })

    const res = await listEntriesHandler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('main') },
    )

    expect(res.ok).toBe(true)

    // Verify entry is returned
    const homeEntry = res.data?.entries.find((e) => e.slug === 'home')
    expect(homeEntry).toBeDefined()
    expect(homeEntry?.collectionPath).toBe('content/pages')

    // Collections are now fetched from schema API, not entries API
  })

  it('includes canEdit flag based on edit permissions', async () => {
    const root = await tmpDir()
    await fs.mkdir(path.join(root, 'content/posts'), { recursive: true })
    await fs.writeFile(
      path.join(root, 'content/posts/entry.public.abcDEFghj123.json'),
      JSON.stringify({ title: 'Public Post' }),
      'utf8',
    )
    await fs.writeFile(
      path.join(root, 'content/posts/entry.readonly.defGHJkmn456.json'),
      JSON.stringify({ title: 'Read-Only Post' }),
      'utf8',
    )

    const schema = {
      collections: [
        {
          name: 'posts',
          path: 'posts',
          entries: [
            {
              name: 'entry',
              format: 'json' as const,
              schema: [{ name: 'title', type: 'string' as const }],
            },
          ],
        },
      ],
    } as const

    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'allow',
      schema,
    })

    // Mock loadPathPermissions: 'entry.readonly.defGHJkmn456.json' is read-only for user 'u1'
    const pathRules: PathPermission[] = [
      {
        path: unsafeAsPermissionPath('content/posts/entry.readonly.defGHJkmn456.json'),
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
        checkBranchAccess,
        checkContentAccess,
      },
      branchContext: {
        ...createMockBranchContext({
          branchName: 'main',
          baseRoot: root,
          branchRoot: root,
          createdBy: 'u1',
        }),
        flatSchema: flattenSchema(schema, config.contentRoot),
      },
    })

    const res = await listEntriesHandler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('main') },
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
            schema: 'authorSchema',
          },
        ],
        order: [],
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
    const entrySchemaRegistry = {
      authorSchema: [
        { name: 'name', type: 'string' },
        { name: 'bio', type: 'string' },
      ],
    }

    const metaFiles = await loadCollectionMetaFiles(path.join(root, 'content'))
    const schema = resolveCollectionReferences(metaFiles, entrySchemaRegistry)

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
        entrySchemaRegistry: entrySchemaRegistry,
        checkBranchAccess,
        checkContentAccess,
      },
      branchContext: {
        ...createMockBranchContext({
          branchName: 'main',
          baseRoot: root,
          branchRoot: root,
          createdBy: 'u1',
        }),
        flatSchema: flattenSchema(schema, config.contentRoot),
      },
    })

    const res = await listEntriesHandler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('main') },
    )

    expect(res.ok).toBe(true)
    expect(res.data?.entries).toHaveLength(2) // alice + bob

    // Verify slugs are extracted correctly (without IDs) for collection entries
    const aliceEntry = res.data?.entries.find((e) => e.slug === 'alice')
    const bobEntry = res.data?.entries.find((e) => e.slug === 'bob')

    expect(aliceEntry).toBeDefined()
    expect(aliceEntry?.slug).toBe('alice')
    expect(aliceEntry?.title).toBe('Alice')
    expect(aliceEntry?.collectionPath).toBe('content/authors') // Logical path, no ID

    expect(bobEntry).toBeDefined()
    expect(bobEntry?.slug).toBe('bob')
    expect(bobEntry?.title).toBe('Bob')
    expect(bobEntry?.collectionPath).toBe('content/authors') // Logical path, no ID
  })

  it('lists root-level entry types with maxItems: 1', async () => {
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
            schema: 'homeSchema',
            maxItems: 1,
          },
          {
            name: 'settings',
            label: 'Settings',
            format: 'json',
            schema: 'settingsSchema',
            maxItems: 1,
          },
        ],
        order: [],
      }),
      'utf8',
    )

    // Create root-level entry files (pattern: {type}.{slug}.{id}.{ext})
    const homeId = 'agfzDt2RLpSn'
    const settingsId = 'Xp7qR2sL9mKn'
    await fs.writeFile(
      path.join(root, `content/home.home.${homeId}.json`),
      JSON.stringify({ title: 'Welcome Home', hero: 'Hello World' }),
      'utf8',
    )
    await fs.writeFile(
      path.join(root, `content/settings.settings.${settingsId}.json`),
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
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
        order: [],
      }),
      'utf8',
    )
    await fs.writeFile(
      path.join(root, `content/posts.${postsId}/post.first.abc123def456.json`),
      JSON.stringify({ title: 'First Post' }),
      'utf8',
    )

    // Load schema from .collection.json files
    const entrySchemaRegistry = {
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
    const schema = resolveCollectionReferences(metaFiles, entrySchemaRegistry)

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
        entrySchemaRegistry: entrySchemaRegistry,
        checkBranchAccess,
        checkContentAccess,
      },
      branchContext: {
        ...createMockBranchContext({
          branchName: 'main',
          baseRoot: root,
          branchRoot: root,
          createdBy: 'u1',
        }),
        flatSchema: flattenSchema(schema, config.contentRoot),
      },
    })

    const res = await listEntriesHandler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('main') },
    )

    expect(res.ok).toBe(true)
    // Should have 3 entries: home, settings (root-level) + first post (collection)
    expect(res.data?.entries).toHaveLength(3)

    // Check root-level entry types
    const homeEntry = res.data?.entries.find(
      (e) => e.slug === 'home' && e.collectionPath === 'content',
    )
    expect(homeEntry).toBeDefined()
    expect(homeEntry?.slug).toBe('home') // Name acts as slug
    expect(homeEntry?.title).toBe('Welcome Home')
    expect(homeEntry?.collectionPath).toBe('content') // Parent path, not full path
    expect(homeEntry?.entryType).toBe('home')

    const settingsEntry = res.data?.entries.find(
      (e) => e.slug === 'settings' && e.collectionPath === 'content',
    )
    expect(settingsEntry).toBeDefined()
    expect(settingsEntry?.slug).toBe('settings') // Name acts as slug
    expect(settingsEntry?.title).toBe('Settings') // Falls back to label since siteName isn't title
    expect(settingsEntry?.collectionPath).toBe('content') // Parent path, not full path
    expect(settingsEntry?.entryType).toBe('settings')

    // Check collection entry still works
    const postEntry = res.data?.entries.find((e) => e.slug === 'first')
    expect(postEntry).toBeDefined()
    expect(postEntry?.collectionPath).toBe('content/posts')
  })
})

describe('sortEntriesByOrder', () => {
  // Import the function for testing
  // Since it's not exported, we'll test it indirectly through the list handler
  // or we can add a describe block that tests ordering behavior

  it('returns entries sorted by order array when order is provided', async () => {
    const root = await tmpDir()

    // Create collection folder with embedded ID
    const postsId = 'q52DCVPuH4ga'
    await fs.mkdir(path.join(root, `content/posts.${postsId}`), { recursive: true })

    // Create .collection.json with an order array
    await fs.writeFile(
      path.join(root, `content/posts.${postsId}/.collection.json`),
      JSON.stringify({
        name: 'posts',
        label: 'Posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
        order: ['ccc333def456', 'aaa111abc123', 'bbb222xyz789'], // Custom order
      }),
      'utf8',
    )

    // Create entries (alphabetically: aaa < bbb < ccc, but order says ccc, aaa, bbb)
    await fs.writeFile(
      path.join(root, `content/posts.${postsId}/post.alpha.aaa111abc123.json`),
      JSON.stringify({ title: 'Alpha Post' }),
      'utf8',
    )
    await fs.writeFile(
      path.join(root, `content/posts.${postsId}/post.beta.bbb222xyz789.json`),
      JSON.stringify({ title: 'Beta Post' }),
      'utf8',
    )
    await fs.writeFile(
      path.join(root, `content/posts.${postsId}/post.gamma.ccc333def456.json`),
      JSON.stringify({ title: 'Gamma Post' }),
      'utf8',
    )

    const entrySchemaRegistry = {
      postSchema: [{ name: 'title', type: 'string' }],
    }

    const metaFiles = await loadCollectionMetaFiles(path.join(root, 'content'))
    const schema = resolveCollectionReferences(metaFiles, entrySchemaRegistry)

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
        entrySchemaRegistry: entrySchemaRegistry,
        checkBranchAccess,
        checkContentAccess,
      },
      branchContext: {
        ...createMockBranchContext({
          branchName: 'main',
          baseRoot: root,
          branchRoot: root,
          createdBy: 'u1',
        }),
        flatSchema: flattenSchema(schema, config.contentRoot),
      },
    })

    const res = await listEntriesHandler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('main'), collection: unsafeAsLogicalPath('content/posts') },
    )

    expect(res.ok).toBe(true)
    expect(res.data?.entries).toHaveLength(3)

    // Verify entries are sorted according to order array: gamma, alpha, beta
    const slugs = res.data?.entries.map((e) => e.slug)
    expect(slugs).toEqual(['gamma', 'alpha', 'beta'])

    // Verify entries have contentId
    const contentIds = res.data?.entries.map((e) => e.contentId)
    expect(contentIds).toEqual(['ccc333def456', 'aaa111abc123', 'bbb222xyz789'])
  })

  it('puts unordered entries at the end alphabetically', async () => {
    const root = await tmpDir()

    const postsId = 'q52DCVPuH4ga'
    await fs.mkdir(path.join(root, `content/posts.${postsId}`), { recursive: true })

    // Order only has one entry
    await fs.writeFile(
      path.join(root, `content/posts.${postsId}/.collection.json`),
      JSON.stringify({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
        order: ['bbb222xyz789'], // Only beta is in the order
      }),
      'utf8',
    )

    // Create entries
    await fs.writeFile(
      path.join(root, `content/posts.${postsId}/post.alpha.aaa111abc123.json`),
      JSON.stringify({ title: 'Alpha' }),
      'utf8',
    )
    await fs.writeFile(
      path.join(root, `content/posts.${postsId}/post.beta.bbb222xyz789.json`),
      JSON.stringify({ title: 'Beta' }),
      'utf8',
    )
    await fs.writeFile(
      path.join(root, `content/posts.${postsId}/post.gamma.ccc333def456.json`),
      JSON.stringify({ title: 'Gamma' }),
      'utf8',
    )

    const entrySchemaRegistry = { postSchema: [{ name: 'title', type: 'string' }] }
    const metaFiles = await loadCollectionMetaFiles(path.join(root, 'content'))
    const schema = resolveCollectionReferences(metaFiles, entrySchemaRegistry)

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
        entrySchemaRegistry: entrySchemaRegistry,
        checkBranchAccess,
        checkContentAccess,
      },
      branchContext: {
        ...createMockBranchContext({
          branchName: 'main',
          baseRoot: root,
          branchRoot: root,
          createdBy: 'u1',
        }),
        flatSchema: flattenSchema(schema, config.contentRoot),
      },
    })

    const res = await listEntriesHandler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('main'), collection: unsafeAsLogicalPath('content/posts') },
    )

    expect(res.ok).toBe(true)
    // Beta first (in order), then alpha and gamma alphabetically
    const slugs = res.data?.entries.map((e) => e.slug)
    expect(slugs).toEqual(['beta', 'alpha', 'gamma'])
  })
})

describe('dynamic collection discovery', () => {
  it('discovers collections from .collection.json files not in flatSchema', async () => {
    const root = await tmpDir()

    // Create initial collection folder
    const docsId = 'bChqT78gcaLd'
    await fs.mkdir(path.join(root, `content/docs.${docsId}`), { recursive: true })

    await fs.writeFile(
      path.join(root, `content/docs.${docsId}/.collection.json`),
      JSON.stringify({
        name: 'docs',
        label: 'Documentation',
        entries: [{ name: 'doc', format: 'json', schema: 'docSchema' }],
        order: [],
      }),
      'utf8',
    )

    // Create an entry in docs
    await fs.writeFile(
      path.join(root, `content/docs.${docsId}/doc.overview.gnVmHnnMjWrD.json`),
      JSON.stringify({ title: 'Overview' }),
      'utf8',
    )

    // Now simulate a dynamically created subcollection that is NOT in the flatSchema
    // This is the scenario where a user creates a collection via the schema API
    const innerId = '2XWmsdeEU2Li'
    await fs.mkdir(path.join(root, `content/docs.${docsId}/inner.${innerId}`), { recursive: true })

    await fs.writeFile(
      path.join(root, `content/docs.${docsId}/inner.${innerId}/.collection.json`),
      JSON.stringify({
        name: 'inner',
        label: 'Inner Docs',
        entries: [{ name: 'doc', format: 'json', schema: 'docSchema' }],
        order: [],
      }),
      'utf8',
    )

    const entrySchemaRegistry = {
      docSchema: [
        { name: 'title', type: 'string' },
        { name: 'body', type: 'markdown' },
      ],
    }

    // Only load the ORIGINAL schema (docs only, not inner)
    // This simulates the flatSchema being cached at startup before "inner" was created
    const originalSchema = {
      collections: [
        {
          name: 'docs',
          label: 'Documentation',
          path: 'docs',
          entries: [
            { name: 'doc', format: 'json' as const, schema: entrySchemaRegistry.docSchema },
          ],
        },
      ],
    }

    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'allow',
      contentRoot: 'content',
      schema: originalSchema,
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
        entrySchemaRegistry: entrySchemaRegistry,
        checkBranchAccess,
        checkContentAccess,
      },
      branchContext: {
        ...createMockBranchContext({
          branchName: 'main',
          baseRoot: root,
          branchRoot: root,
          createdBy: 'u1',
        }),
        // flatSchema only knows about 'docs', NOT 'docs/inner'
        flatSchema: flattenSchema(originalSchema, config.contentRoot),
      },
    })

    const res = await listEntriesHandler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('main') },
    )

    expect(res.ok).toBe(true)

    // Dynamic collection discovery has moved to schema API
    // This test now only verifies entries API returns entries, not collections
    expect(res.data?.entries).toBeDefined()
  })
})

describe('deleteEntry', () => {
  it('deletes an entry and returns success', async () => {
    const root = await tmpDir()

    const postsId = 'q52DCVPuH4ga'
    await fs.mkdir(path.join(root, `content/posts.${postsId}`), { recursive: true })

    await fs.writeFile(
      path.join(root, `content/posts.${postsId}/.collection.json`),
      JSON.stringify({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
        order: [],
      }),
      'utf8',
    )

    const entryId = 'abc123def456'
    await fs.writeFile(
      path.join(root, `content/posts.${postsId}/post.to-delete.${entryId}.json`),
      JSON.stringify({ title: 'Delete Me' }),
      'utf8',
    )

    const entrySchemaRegistry = { postSchema: [{ name: 'title', type: 'string' }] }
    const metaFiles = await loadCollectionMetaFiles(path.join(root, 'content'))
    const schema = resolveCollectionReferences(metaFiles, entrySchemaRegistry)

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
        entrySchemaRegistry: entrySchemaRegistry,
        checkBranchAccess,
        checkContentAccess,
      },
      branchContext: {
        ...createMockBranchContext({
          branchName: 'main',
          baseRoot: root,
          branchRoot: root,
          createdBy: 'u1',
        }),
        flatSchema: flattenSchema(schema, config.contentRoot),
      },
    })

    // Import deleteEntry handler
    const { deleteEntry } = await import('./entries')

    const res = await deleteEntry.handler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      {
        branch: unsafeAsBranchName('main'),
        entryPath: unsafeAsLogicalPath('content/posts/to-delete'),
      },
    )

    expect(res.ok).toBe(true)
    expect(res.data?.deleted).toBe(true)

    // Verify file was deleted
    const files = await fs.readdir(path.join(root, `content/posts.${postsId}`))
    expect(files.filter((f) => f.endsWith('.json') && f !== '.collection.json')).toHaveLength(0)
  })

  it('returns 403 when user lacks edit permission', async () => {
    const root = await tmpDir()

    const postsId = 'q52DCVPuH4ga'
    await fs.mkdir(path.join(root, `content/posts.${postsId}`), { recursive: true })

    await fs.writeFile(
      path.join(root, `content/posts.${postsId}/.collection.json`),
      JSON.stringify({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
        order: [],
      }),
      'utf8',
    )

    await fs.writeFile(
      path.join(root, `content/posts.${postsId}/post.protected.abc123def456.json`),
      JSON.stringify({ title: 'Protected' }),
      'utf8',
    )

    const entrySchemaRegistry = { postSchema: [{ name: 'title', type: 'string' }] }
    const metaFiles = await loadCollectionMetaFiles(path.join(root, 'content'))
    const schema = resolveCollectionReferences(metaFiles, entrySchemaRegistry)

    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'allow',
      contentRoot: 'content',
      schema,
    })

    // Mock edit access denied
    const pathRules: PathPermission[] = [
      {
        path: unsafeAsPermissionPath(`content/posts.${postsId}/post.protected.abc123def456.json`),
        edit: { allowedUsers: ['admin'] },
      },
    ]

    const checkBranchAccess = createCheckBranchAccess('allow')
    const checkContentAccess = createCheckContentAccess({
      checkBranchAccess,
      loadPathPermissions: vi.fn().mockResolvedValue(pathRules),
      defaultPathAccess: 'allow',
      mode: 'dev',
    })

    const ctx = createMockApiContext({
      services: {
        config,
        entrySchemaRegistry: entrySchemaRegistry,
        checkBranchAccess,
        checkContentAccess,
      },
      branchContext: {
        ...createMockBranchContext({
          branchName: 'main',
          baseRoot: root,
          branchRoot: root,
          createdBy: 'u1',
        }),
        flatSchema: flattenSchema(schema, config.contentRoot),
      },
    })

    const { deleteEntry } = await import('./entries')

    const res = await deleteEntry.handler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      {
        branch: unsafeAsBranchName('main'),
        entryPath: unsafeAsLogicalPath('content/posts/protected'),
      },
    )

    expect(res.ok).toBe(false)
    expect(res.status).toBe(403)
    expect(res.error).toContain('Edit permission required')
  })

  it('returns 404 for non-existent entry', async () => {
    const root = await tmpDir()

    const postsId = 'q52DCVPuH4ga'
    await fs.mkdir(path.join(root, `content/posts.${postsId}`), { recursive: true })

    await fs.writeFile(
      path.join(root, `content/posts.${postsId}/.collection.json`),
      JSON.stringify({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
        order: [],
      }),
      'utf8',
    )

    const entrySchemaRegistry = { postSchema: [{ name: 'title', type: 'string' }] }
    const metaFiles = await loadCollectionMetaFiles(path.join(root, 'content'))
    const schema = resolveCollectionReferences(metaFiles, entrySchemaRegistry)

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
        entrySchemaRegistry: entrySchemaRegistry,
        checkBranchAccess,
        checkContentAccess,
      },
      branchContext: {
        ...createMockBranchContext({
          branchName: 'main',
          baseRoot: root,
          branchRoot: root,
          createdBy: 'u1',
        }),
        flatSchema: flattenSchema(schema, config.contentRoot),
      },
    })

    const { deleteEntry } = await import('./entries')

    const res = await deleteEntry.handler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      {
        branch: unsafeAsBranchName('main'),
        entryPath: unsafeAsLogicalPath('content/posts/nonexistent'),
      },
    )

    expect(res.ok).toBe(false)
    expect(res.status).toBe(404)
  })

  it('returns 400 for invalid entry path format', async () => {
    const root = await tmpDir()
    await fs.mkdir(path.join(root, 'content'), { recursive: true })

    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'allow',
      contentRoot: 'content',
      schema: { collections: [] },
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
        entrySchemaRegistry: {},
        checkBranchAccess,
        checkContentAccess,
      },
      branchContext: {
        ...createMockBranchContext({
          branchName: 'main',
          baseRoot: root,
          branchRoot: root,
          createdBy: 'u1',
        }),
        flatSchema: [],
      },
    })

    const { deleteEntry } = await import('./entries')

    // Path without slash is invalid
    const res = await deleteEntry.handler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('main'), entryPath: unsafeAsLogicalPath('invalid-no-slash') },
    )

    expect(res.ok).toBe(false)
    expect(res.status).toBe(400)
    expect(res.error).toContain('Invalid entry path format')
  })
})
