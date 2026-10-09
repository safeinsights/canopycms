import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { defineCanopyTestConfig } from '../config-test'
import { flattenSchema, type PathPermission } from '../config'
import { createCheckBranchAccess } from '../authorization'
import { createTestContentAccess, unsafeAsPermissionPath } from '../authorization/test-utils'
import { createMockApiContext, createMockBranchContext } from '../test-utils'
import { loadCollectionMetaFiles, resolveCollectionReferences } from '../schema'
import { unsafeAsBranchName, unsafeAsLogicalPath } from '../paths/test-utils'
import { deleteEntry } from './entries'

const listing = vi.hoisted(() => ({ failure: null as Error | null }))
vi.mock('../content-listing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../content-listing')>()
  return {
    ...actual,
    listEntries: (...args: Parameters<typeof actual.listEntries>) =>
      listing.failure ? Promise.reject(listing.failure) : actual.listEntries(...args),
  }
})
afterEach(() => {
  listing.failure = null
})

const PEOPLE_DIR = 'people.pEoPLEdir123'
const POSTS_DIR = 'posts.pstsDir12345'
const ALICE = 'aLiCEaLiCE12'
const BOB = 'bobBXBbobBXB'

const entrySchemaRegistry = {
  personSchema: [{ name: 'name', type: 'string', isTitle: true }],
  postSchema: [
    { name: 'title', type: 'string', isTitle: true },
    { name: 'author', type: 'reference', collections: ['people'] },
    { name: 'reviewers', type: 'reference', list: true, collections: ['people'] },
  ],
  pageSchema: [
    { name: 'title', type: 'string' },
    { name: 'body', type: 'markdown', isBody: true },
  ],
}

async function writeJson(root: string, rel: string, data: unknown) {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await fs.writeFile(path.join(root, rel), JSON.stringify(data), 'utf8')
}

/**
 * People alice and bob; posts that reference alice (one of them unreadable to u1, by path
 * rule); an md page that links to alice from its body.
 */
