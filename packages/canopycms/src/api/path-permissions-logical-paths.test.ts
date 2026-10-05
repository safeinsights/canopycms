/**
 * Path-permission rules are logical paths (`content/blog/**`), while entries live on disk under
 * id-suffixed names (`content/blog.<id>/post.<slug>.<id>.json`). These tests run every
 * enforcing API endpoint against that real on-disk layout, with the real authorization layer.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defineCanopyTestConfig } from '../config-test'
import { flattenSchema, type PathPermission, type RootCollectionConfig } from '../config'
import { createCheckBranchAccess } from '../authorization'
import { createTestContentAccess, unsafeAsPermissionPath } from '../authorization/test-utils'
import { generateId } from '../id'
import { createMockApiContext, createMockBranchContext } from '../test-utils'
import { unsafeAsBranchName, unsafeAsLogicalPath, unsafeAsSlug } from '../paths/test-utils'
import type { ContentId } from '../paths/types'
import type { ApiContext, ApiRequest } from './types'
import { listEntries, deleteEntry } from './entries'
import { CONTENT_ROUTES } from './content'
import { REFERENCE_OPTIONS_ROUTES } from './reference-options'
import { RESOLVE_REFERENCES_ROUTES } from './resolve-references'

const titleSchema = [{ name: 'title', type: 'string' as const }]

const schema: RootCollectionConfig = {
  entries: [{ name: 'page', format: 'json', schema: titleSchema }],
  collections: [
    {
      name: 'blog',
      path: 'blog',
      entries: [{ name: 'post', format: 'json', schema: titleSchema }],
    },
    {
      name: 'private',
      path: 'private',
      entries: [{ name: 'post', format: 'json', schema: titleSchema }],
    },
    {
      name: 'docs',
      path: 'docs',
      entries: [{ name: 'doc', format: 'json', schema: titleSchema }],
      collections: [
        {
          name: 'api',
          path: 'docs/api',
          entries: [{ name: 'doc', format: 'json', schema: titleSchema }],
        },
      ],
    },
  ],
}

const BRANCH = unsafeAsBranchName('main')
const user = (groups: string[] = []): ApiRequest['user'] => ({
  type: 'authenticated',
  userId: 'u1',
  groups,
})

let root: string
/** Content id of each fixture entry, keyed by its logical path. */
let ids: Record<string, ContentId>

/**
 * Write the fixture in the real on-disk layout: every collection directory and entry file
 * carries a generated content id.
 */
const writeFixture = async (): Promise<void> => {
  ids = {}
  const dirs: Record<string, string> = { content: path.join(root, 'content') }
  dirs['content/blog'] = path.join(dirs.content, `blog.${generateId()}`)
  dirs['content/private'] = path.join(dirs.content, `private.${generateId()}`)
  dirs['content/docs'] = path.join(dirs.content, `docs.${generateId()}`)
  dirs['content/docs/api'] = path.join(dirs['content/docs'], `api.${generateId()}`)
  for (const dir of Object.values(dirs)) await fs.mkdir(dir, { recursive: true })

  const entries: Array<[collection: string, type: string, slug: string]> = [
    ['content', 'page', 'home'],
    ['content/blog', 'post', 'find-education-datasets'],
    ['content/blog', 'post', 'other-post'],
    ['content/private', 'post', 'secret-plan'],
    ['content/docs', 'doc', 'intro'],
    ['content/docs/api', 'doc', 'endpoints'],
  ]
  for (const [collection, type, slug] of entries) {
    const id = generateId()
    ids[`${collection}/${slug}`] = id
    await fs.writeFile(
      path.join(dirs[collection], `${type}.${slug}.${id}.json`),
      JSON.stringify({ title: `Title of ${slug}` }),
      'utf8',
    )
  }
}

