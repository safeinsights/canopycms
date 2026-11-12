/**
 * The conflicts API and a save's `resolvedConflicts`, against a real branch clone, real blobs and
 * the real path-ACL layer. Plan rows (the field-merge plan's Verification matrix, API layer):
 * 4 scalar, 5 nested, 7/8 removed on one side, 13 item path, 14 item removed vs edited, 21 block,
 * 31 entry deleted vs edited, 33 unreadable, 43 each resolution choice, 44 save without resolving /
 * stale key / version mismatch, 46 a path the user can't read. Rows 23 (a body), 28 (a key the
 * migration removed) and 30 (the location pseudo-key) are named by key and kind here like any
 * field; their values are the engine's (merge/entry-merge.test.ts). Row 45 is in
 * merge-conflict-gates.test.ts.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { simpleGit, type SimpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import { defineCanopyTestConfig } from '../config-test'
import { flattenSchema, type PathPermission, type RootCollectionConfig } from '../config'
import { createCheckBranchAccess, RESERVED_GROUPS } from '../authorization'
import { createTestContentAccess, unsafeAsPermissionPath } from '../authorization/test-utils'
import { BranchMetadataFileManager, getBranchMetadataFileManager } from '../branch-metadata'
import { ContentStore } from '../content-store'
import { GitManager } from '../git-manager'
import {
  LOCATION_CONFLICT_KEY,
  MergeConflictStore,
  type MergeConflictEntry,
  type MergeConflictField,
} from '../merge-conflicts'
import {
  createMockApiContext,
  createMockBranchContext,
  initTestRepo,
  openBareRepo,
} from '../test-utils'
import { unsafeAsBranchName, unsafeAsContentId, unsafeAsLogicalPath } from '../paths/test-utils'
import { mockConsole } from '../test-utils/console-spy'
import { matchRoute } from '../http/router'
import { buildCanopyRoutes } from './routes'
import type { ApiContext, ApiRequest } from './types'
import { CONTENT_ROUTES, type ContentWriteResponse } from './content'
import { logicalPathSchema } from './validators'
import { MERGE_CONFLICT_ROUTES, type ResolveEntryConflictBody } from './merge-conflicts'

const postFields = [
  { name: 'title', type: 'string' as const, isTitle: true },
  {
    name: 'sections',
    type: 'block' as const,
    templates: [
      { name: 'hero', fields: [{ name: 'heading', type: 'string' as const }] },
      { name: 'text', fields: [{ name: 'copy', type: 'markdown' as const }] },
    ],
  },
]
const noteFields = [
  { name: 'title', type: 'string' as const, isTitle: true },
  { name: 'content', type: 'markdown' as const, isBody: true },
]
const titleOnly = [{ name: 'title', type: 'string' as const, isTitle: true }]
const schema: RootCollectionConfig = {
  collections: [
    { name: 'blog', path: 'blog', entries: [{ name: 'post', format: 'json', schema: postFields }] },
    { name: 'notes', path: 'notes', entries: [{ name: 'note', format: 'md', schema: noteFields }] },
    {
      name: 'private',
      path: 'private',
      entries: [{ name: 'post', format: 'json', schema: titleOnly }],
    },
  ],
}

const BLOG = 'blog.q52DCVPuH4ga'
const NOTES = 'notes.Hq2Wd3Rt4Yu5'
const PRIVATE = 'private.Kp3Lm4Nq5Rs6'
const ID = {
  hello: 'zY9xW8vU7tS6',
  old: 'pQ2rS3tU4vW5',
  gone: 'Gg2Hh3Jj4Kk5',
  memo: 'Ab2Cd3Ef4Gh5',
  secret: 'mN8bV7cX6zL5',
}
const files = {
  hello: `content/${BLOG}/post.hello.${ID.hello}.json`,
  old: `content/${BLOG}/post.old-news.${ID.old}.json`,
  gone: `content/${BLOG}/post.gone.${ID.gone}.json`,
  memo: `content/${NOTES}/note.memo.${ID.memo}.md`,
  secret: `content/${PRIVATE}/post.secret.${ID.secret}.json`,
  notes: `content/${BLOG}/notes.txt`,
}

const post = (title: string, heading: string, copy = 'Some words') => ({
  title,
  sections: [
    { _key: 'hero1', template: 'hero', value: { heading } },
    { _key: 'text1', template: 'text', value: { copy } },
  ],
})
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

const MERGE = 'a'.repeat(40)
const OLDER = 'b'.repeat(40)

let tmpDir: string
let branchRoot: string
let clone: SimpleGit

const write = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(path.join(branchRoot, file)), { recursive: true })
  await fs.writeFile(path.join(branchRoot, file), text, 'utf8')
}

/** Store `text` as a blob in the clone, as a merge's versions are. */
const blob = async (text: string): Promise<string> => {
  const at = path.join(tmpDir, `blob-${Math.random().toString(36).slice(2)}`)
  await fs.writeFile(at, text, 'utf8')
  return (await clone.raw(['hash-object', '-w', '--', at])).trim()
}