async function setup(options: { readRules?: PathPermission[]; editRules?: PathPermission[] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-delete-refs-'))
  await writeJson(root, `content/${PEOPLE_DIR}/.collection.json`, {
    name: 'people',
    entries: [{ name: 'person', format: 'json', schema: 'personSchema' }],
  })
  await writeJson(root, `content/${PEOPLE_DIR}/person.alice.${ALICE}.json`, { name: 'Alice' })
  await writeJson(root, `content/${PEOPLE_DIR}/person.bob.${BOB}.json`, { name: 'Bob' })
  await writeJson(root, `content/${POSTS_DIR}/.collection.json`, {
    name: 'posts',
    entries: [
      { name: 'post', format: 'json', schema: 'postSchema', default: true },
      { name: 'page', format: 'md', schema: 'pageSchema' },
    ],
  })
  await writeJson(root, `content/${POSTS_DIR}/post.by-alice.pst1pst1pst1.json`, {
    title: 'By Alice',
    author: ALICE,
  })
  await writeJson(root, `content/${POSTS_DIR}/post.reviewed.pst2pst2pst2.json`, {
    title: 'Reviewed',
    author: BOB,
    reviewers: [BOB, ALICE],
  })
  await writeJson(root, `content/${POSTS_DIR}/post.secret.pst3pst3pst3.json`, {
    title: 'Secret',
    author: ALICE,
  })
  await fs.writeFile(
    path.join(root, `content/${POSTS_DIR}/page.about.pAGE1pAGE1pA.md`),
    `---\ntitle: About\n---\nWritten with [Alice](entry:${ALICE}).\n`,
    'utf8',
  )

  const metaFiles = await loadCollectionMetaFiles(path.join(root, 'content'))
  const schema = resolveCollectionReferences(metaFiles, entrySchemaRegistry)
  const config = defineCanopyTestConfig({
    defaultBranchAccess: 'allow',
    contentRoot: 'content',
    schema,
  })
  const checkBranchAccess = createCheckBranchAccess('allow')
  const loadPathPermissions = vi
    .fn()
    .mockResolvedValue([...(options.readRules ?? []), ...(options.editRules ?? [])])
  const { checkContentAccess, createContentAccessChecker } = createTestContentAccess({
    checkBranchAccess,
    loadPathPermissions,
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

  const del = (entryPath: string, confirmReferenced?: boolean) =>
    deleteEntry.handler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      {
        branch: unsafeAsBranchName('main'),
        entryPath: unsafeAsLogicalPath(entryPath),
        ...(confirmReferenced === undefined ? {} : { confirmReferenced }),
      },
    )
  const exists = async (file: string) =>
    fs.access(path.join(root, `content/${PEOPLE_DIR}/${file}`)).then(
      () => true,
      () => false,
    )
  return { del, exists }
}

const secretReadRule: PathPermission = {
  path: unsafeAsPermissionPath('content/posts/secret'),
  read: { allowedUsers: ['someone-else'] },
}

describe('deleteEntry: entries other entries reference', () => {
  it('refuses with a 409 naming every referencing entry, and leaves the file in place', async () => {
    const { del, exists } = await setup()
    const res = await del('content/people/alice')

    expect(res.ok).toBe(false)
    expect(res.status).toBe(409)
    expect(res.error).toBe('Entry is referenced by 4 other entries')
    expect(res.data?.deleted).toBe(false)
    expect(res.data?.referencedBy).toEqual({
      entries: [
        {
          entryPath: 'content/posts/about',
          contentId: 'pAGE1pAGE1pA',
          title: 'About',
          fields: [],
          links: ['body'],
        },
        {
          entryPath: 'content/posts/by-alice',
          contentId: 'pst1pst1pst1',
          title: 'By Alice',
          fields: ['author'],
          links: [],
        },
        {
          entryPath: 'content/posts/reviewed',
          contentId: 'pst2pst2pst2',
          title: 'Reviewed',
          fields: ['reviewers[1]'],
          links: [],
        },
        {
          entryPath: 'content/posts/secret',
          contentId: 'pst3pst3pst3',
          title: 'Secret',
          fields: ['author'],
          links: [],
        },
      ],
      hiddenCount: 0,
    })
    expect(await exists(`person.alice.${ALICE}.json`)).toBe(true)
  })

  it('deletes a referenced entry when the request confirms it', async () => {
    const { del, exists } = await setup()
    const res = await del('content/people/alice', true)

    expect(res.ok).toBe(true)
    expect(res.data?.deleted).toBe(true)
    expect(res.data?.referencedBy).toBeUndefined()
    expect(await exists(`person.alice.${ALICE}.json`)).toBe(false)
  })

  it('deletes an entry nothing references without any confirmation', async () => {
    const { del, exists } = await setup()
    const res = await del('content/posts/by-alice')

    expect(res.ok).toBe(true)
    expect(res.data?.deleted).toBe(true)
    expect(await exists(`person.alice.${ALICE}.json`)).toBe(true)
  })

  it('counts a referencing entry the user may not read, without its title, path or fields', async () => {
    const { del } = await setup({ readRules: [secretReadRule] })
    const res = await del('content/people/alice')

    expect(res.status).toBe(409)
    expect(res.data?.referencedBy?.hiddenCount).toBe(1)
    expect(res.data?.referencedBy?.entries.map((e) => e.entryPath)).toEqual([
      'content/posts/about',
      'content/posts/by-alice',
      'content/posts/reviewed',
    ])
    expect(JSON.stringify(res)).not.toContain('Secret')
    expect(JSON.stringify(res)).not.toContain('pst3pst3pst3')
    expect(res.error).toBe('Entry is referenced by 4 other entries')
  })

  it('refuses a user who may not edit the entry before saying anything about its references', async () => {
    const { del, exists } = await setup({
      editRules: [
        {
          path: unsafeAsPermissionPath('content/people/alice'),
          edit: { allowedUsers: ['someone-else'] },
        },
      ],
    })
    const res = await del('content/people/alice')

    expect(res.status).toBe(403)
    expect(res.data).toBeUndefined()
    expect(await exists(`person.alice.${ALICE}.json`)).toBe(true)
  })

  it('reports a failed scan as a failed check, not as this entry missing, and deletes nothing', async () => {
    const { del, exists } = await setup()
    listing.failure = Object.assign(new Error('ENOENT: another file vanished mid-scan'), {
      code: 'ENOENT',
    })
    const res = await del('content/people/alice')

    expect(res.status).toBe(500)
    expect(res.error).toBe('Could not check which entries reference this one; try again')
    expect(await exists(`person.alice.${ALICE}.json`)).toBe(true)
  })

  it('accepts the confirm flag as the query string sends it', () => {
    // Query-string values reach validate() as strings (http/handler.ts parseQueryParams).
    const result = deleteEntry.validate({
      params: { branch: 'main', entryPath: 'content/people/alice', confirmReferenced: 'true' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.params as { confirmReferenced?: boolean }).confirmReferenced).toBe(true)
    }
  })
})
