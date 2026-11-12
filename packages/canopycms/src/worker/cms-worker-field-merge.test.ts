/**
 * The field merge in the worker's rebase loop, against real git repositories: a bare `remote.git`
 * fed from an upstream working repository (the base branch), and a branch clone. Each case is a
 * row of the field-merge plan's conflict-case table at the worker layer (W), named by its number.
 *
 * Rows: 1, 4, 6, 7, 9, 14, 17, 18, 23, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41.
 * Tests that name no row cover what review found beyond the table. Row 42 (a branch in review
 * merging when nothing clashes) ships separately: here a branch in review takes the base in only as
 * git's own merge with nothing to decide (cms-worker-github-commits.test.ts).
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { simpleGit, type SimpleGit } from 'simple-git'

import { BranchMetadataFileManager } from '../branch-metadata'
import { SCHEMA_CACHE_VERSION } from '../branch-schema-cache'
import type { FieldConfig } from '../config'
import type { FlatSchemaItem } from '../config/types'
import { parseEntryParts } from '../content-listing'
import { itemKeysAsRead } from '../item-keys'
import { MergeConflictStore, type MergeConflictsFile } from '../merge-conflicts'
import { unsafeAsLogicalPath } from '../paths/test-utils'
import { initTestRepo, mockConsole } from '../test-utils'
import { CmsWorker } from './cms-worker'

const compromiseHook = vi.hoisted(() => ({ fire: undefined as ((err: Error) => void) | undefined }))

// Captures the content-write lock's `onCompromised`, so a test can lose the lock at a chosen
// instant; see cms-worker-content-lock.test.ts.
vi.mock('../utils/content-write-lock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/content-write-lock')>()
  return {
    ...actual,
    tryAcquireContentWriteLock: (branchRoot: string, onCompromised?: (err: Error) => void) => {
      if (onCompromised) compromiseHook.fire = onCompromised
      return actual.tryAcquireContentWriteLock(branchRoot, onCompromised)
    },
  }
})

const BRANCH = 'my-feature'
const DIR = 'content/pages.cNbR5xFm2Kpd'
const COLLECTION_ID = 'cNbR5xFm2Kpd'
const entry = (type: string, slug: string, id: string, ext: string) =>
  `${DIR}/${type}.${slug}.${id}.${ext}`

type Item = Record<string, string>
const readKey = (item: Item): string => itemKeysAsRead([item])[0]!

interface Summary {
  rebased: string[]
  skippedDirty: string[]
  skippedLocked: string[]
  failed: { branch: string; error: string }[]
}

interface Repo {
  clonePath: string
  git: SimpleGit
  /** Commit `files` to the base branch and publish it; null deletes. Resolves the commit. */
  base(files: Record<string, string | null>): Promise<string>
  /** Commit `files` on the branch clone; null deletes. */
  branch(files: Record<string, string | null>): Promise<string>
  /** Push the clone's branch to `remote.git`, as a submit does. */
  publish(): Promise<void>
  remoteSha(): Promise<string | null>
  /** Point `remote.git`'s branch at a new commit the clone has never fetched. Resolves it. */
  forgeRemoteHead(): Promise<string>
  /** Replace the base branch with a commit that shares no history with the branch. */
  orphanBase(files: Record<string, string>): Promise<void>
  status(status: 'editing' | 'submitted'): Promise<void>
  /**
   * Publish to `remote.git` a merge of the base into the branch that the clone never moved to, as a
   * crash between the two leaves it. Resolves the merge.
   */
  publishMergeOnly(): Promise<string>
  cycle(worker?: CmsWorker): Promise<Summary>
  file(name: string): Promise<string | null>
  record(): Promise<MergeConflictsFile | null>
  parents(): Promise<number>
  blob(commit: string, name: string): Promise<string>
  schema(items: FlatSchemaItem[]): Promise<void>
}

const makeWorker = (tmpDir: string) =>
  new CmsWorker({
    workspacePath: tmpDir,
    githubOwner: 'test-owner',
    githubRepo: 'test-repo',
    githubToken: 'fake-token',
    baseBranch: 'main',
  })

async function writeFiles(root: string, files: Record<string, string | null>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name)
    if (content === null) {
      await fs.rm(full, { force: true })
      continue
    }
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content)
  }
}

