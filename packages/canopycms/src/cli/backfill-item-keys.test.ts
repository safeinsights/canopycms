import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { simpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CONTENT_ROUTES } from '../api/content'
import type { ApiContext } from '../api/types'
import { createCheckBranchAccess } from '../authorization'
import { createTestContentAccess } from '../authorization/test-utils'
import { flattenSchema, type FieldConfig, type RootCollectionConfig } from '../config'
import { defineCanopyTestConfig } from '../config-test'
import { contentIndexGenerationPath } from '../content-index-generation'
import { ContentStore } from '../content-store'
import { ITEM_KEY } from '../item-keys'
import { unsafeAsBranchName, unsafeAsLogicalPath, unsafeAsSlug } from '../paths/test-utils'
import { createMockApiContext, createMockBranchContext } from '../test-utils'
import { mockConsole, type MockConsole } from '../test-utils/console-spy'
import { CANOPY_META_DIR } from '../utils/git'
import { backfillItemKeys, backfillItemKeysCLI, BACKFILL_EXIT_CODES } from './backfill-item-keys'

const link: FieldConfig[] = [
  { name: 'href', type: 'string' },
  { name: 'label', type: 'string' },
]
const fields: FieldConfig[] = [
  { name: 'title', type: 'string', isTitle: true },
  { name: 'published', type: 'date' },
  { name: 'author', type: 'reference', collections: ['people'] },
  {
    name: 'steps',
    type: 'object',
    list: true,
    fields: [
      { name: 'title', type: 'string' },
      { name: 'links', type: 'object', list: true, fields: link },
    ],
  },
  {
    name: 'blocks',
    type: 'block',
    templates: [
      {
        name: 'hero',
        fields: [
          { name: 'headline', type: 'string' },
          { name: 'ctas', type: 'object', list: true, fields: link },
        ],
      },
    ],
  },
]

const DOCS_DIR = 'docs.Ab3dEf6hJk9m'
const PEOPLE_DIR = 'people.Bc4eFg7hJk8m'
const AUTHOR_ID = 'Cd5fGh8jKm9n'

const schema: RootCollectionConfig = {
  collections: [
    {
      name: 'docs',
      path: 'docs',
      entries: [
        { name: 'doc', format: 'md', schema: [...fields, { name: 'body', type: 'markdown' }] },
        { name: 'page', format: 'mdx', schema: [...fields, { name: 'body', type: 'mdx' }] },
        { name: 'card', format: 'yaml', schema: fields },
        { name: 'data', format: 'json', schema: fields },
      ],
    },
    {
      name: 'people',
      path: 'people',
      entries: [
        {
          name: 'person',
          format: 'json',
          schema: [{ name: 'name', type: 'string', isTitle: true }],
        },
      ],
    },
  ],
}
const flatSchema = flattenSchema(schema, 'content')

// Both block shapes (`template` + `value`, and inline `_type`), a list nested in a list item, a
// list nested in a block, identical siblings, an item already keyed, a comment, a calendar day
// and a reference.
const FRONTMATTER = `title: Getting started
published: 2024-01-05
author: ${AUTHOR_ID}
# the first step
steps:
  - title: Install
    links:
      - href: /docs/install
        label: Install guide
      - href: /docs/install
        label: Install guide
  - title: Configure
    _key: kept-key
blocks:
  - template: hero
    value:
      headline: Welcome
      ctas:
        - href: /start
          label: Start
  - _type: hero
    headline: Inline
    ctas:
      - href: /more
        label: More
`

const FRONTMATTER_KEYED = `title: Getting started
published: 2024-01-05
author: ${AUTHOR_ID}
# the first step
steps:
  - title: Install
    links:
      - href: /docs/install
        label: Install guide
        _key: hLb87xjAYB
      - href: /docs/install
        label: Install guide
        _key: hLb87xjAYB-2
    _key: hM5BtcwVyK
  - title: Configure
    _key: kept-key
blocks:
  - template: hero
    value:
      headline: Welcome
      ctas:
        - href: /start
          label: Start
          _key: h29puQhk4qZ
    _key: h21eRNJuHnG
  - _type: hero
    headline: Inline
    ctas:
      - href: /more
        label: More
        _key: hM5JU1rfyn
    _key: hFEp2afMQu
`

const JSON_DATA = {
  title: 'Facts',
  author: AUTHOR_ID,
  steps: [
    {
      title: 'Install',
      links: [
        { href: '/a', label: 'A' },
        { href: '/a', label: 'A' },
      ],
    },
    { title: 'Configure', _key: 'kept-key' },
  ],
  blocks: [
    { template: 'hero', value: { headline: 'W', ctas: [{ href: '/s', label: 'S' }] } },
    { _type: 'hero', headline: 'I', ctas: [{ href: '/m', label: 'M' }] },
  ],
}

