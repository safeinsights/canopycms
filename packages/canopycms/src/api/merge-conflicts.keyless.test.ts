/**
 * A conflict inside a list the base left keyless, end to end: real repositories, the worker's own
 * merge (`planMerge`), the record as the worker writes it, `GET /:branch/conflicts/...`, and
 * the editor's cards and "Use latest version". The merge keys the item the base edited as the
 * base's version reads, so only each version's own path (`sidePaths`) finds the branch's value in
 * the version the branch stored.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { SimpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defineCanopyTestConfig } from '../config-test'
import { flattenSchema, type FieldConfig, type RootCollectionConfig } from '../config'
import { SCHEMA_CACHE_VERSION } from '../branch-schema-cache'
import { createCheckBranchAccess } from '../authorization'
import { createTestContentAccess } from '../authorization/test-utils'
import { buildEntryConflicts } from '../editor/conflict-cards'
import { withLatest } from '../editor/conflict-choices'
import { GitManager } from '../git-manager'
import { itemKeysAsRead } from '../item-keys'
import { MergeConflictStore, withFoundConflicts } from '../merge-conflicts'
import { unsafeAsBranchName, unsafeAsLogicalPath } from '../paths/test-utils'
import { createMockApiContext, createMockBranchContext, initTestRepo } from '../test-utils'
import { entryAsRead } from '../utils/calendar-day'
import { planMerge } from '../worker/branch-merge'
import { MERGE_CONFLICT_ROUTES } from './merge-conflicts'

const fields: FieldConfig[] = [
  { name: 'title', type: 'string', isTitle: true },
  {
    name: 'items',
    type: 'object',
    list: true,
    fields: [
      { name: 'title', type: 'string' },
      { name: 'detail', type: 'string' },
    ],
  },
]
const schema: RootCollectionConfig = {
  collections: [
    { name: 'pages', path: 'pages', entries: [{ name: 'page', format: 'json', schema: fields }] },
  ],
}
const ID = 'zY9xW8vU7tS6'
const FILE = `content/pages.q52DCVPuH4ga/page.home.${ID}.json`
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

const ancestorItem = { title: 'Started', detail: 'd' }
const ancestor = { title: 'Home', items: [ancestorItem] }
// The base edits the item and leaves its list keyless; the branch's first save keyed it.
const base = { title: 'Home', items: [{ title: 'Latest', detail: 'd' }] }
const branchData = {
  title: 'Home',
  items: [{ title: 'Mine', detail: 'd', _key: itemKeysAsRead([ancestorItem])[0] }],
}

let tmpDir: string
let clonePath: string
let git: SimpleGit

const commit = async (data: unknown, message: string) => {
  await fs.mkdir(path.dirname(path.join(clonePath, FILE)), { recursive: true })
  await fs.writeFile(path.join(clonePath, FILE), json(data))
  await git.raw(['add', '--', FILE])
  await git.raw(['commit', '-q', '-m', message])
  return (await git.raw(['rev-parse', 'HEAD'])).trim()
}

beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-keyless-')))
  clonePath = path.join(tmpDir, 'clone')
  await fs.mkdir(clonePath)
  git = await initTestRepo(clonePath)
  await git.raw(['checkout', '-q', '-b', 'main'])
  await commit(ancestor, 'ancestor')
  await git.raw(['checkout', '-q', '-b', 'feature'])
  await commit(branchData, 'branch')
  await git.raw(['checkout', '-q', 'main'])
  await commit(base, 'base')
  await git.raw(['checkout', '-q', 'feature'])
  const snapshot = path.join(clonePath, '.git', 'canopycms')
  await fs.mkdir(snapshot, { recursive: true })
  await fs.writeFile(
    path.join(snapshot, 'schema-cache.json'),
    JSON.stringify({ version: SCHEMA_CACHE_VERSION, flatSchema: flattenSchema(schema, 'content') }),
  )
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const createCtx = () => {
  const config = defineCanopyTestConfig({ defaultBranchAccess: 'allow', schema })
  const checkBranchAccess = createCheckBranchAccess('allow')
  const access = createTestContentAccess({
    checkBranchAccess,
    loadPathPermissions: vi.fn().mockResolvedValue([]),
    defaultPathAccess: 'allow',
    mode: 'dev',
    getSettingsBranchRoot: () => Promise.resolve(clonePath),
  })
  const branchContext = createMockBranchContext({
    branchName: 'feature',
    baseRoot: tmpDir,
    branchRoot: clonePath,
  })
  return createMockApiContext({
    services: {
      config,
      checkBranchAccess,
      ...access,
      createGitManagerFor: (repoPath) =>
        new GitManager({ repoPath, baseBranch: 'main', remote: 'origin' }),
    },
    branchContext: { ...branchContext, flatSchema: flattenSchema(schema, config.contentRoot) },
  })
}

/** The worker's merge of `feature` with `main`, its conflicts on record, and the API's answer. */
const mergeAndRead = async () => {
  const head = (await git.raw(['rev-parse', 'feature'])).trim()
  const other = (await git.raw(['rev-parse', 'main'])).trim()
  const plan = await planMerge(git, clonePath, {
    head,
    other,
    contentRoot: 'content',
    timeoutMs: 30_000,
  })
  if (plan.kind !== 'planned') throw new Error(`expected a merge, got ${plan.kind}`)
  // The merge commit, as the worker makes it from the plan: `head` first, then the base.
  const mergeSha = (
    await git.raw([
      'commit-tree',
      '-p',
      head,
      '-p',
      other,
      '-m',
      'merge',
      '--end-of-options',
      plan.tree,
    ])
  ).trim()
  await new MergeConflictStore(clonePath, 0).update(() => ({
    entries: withFoundConflicts({}, plan.conflicts, mergeSha),
  }))
  const res = await MERGE_CONFLICT_ROUTES.entry.handler(
    createCtx(),
    { user: { type: 'authenticated', userId: 'u1', groups: [] } },
    { branch: unsafeAsBranchName('feature'), entryPath: unsafeAsLogicalPath('content/pages/home') },
  )
  expect(res).toMatchObject({ ok: true, status: 200 })
  const merged = JSON.parse(await git.raw(['show', `${mergeSha}:${FILE}`])) as typeof branchData
  return { data: res.data!, merged }
}

describe('a conflict in a list the base left keyless', () => {
  it('shows a re-keyed item’s versions on its card, and places the latest under its new key', async () => {
    const { data, merged } = await mergeAndRead()
    // The merge keys the item as the base's version reads, so the next sync's ancestor knows it.
    const baseKey = itemKeysAsRead([base.items[0]])[0]
    expect(merged.items[0]._key).toBe(baseKey)
    const [field] = data.fields
    expect(field.dataPath).toEqual([{ field: 'items' }, { item: baseKey }, { field: 'title' }])
    expect(field.sidePaths.branch).toEqual([
      { field: 'items' },
      { item: branchData.items[0]._key },
      { field: 'title' },
    ])
    const saved = entryAsRead(fields, merged)
    const { fields: cards } = buildEntryConflicts(data, fields, undefined, undefined, saved)
    expect(cards[0].latestPlaceable).toBe(true)
    expect(cards[0].cards[0]).toMatchObject({
      type: 'value',
      before: { kind: 'text', text: 'Started' },
      latest: { kind: 'text', text: 'Latest' },
      yours: { kind: 'text', text: 'Mine' },
    })
    const placed = withLatest(saved, cards[0], undefined)
    expect((placed?.items as Array<Record<string, unknown>>)[0]).toMatchObject({
      title: 'Latest',
      _key: baseKey,
    })
  })
})