async function createRepo(tmpDir: string, initial: Record<string, string>): Promise<Repo> {
  const remotePath = path.join(tmpDir, 'remote.git')
  const upstreamPath = path.join(tmpDir, 'upstream')
  const contentBranches = path.join(tmpDir, 'content-branches')
  const clonePath = path.join(contentBranches, BRANCH)

  await fs.mkdir(upstreamPath)
  const upstream = await initTestRepo(upstreamPath)
  await upstream.raw(['branch', '-M', 'main'])
  await simpleGit().raw(['init', '--bare', '--initial-branch', 'main', remotePath])
  const publishBase = () => upstream.raw(['push', '-q', '--force', remotePath, 'main:main'])
  await writeFiles(upstreamPath, { '.gitkeep': '', ...initial })
  await upstream.raw(['add', '-A'])
  await upstream.commit('initial commit')
  await publishBase()

  await fs.mkdir(contentBranches, { recursive: true })
  await simpleGit().clone(remotePath, clonePath)
  const git = simpleGit({ baseDir: clonePath, unsafe: { allowUnsafeEditor: true } })
  await git.addConfig('user.name', 'Test Bot')
  await git.addConfig('user.email', 'test@canopycms.test')
  await fs.appendFile(path.join(clonePath, '.git', 'info', 'exclude'), '\n.canopy-meta/\n')
  await git.checkoutBranch(BRANCH, 'origin/main')
  await BranchMetadataFileManager.get(clonePath, contentBranches).save({
    branch: { name: BRANCH, status: 'editing', access: {}, createdBy: 'test' },
  })

  const sha = async (repo: SimpleGit) => (await repo.revparse(['HEAD'])).trim()
  const repo: Repo = {
    clonePath,
    git,
    async base(files) {
      await writeFiles(upstreamPath, files)
      await upstream.raw(['add', '-A'])
      await upstream.commit('base commit')
      await publishBase()
      return sha(upstream)
    },
    async branch(files) {
      await writeFiles(clonePath, files)
      await git.raw(['add', '-A'])
      await git.commit('branch commit')
      return sha(git)
    },
    async publish() {
      await git.raw(['push', '-q', remotePath, `${BRANCH}:refs/heads/${BRANCH}`])
    },
    async forgeRemoteHead() {
      const tree = (await upstream.raw(['rev-parse', 'HEAD^{tree}'])).trim()
      const forged = (
        await upstream.raw(['commit-tree', tree, '-p', 'HEAD', '-m', 'forged'])
      ).trim()
      await upstream.raw(['push', '-q', '--force', remotePath, `${forged}:refs/heads/${BRANCH}`])
      return forged
    },
    async orphanBase(files) {
      await upstream.raw(['checkout', '-q', '--orphan', 'unrelated'])
      await upstream.raw(['rm', '-rq', '--cached', '.'])
      await writeFiles(upstreamPath, files)
      await upstream.raw(['add', '-A'])
      await upstream.commit('unrelated base')
      await upstream.raw(['push', '-q', '--force', remotePath, 'unrelated:main'])
    },
    async publishMergeOnly() {
      await git.raw(['fetch', '-q', remotePath, 'main'])
      const base = (await git.raw(['rev-parse', 'FETCH_HEAD'])).trim()
      const tree = (await git.raw(['rev-parse', 'HEAD^{tree}'])).trim()
      const merge = (
        await git.raw(['commit-tree', tree, '-p', 'HEAD', '-p', base, '-m', 'merge'])
      ).trim()
      await git.raw(['push', '-q', '--force', remotePath, `${merge}:refs/heads/${BRANCH}`])
      return merge
    },
    async status(status) {
      await BranchMetadataFileManager.get(clonePath, contentBranches).save({ branch: { status } })
    },
    async remoteSha() {
      const out = await simpleGit()
        .raw(['--git-dir', remotePath, 'rev-parse', '--verify', '-q', `refs/heads/${BRANCH}`])
        .catch(() => '')
      return out.trim() || null
    },
    async cycle(worker = makeWorker(tmpDir)) {
      return (
        worker as unknown as { rebaseActiveBranches(): Promise<Summary> }
      ).rebaseActiveBranches()
    },
    async file(name) {
      return fs.readFile(path.join(clonePath, name), 'utf8').catch(() => null)
    },
    record: () => new MergeConflictStore(clonePath).read(),
    async parents() {
      return (
        (await git.raw(['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ').length - 1
      )
    },
    async blob(commit, name) {
      return (await git.raw(['rev-parse', `${commit}:${name}`])).trim()
    },
    async schema(items) {
      const dir = path.join(clonePath, '.git', 'canopycms')
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(
        path.join(dir, 'schema-cache.json'),
        JSON.stringify({ version: SCHEMA_CACHE_VERSION, flatSchema: items }),
      )
    },
  }
  return repo
}

/** No file under the clone's content root holds a git conflict marker. */
async function expectNoMarkers(repo: Repo): Promise<void> {
  const files = await fs.readdir(path.join(repo.clonePath, 'content'), { recursive: true })
  for (const name of files) {
    const full = path.join(repo.clonePath, 'content', name)
    if (!(await fs.stat(full)).isFile()) continue
    expect(await fs.readFile(full, 'utf8')).not.toMatch(/^(<{7}|={7}|>{7})/m)
  }
}

const parse = (text: string | null, format: 'md' | 'mdx' | 'json' | 'yaml') => {
  if (text === null) throw new Error('no file')
  return parseEntryParts(text, format)
}

const entryType = (
  name: string,
  format: 'md' | 'json' | 'yaml',
  schema: FieldConfig[],
): FlatSchemaItem => ({
  type: 'entry-type',
  logicalPath: unsafeAsLogicalPath(`content/pages/${name}`),
  name,
  parentPath: unsafeAsLogicalPath('content/pages'),
  format,
  schema,
})

const strings = (...names: string[]): FieldConfig[] =>
  names.map((name) => ({ name, type: 'string' }))

const yamlList = (name: string, items: Item[], keys: boolean): string =>
  `${name}:\n` +
  items
    .map((item) => {
      const lines = Object.entries(item).map(
        ([k, v], i) => `${i === 0 ? '  - ' : '    '}${k}: ${v}`,
      )
      if (keys) lines.push(`    _key: ${readKey(item)}`)
      return lines.join('\n')
    })
    .join('\n') +
  '\n'

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

/** The conflicts on record, none when there is no record. */
const openConflicts = async (repo: Repo) => (await repo.record())?.entries ?? {}

const loseLock = () => compromiseHook.fire?.(new Error('simulated lock takeover'))

/** Run `then` once, right after the first write of merge-conflicts.json that writes anything. */
const afterFirstRecordWrite = (then: () => void) => {
  const update = MergeConflictStore.prototype.update
  let done = false
  return vi.spyOn(MergeConflictStore.prototype, 'update').mockImplementation(async function (
    this: MergeConflictStore,
    change,
  ) {
    const written = await update.call(this, change)
    if (!done && written !== null) {
      done = true
      then()
    }
    return written
  })
}

describe('the field merge in the rebase loop', () => {
  let tmpDir: string

  beforeEach(async () => {
    mockConsole()
    compromiseHook.fire = undefined
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-field-merge-'))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  // --- Which way the base comes in -------------------------------------------------------------

  it('row 39: a branch with nothing to decide still rebases, with no merge commit', async () => {
    const FILE = entry('page', 'home', 'aboutAbc1234', 'json')
    const repo = await createRepo(tmpDir, { [FILE]: json({ title: 'Home' }) })
    await repo.branch({ [FILE]: json({ title: 'Welcome home' }) })
    await repo.base({ 'content/other.txt': 'from the base\n' })

    const summary = await repo.cycle()

    expect(summary.rebased).toEqual([BRANCH])
    expect(await repo.parents()).toBe(1)
    expect(await repo.file('content/other.txt')).toBe('from the base\n')
    expect(await openConflicts(repo)).toEqual({})
  })

  it('row 1: disjoint fields git conflicts on merge, and publish as a fast-forward', async () => {
    const FILE = entry('page', 'home', 'aboutAbc1234', 'md')
    const repo = await createRepo(tmpDir, {
      [FILE]: '---\ntitle: Home\ndescription: The start.\n---\nHello.\n',
    })
    await repo.branch({ [FILE]: '---\ntitle: Home\ndescription: Where it begins.\n---\nHello.\n' })
    await repo.publish()
    const published = await repo.remoteSha()
    await repo.base({ [FILE]: '---\ntitle: Welcome\ndescription: The start.\n---\nHello.\n' })

    const summary = await repo.cycle()

    expect(summary.rebased).toEqual([BRANCH])
    expect(parse(await repo.file(FILE), 'md').data).toEqual({
      title: 'Welcome',
      description: 'Where it begins.',
    })
    expect(await repo.parents()).toBe(2)
    expect(await openConflicts(repo)).toEqual({})
    await expectNoMarkers(repo)
    // Published as a plain push on top of what remote.git held: no rewrite to carry forward.
    const head = (await repo.git.revparse(['HEAD'])).trim()
    expect(await repo.remoteSha()).toBe(head)
    expect((await repo.git.raw(['rev-parse', 'HEAD^1'])).trim()).toBe(published)
    const meta = await BranchMetadataFileManager.loadOnly(repo.clonePath)
    expect(meta?.branch.historyRewrittenFrom).toBeUndefined()
  })

  it('falls back to a merge when one replayed commit conflicts though the whole merge does not', async () => {
    const FILE = entry('page', 'home', 'aboutAbc1234', 'json')
    const repo = await createRepo(tmpDir, { [FILE]: json({ title: 'Home' }) })
    await repo.branch({ [FILE]: json({ title: 'A draft' }) })
    await repo.branch({ [FILE]: json({ title: 'Welcome' }) })
    await repo.base({ [FILE]: json({ title: 'Welcome' }) })
    const consoleSpy = mockConsole()

    const summary = await repo.cycle()

    expect(summary.rebased).toEqual([BRANCH])
    expect(consoleSpy).toHaveLogged(/a replayed commit conflicts/)
    expect(await repo.parents()).toBe(2)
    expect(JSON.parse((await repo.file(FILE)) ?? '')).toEqual({ title: 'Welcome' })
    expect(await openConflicts(repo)).toEqual({})
  })

  it('row 38: git merges cleanly but wrongly, a duplicate frontmatter key, and the field merge wins', async () => {
    const FILE = entry('page', 'home', 'aboutAbc1234', 'md')
    const head = 'title: Home\na: 1\nb: 2\nc: 3\nd: 4\ne: 5\n'
    const repo = await createRepo(tmpDir, { [FILE]: `---\n${head}---\nHello.\n` })
    await repo.branch({ [FILE]: `---\n${head}summary: Short.\n---\nHello.\n` })
    await repo.base({
      [FILE]: `---\ntitle: Home\nsummary: Short.\na: 1\nb: 2\nc: 3\nd: 4\ne: 5\n---\nHello.\n`,
    })

    const summary = await repo.cycle()

    expect(summary.rebased).toEqual([BRANCH])
    const text = (await repo.file(FILE)) ?? ''
    expect(text.match(/^summary:/gm)).toHaveLength(1)
    expect(parse(text, 'md').data).toMatchObject({ title: 'Home', summary: 'Short.', e: 5 })
    expect(await repo.parents()).toBe(2)
    expect(await openConflicts(repo)).toEqual({})
  })

  // --- Values ----------------------------------------------------------------------------------

  it("row 4: the same field changed on both sides is a conflict on record, the author's value in the tree", async () => {
    const ID = 'aboutAbc1234'
    const FILE = entry('page', 'home', ID, 'json')
    const repo = await createRepo(tmpDir, { [FILE]: json({ title: 'Home', cta: 'Go' }) })
    const ancestor = (await repo.git.revparse(['HEAD'])).trim()
    const branchSha = await repo.branch({ [FILE]: json({ title: 'Our home', cta: 'Go' }) })
    const baseSha = await repo.base({ [FILE]: json({ title: 'Welcome', cta: 'Go' }) })

    await repo.cycle()

    expect(JSON.parse((await repo.file(FILE)) ?? '')).toEqual({ title: 'Our home', cta: 'Go' })
    const head = (await repo.git.revparse(['HEAD'])).trim()
    const sides = {
      ancestor: await repo.blob(ancestor, FILE),
      base: await repo.blob(baseSha, FILE),
      branch: await repo.blob(branchSha, FILE),
    }
    expect((await repo.record())?.entries).toEqual({
      [ID]: {
        path: FILE,
        mergeSha: head,
        kind: 'fields',
        sides,
        fields: [
          {
            key: '?title',
            dataPath: [{ field: 'title' }],
            sidePaths: {
              ancestor: [{ field: 'title' }],
              base: [{ field: 'title' }],
              branch: [{ field: 'title' }],
            },
            kind: 'changed',
            mergeSha: head,
            sides,
          },
        ],
      },
    })
    const meta = await BranchMetadataFileManager.loadOnly(repo.clonePath)
    expect(meta?.branch.conflictFiles).toEqual([ID])
    expect(meta?.branch.conflictStatus).toBe('conflicts-detected')
    await expectNoMarkers(repo)
  })

  it('names conflicts as the "Show changes" drawer does, from the branch\'s schema snapshot', async () => {
    const ID = 'priceAbc1234'
    const FILE = entry('pricing', 'plans', ID, 'json')
    const repo = await createRepo(tmpDir, {
      [FILE]: json({ hero: { heading: 'Simple', sub: 'Pick.' } }),
    })
    await repo.schema([
      entryType('pricing', 'json', [
        { name: 'hero', type: 'object', fields: strings('heading', 'sub') },
      ]),
    ])
    await repo.branch({ [FILE]: json({ hero: { heading: 'For teams', sub: 'Pick.' } }) })
    await repo.base({ [FILE]: json({ hero: { heading: 'Scales', sub: 'Pick.' } }) })

    await repo.cycle()

    const fields = (await repo.record())?.entries[ID]?.fields
    expect(fields?.map(({ key, dataPath }) => ({ key, dataPath }))).toEqual([
      { key: 'hero.heading', dataPath: [{ field: 'hero' }, { field: 'heading' }] },
    ])
  })

  it('row 14: an item removed on one side and edited on the other is an item conflict, both ways', async () => {
    const [ONE, TWO] = ['aboutAbc1234', 'priceAbc1234']
    const [F1, F2] = [entry('page', 'one', ONE, 'json'), entry('page', 'two', TWO, 'json')]
    const items = [
      { _key: 'k1', text: 'first' },
      { _key: 'k2', text: 'second' },
      { _key: 'k3', text: 'third' },
    ]
    const edited = items.map((i) => (i._key === 'k2' ? { ...i, text: 'second, edited' } : i))
    const removed = items.filter((i) => i._key !== 'k2')
    const repo = await createRepo(tmpDir, { [F1]: json({ items }), [F2]: json({ items }) })
    // The schema makes the list's items places the drawer names, rather than one whole value.
    await repo.schema([
      entryType('page', 'json', [
        { name: 'items', type: 'object', list: true, fields: strings('text') },
      ]),
    ])
    await repo.branch({ [F1]: json({ items: edited }), [F2]: json({ items: removed }) })
    await repo.base({ [F1]: json({ items: removed }), [F2]: json({ items: edited }) })

    await repo.cycle()

    const entries = (await repo.record())?.entries ?? {}
    expect(entries[ONE]?.fields?.map(({ key, kind, item }) => ({ key, kind, item }))).toEqual([
      { key: 'items.k2', kind: 'removed-on-base', item: true },
    ])
    expect(entries[TWO]?.fields?.map(({ key, kind, item }) => ({ key, kind, item }))).toEqual([
      { key: 'items.k2', kind: 'removed-by-you', item: true },
    ])
    // The branch's state holds: its edit in one, its removal in the other.
    expect(JSON.parse((await repo.file(F1)) ?? '').items).toEqual(edited)
    expect(JSON.parse((await repo.file(F2)) ?? '').items).toEqual(removed)
  })

  it('row 23: body paragraphs each side changed merge; the same lines are a region conflict', async () => {
    const [ONE, TWO] = ['aboutAbc1234', 'priceAbc1234']
    const [F1, F2] = [entry('page', 'one', ONE, 'md'), entry('page', 'two', TWO, 'md')]
    const doc = (p1: string, p2: string, p3: string) =>
      `---\ntitle: T\n---\n${p1}\n\n${p2}\n\n${p3}\n`
    const repo = await createRepo(tmpDir, {
      [F1]: doc('One.', 'Two.', 'Three.'),
      [F2]: doc('One.', 'Two.', 'Three.'),
    })
    await repo.branch({
      [F1]: doc('One.', 'Two.', 'Three, by the author.'),
      [F2]: doc('One.', 'Two, by the author.', 'Three.'),
    })
    await repo.base({
      [F1]: doc('One, from the base.', 'Two.', 'Three.'),
      [F2]: doc('One.', 'Two, from the base.', 'Three.'),
    })

    await repo.cycle()

    expect(parse(await repo.file(F1), 'md').body).toBe(
      'One, from the base.\n\nTwo.\n\nThree, by the author.\n',
    )
    expect(parse(await repo.file(F2), 'md').body).toBe('One.\n\nTwo, by the author.\n\nThree.\n')
    const entries = (await repo.record())?.entries ?? {}
    expect(entries[ONE]).toBeUndefined()
    expect(entries[TWO]?.fields?.map(({ key, text }) => ({ key, text }))).toEqual([
      { key: '?body', text: true },
    ])
    await expectNoMarkers(repo)
  })

  // --- The acceptance fixtures -----------------------------------------------------------------

  const steps: Item[] = [
    ['Install the tool', 'Run the installer for your system.'],
    ['Create a project', 'Pick a folder and start a new project.'],
    ['Add a page', 'Pages live in the content folder.'],
    ['Preview it', 'Open the preview to see your page.'],
    ['Invite a colleague', 'Share access with one more person.'],
    ['Publish', 'Submit the branch for review.'],
    ['Celebrate', 'You shipped your first page.'],
  ].map(([title, detail]) => ({ title, icon: 'dot', level: 'basic', detail }))
  const reworded = steps.map((s, i) => ({
    ...s,
    detail: `${s.detail.slice(0, -1)}, reworded ${i}.`,
  }))
  const guide = (items: Item[], keys: boolean, extra = '') =>
    `---\ntitle: Getting started\n${extra}${yamlList('steps', items, keys)}---\nWelcome.\n`
  const GUIDE = 'gUideAbc1234'
  const GUIDE_FILE = entry('page', 'guide', GUIDE, 'md')

  it('row 17, fixture 1: keys a first save wrote beside items the base reworded merge with no conflict', async () => {
    const repo = await createRepo(tmpDir, { [GUIDE_FILE]: guide(steps, false) })
    await repo.branch({ [GUIDE_FILE]: guide(steps, true, 'summary: Short.\n') })
    await repo.base({ [GUIDE_FILE]: guide(reworded, false) })

    await repo.cycle()

    expect(parse(await repo.file(GUIDE_FILE), 'md').data).toEqual({
      title: 'Getting started',
      summary: 'Short.',
      steps: reworded.map((s, i) => ({ ...s, _key: readKey(steps[i]) })),
    })
    expect(await openConflicts(repo)).toEqual({})
  })

  it("row 18, fixture 4: a base keyed after rewording gives its keys, and the branch's threads follow", async () => {
    const repo = await createRepo(tmpDir, { [GUIDE_FILE]: guide(steps, false) })
    await repo.branch({ [GUIDE_FILE]: guide(steps, true, 'summary: Short.\n') })
    await repo.base({ [GUIDE_FILE]: guide(reworded, true) })
    const thread = (id: string, key: string) => ({
      id,
      comments: [],
      resolved: false,
      createdAt: '2026-11-01T00:00:00.000Z',
      type: 'field',
      authorId: 'u1',
      entryPath: 'content/pages/guide',
      canopyPath: 'steps[2].detail',
      itemKeys: [key],
    })
    await fs.mkdir(path.join(repo.clonePath, '.canopy-meta'), { recursive: true })
    await fs.writeFile(
      path.join(repo.clonePath, '.canopy-meta', 'comments.json'),
      JSON.stringify({
        schemaVersion: 1,
        version: 1,
        threads: { t1: thread('t1', readKey(steps[2])), t2: thread('t2', 'unrelated') },
      }),
    )

    await repo.cycle()

    expect(parse(await repo.file(GUIDE_FILE), 'md').data.steps).toEqual(
      reworded.map((s) => ({ ...s, _key: readKey(s) })),
    )
    // Nothing to choose, and the remap applied once the clone held the merge.
    expect(await repo.record()).toMatchObject({ entries: {}, remaps: [] })
    const comments = JSON.parse(
      await fs.readFile(path.join(repo.clonePath, '.canopy-meta', 'comments.json'), 'utf8'),
    ) as { threads: Record<string, { itemKeys: string[] }> }
    expect(comments.threads.t1.itemKeys).toEqual([readKey(reworded[2])])
    expect(comments.threads.t2.itemKeys).toEqual(['unrelated'])
  })

  it('row 27, fixture 2: four entries in md, json, md and yaml, and exactly two conflicts', async () => {
    const [ABOUT, PRICING, NOTES, FOOTER] = [
      'aboutAbc1234',
      'priceAbc1234',
      'notesAbc1234',
      'footrAbc1234',
    ]
    const files = {
      about: entry('about', 'us', ABOUT, 'md'),
      pricing: entry('pricing', 'plans', PRICING, 'json'),
      notes: entry('post', 'release', NOTES, 'md'),
      footer: entry('footer', 'site', FOOTER, 'yaml'),
    }
    const team: Item[] = [
      { name: 'Ada', role: 'Engineer' },
      { name: 'Grace', role: 'Designer' },
    ]
    const about = (title: string, description: string, list: Item[], keys: boolean, p: string) =>
      `---\ntitle: ${title}\ndescription: ${description}\n${yamlList('team', list, keys)}---\nWe build tools.\n\nStarted small.\n\n${p}\n`
    const plans: Item[] = [
      { name: 'Starter', price: '0' },
      { name: 'Team', price: '12' },
    ]
    const pricing = (heading: string, cta: string, list: Item[], keys: boolean) =>
      json({
        hero: { heading, sub: 'Pick a plan.' },
        cta,
        plans: list.map((p) => (keys ? { ...p, _key: readKey(p) } : p)),
      })
    const notes = (summary: string, tags: string[], date: string, p2: string) =>
      `---\ntitle: Release notes\nsummary: ${summary}\n${date}tags:\n${tags.map((t) => `  - ${t}`).join('\n')}\n---\nThree changes.\n\n${p2}\n\nThanks.\n`
    const links: Item[] = [
      { href: '/', label: 'Home' },
      { href: '/docs', label: 'Docs' },
    ]
    const footer = (list: Item[], keys: boolean) =>
      `copyright: 2026 Example Co\n${yamlList('links', list, keys)}`

    const repo = await createRepo(tmpDir, {
      [files.about]: about('About us', 'Who we are.', team, false, 'We are twelve.'),
      [files.pricing]: pricing('Simple pricing', 'Start free', plans, false),
      [files.notes]: notes('What changed.', ['release'], '', 'Saving is faster.'),
      [files.footer]: footer(links, false),
    })
    await repo.schema([
      entryType('pricing', 'json', [
        { name: 'hero', type: 'object', fields: strings('heading', 'sub') },
        { name: 'cta', type: 'string' },
        { name: 'plans', type: 'object', list: true, fields: strings('name', 'price') },
      ]),
      entryType('post', 'md', [
        ...strings('title', 'summary'),
        { name: 'date', type: 'date' },
        { name: 'tags', type: 'string', list: true },
        { name: 'body', type: 'markdown', isBody: true },
      ]),
    ])
    const teamBase = team.map((m) => ({ ...m, role: `${m.role} lead` }))
    const basePlans = plans.map((p, i) => (i === 1 ? { ...p, price: '15' } : p))
    const linksBase = links.map((l) => ({ ...l, label: `${l.label} page` }))
    await repo.branch({
      [files.about]: about(
        'About us',
        'Who we are and what we make.',
        team,
        true,
        'We are fourteen.',
      ),
      [files.pricing]: pricing('Plans for every team', 'Try it free', plans, true),
      [files.notes]: notes(
        'A month of fixes.',
        ['release'],
        'date: 2026-11-01\n',
        'Saving is faster and safer.',
      ),
      [files.footer]: footer(links, true),
    })
    await repo.base({
      [files.about]: about('About the team', 'Who we are.', teamBase, false, 'We are twelve.'),
      [files.pricing]: pricing('Pricing that scales', 'Start free', basePlans, false),
      [files.notes]: notes('Everything new.', ['release', 'product'], '', 'Saving is faster.'),
      [files.footer]: footer(linksBase, false),
    })

    await repo.cycle()

    const entries = (await repo.record())?.entries ?? {}
    expect(
      Object.fromEntries(
        Object.entries(entries).map(([id, e]) => [id, e.fields?.map((f) => f.key)]),
      ),
    ).toEqual({ [PRICING]: ['hero.heading'], [NOTES]: ['summary'] })
    const meta = await BranchMetadataFileManager.loadOnly(repo.clonePath)
    expect(meta?.branch.conflictFiles).toEqual([NOTES, PRICING].sort())

    const aboutMerged = parse(await repo.file(files.about), 'md')
    expect(aboutMerged.data).toEqual({
      title: 'About the team',
      description: 'Who we are and what we make.',
      team: teamBase.map((m, i) => ({ ...m, _key: readKey(team[i]) })),
    })
    expect(aboutMerged.body).toBe('We build tools.\n\nStarted small.\n\nWe are fourteen.\n')
    expect(JSON.parse((await repo.file(files.pricing)) ?? '')).toEqual({
      hero: { heading: 'Plans for every team', sub: 'Pick a plan.' },
      cta: 'Try it free',
      plans: basePlans.map((p, i) => ({ ...p, _key: readKey(plans[i]) })),
    })
    const notesMerged = parse(await repo.file(files.notes), 'md')
    expect(notesMerged.data).toEqual({
      title: 'Release notes',
      summary: 'A month of fixes.',
      date: new Date('2026-11-01T00:00:00.000Z'),
      tags: ['release', 'product'],
    })
    expect(notesMerged.body).toBe('Three changes.\n\nSaving is faster and safer.\n\nThanks.\n')
    expect(parse(await repo.file(files.footer), 'yaml').data).toEqual({
      copyright: '2026 Example Co',
      links: linksBase.map((l, i) => ({ ...l, _key: readKey(links[i]) })),
    })
    await expectNoMarkers(repo)
  })

  it('rows 6, 7, 9 and 28, fixture 3: a schema migration on the base survives, one conflict', async () => {
    const ID = 'artcxAbc1234'
    const FILE = entry('article', 'field-notes', ID, 'md')
    const article = (frontmatter: string, p2: string) =>
      `---\n${frontmatter}---\nNotes from the field.\n\n${p2}\n\nMore next month.\n`
    const reviewers =
      'reviewers:\n  - name: Sam Rivera\n    role: author\n  - name: Kai Moreno\n    role: reviewer\n'
    const repo = await createRepo(tmpDir, {
      [FILE]: article(
        'title: Field notes\nauthor: Sam Rivera\nreviewer: Kai Moreno\nreadTime: 4\ntags:\n  - notes\n',
        'We visited three sites.',
      ),
    })
    await repo.branch({
      [FILE]: article(
        'title: Field notes from the coast\nauthor: Sam Rivera\nreviewer: Kai Moreno\nreadTime: 6\ntags:\n  - notes\n',
        'We visited three coastal sites.',
      ),
    })
    await repo.base({
      [FILE]: article(
        `title: Field notes\ntags:\n  - notes\n${reviewers}`,
        'We visited three sites.',
      ),
    })

    await repo.cycle()

    const text = (await repo.file(FILE)) ?? ''
    const merged = parse(text, 'md')
    // Row 6: the keys the base removed and the branch left alone are gone.
    expect(merged.data).not.toHaveProperty('author')
    expect(merged.data).not.toHaveProperty('reviewer')
    expect(merged.data).toEqual({
      title: 'Field notes from the coast',
      readTime: 6,
      tags: ['notes'],
      reviewers: [
        { name: 'Sam Rivera', role: 'author' },
        { name: 'Kai Moreno', role: 'reviewer' },
      ],
    })
    // Row 9: the list the base added is there byte for byte, with no keys minted in it.
    expect(text).toContain(reviewers)
    expect(merged.body).toBe(
      'Notes from the field.\n\nWe visited three coastal sites.\n\nMore next month.\n',
    )
    // Row 7: readTime, removed on the base and changed on the branch, is the one conflict.
    expect(
      (await repo.record())?.entries[ID]?.fields?.map(({ key, kind }) => ({ key, kind })),
    ).toEqual([{ key: '?readTime', kind: 'removed-on-base' }])
  })

  // --- Files -----------------------------------------------------------------------------------

  it('row 29: an entry renamed on one side and edited on the other merges at the new path', async () => {
    const ID = 'aboutAbc1234'
    const [OLD, NEW] = [entry('page', 'start', ID, 'json'), entry('page', 'begin', ID, 'json')]
    const repo = await createRepo(tmpDir, { [OLD]: json({ title: 'Start', body: 'Text' }) })
    await repo.branch({ [OLD]: json({ title: 'Start', body: 'Text, edited' }) })
    await repo.base({ [OLD]: null, [NEW]: json({ title: 'Begin', body: 'Text' }) })

    await repo.cycle()

    expect(await repo.file(OLD)).toBeNull()
    expect(JSON.parse((await repo.file(NEW)) ?? '')).toEqual({
      title: 'Begin',
      body: 'Text, edited',
    })
    expect(await openConflicts(repo)).toEqual({})
  })

  it("row 30: an entry renamed apart on both sides stays at the branch's path, with a location conflict", async () => {
    const ID = 'aboutAbc1234'
    const [OLD, BASE, MINE] = ['start', 'begin', 'intro'].map((slug) =>
      entry('page', slug, ID, 'json'),
    )
    const repo = await createRepo(tmpDir, { [OLD]: json({ title: 'Start' }) })
    await repo.branch({ [OLD]: null, [MINE]: json({ title: 'Start' }) })
    await repo.base({ [OLD]: null, [BASE]: json({ title: 'Start' }) })

    const summary = await repo.cycle()

    expect(summary.failed).toEqual([])
    expect(await repo.file(OLD)).toBeNull()
    expect(await repo.file(BASE)).toBeNull()
    expect(JSON.parse((await repo.file(MINE)) ?? '')).toEqual({ title: 'Start' })
    const record = (await repo.record())?.entries[ID]
    expect(record?.path).toBe(MINE)
    expect(record?.fields?.map(({ key }) => key)).toEqual(['@location'])
  })

  it('row 31: an entry deleted on one side and edited on the other is an entry-level conflict, both ways', async () => {
    const [ONE, TWO] = ['aboutAbc1234', 'priceAbc1234']
    const [F1, F2] = [entry('page', 'one', ONE, 'json'), entry('page', 'two', TWO, 'json')]
    const repo = await createRepo(tmpDir, {
      [F1]: json({ title: 'One' }),
      [F2]: json({ title: 'Two' }),
    })
    await repo.branch({ [F1]: json({ title: 'One, edited' }), [F2]: null })
    await repo.base({ [F1]: null, [F2]: json({ title: 'Two, edited' }) })

    await repo.cycle()

    expect(JSON.parse((await repo.file(F1)) ?? '')).toEqual({ title: 'One, edited' })
    expect(await repo.file(F2)).toBeNull()
    const entries = (await repo.record())?.entries ?? {}
    expect(entries[ONE]).toMatchObject({ kind: 'deleted-on-base', path: F1 })
    expect(entries[TWO]).toMatchObject({ kind: 'deleted-on-branch', path: F2 })
  })

  it('row 32: an entry retyped on one side and edited on the other is an entry-level conflict', async () => {
    const ID = 'aboutAbc1234'
    const [PAGE, POST] = [entry('page', 'home', ID, 'json'), entry('post', 'home', ID, 'json')]
    const repo = await createRepo(tmpDir, { [PAGE]: json({ title: 'Home' }) })
    await repo.branch({ [PAGE]: json({ title: 'Home, edited' }) })
    await repo.base({ [PAGE]: null, [POST]: json({ title: 'Home' }) })

    await repo.cycle()

    expect(JSON.parse((await repo.file(PAGE)) ?? '')).toEqual({ title: 'Home, edited' })
    expect(await repo.file(POST)).toBeNull()
    expect((await repo.record())?.entries[ID]).toMatchObject({ kind: 'unreadable', path: PAGE })
  })

  it("row 33: a version over 1 MiB, or one that doesn't parse, is an entry-level conflict", async () => {
    const [BIG, BAD] = ['aboutAbc1234', 'priceAbc1234']
    const [F1, F2] = [entry('page', 'big', BIG, 'json'), entry('page', 'bad', BAD, 'json')]
    const repo = await createRepo(tmpDir, {
      [F1]: json({ title: 'Big' }),
      [F2]: json({ title: 'Bad' }),
    })
    await repo.branch({ [F1]: json({ title: 'Big, mine' }), [F2]: json({ title: 'Bad, mine' }) })
    await repo.base({
      [F1]: json({ title: 'Big, base', padding: 'x'.repeat(1024 * 1024) }),
      [F2]: '{\n  "title": "Bad, base",\n',
    })

    await repo.cycle()

    expect(JSON.parse((await repo.file(F1)) ?? '')).toEqual({ title: 'Big, mine' })
    expect(JSON.parse((await repo.file(F2)) ?? '')).toEqual({ title: 'Bad, mine' })
    const entries = (await repo.record())?.entries ?? {}
    expect(entries[BIG]).toMatchObject({ kind: 'unreadable', path: F1 })
    expect(entries[BAD]).toMatchObject({ kind: 'unreadable', path: F2 })
    await expectNoMarkers(repo)
  })

  it('row 34: a .collection.json merges concurrent order inserts, and its entries by name', async () => {
    const META = `${DIR}/.collection.json`
    const meta = (order: string[], pageLabel: string, postLabel: string) =>
      json({
        name: 'pages',
        order,
        entries: [
          { name: 'page', label: pageLabel },
          { name: 'post', label: postLabel },
        ],
      })
    const repo = await createRepo(tmpDir, { [META]: meta(['a1'], 'Page', 'Post') })
    await repo.branch({ [META]: meta(['a1', 'c3'], 'Page', 'Blog post') })
    await repo.base({ [META]: meta(['a1', 'b2'], 'Web page', 'Post') })

    await repo.cycle()

    const merged = JSON.parse((await repo.file(META)) ?? '') as {
      order: string[]
      entries: Item[]
    }
    expect([...merged.order].sort()).toEqual(['a1', 'b2', 'c3'])
    expect(merged.entries).toEqual([
      { name: 'page', label: 'Web page' },
      { name: 'post', label: 'Blog post' },
    ])
    expect(await openConflicts(repo)).toEqual({})
  })

  it("row 35: a conflicting file that is no entry keeps the branch's version, flagged", async () => {
    const NOTE = `${DIR}/notes.txt`
    const repo = await createRepo(tmpDir, { [NOTE]: 'base\n' })
    await repo.branch({ [NOTE]: 'mine\n' })
    await repo.base({ [NOTE]: 'theirs\n' })

    await repo.cycle()

    expect(await repo.file(NOTE)).toBe('mine\n')
    expect((await repo.record())?.entries[COLLECTION_ID]).toMatchObject({
      kind: 'unreadable',
      path: NOTE,
    })
  })

  it('row 36: md, mdx, json and yaml entries each round-trip through the field merge', async () => {
    const files = {
      md: entry('page', 'a', 'aboutAbc1234', 'md'),
      mdx: entry('page', 'b', 'priceAbc1234', 'mdx'),
      json: entry('page', 'c', 'notesAbc1234', 'json'),
      yaml: entry('page', 'd', 'footrAbc1234', 'yaml'),
    }
    const front = (title: string, description: string, body: string) =>
      `---\ntitle: ${title}\ndescription: ${description}\n---\n${body}`
    const mdxBody = 'Intro.\n\n<Note>Careful.</Note>\n'
    const repo = await createRepo(tmpDir, {
      [files.md]: front('T', 'D', 'Body.\n'),
      [files.mdx]: front('T', 'D', mdxBody),
      [files.json]: json({ title: 'T', description: 'D' }),
      [files.yaml]: 'title: T\ndescription: D\n',
    })
    await repo.branch({
      [files.md]: front('T', 'Mine', 'Body.\n'),
      [files.mdx]: front('T', 'Mine', mdxBody),
      [files.json]: json({ title: 'T', description: 'Mine' }),
      [files.yaml]: 'title: T\ndescription: Mine\n',
    })
    await repo.base({
      [files.md]: front('Base', 'D', 'Body.\n'),
      [files.mdx]: front('Base', 'D', mdxBody),
      [files.json]: json({ title: 'Base', description: 'D' }),
      [files.yaml]: 'title: Base\ndescription: D\n',
    })

    await repo.cycle()

    const want = { title: 'Base', description: 'Mine' }
    expect(parse(await repo.file(files.md), 'md')).toEqual({ data: want, body: 'Body.\n' })
    expect(parse(await repo.file(files.mdx), 'mdx')).toEqual({ data: want, body: mdxBody })
    expect(parse(await repo.file(files.json), 'json').data).toEqual(want)
    expect(parse(await repo.file(files.yaml), 'yaml').data).toEqual(want)
    expect(await openConflicts(repo)).toEqual({})
  })

  it("row 37: the base's frontmatter comments and formatting survive the merge", async () => {
    const FILE = entry('page', 'home', 'aboutAbc1234', 'md')
    const commented = (order: number, description: string) =>
      `---\n# Owned by the docs team\ntitle: Home # keep it short\ndescription: ${description}\norder: ${order}\n---\nHello.\n`
    const repo = await createRepo(tmpDir, { [FILE]: commented(3, 'D') })
    // The branch's bytes came from the CMS serializer, which writes no comments.
    await repo.branch({ [FILE]: '---\ntitle: Home\ndescription: Mine\norder: 3\n---\nHello.\n' })
    await repo.base({ [FILE]: commented(4, 'D') })

    await repo.cycle()

    expect(await repo.file(FILE)).toBe(commented(4, 'Mine'))
  })

  // --- The record over time --------------------------------------------------------------------

  it('row 40: the base moving again keeps an open conflict, or renews it from where the author started', async () => {
    const ID = 'aboutAbc1234'
    const FILE = entry('page', 'home', ID, 'json')
    const page = (title: string, cta: string) => json({ title, sub: 'Sub', cta })
    const repo = await createRepo(tmpDir, { [FILE]: page('Home', 'Go') })
    const ancestor = (await repo.git.revparse(['HEAD'])).trim()
    await repo.branch({ [FILE]: page('Mine', 'Go') })
    await repo.base({ [FILE]: page('Base 1', 'Go') })
    await repo.cycle()
    const first = (await repo.record())?.entries[ID]
    expect(first?.fields?.map(({ key }) => key)).toEqual(['?title'])

    // The base changes another field: the title merges as the branch's own change.
    await repo.base({ [FILE]: page('Base 1', 'Start') })
    await repo.cycle()
    expect(JSON.parse((await repo.file(FILE)) ?? '')).toEqual({
      title: 'Mine',
      sub: 'Sub',
      cta: 'Start',
    })
    expect((await repo.record())?.entries[ID]).toEqual(first)

    // The base changes the title again: the latest version, against the original ancestor.
    const base3 = await repo.base({ [FILE]: page('Base 2', 'Start') })
    await repo.cycle()
    const head = (await repo.git.revparse(['HEAD'])).trim()
    const [field] = (await repo.record())?.entries[ID]?.fields ?? []
    expect(field?.mergeSha).toBe(head)
    expect(field?.sides).toEqual({
      ancestor: await repo.blob(ancestor, FILE),
      base: await repo.blob(base3, FILE),
      branch: await repo.blob('HEAD^1', FILE),
    })
    expect(JSON.parse((await repo.file(FILE)) ?? '').title).toBe('Mine')
  })

  it('row 41: a crash between recording a merge and moving the clone leaves no stale record after the next merge', async () => {
    const ID = 'aboutAbc1234'
    const FILE = entry('page', 'home', ID, 'json')
    const repo = await createRepo(tmpDir, { [FILE]: json({ title: 'Home' }) })
    await repo.branch({ [FILE]: json({ title: 'Mine' }) })
    await repo.base({ [FILE]: json({ title: 'Theirs' }) })
    const before = (await repo.git.revparse(['HEAD'])).trim()
    const crash = afterFirstRecordWrite(() => {
      throw new Error('crashed after the record')
    })

    const crashed = await repo.cycle()

    expect(crashed.failed.map(({ branch }) => branch)).toEqual([BRANCH])
    expect((await repo.git.revparse(['HEAD'])).trim()).toBe(before)
    const orphan = (await repo.record())?.entries[ID]?.mergeSha
    expect(orphan).toBeDefined()
    crash.mockRestore()

    await repo.cycle()

    const head = (await repo.git.revparse(['HEAD'])).trim()
    expect(head).not.toBe(before)
    expect((await repo.record())?.entries[ID]?.mergeSha).toBe(head)
  })

  it('row 41: a lock lost mid-merge skips the branch, retried, with nothing moved', async () => {
    const ID = 'aboutAbc1234'
    const FILE = entry('page', 'home', ID, 'json')
    const repo = await createRepo(tmpDir, { [FILE]: json({ title: 'Home' }) })
    await repo.branch({ [FILE]: json({ title: 'Mine' }) })
    await repo.publish()
    await repo.base({ [FILE]: json({ title: 'Theirs' }) })
    const before = (await repo.git.revparse(['HEAD'])).trim()
    afterFirstRecordWrite(loseLock)

    const summary = await repo.cycle()

    expect(summary.skippedLocked).toEqual([BRANCH])
    expect(summary.failed).toEqual([])
    expect((await repo.git.revparse(['HEAD'])).trim()).toBe(before)
    expect(await repo.remoteSha()).toBe(before)
    expect(JSON.parse((await repo.file(FILE)) ?? '')).toEqual({ title: 'Mine' })
  })

  it('reconciles a record whose merge the branch never got, and keeps one remote.git holds', async () => {
    const [GONE, HELD] = ['aboutAbc1234', 'priceAbc1234']
    const repo = await createRepo(tmpDir, {})
    const head = await repo.branch({ 'content/x.txt': 'x\n' })
    await repo.publish()
    const sides = { branch: 'b'.repeat(40) }
    await new MergeConflictStore(repo.clonePath).update(() => ({
      entries: {
        [GONE]: { path: 'p1', mergeSha: 'a'.repeat(40), kind: 'deleted-on-base', sides },
        [HELD]: { path: 'p2', mergeSha: head, kind: 'unreadable', sides },
      },
    }))
    await BranchMetadataFileManager.get(repo.clonePath, path.dirname(repo.clonePath)).save({
      branch: {
        conflictFiles: [GONE as never, HELD as never],
        conflictStatus: 'conflicts-detected',
      },
    })

    await repo.cycle()

    expect(Object.keys((await repo.record())?.entries ?? {})).toEqual([HELD])
    const meta = await BranchMetadataFileManager.loadOnly(repo.clonePath)
    expect(meta?.branch.conflictFiles).toEqual([HELD])
  })

  // --- Found in review ---------------------------------------------------------------------------

  it('keeps a conflict on record when a later merge that renewed it never lands', async () => {
    const ID = 'aboutAbc1234'
    const FILE = entry('page', 'home', ID, 'json')
    const repo = await createRepo(tmpDir, { [FILE]: json({ title: 'Home' }) })
    await repo.branch({ [FILE]: json({ title: 'Mine' }) })
    await repo.base({ [FILE]: json({ title: 'Base 1' }) })
    await repo.cycle()
    const first = (await repo.record())?.entries[ID]
    expect(first?.fields?.map(({ key }) => key)).toEqual(['?title'])

    // The base changes the title again, and the lock is lost once the merge is recorded.
    await repo.base({ [FILE]: json({ title: 'Base 2' }) })
    const spy = afterFirstRecordWrite(loseLock)
    expect((await repo.cycle()).skippedLocked).toEqual([BRANCH])
    spy.mockRestore()
    expect((await repo.record())?.entries[ID]?.previous).toEqual(first)

    // The base goes back: the merge now finds nothing new, and the first record stands.
    await repo.base({ [FILE]: json({ title: 'Base 1' }) })
    await repo.cycle()
    expect((await repo.record())?.entries[ID]).toEqual(first)
  })

  it('moves comment threads only once the clone holds the merge that gave the new keys', async () => {
    const repo = await createRepo(tmpDir, { [GUIDE_FILE]: guide(steps, false) })
    await repo.branch({ [GUIDE_FILE]: guide(steps, true, 'summary: Short.\n') })
    await repo.base({ [GUIDE_FILE]: guide(reworded, true) })
    const commentsFile = path.join(repo.clonePath, '.canopy-meta', 'comments.json')
    await fs.mkdir(path.dirname(commentsFile), { recursive: true })
    await fs.writeFile(
      commentsFile,
      JSON.stringify({
        schemaVersion: 1,
        version: 1,
        threads: {
          t1: {
            id: 't1',
            comments: [],
            resolved: false,
            createdAt: '2026-11-01T00:00:00.000Z',
            type: 'field',
            authorId: 'u1',
            entryPath: 'content/pages/guide',
            canopyPath: 'steps[2].detail',
            itemKeys: [readKey(steps[2])],
          },
        },
      }),
    )
    const keys = async () =>
      (
        JSON.parse(await fs.readFile(commentsFile, 'utf8')) as {
          threads: Record<string, { itemKeys: string[] }>
        }
      ).threads.t1.itemKeys
    const spy = afterFirstRecordWrite(loseLock)

    expect((await repo.cycle()).skippedLocked).toEqual([BRANCH])
    expect(await keys()).toEqual([readKey(steps[2])])
    spy.mockRestore()

    await repo.cycle()
    expect(await keys()).toEqual([readKey(reworded[2])])
  })

  it('keeps a record whose merge only remote.git holds, fetching it to tell', async () => {
    const ID = 'aboutAbc1234'
    const repo = await createRepo(tmpDir, {})
    await repo.branch({ 'content/x.txt': 'x\n' })
    await repo.publish()
    const forged = await repo.forgeRemoteHead()
    const earlier = { path: 'p', mergeSha: 'a'.repeat(40), kind: 'unreadable' as const, sides: {} }
    await new MergeConflictStore(repo.clonePath).update(() => ({
      entries: {
        [ID]: { path: 'p', mergeSha: forged, kind: 'unreadable', sides: {}, previous: earlier },
      },
    }))

    await repo.cycle()

    // Landed, as far as it can tell: the record it replaced goes.
    expect((await repo.record())?.entries).toEqual({
      [ID]: { path: 'p', mergeSha: forged, kind: 'unreadable', sides: {} },
    })
  })

  it('moves aside a conflict record that does not parse, and the base still comes in', async () => {
    const FILE = entry('page', 'home', 'aboutAbc1234', 'json')
    const repo = await createRepo(tmpDir, { [FILE]: json({ title: 'Home' }) })
    await repo.branch({ [FILE]: json({ title: 'Mine' }) })
    await repo.base({ [FILE]: json({ title: 'Theirs' }) })
    const dir = path.join(repo.clonePath, '.canopy-meta')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'merge-conflicts.json'), '{"entries": 7}')

    const summary = await repo.cycle()

    expect(summary.rebased).toEqual([BRANCH])
    expect((await fs.readdir(dir)).filter((f) => f.includes('.malformed-'))).toHaveLength(1)
    expect(Object.keys((await repo.record())?.entries ?? {})).toEqual(['aboutAbc1234'])
  })

  it('reconciles the record of a branch in review too', async () => {
    const GONE = 'aboutAbc1234'
    const repo = await createRepo(tmpDir, {})
    await new MergeConflictStore(repo.clonePath).update(() => ({
      entries: { [GONE]: { path: 'p', mergeSha: 'a'.repeat(40), kind: 'unreadable', sides: {} } },
    }))
    await repo.status('submitted')

    await repo.cycle()

    expect((await repo.record())?.entries).toEqual({})
  })

  it("brings a collection's .collection.json edits through a rename of its directory", async () => {
    const [OLD, NEW] = ['content/posts.cNbR5xFm2Kpd', 'content/articles.cNbR5xFm2Kpd']
    const ENTRY = 'post.a.aboutAbc1234.json'
    const meta = (order: string[], label: string) => json({ name: 'posts', label, order })
    const repo = await createRepo(tmpDir, {
      [`${OLD}/.collection.json`]: meta(['a1', 'b2'], 'Posts'),
      [`${OLD}/${ENTRY}`]: json({ title: 'A' }),
    })
    await repo.branch({ [`${OLD}/.collection.json`]: meta(['b2', 'a1'], 'Posts') })
    await repo.base({
      [`${OLD}/.collection.json`]: null,
      [`${OLD}/${ENTRY}`]: null,
      [`${NEW}/.collection.json`]: meta(['a1', 'b2'], 'Articles'),
      [`${NEW}/${ENTRY}`]: json({ title: 'A' }),
    })

    await repo.cycle()

    expect(await repo.file(`${OLD}/.collection.json`)).toBeNull()
    expect(JSON.parse((await repo.file(`${NEW}/.collection.json`)) ?? '')).toEqual({
      name: 'posts',
      label: 'Articles',
      order: ['b2', 'a1'],
    })
    expect(await openConflicts(repo)).toEqual({})
  })

  it('puts an entry added in a directory the other side renamed into the renamed directory', async () => {
    const [OLD, NEW] = ['content/posts.cNbR5xFm2Kpd', 'content/articles.cNbR5xFm2Kpd']
    const [A, B] = ['post.a.aboutAbc1234.json', 'post.b.priceAbc1234.json']
    const repo = await createRepo(tmpDir, {
      [`${OLD}/.collection.json`]: json({ name: 'posts' }),
      [`${OLD}/${A}`]: json({ title: 'A' }),
    })
    await repo.branch({
      [`${OLD}/${B}`]: json({ title: 'B' }),
      [`${OLD}/${A}`]: json({ title: 'A!' }),
    })
    await repo.base({
      [`${OLD}/.collection.json`]: null,
      [`${OLD}/${A}`]: null,
      [`${NEW}/.collection.json`]: json({ name: 'posts' }),
      [`${NEW}/${A}`]: json({ title: 'A' }),
    })

    await repo.cycle()

    const tree = (await repo.git.raw(['ls-tree', '-r', '--name-only', 'HEAD', 'content']))
      .trim()
      .split('\n')
    expect(tree.sort()).toEqual([`${NEW}/.collection.json`, `${NEW}/${A}`, `${NEW}/${B}`].sort())
    expect(JSON.parse((await repo.file(`${NEW}/${A}`)) ?? '')).toEqual({ title: 'A!' })
    expect(await openConflicts(repo)).toEqual({})
  })

  it("keeps a base's frontmatter comment git merged in, by a rebase", async () => {
    const FILE = entry('page', 'home', 'aboutAbc1234', 'md')
    const doc = (comment: string, title: string) =>
      `---\n${comment}a: 1\nb: 2\nc: 3\nd: 4\ntitle: ${title}\n---\nHello.\n`
    const repo = await createRepo(tmpDir, { [FILE]: doc('', 'Home') })
    await repo.branch({ [FILE]: doc('', 'Mine') })
    await repo.base({ [FILE]: doc('# A developer note\n', 'Home') })

    await repo.cycle()

    expect(await repo.file(FILE)).toBe(doc('# A developer note\n', 'Mine'))
    expect(await repo.parents()).toBe(1)
  })

  it('leaves an entry whose top level is no record to git, as no data to merge', async () => {
    const FILE = entry('page', 'list', 'aboutAbc1234', 'json')
    const list = (first: string, last: string) => json([first, 'b', 'c', 'd', 'e', 'f', last])
    const repo = await createRepo(tmpDir, { [FILE]: list('a', 'g') })
    await repo.branch({ [FILE]: list('a', 'G') })
    await repo.base({ [FILE]: list('A', 'g') })

    await repo.cycle()

    expect(JSON.parse((await repo.file(FILE)) ?? '')).toEqual(['A', 'b', 'c', 'd', 'e', 'f', 'G'])
  })

  it('leaves a second file for an ID, added beside the first, to git', async () => {
    const [ORIGINAL, COPY] = [
      entry('page', 'a', 'aboutAbc1234', 'json'),
      entry('page', 'a-copy', 'aboutAbc1234', 'json'),
    ]
    const repo = await createRepo(tmpDir, { [ORIGINAL]: json({ title: 'A', note: 'n' }) })
    await repo.branch({ [ORIGINAL]: json({ title: 'A!', note: 'n' }) })
    await repo.base({ [COPY]: json({ title: 'A', note: 'n' }) })

    await repo.cycle()

    expect(JSON.parse((await repo.file(ORIGINAL)) ?? '')).toEqual({ title: 'A!', note: 'n' })
    expect(await repo.file(COPY)).not.toBeNull()
  })

  it('records a base that shares no history with the branch as a failure, not a crash', async () => {
    const repo = await createRepo(tmpDir, { 'content/a.txt': 'a\n' })
    await repo.branch({ 'content/b.txt': 'b\n' })
    await repo.orphanBase({ 'content/c.txt': 'c\n' })

    const summary = await repo.cycle()

    expect(
      summary.failed.map(({ branch, error }) => [branch, /no history in common/.test(error)]),
    ).toEqual([[BRANCH, true]])
  })

  it("puts each side's new entry in a collection directory both sides moved, where the branch put it", async () => {
    const [OLD, BASE, MINE] = ['posts', 'articles', 'stories'].map(
      (n) => `content/${n}.cNbR5xFm2Kpd`,
    )
    const [A, N, M] = [
      'post.a.aboutAbc1234.json',
      'post.n.priceAbc1234.json',
      'post.m.notesAbc1234.json',
    ]
    const meta = json({ name: 'posts' })
    const repo = await createRepo(tmpDir, {
      [`${OLD}/.collection.json`]: meta,
      [`${OLD}/${A}`]: json({ title: 'A' }),
    })
    await repo.branch({
      [`${OLD}/.collection.json`]: null,
      [`${OLD}/${A}`]: null,
      [`${MINE}/.collection.json`]: meta,
      [`${MINE}/${A}`]: json({ title: 'A' }),
      [`${MINE}/${M}`]: json({ title: 'M' }),
    })
    await repo.base({
      [`${OLD}/.collection.json`]: null,
      [`${OLD}/${A}`]: null,
      [`${BASE}/.collection.json`]: meta,
      [`${BASE}/${A}`]: json({ title: 'A' }),
      [`${BASE}/${N}`]: json({ title: 'N' }),
    })

    await repo.cycle()

    const tree = (await repo.git.raw(['ls-tree', '-r', '--name-only', 'HEAD', 'content']))
      .trim()
      .split('\n')
    expect(tree.sort()).toEqual(
      [`${MINE}/.collection.json`, `${MINE}/${A}`, `${MINE}/${M}`, `${MINE}/${N}`].sort(),
    )
    expect((await repo.record())?.entries[COLLECTION_ID]?.fields?.map(({ key }) => key)).toEqual([
      '@location',
    ])
  })

  it('combines a parent directory renamed on one side with a child renamed on the other', async () => {
    const P = 'docs.cNbR5xFm2Kpd'
    const [Q, Q2] = ['api.priceAbc1234', 'reference.priceAbc1234']
    const [A, N] = ['page.a.aboutAbc1234.json', 'page.n.notesAbc1234.json']
    const repo = await createRepo(tmpDir, {
      [`content/${P}/.collection.json`]: json({ name: 'docs' }),
      [`content/${P}/${Q}/.collection.json`]: json({ name: 'api' }),
      [`content/${P}/${Q}/${A}`]: json({ title: 'A' }),
    })
    await repo.branch({
      [`content/${P}/${Q}/.collection.json`]: null,
      [`content/${P}/${Q}/${A}`]: null,
      [`content/${P}/${Q2}/.collection.json`]: json({ name: 'api' }),
      [`content/${P}/${Q2}/${A}`]: json({ title: 'A' }),
      [`content/${P}/${Q2}/${N}`]: json({ title: 'N' }),
    })
    const G = 'guides.cNbR5xFm2Kpd'
    await repo.base({
      [`content/${P}/.collection.json`]: null,
      [`content/${P}/${Q}/.collection.json`]: null,
      [`content/${P}/${Q}/${A}`]: null,
      [`content/${G}/.collection.json`]: json({ name: 'docs' }),
      [`content/${G}/${Q}/.collection.json`]: json({ name: 'api' }),
      [`content/${G}/${Q}/${A}`]: json({ title: 'A' }),
    })

    await repo.cycle()

    const tree = (await repo.git.raw(['ls-tree', '-r', '--name-only', 'HEAD', 'content']))
      .trim()
      .split('\n')
    expect(tree.sort()).toEqual(
      [
        `content/${G}/.collection.json`,
        `content/${G}/${Q2}/.collection.json`,
        `content/${G}/${Q2}/${A}`,
        `content/${G}/${Q2}/${N}`,
      ].sort(),
    )
    expect(await openConflicts(repo)).toEqual({})
  })

  it('records a collection moved on one side and deleted on the other, rather than blocking', async () => {
    const [OLD, NEW] = ['content/posts.cNbR5xFm2Kpd', 'content/articles.cNbR5xFm2Kpd']
    const A = 'post.a.aboutAbc1234.json'
    const repo = await createRepo(tmpDir, {
      [`${OLD}/.collection.json`]: json({ name: 'posts' }),
      [`${OLD}/${A}`]: json({ title: 'A' }),
    })
    await repo.branch({ [`${OLD}/.collection.json`]: null, [`${OLD}/${A}`]: null })
    await repo.base({
      [`${OLD}/.collection.json`]: null,
      [`${OLD}/${A}`]: null,
      [`${NEW}/.collection.json`]: json({ name: 'posts' }),
      [`${NEW}/${A}`]: json({ title: 'A' }),
    })

    const summary = await repo.cycle()

    expect(summary.failed).toEqual([])
    expect(await repo.file(`${NEW}/.collection.json`)).toBeNull()
    expect((await repo.record())?.entries[COLLECTION_ID]).toMatchObject({
      kind: 'deleted-on-branch',
      path: `${NEW}/.collection.json`,
    })
  })

  it('records an entry the branch deleted where it would be now, in a directory the branch moved', async () => {
    const [OLD, NEW] = ['content/posts.cNbR5xFm2Kpd', 'content/articles.cNbR5xFm2Kpd']
    const [A, B] = ['post.a.aboutAbc1234.json', 'post.b.priceAbc1234.json']
    const repo = await createRepo(tmpDir, {
      [`${OLD}/.collection.json`]: json({ name: 'posts' }),
      [`${OLD}/${A}`]: json({ title: 'A' }),
      [`${OLD}/${B}`]: json({ title: 'B' }),
    })
    await repo.branch({
      [`${OLD}/.collection.json`]: null,
      [`${OLD}/${A}`]: null,
      [`${OLD}/${B}`]: null,
      [`${NEW}/.collection.json`]: json({ name: 'posts' }),
      [`${NEW}/${B}`]: json({ title: 'B' }),
    })
    await repo.base({ [`${OLD}/${A}`]: json({ title: 'A, edited' }) })

    await repo.cycle()

    expect((await repo.record())?.entries.aboutAbc1234).toMatchObject({
      kind: 'deleted-on-branch',
      path: `${NEW}/${A}`,
    })
  })

  it('keeps a CRLF file CRLF when the merge is written onto it', async () => {
    const FILE = entry('page', 'home', 'aboutAbc1234', 'md')
    const doc = (title: string, extra: string) =>
      `---\r\ntitle: ${title}\r\n# a note\r\nauthor: X\r\n${extra}---\r\nPara one.\r\n`
    const repo = await createRepo(tmpDir, { [FILE]: doc('T', '') })
    await repo.branch({ [FILE]: doc('Mine', '') })
    await repo.base({ [FILE]: doc('Theirs', 'summary: S\r\n') })

    await repo.cycle()

    const text = (await repo.file(FILE)) ?? ''
    expect(text).not.toMatch(/(^|[^\r])\n/)
    expect(parse(text, 'md').data).toEqual({ title: 'Mine', author: 'X', summary: 'S' })
  })

  it('keeps an open conflict when a merge runs after a reconcile that failed', async () => {
    const ID = 'aboutAbc1234'
    const FILE = entry('page', 'home', ID, 'json')
    const page = (title: string, cta: string) => json({ title, sub: 'Sub', cta })
    const repo = await createRepo(tmpDir, { [FILE]: page('Home', 'Go') })
    await repo.branch({ [FILE]: page('Mine', 'Go') })
    await repo.base({ [FILE]: page('Base 1', 'Go') })
    await repo.cycle()
    await repo.base({ [FILE]: page('Base 2', 'Go') })
    const spy = afterFirstRecordWrite(loseLock)
    expect((await repo.cycle()).skippedLocked).toEqual([BRANCH])
    spy.mockRestore()

    // The next reconcile fails, and the base goes back on the title and changes the call to action.
    vi.spyOn(MergeConflictStore.prototype, 'read').mockRejectedValueOnce(new Error('EIO'))
    await repo.base({ [FILE]: page('Base 1', 'Start') })
    await repo.cycle()
    await repo.cycle()

    expect(JSON.parse((await repo.file(FILE)) ?? '')).toEqual({
      title: 'Mine',
      sub: 'Sub',
      cta: 'Start',
    })
    expect((await repo.record())?.entries[ID]?.fields?.map(({ key }) => key)).toEqual(['?title'])
  })

  it('catches the clone up with a merge it published and never moved to, then takes its remaps', async () => {
    const repo = await createRepo(tmpDir, { [GUIDE_FILE]: guide(steps, false) })
    await repo.branch({ [GUIDE_FILE]: guide(steps, true) })
    await repo.publish()
    const merge = await repo.publishMergeOnly()
    const entryPath = 'content/pages/guide'
    const from = readKey(steps[2])
    await new MergeConflictStore(repo.clonePath).update(() => ({
      entries: {},
      remaps: [{ mergeSha: merge, entryPath, remaps: [{ within: [], from, to: 'newKey12' }] }],
      landing: { mergeSha: merge },
    }))
    const commentsFile = path.join(repo.clonePath, '.canopy-meta', 'comments.json')
    await fs.writeFile(
      commentsFile,
      JSON.stringify({
        schemaVersion: 1,
        version: 1,
        threads: {
          t1: {
            id: 't1',
            comments: [],
            resolved: false,
            createdAt: '2026-11-01T00:00:00.000Z',
            type: 'field',
            authorId: 'u1',
            entryPath,
            canopyPath: 'steps[2].detail',
            itemKeys: [from],
          },
        },
      }),
    )

    const keys = async () =>
      (
        JSON.parse(await fs.readFile(commentsFile, 'utf8')) as {
          threads: Record<string, { itemKeys: string[] }>
        }
      ).threads.t1.itemKeys

    const summary = await repo.cycle()

    // Caught up, and the merge landed: its remaps applied, and it is no longer landing.
    expect(summary.failed).toEqual([])
    expect((await repo.git.revparse(['HEAD'])).trim()).toBe(merge)
    expect(await keys()).toEqual(['newKey12'])
    expect((await repo.record())?.landing).toBeUndefined()
  })

  it("never catches up with a merge on remote.git's same-named branch that this worker did not land", async () => {
    const FILE = entry('page', 'home', 'aboutAbc1234', 'json')
    const repo = await createRepo(tmpDir, { [FILE]: json({ title: 'Home' }) })
    const base = await repo.base({ 'content/other.txt': 'theirs\n' })
    const stranger = await repo.publishMergeOnly()

    await repo.cycle()

    const head = (await repo.git.revparse(['HEAD'])).trim()
    expect(head).not.toBe(stranger)
    expect(head).toBe(base)
  })

  it('blocks a merge where each side moved a collection directory into the other', async () => {
    const [A, B] = ['a.cNbR5xFm2Kpd', 'b.priceAbc1234']
    const repo = await createRepo(tmpDir, {
      [`content/${A}/.collection.json`]: json({ name: 'a' }),
      [`content/${B}/.collection.json`]: json({ name: 'b' }),
    })
    await repo.branch({
      [`content/${B}/.collection.json`]: null,
      [`content/${A}/${B}/.collection.json`]: json({ name: 'b' }),
    })
    await repo.base({
      [`content/${A}/.collection.json`]: null,
      [`content/${B}/${A}/.collection.json`]: json({ name: 'a' }),
    })

    const summary = await repo.cycle()

    expect(summary.failed.map(({ error }) => /moved into each other/.test(error))).toEqual([true])
  })

  it("moves a collection's conflict record with its directory", async () => {
    const [OLD, NEW] = ['content/posts.cNbR5xFm2Kpd', 'content/articles.cNbR5xFm2Kpd']
    const repo = await createRepo(tmpDir, {
      [`${OLD}/.collection.json`]: json({ name: 'posts', label: 'Posts' }),
    })
    await repo.branch({ [`${OLD}/.collection.json`]: json({ name: 'posts', label: 'Mine' }) })
    await repo.base({ [`${OLD}/.collection.json`]: json({ name: 'posts', label: 'Theirs' }) })
    await repo.cycle()
    expect((await repo.record())?.entries[COLLECTION_ID]?.path).toBe(`${OLD}/.collection.json`)

    await repo.base({
      [`${OLD}/.collection.json`]: null,
      [`${NEW}/.collection.json`]: json({ name: 'posts', label: 'Theirs' }),
    })
    await repo.cycle()

    expect((await repo.record())?.entries[COLLECTION_ID]?.path).toBe(`${NEW}/.collection.json`)
  })

  it('leaves a conflict record in a later format alone', async () => {
    const repo = await createRepo(tmpDir, {})
    const dir = path.join(repo.clonePath, '.canopy-meta')
    await fs.mkdir(dir, { recursive: true })
    const later = JSON.stringify({ schema: 2, version: 1, entries: { x: { novel: true } } })
    await fs.writeFile(path.join(dir, 'merge-conflicts.json'), later)

    await repo.cycle()

    expect(await fs.readFile(path.join(dir, 'merge-conflicts.json'), 'utf8')).toBe(later)
    expect((await fs.readdir(dir)).filter((f) => f.includes('.malformed-'))).toEqual([])
  })
})