const JSON_KEYED = `{
  "title": "Facts",
  "author": "${AUTHOR_ID}",
  "steps": [
    {
      "title": "Install",
      "links": [
        {
          "href": "/a",
          "label": "A",
          "_key": "htM5H9ernH"
        },
        {
          "href": "/a",
          "label": "A",
          "_key": "htM5H9ernH-2"
        }
      ],
      "_key": "hRnRCG4ebU"
    },
    {
      "title": "Configure",
      "_key": "kept-key"
    }
  ],
  "blocks": [
    {
      "template": "hero",
      "value": {
        "headline": "W",
        "ctas": [
          {
            "href": "/s",
            "label": "S",
            "_key": "hFQDAuRZSp"
          }
        ]
      },
      "_key": "hthEVyXS2r"
    },
    {
      "_type": "hero",
      "headline": "I",
      "ctas": [
        {
          "href": "/m",
          "label": "M",
          "_key": "hDyv1hTwHQ"
        }
      ],
      "_key": "hrFYdd5tHM"
    }
  ]
}
`

const MD_BODY = '\n# Getting started\n\nBody text.\n'
const MDX_BODY = '\n<Note>Hi</Note>\n'

const FILES = {
  md: `doc.start.De6gHj9kLm2n.md`,
  mdx: `page.intro.Ef7hJk2mNp3q.mdx`,
  yaml: `card.promo.Fg8jKm3nPq4r.yaml`,
  json: `data.facts.Gh9kLm4pQr5s.json`,
  compact: `data.compact.Hj2mNp5qRs6t.json`,
  keyed: `card.done.Jk3nPq6rSt7u.yaml`,
} as const

const docPath = (root: string, file: string) => path.join(root, 'content', DOCS_DIR, file)
const rel = (file: string) => `content/${DOCS_DIR}/${file}`

/** The site's content tree under `root`, with `.collection.json` files the CLI's schema reads. */
async function writeContent(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'content', DOCS_DIR), { recursive: true })
  await fs.mkdir(path.join(root, 'content', PEOPLE_DIR), { recursive: true })
  const meta = (name: string, entries: Array<[string, string]>) =>
    JSON.stringify({
      name,
      entries: entries.map(([type, format]) => ({ name: type, format, schema: type })),
    })
  await fs.writeFile(
    path.join(root, 'content', DOCS_DIR, '.collection.json'),
    meta('docs', [
      ['doc', 'md'],
      ['page', 'mdx'],
      ['card', 'yaml'],
      ['data', 'json'],
    ]),
  )
  await fs.writeFile(
    path.join(root, 'content', PEOPLE_DIR, '.collection.json'),
    meta('people', [['person', 'json']]),
  )
  await fs.writeFile(
    path.join(root, 'content', PEOPLE_DIR, `person.ada.${AUTHOR_ID}.json`),
    JSON.stringify({ name: 'Ada' }, null, 2) + '\n',
  )
  await fs.writeFile(docPath(root, FILES.md), `---\n${FRONTMATTER}---\n${MD_BODY}`)
  await fs.writeFile(docPath(root, FILES.mdx), `---\n${FRONTMATTER}---\n${MDX_BODY}`)
  await fs.writeFile(docPath(root, FILES.yaml), FRONTMATTER)
  await fs.writeFile(docPath(root, FILES.json), JSON.stringify(JSON_DATA, null, 2) + '\n')
  await fs.writeFile(
    docPath(root, FILES.compact),
    JSON.stringify({ title: 'Compact', steps: [{ title: 'x' }] }) + '\n',
  )
  await fs.writeFile(
    docPath(root, FILES.keyed),
    'title: Done\nsteps:\n  - title: x\n    _key: abc\n',
  )
}

/** Every file under `dir`, by path relative to it. */
async function snapshot(dir: string): Promise<Map<string, { text: string; mtimeMs: number }>> {
  const out = new Map<string, { text: string; mtimeMs: number }>()
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const file = path.join(entry.parentPath, entry.name)
    const stat = await fs.stat(file)
    out.set(path.relative(dir, file), {
      text: await fs.readFile(file, 'utf8'),
      mtimeMs: stat.mtimeMs,
    })
  }
  return out
}

const run = (root: string, check: boolean) =>
  backfillItemKeys({ root, flatSchema, contentRootName: 'content', check })

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-backfill-'))
  await writeContent(root)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

