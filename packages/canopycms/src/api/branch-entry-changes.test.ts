/**
 * GET /:branch/changes/...entryPath against a real branch clone, with the real path-ACL layer.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { simpleGit, type SimpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import { defineCanopyTestConfig } from '../config-test'
import { flattenSchema, type PathPermission, type RootCollectionConfig } from '../config'
import { createCheckBranchAccess } from '../authorization'
import { createTestContentAccess, unsafeAsPermissionPath } from '../authorization/test-utils'
import { ContentStore } from '../content-store'
import { GitManager } from '../git-manager'
import {
  createMockApiContext,
  createMockBranchContext,
  initTestRepo,
  openBareRepo,
} from '../test-utils'
import {
  unsafeAsBranchName,
  unsafeAsContentId,
  unsafeAsLogicalPath,
  unsafeAsSlug,
} from '../paths/test-utils'
import { mockConsole } from '../test-utils/console-spy'
import { matchRoute } from '../http/router'
import { buildCanopyRoutes } from './routes'
import type { ApiContext, ApiRequest } from './types'
import { readBranchEntryChange, type BranchEntryChangeResponse } from './branch-entry-changes'

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
  entries: [{ name: 'page', format: 'json', schema: titleOnly }],
  collections: [
    { name: 'blog', path: 'blog', entries: [{ name: 'post', format: 'json', schema: postFields }] },
    { name: 'notes', path: 'notes', entries: [{ name: 'note', format: 'md', schema: noteFields }] },
    { name: 'data', path: 'data', entries: [{ name: 'item', format: 'yaml', schema: titleOnly }] },
    {
      name: 'private',
      path: 'private',
      entries: [{ name: 'post', format: 'json', schema: titleOnly }],
    },
  ],
}

const BLOG = 'blog.q52DCVPuH4ga'
const NOTES = 'notes.Hq2Wd3Rt4Yu5'
const DATA = 'data.Lm6Nb7Vc8Xz9'
const PRIVATE = 'private.Kp3Lm4Nq5Rs6'
const ID = {
  hello: 'zY9xW8vU7tS6',
  old: 'pQ2rS3tU4vW5',
  memo: 'Ab2Cd3Ef4Gh5',
  item: 'Jk6Lm7Np8Qr9',
  secret: 'mN8bV7cX6zL5',
  fresh: 'Ff4Gg5Hh6Jj7',
}
const helloPost = {
  title: 'Hello',
  sections: [
    { template: 'hero', value: { heading: 'Welcome' } },
    { template: 'text', value: { copy: 'Some words' } },
  ],
}
const files = {
  hello: `content/${BLOG}/post.hello.${ID.hello}.json`,
  old: `content/${BLOG}/post.old-news.${ID.old}.json`,
  memo: `content/${NOTES}/note.memo.${ID.memo}.md`,
  item: `content/${DATA}/item.thing.${ID.item}.yaml`,
  secret: `content/${PRIVATE}/post.secret.${ID.secret}.json`,
}
const seedText: Record<keyof typeof files, string> = {
  hello: JSON.stringify(helloPost),
  old: JSON.stringify({ title: 'Old news' }),
  memo: '---\ntitle: Memo\n---\nFirst line\nSecond line\n',
  item: 'title: Thing\n',
  secret: JSON.stringify({ title: 'Secret' }),
}

let tmpDir: string
let branchRoot: string
let clone: SimpleGit

const write = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(path.join(branchRoot, file)), { recursive: true })
  await fs.writeFile(path.join(branchRoot, file), text, 'utf8')
}

beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-entry-change-')))
  const remotePath = path.join(tmpDir, 'remote.git')
  await fs.mkdir(remotePath)
  await openBareRepo(remotePath).init(true)
  const seedPath = path.join(tmpDir, 'seed')
  await fs.mkdir(seedPath)
  const seed = await initTestRepo(seedPath)
  await seed.raw(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  for (const [name, file] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(seedPath, file)), { recursive: true })
    await fs.writeFile(path.join(seedPath, file), seedText[name as keyof typeof files], 'utf8')
  }
  await seed.raw(['add', '--', '.'])
  await seed.commit('base')
  await seed.addRemote('origin', remotePath)
  await seed.push('origin', 'main')
  branchRoot = path.join(tmpDir, 'feature')
  await GitManager.cloneRepo(remotePath, branchRoot, 'main')
  clone = simpleGit({ baseDir: branchRoot })
  await clone.raw(['checkout', '-q', '-b', 'feature', 'origin/main'])
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const createCtx = (
  options: {
    rules?: PathPermission[]
    git?: (repoPath: string) => GitManager
    /** The schema now, for a branch that changed it. */
    currentSchema?: RootCollectionConfig
  } = {},
): ApiContext => {
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
        options.git?.(repoPath) ??
        new GitManager({ repoPath, baseBranch: opts?.baseBranch ?? 'main', remote: 'origin' }),
    },
    branchContext: {
      ...branchContext,
      flatSchema: flattenSchema(options.currentSchema ?? schema, config.contentRoot),
    },
  })
}

