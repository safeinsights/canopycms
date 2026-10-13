/**
 * List items and blocks leave every reader and the write API keyed (`item-keys.ts`): a file saved
 * before keys existed names its items by their content, the same way in `ContentStore.read`, the
 * listings and a save, until a save writes the keys down; a hand edit before then loses the key
 * rather than moving a comment thread onto another item.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CONTENT_ROUTES } from './api/content'
import type { ApiContext } from './api/types'
import { createCheckBranchAccess } from './authorization'
import { createTestContentAccess } from './authorization/test-utils'
import { flattenSchema, type FieldConfig, type RootCollectionConfig } from './config'
import { defineCanopyTestConfig } from './config-test'
import { listEntries } from './content-listing'
import { ContentStore } from './content-store'
import { generateId } from './id'
import { ITEM_KEY, isItemKey, itemKeysOnPath, resolveThreadPath } from './item-keys'
import { unsafeAsBranchName, unsafeAsLogicalPath, unsafeAsSlug } from './paths/test-utils'
import { createMockApiContext, createMockBranchContext } from './test-utils'

type Rec = Record<string, unknown>

const pageSchema: FieldConfig[] = [
  { name: 'title', type: 'string', isTitle: true },
  {
    name: 'team',
    type: 'object',
    list: true,
    fields: [
      { name: 'name', type: 'string' },
      { name: 'mentor', type: 'reference', collections: ['people'] },
      {
        name: 'links',
        type: 'object',
        list: true,
        fields: [{ name: 'href', type: 'string' }],
      },
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
          { name: 'who', type: 'reference', collections: ['people'] },
        ],
      },
    ],
  },
]

const schema: RootCollectionConfig = {
  collections: [
    {
      name: 'pages',
      path: 'pages',
      entries: [{ name: 'page', format: 'json', schema: pageSchema }],
    },
    {
      name: 'people',
      path: 'people',
      entries: [
        {
          name: 'person',
          format: 'json',
          schema: [{ name: 'heading', type: 'string', isTitle: true }],
        },
      ],
    },
  ],
}
const flat = flattenSchema(schema, 'content')
const PAGES = unsafeAsLogicalPath('content/pages')
const HOME = unsafeAsSlug('home')
const BRANCH = unsafeAsBranchName('main')

let root: string
let homeFile: string
let alice: string

const writeHome = (data: Rec) => fs.writeFile(homeFile, JSON.stringify(data))
const readFile = async (): Promise<Rec> => JSON.parse(await fs.readFile(homeFile, 'utf8')) as Rec

const readStore = async (resolveReferences: boolean): Promise<Rec> =>
  (await new ContentStore(root, flat).read(PAGES, HOME, { resolveReferences })).data
const readListed = async (): Promise<Rec> => {
  const entries = await listEntries(root, flat, 'content')
  const home = entries.find((entry) => entry.slug === 'home')
  if (!home) throw new Error('home is not listed')
  return home.data as Rec
}
const readApi = async (): Promise<Rec> => (await readHomeApi()).data

const user = { type: 'authenticated' as const, userId: 'u1', groups: [] as string[] }
const createCtx = (): ApiContext => {
  const checkBranchAccess = createCheckBranchAccess('allow')
  const access = createTestContentAccess({
    checkBranchAccess,
    loadPathPermissions: vi.fn().mockResolvedValue([]),
    defaultPathAccess: 'allow',
    mode: 'dev',
    getSettingsBranchRoot: () => Promise.resolve(root),
  })
  return createMockApiContext({
    services: {
      config: defineCanopyTestConfig({
        defaultBranchAccess: 'allow',
        defaultPathAccess: 'allow',
        schema,
      }),
      checkBranchAccess,
      ...access,
    },
    branchContext: {
      ...createMockBranchContext({ branchName: 'main', baseRoot: root, branchRoot: root }),
      flatSchema: flat,
    },
  })
}
const homeParams = { branch: BRANCH, path: unsafeAsLogicalPath('content/pages/home') }
const readHomeApi = async () => {
  const res = await CONTENT_ROUTES.read.handler(createCtx(), { user }, homeParams)
  expect(res.status).toBe(200)
  return res.data as unknown as { data: Rec; version: number }
}
const writeHomeApi = (data: Rec, expectedVersion: number) =>
  CONTENT_ROUTES.write.handler(createCtx(), { user }, homeParams, {
    format: 'json',
    data,
    expectedVersion,
  })

const items = (value: unknown): Rec[] => value as Rec[]
const keysOf = (value: unknown): string[] => items(value).map((item) => item[ITEM_KEY] as string)

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-item-keys-'))
  const pagesDir = path.join(root, 'content', `pages.${generateId()}`)
  const peopleDir = path.join(root, 'content', `people.${generateId()}`)
  await fs.mkdir(pagesDir, { recursive: true })
  await fs.mkdir(peopleDir, { recursive: true })
  alice = generateId()
  await fs.writeFile(
    path.join(peopleDir, `person.alice.${alice}.json`),
    JSON.stringify({ heading: 'Alice' }),
  )
  homeFile = path.join(pagesDir, `page.home.${generateId()}.json`)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

const unkeyed = (): Rec => ({
  title: 'Home',
  team: [
    { name: 'Ada', mentor: alice, links: [{ href: '/a' }, { href: '/b' }] },
    { name: 'Bo', links: [{ href: '/c' }] },
  ],
  blocks: [{ template: 'hero', value: { headline: 'Hi', who: alice } }],
})

describe('an un-keyed file read', () => {
  it('gives the same keys from ContentStore.read, with references resolved or not, and from the listing', async () => {
    await writeHome(unkeyed())

    const resolved = await readStore(true)
    const raw = await readStore(false)
    const listed = await readListed()

    expect(resolved.team).toBeDefined()
    for (const data of [resolved, raw, listed]) {
      const team = items(data.team)
      expect(team.map((t) => isItemKey(t[ITEM_KEY]))).toEqual([true, true])
      expect(isItemKey(items(data.blocks)[0][ITEM_KEY])).toBe(true)
      expect(keysOf(team[0].links).every(isItemKey)).toBe(true)
    }
    expect(keysOf(resolved.team)).toEqual(keysOf(raw.team))
    expect(keysOf(listed.team)).toEqual(keysOf(raw.team))
    expect(keysOf(items(resolved.team)[0].links)).toEqual(keysOf(items(raw.team)[0].links))
    expect(keysOf(items(listed.team)[0].links)).toEqual(keysOf(items(raw.team)[0].links))
    expect(keysOf(resolved.blocks)).toEqual(keysOf(raw.blocks))
    expect(keysOf(listed.blocks)).toEqual(keysOf(raw.blocks))
    // The block's key sits beside `template`, and the resolved reference inside `value` is
    // not part of what the key named.
    expect(items(resolved.blocks)[0].value).not.toHaveProperty(ITEM_KEY)
    expect((items(resolved.team)[0].mentor as Rec).heading).toBe('Alice')
  })

  it('gives the same keys on every read, and from the editor read API', async () => {
    await writeHome(unkeyed())

    const first = await readStore(false)
    const second = await readStore(false)
    const api = await readApi()

    expect(keysOf(second.team)).toEqual(keysOf(first.team))
    expect(keysOf(api.team)).toEqual(keysOf(first.team))
    expect(keysOf(second.blocks)).toEqual(keysOf(first.blocks))
    // Reading writes nothing: the file still has no keys.
    expect(await readFile()).toEqual(unkeyed())
  })

  it('keeps a key the file holds, and keys the item beside it', async () => {
    const data = unkeyed()
    ;(data.team as Rec[])[0][ITEM_KEY] = 'ada-key'
    await writeHome(data)

    for (const read of [() => readStore(true), () => readStore(false), readListed, readApi]) {
      const team = items((await read()).team)
      expect(team[0][ITEM_KEY]).toBe('ada-key')
      expect(isItemKey(team[1][ITEM_KEY])).toBe(true)
      expect(team[1][ITEM_KEY]).not.toBe('ada-key')
    }
  })

  describe('identical siblings', () => {
    const same = () => ({
      title: 'Home',
      team: [
        { name: 'Same', links: [{ href: '/x' }, { href: '/x' }, { href: '/x' }] },
        { name: 'Same', links: [{ href: '/x' }, { href: '/x' }, { href: '/x' }] },
        { name: 'Same', links: [{ href: '/x' }, { href: '/x' }, { href: '/x' }] },
      ],
    })

    it('are keyed h<X>, h<X>-2, h<X>-3 in order, the same on every reader', async () => {
      await writeHome(same())

      for (const read of [() => readStore(true), () => readStore(false), readListed, readApi]) {
        const data = await read()
        const [a, b, c] = keysOf(data.team)
        expect(a).toMatch(/^h[1-9A-HJ-NP-Za-km-z]+$/)
        expect(b).toBe(`${a}-2`)
        expect(c).toBe(`${a}-3`)
        const [x, y, z] = keysOf(items(data.team)[0].links)
        expect(y).toBe(`${x}-2`)
        expect(z).toBe(`${x}-3`)
      }
      expect(keysOf((await readStore(false)).team)).toEqual(keysOf((await readStore(false)).team))
    })

    it('are keyed the same way by a save that sends none', async () => {
      await writeHome(same())
      const { version } = await readHomeApi()
      const expected = keysOf((await readStore(false)).team)

      const res = await writeHomeApi(same(), version)

      expect(res.status).toBe(200)
      expect(keysOf((await readFile()).team)).toEqual(expected)
    })
  })

  it('has unique keys in every list on read and on write, when two items hold the same _key', async () => {
    await writeHome({
      title: 'Home',
      team: [
        { [ITEM_KEY]: 'dup', name: 'Ada' },
        { [ITEM_KEY]: 'dup', name: 'Bo' },
        { [ITEM_KEY]: 'dup', name: 'Cy' },
      ],
    })

    for (const read of [() => readStore(true), () => readStore(false), readListed, readApi]) {
      const keys = keysOf((await read()).team)
      expect(keys[0]).toBe('dup')
      expect(keys.every(isItemKey)).toBe(true)
      expect(new Set(keys).size).toBe(3)
    }
    // Every reader replaces them with the same keys.
    expect(keysOf((await readStore(false)).team)).toEqual(keysOf((await readListed()).team))

    const { data, version } = await readHomeApi()
    const sent = structuredClone(data)
    ;(sent.team as Rec[])[1][ITEM_KEY] = 'dup'
    ;(sent.team as Rec[])[2][ITEM_KEY] = 'dup'
    const res = await writeHomeApi(sent, version)
    expect(res.status).toBe(200)
    const stored = keysOf((await readFile()).team)
    expect(stored[0]).toBe('dup')
    expect(new Set(stored).size).toBe(3)
    expect(stored.every(isItemKey)).toBe(true)
  })
})

describe('a save through the content write API', () => {
  it('writes the keys of a save that sent none, into the file and the response', async () => {
    await writeHome({ title: 'Home' })
    const { version } = await readHomeApi()

    const res = await writeHomeApi(unkeyed(), version)

    expect(res.status).toBe(200)
    const stored = await readFile()
    const team = items(stored.team)
    expect(team.every((t) => isItemKey(t[ITEM_KEY]))).toBe(true)
    expect(keysOf(team[0].links).every(isItemKey)).toBe(true)
    expect(isItemKey(items(stored.blocks)[0][ITEM_KEY])).toBe(true)
    expect(items(stored.blocks)[0].value).not.toHaveProperty(ITEM_KEY)
    // References still go to disk as bare ids.
    expect(team[0].mentor).toBe(alice)
    const returned = (res.data as unknown as { data: Rec }).data
    expect(keysOf(returned.team)).toEqual(keysOf(stored.team))
    expect(keysOf(returned.blocks)).toEqual(keysOf(stored.blocks))
    // A later read names the items by the keys written, not by content.
    expect(keysOf((await readStore(false)).team)).toEqual(keysOf(stored.team))
  })

  it('keeps the keys it is sent verbatim', async () => {
    await writeHome({ title: 'Home' })
    const { version } = await readHomeApi()
    const sent = {
      title: 'Home',
      team: [
        { [ITEM_KEY]: 'k-ada', name: 'Ada', links: [{ [ITEM_KEY]: 'k-l1', href: '/a' }] },
        { [ITEM_KEY]: 'k-bo', name: 'Bo' },
      ],
      blocks: [{ [ITEM_KEY]: 'k-hero', template: 'hero', value: { headline: 'Hi' } }],
    }

    const res = await writeHomeApi(sent, version)

    expect(res.status).toBe(200)
    expect(await readFile()).toEqual(sent)
    expect(keysOf((res.data as unknown as { data: Rec }).data.team)).toEqual(['k-ada', 'k-bo'])
  })

  it('keeps the keys of a reordered list, so a thread on an item can follow it', async () => {
    await writeHome({ title: 'Home' })
    const { version } = await readHomeApi()
    const first = await writeHomeApi(unkeyed(), version)
    expect(first.status).toBe(200)
    const read = await readHomeApi()
    const [ada, bo] = items(read.data.team)

    const res = await writeHomeApi({ ...read.data, team: [bo, ada] }, read.version)

    expect(res.status).toBe(200)
    expect(keysOf((await readFile()).team)).toEqual([bo[ITEM_KEY], ada[ITEM_KEY]])
  })
})

describe('a hand edit before the first save', () => {
  const fields = pageSchema

  it('makes a thread on the edited item resolve to "removed", never onto another item', async () => {
    await writeHome({ title: 'Home', team: [{ name: 'A' }, { name: 'B' }] })
    const before = await readStore(false)
    const keyOfB = keysOf(before.team)[1]
    // A thread made on team[1].name stores B's key.
    const threadKeys = itemKeysOnPath(fields, before, 'team[1].name')
    expect(threadKeys).toEqual([keyOfB])

    // Someone edits B in the file directly; no save went through the API.
    await writeHome({ title: 'Home', team: [{ name: 'A' }, { name: 'B, edited' }] })
    const after = await readStore(false)

    expect(keysOf(after.team)[1]).not.toBe(keyOfB)
    expect(keysOf(after.team)[0]).toBe(keysOf(before.team)[0])
    expect(resolveThreadPath(fields, after, 'team[1].name', threadKeys)).toBeNull()
    // Not on A either, whichever index the thread was made on.
    expect(resolveThreadPath(fields, after, 'team[0].name', threadKeys)).toBeNull()
  })

  it('does not hand B its old key when an un-keyed item is added before A as well', async () => {
    await writeHome({ title: 'Home', team: [{ name: 'A' }, { name: 'B' }] })
    const before = await readStore(false)
    const keyOfB = keysOf(before.team)[1]
    const threadKeys = itemKeysOnPath(fields, before, 'team[1].name')

    await writeHome({ title: 'Home', team: [{ name: 'C' }, { name: 'A' }, { name: 'B, edited' }] })
    const after = await readStore(false)
    const listed = await readListed()

    const keys = keysOf(after.team)
    expect(keys).toHaveLength(3)
    expect(new Set(keys).size).toBe(3)
    expect(keys).not.toContain(keyOfB)
    expect(keys[1]).toBe(keysOf(before.team)[0])
    expect(keysOf(listed.team)).toEqual(keys)
    expect(resolveThreadPath(fields, after, 'team[1].name', threadKeys)).toBeNull()
  })

  it('keeps a thread on an item the hand edit did not touch, following it past an added item', async () => {
    await writeHome({ title: 'Home', team: [{ name: 'A' }, { name: 'B' }] })
    const before = await readStore(false)
    const keyOfB = keysOf(before.team)[1]
    const threadKeys = itemKeysOnPath(fields, before, 'team[1].name')

    await writeHome({ title: 'Home', team: [{ name: 'C' }, { name: 'A' }, { name: 'B' }] })
    const after = await readStore(false)

    expect(keysOf(after.team)[2]).toBe(keyOfB)
    expect(keysOf(after.team)[0]).not.toBe(keyOfB)
    expect(resolveThreadPath(fields, after, 'team[1].name', threadKeys)).toBe('team[2].name')
  })
})