describe('backfillItemKeys', () => {
  it('adds only _key lines to md, mdx, yaml and json entries', async () => {
    const result = await run(root, false)

    expect(await fs.readFile(docPath(root, FILES.md), 'utf8')).toBe(
      `---\n${FRONTMATTER_KEYED}---\n${MD_BODY}`,
    )
    expect(await fs.readFile(docPath(root, FILES.mdx), 'utf8')).toBe(
      `---\n${FRONTMATTER_KEYED}---\n${MDX_BODY}`,
    )
    expect(await fs.readFile(docPath(root, FILES.yaml), 'utf8')).toBe(FRONTMATTER_KEYED)
    expect(await fs.readFile(docPath(root, FILES.json), 'utf8')).toBe(JSON_KEYED)
    for (const file of [FILES.md, FILES.mdx, FILES.yaml, FILES.json]) {
      expect(result.changed).toContainEqual({ path: rel(file), itemsKeyed: 7, otherLines: 0 })
    }
    expect(result.failed).toEqual([])
  })

  it('writes the keys a read gives the editor before the file holds them', async () => {
    const store = new ContentStore(root, flatSchema, { contentRootName: 'content' })
    const collection = unsafeAsLogicalPath('content/docs')
    const keysOf = async (slug: string) => {
      const { data } = await store.read(collection, unsafeAsSlug(slug), {
        resolveReferences: false,
      })
      const steps = data.steps as Array<Record<string, unknown>>
      const blocks = data.blocks as Array<Record<string, unknown>>
      return [...steps, ...blocks].map((item) => item[ITEM_KEY])
    }
    const read = await Promise.all(['start', 'promo', 'facts'].map(keysOf))

    await run(root, false)

    expect(await Promise.all(['start', 'promo', 'facts'].map(keysOf))).toEqual(read)
  })

  it('lists apart a file whose save also changes other lines, and writes it', async () => {
    const result = await run(root, false)

    const compact = result.changed.find((file) => file.path === rel(FILES.compact))
    expect(compact?.itemsKeyed).toBe(1)
    expect(compact?.otherLines).toBeGreaterThan(0)
    expect(await fs.readFile(docPath(root, FILES.compact), 'utf8')).toBe(
      '{\n  "title": "Compact",\n  "steps": [\n    {\n      "title": "x",\n' +
        '      "_key": "hrbRDjGyjW"\n    }\n  ]\n}\n',
    )
  })

  it('leaves a file whose items all hold keys untouched', async () => {
    const before = await snapshot(root)

    const result = await run(root, false)

    expect(result.changed.map((file) => file.path)).not.toContain(rel(FILES.keyed))
    expect(result.changed.map((file) => file.path)).not.toContain(
      `content/${PEOPLE_DIR}/person.ada.${AUTHOR_ID}.json`,
    )
    const after = await snapshot(root)
    expect(after.get(path.join('content', DOCS_DIR, FILES.keyed))).toEqual(
      before.get(path.join('content', DOCS_DIR, FILES.keyed)),
    )
  })

  it('changes nothing on a second run, not even an mtime', async () => {
    await run(root, false)
    const before = await snapshot(root)

    const second = await run(root, false)

    expect(second.changed).toEqual([])
    expect(await snapshot(root)).toEqual(before)
  })

  it('with check, writes nothing and reports what a run writes', async () => {
    const before = await snapshot(root)

    const checked = await run(root, true)

    expect(await snapshot(root)).toEqual(before)
    expect(checked.changed.length).toBe(5)
    expect(await run(root, false)).toEqual(checked)
  })

  it('records a file that fails to read, and keys the rest', async () => {
    const broken = `data.broken.Km4pQr7sTu8v.json`
    await fs.writeFile(docPath(root, broken), '{ not json')

    const result = await run(root, false)

    expect(result.failed).toEqual([{ path: rel(broken), error: expect.any(String) as string }])
    expect(result.changed.length).toBe(5)
  })
})

