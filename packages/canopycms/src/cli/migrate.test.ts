import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { migrate, slugifyName, MigrateError } from './migrate'
import { isValidId } from '../id'
import { mockConsole } from '../test-utils/console-spy'

// Mock @clack/prompts to avoid interactive prompts in tests
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  log: {
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    step: vi.fn(),
  },
  confirm: vi.fn().mockResolvedValue(false),
  select: vi.fn(),
  text: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  cancel: vi.fn(),
}))

const defaultOpts = (projectDir: string) => ({
  projectDir,
  entryType: 'doc',
  format: 'md' as const,
  schema: 'docSchema',
  force: true,
})

/**
 * content/
 *   index.md
 *   guides/
 *     Getting Started.md
 *     advanced/
 *       deep.md
 *   assets/
 *     logo.svg          <- no md content: untouched
 */
async function setupPlainTree(): Promise<string> {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-migrate-test-'))
  const contentDir = path.join(projectDir, 'content')
  await fs.mkdir(path.join(contentDir, 'guides', 'advanced'), { recursive: true })
  await fs.mkdir(path.join(contentDir, 'assets'), { recursive: true })
  await fs.writeFile(path.join(contentDir, 'index.md'), '# Home\n')
  await fs.writeFile(path.join(contentDir, 'guides', 'Getting Started.md'), '# Start\n')
  await fs.writeFile(path.join(contentDir, 'guides', 'advanced', 'deep.md'), '# Deep\n')
  await fs.writeFile(path.join(contentDir, 'assets', 'logo.svg'), '<svg/>')
  return projectDir
}