const createCtx = (
  rules: PathPermission[],
  defaultPathAccess: 'allow' | 'deny' = 'allow',
): ApiContext => {
  const config = defineCanopyTestConfig({ defaultBranchAccess: 'allow', defaultPathAccess, schema })
  const checkBranchAccess = createCheckBranchAccess('allow')
  const access = createTestContentAccess({
    checkBranchAccess,
    loadPathPermissions: vi.fn().mockResolvedValue(rules),
    defaultPathAccess,
    mode: 'dev',
    getSettingsBranchRoot: () => Promise.resolve(root),
  })
  return createMockApiContext({
    services: { config, checkBranchAccess, ...access },
    branchContext: {
      ...createMockBranchContext({ branchName: 'main', baseRoot: root, branchRoot: root }),
      flatSchema: flattenSchema(schema, config.contentRoot),
    },
  })
}

const listAll = async (ctx: ApiContext, groups: string[] = []) => {
  const res = await listEntries.handler(ctx, { user: user(groups) }, { branch: BRANCH })
  expect(res.ok).toBe(true)
  return res.data?.entries ?? []
}

/** Entry logical paths in a listing, so assertions name exactly the paths rules are written in. */
const listedPaths = async (ctx: ApiContext, groups: string[] = []): Promise<string[]> =>
  (await listAll(ctx, groups)).map((e) => e.logicalPath)

const readEntry = (ctx: ApiContext, entryPath: string, groups: string[] = []) =>
  CONTENT_ROUTES.read.handler(
    ctx,
    { user: user(groups) },
    { branch: BRANCH, path: unsafeAsLogicalPath(entryPath) },
  )

/**
 * An update must carry the version it read, or a permitted write is refused as a conflict.
 * The version is read through an allow-all context, so the status the write returns is the
 * verdict of `ctx`'s rules alone.
 */