describe('a backfill write', () => {
  const user = { type: 'authenticated' as const, userId: 'u1', groups: [] as string[] }

  /** The editor's read and save of `root`, as content-item-keys.test.ts drives them. */
  const editor = (siteRoot: string) => {
    const checkBranchAccess = createCheckBranchAccess('allow')
    const ctx = (): ApiContext =>
      createMockApiContext({
        services: {
          config: defineCanopyTestConfig({
            defaultBranchAccess: 'allow',
            defaultPathAccess: 'allow',
            schema,
          }),
          checkBranchAccess,
          ...createTestContentAccess({
            checkBranchAccess,
            loadPathPermissions: vi.fn().mockResolvedValue([]),
            defaultPathAccess: 'allow',
            mode: 'dev',
            getSettingsBranchRoot: () => Promise.resolve(siteRoot),
          }),
        },
        branchContext: {
          ...createMockBranchContext({
            branchName: 'main',
            baseRoot: siteRoot,
            branchRoot: siteRoot,
          }),
          flatSchema,
        },
      })
    return async (slug: string) => {
      const params = {
        branch: unsafeAsBranchName('main'),
        path: unsafeAsLogicalPath(`content/docs/${slug}`),
      }
      const read = await CONTENT_ROUTES.read.handler(ctx(), { user }, params)
      expect(read.status).toBe(200)
      const doc = read.data as unknown as {
        format: 'md' | 'mdx' | 'json' | 'yaml'
        data: Record<string, unknown>
        body?: string
        version: number
      }
      const saved = await CONTENT_ROUTES.write.handler(ctx(), { user }, params, {
        format: doc.format,
        data: doc.data,
        body: doc.body,
        expectedVersion: doc.version,
      })
      expect(saved.status).toBe(200)
    }
  }

  it('is byte for byte what an editor save of the unedited entry writes', async () => {
    const saved = await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-backfill-saved-'))
    try {
      await writeContent(saved)
      const save = editor(saved)
      for (const slug of ['start', 'intro', 'promo', 'facts', 'compact']) await save(slug)

      await run(root, false)

      const backfilled = await snapshot(path.join(root, 'content'))
      const editorSaved = await snapshot(path.join(saved, 'content'))
      expect([...backfilled.keys()].sort()).toEqual([...editorSaved.keys()].sort())
      for (const [file, { text }] of backfilled) {
        expect({ file, text }).toEqual({ file, text: editorSaved.get(file)?.text })
      }
    } finally {
      await fs.rm(saved, { recursive: true, force: true })
    }
  })
})