const listTree = async (dir: string): Promise<string[]> => {
  const out: string[] = []
  const walk = async (d: string, prefix: string) => {
    for (const entry of await fs.readdir(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      out.push(rel)
      if (entry.isDirectory()) await walk(path.join(d, entry.name), rel)
    }
  }
  await walk(dir, '')
  return out.sort()
}

/** Parse "type.slug.id.ext" and assert its shape. */
const expectEntryFileName = (name: string, type: string, slug: string, ext: string) => {
  const parts = name.split('.')
  expect(parts).toHaveLength(4)
  expect(parts[0]).toBe(type)
  expect(parts[1]).toBe(slug)
  expect(isValidId(parts[2])).toBe(true)
  expect(parts[3]).toBe(ext)
}

describe('canopycms migrate', () => {
  let projectDir: string

  beforeEach(() => {
    mockConsole()
  })

  afterEach(async () => {
    if (projectDir) await fs.rm(projectDir, { recursive: true, force: true })
  })

  it('converts a plain tree to CanopyCMS conventions', async () => {
    projectDir = await setupPlainTree()
    const contentDir = path.join(projectDir, 'content')

    const result = await migrate(defaultOpts(projectDir))
    expect(result.opCount).toBeGreaterThan(0)

    const rootEntries = await fs.readdir(contentDir)

    // Loose root file renamed to {type}.{slug}.{id}.md
    const rootDoc = rootEntries.find((n) => n.endsWith('.md'))
    expect(rootDoc).toBeDefined()
    expectEntryFileName(rootDoc as string, 'doc', 'index', 'md')

    // Root .collection.json (root form: no name)
    const rootMeta = JSON.parse(
      await fs.readFile(path.join(contentDir, '.collection.json'), 'utf-8'),
    )
    expect(rootMeta.name).toBeUndefined()
    expect(rootMeta.entries).toEqual([{ name: 'doc', format: 'md', schema: 'docSchema' }])

    // guides/ renamed to guides.{id}/ with .collection.json
    const guidesDir = rootEntries.find((n) => n.startsWith('guides.'))
    expect(guidesDir).toBeDefined()
    expect(isValidId((guidesDir as string).split('.')[1])).toBe(true)
    const guidesMeta = JSON.parse(
      await fs.readFile(path.join(contentDir, guidesDir as string, '.collection.json'), 'utf-8'),
    )
    expect(guidesMeta.name).toBe('guides')
    expect(guidesMeta.order).toBeUndefined() // alphabetical fallback, no order written

    // 'Getting Started.md' slugified
    const guidesEntries = await fs.readdir(path.join(contentDir, guidesDir as string))
    const startDoc = guidesEntries.find((n) => n.endsWith('.md'))
    expectEntryFileName(startDoc as string, 'doc', 'getting-started', 'md')

    // nested advanced/ also migrated
    const advancedDir = guidesEntries.find((n) => n.startsWith('advanced.'))
    expect(advancedDir).toBeDefined()
    const advancedEntries = await fs.readdir(
      path.join(contentDir, guidesDir as string, advancedDir as string),
    )
    expect(advancedEntries).toContain('.collection.json')
    expectEntryFileName(
      advancedEntries.find((n) => n.endsWith('.md')) as string,
      'doc',
      'deep',
      'md',
    )

    // assets/ untouched: no rename, no .collection.json
    expect(rootEntries).toContain('assets')
    expect(await fs.readdir(path.join(contentDir, 'assets'))).toEqual(['logo.svg'])
  })

  it('is idempotent — a second run changes nothing', async () => {
    projectDir = await setupPlainTree()
    const contentDir = path.join(projectDir, 'content')

    await migrate(defaultOpts(projectDir))
    const after = await listTree(contentDir)

    const second = await migrate(defaultOpts(projectDir))
    expect(second.opCount).toBe(0)
    expect(await listTree(contentDir)).toEqual(after)
  })

  it('dry run leaves the tree untouched', async () => {
    projectDir = await setupPlainTree()
    const contentDir = path.join(projectDir, 'content')
    const before = await listTree(contentDir)

    const result = await migrate({ ...defaultOpts(projectDir), dryRun: true })
    expect(result.opCount).toBe(0)
    expect(await listTree(contentDir)).toEqual(before)
  })

  it('fails hard when the content directory is missing', async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-migrate-test-'))
    await expect(migrate(defaultOpts(projectDir))).rejects.toThrow(/Content directory not found/)
  })

  it('rejects an invalid format', async () => {
    projectDir = await setupPlainTree()
    await expect(migrate({ ...defaultOpts(projectDir), format: 'txt' as never })).rejects.toThrow(
      MigrateError,
    )
  })

  it('only migrates files of the chosen format', async () => {
    projectDir = await setupPlainTree()
    const contentDir = path.join(projectDir, 'content')
    await fs.writeFile(path.join(contentDir, 'data.json'), '{"a":1}\n')

    await migrate(defaultOpts(projectDir))

    // json file untouched when migrating md
    const rootEntries = await fs.readdir(contentDir)
    expect(rootEntries).toContain('data.json')
  })

  it('migrates underscore names to slugs the public read path accepts', async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-migrate-test-'))
    const contentDir = path.join(projectDir, 'content')
    await fs.mkdir(contentDir, { recursive: true })
    await fs.writeFile(path.join(contentDir, 'my_post.md'), '# Post\n')

    await migrate(defaultOpts(projectDir))

    const rootEntries = await fs.readdir(contentDir)
    const doc = rootEntries.find((n) => n.endsWith('.md'))
    expectEntryFileName(doc as string, 'doc', 'my-post', 'md')
  })

  it('rejects an entry type that would corrupt the filename grammar', async () => {
    projectDir = await setupPlainTree()
    await expect(migrate({ ...defaultOpts(projectDir), entryType: 'my.doc' })).rejects.toThrow(
      /Invalid entry type/,
    )
    await expect(migrate({ ...defaultOpts(projectDir), entryType: 'a/b' })).rejects.toThrow(
      /Invalid entry type/,
    )
  })

  it('renames files whose names merely contain an ID-like segment', async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-migrate-test-'))
    const contentDir = path.join(projectDir, 'content')
    await fs.mkdir(contentDir, { recursive: true })
    // "attachments1" is 12 valid Base58 chars but this is NOT a conforming
    // {type}.{slug}.{id}.{ext} name — it must still be migrated
    await fs.writeFile(path.join(contentDir, 'report.attachments1.md'), '# R\n')

    await migrate(defaultOpts(projectDir))

    const rootEntries = await fs.readdir(contentDir)
    const doc = rootEntries.find((n) => n.endsWith('.md'))
    expectEntryFileName(doc as string, 'doc', 'report-attachments1', 'md')
  })

  it('accepts .yml files when migrating yaml format', async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-migrate-test-'))
    const contentDir = path.join(projectDir, 'content')
    await fs.mkdir(contentDir, { recursive: true })
    await fs.writeFile(path.join(contentDir, 'settings.yml'), 'a: 1\n')

    await migrate({ ...defaultOpts(projectDir), format: 'yaml' })

    const rootEntries = await fs.readdir(contentDir)
    const entry = rootEntries.find((n) => n.endsWith('.yml'))
    expectEntryFileName(entry as string, 'doc', 'settings', 'yml')
  })

  it('creates no .canopy-meta/ at the project root for a plain (non-branch-clone) directory', async () => {
    // Pins the invariant documented in migrate.ts: a plain project dir (the
    // common case — migrate runs once before any branch workspace exists)
    // must never gain a .canopy-meta/ directory, whether from the surrogate
    // schema lock or from cache invalidation.
    projectDir = await setupPlainTree()

    const result = await migrate(defaultOpts(projectDir))
    expect(result.opCount).toBeGreaterThan(0)

    const metaDirExists = await fs
      .stat(path.join(projectDir, '.canopy-meta'))
      .then(() => true)
      .catch(() => false)
    expect(metaDirExists).toBe(false)
  })

  it('applies ops under the surrogate schema lock for a branch-clone project dir, leaving no lock artifact behind', async () => {
    projectDir = await setupPlainTree()
    // Seed a minimal branch.json the way BranchMetadataFileManager.loadOnly
    // expects, marking projectDir as a branch clone workspace — branch
    // clones are full git clones that carry their own
    // .canopy-meta/branch.json (see migrate.ts's invariant comment).
    await fs.mkdir(path.join(projectDir, '.canopy-meta'), { recursive: true })
    await fs.writeFile(
      path.join(projectDir, '.canopy-meta', 'branch.json'),
      JSON.stringify({
        schemaVersion: 1,
        version: 1,
        branch: {
          name: 'feature-x',
          status: 'editing',
          access: {},
          createdBy: 'u1',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }),
    )

    const result = await migrate(defaultOpts(projectDir))
    expect(result.opCount).toBeGreaterThan(0)

    const metaEntries = await fs.readdir(path.join(projectDir, '.canopy-meta'))
    expect(metaEntries).not.toContain('schema.lock')
    expect(metaEntries).toContain('branch.json') // untouched by the migrate run
  })
})

describe('slugifyName', () => {
  it('lowercases and replaces unsafe characters', () => {
    expect(slugifyName('Getting Started')).toBe('getting-started')
    expect(slugifyName('FAQ & Help!')).toBe('faq-help')
    expect(slugifyName('already-fine-name')).toBe('already-fine-name')
  })

  it('replaces underscores — parseSlug rejects them on the public read path', () => {
    expect(slugifyName('my_post')).toBe('my-post')
    expect(slugifyName('_drafts')).toBe('drafts')
  })

  it('never returns an empty slug', () => {
    expect(slugifyName('***')).toBe('item')
  })
})