const user: ApiRequest['user'] = { type: 'authenticated', userId: 'u1', groups: [] }

const entryChange = (
  ctx: ApiContext,
  entryPath: string,
  from?: string,
  id?: string,
): Promise<BranchEntryChangeResponse> =>
  readBranchEntryChange.handler(
    ctx,
    { user },
    {
      branch: unsafeAsBranchName('feature'),
      entryPath: unsafeAsLogicalPath(entryPath),
      ...(from && { from: unsafeAsLogicalPath(from) }),
      ...(id && { id: unsafeAsContentId(id) }),
    },
  )

const ok = async (ctx: ApiContext, entryPath: string, from?: string, id?: string) => {
  const res = await entryChange(ctx, entryPath, from, id)
  expect(res).toMatchObject({ ok: true, status: 200 })
  return res.data!
}

const notComparable = { ok: false, status: 404, error: "This entry can't be compared." }
const insidersOnly: PathPermission[] = [
  { path: unsafeAsPermissionPath('content/private/**'), read: { allowedGroups: ['insiders'] } },
]

describe('GET /:branch/changes/...entryPath', () => {
  it('reads a modified entry’s base and saved sides, with the fork point', async () => {
    await write(files.hello, JSON.stringify({ ...helloPost, title: 'Hello again' }))
    const data = await ok(createCtx(), 'content/blog/hello')
    expect(data.mergeBaseSha).toMatch(/^[0-9a-f]{40}$/)
    expect(data.before).toMatchObject({
      format: 'json',
      entryType: 'post',
      data: { title: 'Hello' },
    })
    expect(data.after).toMatchObject({
      format: 'json',
      entryType: 'post',
      data: { title: 'Hello again' },
    })
  })

  it('takes a logical path without the content root, as content reads do', async () => {
    await write(files.hello, JSON.stringify({ ...helloPost, title: 'Hello again' }))
    expect((await ok(createCtx(), 'blog/hello')).before?.data.title).toBe('Hello')
  })

  it('has no base side for an entry new on the branch', async () => {
    await write(`content/${BLOG}/post.fresh.${ID.fresh}.json`, JSON.stringify({ title: 'Fresh' }))
    const data = await ok(createCtx(), 'content/blog/fresh')
    expect(data.before).toBeNull()
    expect(data.after?.data.title).toBe('Fresh')
  })

  it('has no base side for a new entry reusing a deleted one’s slug under another id', async () => {
    await fs.rm(path.join(branchRoot, files.old))
    await write(`content/${BLOG}/post.old-news.${ID.fresh}.json`, JSON.stringify({ title: 'New' }))
    const data = await ok(createCtx(), 'content/blog/old-news')
    expect(data.before).toBeNull()
    expect(data.after?.data.title).toBe('New')
  })

  it('has no saved side for an entry the branch deleted', async () => {
    await fs.rm(path.join(branchRoot, files.old))
    const data = await ok(createCtx(), 'content/blog/old-news')
    expect(data.after).toBeNull()
    expect(data.before).toMatchObject({ entryType: 'post', data: { title: 'Old news' } })
  })

  it('reads a moved entry’s base side from `from`, matched by content id', async () => {
    const moved = `content/${BLOG}/post.hello-again.${ID.hello}.json`
    await fs.rename(path.join(branchRoot, files.hello), path.join(branchRoot, moved))
    const data = await ok(createCtx(), 'content/blog/hello-again', 'content/blog/hello')
    expect(data.before?.data.title).toBe('Hello')
    expect(data.after?.data.title).toBe('Hello')
  })

  it('finds the base side when the collection’s directory was renamed on the branch', async () => {
    await clone.raw(['mv', `content/${BLOG}`, 'content/blog.Zz9Yy8Xx7Ww6'])
    await write(
      `content/blog.Zz9Yy8Xx7Ww6/post.hello.${ID.hello}.json`,
      JSON.stringify({ ...helloPost, title: 'Renamed dir' }),
    )
    const data = await ok(createCtx(), 'content/blog/hello')
    expect(data.before?.data.title).toBe('Hello')
    expect(data.after?.data.title).toBe('Renamed dir')
  })

  it('answers 404 for a moved entry whose `from` the user can’t read', async () => {
    const moved = `content/${BLOG}/post.secret.${ID.secret}.json`
    await fs.rename(path.join(branchRoot, files.secret), path.join(branchRoot, moved))
    const res = await entryChange(
      createCtx({ rules: insidersOnly }),
      'content/blog/secret',
      'content/private/secret',
    )
    expect(res).toEqual(notComparable)
  })

  it('answers 404 for an entry the user can’t read, as for one that isn’t there', async () => {
    await write(files.secret, JSON.stringify({ title: 'Secret edited' }))
    const ctx = createCtx({ rules: insidersOnly })
    expect(await entryChange(ctx, 'content/private/secret')).toEqual(notComparable)
    expect(await entryChange(ctx, 'content/private/missing')).toEqual(notComparable)
    expect(await entryChange(createCtx(), 'content/blog/missing')).toEqual(notComparable)
  })

  describe('judges the path it reads, not the path as sent', () => {
    const helloOnly: PathPermission[] = [
      { path: unsafeAsPermissionPath('content/blog/hello'), read: { allowedGroups: ['insiders'] } },
    ]

    it.each(['content/blog/HELLO', 'content/blog//hello', 'content//blog/hello', 'blog/Hello'])(
      'answers 404 for %s, which reads a restricted entry',
      async (sent) => {
        await write(files.hello, JSON.stringify({ ...helloPost, title: 'Hello again' }))
        expect(await entryChange(createCtx({ rules: helloOnly }), sent)).toEqual(notComparable)
        // Without the rule the same spelling reads that entry.
        expect((await ok(createCtx(), sent)).after?.data.title).toBe('Hello again')
      },
    )

    it('answers 404 for a `from` spelled differently from a restricted base path', async () => {
      const moved = `content/${BLOG}/post.hello-again.${ID.hello}.json`
      await fs.rename(path.join(branchRoot, files.hello), path.join(branchRoot, moved))
      const ctx = createCtx({ rules: helloOnly })
      expect(await entryChange(ctx, 'content/blog/hello-again', 'content/blog/HELLO')).toEqual(
        notComparable,
      )
      expect(await entryChange(ctx, 'content/blog/hello-again', 'content//blog/hello')).toEqual(
        notComparable,
      )
    })
  })

  it('pins both sides to `id`: a deleted entry whose slug was reused reads as deleted', async () => {
    await fs.rm(path.join(branchRoot, files.old))
    await write(`content/${BLOG}/post.old-news.${ID.fresh}.json`, JSON.stringify({ title: 'New' }))
    const deleted = await ok(createCtx(), 'content/blog/old-news', undefined, ID.old)
    expect(deleted.after).toBeNull()
    expect(deleted.before?.data.title).toBe('Old news')
    const recreated = await ok(createCtx(), 'content/blog/old-news', undefined, ID.fresh)
    expect(recreated.before).toBeNull()
    expect(recreated.after?.data.title).toBe('New')
  })

  it('answers 404 for an id neither side holds at the path', async () => {
    await write(files.hello, JSON.stringify({ ...helloPost, title: 'Hello again' }))
    expect(await entryChange(createCtx(), 'content/blog/hello', undefined, ID.fresh)).toEqual(
      notComparable,
    )
  })

  it('keys a base side the schema no longer places with the saved side’s fields', async () => {
    // The blog collection is renamed to "posts" in the schema and on disk; the entry is unchanged.
    const renamed: RootCollectionConfig = {
      ...schema,
      collections: schema.collections?.map((c) =>
        c.name === 'blog' ? { ...c, name: 'posts', path: 'posts' } : c,
      ),
    }
    await clone.raw(['mv', `content/${BLOG}`, 'content/posts.Zz9Yy8Xx7Ww6'])
    const data = await ok(
      createCtx({ currentSchema: renamed }),
      'content/posts/hello',
      'content/blog/hello',
    )
    const keys = (side: Record<string, unknown> | undefined) =>
      (side?.sections as Array<{ _key?: string }>).map((s) => s._key)
    expect(keys(data.before?.data)).toEqual(keys(data.after?.data))
    expect(keys(data.after?.data).every((key) => typeof key === 'string')).toBe(true)
  })

  it('answers 413 when either side is over 1 MB, reading neither', async () => {
    const big = JSON.stringify({ title: 'x'.repeat(1024 * 1024) })
    await write(files.hello, big)
    const res = await entryChange(createCtx(), 'content/blog/hello')
    expect(res).toEqual({
      ok: false,
      status: 413,
      error: 'This entry is too large to compare here.',
    })
    await clone.raw(['commit', '-qam', 'big'])
    await clone.raw(['push', '-q', 'origin', 'HEAD:main'])
    await write(files.hello, JSON.stringify({ title: 'Small again' }))
    expect(await entryChange(createCtx(), 'content/blog/hello')).toMatchObject({ status: 413 })
  })

  it('answers 422 when a side doesn’t parse', async () => {
    await write(files.hello, '{ not json')
    expect(await entryChange(createCtx(), 'content/blog/hello')).toEqual({
      ok: false,
      status: 422,
      error: "This entry couldn't be read on one side, so it can't be compared.",
    })
  })

  it('keys list items as ContentStore.read does, so an unchanged block matches on both sides', async () => {
    await write(
      files.hello,
      JSON.stringify({ ...helloPost, sections: [...helloPost.sections].reverse() }),
    )
    const data = await ok(createCtx(), 'content/blog/hello')
    const store = new ContentStore(branchRoot, flattenSchema(schema, 'content'))
    const read = await store.read(unsafeAsLogicalPath('content/blog'), unsafeAsSlug('hello'), {
      resolveReferences: false,
    })
    expect(data.after?.data).toEqual(read.data)
    const keys = (side: Record<string, unknown> | undefined) =>
      (side?.sections as Array<{ _key: string }>).map((s) => s._key)
    expect(keys(data.before?.data)).toEqual([...keys(data.after?.data)].reverse())
    expect(keys(data.before?.data).every((key) => /^h[1-9A-HJ-NP-Za-km-z]+$/.test(key))).toBe(true)
  })

  it('splits a markdown entry’s body out of its frontmatter on both sides', async () => {
    await write(files.memo, '---\ntitle: Memo\n---\nFirst line\nSecond line, edited\n')
    const data = await ok(createCtx(), 'content/notes/memo')
    expect(data.before).toEqual({
      format: 'md',
      entryType: 'note',
      data: { title: 'Memo' },
      body: 'First line\nSecond line\n',
      bodyFieldName: 'content',
    })
    expect(data.after).toEqual({
      format: 'md',
      entryType: 'note',
      data: { title: 'Memo' },
      body: 'First line\nSecond line, edited\n',
      bodyFieldName: 'content',
    })
  })

  it('keeps a frontmatter field named like the body field as data, as ContentStore.read does', async () => {
    await write(files.memo, '---\ntitle: Memo\ncontent: In the frontmatter\n---\n')
    const data = await ok(createCtx(), 'content/notes/memo')
    expect(data.before?.body).toBe('First line\nSecond line\n')
    expect(data.after).toMatchObject({ data: { content: 'In the frontmatter' }, body: '' })
  })

  it('reads a YAML entry', async () => {
    await write(files.item, 'title: Thing two\n')
    const data = await ok(createCtx(), 'content/data/thing')
    expect(data.before).toEqual({ format: 'yaml', entryType: 'item', data: { title: 'Thing' } })
    expect(data.after).toEqual({ format: 'yaml', entryType: 'item', data: { title: 'Thing two' } })
  })

  it('is routed apart from the branch’s list of changes', () => {
    const routes = buildCanopyRoutes()
    expect(matchRoute(routes, 'GET', ['feature', 'changes'])?.pattern).toEqual([
      ':branch',
      'changes',
    ])
    expect(
      matchRoute(routes, 'GET', ['feature', 'changes', 'content', 'blog', 'hello']),
    ).toMatchObject({
      pattern: [':branch', 'changes', '...entryPath'],
      params: { branch: 'feature', entryPath: 'content/blog/hello' },
    })
  })
})