const field = (
  key: string,
  dataPath: MergeConflictField['dataPath'],
  sides: MergeConflictField['sides'],
  extra: Partial<MergeConflictField> = {},
): MergeConflictField => ({
  key,
  dataPath,
  sidePaths: { ancestor: dataPath, base: dataPath, branch: dataPath },
  kind: 'changed',
  mergeSha: MERGE,
  sides,
  ...extra,
})

const recordAs = (entries: Record<string, MergeConflictEntry>) =>
  new MergeConflictStore(branchRoot, 0).update(() => ({ entries }))

const recorded = async () => (await new MergeConflictStore(branchRoot).read())?.entries ?? {}

/**
 * A merge commit, as the worker builds one, whose second parent is the base with `latest`'s files
 * and without `removed`,
 * built in a scratch index so the working tree is left alone. Resolves the merge and its blobs.
 */
const mergeTaking = async (latest: Record<string, string>, removed: string[] = []) => {
  const git = simpleGit({ baseDir: branchRoot }).env({
    PATH: process.env.PATH ?? '',
    HOME: tmpDir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_INDEX_FILE: path.join(tmpDir, 'latest.index'),
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  })
  await git.raw(['read-tree', 'origin/main'])
  for (const file of removed) await git.raw(['update-index', '--force-remove', '--', file])
  const blobs: Record<string, string> = {}
  for (const [file, text] of Object.entries(latest)) {
    blobs[file] = await blob(text)
    await git.raw(['update-index', '--add', '--cacheinfo', `100644,${blobs[file]},${file}`])
  }
  const tree = (await git.raw(['write-tree'])).trim()
  const base = (await git.raw(['commit-tree', tree, '-p', 'origin/main', '-m', 'latest'])).trim()
  const head = (await git.raw(['rev-parse', 'HEAD'])).trim()
  const merge = (
    await git.raw(['commit-tree', 'HEAD^{tree}', '-p', head, '-p', base, '-m', 'merge'])
  ).trim()
  return { merge, blobs }
}

let helloSides: { ancestor: string; base: string; branch: string }

beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-conflicts-api-')))
  const remotePath = path.join(tmpDir, 'remote.git')
  await fs.mkdir(remotePath)
  await openBareRepo(remotePath).init(true)
  const seedPath = path.join(tmpDir, 'seed')
  await fs.mkdir(seedPath)
  const seed = await initTestRepo(seedPath)
  await seed.raw(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  const seedFiles: Record<string, string> = {
    [files.hello]: json(post('Hello', 'Welcome')),
    [files.old]: json({ title: 'Old news' }),
    [files.memo]: '---\ntitle: Memo\n---\nFirst line\n',
    [files.secret]: json({ title: 'Secret' }),
  }
  for (const [file, text] of Object.entries(seedFiles)) {
    await fs.mkdir(path.dirname(path.join(seedPath, file)), { recursive: true })
    await fs.writeFile(path.join(seedPath, file), text, 'utf8')
  }
  await seed.raw(['add', '--', '.'])
  await seed.commit('base')
  await seed.addRemote('origin', remotePath)
  await seed.push('origin', 'main')
  branchRoot = path.join(tmpDir, 'feature')
  await GitManager.cloneRepo(remotePath, branchRoot, 'main')
  clone = simpleGit({ baseDir: branchRoot })
  await clone.raw(['checkout', '-q', '-b', 'feature', 'origin/main'])

  // The merge's outcome in the working tree: the author's values where they conflict.
  await write(files.hello, json(post('Hello you', 'Welcome friends')))
  helloSides = {
    ancestor: await blob(json(post('Hello', 'Welcome'))),
    base: await blob(json(post('Hello there', 'Welcome all'))),
    branch: await blob(json(post('Hello you', 'Welcome friends'))),
  }
  await getBranchMetadataFileManager(branchRoot, tmpDir).save({
    branch: createMockBranchContext({ branchName: 'feature', baseRoot: tmpDir, branchRoot }).branch,
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

/** The record a merge leaves for hello: the title and the hero heading, both changed. */
const helloRecord = (): MergeConflictEntry => ({
  path: files.hello,
  mergeSha: MERGE,
  kind: 'fields',
  sides: helloSides,
  fields: [
    field('title', [{ field: 'title' }], helloSides),
    field(
      'sections.hero1.heading',
      [{ field: 'sections' }, { item: 'hero1' }, { blockData: true }, { field: 'heading' }],
      helloSides,
    ),
  ],
})

const createCtx = (options: { rules?: PathPermission[] } = {}): ApiContext => {
  const config = defineCanopyTestConfig({ defaultBranchAccess: 'allow', schema })
  const checkBranchAccess = createCheckBranchAccess('allow')
  const access = createTestContentAccess({
    checkBranchAccess,
    loadPathPermissions: vi.fn().mockResolvedValue(options.rules ?? []),
    defaultPathAccess: 'allow',
    mode: 'dev',
    getSettingsBranchRoot: () => Promise.resolve(branchRoot),
  })
  const branchContext = createMockBranchContext({
    branchName: 'feature',
    baseRoot: tmpDir,
    branchRoot,
    createdBy: 'creator',
  })
  branchContext.branch.baseBranch = 'main'
  return createMockApiContext({
    services: {
      config,
      checkBranchAccess,
      ...access,
      createGitManagerFor: (repoPath, opts) =>
        new GitManager({ repoPath, baseBranch: opts?.baseBranch ?? 'main', remote: 'origin' }),
    },
    branchContext: { ...branchContext, flatSchema: flattenSchema(schema, config.contentRoot) },
  })
}

const user: ApiRequest['user'] = { type: 'authenticated', userId: 'u1', groups: [] }
const adminUser: ApiRequest['user'] = {
  type: 'authenticated',
  userId: 'a1',
  groups: [RESERVED_GROUPS.ADMINS],
}
const branch = unsafeAsBranchName('feature')
const insidersOnly: PathPermission[] = [
  {
    path: unsafeAsPermissionPath('content/private/**'),
    read: { allowedGroups: ['insiders'] },
    edit: { allowedGroups: ['insiders'] },
  },
]

const list = (ctx: ApiContext, as = user) =>
  MERGE_CONFLICT_ROUTES.list.handler(ctx, { user: as }, { branch })
const entryConflict = (ctx: ApiContext, entryPath: string, id?: string) =>
  MERGE_CONFLICT_ROUTES.entry.handler(
    ctx,
    { user },
    {
      branch,
      entryPath: unsafeAsLogicalPath(entryPath),
      ...(id && { id: unsafeAsContentId(id) }),
    },
  )
const resolveEntry = (
  ctx: ApiContext,
  entryPath: string,
  body: { id: string; mergeSha: string; choice: ResolveEntryConflictBody['choice'] },
) =>
  MERGE_CONFLICT_ROUTES.resolveEntry.handler(
    ctx,
    { user },
    { branch, entryPath: unsafeAsLogicalPath(entryPath) },
    { ...body, id: unsafeAsContentId(body.id) },
  )

const conflictFiles = async () =>
  (await BranchMetadataFileManager.loadOnly(branchRoot))?.branch.conflictFiles

describe('GET /:branch/conflicts', () => {
  it('lists each entry with conflicts open, its field count, and what is open in all', async () => {
    await recordAs({
      [ID.hello]: helloRecord(),
      [ID.memo]: { path: files.memo, mergeSha: MERGE, kind: 'deleted-on-base', sides: {} },
    })
    const res = await list(createCtx())
    expect(res).toMatchObject({ ok: true, status: 200 })
    expect(res.data).toEqual({
      conflicts: [
        {
          contentId: ID.memo,
          kind: 'deleted-on-base',
          path: files.memo,
          logicalPath: 'content/notes/memo',
          fieldCount: 0,
          mergeSha: MERGE,
        },
        {
          contentId: ID.hello,
          kind: 'fields',
          path: files.hello,
          logicalPath: 'content/blog/hello',
          fieldCount: 2,
          mergeSha: MERGE,
        },
      ],
      hiddenCount: 0,
      openCount: 3,
    })
  })

  it('counts, but never names, an entry the user may not read (row 46)', async () => {
    await recordAs({
      [ID.hello]: helloRecord(),
      [ID.secret]: { path: files.secret, mergeSha: MERGE, kind: 'unreadable', sides: {} },
    })
    const res = await list(createCtx({ rules: insidersOnly }))
    expect(res.data?.conflicts.map((c) => c.contentId)).toEqual([ID.hello])
    expect(res.data?.hiddenCount).toBe(1)
    expect(res.data?.openCount).toBe(3)
    expect(JSON.stringify(res.data)).not.toContain('secret')
  })

  it('names a file that is neither an entry nor collection settings to admins only', async () => {
    await recordAs({
      [BLOG.split('.')[1]]: { path: files.notes, mergeSha: MERGE, kind: 'unreadable', sides: {} },
    })
    expect((await list(createCtx())).data).toMatchObject({ conflicts: [], hiddenCount: 1 })
    expect((await list(createCtx(), adminUser)).data?.conflicts).toEqual([
      expect.objectContaining({
        path: files.notes,
        logicalPath: 'content/blog',
        kind: 'unreadable',
      }),
    ])
  })

  it('hides an entry moved out of a place the user may not read, whose versions came from there', async () => {
    await recordAs({
      [ID.hello]: { ...helloRecord(), path: `content/${PRIVATE}/post.hello.${ID.hello}.json` },
    })
    const ctx = createCtx({ rules: insidersOnly })
    expect((await list(ctx)).data).toMatchObject({ conflicts: [], hiddenCount: 1 })
    expect((await entryConflict(ctx, 'blog/hello')).status).toBe(404)
    expect((await list(createCtx())).data?.conflicts).toEqual([
      expect.objectContaining({ logicalPath: 'content/blog/hello' }),
    ])
  })

  it('judges a conflict where it is now only, once the schema no longer places where it was', async () => {
    // As after the branch renamed the collection: the recorded directory is named by its shape.
    await recordAs({
      [ID.hello]: {
        ...helloRecord(),
        path: `content/stories.${BLOG.split('.')[1]}/post.hello.${ID.hello}.json`,
      },
    })
    const storiesClosed: PathPermission[] = [
      { path: unsafeAsPermissionPath('content/stories/**'), read: { allowedGroups: ['insiders'] } },
    ]
    const ctx = createCtx({ rules: storiesClosed })
    expect((await list(ctx)).data?.conflicts).toEqual([
      expect.objectContaining({ logicalPath: 'content/blog/hello' }),
    ])
    expect((await entryConflict(ctx, 'blog/hello')).status).toBe(200)
  })

  it('scans nothing when no conflict is open', async () => {
    await recordAs({})
    const scan = vi.spyOn(ContentStore.prototype, 'idIndex')
    expect((await list(createCtx())).data?.openCount).toBe(0)
    expect(scan).not.toHaveBeenCalled()
  })

  it('names a collection’s settings where the collection is now, by its id', async () => {
    const collectionId = BLOG.split('.')[1]
    await recordAs({
      [collectionId]: {
        path: `content/stories.${collectionId}/.collection.json`,
        mergeSha: MERGE,
        kind: 'unreadable',
        sides: {},
      },
    })
    expect((await list(createCtx())).data?.conflicts).toEqual([
      expect.objectContaining({
        path: `content/${BLOG}/.collection.json`,
        logicalPath: 'content/blog',
      }),
    ])
  })

  it('names an entry the branch renamed since the merge where it is now', async () => {
    const renamed = `content/${BLOG}/post.renamed.${ID.hello}.json`
    await fs.rename(path.join(branchRoot, files.hello), path.join(branchRoot, renamed))
    await recordAs({ [ID.hello]: helloRecord() })
    expect((await list(createCtx())).data?.conflicts).toEqual([
      expect.objectContaining({ path: renamed, logicalPath: 'content/blog/renamed' }),
    ])
    expect((await entryConflict(createCtx(), 'blog/renamed')).data).toMatchObject({
      path: renamed,
      logicalPath: 'content/blog/renamed',
    })
    expect((await entryConflict(createCtx(), 'blog/hello')).status).toBe(404)
  })

  it('has none on a branch with no record', async () => {
    expect((await list(createCtx())).data).toEqual({
      conflicts: [],
      hiddenCount: 0,
      openCount: 0,
    })
  })

  it('answers 503 for a record that does not parse, rather than none', async () => {
    await fs.mkdir(path.join(branchRoot, '.canopy-meta'), { recursive: true })
    await fs.writeFile(path.join(branchRoot, '.canopy-meta', 'merge-conflicts.json'), '{oops')
    expect(await list(createCtx())).toMatchObject({ ok: false, status: 503 })
  })

  it('routes the list and an entry’s conflicts apart', () => {
    const routes = buildCanopyRoutes()
    expect(matchRoute(routes, 'GET', ['feature', 'conflicts'])?.pattern).toEqual([
      ':branch',
      'conflicts',
    ])
    expect(
      matchRoute(routes, 'GET', ['feature', 'conflicts', 'content', 'blog', 'hello'])?.pattern,
    ).toEqual([':branch', 'conflicts', '...entryPath'])
    expect(
      matchRoute(routes, 'POST', ['feature', 'resolve-entry', 'content', 'blog', 'hello'])?.pattern,
    ).toEqual([':branch', 'resolve-entry', '...entryPath'])
  })
})

describe('GET /:branch/conflicts/...entryPath', () => {
  it('returns each field with its sides, and every version they name read as the editor reads it (rows 4, 5, 21)', async () => {
    await recordAs({ [ID.hello]: helloRecord() })
    const res = await entryConflict(createCtx(), 'blog/hello')
    expect(res).toMatchObject({ ok: true, status: 200 })
    const data = res.data!
    expect(data).toMatchObject({
      contentId: ID.hello,
      kind: 'fields',
      logicalPath: 'content/blog/hello',
      mergeSha: MERGE,
    })
    expect(data.fields.map((f) => [f.key, f.drawerKey, f.kind])).toEqual([
      ['title', 'title', 'changed'],
      ['sections.hero1.heading', 'sections.hero1.heading', 'changed'],
    ])
    expect(Object.keys(data.versions).sort()).toEqual(Object.values(helloSides).sort())
    expect(data.versions[helloSides.base]).toMatchObject({
      format: 'json',
      entryType: 'post',
      data: { title: 'Hello there' },
    })
    expect(data.versions[helloSides.branch]).toMatchObject({ data: { title: 'Hello you' } })
  })

  it('names a field recorded without the schema as the drawer names it now', async () => {
    const entry = helloRecord()
    entry.fields = [field('?title', [{ field: 'title' }], helloSides)]
    await recordAs({ [ID.hello]: entry })
    const data = (await entryConflict(createCtx(), 'content/blog/hello')).data!
    expect(data.fields[0]).toMatchObject({ key: '?title', drawerKey: 'title' })
  })

  it('keeps an item conflict’s key and kind, and the location pseudo-key (rows 13, 14)', async () => {
    const entry = helloRecord()
    entry.fields = [
      field('sections.text1', [{ field: 'sections' }, { item: 'text1' }], helloSides, {
        kind: 'removed-on-base',
        item: true,
      }),
      field(LOCATION_CONFLICT_KEY, [], helloSides),
    ]
    await recordAs({ [ID.hello]: entry })
    const data = (await entryConflict(createCtx(), 'blog/hello')).data!
    expect(data.fields).toEqual([
      expect.objectContaining({
        key: 'sections.text1',
        drawerKey: 'sections.text1',
        kind: 'removed-on-base',
        item: true,
      }),
      expect.objectContaining({ key: LOCATION_CONFLICT_KEY, drawerKey: LOCATION_CONFLICT_KEY }),
    ])
  })

  it('reads an md entry’s body and a side the merge found no file for (rows 7, 8, 23)', async () => {
    const ancestor = await blob('---\ntitle: Memo\n---\nFirst line\n')
    const base = await blob('---\ntitle: Memo\n---\nFirst line, edited\n')
    const sides = { ancestor, base, branch: await blob('---\ntitle: Memo\n---\nFirst, mine\n') }
    await recordAs({
      [ID.memo]: {
        path: files.memo,
        mergeSha: MERGE,
        kind: 'fields',
        sides,
        fields: [
          field('content', [{ field: 'content' }], sides, { text: true }),
          field('?readTime', [{ field: 'readTime' }], sides, { kind: 'removed-on-base' }),
          field('?author', [{ field: 'author' }], sides, { kind: 'removed-by-you' }),
        ],
      },
    })
    const data = (await entryConflict(createCtx(), 'content/notes/memo')).data!
    expect(data.versions[base]).toMatchObject({
      format: 'md',
      body: 'First line, edited\n',
      bodyFieldName: 'content',
    })
    expect(data.fields.map((f) => [f.key, f.kind, f.text])).toEqual([
      ['content', 'changed', true],
      ['?readTime', 'removed-on-base', undefined],
      ['?author', 'removed-by-you', undefined],
    ])
  })

  it('marks a version that is missing or too large, rather than failing (row 33)', async () => {
    const big = await blob(json({ title: 'x'.repeat(1024 * 1024) }))
    await recordAs({
      [ID.hello]: {
        path: files.hello,
        mergeSha: MERGE,
        kind: 'unreadable',
        sides: { base: big, branch: 'c'.repeat(40) },
      },
    })
    const data = (await entryConflict(createCtx(), 'blog/hello')).data!
    expect(data.versions).toEqual({
      [big]: { unavailable: 'too-large' },
      ['c'.repeat(40)]: { unavailable: 'missing' },
    })
  })

  it('answers an entry the user may not read as one with no conflict (row 46)', async () => {
    await recordAs({
      [ID.secret]: { path: files.secret, mergeSha: MERGE, kind: 'unreadable', sides: {} },
    })
    const ctx = createCtx({ rules: insidersOnly })
    expect(await entryConflict(ctx, 'content/private/secret')).toEqual({
      ok: false,
      status: 404,
      error: 'This entry has no conflicting changes.',
    })
    expect((await entryConflict(createCtx(), 'content/private/secret')).ok).toBe(true)
  })

  it('answers 404 for an entry with no conflict, and for one under another id', async () => {
    await recordAs({ [ID.hello]: helloRecord() })
    expect((await entryConflict(createCtx(), 'content/blog/old-news')).status).toBe(404)
    expect((await entryConflict(createCtx(), 'content/blog/hello', ID.old)).status).toBe(404)
    expect((await entryConflict(createCtx(), 'content/blog/hello', ID.hello)).status).toBe(200)
  })
})

describe('resolving a field conflict with a save', () => {
  const read = async (ctx: ApiContext) => {
    const res = await CONTENT_ROUTES.read.handler(
      ctx,
      { user },
      { branch, path: unsafeAsLogicalPath('content/blog/hello') },
    )
    return res.data!
  }
  const save = async (
    ctx: ApiContext,
    data: Record<string, unknown>,
    resolvedConflicts: Array<{ mergeSha: string; key: string }> | undefined,
    expectedVersion?: number,
  ): Promise<ContentWriteResponse> =>
    CONTENT_ROUTES.write.handler(
      ctx,
      { user },
      { branch, path: unsafeAsLogicalPath('content/blog/hello') },
      {
        format: 'json',
        data,
        expectedVersion: expectedVersion ?? (await read(ctx)).version,
        ...(resolvedConflicts && { resolvedConflicts }),
      },
    )

  it('clears exactly the keys it names, and conflictFiles follows (row 43)', async () => {
    await recordAs({ [ID.hello]: helloRecord(), [ID.memo]: helloRecord() })
    const ctx = createCtx()
    const res = await save(ctx, post('Hello there', 'Welcome friends'), [
      { mergeSha: MERGE, key: 'title' },
    ])
    expect(res).toMatchObject({ ok: true, status: 200 })
    expect(res.data?.resolvedConflicts).toEqual([{ mergeSha: MERGE, key: 'title' }])
    expect((await recorded())[ID.hello].fields?.map((f) => f.key)).toEqual([
      'sections.hero1.heading',
    ])
    expect(await conflictFiles()).toEqual([ID.memo, ID.hello].sort())

    await save(ctx, post('Hello there', 'Welcome friends'), [
      { mergeSha: MERGE, key: 'sections.hero1.heading' },
    ])
    expect((await recorded())[ID.hello]).toBeUndefined()
    expect(await conflictFiles()).toEqual([ID.memo])
    const saved = JSON.parse(await fs.readFile(path.join(branchRoot, files.hello), 'utf8'))
    expect(saved.title).toBe('Hello there')
  })

  it('clears an item conflict by its item key (row 14)', async () => {
    const entry = helloRecord()
    entry.fields = [
      field('sections.text1', [{ field: 'sections' }, { item: 'text1' }], helloSides, {
        kind: 'removed-on-base',
        item: true,
      }),
    ]
    await recordAs({ [ID.hello]: entry })
    const kept = post('Hello you', 'Welcome friends')
    const res = await save(createCtx(), { ...kept, sections: kept.sections.slice(0, 1) }, [
      { mergeSha: MERGE, key: 'sections.text1' },
    ])
    expect(res.data?.resolvedConflicts).toEqual([{ mergeSha: MERGE, key: 'sections.text1' }])
    expect(await recorded()).toEqual({})
  })

  it('leaves a conflict open when the save does not name it (row 44)', async () => {
    await recordAs({ [ID.hello]: helloRecord() })
    const res = await save(createCtx(), post('Hello there', 'Welcome friends'), undefined)
    expect(res.ok).toBe(true)
    expect(res.data?.resolvedConflicts).toBeUndefined()
    expect((await recorded())[ID.hello].fields).toHaveLength(2)
  })

  it('ignores a key the record no longer holds under that merge (row 44, stale key)', async () => {
    await recordAs({ [ID.hello]: helloRecord() })
    const res = await save(createCtx(), post('Hello there', 'Welcome friends'), [
      { mergeSha: OLDER, key: 'title' },
      { mergeSha: MERGE, key: 'summary' },
    ])
    expect(res).toMatchObject({ ok: true, status: 200 })
    expect(res.data?.resolvedConflicts).toEqual([])
    expect((await recorded())[ID.hello].fields).toHaveLength(2)
  })

  it('leaves the record untouched when the version does not match (row 44)', async () => {
    await recordAs({ [ID.hello]: helloRecord() })
    const ctx = createCtx()
    const stale = (await read(ctx)).version! - 1000
    const before = await fs.readFile(
      path.join(branchRoot, '.canopy-meta', 'merge-conflicts.json'),
      'utf8',
    )
    const res = await save(
      ctx,
      post('Hello there', 'Welcome all'),
      [{ mergeSha: MERGE, key: 'title' }],
      stale,
    )
    expect(res).toMatchObject({ ok: false, status: 409 })
    expect(
      await fs.readFile(path.join(branchRoot, '.canopy-meta', 'merge-conflicts.json'), 'utf8'),
    ).toBe(before)
  })

  it('keeps the save, and says so, when the record cannot be cleared', async () => {
    await recordAs({ [ID.hello]: helloRecord() })
    const consoleSpy = mockConsole()
    onTestFinished(() => consoleSpy.restore())
    vi.spyOn(MergeConflictStore.prototype, 'update').mockRejectedValueOnce(new Error('EIO'))
    const res = await save(createCtx(), post('Hello there', 'Welcome friends'), [
      { mergeSha: MERGE, key: 'title' },
    ])
    expect(consoleSpy).toHaveWarned(/couldn't mark its conflicts resolved/)
    expect(res).toMatchObject({ ok: true, status: 200 })
    expect(res.data?.resolvedConflicts).toEqual([])
    expect(res.data?.validationWarnings?.[0]?.message).toContain('wasn’t recorded')
    expect((await recorded())[ID.hello].fields).toHaveLength(2)
  })

  it('refuses a malformed pair before anything is written', async () => {
    await recordAs({ [ID.hello]: helloRecord() })
    const parsed = CONTENT_ROUTES.write.body!.safeParse({
      format: 'json',
      data: {},
      resolvedConflicts: [{ mergeSha: 'not-a-sha', key: 'title' }],
    })
    expect(parsed.success).toBe(false)
  })
})

describe('POST /:branch/resolve-entry/...entryPath', () => {
  it('keeps the branch’s entry the latest version deleted (rows 31, 43)', async () => {
    await recordAs({
      [ID.hello]: { path: files.hello, mergeSha: MERGE, kind: 'deleted-on-base', sides: {} },
    })
    const res = await resolveEntry(createCtx(), 'blog/hello', {
      id: ID.hello,
      mergeSha: MERGE,
      choice: 'keep',
    })
    expect(res).toEqual({ ok: true, status: 200, data: { contentId: ID.hello, openCount: 0 } })
    expect(await recorded()).toEqual({})
    expect(await conflictFiles()).toEqual([])
    await expect(fs.stat(path.join(branchRoot, files.hello))).resolves.toBeTruthy()
  })

  it('deletes the entry the latest version deleted (rows 31, 43)', async () => {
    await recordAs({
      [ID.hello]: { path: files.hello, mergeSha: MERGE, kind: 'deleted-on-base', sides: {} },
    })
    const res = await resolveEntry(createCtx(), 'blog/hello', {
      id: ID.hello,
      mergeSha: MERGE,
      choice: 'delete',
    })
    expect(res.ok).toBe(true)
    await expect(fs.stat(path.join(branchRoot, files.hello))).rejects.toThrow()
    expect(await recorded()).toEqual({})
  })

  it('restores the entry the branch deleted, as the latest version has it (rows 31, 43)', async () => {
    const latest = json({ title: 'Gone, but updated' })
    await recordAs({
      [ID.gone]: {
        path: files.gone,
        mergeSha: MERGE,
        kind: 'deleted-on-branch',
        sides: { base: await blob(latest) },
      },
    })
    const res = await resolveEntry(createCtx(), 'content/blog/gone', {
      id: ID.gone,
      mergeSha: MERGE,
      choice: 'restore',
    })
    expect(res.ok).toBe(true)
    expect(await fs.readFile(path.join(branchRoot, files.gone), 'utf8')).toBe(latest)
    expect(await recorded()).toEqual({})
  })

  it('replaces an entry that can’t merge field by field with the latest version (rows 33, 43)', async () => {
    const latest = json({ title: 'Latest', sections: [] })
    const { merge, blobs } = await mergeTaking({ [files.hello]: latest })
    await recordAs({
      [ID.hello]: {
        path: files.hello,
        mergeSha: merge,
        kind: 'unreadable',
        sides: { base: blobs[files.hello], branch: helloSides.branch },
      },
    })
    const res = await resolveEntry(createCtx(), 'blog/hello', {
      id: ID.hello,
      mergeSha: merge,
      choice: 'use-latest',
    })
    expect(res.ok).toBe(true)
    expect(await fs.readFile(path.join(branchRoot, files.hello), 'utf8')).toBe(latest)
    expect(await recorded()).toEqual({})
  })

  it('refuses the latest version of another entry type or format, changing nothing (row 32)', async () => {
    const asMarkdown = `content/${BLOG}/post.hello.${ID.hello}.md`
    const { merge, blobs } = await mergeTaking({ [asMarkdown]: '---\ntitle: Latest\n---\n' }, [
      files.hello,
    ])
    await recordAs({
      [ID.hello]: {
        path: files.hello,
        mergeSha: merge,
        kind: 'unreadable',
        sides: { base: blobs[asMarkdown], branch: helloSides.branch },
      },
    })
    const before = await fs.readFile(path.join(branchRoot, files.hello), 'utf8')
    const res = await resolveEntry(createCtx(), 'blog/hello', {
      id: ID.hello,
      mergeSha: merge,
      choice: 'use-latest',
    })
    expect(res).toMatchObject({ ok: false, status: 409 })
    expect(await fs.readFile(path.join(branchRoot, files.hello), 'utf8')).toBe(before)
    expect(Object.keys(await recorded())).toEqual([ID.hello])
  })

  it('deletes only the entry the record names, not another now at its slug', async () => {
    await fs.rm(path.join(branchRoot, files.old))
    const other = `content/${BLOG}/post.old-news.${ID.gone}.json`
    await write(other, json({ title: 'Another entry' }))
    await recordAs({
      [ID.old]: { path: files.old, mergeSha: MERGE, kind: 'deleted-on-base', sides: {} },
    })
    const res = await resolveEntry(createCtx(), 'blog/old-news', {
      id: ID.old,
      mergeSha: MERGE,
      choice: 'delete',
    })
    expect(res).toMatchObject({ ok: false, status: 409, code: 'ENTRY_GONE' })
    await expect(fs.stat(path.join(branchRoot, other))).resolves.toBeTruthy()
    expect(Object.keys(await recorded())).toEqual([ID.old])
  })

  it('keeps every field of a fields record at once', async () => {
    await recordAs({ [ID.hello]: helloRecord(), [ID.memo]: helloRecord() })
    const res = await resolveEntry(createCtx(), 'blog/hello', {
      id: ID.hello,
      mergeSha: MERGE,
      choice: 'keep',
    })
    expect(res.data).toEqual({ contentId: ID.hello, openCount: 2 })
    expect(Object.keys(await recorded())).toEqual([ID.memo])
  })

  it('refuses a conflict a later merge changed, leaving it as it was', async () => {
    await recordAs({
      [ID.hello]: { path: files.hello, mergeSha: MERGE, kind: 'deleted-on-base', sides: {} },
    })
    const res = await resolveEntry(createCtx(), 'blog/hello', {
      id: ID.hello,
      mergeSha: OLDER,
      choice: 'delete',
    })
    expect(res).toMatchObject({ ok: false, status: 409, code: 'CONFLICT_CHANGED' })
    await expect(fs.stat(path.join(branchRoot, files.hello))).resolves.toBeTruthy()
    expect(Object.keys(await recorded())).toEqual([ID.hello])
  })

  it('refuses a choice that does not resolve that kind', async () => {
    await recordAs({
      [ID.hello]: { path: files.hello, mergeSha: MERGE, kind: 'deleted-on-base', sides: {} },
    })
    const res = await resolveEntry(createCtx(), 'blog/hello', {
      id: ID.hello,
      mergeSha: MERGE,
      choice: 'restore',
    })
    expect(res).toMatchObject({ ok: false, status: 400 })
    expect(Object.keys(await recorded())).toEqual([ID.hello])
  })

  it('refuses the latest version from another collection, whose type shares the name', async () => {
    const moved = `content/${PRIVATE}/post.hello.${ID.hello}.json`
    const { merge, blobs } = await mergeTaking({ [moved]: json({ title: 'Moved' }) }, [files.hello])
    await recordAs({
      [ID.hello]: {
        path: files.hello,
        mergeSha: merge,
        kind: 'unreadable',
        sides: { base: blobs[moved], branch: helloSides.branch },
      },
    })
    const res = await resolveEntry(createCtx(), 'blog/hello', {
      id: ID.hello,
      mergeSha: merge,
      choice: 'use-latest',
    })
    expect(res).toMatchObject({ ok: false, status: 409 })
    expect(Object.keys(await recorded())).toEqual([ID.hello])
  })

  it('lets only admins resolve a conflict in a collection’s settings, as only they edit them', async () => {
    const collectionId = BLOG.split('.')[1]
    await recordAs({
      [collectionId]: {
        path: `content/${BLOG}/.collection.json`,
        mergeSha: MERGE,
        kind: 'unreadable',
        sides: {},
      },
    })
    const body = { id: collectionId, mergeSha: MERGE, choice: 'keep' as const }
    expect(await resolveEntry(createCtx(), 'content/blog', body)).toMatchObject({ status: 403 })
    const res = await MERGE_CONFLICT_ROUTES.resolveEntry.handler(
      createCtx(),
      { user: adminUser },
      { branch, entryPath: unsafeAsLogicalPath('content/blog') },
      { ...body, id: unsafeAsContentId(collectionId) },
    )
    expect(res).toMatchObject({ ok: true, status: 200 })
  })

  it('lets an admin keep a conflict on a file that is neither entry nor settings, and no one else', async () => {
    const collectionId = BLOG.split('.')[1]
    await recordAs({
      [collectionId]: { path: files.notes, mergeSha: MERGE, kind: 'unreadable', sides: {} },
    })
    // Addressed by its collection, as the router takes no path with an id in it.
    expect(logicalPathSchema.safeParse(files.notes).success).toBe(false)
    expect(logicalPathSchema.safeParse('content/blog').success).toBe(true)
    const body = { id: collectionId, mergeSha: MERGE, choice: 'keep' as const }
    expect(await resolveEntry(createCtx(), 'content/blog', body)).toMatchObject({ status: 403 })
    expect(Object.keys(await recorded())).toEqual([collectionId])
    const res = await MERGE_CONFLICT_ROUTES.resolveEntry.handler(
      createCtx(),
      { user: adminUser },
      { branch, entryPath: unsafeAsLogicalPath('content/blog') },
      { ...body, id: unsafeAsContentId(collectionId) },
    )
    expect(res).toMatchObject({ ok: true, status: 200 })
    expect(await recorded()).toEqual({})
  })

  it('checks the record inside the write’s locks, changing nothing when a racing write moved it on', async () => {
    await recordAs({
      [ID.hello]: { path: files.hello, mergeSha: MERGE, kind: 'deleted-on-base', sides: {} },
    })
    const original = ContentStore.prototype.delete
    vi.spyOn(ContentStore.prototype, 'delete').mockImplementation(async function (
      this: ContentStore,
      ...args: Parameters<ContentStore['delete']>
    ) {
      await recordAs({
        [ID.hello]: { path: files.hello, mergeSha: OLDER, kind: 'deleted-on-base', sides: {} },
      })
      return original.apply(this, args)
    })
    const res = await resolveEntry(createCtx(), 'blog/hello', {
      id: ID.hello,
      mergeSha: MERGE,
      choice: 'delete',
    })
    expect(res).toMatchObject({ ok: false, status: 409, code: 'CONFLICT_CHANGED' })
    await expect(fs.stat(path.join(branchRoot, files.hello))).resolves.toBeTruthy()
    expect((await recorded())[ID.hello]?.mergeSha).toBe(OLDER)
  })

  it('refuses a user who may not edit the entry', async () => {
    await recordAs({
      [ID.secret]: { path: files.secret, mergeSha: MERGE, kind: 'deleted-on-base', sides: {} },
    })
    const res = await resolveEntry(createCtx({ rules: insidersOnly }), 'private/secret', {
      id: ID.secret,
      mergeSha: MERGE,
      choice: 'delete',
    })
    expect(res).toMatchObject({ ok: false, status: 403 })
    await expect(fs.stat(path.join(branchRoot, files.secret))).resolves.toBeTruthy()
  })
})
