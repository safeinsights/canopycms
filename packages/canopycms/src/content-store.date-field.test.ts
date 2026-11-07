import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ContentFormat, EntrySchema, RootCollectionConfig } from './config'
import { flattenSchema } from './config/flatten'
import { listEntries } from './content-listing'
import { ContentStore } from './content-store'
import { unsafeAsLogicalPath, unsafeAsSlug } from './paths/test-utils'
import { findInvalidEntries } from './static'
import { validateEntryData } from './validation/entry-validator'

const fields: EntrySchema = [
  { name: 'title', type: 'string' },
  { name: 'on', type: 'date' },
  { name: 'at', type: 'datetime' },
  { name: 'rows', type: 'object', list: true, fields: [{ name: 'on', type: 'date' }] },
  {
    name: 'blocks',
    type: 'block',
    templates: [{ name: 'event', fields: [{ name: 'on', type: 'date' }] }],
  },
]

const FORMATS: ContentFormat[] = ['md', 'mdx', 'json', 'yaml']

const schema: RootCollectionConfig = {
  collections: FORMATS.map((format) => ({
    name: format,
    path: format,
    entries: [{ name: 'event', format, schema: fields }],
  })),
}

const flat = flattenSchema(schema, 'content')

const HAND_WRITTEN = `---
title: Launch # shown in the card
on: 2024-05-01
rows:
  - on: 2024-05-02
blocks:
  - template: event
    value:
      on: 2024-05-03
---

Body.
`

const zone = process.env.TZ
let root: string
let store: ContentStore

const collection = (format: ContentFormat) => unsafeAsLogicalPath(`content/${format}`)
const launch = unsafeAsSlug('launch')

/** Saves `data`, returning the file it landed in. */
const save = async (format: ContentFormat, data: Record<string, unknown>) => {
  const input =
    format === 'md' || format === 'mdx' ? { format, data, body: 'Body.\n' } : { format, data }
  const doc = await store.write(collection(format), launch, input, 'event')
  return path.join(root, doc.relativePath)
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-date-field-'))
  store = new ContentStore(root, flat)
})

afterEach(async () => {
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
  await fs.rm(root, { recursive: true, force: true })
})

describe.each(FORMATS)('a date field saved as %s', (format) => {
  it('reads back as the same string, through a read and a listing', async () => {
    await save(format, { title: 'Launch', on: '2026-11-05', rows: [{ on: '2024-02-29' }] })
    const doc = await store.read(collection(format), launch)
    expect(doc.data.on).toBe('2026-11-05')
    expect((doc.data.rows as Array<{ on: unknown }>)[0].on).toBe('2024-02-29')
    const [listed] = await listEntries(root, flat, 'content')
    expect(listed.data.on).toBe('2026-11-05')
  })
})

describe('a hand-written bare date in an md entry', () => {
  /** A file an author wrote: the store first creates it, for its id, then the text is replaced. */
  const handWrite = async (text: string) => {
    const file = await save('md', { title: 'Launch' })
    await fs.writeFile(file, text, 'utf8')
    return file
  }

  it.each(['America/Los_Angeles', 'Pacific/Honolulu', 'Pacific/Auckland'])(
    'is the day written in %s, at any depth, read or listed',
    async (timeZone) => {
      process.env.TZ = timeZone
      await handWrite(HAND_WRITTEN)
      const doc = await store.read(collection('md'), launch)
      const expected = {
        on: '2024-05-01',
        rows: [expect.objectContaining({ on: '2024-05-02' })],
        blocks: [expect.objectContaining({ value: { on: '2024-05-03' } })],
      }
      expect(doc.data).toMatchObject(expected)
      expect(JSON.parse(JSON.stringify(doc.data))).toMatchObject(expected)
      const [listed] = await listEntries(root, flat, 'content')
      expect(listed.data).toMatchObject(expected)
    },
  )

  it('passes save validation and the build guard as read', async () => {
    process.env.TZ = 'America/Los_Angeles'
    await handWrite(HAND_WRITTEN)
    const doc = await store.read(collection('md'), launch)
    expect(validateEntryData(fields, doc.data)).toEqual([])
    const [listed] = await listEntries(root, flat, 'content')
    expect(
      findInvalidEntries([{ entryPath: listed.entryPath, schema: fields, data: listed.data }]),
    ).toEqual([])
  })

  it('stays on its line, with the file’s comments, when an edit elsewhere is saved', async () => {
    const file = await handWrite(HAND_WRITTEN)
    const doc = await store.read(collection('md'), launch)
    await save('md', { ...doc.data, title: 'Launched' })
    const saved = await fs.readFile(file, 'utf8')
    expect(saved).toContain('title: Launched # shown in the card\non: 2024-05-01\n')
    expect(saved).toContain('  - on: 2024-05-02\n')
  })

  it('takes a new day as a quoted string, keeping the file’s comments', async () => {
    const file = await handWrite(HAND_WRITTEN)
    const doc = await store.read(collection('md'), launch)
    await save('md', { ...doc.data, on: '2024-06-02' })
    const saved = await fs.readFile(file, 'utf8')
    expect(saved).toContain(`on: '2024-06-02'\n`)
    expect(saved).toContain('title: Launch # shown in the card\n')
    expect((await store.read(collection('md'), launch)).data.on).toBe('2024-06-02')
  })

  it('leaves a bare date under a datetime field as it was: a timestamp', async () => {
    await handWrite('---\nat: 2024-05-01\n---\n\nBody.\n')
    const doc = await store.read(collection('md'), launch)
    expect(doc.data.at).toEqual(new Date('2024-05-01T00:00:00.000Z'))
  })

  it('refuses a time of day: the file holds a moment, not a day', async () => {
    await handWrite('---\non: 2024-05-01T10:30:00Z\n---\n\nBody.\n')
    const doc = await store.read(collection('md'), launch)
    expect(validateEntryData(fields, JSON.parse(JSON.stringify(doc.data)))).toEqual([
      { fieldPath: 'on', message: 'Expected a real date, written YYYY-MM-DD' },
    ])
  })
})