describe('backfillItemKeysCLI', () => {
  let output: MockConsole

  const registry = (types: string[]) =>
    `const fields = ${JSON.stringify(fields)}\n` +
    `const all = {\n` +
    `  doc: [...fields, { name: 'body', type: 'markdown' }],\n` +
    `  page: [...fields, { name: 'body', type: 'mdx' }],\n` +
    `  card: fields,\n` +
    `  data: fields,\n` +
    `  person: [{ name: 'name', type: 'string', isTitle: true }],\n` +
    `}\n` +
    `export const entrySchemaRegistry = Object.fromEntries(\n` +
    `  Object.entries(all).filter(([name]) => ${JSON.stringify(types)}.includes(name)),\n` +
    `)\n`

  const writeSite = async (types = ['doc', 'page', 'card', 'data', 'person']) => {
    await fs.writeFile(
      path.join(root, 'canopycms.config.ts'),
      "export default { server: { mode: 'dev', contentRoot: 'content' } }\n",
    )
    await fs.mkdir(path.join(root, 'app'), { recursive: true })
    await fs.writeFile(path.join(root, 'app', 'schemas.ts'), registry(types))
  }

  const commitAll = async () => {
    const git = simpleGit({ baseDir: root })
    await git.init()
    await git.addConfig('user.name', 'Test Bot')
    await git.addConfig('user.email', 'test@canopycms.test')
    await git.add('-A')
    await git.commit('content')
    return git
  }

  const cli = (options: { check?: boolean; force?: boolean } = {}) =>
    backfillItemKeysCLI({ projectDir: root, ...options })

  const logged = () => output.all().log.join('\n')

  beforeEach(async () => {
    output = mockConsole()
    await writeSite()
  })

  afterEach(() => output.restore())

  it('--check exits 1 while files need keys, and 0 after a run', async () => {
    await commitAll()
    const before = await snapshot(path.join(root, 'content'))

    expect(await cli({ check: true })).toBe(BACKFILL_EXIT_CODES.changesOrRefused)
    expect(await snapshot(path.join(root, 'content'))).toEqual(before)
    expect(logged()).toContain(`Would key items in 4 files, adding only _key lines:`)

    expect(await cli()).toBe(BACKFILL_EXIT_CODES.ok)
    expect(await cli({ check: true })).toBe(BACKFILL_EXIT_CODES.ok)
    expect(logged()).toContain('Every item already has its key.')
  })

  it('lists a file the save also normalises under its own heading', async () => {
    await commitAll()

    expect(await cli()).toBe(BACKFILL_EXIT_CODES.ok)

    const text = logged()
    const heading = text.indexOf('also normalises in other lines. Review these before committing:')
    expect(heading).toBeGreaterThan(-1)
    expect(text.indexOf(rel(FILES.compact))).toBeGreaterThan(heading)
    expect(text.indexOf(rel(FILES.json))).toBeLessThan(heading)
  })

  it('leaves no .canopy-meta directory at the project root', async () => {
    await commitAll()

    await cli()

    await expect(fs.stat(path.join(root, CANOPY_META_DIR))).rejects.toThrow(/ENOENT/)
    const status = await simpleGit({ baseDir: root }).raw([
      'status',
      '--porcelain',
      '--untracked-files=all',
    ])
    expect(status.trimEnd().split('\n').sort()).toEqual(
      [FILES.compact, FILES.json, FILES.md, FILES.mdx, FILES.yaml]
        .map((f) => ` M ${rel(f)}`)
        .sort(),
    )
  })

  it('keeps a .canopy-meta directory that was already there', async () => {
    await commitAll()
    await fs.mkdir(path.join(root, CANOPY_META_DIR))
    await fs.writeFile(path.join(root, CANOPY_META_DIR, 'branch.json'), '{}')

    await cli()

    expect(await fs.readFile(path.join(root, CANOPY_META_DIR, 'branch.json'), 'utf8')).toBe('{}')
    // The store's own marker stays too: inside a branch workspace other processes read it.
    expect((await fs.stat(contentIndexGenerationPath(root))).isFile()).toBe(true)
  })

  it('refuses uncommitted content changes, and writes them with --force', async () => {
    await commitAll()
    await fs.appendFile(docPath(root, FILES.md), '\nAn edit.\n')
    const before = await snapshot(path.join(root, 'content'))

    expect(await cli()).toBe(BACKFILL_EXIT_CODES.changesOrRefused)
    expect(output.all().error.join('\n')).toContain(` M ${rel(FILES.md)}`)
    expect(await snapshot(path.join(root, 'content'))).toEqual(before)

    expect(await cli({ force: true })).toBe(BACKFILL_EXIT_CODES.ok)
    expect(await fs.readFile(docPath(root, FILES.json), 'utf8')).toBe(JSON_KEYED)
  })

  it('refuses an entry git does not track yet', async () => {
    await commitAll()
    await fs.writeFile(docPath(root, 'card.new.Lm5qRs8tUv9w.yaml'), 'title: New\n')

    expect(await cli()).toBe(BACKFILL_EXIT_CODES.changesOrRefused)
    expect(output.all().error.join('\n')).toContain(`?? ${rel('card.new.Lm5qRs8tUv9w.yaml')}`)
  })

  it('refuses outside a git checkout unless forced', async () => {
    expect(await cli()).toBe(BACKFILL_EXIT_CODES.changesOrRefused)
    expect(output.all().error.join('\n')).toContain('pass --force')
    expect(await cli({ force: true })).toBe(BACKFILL_EXIT_CODES.ok)
  })

  it('skips entries whose entry type the registry lacks', async () => {
    await writeSite(['doc', 'page', 'data', 'person'])
    await commitAll()
    const yamlBefore = await fs.readFile(docPath(root, FILES.yaml), 'utf8')

    expect(await cli()).toBe(BACKFILL_EXIT_CODES.ok)

    expect(await fs.readFile(docPath(root, FILES.yaml), 'utf8')).toBe(yamlBefore)
    expect(output.all().warn.join('\n')).toContain(
      'Skipped 2 entries whose entry type the schema registry does not have.',
    )
    expect(await fs.readFile(docPath(root, FILES.json), 'utf8')).toBe(JSON_KEYED)
  })

  it('exits 2 when the config does not load', async () => {
    await fs.writeFile(path.join(root, 'canopycms.config.ts'), 'export default {{\n')

    expect(await cli({ check: true })).toBe(BACKFILL_EXIT_CODES.loadError)
    expect(output.all().error.join('\n')).toContain('Could not load the site')
  })

  it('exits 2 when schemas.ts is missing', async () => {
    await fs.rm(path.join(root, 'app', 'schemas.ts'))

    expect(await cli({ check: true })).toBe(BACKFILL_EXIT_CODES.loadError)
  })

  it('exits 2 when an entry cannot be read', async () => {
    await fs.writeFile(docPath(root, `data.broken.Km4pQr7sTu8v.json`), '{ not json')

    expect(await cli({ check: true })).toBe(BACKFILL_EXIT_CODES.loadError)
    expect(output.all().error.join('\n')).toContain(rel(`data.broken.Km4pQr7sTu8v.json`))
  })
})