describe('GET /:branch/changes/...entryPath: reads that race or fail', () => {
  /** A GitManager that runs `during` once the base tree has been listed. */
  const gitThat = (during: () => Promise<void>) => (repoPath: string) =>
    new (class extends GitManager {
      async listFilesWithSizeAt(rev: string, under: string) {
        const result = await super.listFilesWithSizeAt(rev, under)
        await during()
        return result
      }
    })({ repoPath, baseBranch: 'main', remote: 'origin' })

  it('refuses with 409 mid-rebase, in the server’s words', async () => {
    await fs.mkdir(path.join(branchRoot, '.git', 'rebase-merge'))
    expect(await entryChange(createCtx(), 'content/blog/hello')).toEqual({
      ok: false,
      status: 409,
      error: 'This branch is being synced with main. Try again in a moment.',
    })
  })

  it('refuses with 409 when HEAD moves during the read', async () => {
    await write(files.hello, JSON.stringify({ title: 'Edited' }))
    const ctx = createCtx({
      git: gitThat(() =>
        clone.raw(['commit', '-q', '--allow-empty', '-m', 'submitted']).then(() => {}),
      ),
    })
    expect(await entryChange(ctx, 'content/blog/hello')).toEqual({
      ok: false,
      status: 409,
      error: 'This branch changed while its changes were being read. Try again in a moment.',
    })
  })

  it('answers 503 when git fails, and logs why', async () => {
    const consoleSpy = mockConsole()
    onTestFinished(() => consoleSpy.restore())
    await fs.rm(path.join(tmpDir, 'remote.git'), { recursive: true, force: true })
    expect(await entryChange(createCtx(), 'content/blog/hello')).toEqual({
      ok: false,
      status: 503,
      error: "Couldn't read this branch's changes right now. Try again in a moment.",
    })
    expect(consoleSpy).toHaveWarned(/could not read what feature changes against main/)
  })
})
