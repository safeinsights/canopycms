import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { defineCanopyTestConfig } from '../config-test'
import { flattenSchema } from '../config'
import { createCheckBranchAccess } from '../authorization'
import { unsafeAsPermissionPath, createTestContentAccess } from '../authorization/test-utils'
import type { PathPermission } from '../config'
import { listEntries } from './entries'
import { createMockApiContext, createMockBranchContext } from '../test-utils'
import { loadCollectionMetaFiles, resolveCollectionReferences } from '../schema'
import { unsafeAsBranchName, unsafeAsLogicalPath } from '../paths/test-utils'
import { BranchSchemaCache, SCHEMA_GENERATION_RESOURCE } from '../branch-schema-cache'
import { resourceGenerationPath } from '../resource-generation'
import { SchemaOps, SchemaStoreBusyError } from '../schema/schema-store'

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
    const { checkContentAccess, createContentAccessChecker } = createTestContentAccess({
      checkBranchAccess,
      loadPathPermissions: mockLoadPermissions,
      defaultPathAccess: 'allow',
      mode: 'dev',
      getSettingsBranchRoot: () => Promise.resolve('/mock/settings'),
    })

    const ctx = createMockApiContext({
      services: {
        config,
        checkBranchAccess,
        checkContentAccess,
        createContentAccessChecker,
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
    const res = await listEntries.handler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('main'), limit: 2 },
    )

    expect(res.ok).toBe(true)
    // Should include posts but not hidden.json (restricted by permission)
    expect(res.data?.entries.some((e) => e.slug === 'first')).toBe(true)
    expect(res.data?.entries.some((e) => e.slug === 'hidden')).toBe(false)
  })

  it('clamps an over-large limit to the server maximum (200)', async () => {
    const root = await tmpDir()
    await fs.mkdir(path.join(root, 'content/posts'), { recursive: true })
    await fs.writeFile(
      path.join(root, 'content/posts/entry.first.abc123def456.json'),
      JSON.stringify({ title: 'First Post' }),
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

    const config = defineCanopyTestConfig({ defaultBranchAccess: 'allow', schema })
    const checkBranchAccess = createCheckBranchAccess('allow')
    const { checkContentAccess, createContentAccessChecker } = createTestContentAccess({
      checkBranchAccess,
      loadPathPermissions: vi.fn().mockResolvedValue([]),
      defaultPathAccess: 'allow',
      mode: 'dev',
      getSettingsBranchRoot: () => Promise.resolve('/mock/settings'),
    })

    const ctx = createMockApiContext({
      services: { config, checkBranchAccess, checkContentAccess, createContentAccessChecker },
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

    // Request well above the 200 cap; handler clamps rather than 400s or echoes it back.
    const res = await listEntries.handler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('main'), limit: 500 },
    )

    expect(res.ok).toBe(true)
    expect(res.data?.pagination.limit).toBe(200)
  })

  it('clamps a negative cursor to 0 instead of slicing from the end (API-L1)', async () => {
    const root = await tmpDir()
    await fs.mkdir(path.join(root, 'content/posts'), { recursive: true })
    await fs.writeFile(
      path.join(root, 'content/posts/entry.first.abc123def456.json'),
      JSON.stringify({ title: 'First Post' }),
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

    const config = defineCanopyTestConfig({ defaultBranchAccess: 'allow', schema })
    const checkBranchAccess = createCheckBranchAccess('allow')
    const { checkContentAccess, createContentAccessChecker } = createTestContentAccess({
      checkBranchAccess,
      loadPathPermissions: vi.fn().mockResolvedValue([]),
      defaultPathAccess: 'allow',
      mode: 'dev',
      getSettingsBranchRoot: () => Promise.resolve('/mock/settings'),
    })

    const ctx = createMockApiContext({
      services: { config, checkBranchAccess, checkContentAccess, createContentAccessChecker },
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

    // Without clamping, Array.slice(-5, -5 + limit) treats a negative offset as
    // "from the end", which would silently return an empty/unexpected page
    // instead of the first page a client meant to request.
    const res = await listEntries.handler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('main'), cursor: '-5' },
    )

    expect(res.ok).toBe(true)
    expect(res.data?.entries.some((e) => e.slug === 'first')).toBe(true)
  })

  it('returns 404 when branch is missing', async () => {
    const ctx = createMockApiContext({ branchContext: null })
    const res = await listEntries.handler(
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

    await fs.mkdir(path.join(root, `content/docs.${docsId}`), {
      recursive: true,
    })
    await fs.mkdir(path.join(root, `content/docs.${docsId}/api.${apiId}`), {
      recursive: true,
    })
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
              path: 'docs/api',
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
                  path: 'docs/api/v2',
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
    const { checkContentAccess, createContentAccessChecker } = createTestContentAccess({
      checkBranchAccess,
      loadPathPermissions: vi.fn().mockResolvedValue([]),
      defaultPathAccess: 'allow',
      mode: 'dev',
      getSettingsBranchRoot: () => Promise.resolve('/mock/settings'),
    })

    const ctx = createMockApiContext({
      services: {
        config,
        checkBranchAccess,
        checkContentAccess,
        createContentAccessChecker,
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
    const allEntriesRes = await listEntries.handler(
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
    const docsNonRecursiveRes = await listEntries.handler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      {
        branch: unsafeAsBranchName('main'),
        collection: unsafeAsLogicalPath('content/docs'),
      },
    )

    expect(docsNonRecursiveRes.ok).toBe(true)
    expect(docsNonRecursiveRes.data?.entries.length).toBe(1) // Only 'overview' from docs
    expect(docsNonRecursiveRes.data?.entries.some((e) => e.slug === 'overview')).toBe(true)
    expect(docsNonRecursiveRes.data?.entries.some((e) => e.slug === 'intro')).toBe(false) // From child collection
    expect(docsNonRecursiveRes.data?.entries.some((e) => e.slug === 'auth')).toBe(false) // From grandchild collection

    // Test 3: With collection filter and recursive flag - gets entries from 'content/docs' and all children
    const docsRecursiveRes = await listEntries.handler(
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
    const apiRecursiveRes = await listEntries.handler(
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
    const { checkContentAccess, createContentAccessChecker } = createTestContentAccess({
      checkBranchAccess,
      loadPathPermissions: async () => [],
      defaultPathAccess: 'allow',
      mode: 'dev',
      getSettingsBranchRoot: () => Promise.resolve('/mock/settings'),
    })

    const ctx = createMockApiContext({
      services: {
        config,
        checkBranchAccess,
        checkContentAccess,
        createContentAccessChecker,
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

    const res = await listEntries.handler(
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
    const { checkContentAccess, createContentAccessChecker } = createTestContentAccess({
      checkBranchAccess,
      loadPathPermissions: mockLoadPermissions,
      defaultPathAccess: 'allow',
      mode: 'dev',
      getSettingsBranchRoot: () => Promise.resolve('/mock/settings'),
    })

    const ctx = createMockApiContext({
      services: {
        config,
        checkBranchAccess,
        checkContentAccess,
        createContentAccessChecker,
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

    const res = await listEntries.handler(
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
    await fs.mkdir(path.join(root, `content/authors.${authorsId}`), {
      recursive: true,
    })

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
    const { checkContentAccess, createContentAccessChecker } = createTestContentAccess({
      checkBranchAccess,
      loadPathPermissions: vi.fn().mockResolvedValue([]),
      defaultPathAccess: 'allow',
      mode: 'dev',
      getSettingsBranchRoot: () => Promise.resolve('/mock/settings'),
    })

    const ctx = createMockApiContext({
      services: {
        config,
        entrySchemaRegistry: entrySchemaRegistry,
        checkBranchAccess,
        checkContentAccess,
        createContentAccessChecker,
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

    const res = await listEntries.handler(
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
    await fs.mkdir(path.join(root, `content/posts.${postsId}`), {
      recursive: true,
    })
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
    const { checkContentAccess, createContentAccessChecker } = createTestContentAccess({
      checkBranchAccess,
      loadPathPermissions: vi.fn().mockResolvedValue([]),
      defaultPathAccess: 'allow',
      mode: 'dev',
      getSettingsBranchRoot: () => Promise.resolve('/mock/settings'),
    })

    const ctx = createMockApiContext({
      services: {
        config,
        entrySchemaRegistry: entrySchemaRegistry,
        checkBranchAccess,
        checkContentAccess,
        createContentAccessChecker,
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

    const res = await listEntries.handler(
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

  it('loads permissions and the settings root once per request across many collections', async () => {
    const root = await tmpDir()
    // Distinct 12-char Base58 content IDs per file (the on-disk filename format requires
    // them; Base58 excludes 0/O/I/l).
    const collections = [
      { name: 'posts', ids: ['pst111aaa222', 'pst333bbb444'] },
      { name: 'pages', ids: ['pag111aaa222', 'pag333bbb444'] },
      { name: 'news', ids: ['nws111aaa222', 'nws333bbb444'] },
    ]
    for (const { name, ids } of collections) {
      await fs.mkdir(path.join(root, `content/${name}`), { recursive: true })
      await fs.writeFile(
        path.join(root, `content/${name}/entry.a.${ids[0]}.json`),
        JSON.stringify({ title: `${name} A` }),
        'utf8',
      )
      await fs.writeFile(
        path.join(root, `content/${name}/entry.b.${ids[1]}.json`),
        JSON.stringify({ title: `${name} B` }),
        'utf8',
      )
    }

    const schema = {
      collections: collections.map(({ name }) => ({
        name,
        path: name,
        entries: [
          {
            name: 'entry',
            format: 'json' as const,
            schema: [{ name: 'title', type: 'string' as const }],
          },
        ],
      })),
    } as const

    const config = defineCanopyTestConfig({ defaultBranchAccess: 'allow', schema })

    // Spy on the request-constant work: it must run once per request, not once per entry.
    const loadPathPermissions = vi.fn().mockResolvedValue([])
    const getSettingsBranchRoot = vi.fn().mockResolvedValue('/mock/settings')
    const checkBranchAccess = createCheckBranchAccess('allow')
    const { checkContentAccess, createContentAccessChecker } = createTestContentAccess({
      checkBranchAccess,
      loadPathPermissions,
      defaultPathAccess: 'allow',
      mode: 'dev',
      getSettingsBranchRoot,
    })

    const ctx = createMockApiContext({
      services: { config, checkBranchAccess, checkContentAccess, createContentAccessChecker },
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

    const res = await listEntries.handler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('main'), limit: 100 },
    )

    expect(res.ok).toBe(true)
    expect(res.data?.entries).toHaveLength(6)
    // The whole point of the batch checker: loaded once, not once per entry (6) or per check (12).
    expect(loadPathPermissions).toHaveBeenCalledTimes(1)
    expect(getSettingsBranchRoot).toHaveBeenCalledTimes(1)
  })

  it('paginates after access filtering so a denied first entry does not consume the page', async () => {
    const root = await tmpDir()
    await fs.mkdir(path.join(root, 'content/posts'), { recursive: true })
    // 'denied' sorts before 'visible' alphabetically, so a slice-before-filter bug would
    // return an empty page for limit=1.
    await fs.writeFile(
      path.join(root, 'content/posts/entry.denied.aaa111bbb222.json'),
      JSON.stringify({ title: 'Denied' }),
      'utf8',
    )
    await fs.writeFile(
      path.join(root, 'content/posts/entry.visible.ccc333ddd444.json'),
      JSON.stringify({ title: 'Visible' }),
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

    const config = defineCanopyTestConfig({ defaultBranchAccess: 'allow', schema })

    const pathRules: PathPermission[] = [
      {
        path: unsafeAsPermissionPath('content/posts/entry.denied.aaa111bbb222.json'),
        read: { allowedUsers: ['other'] },
      },
    ]
    const checkBranchAccess = createCheckBranchAccess('allow')
    const { checkContentAccess, createContentAccessChecker } = createTestContentAccess({
      checkBranchAccess,
      loadPathPermissions: vi.fn().mockResolvedValue(pathRules),
      defaultPathAccess: 'allow',
      mode: 'dev',
      getSettingsBranchRoot: () => Promise.resolve('/mock/settings'),
    })

    const ctx = createMockApiContext({
      services: { config, checkBranchAccess, checkContentAccess, createContentAccessChecker },
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

    const res = await listEntries.handler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('main'), limit: 1 },
    )

    expect(res.ok).toBe(true)
    expect(res.data?.entries).toHaveLength(1)
    expect(res.data?.entries[0]?.slug).toBe('visible')
    // Only one readable entry exists, so there is no next page.
    expect(res.data?.pagination.hasMore).toBe(false)
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
    await fs.mkdir(path.join(root, `content/posts.${postsId}`), {
      recursive: true,
    })

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
    const { checkContentAccess, createContentAccessChecker } = createTestContentAccess({
      checkBranchAccess,
      loadPathPermissions: vi.fn().mockResolvedValue([]),
      defaultPathAccess: 'allow',
      mode: 'dev',
      getSettingsBranchRoot: () => Promise.resolve('/mock/settings'),
    })

    const ctx = createMockApiContext({
      services: {
        config,
        entrySchemaRegistry: entrySchemaRegistry,
        checkBranchAccess,
        checkContentAccess,
        createContentAccessChecker,
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

    const res = await listEntries.handler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      {
        branch: unsafeAsBranchName('main'),
        collection: unsafeAsLogicalPath('content/posts'),
      },
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
    await fs.mkdir(path.join(root, `content/posts.${postsId}`), {
      recursive: true,
    })

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
    const { checkContentAccess, createContentAccessChecker } = createTestContentAccess({
      checkBranchAccess,
      loadPathPermissions: vi.fn().mockResolvedValue([]),
      defaultPathAccess: 'allow',
      mode: 'dev',
      getSettingsBranchRoot: () => Promise.resolve('/mock/settings'),
    })

    const ctx = createMockApiContext({
      services: {
        config,
        entrySchemaRegistry: entrySchemaRegistry,
        checkBranchAccess,
        checkContentAccess,
        createContentAccessChecker,
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

    const res = await listEntries.handler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      {
        branch: unsafeAsBranchName('main'),
        collection: unsafeAsLogicalPath('content/posts'),
      },
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
    await fs.mkdir(path.join(root, `content/docs.${docsId}`), {
      recursive: true,
    })

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
    await fs.mkdir(path.join(root, `content/docs.${docsId}/inner.${innerId}`), {
      recursive: true,
    })

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
            {
              name: 'doc',
              format: 'json' as const,
              schema: entrySchemaRegistry.docSchema,
            },
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
    const { checkContentAccess, createContentAccessChecker } = createTestContentAccess({
      checkBranchAccess,
      loadPathPermissions: vi.fn().mockResolvedValue([]),
      defaultPathAccess: 'allow',
      mode: 'dev',
      getSettingsBranchRoot: () => Promise.resolve('/mock/settings'),
    })

    const ctx = createMockApiContext({
      services: {
        config,
        entrySchemaRegistry: entrySchemaRegistry,
        checkBranchAccess,
        checkContentAccess,
        createContentAccessChecker,
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

    const res = await listEntries.handler(
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
    await fs.mkdir(path.join(root, `content/posts.${postsId}`), {
      recursive: true,
    })

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
    const { checkContentAccess, createContentAccessChecker } = createTestContentAccess({
      checkBranchAccess,
      loadPathPermissions: vi.fn().mockResolvedValue([]),
      defaultPathAccess: 'allow',
      mode: 'dev',
      getSettingsBranchRoot: () => Promise.resolve('/mock/settings'),
    })

    const ctx = createMockApiContext({
      services: {
        config,
        entrySchemaRegistry: entrySchemaRegistry,
        checkBranchAccess,
        checkContentAccess,
        createContentAccessChecker,
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

  it('removes the deleted entry id from the collection order array and bumps the schema generation marker', async () => {
    // Pins the 89f7885 fix: deleteEntry's order-update branch only runs when
    // contentId is found + collection.type === 'collection' + collection.order
    // is defined + the id is present in order. Before the fix, the SchemaOps
    // used for the order update was constructed with branchRoot (instead of
    // contentRoot) and without services, so its .collection.json write never
    // bumped the schema generation marker -- every host durably served the
    // stale cached order (still containing the deleted entry) until the next
    // unrelated schema mutation.
    const root = await tmpDir()

    const postsId = 'q52DCVPuH4ga'
    await fs.mkdir(path.join(root, `content/posts.${postsId}`), {
      recursive: true,
    })

    const entryId = 'abc123def456'
    const otherEntryId = 'other000id001'
    await fs.writeFile(
      path.join(root, `content/posts.${postsId}/.collection.json`),
      JSON.stringify({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
        order: [entryId, otherEntryId],
      }),
      'utf8',
    )

    await fs.writeFile(
      path.join(root, `content/posts.${postsId}/post.to-delete.${entryId}.json`),
      JSON.stringify({ title: 'Delete Me' }),
      'utf8',
    )
    await fs.writeFile(
      path.join(root, `content/posts.${postsId}/post.keep-me.${otherEntryId}.json`),
      JSON.stringify({ title: 'Keep Me' }),
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
    const { checkContentAccess, createContentAccessChecker } = createTestContentAccess({
      checkBranchAccess,
      loadPathPermissions: vi.fn().mockResolvedValue([]),
      defaultPathAccess: 'allow',
      mode: 'dev',
      getSettingsBranchRoot: () => Promise.resolve('/mock/settings'),
    })

    // A REAL BranchSchemaCache (not the default createMockServices() stub,
    // whose branchSchemaCache is a vi.fn() that never touches disk) so
    // SchemaOps.invalidateSchemaCache()'s bump + eager re-resolve actually
    // read/write the on-disk generation marker below.
    const branchSchemaCache = new BranchSchemaCache('dev')

    const ctx = createMockApiContext({
      services: {
        config,
        entrySchemaRegistry: entrySchemaRegistry,
        checkBranchAccess,
        checkContentAccess,
        createContentAccessChecker,
        branchSchemaCache,
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

    const markerPath = resourceGenerationPath(root, SCHEMA_GENERATION_RESOURCE)
    const markerExistedBefore = await fs
      .stat(markerPath)
      .then(() => true)
      .catch(() => false)
    expect(markerExistedBefore).toBe(false)

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

    // (a) the entry file is gone
    const files = await fs.readdir(path.join(root, `content/posts.${postsId}`))
    expect(files).not.toContain(`post.to-delete.${entryId}.json`)
    expect(files).toContain(`post.keep-me.${otherEntryId}.json`)

    // (b) .collection.json's order array no longer contains the deleted id
    const meta = JSON.parse(
      await fs.readFile(path.join(root, `content/posts.${postsId}/.collection.json`), 'utf8'),
    ) as { order?: string[] }
    expect(meta.order).toEqual([otherEntryId])

    // (c) the schema generation marker was bumped by the order-update write
    const markerAfter = await fs.readFile(markerPath, 'utf8')
    expect(markerAfter.length).toBeGreaterThan(0)
  })

  it('honors a non-default config.contentRoot when cleaning up the collection order', async () => {
    // Regression: this handler built its order-cleanup SchemaOps from the
    // literal 'content' rather than config.contentRoot, so for an adopter with
    // a different content root it pointed at a directory that does not exist.
    // Every other content-facing path honored the config, making this a
    // confusing partial failure rather than an obvious one.
    const contentRoot = 'cms-content'
    const root = await tmpDir()

    const postsId = 'q52DCVPuH4ga'
    await fs.mkdir(path.join(root, `${contentRoot}/posts.${postsId}`), { recursive: true })

    const entryId = 'abc123def456'
    const otherEntryId = 'other000id001'
    await fs.writeFile(
      path.join(root, `${contentRoot}/posts.${postsId}/.collection.json`),
      JSON.stringify({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
        order: [entryId, otherEntryId],
      }),
      'utf8',
    )
    await fs.writeFile(
      path.join(root, `${contentRoot}/posts.${postsId}/post.to-delete.${entryId}.json`),
      JSON.stringify({ title: 'Delete Me' }),
      'utf8',
    )
    await fs.writeFile(
      path.join(root, `${contentRoot}/posts.${postsId}/post.keep-me.${otherEntryId}.json`),
      JSON.stringify({ title: 'Keep Me' }),
      'utf8',
    )

    const entrySchemaRegistry = { postSchema: [{ name: 'title', type: 'string' }] }
    const metaFiles = await loadCollectionMetaFiles(path.join(root, contentRoot))
    const schema = resolveCollectionReferences(metaFiles, entrySchemaRegistry)

    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'allow',
      contentRoot,
      schema,
    })

    const checkBranchAccess = createCheckBranchAccess('allow')
    const { checkContentAccess, createContentAccessChecker } = createTestContentAccess({
      checkBranchAccess,
      loadPathPermissions: vi.fn().mockResolvedValue([]),
      defaultPathAccess: 'allow',
      mode: 'dev',
      getSettingsBranchRoot: () => Promise.resolve('/mock/settings'),
    })

    const ctx = createMockApiContext({
      services: {
        config,
        entrySchemaRegistry,
        checkBranchAccess,
        checkContentAccess,
        createContentAccessChecker,
        branchSchemaCache: new BranchSchemaCache('dev'),
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
        entryPath: unsafeAsLogicalPath(`${contentRoot}/posts/to-delete`),
      },
    )

    expect(res.ok).toBe(true)
    expect(res.data?.deleted).toBe(true)

    // The order array under the CONFIGURED content root was cleaned up. With the
    // hardcoded 'content', the SchemaOps pointed at a nonexistent directory and
    // the order update threw instead.
    const meta = JSON.parse(
      await fs.readFile(
        path.join(root, `${contentRoot}/posts.${postsId}/.collection.json`),
        'utf8',
      ),
    ) as { order?: string[] }
    expect(meta.order).toEqual([otherEntryId])

    // branchRoot was resolved to the real branch root, so the generation marker
    // landed there rather than inside the content tree.
    const markerAfter = await fs.readFile(
      resourceGenerationPath(root, SCHEMA_GENERATION_RESOURCE),
      'utf8',
    )
    expect(markerAfter.length).toBeGreaterThan(0)
  })

  it('still returns 200 when the order-cleanup update is rejected because the schema is busy', async () => {
    // deleteEntryHandler's order-array cleanup is best-effort order hygiene
    // (see the comment above that call site): a busy surrogate schema lock
    // (another in-flight schema mutation on this branch) must not turn an
    // already-completed delete into an error response.
    const root = await tmpDir()

    const postsId = 'q52DCVPuH4ga'
    await fs.mkdir(path.join(root, `content/posts.${postsId}`), {
      recursive: true,
    })

    const entryId = 'abc123def456'
    const otherEntryId = 'other000id001'
    await fs.writeFile(
      path.join(root, `content/posts.${postsId}/.collection.json`),
      JSON.stringify({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
        order: [entryId, otherEntryId],
      }),
      'utf8',
    )

    await fs.writeFile(
      path.join(root, `content/posts.${postsId}/post.to-delete.${entryId}.json`),
      JSON.stringify({ title: 'Delete Me' }),
      'utf8',
    )
    await fs.writeFile(
      path.join(root, `content/posts.${postsId}/post.keep-me.${otherEntryId}.json`),
      JSON.stringify({ title: 'Keep Me' }),
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
    const { checkContentAccess, createContentAccessChecker } = createTestContentAccess({
      checkBranchAccess,
      loadPathPermissions: vi.fn().mockResolvedValue([]),
      defaultPathAccess: 'allow',
      mode: 'dev',
      getSettingsBranchRoot: () => Promise.resolve('/mock/settings'),
    })

    const ctx = createMockApiContext({
      services: {
        config,
        entrySchemaRegistry,
        checkBranchAccess,
        checkContentAccess,
        createContentAccessChecker,
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

    const updateOrderSpy = vi
      .spyOn(SchemaOps.prototype, 'updateOrder')
      .mockRejectedValue(new SchemaStoreBusyError())

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
    expect(updateOrderSpy).toHaveBeenCalled()

    // The entry file is still gone — the delete itself completed
    // successfully; only the best-effort order cleanup was skipped.
    const files = await fs.readdir(path.join(root, `content/posts.${postsId}`))
    expect(files).not.toContain(`post.to-delete.${entryId}.json`)

    // The order array still contains the deleted id (cleanup was skipped)
    const meta = JSON.parse(
      await fs.readFile(path.join(root, `content/posts.${postsId}/.collection.json`), 'utf8'),
    ) as { order?: string[] }
    expect(meta.order).toEqual([entryId, otherEntryId])

    updateOrderSpy.mockRestore()
  })

  it('returns 403 when user lacks edit permission', async () => {
    const root = await tmpDir()

    const postsId = 'q52DCVPuH4ga'
    await fs.mkdir(path.join(root, `content/posts.${postsId}`), {
      recursive: true,
    })

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

    // Mock edit access denied
    const pathRules: PathPermission[] = [
      {
        path: unsafeAsPermissionPath(`content/posts.${postsId}/post.protected.abc123def456.json`),
        edit: { allowedUsers: ['admin'] },
      },
    ]

    const checkBranchAccess = createCheckBranchAccess('allow')
    const { checkContentAccess, createContentAccessChecker } = createTestContentAccess({
      checkBranchAccess,
      loadPathPermissions: vi.fn().mockResolvedValue(pathRules),
      defaultPathAccess: 'allow',
      mode: 'dev',
      getSettingsBranchRoot: () => Promise.resolve('/mock/settings'),
    })

    const ctx = createMockApiContext({
      services: {
        config,
        entrySchemaRegistry: entrySchemaRegistry,
        checkBranchAccess,
        checkContentAccess,
        createContentAccessChecker,
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
    await fs.mkdir(path.join(root, `content/posts.${postsId}`), {
      recursive: true,
    })

    await fs.writeFile(
      path.join(root, `content/posts.${postsId}/.collection.json`),
      JSON.stringify({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
        order: [],
      }),
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
    const { checkContentAccess, createContentAccessChecker } = createTestContentAccess({
      checkBranchAccess,
      loadPathPermissions: vi.fn().mockResolvedValue([]),
      defaultPathAccess: 'allow',
      mode: 'dev',
      getSettingsBranchRoot: () => Promise.resolve('/mock/settings'),
    })

    const ctx = createMockApiContext({
      services: {
        config,
        entrySchemaRegistry: entrySchemaRegistry,
        checkBranchAccess,
        checkContentAccess,
        createContentAccessChecker,
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
    const { checkContentAccess, createContentAccessChecker } = createTestContentAccess({
      checkBranchAccess,
      loadPathPermissions: vi.fn().mockResolvedValue([]),
      defaultPathAccess: 'allow',
      mode: 'dev',
      getSettingsBranchRoot: () => Promise.resolve('/mock/settings'),
    })

    const ctx = createMockApiContext({
      services: {
        config,
        entrySchemaRegistry: {},
        checkBranchAccess,
        checkContentAccess,
        createContentAccessChecker,
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
      {
        branch: unsafeAsBranchName('main'),
        entryPath: unsafeAsLogicalPath('invalid-no-slash'),
      },
    )

    expect(res.ok).toBe(false)
    expect(res.status).toBe(400)
    expect(res.error).toContain('Invalid entry path format')
  })
})

describe('listEntries.validate (HTTP query params)', () => {
  // Query-string values reach validate() as strings (http/handler.ts parseQueryParams),
  // unlike the typed params the handler tests above pass directly.
  it('coerces limit strings to numbers', () => {
    const result = listEntries.validate({ params: { branch: 'main', limit: '200' } })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.params as { limit?: number }).limit).toBe(200)
    }
  })

  it('rejects non-numeric and non-positive limits', () => {
    expect(listEntries.validate({ params: { branch: 'main', limit: 'abc' } }).ok).toBe(false)
    expect(listEntries.validate({ params: { branch: 'main', limit: '0' } }).ok).toBe(false)
    expect(listEntries.validate({ params: { branch: 'main', limit: '2.5' } }).ok).toBe(false)
  })

  it('coerces recursive strings to booleans', () => {
    const trueResult = listEntries.validate({ params: { branch: 'main', recursive: 'true' } })
    expect(trueResult.ok).toBe(true)
    if (trueResult.ok) {
      expect((trueResult.params as { recursive?: boolean }).recursive).toBe(true)
    }

    const falseResult = listEntries.validate({ params: { branch: 'main', recursive: 'false' } })
    expect(falseResult.ok).toBe(true)
    if (falseResult.ok) {
      expect((falseResult.params as { recursive?: boolean }).recursive).toBe(false)
    }
  })

  it('rejects recursive values other than true/false', () => {
    expect(listEntries.validate({ params: { branch: 'main', recursive: '1' } }).ok).toBe(false)
  })

  it('leaves absent optional params undefined', () => {
    const result = listEntries.validate({ params: { branch: 'main' } })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const params = result.params as { limit?: number; recursive?: boolean }
      expect(params.limit).toBeUndefined()
      expect(params.recursive).toBeUndefined()
    }
  })

  it('still accepts native typed params (programmatic validate)', () => {
    const result = listEntries.validate({
      params: { branch: 'main', limit: 50, recursive: true } as unknown as Record<string, string>,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const params = result.params as { limit?: number; recursive?: boolean }
      expect(params.limit).toBe(50)
      expect(params.recursive).toBe(true)
    }
  })
})