const writeEntry = async (ctx: ApiContext, entryPath: string, groups: string[] = []) => {
  const read = await readEntry(createCtx([]), entryPath, groups)
  expect(read.data?.version).toEqual(expect.any(Number))
  return CONTENT_ROUTES.write.handler(
    ctx,
    { user: user(groups) },
    { branch: BRANCH, path: unsafeAsLogicalPath(entryPath) },
    { format: 'json', data: { title: 'Updated' }, expectedVersion: read.data?.version },
  )
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-logical-acl-'))
  await writeFixture()
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('path permissions match logical paths against an id-suffixed layout', () => {
  it('lays the fixture out with ids on disk, so a physical-path match could not succeed', async () => {
    const contentDirs = await fs.readdir(path.join(root, 'content'))
    expect(contentDirs.some((d) => /^blog\.[1-9A-HJ-NP-Za-km-z]{12}$/.test(d))).toBe(true)
    expect(contentDirs).not.toContain('blog')
  })

  describe('a group-scoped edit grant on content/blog/**', () => {
    const rules: PathPermission[] = [
      { path: unsafeAsPermissionPath('content/blog/**'), edit: { allowedGroups: ['bloggers'] } },
    ]

    it('reports canEdit for blog entries and not for other collections', async () => {
      const ctx = createCtx(rules, 'deny')
      // Read is denied by default too, so grant it everywhere to see every entry's canEdit.
      const readable: PathPermission[] = [
        { ...rules[0], read: {} },
        { path: unsafeAsPermissionPath('content/**'), read: {} },
      ]
      const entries = await listAll(createCtx(readable, 'deny'), ['bloggers'])
      const canEdit = Object.fromEntries(entries.map((e) => [e.logicalPath, e.canEdit]))

      expect(canEdit['content/blog/find-education-datasets']).toBe(true)
      expect(canEdit['content/blog/other-post']).toBe(true)
      expect(canEdit['content/docs/intro']).toBe(false)
      expect(canEdit['content/home']).toBe(false)
      // The unreadable-by-default context lists nothing, so the grant is what opens the blog.
      expect(await listedPaths(ctx, ['bloggers'])).toEqual([])
    })

    it('allows a write to a blog entry and forbids one to another collection', async () => {
      const ctx = createCtx(rules, 'deny')

      const blogWrite = await writeEntry(ctx, 'content/blog/find-education-datasets', ['bloggers'])
      expect(blogWrite.status).toBe(200)
      expect(blogWrite.ok).toBe(true)

      const docsWrite = await writeEntry(ctx, 'content/docs/intro', ['bloggers'])
      expect(docsWrite.status).toBe(403)
    })

    it('does not extend the grant to a user outside the group', async () => {
      const ctx = createCtx(rules, 'deny')
      const res = await writeEntry(ctx, 'content/blog/find-education-datasets', ['others'])
      expect(res.status).toBe(403)
    })
  })

  describe('a restrictive read rule on content/private/**', () => {
    const rules: PathPermission[] = [
      { path: unsafeAsPermissionPath('content/private/**'), read: { allowedGroups: ['insiders'] } },
    ]

    it('drops private entries from the entries listing', async () => {
      const listed = await listedPaths(createCtx(rules))
      expect(listed).toContain('content/blog/find-education-datasets')
      expect(listed).not.toContain('content/private/secret-plan')

      const insider = await listedPaths(createCtx(rules), ['insiders'])
      expect(insider).toContain('content/private/secret-plan')
    })

    it('forbids a direct read of a private entry and allows a public one', async () => {
      const ctx = createCtx(rules)
      expect((await readEntry(ctx, 'content/private/secret-plan')).status).toBe(403)
      expect((await readEntry(ctx, 'content/blog/other-post')).status).toBe(200)
    })

    it('forbids validating references on a private entry and allows it on a public one', async () => {
      const ctx = createCtx(rules)
      const validate = (entryPath: string) =>
        CONTENT_ROUTES.validateReferences.handler(
          ctx,
          { user: user() },
          { branch: BRANCH, path: unsafeAsLogicalPath(entryPath) },
          { data: {} },
        )
      expect((await validate('content/private/secret-plan')).status).toBe(403)
      expect((await validate('content/blog/other-post')).status).toBe(200)
    })

    it('excludes private entries from reference options', async () => {
      const ctx = createCtx(rules)
      const res = await REFERENCE_OPTIONS_ROUTES.get.handler(
        ctx,
        {
          user: user(),
          query: { collections: 'content/blog,content/private', displayField: 'title' },
        },
        { branch: BRANCH },
      )
      expect(res.ok).toBe(true)
      const optionIds = (res.data?.options ?? []).map((o) => o.id)
      expect(optionIds).toContain(ids['content/blog/other-post'])
      expect(optionIds).not.toContain(ids['content/private/secret-plan'])
    })

    it('resolves private entries to a restricted title + URL in resolve-references', async () => {
      const ctx = createCtx(rules)
      const res = await RESOLVE_REFERENCES_ROUTES.post.handler(
        ctx,
        { user: user() },
        { branch: BRANCH },
        { ids: [ids['content/blog/other-post'], ids['content/private/secret-plan']] },
      )
      expect(res.ok).toBe(true)
      const resolved = res.data?.resolved ?? {}
      expect(resolved[ids['content/blog/other-post']]).toMatchObject({
        title: 'Title of other-post',
      })
      expect(resolved[ids['content/blog/other-post']]).not.toHaveProperty('unavailable')
      expect(resolved[ids['content/private/secret-plan']]).toStrictEqual({
        id: ids['content/private/secret-plan'],
        slug: 'secret-plan',
        collection: 'content/private',
        urlPath: '/private/secret-plan',
        title: 'Title of secret-plan',
        unavailable: true,
        reason: 'restricted',
      })
    })
  })

  it('matches a file-level rule (no glob) to that one entry only', async () => {
    const ctx = createCtx([
      {
        path: unsafeAsPermissionPath('content/blog/other-post'),
        read: { allowedGroups: ['insiders'] },
      },
    ])
    const listed = await listedPaths(ctx)
    expect(listed).toContain('content/blog/find-education-datasets')
    expect(listed).not.toContain('content/blog/other-post')
  })

  it('does not match a rule written with the physical, id-suffixed collection directory', async () => {
    const blogDir = (await fs.readdir(path.join(root, 'content'))).find((d) =>
      d.startsWith('blog.'),
    )
    expect(blogDir).toBeDefined()
    const ctx = createCtx([
      {
        path: unsafeAsPermissionPath(`content/${blogDir}/**`),
        read: { allowedGroups: ['insiders'] },
      },
    ])
    const listed = await listedPaths(ctx)
    expect(listed).toContain('content/blog/other-post')
    expect(listed).toContain('content/blog/find-education-datasets')
  })

  it('matches a rule on a nested collection (content/docs/api/**) and not its parent', async () => {
    const ctx = createCtx([
      {
        path: unsafeAsPermissionPath('content/docs/api/**'),
        read: { allowedGroups: ['insiders'] },
      },
    ])
    const listed = await listedPaths(ctx)
    expect(listed).toContain('content/docs/intro')
    expect(listed).not.toContain('content/docs/api/endpoints')
    expect((await readEntry(ctx, 'content/docs/api/endpoints')).status).toBe(403)
  })

  describe('root-collection entries', () => {
    it('are matched by content/**', async () => {
      const ctx = createCtx([
        { path: unsafeAsPermissionPath('content/**'), read: { allowedGroups: ['insiders'] } },
      ])
      expect(await listedPaths(ctx)).toEqual([])
      expect(await listedPaths(ctx, ['insiders'])).toContain('content/home')
    })

    it('are matched by content/*, which leaves nested entries alone', async () => {
      const ctx = createCtx([
        { path: unsafeAsPermissionPath('content/*'), read: { allowedGroups: ['insiders'] } },
      ])
      const listed = await listedPaths(ctx)
      expect(listed).not.toContain('content/home')
      expect(listed).toContain('content/blog/other-post')
      expect(listed).toContain('content/docs/api/endpoints')
    })
  })

  describe('rename', () => {
    const rename = (ctx: ApiContext, entryPath: string, newSlug: string) =>
      CONTENT_ROUTES.renameEntry.handler(
        ctx,
        { user: user() },
        { branch: BRANCH, path: unsafeAsLogicalPath(entryPath) },
        { newSlug: unsafeAsSlug(newSlug) },
      )

    it('is forbidden when the destination is a path the user cannot edit', async () => {
      const ctx = createCtx([
        {
          path: unsafeAsPermissionPath('content/blog/reserved-slug'),
          edit: { allowedGroups: ['insiders'] },
        },
      ])
      const res = await rename(ctx, 'content/blog/other-post', 'reserved-slug')
      expect(res.status).toBe(403)
      // The source is untouched.
      expect((await readEntry(ctx, 'content/blog/other-post')).status).toBe(200)
    })

    it('is allowed when both source and destination are editable', async () => {
      const ctx = createCtx([
        {
          path: unsafeAsPermissionPath('content/blog/reserved-slug'),
          edit: { allowedGroups: ['insiders'] },
        },
      ])
      const res = await rename(ctx, 'content/blog/other-post', 'free-slug')
      expect(res.status).toBe(200)
      expect(res.data?.newPath).toBe('content/blog/free-slug')
    })
  })

  it('forbids deleting an entry under a logical-path edit rule', async () => {
    const ctx = createCtx([
      { path: unsafeAsPermissionPath('content/blog/**'), edit: { allowedGroups: ['bloggers'] } },
    ])
    const denied = await deleteEntry.handler(
      ctx,
      { user: user() },
      { branch: BRANCH, entryPath: unsafeAsLogicalPath('content/blog/other-post') },
    )
    expect(denied.status).toBe(403)

    const allowed = await deleteEntry.handler(
      ctx,
      { user: user(['bloggers']) },
      { branch: BRANCH, entryPath: unsafeAsLogicalPath('content/blog/other-post') },
    )
    expect(allowed.status).toBe(200)
  })
})
